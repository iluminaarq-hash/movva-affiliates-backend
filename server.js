require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const dbModule = require('./db');
const cartpanda = require('./cartpanda');
let _globalDb = null; // will be set on init
const sheets = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

const auth = (req, res, next) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok', app: 'MOVVA Affiliates API', version: '1.0.0', time: new Date().toISOString()
}));

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, (req, res) => {
  try {
    const { run, get, all, log } = req.db;
    const byStatus = all(`SELECT status, COUNT(*) as total FROM candidatos GROUP BY status`);
    const afiliados = get(`SELECT COUNT(*) as total FROM afiliados WHERE status = 'ativo'`);
    const vendasMes = get(`SELECT COUNT(*) as pedidos, COALESCE(SUM(base_comissionavel),0) as total_vendido, COALESCE(SUM(comissao_valor),0) as total_comissao FROM pedidos WHERE cancelado=0 AND strftime('%Y-%m',data_pedido)=strftime('%Y-%m','now')`);
    const topAfiliados = all(`SELECT a.id, a.cupom, a.comissao_pct, c.name, c.instagram, COUNT(p.id) as pedidos, COALESCE(SUM(p.base_comissionavel),0) as total_vendido, COALESCE(SUM(p.comissao_valor),0) as comissao FROM afiliados a JOIN candidatos c ON c.id=a.candidato_id LEFT JOIN pedidos p ON p.afiliado_id=a.id AND p.cancelado=0 GROUP BY a.id ORDER BY total_vendido DESC LIMIT 5`);
    const ultimaSync = get(`SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 1`);
    res.json({ byStatus, afiliados, vendasMes, topAfiliados, ultimaSync });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CANDIDATOS ────────────────────────────────────────────────────────────────
app.get('/api/candidatos', auth, (req, res) => {
  try {
    const { all, get } = req.db;
    const { status, modalidade, fonte, search, page = 1, limit = 200 } = req.query;
    let where = ['1=1']; const params = [];
    if (status)     { where.push('status = ?'); params.push(status); }
    if (modalidade) { where.push('modalidade = ?'); params.push(modalidade); }
    if (fonte)      { where.push('fonte = ?'); params.push(fonte); }
    if (search) {
      where.push('(name LIKE ? OR instagram LIKE ? OR email LIKE ? OR cidade LIKE ?)');
      const q = `%${search}%`; params.push(q,q,q,q);
    }
    const offset = (parseInt(page)-1)*parseInt(limit);
    const totalRow = get(`SELECT COUNT(*) as n FROM candidatos WHERE ${where.join(' AND ')}`, params);
    const total = totalRow ? totalRow.n : 0;
    const data = all(`SELECT * FROM candidatos WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
    res.json({ data, total, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/candidatos/:id', auth, (req, res) => {
  const { get, all } = req.db;
  const c = get('SELECT * FROM candidatos WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Não encontrado' });
  const historico = all('SELECT * FROM historico WHERE candidato_id = ? ORDER BY created_at DESC', [req.params.id]);
  const contatos  = all('SELECT * FROM contatos  WHERE candidato_id = ? ORDER BY created_at DESC', [req.params.id]);
  res.json({ ...c, historico, contatos });
});

app.patch('/api/candidatos/:id/status', auth, (req, res) => {
  try {
    const { run, get, log } = req.db;
    const { status, usuario } = req.body;
    const c = get('SELECT status FROM candidatos WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Não encontrado' });
    run('UPDATE candidatos SET status=?, updated_at=datetime("now") WHERE id=?', [status, req.params.id]);
    log(req.params.id, 'status_alterado', null, c.status, status, usuario);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/candidatos/:id', auth, (req, res) => {
  try {
    const { run } = req.db;
    const fields = ['nota','observacoes','responsavel','status'];
    const updates = []; const params = [];
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f}=?`); params.push(req.body[f]); } });
    if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar' });
    updates.push('updated_at=datetime("now")');
    params.push(req.params.id);
    run(`UPDATE candidatos SET ${updates.join(',')} WHERE id=?`, params);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/candidatos/bulk/status', auth, (req, res) => {
  try {
    const { run, log } = req.db;
    const { ids, status, usuario } = req.body;
    ids.forEach(id => {
      run('UPDATE candidatos SET status=?,updated_at=datetime("now") WHERE id=?', [status, id]);
      log(id, 'status_alterado', null, null, status, usuario||'Cairo Jácome');
    });
    res.json({ ok: true, updated: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONTATOS ──────────────────────────────────────────────────────────────────
app.post('/api/candidatos/:id/contatos', auth, (req, res) => {
  try {
    const { run, log } = req.db;
    const { canal, mensagem, resposta, resultado, proxima_acao, data_proxima_acao, responsavel } = req.body;
    run(`INSERT INTO contatos (candidato_id,canal,mensagem,resposta,resultado,proxima_acao,data_proxima_acao,responsavel) VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, canal, mensagem, resposta, resultado, proxima_acao, data_proxima_acao, responsavel||'Cairo Jácome']);
    log(req.params.id, 'contato_registrado', `Canal: ${canal}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AFILIADOS ─────────────────────────────────────────────────────────────────
app.get('/api/afiliados', auth, (req, res) => {
  try {
    const { all } = req.db;
    const data = all(`SELECT a.*, c.name, c.instagram, c.whatsapp, c.email, c.cidade, c.modalidade, COUNT(p.id) as total_pedidos, COALESCE(SUM(p.base_comissionavel),0) as total_vendido, COALESCE(SUM(p.comissao_valor),0) as comissao_acumulada, MAX(p.data_pedido) as ultima_venda FROM afiliados a JOIN candidatos c ON c.id=a.candidato_id LEFT JOIN pedidos p ON p.afiliado_id=a.id AND p.cancelado=0 GROUP BY a.id ORDER BY total_vendido DESC`);
    res.json({ data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/afiliados', auth, async (req, res) => {
  try {
    const { run, get, log } = req.db;
    const { candidato_id, cupom, desconto_pct, comissao_pct, cpf, chave_pix, observacoes, criar_cupom } = req.body;
    const existing = get('SELECT id FROM afiliados WHERE cupom=?', [cupom.toUpperCase()]);
    if (existing) return res.status(400).json({ error: 'Cupom já vinculado a outro afiliado' });
    let cartpanda_discount_id = null;
    if (criar_cupom) {
      try {
        const cpRes = await cartpanda.createDiscount({ code: cupom, discountPct: desconto_pct||15, startDate: new Date().toISOString().slice(0,10) });
        cartpanda_discount_id = cpRes?.discounts?.id ? String(cpRes.discounts.id) : null;
      } catch (e) { console.error('CartPanda:', e.message); }
    }
    run(`INSERT INTO afiliados (candidato_id,cupom,desconto_pct,comissao_pct,cpf,chave_pix,cartpanda_discount_id,observacoes,data_inicio) VALUES (?,?,?,?,?,?,?,?,date('now'))`,
      [candidato_id, cupom.toUpperCase(), desconto_pct||15, comissao_pct||10, cpf, chave_pix, cartpanda_discount_id, observacoes]);
    run(`UPDATE candidatos SET status='Ativo',cupom=?,updated_at=datetime('now') WHERE id=?`, [cupom.toUpperCase(), candidato_id]);
    log(candidato_id, 'aprovado_afiliado', `Cupom: ${cupom.toUpperCase()}`, 'Aprovado', 'Ativo');
    res.json({ ok: true, cartpanda_discount_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/afiliados/:id/pedidos', auth, (req, res) => {
  try {
    const { all, get } = req.db;
    const data = all('SELECT * FROM pedidos WHERE afiliado_id=? ORDER BY data_pedido DESC', [req.params.id]);
    const stats = get(`SELECT COUNT(*) as total_pedidos, COALESCE(SUM(base_comissionavel),0) as total_vendido, COALESCE(SUM(comissao_valor),0) as total_comissao, COALESCE(AVG(valor_total),0) as ticket_medio FROM pedidos WHERE afiliado_id=? AND cancelado=0`, [req.params.id]);
    res.json({ data, stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SYNC SHEETS ───────────────────────────────────────────────────────────────
app.post('/api/sync/sheets', auth, async (req, res) => {
  try {
    const { run, get, log } = req.db;
    const rows = await sheets.syncCandidatos();
    let novos = 0, atualizados = 0;
    rows.forEach((r, i) => {
      const id = `MVV${String(i+1).padStart(3,'0')}`;
      const existing = r.whatsapp ? get('SELECT id FROM candidatos WHERE whatsapp=?', [r.whatsapp]) : null;
      const finalId = existing?.id || id;
      const prev = get('SELECT id FROM candidatos WHERE id=?', [finalId]);
      run(`INSERT INTO candidatos (id,name,email,whatsapp,instagram,cidade,modalidade,motivo,data_inscricao,fonte) VALUES (?,?,?,?,?,?,?,?,?,'Formulário site 2026') ON CONFLICT(id) DO UPDATE SET email=excluded.email,instagram=excluded.instagram,cidade=excluded.cidade,motivo=excluded.motivo,updated_at=datetime('now')`,
        [finalId, r.nome, r.email, r.whatsapp, r.instagram, r.cidade, r.modalidade, r.motivo, r.data]);
      if (prev) atualizados++; else novos++;
    });
    run(`INSERT INTO sync_log (tipo,status,mensagem,novos,atualizados) VALUES ('sheets','ok',?,?,?)`,
      [`${rows.length} registros processados`, novos, atualizados]);
    res.json({ ok: true, total: rows.length, novos, atualizados });
  } catch (err) {
    req.db.run(`INSERT INTO sync_log (tipo,status,mensagem,erros) VALUES ('sheets','erro',?,1)`, [err.message]);
    res.status(500).json({ error: err.message });
  }
});

// ── SYNC CARTPANDA ────────────────────────────────────────────────────────────
app.post('/api/sync/cartpanda', auth, async (req, res) => {
  try {
    const { run, all, get } = req.db;
    const { dateStart, dateEnd } = req.body;
    const orders = await cartpanda.getAllOrdersByDateRange(dateStart, dateEnd);
    const afiliados = all('SELECT id, cupom, comissao_pct FROM afiliados WHERE status="ativo"');
    const cupomMap = {};
    afiliados.forEach(a => { cupomMap[a.cupom.toUpperCase()] = a; });
    let novos = 0, ignorados = 0;
    orders.forEach(order => {
      const d = cartpanda.extractOrderData(order);
      if (d.cancelado || !d.cupom) { ignorados++; return; }
      const afiliado = cupomMap[d.cupom];
      const afiliadoId = afiliado?.id || null;
      const comissao = afiliado ? (d.base_comissionavel * afiliado.comissao_pct / 100) : 0;
      try {
        run(`INSERT OR IGNORE INTO pedidos (cartpanda_order_id,numero_pedido,afiliado_id,cupom,cliente_nome,cliente_email,valor_produtos,valor_desconto,valor_frete,valor_total,base_comissionavel,comissao_valor,status_pagamento,status_pedido,cancelado,reembolso_valor,data_pedido,data_pagamento,raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [d.cartpanda_order_id,d.numero_pedido,afiliadoId,d.cupom,d.cliente_nome,d.cliente_email,d.valor_produtos,d.valor_desconto,d.valor_frete,d.valor_total,d.base_comissionavel,comissao,d.status_pagamento,d.status_pedido,d.cancelado,d.reembolso_valor,d.data_pedido,d.data_pagamento,d.raw_data]);
        novos++;
      } catch(e) { ignorados++; }
    });
    run(`INSERT INTO sync_log (tipo,status,mensagem,novos) VALUES ('cartpanda','ok',?,?)`, [`${orders.length} pedidos processados`, novos]);
    res.json({ ok: true, total: orders.length, novos, ignorados });
  } catch (err) {
    req.db.run(`INSERT INTO sync_log (tipo,status,mensagem,erros) VALUES ('cartpanda','erro',?,1)`, [err.message]);
    res.status(500).json({ error: err.message });
  }
});

// ── RANKING ───────────────────────────────────────────────────────────────────
app.get('/api/ranking', auth, (req, res) => {
  try {
    const { all } = req.db;
    const ranking = all(`SELECT a.id,a.cupom,a.comissao_pct,a.status,c.name,c.instagram,c.cidade, COUNT(p.id) as pedidos, COALESCE(SUM(p.base_comissionavel),0) as total_vendido, COALESCE(AVG(p.valor_total),0) as ticket_medio, COALESCE(SUM(p.comissao_valor),0) as comissao, MAX(p.data_pedido) as ultima_venda FROM afiliados a JOIN candidatos c ON c.id=a.candidato_id LEFT JOIN pedidos p ON p.afiliado_id=a.id AND p.cancelado=0 GROUP BY a.id ORDER BY total_vendido DESC`);
    res.json({ ranking });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logs', auth, (req, res) => {
  const logs = req.db.all('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 50');
  res.json({ logs });
});

// ── BULK IMPORT candidatos (para importar os 370 via painel) ─────────────────
app.post('/api/candidatos/bulk/import', auth, (req, res) => {
  try {
    const { run } = req.db;
    const { candidatos } = req.body;
    let importados = 0;
    candidatos.forEach(c => {
      try {
        run(`INSERT OR IGNORE INTO candidatos (id,name,email,whatsapp,instagram,cidade,modalidade,motivo,seguidores,stories_views,experiencia,data_inscricao,fonte,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [c.id,c.name,c.email||'',c.whatsapp||'',c.instagram||'—',c.cidade||'',c.modalidade||'',c.motivo||'',c.seguidores||'',c.stories_views||'',c.experiencia||'',c.data||'',c.fonte||'',c.status||'Novo inscrito']);
        importados++;
      } catch(e) {}
    });
    res.json({ ok: true, importados });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ── IMPORT COUPONS FROM CARTPANDA UI ─────────────────────────────────────────
// Recebe lista de cupons coletada via browser e importa pedidos
app.post('/api/cartpanda/import-coupons', auth, async (req, res) => {
  try {
    const { coupons = [], comissao_pct = 10 } = req.body;
    const db = req.db || _globalDb;
    if (!db) return res.status(503).json({ error: 'DB not ready' });
    let criados = 0, existentes = 0, pedidosTotal = 0;
    const resultado = [];
    const erros = [];

    for (const d of coupons) {
      const cupom = (d.code || '').toUpperCase().trim();
      if (!cupom) continue;

      // Verificar/criar afiliado
      let afiliado = db.get('SELECT id, comissao_pct FROM afiliados WHERE cupom = ?', [cupom]);
      
      if (!afiliado) {
        // Tentar achar candidato pelo nome similar ao cupom
        const nomeGuess = cupom.replace(/[0-9]/g,'').toLowerCase();
        const candidatoExist = nomeGuess.length > 3 
          ? db.prepare("SELECT id FROM candidatos WHERE LOWER(name) LIKE ? OR LOWER(instagram) LIKE ?").get('%'+nomeGuess+'%','%'+nomeGuess+'%')
          : null;
        
        const countC = db.prepare('SELECT COUNT(*) as n FROM candidatos').get().n;
        const candidatoId = candidatoExist?.id || ('EXT' + String(countC + 1).padStart(3,'0'));
        
        if (!candidatoExist) {
          db.prepare("INSERT OR IGNORE INTO candidatos (id, name, whatsapp, instagram, cupom, status, fonte, data_inscricao) VALUES (?,?,'','',?,'Ativo','CartPanda import',date('now'))").run(candidatoId, cupom, cupom);
        }
        
        db.prepare("INSERT OR IGNORE INTO afiliados (candidato_id, cupom, desconto_pct, comissao_pct, cartpanda_discount_id, status, data_inicio) VALUES (?,?,?,?,?,'ativo',date('now'))").run(
          candidatoId, cupom, 10, comissao_pct, String(d.id||'')
        );
        db.prepare("UPDATE candidatos SET cupom=?,status='Ativo' WHERE id=?").run(cupom, candidatoId);
        
        afiliado = db.prepare('SELECT id, comissao_pct FROM afiliados WHERE cupom = ?').get(cupom);
        criados++;
      } else {
        existentes++;
      }

      // Buscar pedidos com esse cupom via CartPanda API
      try {
        const orders = await cartpanda.getOrdersByCoupon(cupom);
        const paidOrders = orders.filter(o => !o.cancelled_at);
        
        if (afiliado && paidOrders.length > 0) {
          const insertP = db.prepare("INSERT OR IGNORE INTO pedidos (cartpanda_order_id,numero_pedido,afiliado_id,cupom,cliente_nome,cliente_email,valor_produtos,valor_desconto,valor_frete,valor_total,base_comissionavel,comissao_valor,status_pagamento,status_pedido,cancelado,data_pedido,raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
          let vendasCupom = 0;
          const tx = (fn) => fn(); // db.transaction simplified
const _tx_fn = (() => {
            paidOrders.forEach(o => {
              const d2 = cartpanda.extractOrderData(o);
              const com = d2.base_comissionavel * afiliado.comissao_pct / 100;
              insertP.run(d2.cartpanda_order_id,d2.numero_pedido,afiliado.id,cupom,d2.cliente_nome,d2.cliente_email,d2.valor_produtos,d2.valor_desconto,d2.valor_frete,d2.valor_total,d2.base_comissionavel,com,d2.status_pagamento,d2.status_pedido,d2.cancelado,d2.data_pedido,d2.raw_data);
              vendasCupom += d2.base_comissionavel;
              pedidosTotal++;
            });
          });
          tx();
          if (paidOrders.length > 0) {
            resultado.push({ cupom, pedidos: paidOrders.length, total_vendido: vendasCupom.toFixed(2) });
          }
        }
      } catch(orderErr) {
        erros.push({ cupom, erro: orderErr.message });
      }
    }

    res.json({ 
      ok: true, 
      total_cupons: coupons.length, 
      afiliados_criados: criados, 
      afiliados_existentes: existentes, 
      pedidos_importados: pedidosTotal,
      cupons_com_vendas: resultado,
      erros: erros.slice(0,10)
    });
  } catch(err) {
    console.error('import-coupons error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CARTPANDA PROXY ────────────────────────────────────────────────────────────
app.get('/api/cartpanda/discounts', auth, async (req, res) => {
  try {

    const db = req.db;    const all = await cartpanda.listDiscountsAll();
    res.json({ ok: true, total: all.length, discounts: all });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cartpanda/orders-by-coupon/:coupon', auth, async (req, res) => {
  try {

    const db = req.db;    const orders = await cartpanda.getOrdersByCoupon(req.params.coupon);
    res.json({ ok: true, total: orders.length, orders });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cartpanda/sync-coupons', auth, async (req, res) => {
  try {

    const db = req.db;    const { comissao_pct = 10 } = req.body;
    const discounts = await cartpanda.listDiscountsAll();
    let criados = 0, existentes = 0, pedidosTotal = 0;
    const resultado = [];

    for (const d of discounts) {
      const cupom = (d.code || '').toUpperCase().trim();
      if (!cupom) continue;
      const existing = db.get('SELECT id FROM afiliados WHERE cupom = ?', [cupom]);
      const orders = await cartpanda.getOrdersByCoupon(cupom);
      const paidOrders = orders.filter(o => !o.cancelled_at);

      if (!existing && paidOrders.length > 0) {
        const countC = db.get('SELECT COUNT(*) as n FROM candidatos', []).n;
        const candidatoId = 'EXT' + String(countC + 1).padStart(3,'0');
        const nomeGuess = cupom.replace(/[0-9]/g,'').toLowerCase();
        const candidatoExist = db.get("SELECT id FROM candidatos WHERE LOWER(name) LIKE ? OR LOWER(instagram) LIKE ?", ['%'+nomeGuess+'%','%'+nomeGuess+'%']);
        const afiliadoCandidatoId = candidatoExist?.id || candidatoId;
        if (!candidatoExist) {
          db.run("INSERT OR IGNORE INTO candidatos (id, name, whatsapp, instagram, cupom, status, fonte, data_inscricao) VALUES (?,?,'','',?,'Ativo','CartPanda import',date('now'))", [candidatoId, cupom, cupom]);
        }
        db.run("INSERT OR IGNORE INTO afiliados (candidato_id, cupom, desconto_pct, comissao_pct, cartpanda_discount_id, status, data_inicio) VALUES (?,?,?,?,?,'ativo',date('now'))", [afiliadoCandidatoId, cupom, parseFloat(d.discount||10]), comissao_pct, String(d.id||''));
        db.run("UPDATE candidatos SET cupom=?,status='Ativo' WHERE id=?", [cupom, afiliadoCandidatoId]);
        criados++;
      } else if (existing) { existentes++; }

      const afiliado = db.get('SELECT id, comissao_pct FROM afiliados WHERE cupom = ?', [cupom]);
      if (afiliado && paidOrders.length > 0) {
        const insertP = _globalDb.prepare("INSERT OR IGNORE INTO pedidos (cartpanda_order_id,numero_pedido,afiliado_id,cupom,cliente_nome,cliente_email,valor_produtos,valor_desconto,valor_frete,valor_total,base_comissionavel,comissao_valor,status_pagamento,status_pedido,cancelado,data_pedido,raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        let vendasCupom = 0;
        const tx = (fn) => fn(); // db.transaction simplified
const _tx_fn = (() => {
          paidOrders.forEach(o => {
            const d2 = cartpanda.extractOrderData(o);
            const com = d2.base_comissionavel * afiliado.comissao_pct / 100;
            insertP.run(d2.cartpanda_order_id,d2.numero_pedido,afiliado.id,cupom,d2.cliente_nome,d2.cliente_email,d2.valor_produtos,d2.valor_desconto,d2.valor_frete,d2.valor_total,d2.base_comissionavel,com,d2.status_pagamento,d2.status_pedido,d2.cancelado,d2.data_pedido,d2.raw_data);
            vendasCupom += d2.base_comissionavel; pedidosTotal++;
          });
        });
        tx();
        resultado.push({ cupom, pedidos: paidOrders.length, total_vendido: vendasCupom.toFixed(2), desconto_pct: d.discount, usado: d.used });
      }
    }
    res.json({ ok: true, total_cupons: discounts.length, afiliados_criados: criados, afiliados_existentes: existentes, pedidos_importados: pedidosTotal, cupons_com_vendas: resultado });
  } catch(err) {
    console.error('sync-coupons error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── IMPORT COUPONS FROM CARTPANDA SCRAPE ─────────────────────────────────────
app.post('/api/cartpanda/import-coupons', auth, (req, res) => {
  try {
    const { cupons, comissao_pct_padrao = 10 } = req.body;
    if (!Array.isArray(cupons)) return res.status(400).json({ error: 'cupons deve ser array' });

    let criados = 0, existentes = 0, erros = 0;
    const resultado = [];

    const tx = _globalDb.transaction(() => {
      cupons.forEach(c => {
        const cupom = (c.code || '').toUpperCase().trim();
        if (!cupom) return;

        const usadoNum = parseInt((c.usado || '0').split('/')[0]) || 0;
        
        // Verificar se já existe afiliado com esse cupom
        const existing = _globalDb.prepare('SELECT id FROM afiliados WHERE cupom = ?').get(cupom);
        if (existing) { existentes++; return; }

        // Tentar encontrar candidato existente pelo cupom (nome parcial)
        const nomeGuess = cupom.replace(/[0-9!@#$%]/g,'').toLowerCase();
        let candidatoId = null;
        
        if (nomeGuess.length >= 3) {
          const candidatoExist = _globalDb.prepare(
            "SELECT id FROM candidatos WHERE LOWER(name) LIKE ? OR LOWER(instagram) LIKE ? OR LOWER(cupom) = ?"
          ).get('%'+nomeGuess+'%', '%'+nomeGuess+'%', cupom.toLowerCase());
          candidatoId = candidatoExist?.id;
        }

        // Criar candidato placeholder se não encontrou
        if (!candidatoId) {
          const countC = _globalDb.prepare('SELECT COUNT(*) as n FROM candidatos').get().n;
          candidatoId = 'CP' + String(countC + 1).padStart(3,'0');
          _globalDb.prepare(`
            INSERT OR IGNORE INTO candidatos 
            (id, name, whatsapp, instagram, email, cupom, status, fonte, data_inscricao)
            VALUES (?, ?, '', '', '', ?, 'Ativo', 'CartPanda import', ?)
          `).run(candidatoId, cupom, cupom, c.inicio || '');
        }

        // Criar afiliado
        try {
          _globalDb.prepare(`
            INSERT OR IGNORE INTO afiliados 
            (candidato_id, cupom, desconto_pct, comissao_pct, status, data_inicio)
            VALUES (?, ?, 10, ?, 'ativo', ?)
          `).run(candidatoId, cupom, comissao_pct_padrao, c.inicio || '');

          _globalDb.prepare("UPDATE candidatos SET cupom=?, status='Ativo' WHERE id=?")
            .run(cupom, candidatoId);

          log(candidatoId, 'afiliado_importado', `Importado do CartPanda — ${usadoNum} usos`, null, 'Ativo', 'Sistema');
          criados++;
          resultado.push({ cupom, usado: c.usado, status: c.status });
        } catch(e) { erros++; }
      });
    });
    tx();

    res.json({ ok: true, total: cupons.length, criados, existentes, erros, afiliados: resultado });
  } catch(err) {
    console.error('import-coupons error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── INIT & START ──────────────────────────────────────────────────────────────
dbModule.initDB().then(database => {
  const dbHelpers = {
    run: dbModule.run,
    get: dbModule.get,
    all: dbModule.all,
    log: dbModule.log,
    save: dbModule.save
  };

  _globalDb = dbHelpers; // set global
  // Inject db into every request
  app.use((req, res, next) => { req.db = dbHelpers; next(); });

  app.listen(PORT, () => {
    console.log(`✅ MOVVA Affiliates API rodando na porta ${PORT}`);
    console.log(`   CartPanda slug: ${process.env.CARTPANDA_SLUG}`);
    console.log(`   Google Sheets ID: ${process.env.GOOGLE_SHEET_ID}`);
  });
}).catch(err => {
  console.error('❌ DB init failed:', err);
  process.exit(1);
});
