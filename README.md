# MOVVA Affiliates — Backend

API Node.js para gestão de afiliados com integração CartPanda + Google Sheets.

## Setup rápido no Railway

### 1. Deploy
1. Crie conta em railway.app com GitHub
2. New Project → Deploy from GitHub repo
3. Selecione este repositório

### 2. Variáveis de ambiente (Railway → Variables)
```
CARTPANDA_TOKEN=3z8gYcPApUEvMBoX
CARTPANDA_SLUG=movvazone
GOOGLE_SHEET_ID=1AapMrdHXmjdGjjWhM__oYEPDeECOpH8PpPuMpHyCxr4
GOOGLE_SERVICE_ACCOUNT_EMAIL=sua-conta@projeto.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
ADMIN_SECRET=movva2026secret
PORT=3001
```

### 3. Google Service Account
1. Acesse console.cloud.google.com
2. Crie um projeto → Ative "Google Sheets API"
3. IAM → Contas de serviço → Criar
4. Baixe o JSON → copie client_email e private_key para as variáveis acima
5. Compartilhe a planilha com o client_email como Leitor

## Endpoints principais

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /api/dashboard | KPIs gerais |
| GET | /api/candidatos | Lista com filtros |
| PATCH | /api/candidatos/:id/status | Alterar status |
| POST | /api/afiliados | Aprovar + criar cupom |
| GET | /api/afiliados | Lista com vendas |
| POST | /api/sync/sheets | Sync Google Sheets |
| POST | /api/sync/cartpanda | Sync pedidos CartPanda |
| GET | /api/ranking | Ranking de afiliados |

## Autenticação
Todos os endpoints exigem header:
```
x-admin-secret: movva2026secret
```
