'use strict';
/**
 * Hans Pulse - a live activity dashboard for every user of the bot.
 *   .pulse            your numbers in the chat
 *   .pulse link       your private dashboard link (a web page with charts and the community)
 *   .pulse link reset make a new link (the old one stops working)
 *   .pulse all        (admin bot only) numbers for the whole bot
 * Counters live in sock.hm.db.pulse (saved per user). The web page is served by server.js:
 *   GET /pulse/<token>   GET /api/pulse/<token>   POST /api/pulse/<token>/(say|join|leave)
 */
const crypto = require('crypto');
const community = require('./community');

const hmOf = (sock) => sock.hm;
const num = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
const DAYS_KEPT = 45;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

const unwrap = (m) => {
  let x = m || {};
  for (let i = 0; i < 4; i++) x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x;
  return x;
};
const textOf = (c) => c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';

/* ---------------- counters ---------------- */
function store(sock) {
  const db = hmOf(sock).db;
  const p = (db.pulse ||= { since: Date.now(), totals: {}, days: {}, cmds: {}, hours: Array(24).fill(0), last: 0 });
  if (!p.hours || p.hours.length !== 24) p.hours = Array(24).fill(0);
  return p;
}
/** pulse.count(sock, 'cmd') - key is one of cmd msg group private status deleted viewonce media calls guard comm */
function count(sock, key, n = 1) {
  try {
    if (!sock?.hm?.db) return;
    const p = store(sock), d = day();
    p.totals[key] = (p.totals[key] || 0) + n;
    const row = (p.days[d] ||= {});
    row[key] = (row[key] || 0) + n;
    if (key === 'cmd' || key === 'msg') p.hours[new Date().getUTCHours()] += n;
    p.last = Date.now();
    const keys = Object.keys(p.days);
    if (keys.length > DAYS_KEPT) for (const k of keys.sort().slice(0, keys.length - DAYS_KEPT)) delete p.days[k];
    sock.hm.save?.();
  } catch (e) { console.error('[pulse] count:', e.message); }
}

const CMD_RE = /^[.!#\/$~,]([a-z][a-z0-9]{1,19})(?=\s|$)/i;

/** called for every message by more.js */
async function passive(sock, m) {
  try {
    const jid = m?.key?.remoteJid;
    if (!jid || !m.message || jid.endsWith('@newsletter')) return;
    if (jid === 'status@broadcast') { if (!m.key.fromMe) count(sock, 'status'); return; }
    const raw = m.message;
    const c = unwrap(raw);
    if (c.protocolMessage) { if (c.protocolMessage.type === 0 || c.protocolMessage.type === 'REVOKE') count(sock, 'deleted'); return; }
    if (c.reactionMessage || c.senderKeyDistributionMessage) return;
    const text = textOf(c).trim();
    const cm = text.match(CMD_RE);
    if (cm) {
      count(sock, 'cmd');
      const p = store(sock), name = cm[1].toLowerCase();
      p.cmds[name] = (p.cmds[name] || 0) + 1;
      return;
    }
    if (m.key.fromMe) return;
    count(sock, 'msg');
    count(sock, jid.endsWith('@g.us') ? 'group' : 'private');
    if (raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension) count(sock, 'viewonce');
    if (c.imageMessage || c.videoMessage || c.audioMessage || c.stickerMessage || c.documentMessage) count(sock, 'media');
  } catch (e) { console.error('[pulse] passive:', e.message); }
}

/* ---------------- numbers for the chat and the page ---------------- */
const BARS = '▁▂▃▄▅▆▇█';
const spark = (arr) => { const mx = Math.max(1, ...arr); return arr.map((v) => BARS[Math.min(7, Math.floor((v / mx) * 7.999))]).join(''); };
const lastDays = (p, n) => Array.from({ length: n }, (_, i) => { const t = Date.now() - (n - 1 - i) * 86400000; const r = p.days[day(t)] || {}; return { d: day(t).slice(5), cmd: r.cmd || 0, msg: r.msg || 0 }; });
const topCmds = (p, k) => Object.entries(p.cmds || {}).sort((a, b) => b[1] - a[1]).slice(0, k);
const upText = (since) => { const s = Math.floor((Date.now() - since) / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600); return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`; };
const busiest = (p) => { const mx = Math.max(...p.hours); return mx ? String(p.hours.indexOf(mx)).padStart(2, '0') + ':00 UTC' : '-'; };

function report(sock, prefix) {
  const p = store(sock), t = p.totals;
  const days = lastDays(p, 7);
  const top = topCmds(p, 5);
  return `📈 *Hans Pulse*\n` +
    `⏱ With you for ${upText(p.since)}\n\n` +
    `⚡ Commands run: *${t.cmd || 0}*\n` +
    `💬 Messages seen: *${t.msg || 0}*  (${t.private || 0} private, ${t.group || 0} group)\n` +
    `🗑 Deleted messages spotted: *${t.deleted || 0}*\n` +
    `📸 Statuses seen: *${t.status || 0}*\n` +
    `👁 View-once seen: *${t.viewonce || 0}*\n` +
    `📎 Media received: *${t.media || 0}*\n` +
    `🛡 Calls blocked: *${t.calls || 0}*   Guard actions: *${t.guard || 0}*\n` +
    `🌍 Community posts: *${t.comm || 0}*\n\n` +
    `📅 Last 7 days (commands)\n${spark(days.map((x) => x.cmd))}  ${days.map((x) => x.cmd).join(' ')}\n` +
    `🕒 Busiest hour: ${busiest(p)}\n\n` +
    `🏆 *Top commands*\n` + (top.length ? top.map(([n, c], i) => `${i + 1}. ${prefix}${n}  (${c})`).join('\n') : 'None yet.') +
    `\n\nFull dashboard: ${prefix}pulse link`;
}

function data(sock) {
  const p = store(sock), hm = hmOf(sock);
  const n = hm.owner || '';
  const ci = community.info(n);
  return {
    name: process.env.BOT_NAME || 'Hans-Mini',
    number: n ? '+' + n.slice(0, 3) + ' ' + '•'.repeat(Math.max(0, n.length - 6)) + ' ' + n.slice(-3) : '',
    since: p.since, last: p.last, totals: p.totals, days: lastDays(p, 14), top: topCmds(p, 8), hours: p.hours,
    community: ci,
  };
}

/* ---------------- private links ---------------- */
const byToken = new Map(); // token -> sock
function ensureToken(sock, reset) {
  const db = hmOf(sock).db;
  if (reset && db.pulseToken) byToken.delete(db.pulseToken);
  if (reset || !db.pulseToken) { db.pulseToken = crypto.randomBytes(18).toString('base64url'); hmOf(sock).save?.(); }
  byToken.set(db.pulseToken, sock);
  return db.pulseToken;
}
const baseUrl = () => (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://hans-mini-production-423a.up.railway.app')).replace(/\/+$/, '');

function boot(sock) {
  const db = hmOf(sock).db;
  if (db.pulseToken) byToken.set(db.pulseToken, sock);
  store(sock);
  sock.ev.on('connection.update', ({ connection }) => { if (connection === 'open') { const t = hmOf(sock).db.pulseToken; if (t) byToken.set(t, sock); } });
}

/* ---------------- command ---------------- */
function register(add) {
  add('pulse', 'Info', '[link | link reset | all]', 'Your activity numbers and private dashboard link', (ctx) => {
    const sub = (ctx.args[0] || '').toLowerCase();
    if (sub === 'link') {
      if (!ctx.isMainOwner) throw new Error('Only the owner of this bot can get the dashboard link.');
      const t = ensureToken(ctx.sock, (ctx.args[1] || '').toLowerCase() === 'reset');
      return `📊 *Your private dashboard*\n${baseUrl()}/pulse/${t}\n\nKeep this link to yourself. Anyone with it can see your numbers and post in the community as you. Make a new one with ${ctx.prefix}pulse link reset`;
    }
    if (sub === 'all') {
      const m = require('./manager');
      if (!process.env.ADMIN_NUMBER || !ctx.isMainOwner || !m.isAdmin(ctx.config.owners[0])) throw new Error('This only works on the admin bot.');
      const st = m.stats(), us = m.users();
      const day24 = us.filter((u) => u.lastActive && Date.now() - u.lastActive < 86400000).length;
      const cmds = us.reduce((a, u) => a + (u.commands || 0), 0);
      return `📈 *Pulse: whole bot*\n👥 Users: *${st.users}/${st.max}*\n🟢 Online now: *${us.filter((u) => u.online).length}*\n⚡ Active in 24h: *${day24}*\n🧮 Commands run (all users): *${cmds}*`;
    }
    return report(ctx.sock, ctx.prefix);
  }, { aliases: ['stats2', 'dashboard'] });
}

/* ---------------- web routes (called by server.js) ---------------- */
const J = (status, body) => ({ status, body });
async function route(req, p, readJson) {
  const m = p.match(/^\/(?:api\/)?pulse\/([\w-]{20,40})(?:\/(say|join|leave))?$/);
  if (!m) return null;
  if (!m[0].startsWith('/api/')) {
    if (req.method !== 'GET') return J(405, { error: 'Not allowed.' });
    if (!byToken.has(m[1])) return J(404, 'This dashboard link is not valid or the bot is offline. Send .pulse link to your bot for a new one.');
    return { status: 200, body: require('./pulsepage')(process.env.BOT_NAME || 'Hans-Mini'), type: 'text/html; charset=utf-8' };
  }
  const sock = byToken.get(m[1]);
  if (!sock) return J(404, { error: 'This dashboard link is not valid or the bot is offline.' });
  const number = hmOf(sock).owner;
  try {
    if (req.method === 'GET' && !m[2]) return J(200, data(sock));
    if (req.method !== 'POST') return J(405, { error: 'Not allowed.' });
    const body = await readJson();
    if (m[2] === 'say') { const r = community.post(number, body.text); count(sock, 'comm'); return J(200, { ok: true, sent: r.sent, nick: r.nick }); }
    if (m[2] === 'join') { community.join(number, body.nick); return J(200, { ok: true }); }
    if (m[2] === 'leave') { community.leave(number); return J(200, { ok: true }); }
  } catch (e) { return J(400, { error: e.message }); }
  return J(404, { error: 'Not found.' });
}

module.exports = { register, boot, passive, count, route, data, ensureToken };
