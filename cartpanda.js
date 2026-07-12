const fetch = require('node-fetch');

const BASE = 'https://accounts.cartpanda.com/api';
const SLUG = process.env.CARTPANDA_SLUG || 'movvazone';
const TOKEN = process.env.CARTPANDA_TOKEN;

const headers = () => ({
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TOKEN}`
});

// ── PEDIDOS ──────────────────────────────────────────────────────────────────
async function listOrders({ dateStart, dateEnd, paymentStatus, page = 1 } = {}) {
  const params = new URLSearchParams({ page });
  if (dateStart) params.set('created_at_min', dateStart);
  if (dateEnd)   params.set('created_at_max', dateEnd);
  if (paymentStatus) params.set('payment_status', paymentStatus);

  const res = await fetch(`${BASE}/${SLUG}/orders?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`CartPanda orders error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getAllOrdersByDateRange(dateStart, dateEnd) {
  const allOrders = [];
  let page = 1;
  let lastPage = 1;

  do {
    const data = await listOrders({ dateStart, dateEnd, paymentStatus: 3, page }); // 3 = paid
    const orders = data?.orders?.data || data?.data || [];
    lastPage = data?.orders?.last_page || data?.last_page || 1;
    allOrders.push(...orders);
    page++;
  } while (page <= lastPage && page <= 20); // max 20 pages safety

  return allOrders;
}

// ── CUPONS ───────────────────────────────────────────────────────────────────
async function createDiscount({ code, discountPct, startDate }) {
  const body = {
    code: code.toUpperCase(),
    type: 'percentage',
    category: 'manual',
    discount: String(discountPct),
    min_requirement: 'none',
    coupon_start_date: startDate || new Date().toISOString().slice(0, 10),
    coupon_start_time: '00:00:00',
    applies_to: 'entire_order'
  };

  const res = await fetch(`${BASE}/${SLUG}/discount`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`CartPanda discount error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listDiscounts() {
  const res = await fetch(`${BASE}/${SLUG}/discount`, { headers: headers() });
  if (!res.ok) throw new Error(`CartPanda list discounts error: ${res.status}`);
  return res.json();
}

// ── EXTRACTOR ─────────────────────────────────────────────────────────────────
function extractOrderData(order) {
  // Normalize CartPanda order structure
  const items = order.order_items || order.items || [];
  const valorProdutos = items.reduce((sum, i) => sum + (parseFloat(i.price) * parseInt(i.quantity || 1)), 0);
  const valorFrete = parseFloat(order.shipping_price || order.shipping || 0);
  const valorDesconto = parseFloat(order.discount_price || order.discount || 0);
  const valorTotal = parseFloat(order.total_price || order.total || 0);
  const baseComissionavel = Math.max(0, valorProdutos - valorDesconto);

  // Extract coupon code
  const cupom = order.discount_code || order.coupon_code || order.coupon || null;

  return {
    cartpanda_order_id: String(order.id),
    numero_pedido: order.order_number || order.number || String(order.id),
    cupom: cupom ? cupom.toUpperCase().trim() : null,
    cliente_nome: order.customer?.name || `${order.first_name || ''} ${order.last_name || ''}`.trim(),
    cliente_email: order.customer?.email || order.email,
    valor_produtos: valorProdutos,
    valor_desconto: valorDesconto,
    valor_frete: valorFrete,
    valor_total: valorTotal,
    base_comissionavel: baseComissionavel,
    status_pagamento: order.financial_status || order.payment_status,
    status_pedido: order.fulfillment_status || order.status,
    cancelado: order.cancelled_at ? 1 : 0,
    reembolso_valor: parseFloat(order.refund_amount || 0),
    data_pedido: order.created_at,
    data_pagamento: order.paid_at || order.processed_at,
    raw_data: JSON.stringify(order)
  };
}

module.exports = { listOrders, getAllOrdersByDateRange, createDiscount, listDiscounts, extractOrderData };
