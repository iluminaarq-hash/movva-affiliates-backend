require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { db, log } = require('./db');
const cartpanda = require('./cartpanda');
const sheets = require('./sheets');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 200 }));

// Auth middleware — simple secret header
const auth = (req, res, next) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ 
  status: 'ok', 
  app: 'MOVVA Affiliates API',
  version: '1.0.0',
  time: new Date().toISOString()
}));

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, (req, res) => {
  try {
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as total FROM candidatos GROUP BY status
    `).all();

    const afiliados = db.prepare(`
      SELECT COUNT(*) as total FROM afiliados WHERE status = 'ativo'
    `).get();

    const vendasMes = db.prepare(`
      SELECT 
        COUNT(*) as pedidos,
        COALESCE(SUM(base_comissionavel), 0) as total_vendido,
        COALESCE(SUM(comissao_valor), 0) as total_comissao
      FROM pedidos 
      WHERE cancelado = 0 
        AND status_pagamento NOT IN ('pending','cancelled','refunded')
        AND strftime('%Y-%m', data_pedido) = strftime('%Y-%m', 'now')
    `).get();

    const topAfiliados = db.prepare(`
      SELECT 
        a.id, a.cupom, a.comissao_pct,
        c.name, c.instagram,
        COUNT(p.id) as pedidos,
        COALESCE(SUM(p.base_comissionavel), 0) as total_vendido,
        COALESCE(SUM(p.comissao_valor), 0) as comissao
      FROM afiliados a
      JOIN candidatos c ON c.id = a.candidato_id
      LEFT JOIN pedidos p ON p.afiliado_id = a.id AND p.cancelado = 0
      GROUP BY a.id
      ORDER BY total_vendido DESC
      LIMIT 5
    `).all();

    const ultimaSync = db.prepare(`
      SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 1
    `).get();

    res.json({ byStatus, afiliados, vendasMes, topAfiliados, ultimaSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CANDIDATOS ────────────────────────────────────────────────────────────────
app.get('/api/candidatos', auth, (req, res) => {
  try {
    const { status, modalidade, fonte, search, page = 1, limit = 100 } = req.query;
    let where = ['1=1'];
    const params = [];

    if (status)     { where.push('status = ?'); params.push(status); }
    if (modalidade) { where.push('modalidade = ?'); params.push(modalidade); }
    if (fonte)      { where.push('fonte = ?'); params.push(fonte); }
    if (search) {
      where.push('(name LIKE ? OR instagram LIKE ? OR email LIKE ? OR cidade LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const total = db.prepare(`SELECT COUNT(*) as n FROM candidatos WHERE ${where.join(' AND ')}`).get(...params).n;
    const data  = db.prepare(`SELECT * FROM candidatos WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);

    res.json({ data, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/candidatos/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM candidatos WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Não encontrado' });
  const historico = db.prepare('SELECT * FROM historico WHERE candidato_id = ? ORDER BY created_at DESC').all(req.params.id);
  const contatos  = db.prepare('SELECT * FROM contatos  WHERE candidato_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...c, historico, contatos });
});

app.patch('/api/candidatos/:id/status', auth, (req, res) => {
  try {
    const { status, usuario } = req.body;
    const c = db.prepare('SELECT status FROM candidatos WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Não encontrado' });
    db.prepare('UPDATE candidatos SET status = ?, updated_at = datetime("now") WHERE id = ?').run(status, req.params.id);
    log(req.params.id, 'status_alterado', null, c.status, status, usuario);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/candidatos/:id', auth, (req, res) => {
  try {
    const fields = ['nota','observacoes','responsavel','status'];
    const updates = [];
    const params = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f]);
      }
    });
    if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    updates.push('updated_at = datetime("now")');
    params.push(req.params.id);
    db.prepare(`UPDATE candidatos SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk status update
app.patch('/api/candidatos/bulk/status', auth, (req, res) => {
  try {
    const { ids, status, usuario } = req.body;
    const update = db.prepare('UPDATE candidatos SET status = ?, updated_at = datetime("now") WHERE id = ?');
    const logEntry = db.prepare(`INSERT INTO historico (candidato_id, acao, valor_novo, usuario) VALUES (?, 'status_alterado', ?, ?)`);
    const tx = db.transaction(() => {
      ids.forEach(id => { update.run(status, id); logEntry.run(id, status, usuario || 'Cairo Jácome'); });
    });
    tx();
    res.json({ ok: true, updated: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONTATOS ──────────────────────────────────────────────────────────────────
app.post('/api/candidatos/:id/contatos', auth, (req, res) => {
  try {
    const { canal, mensagem, resposta, resultado, proxima_acao, data_proxima_acao, responsavel } = req.body;
    db.prepare(`
      INSERT INTO contatos (candidato_id, canal, mensagem, resposta, resultado, proxima_acao, data_proxima_acao, responsavel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, canal, mensagem, resposta, resultado, proxima_acao, data_proxima_acao, responsavel || 'Cairo Jácome');
    log(req.params.id, 'contato_registrado', `Canal: ${canal}`, null, null, responsavel);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AFILIADOS ─────────────────────────────────────────────────────────────────
app.get('/api/afiliados', auth, (req, res) => {
  try {
    const data = db.prepare(`
      SELECT 
        a.*, c.name, c.instagram, c.whatsapp, c.email, c.cidade, c.modalidade,
        COUNT(p.id) as total_pedidos,
        COALESCE(SUM(p.base_comissionavel), 0) as total_vendido,
        COALESCE(SUM(p.comissao_valor), 0) as comissao_acumulada,
        MAX(p.data_pedido) as ultima_venda
      FROM afiliados a
      JOIN candidatos c ON c.id = a.candidato_id
      LEFT JOIN pedidos p ON p.afiliado_id = a.id AND p.cancelado = 0
      GROUP BY a.id
      ORDER BY total_vendido DESC
    `).all();
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/afiliados', auth, async (req, res) => {
  try {
    const { candidato_id, cupom, desconto_pct, comissao_pct, cpf, chave_pix, observacoes, criar_cupom } = req.body;

    // Check if cupom already exists
    const existing = db.prepare('SELECT id FROM afiliados WHERE cupom = ?').get(cupom.toUpperCase());
    if (existing) return res.status(400).json({ error: 'Cupom já vinculado a outro afiliado' });

    let cartpanda_discount_id = null;

    if (criar_cupom) {
      try {
        const cpRes = await cartpanda.createDiscount({
          code: cupom,
          discountPct: desconto_pct || 15,
          startDate: new Date().toISOString().slice(0, 10)
        });
        cartpanda_discount_id = cpRes?.discounts?.id ? String(cpRes.discounts.id) : null;
      } catch (cpErr) {
        console.error('CartPanda discount error:', cpErr.message);
        // Continue even if CartPanda fails — user can retry
      }
    }

    db.prepare(`
      INSERT INTO afiliados (candidato_id, cupom, desconto_pct, comissao_pct, cpf, chave_pix, cartpanda_discount_id, observacoes, data_inicio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now'))
    `).run(candidato_id, cupom.toUpperCase(), desconto_pct || 15, comissao_pct || 10, cpf, chave_pix, cartpanda_discount_id, observacoes);

    db.prepare('UPDATE candidatos SET status = ?, cupom = ?, updated_at = datetime("now") WHERE id = ?')
      .run('Ativo', cupom.toUpperCase(), candidato_id);

    log(candidato_id, 'aprovado_afiliado', `Cupom: ${cupom.toUpperCase()}`, 'Aprovado', 'Ativo', 'Cairo Jácome');

    res.json({ ok: true, cartpanda_discount_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/afiliados/:id/pedidos', auth, (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM pedidos WHERE afiliado_id = ? ORDER BY data_pedido DESC').all(req.params.id);
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_pedidos,
        COALESCE(SUM(base_comissionavel), 0) as total_vendido,
        COALESCE(SUM(comissao_valor), 0) as total_comissao,
        COALESCE(AVG(valor_total), 0) as ticket_medio
      FROM pedidos WHERE afiliado_id = ? AND cancelado = 0
    `).get(req.params.id);
    res.json({ data, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SYNC SHEETS ───────────────────────────────────────────────────────────────
app.post('/api/sync/sheets', auth, async (req, res) => {
  try {
    const rows = await sheets.syncCandidatos();
    let novos = 0, atualizados = 0;

    const insert = db.prepare(`
      INSERT INTO candidatos (id, name, email, whatsapp, instagram, cidade, modalidade, motivo, data_inscricao, fonte)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Formulário site 2026')
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        instagram = excluded.instagram,
        cidade = excluded.cidade,
        motivo = excluded.motivo,
        updated_at = datetime('now')
    `);

    const tx = db.transaction(() => {
      rows.forEach((r, i) => {
        const wpp = r.whatsapp;
        const existing = wpp ? db.prepare('SELECT id FROM candidatos WHERE whatsapp = ?').get(wpp) : null;
        const id = existing?.id || `MVV${String(i + 1).zfill ? String(i+1).padStart(3,'0') : (i+1).toString().padStart(3,'0')}`;

        const prev = db.prepare('SELECT id FROM candidatos WHERE id = ?').get(id);
        insert.run(id, r.nome, r.email, r.whatsapp, r.instagram, r.cidade, r.modalidade, r.motivo, r.data);
        if (prev) atualizados++; else novos++;
      });
    });
    tx();

    db.prepare(`INSERT INTO sync_log (tipo, status, mensagem, novos, atualizados) VALUES ('sheets','ok',?,?,?)`)
      .run(`${rows.length} registros processados`, novos, atualizados);

    res.json({ ok: true, total: rows.length, novos, atualizados });
  } catch (err) {
    db.prepare(`INSERT INTO sync_log (tipo, status, mensagem, erros) VALUES ('sheets','erro',?,1)`).run(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SYNC CARTPANDA ────────────────────────────────────────────────────────────
app.post('/api/sync/cartpanda', auth, async (req, res) => {
  try {
    const { dateStart, dateEnd } = req.body;
    const orders = await cartpanda.getAllOrdersByDateRange(dateStart, dateEnd);

    // Get all affiliates with their coupons
    const afiliados = db.prepare('SELECT id, cupom, comissao_pct FROM afiliados WHERE status = "ativo"').all();
    const cupomMap = {};
    afiliados.forEach(a => { cupomMap[a.cupom.toUpperCase()] = a; });

    let novos = 0, ignorados = 0;

    const insertPedido = db.prepare(`
      INSERT OR IGNORE INTO pedidos 
        (cartpanda_order_id, numero_pedido, afiliado_id, cupom, cliente_nome, cliente_email,
         valor_produtos, valor_desconto, valor_frete, valor_total, base_comissionavel, comissao_valor,
         status_pagamento, status_pedido, cancelado, reembolso_valor, data_pedido, data_pagamento, raw_data)
      VALUES 
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      orders.forEach(order => {
        const d = cartpanda.extractOrderData(order);

        // Skip invalid orders
        if (d.cancelado) { ignorados++; return; }
        if (!d.cupom)    { ignorados++; return; }

        const afiliado = cupomMap[d.cupom];
        const afiliadoId = afiliado?.id || null;
        const comissao = afiliado ? (d.base_comissionavel * afiliado.comissao_pct / 100) : 0;

        const result = insertPedido.run(
          d.cartpanda_order_id, d.numero_pedido, afiliadoId, d.cupom,
          d.cliente_nome, d.cliente_email,
          d.valor_produtos, d.valor_desconto, d.valor_frete, d.valor_total,
          d.base_comissionavel, comissao,
          d.status_pagamento, d.status_pedido, d.cancelado,
          d.reembolso_valor, d.data_pedido, d.data_pagamento, d.raw_data
        );

        if (result.changes > 0) novos++; else ignorados++;
      });
    });
    tx();

    db.prepare(`INSERT INTO sync_log (tipo, status, mensagem, novos) VALUES ('cartpanda','ok',?,?)`)
      .run(`${orders.length} pedidos processados`, novos);

    res.json({ ok: true, total: orders.length, novos, ignorados });
  } catch (err) {
    db.prepare(`INSERT INTO sync_log (tipo, status, mensagem, erros) VALUES ('cartpanda','erro',?,1)`).run(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── RANKING ───────────────────────────────────────────────────────────────────
app.get('/api/ranking', auth, (req, res) => {
  try {
    const ranking = db.prepare(`
      SELECT 
        a.id, a.cupom, a.comissao_pct, a.status,
        c.name, c.instagram, c.cidade,
        COUNT(p.id) as pedidos,
        COALESCE(SUM(p.base_comissionavel), 0) as total_vendido,
        COALESCE(AVG(p.valor_total), 0) as ticket_medio,
        COALESCE(SUM(p.comissao_valor), 0) as comissao,
        MAX(p.data_pedido) as ultima_venda
      FROM afiliados a
      JOIN candidatos c ON c.id = a.candidato_id
      LEFT JOIN pedidos p ON p.afiliado_id = a.id AND p.cancelado = 0
      GROUP BY a.id
      ORDER BY total_vendido DESC
    `).all();
    res.json({ ranking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LOGS ──────────────────────────────────────────────────────────────────────
app.get('/api/logs', auth, (req, res) => {
  const logs = db.prepare('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 50').all();
  res.json({ logs });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ MOVVA Affiliates API rodando na porta ${PORT}`);
  console.log(`   CartPanda: ${process.env.CARTPANDA_SLUG}.cartpanda.com`);
  console.log(`   Google Sheets ID: ${process.env.GOOGLE_SHEET_ID}`);
});
