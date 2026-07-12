const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'movva.db');

let db;
let SQL;

async function initDB() {
  SQL = await initSqlJs();
  
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA foreign_keys = ON;`);

  db.run(`
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
      created_at TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now'))
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
  `);

  save();
  console.log('✅ Database initialized');
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function log(candidatoId, acao, detalhe, anterior, novo, usuario) {
  run(
    `INSERT INTO historico (candidato_id, acao, detalhe, valor_anterior, valor_novo, usuario) VALUES (?, ?, ?, ?, ?, ?)`,
    [candidatoId, acao, detalhe || null, anterior || null, novo || null, usuario || 'Cairo Jácome']
  );
}

module.exports = { initDB, run, get, all, log, save };
