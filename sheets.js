const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Página1';

function getAuth() {
  const credentials = {
    type: 'service_account',
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  };
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

// Column mapping — configurável via env
const COL_MAP = {
  data:       parseInt(process.env.COL_DATA       || '0'),  // A
  nome:       parseInt(process.env.COL_NOME       || '1'),  // B
  email:      parseInt(process.env.COL_EMAIL      || '2'),  // C
  whatsapp:   parseInt(process.env.COL_WHATSAPP   || '3'),  // D
  instagram:  parseInt(process.env.COL_INSTAGRAM  || '4'),  // E
  cidade:     parseInt(process.env.COL_CIDADE     || '5'),  // F
  modalidade: parseInt(process.env.COL_MODALIDADE || '6'),  // G
  motivo:     parseInt(process.env.COL_MOTIVO     || '7'),  // H
};

function cleanWpp(w) {
  if (!w) return '';
  const d = w.replace(/\D/g, '');
  return d.length > 11 ? d.slice(-11) : d;
}

function cleanIg(ig) {
  if (!ig) return '—';
  ig = ig.trim().replace(/'/g, '');
  if (!ig.startsWith('@') && ig !== '—' && ig.length > 0) ig = '@' + ig;
  return ig;
}

async function syncCandidatos() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:Z`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return { candidatos: [], total: 0 };

  // Skip header if first row looks like headers
  const dataRows = rows[0][COL_MAP.nome]?.toLowerCase().includes('nome') ? rows.slice(1) : rows;

  return dataRows
    .filter(r => r[COL_MAP.nome]?.trim())
    .map((r, i) => ({
      nome:       r[COL_MAP.nome]?.trim() || '',
      email:      r[COL_MAP.email]?.trim() || '',
      whatsapp:   cleanWpp(r[COL_MAP.whatsapp]),
      instagram:  cleanIg(r[COL_MAP.instagram]),
      cidade:     r[COL_MAP.cidade]?.trim() || '',
      modalidade: r[COL_MAP.modalidade]?.trim() || 'Corrida / Trail Running',
      motivo:     r[COL_MAP.motivo]?.trim() || '',
      data:       r[COL_MAP.data]?.trim() || '',
    }));
}

module.exports = { syncCandidatos };
