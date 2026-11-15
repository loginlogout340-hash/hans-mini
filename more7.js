'use strict';
/**
 * Hans-Mini v2.2 extra commands:  emojimix, meme, updates, textall
 *
 *   bot.js    calls late(registry, commands) once at start: it adds the new commands by itself (no edit of more.js needed)
 *   bot.js    calls boot(sock) and passive(sock, msg)   (builds the contact book that .textall uses)
 *   more.js   may still call register(add) (optional; it does the same job and late() then skips what is already there)
 *
 * The contact book is saved in the user's own extra.json (sock.hm.db.contacts), so nothing is shared between users.
 * emojimix needs the npm package "emoji-mixer" (add it to package.json).
 */
const fs = require('fs');
const path = require('path');
const UPDATES = require('./updates');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const norm = (j) => String(j || '').replace(/:\d+@/, '@');

/* =============================== emojimix =============================== */
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

let mixerFn; // undefined = not tried yet, null = not installed
function mixer() {
  if (mixerFn === undefined) {
    try {
      const m = require('emoji-mixer');
      const f = typeof m === 'function' ? m : (m.default || m.getEmojiMixUrl);
      mixerFn = typeof f === 'function' ? f : null;
    } catch { mixerFn = null; }
  }
  return mixerFn;
}

async function emojimix(ctx) {
  const found = (ctx.text || ctx.quoted?.text || '').match(EMOJI_RE) || [];
  if (found.length < 2) throw new Error(`Send two emojis.\nExample: ${ctx.prefix}emojimix 😀😍`);
  const getUrl = mixer();
  if (!getUrl) throw new Error('Emoji mixing is not installed on this server yet. The owner must add "emoji-mixer" to package.json and redeploy.');
  let url = null;
  try { url = getUrl(found[0], found[1]); } catch { /* unsupported emoji */ }
  if (!url) throw new Error('Those two emojis cannot be mixed. Try other ones, for example 😀😍 or 🔥😃.');
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('Could not get that mix right now. Try again.');
  const png = Buffer.from(await r.arrayBuffer());
  let webp;
  try {
    const sharp = require('sharp'); // already in package.json
    webp = await sharp(png).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 90 }).toBuffer();
  } catch {
    return void (await ctx.send({ image: png, caption: `${found[0]} + ${found[1]}` })); // no sticker tool: send it as a picture
  }
  await ctx.send({ sticker: webp });
}

/* ================================= meme ================================= */
async function meme(ctx) {
  const sub = (ctx.args[0] || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30);
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch('https://meme-api.com/gimme' + (sub ? '/' + sub : ''), { signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.url) {
        if (sub && r.status >= 400 && r.status < 500) throw new Error(`I could not find memes in r/${sub}. Try ${ctx.prefix}meme without a name.`);
        continue;
      }
      if (j.nsfw || j.spoiler || !/\.(png|jpe?g|webp)(\?|$)/i.test(j.url)) continue; // clean pictures only
      await ctx.send({ image: { url: j.url }, caption: `😂 *${String(j.title || 'Meme').slice(0, 200)}*\n_r/${j.subreddit || 'memes'}_` });
      return;
    } catch (e) {
      if (/I could not find memes/.test(e.message)) throw e;
    }
  }
  throw new Error('Could not get a meme right now. Try again.');
}

/* ============================ contact book ============================== */
const MAX_CONTACTS = 5000; // how many contacts are remembered
const isPerson = (j) => typeof j === 'string' && /@(s\.whatsapp\.net|lid)$/.test(j);
const bookOf = (sock) => (sock.hm.db.contacts ||= {});

/** remembers one person; returns true when something changed */
function addContact(sock, jid, name) {
  if (!sock.hm || !isPerson(jid)) return false;
  jid = norm(jid);
  const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(digits);
  if (me.includes(digits(jid))) return false; // never yourself
  const book = bookOf(sock);
  const nm = String(name || '').trim().slice(0, 60);
  if (jid in book) {
    if (nm && book[jid] !== nm) { book[jid] = nm; return true; }
    return false;
  }
  if (Object.keys(book).length >= MAX_CONTACTS) return false;
  book[jid] = nm;
  return true;
}

function feedContacts(sock, list) {
  let changed = false;
  for (const c of list || []) {
    if (!c) continue;
    const jid = [c.phoneNumber, c.id].find(isPerson); // a phone number is preferred over a LID
    if (jid && addContact(sock, jid, c.name || c.notify || c.verifiedName)) changed = true;
  }
  if (changed) sock.hm.save();
}

let mediaInstalled = false;
/** every contact and chat that WhatsApp syncs is added (called once per connection from bot.js) */
function boot(sock) {
  // the video and picture downloaders (.video .yt .tiktok .ig .fb .twitter2 .threads .pinterest) get keyless sources, once
  if (!mediaInstalled) {
    mediaInstalled = true;
    try { require('./getmedia').install(require('./commands').commands); } catch (e) { console.error('[more7] getmedia:', e.message); }
  }
  try {
    sock.ev.on('contacts.upsert', (list) => feedContacts(sock, list));
    sock.ev.on('contacts.update', (list) => feedContacts(sock, list));
    sock.ev.on('chats.upsert', (list) => feedContacts(sock, (list || []).map((c) => ({ id: c.id, name: c.name }))));
    sock.ev.on('messaging-history.set', ({ contacts, chats }) => {
      feedContacts(sock, contacts);
      feedContacts(sock, (chats || []).map((c) => ({ id: c.id, name: c.name })));
    });
  } catch (e) { console.error('[more7] boot:', e.message); }
}

/** every private chat message adds that person (called from bot.js for every message) */
function passive(sock, m) {
  try {
    const jid = m?.key?.remoteJid;
    if (!jid || !sock.hm) return;
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
    const pn = [m.key.remoteJidAlt, jid].find((j) => j && j.endsWith('@s.whatsapp.net')) || jid;
    if (addContact(sock, pn, m.key.fromMe ? '' : m.pushName)) sock.hm.save();
  } catch { /* never stops a message */ }
}

/* ================================ textall =============================== */
const MAX_PER_RUN = 300; // most people one run can reach
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // wait this long before the next run
const CONFIRM_MS = 2 * 60 * 1000; // how long "confirm" stays valid
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

async function blast(sock, st, ownerJid, text, list) {
  st.running = true;
  st.stop = false;
  st.done = 0;
  st.total = list.length;
  let ok = 0, bad = 0, inARow = 0, reason = '';
  try {
    for (let i = 0; i < list.length; i++) {
      if (st.stop) { reason = 'You stopped it.'; break; }
      const [jid, name] = list[i];
      try {
        await sock.sendMessage(jid, { text: text.replace(/\{name\}/gi, firstName(name)) });
        ok++; inARow = 0;
      } catch { bad++; inARow++; }
      st.done = i + 1;
      if (inARow >= 8) { reason = 'Stopped: 8 messages failed in a row (connection problem).'; break; }
      // a pause between people keeps WhatsApp from blocking your number; a longer rest after every 25
      if (i < list.length - 1) await sleep(rand(4000, 9000) + ((i + 1) % 25 === 0 ? 45000 : 0));
    }
  } finally { st.running = false; }
  await sock.sendMessage(ownerJid, { text: `📣 *Text all finished*\n✅ Sent: ${ok}\n❌ Failed: ${bad}${reason ? '\nℹ️ ' + reason : ''}` }).catch(() => {});
}

async function textall(ctx) {
  if (!ctx.isMainOwner) throw new Error('Only the real owner of this bot can use this command.');
  const p = ctx.prefix;
  const hm = ctx.sock.hm;
  const st = (hm.textall ||= { pending: null, running: false, stop: false, done: 0, total: 0 });
  const word = (ctx.args[0] || '').toLowerCase();
  const total = Object.keys(bookOf(ctx.sock)).length;

  if (word === 'stop') {
    if (!st.running) return 'ℹ️ Nothing is being sent right now.';
    st.stop = true;
    return '🛑 Stopping after the message that is being sent now.';
  }
  if (word === 'cancel') { st.pending = null; return '❎ Cancelled.'; }
  if (word === 'status') return st.running ? `📣 Sending: ${st.done}/${st.total} done.` : 'ℹ️ Nothing is being sent right now.';

  if (word === 'confirm' || word === 'yes') {
    if (st.running) throw new Error(`A message is already being sent (${st.done}/${st.total}). Use ${p}textall stop to stop it.`);
    if (!st.pending || Date.now() - st.pending.at > CONFIRM_MS) throw new Error(`Nothing is waiting for confirmation. Start with ${p}textall <message>`);
    const wait = (hm.db.textallLast || 0) + COOLDOWN_MS - Date.now();
    if (wait > 0) throw new Error(`Please wait ${Math.ceil(wait / 60000)} more minutes before the next round. Sending too much too often gets numbers blocked.`);
    const { text } = st.pending;
    st.pending = null;
    const list = Object.entries(bookOf(ctx.sock)).slice(0, MAX_PER_RUN);
    if (!list.length) throw new Error('I have no contacts to send to yet.');
    hm.db.textallLast = Date.now();
    hm.save();
    blast(ctx.sock, st, ctx.ownerJid, text, list).catch((e) => console.error('[textall]', e.message));
    return `🚀 Sending to ${list.length} contact(s). I will tell you when it is finished.\n${p}textall status  ·  ${p}textall stop`;
  }

  if (!ctx.text) {
    return `📣 *Text all contacts*\nSends one message to your contacts, one by one.\n\n${p}textall <message>\nTip: write {name} to put each person's name, for example:\n${p}textall Hello {name}, new update is out!\n\nContacts I know: *${total}*\nOther commands: ${p}textall status · stop · cancel`;
  }
  if (!total) throw new Error('I do not know any contacts yet. They are added as WhatsApp syncs them and when people chat with you. Try again later.');
  const count = Math.min(total, MAX_PER_RUN);
  st.pending = { text: ctx.text.slice(0, 1000), at: Date.now() };
  const mins = Math.ceil((count * 7) / 60);
  return `📣 *Ready to send*\n\n"${st.pending.text}"\n\n👥 To: ${count} contact(s)${total > MAX_PER_RUN ? ` (the first ${MAX_PER_RUN} of ${total})` : ''}\n⏱ About ${mins} minute(s)\n\n⚠️ WhatsApp can block numbers that message many people. Only text people who know you.\n\nSend *${p}textall confirm* within 2 minutes to start, or ${p}textall cancel.`;
}

/* ============================= fixviewonce ============================= */
// WhatsApp does not send view-once pictures to a normally linked bot. Linking again as "android" (see bot.js) fixes that.
// The old settings are kept in <DATA_DIR>/relink/<number> and put back when the person links again.
const dataDir = () => process.env.DATA_DIR || process.env.SESSION_DIR || './data';
const relinkDir = (n) => path.join(dataDir(), 'relink', String(n));
const RELINK_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // a saved copy is used for 7 days

function saveForRelink(number, userDir) {
  try {
    const to = relinkDir(number);
    fs.mkdirSync(to, { recursive: true });
    for (const f of ['settings.json', 'extra.json']) {
      const from = path.join(userDir, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(to, f));
    }
    fs.writeFileSync(path.join(to, 'saved-at'), String(Date.now()));
  } catch (e) { console.error('[more7] could not keep the settings for relinking:', e.message); }
}
/** called by bot.js when a bot is created: puts the saved settings back for a person who is linking again */
function restoreRelink(number, userDir) {
  try {
    const from = relinkDir(number);
    if (!fs.existsSync(from)) return;
    const at = Number(fs.readFileSync(path.join(from, 'saved-at'), 'utf8')) || 0;
    if (Date.now() - at > RELINK_KEEP_MS) return void fs.rmSync(from, { recursive: true, force: true });
    if (fs.existsSync(path.join(userDir, 'settings.json'))) return;
    fs.mkdirSync(userDir, { recursive: true });
    const sf = path.join(from, 'settings.json');
    if (fs.existsSync(sf)) {
      const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
      delete st.identity; // so the new link picks the android way
      fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify(st));
    }
    const ef = path.join(from, 'extra.json');
    if (fs.existsSync(ef)) fs.copyFileSync(ef, path.join(userDir, 'extra.json'));
  } catch (e) { console.error('[more7] could not restore the settings after relinking:', e.message); }
}
/** called by bot.js when the new link is complete */
function clearRelink(number) { try { fs.rmSync(relinkDir(number), { recursive: true, force: true }); } catch { /* ignore */ } }

function siteUrl() {
  const u = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
  return String(u || '').replace(/\/+$/, '');
}

// after the person is unlinked: make a new pairing code and send it to them from the admin's bot
async function relinkWithCode(number) {
  const manager = require('./manager'); // loaded now (not at the top) to avoid a loop between the files
  const where = siteUrl() || 'the Hans-Mini website';
  try {
    for (let i = 0; i < 40 && manager.status(number) !== 'none'; i++) await sleep(1000); // wait until the old bot is removed
    await sleep(2500);
    const code = await manager.pair(number);
    const shown = String(code).length === 8 ? String(code).slice(0, 4) + '-' + String(code).slice(4) : code;
    const text = `🔗 *Hans-Mini: your new pairing code*\n\n*${shown}*\n\n1. Open WhatsApp > Settings > Linked devices\n2. Tap *Link a device*, then *Link with phone number instead*\n3. Enter the code above\n\nThe code works for about 4 minutes. After that, open ${where} to get a new one.`;
    if (!(await manager.sendFromAdmin(number, text))) console.log(`[${number}] could not send the pairing code (the admin bot is offline)`);
  } catch (e) {
    console.error(`[${number}] relink failed:`, e.message);
    try { await manager.sendFromAdmin(number, `⚠️ I could not make a pairing code: ${e.message}\nOpen ${where} to link again.`); } catch { /* ignore */ }
  }
}

async function fixviewonce(ctx) {
  if (!ctx.isMainOwner) throw new Error('Only the owner of this bot can use this command.');
  const p = ctx.prefix;
  if (ctx.config.identity === 'android') {
    return '✅ Your bot is already linked the new way, so view-once messages can be saved. If one still fails, the bot was probably offline when it was sent.';
  }
  const manager = require('./manager');
  const number = ctx.config.owners[0];
  // the new pairing code can be sent by the admin's bot when it is online (not for the admin's own number)
  const auto = !!process.env.ADMIN_NUMBER && !manager.isAdmin(number) && manager.users().some((u) => manager.isAdmin(u.number) && u.online);
  const where = siteUrl() || 'the Hans-Mini website';
  if ((ctx.args[0] || '').toLowerCase() !== 'confirm') {
    const steps = auto
      ? `1. The bot unlinks your number.\n2. About 30 seconds later you get a message with a new pairing code.\n3. In WhatsApp open Linked devices > Link a device > Link with phone number instead, and enter the code.`
      : `1. The bot unlinks your number.\n2. You open ${where} and link again with a new pairing code (about 1 minute).`;
    return `👁️ *View-once fix*\n\nWhatsApp does not send view-once pictures to the way your bot is linked now. Linking again fixes it.\n\nWhen you confirm:\n${steps}\n\nYour settings are kept.\n\nReady? Send *${p}fixviewonce confirm*`;
  }
  // keep the settings, then unlink
  try { ctx.config.save(); ctx.sock.hm?.save?.(); } catch { /* ignore */ }
  await sleep(1000); // the settings files are written a moment later
  saveForRelink(number, path.dirname(ctx.config.sessionDir));
  await ctx.reply(auto
    ? '🔓 Unlinking now. In about 30 seconds a message with your new pairing code will arrive from the admin number.'
    : `🔓 Unlinking now. Open ${where} and link your number again.`);
  await sleep(2000);
  await ctx.sock.logout(); // the bot then removes the old data by itself (manager.js)
  if (auto) relinkWithCode(number).catch((e) => console.error('[more7] relink:', e.message));
}

/* ============================ view-once vault ============================ */
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago'; };
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((n || 0) / 1024)) + ' KB');
const ICON = { image: '🖼️', video: '🎬', audio: '🎤' };

function vvlist(ctx) {
  if (!ctx.isMainOwner) throw new Error('Only the owner of this bot can use this command.');
  const p = ctx.prefix;
  const all = (ctx.args[0] || '').toLowerCase() === 'all';
  const items = ctx.vv.list(all).slice(0, 15);
  if (!items.length) return `👁️ The vault is empty${all ? '' : ' for this chat'}.\nView-once messages are saved when they arrive and kept for 6 hours.${all ? '' : `\nSee every chat: ${p}vvlist all`}`;
  const lines = items.map((m, i) => `${i + 1}. ${ICON[m.kind] || '📎'} ${m.name || '+' + m.from} · ${kb(m.size)} · ${ago(m.t)}${m.caption ? '\n    ' + m.caption.slice(0, 40) : ''}`);
  return `👁️ *View-once vault* (${all ? 'all chats' : 'this chat'})\n\n${lines.join('\n')}\n\nGet one: ${p}vvget 1${all ? ' all' : `\nOther chats: ${p}vvlist all`}`;
}
async function vvget(ctx) {
  if (!ctx.isMainOwner) throw new Error('Only the owner of this bot can use this command.');
  const n = parseInt(ctx.args[0], 10);
  const all = ctx.args.some((a) => /^all$/i.test(a));
  const items = ctx.vv.list(all).slice(0, 15);
  if (!n || n < 1 || n > items.length) throw new Error(`Pick a number from the list.\nExample: ${ctx.prefix}vvget 1   (see ${ctx.prefix}vvlist${all ? ' all' : ''})`);
  const m = items[n - 1];
  await ctx.vv.send(m.id, ctx.ownerJid, `👁️ View-once from ${m.name || '+' + m.from}`); // always to your own chat, never back to the sender
  if (ctx.jid !== ctx.ownerJid) return '✅ Sent to your own chat.';
}

/* ============================== command stats ============================== */
function cmdstats(ctx) {
  const rows = Object.entries(ctx.stats.byCmd || {}).sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  if (!rows.length) return 'No commands have been used yet since the bot started.';
  const lines = rows.map(([name, e]) => {
    const ok = Math.max(1, e.n - e.err);
    return `${ctx.prefix}${name} · ${e.n} used · ${e.err} failed · ${(Math.round((e.ms / ok) / 100) / 10)}s average`;
  });
  return `📊 *Most used commands* (since the bot started)\n\n${lines.join('\n')}`;
}

/* =============================== register =============================== */
function register(add) {
  // .play / .song that work without any variable (registered first, so they replace the old ones)
  try { require('./music').register(add); } catch (e) { console.error('[more7] music.js is missing or broken:', e.message); }
  add('emojimix', 'Fun', '<emoji> <emoji>', 'Mix two emojis into one sticker, e.g. emojimix 😀😍', emojimix, { aliases: ['emix', 'mixemoji'] });
  add('meme', 'Fun', '[subreddit]', 'Get a random meme, e.g. meme or meme dankmemes', meme, { aliases: ['memes'] });
  add('updates', 'Info', '', "See what's new in the bot", (ctx) => UPDATES.text(ctx.prefix), { aliases: ['whatsnew', 'news', 'changelog'] });
  add('vvlist', 'Owner', '[all]', 'List the view-once messages saved in the vault', vvlist, { owner: true, aliases: ['vault'] });
  add('vvget', 'Owner', '<number>', 'Get a saved view-once message from the vault (sent to your own chat)', vvget, { owner: true });
  add('cmdstats', 'Owner', '', 'Which commands are used most, and which fail', cmdstats, { owner: true, aliases: ['topcmds'] });
  add('fixviewonce', 'Owner', '[confirm]', 'Fix view-once retrieve: unlink and link your number again once', fixviewonce, { owner: true, aliases: ['fixvv'] });
  add('textall', 'Owner', '<message>', 'Send one message to all your contacts, one by one (safety delay, asks to confirm)', textall, { owner: true, aliases: ['sendall'] });
}

/**
 * Called once by bot.js after the command list is built. It adds the commands above WITHOUT touching more.js.
 * Commands that are already registered (for example through more.js) are left alone.
 * play and song replace the old ones (the old ones still run as a backup step, see music.js).
 */
function late(registry, commands) {
  const OVERRIDE = new Set(['play', 'song']);
  const add = (name, category, usage, desc, run, opts = {}) => {
    const cur = registry.get(name);
    if (cur && !(OVERRIDE.has(name) && !(cur.run && cur.run.isNew))) return; // already there
    const cmd = { name, category, usage, desc, run, aliases: opts.aliases || [], group: !!opts.group, admin: !!opts.admin, botAdmin: !!opts.botAdmin, owner: !!opts.owner };
    commands.push(cmd);
    for (const n of [name, ...cmd.aliases]) if (OVERRIDE.has(name) || !registry.has(n)) registry.set(n, cmd);
  };
  try { register(add); } catch (e) { console.error('[more7] could not add the new commands:', e.message); }
}

module.exports = { register, late, boot, passive, restoreRelink, clearRelink };
