'use strict';
/**
 * Hans-Mini Community: users talk to each other (and the admin) through their own bots.
 * Opt-in, nickname only (phone numbers are never shown to other users, only to the admin).
 *
 * User commands:   .community [join <nick> | leave | nick <new> | rules | members | history]
 *                  .csay <message>        post to the community
 * Admin commands (admin bot only, hidden from other menus):
 *   .cmute <nick|number> [minutes]  .cunmute <nick|number>  .cban <nick|number>  .cunban <nick|number>
 *   .cpin <text>  .cannounce <text>  .cwho  .cclose  .copen
 * Everyone who links a number is added automatically (nickname "Member1234", changeable with .community nick).
 * Leaving with .community leave is remembered, so nobody is added back. COMMUNITY_AUTOJOIN=off switches the automatic join off.
 * Messages arrive in each member's own "Message yourself" chat. Data: DATA_DIR/community.json
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DIR, 'community.json');
const BOT_NAME = process.env.BOT_NAME || 'Hans-Mini';
const ADMIN_LABEL = process.env.OWNER_NAME || 'Admin';
const MAX_MEMBERS = Number(process.env.COMMUNITY_MAX) || 300;
const HISTORY = 60;

let db = { open: true, members: {}, history: [], pinned: '', rules: '' };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }

let timer;
function flush() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('[community] could not save:', e.message); }
}
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 400); };
process.on('beforeExit', flush);

const RULES = `📜 *Community rules*
1. Be respectful. No insults, hate or threats.
2. No links, no ads, no begging for money.
3. Never share your own or anyone's personal details.
4. Others only see your nickname, never your number.
5. Break the rules and the admin can mute or remove you.`;

const num = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINK_RE = /(?:https?:\/\/|www\.)\S+|(?:chat\.whatsapp\.com|wa\.me|t\.me|bit\.ly)\/\S+|\b[a-z0-9][a-z0-9-]{1,40}\.(?:com|net|org|io|co|me|xyz|info|link|gg|app|site|online|ly)\b/i;

/* ---------------- who is online (sockets of every linked user, in this process) ---------------- */
const socks = new Map(); // number -> sock
function boot(sock) {
  const n = sock.hm?.owner;
  if (!n) return;
  socks.set(n, sock);
  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'close' && socks.get(n) === sock) socks.delete(n);
    if (connection === 'open') setTimeout(() => { try { autoJoin(sock); } catch (e) { console.error('[community] auto join:', e.message); } }, 12000);
  });
}

/** every linked number is put in the community once (unless they left on purpose, are banned, or it is closed) */
function autoJoin(sock) {
  const n = sock.hm?.owner;
  if (!n || String(process.env.COMMUNITY_AUTOJOIN || '').toLowerCase() === 'off') return false;
  if (isAdmin(n)) return false;
  const m = db.members[n];
  if (!db.open || m?.joined || m?.banned || m?.optOut) return false;
  if (memberCount() >= MAX_MEMBERS) return false;
  let nick = '';
  for (let i = 0; i < 30 && !nick; i++) {
    const c = 'Member' + (1000 + Math.floor(Math.random() * 9000));
    if (!nickTaken(c, n)) nick = c;
  }
  if (!nick) return false;
  db.members[n] = { ...(m || {}), nick, joined: Date.now(), optOut: false, auto: true };
  save();
  deliver(`➕ *${nick}* joined the community.`, n);
  const p = (sock.hm?.db?.prefix) || process.env.PREFIX || '.';
  sock.sendMessage(n + '@s.whatsapp.net', { text:
    `🌍 *Welcome to the ${BOT_NAME} community!*\n` +
    `You were added as *${nick}*. Others only see this nickname, never your number.\n\n` +
    `Post: ${p}csay Hello everyone!\nChange nickname: ${p}community nick <new name>\nRules: ${p}community rules\nLeave any time: ${p}community leave` }).catch(() => {});
  return true;
}

function isAdmin(number) {
  try { return !!process.env.ADMIN_NUMBER && require('./manager').isAdmin(number); } catch { return false; }
}

/* ---------------- core ---------------- */
const nickKey = (s) => String(s).trim().toLowerCase();
const nickTaken = (nick, except) => Object.entries(db.members).some(([n, m]) => n !== except && nickKey(m.nick) === nickKey(nick));
const memberCount = () => Object.values(db.members).filter((m) => !m.banned && m.joined).length;

function cleanNick(s) {
  const nick = String(s || '').trim().replace(/\s+/g, ' ');
  if (nick.length < 3 || nick.length > 20) throw new Error('Your nickname must be 3 to 20 characters.');
  if (!/^[\p{L}\p{N}_ .\-✪]+$/u.test(nick)) throw new Error('Use letters, numbers, spaces, _ . - only.');
  if (/\d{6,}/.test(nick.replace(/\D/g, '')) || /(\+|233)\d{6,}/.test(nick)) throw new Error('A nickname cannot look like a phone number.');
  if (/admin|owner|moderator|hans-?mini/i.test(nick)) throw new Error('That nickname is reserved.');
  return nick;
}

function find(target) {
  const t = String(target || '').trim();
  if (!t) return null;
  const d = t.replace(/\D/g, '');
  if (d.length >= 7 && db.members[d]) return d;
  return Object.keys(db.members).find((n) => nickKey(db.members[n].nick) === nickKey(t)) || null;
}

/** send text to every joined member except one number; slow on purpose */
function deliver(text, except) {
  const targets = Object.entries(db.members).filter(([n, m]) => m.joined && !m.banned && n !== except && socks.has(n));
  (async () => {
    for (const [n] of targets) {
      try { await socks.get(n).sendMessage(n + '@s.whatsapp.net', { text }); } catch { /* member offline */ }
      await sleep(350);
    }
  })();
  return targets.length;
}

function info(number) {
  const m = db.members[number];
  const admin = isAdmin(number);
  return {
    open: db.open, member: !!(m && m.joined && !m.banned), nick: m?.nick || '', banned: !!m?.banned,
    muted: !!(m?.mutedUntil && m.mutedUntil > Date.now()), admin,
    members: memberCount(), pinned: db.pinned, rules: db.rules || RULES,
    feed: db.history.slice(-30).map((h) => ({ t: h.t, nick: h.nick, admin: !!h.admin, text: h.text, ann: !!h.ann })),
  };
}

function join(number, nickRaw) {
  if (!db.open) throw new Error('The community is closed right now.');
  const m = db.members[number];
  if (m?.banned) throw new Error('You cannot join the community.');
  if (m?.joined) throw new Error(`You are already in as *${m.nick}*.`);
  if (memberCount() >= MAX_MEMBERS) throw new Error('The community is full for now.');
  const nick = cleanNick(nickRaw);
  if (nickTaken(nick, number)) throw new Error('That nickname is taken. Pick another one.');
  db.members[number] = { ...(m || {}), nick, joined: Date.now(), optOut: false };
  save();
  deliver(`➕ *${nick}* joined the community.`, number);
  return nick;
}
function leave(number) {
  const m = db.members[number];
  if (!m?.joined) throw new Error('You are not in the community.');
  m.joined = 0; m.optOut = true; save();
}
function rename(number, nickRaw) {
  const m = db.members[number];
  if (!m?.joined) throw new Error('Join first with .community join <nickname>');
  const nick = cleanNick(nickRaw);
  if (nickTaken(nick, number)) throw new Error('That nickname is taken. Pick another one.');
  m.nick = nick; save();
  return nick;
}

const lastPost = new Map(); // number -> [timestamps]
function post(number, textRaw) {
  const admin = isAdmin(number);
  const m = db.members[number];
  if (!admin) {
    if (!db.open) throw new Error('The community is closed right now.');
    if (!m?.joined || m.banned) throw new Error('Join first: .community join <nickname>');
    if (m.mutedUntil && m.mutedUntil > Date.now()) throw new Error(`You are muted for ${Math.ceil((m.mutedUntil - Date.now()) / 60000)} more minute(s).`);
  }
  const text = String(textRaw || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Write a message.');
  if (text.length > 400) throw new Error('Keep it under 400 characters.');
  if (!admin && LINK_RE.test(text)) throw new Error('Links are not allowed in the community.');
  const now = Date.now();
  const arr = (lastPost.get(number) || []).filter((t) => now - t < 60000);
  if (arr.length && now - arr[arr.length - 1] < 3000) throw new Error('Slow down a little (one message every 3 seconds).');
  if (arr.length >= 15) throw new Error('Too many messages this minute. Wait a bit.');
  arr.push(now); lastPost.set(number, arr);
  const nick = admin ? ADMIN_LABEL : m.nick;
  db.history.push({ t: now, nick, admin, text });
  if (db.history.length > HISTORY) db.history.splice(0, db.history.length - HISTORY);
  save();
  const sent = deliver(admin ? `👑 *${nick}* (admin): ${text}` : `🌍 *${nick}*: ${text}`, number);
  return { nick, sent };
}

function announce(text) {
  const t = String(text).trim().slice(0, 500);
  db.history.push({ t: Date.now(), nick: ADMIN_LABEL, admin: true, text: t, ann: true });
  if (db.history.length > HISTORY) db.history.splice(0, db.history.length - HISTORY);
  save();
  return deliver(`📢 *${BOT_NAME} Community*\n\n${t}`);
}

const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const historyText = (n = 15) => {
  const h = db.history.slice(-n);
  return h.length ? '🕘 *Recent messages* (UTC)\n' + h.map((x) => `${hhmm(x.t)} ${x.admin ? '👑' : '•'} *${x.nick}*: ${x.text}`).join('\n') : 'No messages yet. Be the first with .csay Hello everyone!';
};

/* ---------------- commands ---------------- */
function register(add) {
  const me = (ctx) => {
    if (!ctx.isMainOwner) throw new Error('Only the owner of this bot can use the community.');
    const n = ctx.sock.hm?.owner;
    if (!n) throw new Error('Could not tell which number this bot belongs to.');
    return n;
  };
  const adminOnly = (ctx) => {
    const n = me(ctx);
    if (!isAdmin(n)) throw new Error('This command only works on the admin bot.');
    return n;
  };

  add('community', 'Community', 'join <nick> | leave | nick <new> | rules | members | history', `Chat with other ${BOT_NAME} users and the admin`, (ctx) => {
    const n = me(ctx), p = ctx.prefix;
    const sub = (ctx.args[0] || '').toLowerCase();
    const rest = ctx.args.slice(1).join(' ');
    if (sub === 'join') {
      const nick = join(n, rest);
      return `✅ You joined as *${nick}*.\nPost with ${p}csay Hello everyone!\nOthers see only your nickname, never your number.\n\n${db.pinned ? '📌 ' + db.pinned + '\n\n' : ''}${historyText(8)}`;
    }
    if (sub === 'leave') { leave(n); return '👋 You left the community. Join again any time.'; }
    if (sub === 'nick') return `✅ Your nickname is now *${rename(n, rest)}*.`;
    if (sub === 'rules') return db.rules || RULES;
    if (sub === 'history') return historyText(15);
    if (sub === 'members') {
      const names = Object.values(db.members).filter((m) => m.joined && !m.banned).map((m) => m.nick);
      return `👥 *${names.length} member(s)*\n` + (names.length ? names.slice(0, 60).join(', ') : 'Nobody yet.');
    }
    const i = info(n);
    return `🌍 *${BOT_NAME} Community*  (${i.members} member${i.members === 1 ? '' : 's'}${i.open ? '' : ', closed'})\n` +
      (i.member ? `You are in as *${i.nick}*.\nPost: ${p}csay <message>\nHistory: ${p}community history\nLeave: ${p}community leave\n` : `Join: ${p}community join <nickname>\n`) +
      (db.pinned ? `\n📌 ${db.pinned}\n` : '') + `\nRules: ${p}community rules\nMembers: ${p}community members`;
  }, { aliases: ['comm', 'hub'] });

  add('csay', 'Community', '<message>', 'Post a message to the community', (ctx) => {
    const n = me(ctx);
    const text = ctx.text.trim();
    if (!text) throw new Error(`Write a message.\nExample: ${ctx.prefix}csay Hello everyone!`);
    const r = post(n, text);
    try { require('./pulse').count(ctx.sock, 'comm'); } catch { /* optional */ }
    return `✅ Sent to ${r.sent} member${r.sent === 1 ? '' : 's'}.`;
  }, { aliases: ['hubsay'] });

  /* ----- admin ----- */
  const target = (ctx, name) => {
    const n = find(ctx.args[0]);
    if (!n) throw new Error(`Give a nickname or number of a member.\nExample: ${ctx.prefix}${name} Kojo`);
    return n;
  };
  add('cmute', 'Admin', '<nick|number> [minutes]', 'Mute a community member (default 60 minutes)', (ctx) => {
    adminOnly(ctx); const n = target(ctx, 'cmute');
    const mins = Math.min(Math.max(parseInt(ctx.args[1], 10) || 60, 1), 10080);
    db.members[n].mutedUntil = Date.now() + mins * 60000; save();
    return `🔇 *${db.members[n].nick}* muted for ${mins} minute(s).`;
  }, { owner: true });
  add('cunmute', 'Admin', '<nick|number>', 'Unmute a community member', (ctx) => {
    adminOnly(ctx); const n = target(ctx, 'cunmute');
    db.members[n].mutedUntil = 0; save();
    return `🔊 *${db.members[n].nick}* unmuted.`;
  }, { owner: true });
  add('cban', 'Admin', '<nick|number>', 'Remove a member from the community for good', (ctx) => {
    adminOnly(ctx); const n = target(ctx, 'cban');
    db.members[n].banned = true; db.members[n].joined = 0; save();
    return `🚫 *${db.members[n].nick}* banned from the community.`;
  }, { owner: true });
  add('cunban', 'Admin', '<nick|number>', 'Let a banned member join again', (ctx) => {
    adminOnly(ctx); const n = target(ctx, 'cunban');
    db.members[n].banned = false; save();
    return `✅ *${db.members[n].nick}* can join again.`;
  }, { owner: true });
  add('cpin', 'Admin', '<text> | off', 'Pin a short notice shown to everyone who joins', (ctx) => {
    adminOnly(ctx);
    const t = ctx.text.trim();
    if (!t) throw new Error(`Usage: ${ctx.prefix}cpin <text>  (or ${ctx.prefix}cpin off)`);
    db.pinned = /^(off|clear)$/i.test(t) ? '' : t.slice(0, 300); save();
    return db.pinned ? '📌 Pinned.' : '📌 Pin removed.';
  }, { owner: true });
  add('cannounce', 'Admin', '<text>', 'Send an announcement to every community member', (ctx) => {
    adminOnly(ctx);
    const t = ctx.text.trim();
    if (!t) throw new Error(`Usage: ${ctx.prefix}cannounce <text>`);
    return `📢 Sending to ${announce(t)} member(s).`;
  }, { owner: true });
  add('cwho', 'Admin', '', 'List community members with their numbers', (ctx) => {
    adminOnly(ctx);
    const rows = Object.entries(db.members).map(([n, m]) => `${m.banned ? '🚫' : m.joined ? (m.mutedUntil > Date.now() ? '🔇' : '🟢') : '⚪'} *${m.nick}*  +${n}`);
    return rows.length ? `👥 *Community* (${memberCount()} active)\n` + rows.join('\n') : 'Nobody has joined yet.';
  }, { owner: true });
  add('cclose', 'Admin', '', 'Close the community (nobody can join or post)', (ctx) => { adminOnly(ctx); db.open = false; save(); return '🔒 Community closed.'; }, { owner: true });
  add('copen', 'Admin', '', 'Open the community again', (ctx) => { adminOnly(ctx); db.open = true; save(); return '🔓 Community open.'; }, { owner: true });
}

module.exports = { autoJoin, register, boot, info, join, leave, rename, post, isAdmin, flush };
