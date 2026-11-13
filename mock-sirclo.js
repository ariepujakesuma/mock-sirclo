// Mock Sirclo WA Commerce — follows "Nivea API Development & Config" v1.0 (Step 1–7).
// Node 18+, no dependencies.  Run: node mock-sirclo.js
//
// Inbound  (Creacon BE -> mock):  POST /api/webhook        (Infobip-style payload, as in the doc)
// Outbound (mock -> Creacon BE):  POST ${REPLY_URL}        (Sirclo reply payload, as in the doc)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4010);
const REPLY_URL = process.env.REPLY_URL || '';          // e.g. http://localhost:3000/sirclo/reply
const REPLY_TOKEN = process.env.REPLY_TOKEN || '';      // optional Bearer token for REPLY_URL
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

const sessions = new Map(); // customer msisdn -> { step, cart: [] }
const outbox = [];          // last outbound messages, for debugging
const inbox = [];           // last inbound messages, for debugging

const rupiah = n => 'Rp ' + Number(n).toLocaleString('id-ID');
const now = () => new Date().toISOString();
const processId = () => `${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
const push = (arr, item) => { arr.unshift(item); if (arr.length > 100) arr.pop(); };

// ---------- outbound builders (payload shapes copied from the doc) ----------

function showCategory(to) { // Step 1 — List Message
  return {
    from: FIXTURES.businessNumber, to,
    content: {
      body: { text: 'Silakan pilih salah satu fokus produk kategori di bawah ini  ?' },
      action: {
        title: 'Show Category',
        sections: [{ rows: FIXTURES.categories.map(c => ({ id: c.id, title: c.title })) }],
      },
    },
  };
}

function showProduct(to, category) { // Step 3 — Multi Product
  return {
    from: FIXTURES.businessNumber, to,
    content: {
      header: { type: 'TEXT', text: 'Terus Mencari' },
      body: { text: 'Kamu telah memilih produk kategori, selanjutnya silakan pilih produk yang kamu inginkan dengan klik View Items.' },
      action: {
        catalogId: FIXTURES.catalogId,
        sections: [{ title: category.title, productRetailerIds: category.productRetailerIds || FIXTURES.defaultProductRetailerIds }],
      },
    },
  };
}

function showCart(to, cart) { // Step 5 — Reply Button
  const lines = cart.map(i =>
    ` Nama : ${FIXTURES.productNames[i.productRetailerId] || i.productRetailerId}\n` +
    ` ID : ${i.productRetailerId}\n` +
    ` Harga : ${rupiah(i.itemPrice)}\n` +
    ` Jumlah : ${i.quantity}\n` +
    ` Subtotal : ${rupiah(i.itemPrice * i.quantity)}`);
  const total = cart.reduce((s, i) => s + i.itemPrice * i.quantity, 0);
  return {
    from: FIXTURES.businessNumber, to,
    content: {
      body: { text: `Keranjang Belanja:\n -----------------\n${lines.join('\n\n')}\n\n Total : ${rupiah(total)}` },
      action: {
        buttons: [
          { type: 'REPLY', id: 'getcart.keep_browsing', title: 'Terus Mencari' },
          { type: 'REPLY', id: 'getcart.checkout', title: 'Memesan' },
        ],
      },
    },
  };
}

function placeOrderLink(to, cartId) { // Step 7 — Text Message
  return {
    from: FIXTURES.businessNumber, to,
    content: { text: `Silakan lanjutkan pembayaran dengan mengklik tautan berikut ${PUBLIC_URL}/pay/order?scvCartId=${cartId}` },
  };
}

// ---------- state machine ----------

function handleInbound(result) {
  const customer = result.from;
  const msg = result.message || {};
  const s = sessions.get(customer) || { step: 'new', cart: [] };
  sessions.set(customer, s);

  // Step 2: category selected
  if (msg.type === 'INTERACTIVE_LIST_REPLY') {
    const cat = FIXTURES.categories.find(c => c.id === msg.id);
    if (cat) { s.step = 'browsing'; return showProduct(customer, cat); }
  }

  // Step 4: cart sent from WhatsApp catalog
  if (msg.type === 'ORDER' && Array.isArray(msg.productItems)) {
    s.cart = msg.productItems.map(p => ({
      productRetailerId: String(p.productRetailerId),
      itemPrice: Number(p.itemPrice),
      quantity: Number(p.quantity),
    }));
    s.step = 'cart';
    return showCart(customer, s.cart);
  }

  // Step 6 / 6-alt: cart buttons
  if (msg.type === 'INTERACTIVE_BUTTON_REPLY') {
    if (msg.id === 'getcart.checkout' && s.cart.length) {
      const cartId = crypto.randomBytes(24).toString('base64url').slice(0, 32);
      sessions.delete(customer); // session ends after order link (doc ends at Step 7)
      return placeOrderLink(customer, cartId);
    }
    if (msg.id === 'getcart.keep_browsing') { s.step = 'category'; return showCategory(customer); }
  }

  // Step 1: initial data / anything unrecognised -> category list
  s.step = 'category';
  return showCategory(customer);
}

async function sendOutbound(payload) {
  const entry = { at: now(), payload, delivered: false, status: null, error: null };
  push(outbox, entry);
  console.log(`[OUT] -> ${payload.to}\n${JSON.stringify(payload, null, 2)}`);
  if (!REPLY_URL) { entry.error = 'REPLY_URL not set (logged only)'; return; }
  try {
    const res = await fetch(REPLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(REPLY_TOKEN && { Authorization: `Bearer ${REPLY_TOKEN}` }) },
      body: JSON.stringify(payload),
    });
    entry.status = res.status;
    entry.delivered = res.ok;
    entry.response = await res.text();
  } catch (e) {
    entry.error = e.message;
    console.error(`[OUT] failed: ${e.message}`);
  }
  return entry;
}

// Builds an inbound in the same shape Creacon BE sends (OutboundHandler._parse_result)
function fakeInbound(customer, message) {
  return {
    from: customer,
    to: FIXTURES.businessNumber,
    integrationType: 'WHATSAPP',
    receivedAt: now(),
    messageId: crypto.randomUUID(),
    callbackData: 'callbackData',
    message,
    price: { pricePerMessage: 0, currency: 'IDR' },
    contact: { name: 'Simulated Customer' },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs Step 1 -> 7 automatically with dummy choices
async function simulate(opts = {}) {
  const customer = String(opts.customer || '6281337875000');
  const category = FIXTURES.categories.find(c => c.id === opts.categoryId) || FIXTURES.categories[0];
  const items = opts.items || [{ currency: 'IDR', itemPrice: 19500, productRetailerId: '13142601250008', quantity: 1 }];
  const delayMs = Number(opts.delayMs ?? 1500);
  const checkout = opts.checkout !== false;

  const script = [
    ['start session', { type: 'TEXT', text: 'Beli NIVEA di WhatsApp' }],
    ['select category', { type: 'INTERACTIVE_LIST_REPLY', id: category.id, title: category.title }],
    ['add to cart', { type: 'ORDER', catalogId: FIXTURES.catalogId, text: '', productItems: items }],
    checkout
      ? ['click order', { type: 'INTERACTIVE_BUTTON_REPLY', id: 'getcart.checkout', title: 'Memesan' }]
      : ['back to category', { type: 'INTERACTIVE_BUTTON_REPLY', id: 'getcart.keep_browsing', title: 'Terus Mencari' }],
  ];

  sessions.delete(customer);
  const steps = [];
  for (const [label, message] of script) {
    const result = fakeInbound(customer, message);
    push(inbox, { at: now(), simulated: true, body: { results: [result], messageCount: 1, pendingMessageCount: 0 } });
    const out = await sendOutbound(handleInbound(result));
    steps.push({ inbound: label, outbound: out.payload.content, delivered: out.delivered, status: out.status, error: out.error });
    await sleep(delayMs);
  }
  return { customer, replyUrl: REPLY_URL || null, steps };
}

// ---------- http ----------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    // Inbound webhook (what Creacon BE calls, replacing Zanroo/Jatis)
    if (req.method === 'POST' && url.pathname === '/api/webhook') {
      const body = await readJson(req);
      if (!Array.isArray(body.results) || !body.results.length) {
        return send(res, 400, { error: 'expected Infobip-style body: { results: [ { from, to, message: { type, ... } } ] }' });
      }
      push(inbox, { at: now(), body });
      res.writeHead(200); res.end(); // doc: Expected Response = 200 (Status Code)
      for (const r of body.results) {
        console.log(`[IN] <- ${r.from} ${r.message && r.message.type}`);
        await sendOutbound(handleInbound(r));
      }
      return;
    }

    // Stand-in for Creacon BE reply endpoint, so the mock can be tested alone (REPLY_URL=http://localhost:4010/mock/reply)
    if (req.method === 'POST' && url.pathname === '/mock/reply') {
      await readJson(req);
      return send(res, 200, { is_success: true, process_id: processId(), timestamp: now() });
    }

    if (req.method === 'GET' && url.pathname === '/pay/order') {
      return send(res, 200, `<h1>Mock SCV2 Checkout</h1><p>scvCartId: ${url.searchParams.get('scvCartId') || '-'}</p><p>Halaman pembayaran tiruan, tidak ada transaksi sungguhan.</p>`, 'text/html');
    }

    if (req.method === 'POST' && url.pathname === '/mock/simulate') {
      const opts = await readJson(req);
      return send(res, 200, await simulate(opts));
    }

    if (req.method === 'GET' && url.pathname === '/mock/outbox') return send(res, 200, outbox);
    if (req.method === 'GET' && url.pathname === '/mock/inbox') return send(res, 200, inbox);
    if (req.method === 'GET' && url.pathname === '/mock/sessions') return send(res, 200, Object.fromEntries(sessions));
    if (req.method === 'POST' && url.pathname === '/mock/reset') {
      sessions.clear(); outbox.length = 0; inbox.length = 0;
      return send(res, 200, { reset: true });
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Mock Sirclo on ${PUBLIC_URL}  (REPLY_URL=${REPLY_URL || 'not set — log only'})`);
});
