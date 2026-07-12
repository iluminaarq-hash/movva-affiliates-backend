const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'movva.db');
const db = new Database(DB_PATH);

// Enable WAL for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS candidatos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    whatsapp TEXT,
    instagram TEXT,
    cidade TEXT,
    modalidade TEXT,
    motivo TEXT,
    seguidores TEXT,
    stories_views TEXT,
    experiencia TEXT,
    nichado TEXT,
    endereco TEXT,
    data_inscricao TEXT,
    fonte TEXT,
    status TEXT DEFAULT 'Novo inscrito',
    nota INTEGER DEFAULT 0,
    responsavel TEXT,
    observacoes TEXT,
    cupom TEXT,
    comissao_pct REAL DEFAULT 10,
    desconto_pct REAL DEFAULT 15,
    cpf TEXT,
    chave_pix TEXT,
    data_aprovacao TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidato_id TEXT NOT NULL,
    acao TEXT NOT NULL,
    detalhe TEXT,
    usuario TEXT DEFAULT 'Cairo Jácome',
    valor_anterior TEXT,
    valor_novo TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (candidato_id) REFERENCES candidatos(id)
  );

  CREATE TABLE IF NOT EXISTS contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidato_id TEXT NOT NULL,
    canal TEXT,
    mensagem TEXT,
    resposta TEXT,
    resultado TEXT,
    proxima_acao TEXT,
    data_proxima_acao TEXT,
    responsavel TEXT DEFAULT 'Cairo Jácome',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (candidato_id) REFERENCES candidatos(id)
  );

  CREATE TABLE IF NOT EXISTS afiliados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidato_id TEXT UNIQUE NOT NULL,
    cupom TEXT UNIQUE NOT NULL,
    desconto_pct REAL DEFAULT 15,
    comissao_pct REAL DEFAULT 10,
    cpf TEXT,
    chave_pix TEXT,
    cartpanda_discount_id TEXT,
    status TEXT DEFAULT 'ativo',
    data_inicio TEXT,
    observacoes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (candidato_id) REFERENCES candidatos(id)
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cartpanda_order_id TEXT UNIQUE NOT NULL,
    numero_pedido TEXT,
    afiliado_id INTEGER,
    cupom TEXT,
    cliente_nome TEXT,
    cliente_email TEXT,
    valor_produtos REAL DEFAULT 0,
    valor_desconto REAL DEFAULT 0,
    valor_frete REAL DEFAULT 0,
    valor_total REAL DEFAULT 0,
    base_comissionavel REAL DEFAULT 0,
    comissao_valor REAL DEFAULT 0,
    status_pagamento TEXT,
    status_pedido TEXT,
    status_comissao TEXT DEFAULT 'em_analise',
    cancelado INTEGER DEFAULT 0,
    reembolso_valor REAL DEFAULT 0,
    data_pedido TEXT,
    data_pagamento TEXT,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (afiliado_id) REFERENCES afiliados(id)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT,
    status TEXT,
    mensagem TEXT,
    novos INTEGER DEFAULT 0,
    atualizados INTEGER DEFAULT 0,
    erros INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_candidatos_status ON candidatos(status);
  CREATE INDEX IF NOT EXISTS idx_candidatos_whatsapp ON candidatos(whatsapp);
  CREATE INDEX IF NOT EXISTS idx_pedidos_cupom ON pedidos(cupom);
  CREATE INDEX IF NOT EXISTS idx_pedidos_afiliado ON pedidos(afiliado_id);
  CREATE INDEX IF NOT EXISTS idx_historico_candidato ON historico(candidato_id);
`);

// ── HELPERS ──────────────────────────────────────────────────────────────────
const log = (candidatoId, acao, detalhe, anterior, novo, usuario) => {
  db.prepare(`
    INSERT INTO historico (candidato_id, acao, detalhe, valor_anterior, valor_novo, usuario)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidatoId, acao, detalhe || null, anterior || null, novo || null, usuario || 'Cairo Jácome');
};

module.exports = { db, log };
