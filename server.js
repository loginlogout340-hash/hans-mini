'use strict';
/**
 * The pairing website. No extra packages needed.
 *   GET  /              the page
 *   GET  /api/info      { name, codeRequired }
 *   POST /api/pair      { number, access }  ->  { code }
 *   GET  /api/status    ?number=...         ->  { state: connected | pending | none }
 *   GET  /health
 *
 * Railway variables:
 *   ACCESS_CODE   one or more access codes separated by commas. Leave it empty to let anyone pair.
 */
const http = require('http');
const crypto = require('crypto');
const manager = require('./manager');
const page = require('./page');

const BOT_NAME = process.env.BOT_NAME || 'Hans-Mini';
const CODES = (process.env.ACCESS_CODE || '').split(',').map((s) => s.trim()).filter(Boolean);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const accessOk = (given) => !CODES.length || CODES.some((c) => crypto.timingSafeEqual(sha(given), sha(c)));
if (!CODES.length) console.warn('WARNING: ACCESS_CODE is not set, so anyone with the link can pair a number.');

// simple rate limits (per visitor address)
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
const lastPair = new Map(); // number -> time of last attempt

const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4096) { reject(new manager.UserError('Request too large.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new manager.UserError('Bad request.')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = ipOf(req);

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, page(BOT_NAME, CODES.length > 0), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok');
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return send(res, 200, { name: BOT_NAME, codeRequired: CODES.length > 0 });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (limited('s:' + ip, 150, 600000)) return send(res, 429, { error: 'Too many requests. Wait a few minutes.' });
      return send(res, 200, { state: manager.status(url.searchParams.get('number')) });
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      if (limited('p:' + ip, 6, 600000)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      const body = await readJson(req);
      if (!accessOk(body.access || '')) return send(res, 403, { error: 'Wrong access code.' });
      const number = String(body.number || '').replace(/\D/g, '');
      if (Date.now() - (lastPair.get(number) || 0) < 20000) return send(res, 429, { error: 'Please wait a little before asking for another code.' });
      lastPair.set(number, Date.now());
      const code = await manager.pair(number);
      return send(res, 200, { code: (code.match(/.{1,4}/g) || [code]).join('-'), number });
    }

    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof manager.UserError) return send(res, 400, { error: e.message });
    console.error('server error:', e);
    send(res, 500, { error: 'Could not get a pairing code right now. Please try again in a minute.' });
  }
});

module.exports = server;
