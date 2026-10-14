'use strict';
/**
 * The pairing + payment website. No extra packages needed.
 *   GET  /                 the page
 *   GET  /api/info         { name, restricted, payments, price, days, tutorial }
 *   POST /api/pair         { number, access }            -> { code, number }
 *   GET  /api/status       ?number=...                   -> { state }
 *   POST /api/pay/start    { number, email? }            -> { url }   (Paystack checkout)
 *   GET  /api/pay/verify   ?ref=...                      -> { code, number, expiresAt }
 *   POST /api/pay/webhook  (Paystack calls this)
 *   GET  /admin            your own page for manual codes and the price
 *   GET  /health
 *
 * Railway variables:
 *   ACCESS_CODE     your own code(s), comma separated. They never expire and work for any number.
 *   PAYSTACK_SECRET your Paystack secret key (sk_live_... or sk_test_...). Turns on the Pay button.
 *   ADMIN_KEY       password for /admin (manual codes, price). Optional but recommended.
 *   PUBLIC_URL      https://your-domain (optional; guessed from the request when empty)
 *   PRICE_GHS, PLAN_DAYS   first-time defaults (20 and 30); change them later on /admin
 *   TUTORIAL_URL    link to your tutorial video (optional, shows a Watch tutorial button)
 *   DATA_DIR        folder on the Railway Volume (example /data)
 * If ACCESS_CODE, PAYSTACK_SECRET and ADMIN_KEY are all empty, anyone can pair (open mode).
 */
const http = require('http');
const crypto = require('crypto');
const manager = require('./manager');
const page = require('./page');
const codes = require('./codes');

const BOT_NAME = process.env.BOT_NAME || 'Hans-Mini';
const OWNER_CODES = (process.env.ACCESS_CODE || '').split(',').map((s) => s.trim()).filter(Boolean);
const PAYSTACK = (process.env.PAYSTACK_SECRET || '').trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
const TUTORIAL = (process.env.TUTORIAL_URL || '').trim();
const RESTRICTED = OWNER_CODES.length > 0 || !!PAYSTACK || !!ADMIN_KEY;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const ownerOk = (given) => !!given && OWNER_CODES.some((c) => same(given, c));
if (!RESTRICTED) console.warn('WARNING: no ACCESS_CODE, PAYSTACK_SECRET or ADMIN_KEY set, so anyone with the link can pair a number.');

/* simple rate limits (per visitor address) */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  const over = arr.length >= max;
  if (!over) arr.push(now);
  hits.set(key, arr);
  return over;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
}, 600000).unref();

const PAIR_WAIT_MS = 10000;
const lastPair = new Map();
const inFlight = new Set();

const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const originOf = (req) => (process.env.PUBLIC_URL || `${String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/+$/, '');

function send(res, status, body, type) {
  const isObj = typeof body === 'object';
  res.writeHead(status, {
    'content-type': type || (isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readRaw(req, max = 65536) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > max) { reject(new manager.UserError('Request too large.')); req.destroy(); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readRaw(req, 4096);
  try { return JSON.parse(raw || '{}'); } catch { throw new manager.UserError('Bad request.'); }
}

/* ---------------- Paystack ---------------- */
async function paystack(method, route, body) {
  const r = await fetch('https://api.paystack.co' + route, {
    method,
    headers: { Authorization: 'Bearer ' + PAYSTACK, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === false) throw new Error(j.message || 'Paystack error ' + r.status);
  return j.data;
}

/** a successful Paystack transaction -> code (safe to call twice for the same reference) */
function fulfil(data) {
  const price = codes.settings().price;
  if (!data || data.status !== 'success') throw new manager.UserError('This payment is not complete yet.');
  if (String(data.currency || 'GHS').toUpperCase() !== 'GHS') throw new manager.UserError('Wrong currency.');
  if (Number(data.amount) < Math.round(price * 100)) throw new manager.UserError('The amount paid is less than the price.');
  const number = String(data.metadata?.number || '').replace(/\D/g, '');
  if (!number) throw new manager.UserError('This payment has no phone number attached.');
  return codes.issue({ number, ref: data.reference, source: 'paystack' });
}

/* ---------------- admin page ---------------- */
const adminPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BOT_NAME} admin</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:16px;background:#0b1210;color:#e8f1ec;font:15px/1.5 system-ui,sans-serif}
.w{max-width:640px;margin:0 auto}h1{font-size:20px}h2{font-size:15px;margin:22px 0 8px;color:#8fe3b0}
input,button{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid #2a3a33;background:#101a16;color:inherit}
button{background:#25d366;color:#04210f;font-weight:600;border:0;cursor:pointer}button.s{background:transparent;color:#e8f1ec;border:1px solid #2a3a33;padding:6px 10px;font-weight:400}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.row input{flex:1;min-width:120px}
.item{border:1px solid #2a3a33;border-radius:12px;padding:10px 12px;margin:8px 0;display:flex;justify-content:space-between;gap:10px;align-items:center}
.m{color:#8aa196;font-size:13px}.ok{color:#25d366}.bad{color:#ff6b6b}code{font-size:16px;letter-spacing:1px}
</style></head><body><div class="w"><h1>${BOT_NAME} admin</h1>
<div id="login"><div class="row"><input id="key" type="password" placeholder="Admin key"><button id="go">Open</button></div><div id="e" class="bad"></div></div>
<div id="app" style="display:none">
<h2>Price</h2><div class="row"><input id="price" inputmode="decimal" placeholder="Price GH₵"><input id="days" inputmode="numeric" placeholder="Days"><button id="saveS">Save</button></div><div id="sm" class="m"></div>
<h2>Make a code by hand (for MoMo payments)</h2><div class="row"><input id="num" inputmode="numeric" placeholder="233241234567"><input id="d2" inputmode="numeric" placeholder="Days (default plan)"><button id="mk">Create</button></div><div id="cm" class="m"></div>
<h2>Codes</h2><div id="list"></div></div></div>
<script>
var K='',$=function(i){return document.getElementById(i)};
function api(p,b){return fetch(p,{method:b?'POST':'GET',headers:{'x-admin-key':K,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Error');return j})})}
function dt(t){return new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
function load(){api('/api/admin/list').then(function(j){$('price').value=j.settings.price;$('days').value=j.settings.days;
 $('list').innerHTML=j.codes.length?'':'<div class="m">No codes yet.</div>';
 j.codes.forEach(function(c){var d=document.createElement('div');d.className='item';
  d.innerHTML='<div><code>'+c.code+'</code><div class="m">+'+c.number+' · '+c.source+' · '+(c.active?'<span class="ok">active until '+dt(c.expiresAt)+'</span>':'<span class="bad">ended '+dt(c.expiresAt)+'</span>')+'</div></div>';
  var b=document.createElement('button');b.className='s';b.textContent='Revoke';b.onclick=function(){if(confirm('Revoke '+c.code+'?'))api('/api/admin/revoke',{code:c.code}).then(load)};
  if(c.active)d.appendChild(b);$('list').appendChild(d)})}).catch(function(e){$('login').style.display='';$('app').style.display='none';$('e').textContent=e.message})}
$('go').onclick=function(){K=$('key').value;$('login').style.display='none';$('app').style.display='';load()};
$('saveS').onclick=function(){api('/api/admin/settings',{price:$('price').value,days:$('days').value}).then(function(){$('sm').textContent='Saved.'}).catch(function(e){$('sm').textContent=e.message})};
$('mk').onclick=function(){api('/api/admin/create',{number:$('num').value,days:$('d2').value}).then(function(j){$('cm').innerHTML='Code for +'+j.number+': <code>'+j.code+'</code> (valid until '+dt(j.expiresAt)+'). Send it to them.';load()}).catch(function(e){$('cm').textContent=e.message})};
</script></body></html>`;

const adminOk = (req) => !!ADMIN_KEY && same(req.headers['x-admin-key'] || '', ADMIN_KEY);

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = ipOf(req);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') return send(res, 200, page(BOT_NAME), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/health') return send(res, 200, 'ok');
    if (req.method === 'GET' && p === '/admin') return send(res, 200, ADMIN_KEY ? adminPage() : 'Set the Railway variable ADMIN_KEY to use this page.', 'text/html; charset=utf-8');

    if (req.method === 'GET' && p === '/api/info') {
      const s = codes.settings();
      return send(res, 200, { name: BOT_NAME, restricted: RESTRICTED, payments: !!PAYSTACK, price: s.price, days: s.days, tutorial: TUTORIAL || null });
    }

    if (req.method === 'GET' && p === '/api/status') {
      if (limited('s:' + ip, 150, 600000)) return send(res, 429, { error: 'Too many requests. Wait a few minutes.' });
      return send(res, 200, { state: manager.status(url.searchParams.get('number')) });
    }

    /* ----- pairing ----- */
    if (req.method === 'POST' && p === '/api/pair') {
      if (limited('p:' + ip, 12, 600000)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      const body = await readJson(req);
      const number = String(body.number || '').replace(/\D/g, '');
      const access = String(body.access || '').trim();
      let paid = false;
      if (RESTRICTED && !ownerOk(access)) {
        if (!codes.exists(access)) return send(res, 403, { error: 'Wrong access code.' });
        const c = codes.check(access, number);
        if (!c.ok) return send(res, 403, { error: c.reason });
        paid = true;
      }
      if (inFlight.has(number)) return send(res, 429, { error: 'Your code is being made. Please wait a few seconds.' });
      const wait = PAIR_WAIT_MS - (Date.now() - (lastPair.get(number) || 0));
      if (wait > 0) return send(res, 429, { error: `Please wait ${Math.ceil(wait / 1000)} seconds before asking for another code.` });
      inFlight.add(number);
      try {
        const code = await manager.pair(number);
        lastPair.set(number, Date.now());
        if (paid) codes.markMember(number);
        return send(res, 200, { code: (code.match(/.{1,4}/g) || [code]).join('-'), number });
      } finally {
        inFlight.delete(number);
      }
    }

    /* ----- payments ----- */
    if (req.method === 'POST' && p === '/api/pay/start') {
      if (!PAYSTACK) return send(res, 404, { error: 'Online payment is not switched on.' });
      if (limited('ps:' + ip, 10, 600000)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes.' });
      const body = await readJson(req);
      const number = String(body.number || '').replace(/\D/g, '');
      if (number.length < 8 || number.length > 15) throw new manager.UserError('Enter your WhatsApp number with the country code.');
      let email = String(body.email || '').trim().slice(0, 100);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = `${number}@hans-mini.pay`; // Paystack needs an email address
      const s = codes.settings();
      const reference = 'hm_' + crypto.randomBytes(10).toString('hex');
      const data = await paystack('POST', '/transaction/initialize', {
        email, amount: Math.round(s.price * 100), currency: 'GHS', reference,
        callback_url: originOf(req) + '/',
        metadata: { number, product: BOT_NAME, days: s.days },
      });
      return send(res, 200, { url: data.authorization_url, ref: data.reference || reference });
    }

    if (req.method === 'GET' && p === '/api/pay/verify') {
      if (!PAYSTACK) return send(res, 404, { error: 'Online payment is not switched on.' });
      if (limited('pv:' + ip, 40, 600000)) return send(res, 429, { error: 'Too many requests. Wait a few minutes.' });
      const ref = String(url.searchParams.get('ref') || '').replace(/[^\w-]/g, '').slice(0, 80);
      if (!ref) throw new manager.UserError('Missing payment reference.');
      const data = await paystack('GET', '/transaction/verify/' + encodeURIComponent(ref));
      const rec = fulfil(data);
      return send(res, 200, { code: rec.code, number: rec.number, expiresAt: rec.expiresAt });
    }

    if (req.method === 'POST' && p === '/api/pay/webhook') {
      if (!PAYSTACK) return send(res, 404, { error: 'Not found.' });
      const raw = await readRaw(req);
      const sig = String(req.headers['x-paystack-signature'] || '');
      const mine = crypto.createHmac('sha512', PAYSTACK).update(raw).digest('hex');
      if (sig.length !== mine.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mine))) return send(res, 401, { error: 'Bad signature.' });
      let ev; try { ev = JSON.parse(raw); } catch { return send(res, 400, { error: 'Bad request.' }); }
      if (ev.event === 'charge.success') { try { fulfil(ev.data); } catch (e) { console.error('[pay] webhook:', e.message); } }
      return send(res, 200, 'ok');
    }

    /* ----- admin ----- */
    if (p.startsWith('/api/admin/')) {
      if (limited('a:' + ip, 60, 600000)) return send(res, 429, { error: 'Too many requests.' });
      if (!adminOk(req)) return send(res, 401, { error: 'Wrong admin key.' });
      if (req.method === 'GET' && p === '/api/admin/list') return send(res, 200, { settings: codes.settings(), codes: codes.list() });
      if (req.method === 'POST' && p === '/api/admin/create') {
        const b = await readJson(req);
        try { const r = codes.issue({ number: b.number, days: b.days || undefined, source: 'manual' }); return send(res, 200, { code: r.code, number: r.number, expiresAt: r.expiresAt }); }
        catch (e) { throw new manager.UserError(e.message); }
      }
      if (req.method === 'POST' && p === '/api/admin/revoke') {
        const b = await readJson(req);
        return codes.revoke(b.code) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No such code.' });
      }
      if (req.method === 'POST' && p === '/api/admin/settings') {
        const b = await readJson(req);
        try { return send(res, 200, codes.setSettings({ price: b.price === '' ? null : b.price, days: b.days === '' ? null : b.days })); }
        catch (e) { throw new manager.UserError(e.message); }
      }
    }

    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof manager.UserError) return send(res, 400, { error: e.message });
    console.error('server error:', e);
    send(res, 500, { error: 'Something went wrong. Please try again in a minute.' });
  }
});

/* ---------------- when paid time ends, the number is logged out ---------------- */
async function sweep() {
  for (const n of codes.expiredMembers()) {
    try {
      if (manager.status(n) !== 'none') await manager.removeUser(n, false, '⏰ Your Hans-Mini plan has ended. Pay again on the pairing website to continue.');
      codes.unmember(n);
    } catch (e) { console.error('[sweep]', n, e.message); }
  }
}
setInterval(sweep, 5 * 60000).unref();
setTimeout(sweep, 30000).unref();

module.exports = server;
