'use strict';
/**
 * One WhatsApp bot per connected user.
 * createBot({ number, dir, onLoggedOut, onEvent }) gives a bot with its own settings, session folder,
 * message store and WhatsApp connection. The user's own number is the owner of their bot.
 *
 *   dir/session/    WhatsApp login (Baileys)
 *   dir/settings.json, dir/extra.json    that user's settings
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { commands } = require('./commands');
const extra = require('./extra');
const { unwrap, getText, isViewOnce, makeForwarder } = require('./media');
const ui = require('./ui');
const statusMod = require('./status'); // NEW: auto view / auto like status logic
const moreFive = require('./more5');
const hanson = require('./hanson'); // Hanson, the built-in AI assistant (turned on with .hanson on)
const more7 = require('./more7'); // NEW: emojimix, meme, textall (contact book), updates
const UPDATES = require('./updates'); // NEW: the "what's new" notes shown to users
const heal = (() => { try { return require('./selfheal'); } catch { return { noteEvent() {}, noteError() {} }; } })(); // NEW: the bot repairs itself (optional file)

// name/alias -> command (shared by every user, built once)
const registry = new Map();
for (const c of commands) {
  for (const n of [c.name, ...c.aliases]) {
    if (registry.has(n)) { console.warn('Duplicate command name ignored: ' + n + ' (the first one is kept)'); continue; }
    registry.set(n, c);
  }
}
ui.install(registry, commands); // styled menu with the default picture
more7.late(registry, commands); // NEW: adds .emojimix .meme .textall .updates and the keyless .play/.song by itself

// .autolikestatus emoji random  ->  a different emoji from this list for every status
const STATUS_EMOJIS = ['❤️', '🔥', '😂', '😍', '👏', '🥰', '💯', '😭', '🤣', '🙏', '👌', '💪', '🤩', '😎', '🥳', '✨', '💀', '🤯', '😤', '💅', '👀', '🎉', '😈', '🤫', '🫶'];
const SAVED_KEYS = ['autoStatus', 'autoLikeStatus', 'likeEmoji', 'mode', 'antiViewOnce', 'antiDelete', 'welcomed', 'prefix', 'multiPrefix', 'defaultsApplied', 'seenUpdate', 'identity'];
// NEW: switched on automatically the first time a NEW person links their number
// (people who were already linked before this update keep their own settings).
// Always online is switched on too (see connect()).
const NEW_USER_DEFAULTS = { autoStatus: true, autoLikeStatus: true, likeEmoji: 'random', antiDelete: true, mode: 'private' };
const MULTI_PREFIXES = ['.', '!', '#', '/', '$', '~', ','];
const STORE_MAX = 600; // recent messages kept per user (for antidelete)
const GROUP_CACHE_MAX = 60; // groups remembered per user
const MAX_RUNNING = 8; // commands one user's bot runs at the same time; a flood beyond this is dropped

// NEW: how a number is linked to WhatsApp (its "identity"). WhatsApp does NOT send view-once pictures to a normal
// "web" linked device, but it does to an "android" one. So new users are linked as android (when this Baileys has it).
// If the android way fails, the bot falls back to the normal way by itself. People who were already linked keep the
// normal way until they send .fixviewonce (it unlinks them once, they link again, and view-once works).
const ANDROID_RETRY_MS = 30 * 60 * 1000; // after an android attempt that did not finish, the next try on that number uses the normal way
const androidTried = new Map(); // number -> when an android pairing code was last given
const webOnly = new Set(); // numbers where the android way failed

// NEW: view-once pictures, videos and voice notes are saved the moment they arrive, because WhatsApp
// removes them from its servers once they are opened (a later download fails with "No valid media URL").
const VV_MAX = 20; // view-once items kept per user in the vault (the oldest is dropped first)
const VV_MAX_BYTES = 25 * 1024 * 1024; // anything bigger than 25 MB is not kept
const VV_MAX_AGE = 6 * 60 * 60 * 1000; // kept for 6 hours

// NEW: smarter command handling for every command
const CMD_TIMEOUT_MS = Number(process.env.CMD_TIMEOUT_MS) || 330000; // a command that hangs is stopped after about 5 minutes and frees its slot
const RATE_MAX = 8; // a normal user can run this many commands ...
const RATE_WINDOW = 10000; // ... in this many milliseconds (the owner has no limit)

// turns a technical error into something a normal person understands
function friendlyError(err) {
  const msg = String(err?.message || '');
  // a message the bot wrote itself (several lines, or a long explanation) is shown exactly as it is
  if (msg.includes('\n') || msg.length > 140) return msg;
  const tech = msg + ' ' + (err?.cause?.code || err?.code || '') + ' ' + (err?.name || '');
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network/i.test(tech)) return 'A network problem happened. Please try again in a moment.';
  if (/TimeoutError|aborted due to timeout|ETIMEDOUT|timed out/i.test(tech)) return 'The service took too long to answer. Please try again.';
  if (/rate-overlimit|too many requests|HTTP 429/i.test(tech)) return 'The service is busy right now. Please try again in a minute.';
  return msg || 'Something went wrong.';
}
// how many edits turn one word into another (a swapped pair like "plya" -> "play" counts as one)
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const norm = (j) => String(j || '').replace(/:\d+@/, '@');
const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const idsOf = (p) => [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean).map(norm);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envOn = (n) => /^(on|true|1)$/i.test(process.env[n] || '');

// Baileys is loaded once and shared by every user
let baileysP;
function loadBaileys() {
  return (baileysP ||= (async () => {
    const baileys = await import('@whiskeysockets/baileys');
    // Works whether the installed Baileys is CommonJS (v6) or ESM (v7)
    const B = baileys.default && (baileys.default.useMultiFileAuthState || baileys.default.default) ? baileys.default : baileys;
    const makeWASocket = typeof B.default === 'function' ? B.default : B.makeWASocket;
    ui.init({ generateWAMessageFromContent: B.generateWAMessageFromContent, proto: B.proto });
    let version;
    try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* use Baileys default */ }
    return { B, makeWASocket, version };
  })());
}

function createBot({ number, dir, onLoggedOut, onEvent }) {
  const stats = { since: Date.now(), commands: 0, lastActive: 0, byCmd: {} }; // for the admin (.users) and .cmdstats
  const emit = (type, data) => { try { if (onEvent) onEvent(type, data || {}); } catch (e) { console.error(`[${number}] event error:`, e.message); } };
  const config = {
    botName: process.env.BOT_NAME || 'Hans-Mini',
    prefix: process.env.PREFIX || '.',
    multiPrefix: false,
    mode: (process.env.MODE || 'public').toLowerCase(), // public | private
    owners: [number],
    sessionDir: path.join(dir, 'session'),
    timezone: process.env.TIMEZONE || 'Africa/Accra',
    startedAt: Date.now(),
    autoStatus: envOn('AUTO_STATUS'),
    autoLikeStatus: envOn('AUTO_LIKE_STATUS'),
    likeEmoji: process.env.LIKE_EMOJI || '💚',
    antiViewOnce: envOn('ANTI_VIEWONCE'),
    antiDelete: envOn('ANTI_DELETE'),
    welcomed: false,
  };
  const settingsFile = path.join(dir, 'settings.json');
  more7.restoreRelink(number, dir); // NEW: someone who unlinked with .fixviewonce gets their settings back
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    for (const k of SAVED_KEYS) if (saved[k] !== undefined) config[k] = saved[k];
  } catch { /* no saved settings yet */ }
  config.save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // written to a temporary file first, so a crash in the middle never leaves a broken settings file
      fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(Object.fromEntries(SAVED_KEYS.map((k) => [k, config[k]]))));
      fs.renameSync(settingsFile + '.tmp', settingsFile);
    } catch (e) { console.error(`[${number}] could not save settings:`, e.message); }
  };
  const likeEmojiNow = () => (!config.likeEmoji || String(config.likeEmoji).toLowerCase() === 'random'
    ? STATUS_EMOJIS[Math.floor(Math.random() * STATUS_EMOJIS.length)]
    : config.likeEmoji);

  const log = (...a) => console.log(`[${number}]`, ...a);
  const ownerJid = () => number + '@s.whatsapp.net';

  let current = null; // the live socket
  let stopped = false;
  let open = false;
  let everOpen = false;
  let retry = 0;
  let forward = null;
  let download = null;
  const store = new Map();
  const groupCache = new Map();
  const rate = new Map(); // NEW: sender -> times of their recent commands
  const notes = new Map(); // NEW: chat -> when the last hint ("did you mean", "slow down") was sent
  let running = 0; // commands running right now
  let starterNote = false; // NEW: a new user still has to be told which settings were switched on
  let onlineByDefault = false; // NEW: switch "always online" on for a new user
  let announcing = false;
  let identity = 'web'; // NEW: 'android' or 'web' (see the notes at the top of this file)
  let lastVvNudge = 0; // NEW: when the owner was last told about .fixviewonce

  // NEW: which identity this number connects with
  function pickIdentity(B) {
    const canAndroid = typeof B.Browsers?.android === 'function';
    if (config.identity === 'android') return canAndroid ? 'android' : 'web';
    if (config.identity === 'web') return 'web';
    // never decided before: someone who is already linked keeps the normal way (they must link again to change it)
    if (fs.existsSync(path.join(config.sessionDir, 'creds.json'))) return 'web';
    if (!canAndroid || webOnly.has(number)) return 'web';
    const t = androidTried.get(number);
    if (t && Date.now() - t < ANDROID_RETRY_MS) return 'web'; // the last android try did not finish
    return 'android';
  }

  // NEW: throws the current connection away and connects again with another identity (only used before linking)
  async function switchIdentity(to) {
    const old = current;
    current = null;
    open = false;
    if (old) {
      try { for (const [k, v] of Object.entries(old.hm || {})) if (/timer$/i.test(k)) clearInterval(v); } catch { /* ignore */ }
      try { old.ev.removeAllListeners('connection.update'); old.ev.removeAllListeners('messages.upsert'); } catch { /* ignore */ }
      try { old.end(undefined); } catch { /* ignore */ }
    }
    try { fs.rmSync(config.sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
    config.identity = to;
    config.save();
    await connect();
  }

  // ---------------- NEW: the watchdog (a stuck or offline bot reconnects by itself) ----------------
  let lastDownAt = 0; // when the connection last closed
  let lastRestartAt = 0; // when the watchdog last restarted it
  let badSocketChecks = 0;
  const wsAlive = (s) => { // does the socket still have a working web connection?
    const w = s && s.ws;
    if (!w) return true; // cannot tell: assume yes
    if (typeof w.isOpen === 'boolean') return w.isOpen;
    if (typeof w.readyState === 'number') return w.readyState === 1;
    return true;
  };
  // throw the old connection away and connect again (the same thing the normal reconnect does, but it cannot get stuck)
  async function restartSocket(reason) {
    if (stopped) return;
    lastRestartAt = Date.now();
    heal.noteEvent('watchdog', `bot ...${String(number).slice(-4)} reconnected by itself: ${reason}`);
    const old = current;
    current = null;
    open = false;
    if (old) {
      try { for (const [k, v] of Object.entries(old.hm || {})) if (/timer$/i.test(k)) clearInterval(v); } catch { /* ignore */ }
      try { old.ev.removeAllListeners('connection.update'); old.ev.removeAllListeners('messages.upsert'); } catch { /* ignore */ }
      try { old.end(undefined); } catch { /* ignore */ }
    }
    await connect();
  }
  const watchdog = setInterval(() => {
    try {
      if (stopped) { clearInterval(watchdog); return; }
      if (open && current && !wsAlive(current)) { // looks connected, but the socket is closed
        if (++badSocketChecks >= 2) { badSocketChecks = 0; restartSocket('the connection looked open but the socket was closed').catch((e) => console.error(`[${number}] watchdog restart failed:`, e.message)); }
        return;
      }
      badSocketChecks = 0;
      // linked before, but offline for 5 minutes: the normal reconnect failed or got stuck
      if (!open && everOpen && Date.now() - Math.max(lastDownAt, lastRestartAt) > 5 * 60000) {
        restartSocket('offline for more than 5 minutes').catch((e) => console.error(`[${number}] watchdog restart failed:`, e.message));
      }
    } catch { /* the watchdog must never throw */ }
  }, 90000);
  watchdog.unref();

  // NEW: tells the user about the starter settings (new people) and about updates (people who were already linked)
  async function announce(sock, returning) {
    if (announcing) return;
    announcing = true;
    try {
      await sleep(6000); // after the welcome banner
      const to = ownerJid();
      const p = config.prefix;
      if (starterNote) {
        starterNote = false;
        await sock.sendMessage(to, {
          text: `⚙️ *Starter settings*\nI switched these ON for you:\n✅ Auto view status (${p}autostatus)\n✅ Auto like status with random emojis (${p}autolikestatus)\n✅ Always online (${p}alwaysonline)\n✅ Anti delete (${p}antidelete)\n🔒 Private mode: only you can use the bot. Let other people in with ${p}mode public\n\nTurn any of them off with its command, for example ${p}antidelete off\n\nType ${p}updates to see what is new.`,
        });
      }
      if (returning && config.seenUpdate !== UPDATES.version) await sock.sendMessage(to, { text: UPDATES.text(p) });
      if (config.seenUpdate !== UPDATES.version) { config.seenUpdate = UPDATES.version; config.save(); }
    } catch (e) { console.error(`[${number}] update notice error:`, e.message); }
    finally { announcing = false; }
  }

  async function getGroup(sock, jid) {
    const hit = groupCache.get(jid);
    if (hit && Date.now() - hit.t < 60000) return hit.data;
    const data = await sock.groupMetadata(jid);
    groupCache.set(jid, { t: Date.now(), data });
    if (groupCache.size > GROUP_CACHE_MAX) groupCache.delete(groupCache.keys().next().value); // never grows without limit
    return data;
  }

  // ---------------- NEW: the view-once vault ----------------
  // A view-once message is saved on disk the moment it arrives (before WhatsApp removes it), so it survives a restart.
  // Each item has a small .json file (who, when, what) and a .bin file (the picture / video / voice note itself).
  const vvDir = path.join(dir, 'vv');
  const vvIndex = new Map(); // message id -> { id, t, kind, caption, mimetype, ptt, chat, from, name, size }
  const vvPath = (id) => path.join(vvDir, String(id).replace(/[^A-Za-z0-9_-]/g, '_'));
  let vvLoaded = false;
  function vvDrop(id) { vvIndex.delete(id); for (const e of ['.bin', '.json']) fs.unlink(vvPath(id) + e, () => {}); }
  function vvPurge() {
    const now = Date.now();
    for (const [id, m] of vvIndex) if (now - m.t > VV_MAX_AGE) vvDrop(id); // too old
    const list = [...vvIndex.values()].sort((a, b) => a.t - b.t);
    while (list.length > VV_MAX) vvDrop(list.shift().id); // too many: the oldest go first
  }
  function vvLoad() {
    if (vvLoaded) return;
    vvLoaded = true;
    try {
      for (const f of fs.readdirSync(vvDir)) {
        if (!f.endsWith('.json')) continue;
        try { const m = JSON.parse(fs.readFileSync(path.join(vvDir, f), 'utf8')); if (m && m.id) vvIndex.set(m.id, m); } catch { /* skip a broken file */ }
      }
    } catch { /* no vault yet */ }
    vvPurge();
  }
  function vvPut(meta, buffer) {
    fs.mkdirSync(vvDir, { recursive: true });
    fs.writeFileSync(vvPath(meta.id) + '.bin', buffer);
    fs.writeFileSync(vvPath(meta.id) + '.json', JSON.stringify(meta));
    vvIndex.set(meta.id, meta);
    vvPurge();
  }
  function vvGet(id) {
    vvLoad();
    const m = id && vvIndex.get(id);
    if (!m) return null;
    try { return { ...m, buffer: fs.readFileSync(vvPath(id) + '.bin') }; } catch { vvIndex.delete(id); return null; }
  }
  const vvList = (chat) => { vvLoad(); return [...vvIndex.values()].filter((m) => !chat || m.chat === chat).sort((a, b) => b.t - a.t); };

  // one download, with one more try if the first one fails
  async function downloadRetry(m) {
    try { return await download(m); } catch { await sleep(1500); return download(m); }
  }

  // save a view-once message right when it arrives
  async function saveViewOnce(msg) {
    try {
      vvLoad();
      if (!download || !msg.key?.id || vvIndex.has(msg.key.id)) return;
      const c = unwrap(msg.message);
      const kind = c.imageMessage ? 'image' : c.videoMessage ? 'video' : c.audioMessage ? 'audio' : null;
      if (!kind) return;
      const part = c[kind + 'Message'];
      if (!part.mediaKey && !part.directPath && !part.url) {
        log('view-once ' + kind + ' arrived WITHOUT its media (WhatsApp withheld it from this linked device, identity: ' + identity + ')');
        // tell the owner (at most once a day) how to fix it
        if (identity !== 'android' && !msg.key.fromMe && Date.now() - lastVvNudge > 24 * 60 * 60 * 1000 && current) {
          lastVvNudge = Date.now();
          current.sendMessage(ownerJid(), { text: `👁️ A view-once message just arrived, but WhatsApp did not give it to your bot.\nSend ${config.prefix}fixviewonce to fix this (you link your number again once, and your settings are kept).` }).catch(() => {});
        }
        return;
      }
      const buffer = await downloadRetry(msg);
      if (!buffer || !buffer.length || buffer.length > VV_MAX_BYTES) return;
      vvPut({
        id: msg.key.id, t: Date.now(), kind, caption: part.caption || '', mimetype: part.mimetype || '', ptt: !!part.ptt,
        chat: msg.key.remoteJid, from: digits(msg.key.participant || msg.key.remoteJid), name: msg.pushName || '', size: buffer.length,
      }, buffer);
      log('view-once ' + kind + ' saved in the vault (' + Math.round(buffer.length / 1024) + ' KB)');
    } catch (e) { log('could not save view-once:', e.message); }
  }

  // send a saved view-once item to a chat
  async function sendSaved(sock, to, hit, header = '') {
    const cap = [header, hit.caption].filter(Boolean).join('\n\n');
    if (hit.kind === 'image') return sock.sendMessage(to, { image: hit.buffer, caption: cap });
    if (hit.kind === 'video') return sock.sendMessage(to, { video: hit.buffer, caption: cap });
    if (header) await sock.sendMessage(to, { text: header });
    return sock.sendMessage(to, { audio: hit.buffer, mimetype: hit.mimetype || 'audio/ogg; codecs=opus', ptt: !!hit.ptt });
  }

  // ---------------- NEW: helpers for every command ----------------
  const withTimeout = (p, ms) => new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('That took too long and was stopped. Please try again.')), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e); });
  });
  function rateOk(key) {
    const now = Date.now();
    const arr = (rate.get(key) || []).filter((t) => now - t < RATE_WINDOW);
    if (arr.length >= RATE_MAX) { rate.set(key, arr); return false; }
    arr.push(now);
    rate.set(key, arr);
    if (rate.size > 500) rate.delete(rate.keys().next().value);
    return true;
  }
  // at most one hint per chat every `ms`
  function hintOk(chat, kind, ms) {
    const k = kind + chat, now = Date.now();
    if (now - (notes.get(k) || 0) < ms) return false;
    notes.set(k, now);
    if (notes.size > 300) notes.delete(notes.keys().next().value);
    return true;
  }
  const bump = (name, failed, ms) => { const e = (stats.byCmd[name] ||= { n: 0, err: 0, ms: 0 }); e.n++; if (failed) e.err++; e.ms += ms; };

  // "did you mean ...?" for a mistyped command (private chats and the owner only, never in other people's groups)
  function suggest(sock, msg, jid, p, typed) {
    try {
      const word = String(typed).toLowerCase();
      if (!/^[a-z0-9]{2,20}$/.test(word)) return;
      if (jid.endsWith('@g.us') && !msg.key.fromMe) return;
      if (config.mode === 'private' && !msg.key.fromMe) return;
      if (!hintOk(jid, 'sg', 20000)) return;
      const max = word.length <= 4 ? 1 : 2;
      const found = new Map(); // command -> best distance
      for (const [name, c] of registry) {
        if (name.length < 3 || Math.abs(name.length - word.length) > max + 3) continue;
        const d = word.length >= 3 && name.startsWith(word) ? 0 : lev(word, name);
        if (d <= max && !(found.get(c) <= d)) found.set(c, d);
      }
      const top = [...found.entries()].sort((a, b) => a[1] - b[1] || a[0].name.length - b[0].name.length).slice(0, 2).map(([c]) => '*' + p + c.name + '*');
      if (!top.length) return;
      sock.sendMessage(jid, { text: `🤔 *${p}${word}* is not a command. Did you mean ${top.join(' or ')}?\nType *${p}menu* to see all commands.` }, { quoted: msg }).catch(() => {});
    } catch { /* a hint must never break anything */ }
  }

  // a sticker bound with .stickcmd runs its command (owner only); the sticker's reply context is kept
  function withStickerCmd(sock, msg) {
    const cmd = extra.stickerCommand(sock, msg);
    if (!cmd) return msg;
    const fromOwner = msg.key.fromMe || [msg.key.participant, msg.key.participantAlt, msg.key.remoteJid].some((j) => j && config.owners.includes(digits(j)));
    if (!fromOwner) return msg;
    const st = unwrap(msg.message).stickerMessage;
    return { ...msg, message: { extendedTextMessage: { text: config.prefix + cmd, contextInfo: st.contextInfo || {} } } };
  }

  async function handle(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || !msg.message) return;

    // "Hanson, ...": the assistant turns the request into a command (typed as the same person) or just answers
    if (hanson.wants(sock, msg, config)) {
      msg = await hanson.route(sock, msg, { config, registry });
      if (!msg) return;
    }

    const message = unwrap(msg.message);
    const body = getText(message).trim();
    const prefixes = config.multiPrefix ? [config.prefix, ...MULTI_PREFIXES.filter((p) => p !== config.prefix)] : [config.prefix];
    const usedPrefix = prefixes.find((p) => body.startsWith(p));
    if (!usedPrefix) return;

    // CHANGED: spaces between the prefix and the command are allowed, so ". play song" works like ".play song"
    const m = body.slice(usedPrefix.length).match(/^\s*(\S+)\s*([\s\S]*)$/);
    if (!m) return;
    const cmd = registry.get(m[1].toLowerCase());
    if (!cmd) return void suggest(sock, msg, jid, usedPrefix, m[1]); // NEW: "did you mean ...?"
    const text = m[2].trim();

    const isGroup = jid.endsWith('@g.us');
    const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(norm);
    const senderRaw = msg.key.fromMe ? sock.user.id : isGroup ? msg.key.participant || msg.participant : jid;
    const sender = norm(senderRaw);
    const senderIds = [sender, msg.key.participantAlt, msg.key.remoteJidAlt].filter(Boolean).map(norm);

    const isMainOwner = msg.key.fromMe || senderIds.some((s) => config.owners.includes(digits(s)));
    const sudo = sock.hm?.db?.sudo || []; // extra owners added with .setsudo
    const isOwner = isMainOwner || senderIds.some((s) => sudo.includes(digits(s)));
    if (config.mode === 'private' && !isOwner) return;
    // NEW: a normal user cannot flood the bot (the owner has no limit)
    if (!isOwner && !rateOk(senderIds[0] || jid)) {
      if (hintOk(jid, 'sl', RATE_WINDOW)) sock.sendMessage(jid, { text: '🐢 Slow down a little, then try again.' }, { quoted: msg }).catch(() => {});
      return;
    }
    stats.commands++; stats.lastActive = Date.now();
    emit('command', { name: cmd.name, by: digits(senderIds[0]), group: isGroup });

    const ctxInfo = message.extendedTextMessage?.contextInfo || message.imageMessage?.contextInfo || message.videoMessage?.contextInfo || {};
    const qm = ctxInfo.quotedMessage ? unwrap(ctxInfo.quotedMessage) : null;
    const quoted = qm ? {
      id: ctxInfo.stanzaId,
      participant: ctxInfo.participant ? norm(ctxInfo.participant) : undefined,
      text: getText(qm),
      fromBot: botIds.includes(norm(ctxInfo.participant)),
    } : null;

    const send = (content) => sock.sendMessage(jid, content, { quoted: msg });
    const ctx = {
      sock, msg, jid, isGroup, sender, isOwner, isMainOwner, quoted, config, prefix: usedPrefix,
      text, args: text ? text.split(/\s+/) : [],
      mentioned: (ctxInfo.mentionedJid || []).map(norm),
      isAdmin: false, isBotAdmin: false,
      reply: (t) => send({ text: String(t) }),
      send,
      sendImage: (url, caption) => send({ image: { url }, caption }),
      getGroup: () => getGroup(sock, jid),
      ownerJid: ownerJid(),
      stats,
      // NEW: the view-once vault (used by .vvlist and .vvget)
      vv: {
        list: (all) => vvList(all ? null : jid),
        get: vvGet,
        send: (id, to, header) => { const h = vvGet(id); if (!h) throw new Error('That item is no longer in the vault.'); return sendSaved(sock, to, h, header); },
      },
      // the picture sent with the command, or the one it replies to
      downloadMedia: async () => {
        if (!download) throw new Error('The bot is not ready yet. Try again.');
        if (message.imageMessage) return download(msg);
        if (!ctxInfo.quotedMessage) throw new Error('Reply to a picture, or send a picture with this command as its caption.');
        // NEW: a view-once picture was saved when it arrived, so use that copy
        const saved = vvGet(ctxInfo.stanzaId);
        if (saved) return saved.buffer;
        return download({ key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant }, message: ctxInfo.quotedMessage });
      },
      forwardQuoted: async (to, header) => {
        // NEW: .retrieve without a reply sends the newest view-once message saved in this chat
        if (!ctxInfo.quotedMessage) {
          const last = cmd.name === 'retrieve' ? vvList(jid)[0] : null;
          const hit = last && vvGet(last.id);
          if (hit) return sendSaved(sock, to, hit, header);
          throw new Error('Reply to the message you want to retrieve.' + (cmd.name === 'retrieve' ? ' (No view-once message is saved in this chat yet.)' : ''));
        }
        try {
          // a view-once message was saved when it arrived, so send that copy
          const saved = vvGet(ctxInfo.stanzaId);
          if (saved) return await sendSaved(sock, to, saved, header);
          return await forward(sock, to, { key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant }, message: ctxInfo.quotedMessage }, header);
        } catch (e) {
          if (isViewOnce(ctxInfo.quotedMessage)) {
            if (config.identity !== 'android') {
              throw new Error(`WhatsApp does not send view-once pictures to the way your bot is linked. Send ${usedPrefix}fixviewonce to fix it (you link your number again once).`);
            }
            throw new Error('That view-once message was not saved. The bot must be online when it is sent. Ask for a new one and reply to it again.');
          }
          throw new Error('Could not retrieve that media (it may have expired): ' + e.message);
        }
      },
    };

    if (running >= MAX_RUNNING) { if (!isGroup) ctx.reply('⏳ Too many commands at once. Please wait a moment.').catch(() => {}); return; }
    running++;
    try {
      if (cmd.owner && !isOwner) return void (await ctx.reply('⛔ This command is for the bot owner only.'));
      if (cmd.group && !isGroup) return void (await ctx.reply('👥 This command only works in groups.'));
      if (isGroup && (cmd.admin || cmd.botAdmin || cmd.name === 'delete')) {
        const g = await ctx.getGroup();
        const admins = g.participants.filter((p) => p.admin);
        ctx.isAdmin = isOwner || admins.some((p) => idsOf(p).some((i) => senderIds.includes(i)));
        ctx.isBotAdmin = admins.some((p) => idsOf(p).some((i) => botIds.includes(i)));
      }
      if (cmd.admin && !ctx.isAdmin) return void (await ctx.reply('⛔ Only group admins can use this command.'));
      if (cmd.botAdmin && !ctx.isBotAdmin) return void (await ctx.reply('⚠️ Make me a group admin first, then try again.'));

      const t0 = Date.now();
      const out = await withTimeout(cmd.run(ctx), CMD_TIMEOUT_MS); // NEW: a hanging command is stopped
      bump(cmd.name, false, Date.now() - t0);
      if (typeof out === 'string' && out) await ctx.reply(out);
    } catch (err) {
      bump(cmd.name, true, 0);
      heal.noteError(cmd.name, err); // NEW: counted for .errors (phone numbers are hidden)
      console.error(`[${number}] [${cmd.name}]`, err);
      await ctx.reply('⚠️ ' + friendlyError(err)).catch(() => {}); // NEW: plain words instead of technical errors
    } finally { running--; }
  }

  // --- recent message store (for antidelete) ---
  function remember(msg) {
    if (!msg.message || !msg.key.id) return;
    store.set(msg.key.id, { msg });
    if (store.size > STORE_MAX) store.delete(store.keys().next().value);
  }

  async function watchers(sock, msg) {
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    const where = jid.endsWith('@g.us') ? 'a group' : 'private chat';
    const proto = unwrap(msg.message).protocolMessage;
    try {
      // someone deleted a message
      if (proto && (proto.type === 0 || proto.type === 'REVOKE')) {
        if (!config.antiDelete) return;
        const old = store.get(proto.key?.id);
        if (!old || old.msg.key.fromMe) return;
        const who = old.msg.pushName || '+' + digits(old.msg.key.participant || old.msg.key.remoteJid);
        const header = `🗑️ *Deleted message*\nFrom: ${who} (${'+' + digits(old.msg.key.participant || old.msg.key.remoteJid)})\nIn: ${where}`;
        try { await forward(sock, ownerJid(), old.msg, header); }
        catch { await sock.sendMessage(ownerJid(), { text: header + '\n\n(the media could not be recovered)' }); }
        return;
      }
      // someone sent a view-once message
      if (config.antiViewOnce && !msg.key.fromMe && isViewOnce(msg.message)) {
        const header = `👁️ *View-once message*\nFrom: ${msg.pushName || ''} (+${digits(msg.key.participant || msg.key.remoteJid)})\nIn: ${where}`;
        try { await forward(sock, ownerJid(), msg, header); }
        catch { await sock.sendMessage(ownerJid(), { text: header + '\n\n(the media could not be recovered)' }); }
      }
    } catch (e) { console.error(`[${number}] watcher error:`, e.message); }
  }

  // CHANGED: the real work is now done by status.js (it converts the poster's LID to a phone JID,
  // skips duplicates, marks the status as seen, then reacts with a statusJidList).
  async function handleStatus(sock, msg) {
    if (msg.key.fromMe || !msg.message) return;
    // ignore old statuses replayed after a reconnect (older than 1 hour)
    const ts = Number(msg.messageTimestamp || 0);
    if (ts && Date.now() / 1000 - ts > 3600) return;
    // reads the user's CURRENT settings every time (so .autolikestatus works without a restart)
    if (!config.autoStatus && !config.autoLikeStatus) return;
    await statusMod.handleStatus(sock, msg, {
      autoview: true, // viewing first makes the like show up reliably
      autolike: config.autoLikeStatus,
      emoji: likeEmojiNow(),
    });
  }

  async function connect() {
    if (stopped) return;
    const { B, makeWASocket, version } = await loadBaileys();
    const logger = pino({ level: 'silent' });

    // NEW: starter settings for a brand-new user. Someone who already has a saved login keeps what they have.
    if (!config.defaultsApplied) {
      const returning = fs.existsSync(path.join(config.sessionDir, 'creds.json'));
      config.defaultsApplied = true;
      if (!returning) {
        Object.assign(config, NEW_USER_DEFAULTS);
        onlineByDefault = true;
        starterNote = true;
      }
      config.save();
    }

    // NEW: how this number is linked (decided before the session folder is created)
    identity = pickIdentity(B);
    if (config.identity !== identity) { config.identity = identity; config.save(); }
    if (identity === 'android') log('connecting with the android identity (view-once pictures can be received)');

    fs.mkdirSync(config.sessionDir, { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(config.sessionDir);
    if (stopped) return;

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      browser: identity === 'android' ? B.Browsers.android('13') : (B.Browsers ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4']),
      markOnlineOnConnect: false,
      // .onetick: private chats are ignored at connection level, so the bot never confirms them (see more5.js)
      shouldIgnoreJid: (jid) => moreFive.oneTickIgnore(sock, jid),
      // when a phone cannot decrypt a message it asks for it again; without this the chat shows
      // "Waiting for this message. This may take a while."
      getMessage: async (key) => store.get(key.id)?.msg?.message || undefined,
    });
    current = sock;

    sock.ev.on('creds.update', saveCreds);
    extra.boot(sock, dir);
    more7.boot(sock); // NEW: collects contacts for .textall
    if (onlineByDefault) { // NEW: always online is ON for a new user (the ping starts when the connection opens)
      onlineByDefault = false;
      sock.hm.db.alwaysOnline = true;
      sock.hm.save();
    }
    download = (m) => B.downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    forward = makeForwarder(download);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (sock !== current) return; // an old socket
      if (connection === 'open') {
        open = true;
        everOpen = true;
        retry = 0;
        androidTried.delete(number); // the link worked
        more7.clearRelink(number); // the saved copy of the settings is no longer needed
        // the owner is shown by name (OWNER_NAME overrides it for every user), not by number
        config.ownerName = (process.env.OWNER_NAME || sock.user?.name || '').trim();
        log('connected as', sock.user?.id);
        emit('connected', { name: config.ownerName });
        // NEW: someone who has seen the welcome banner before (or has it switched off) is an existing user
        const returning = config.welcomed || /^(off|false|0)$/i.test(process.env.WELCOME || '');
        ui.welcome(sock, config, commands.length).catch((e) => console.error(`[${number}] welcome error:`, e.message));
        announce(sock, returning); // NEW: starter settings (new users) or "what's new" (existing users)
      }
      if (connection === 'close') {
        open = false;
        lastDownAt = Date.now();
        if (stopped) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === B.DisconnectReason.loggedOut) {
          stopped = true;
          log('logged out from WhatsApp');
          emit('loggedout');
          Promise.resolve(onLoggedOut && onLoggedOut()).catch((e) => console.error(`[${number}] logout cleanup failed:`, e.message));
          return;
        }
        retry++;
        // code 440: the same login is open somewhere else (for example an old copy of the bot is still running).
        // Reconnecting at once would start a fight with it, so wait much longer.
        const conflict = code === 440;
        if (conflict && (retry === 1 || retry % 5 === 0)) heal.noteEvent('conflict', `bot ...${String(number).slice(-4)}: this login is open somewhere else (code 440). Is an old copy of the bot still running?`);
        log('connection closed (code ' + code + '), reconnecting...');
        setTimeout(() => {
          if (stopped || current !== sock) return; // the watchdog already replaced this connection
          connect().catch((e) => console.error(`[${number}] reconnect failed:`, e.message));
        }, conflict ? Math.min(300000, 30000 * retry) : Math.min(30000, 3000 * retry));
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        // one bad message must not stop the rest of the batch (or the bot)
        try {
          // statuses can arrive as "notify" or "append", so they are handled before the type check
          if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJidAlt === 'status@broadcast') { handleStatus(sock, msg).catch((e) => console.error(`[${number}] status error:`, e.message)); continue; }
          remember(msg); // also the bot's own sent messages (type "append"), so they can be re-sent on request
          // NEW: keep a copy of every fresh view-once message (so retrieve still works after it is opened)
          if (msg.message && isViewOnce(msg.message)) {
            const ts = Number(String(msg.messageTimestamp || 0));
            if (!ts || Date.now() / 1000 - ts < 600) saveViewOnce(msg);
          }
          if (type !== 'notify') continue;
          watchers(sock, msg).catch((e) => console.error(`[${number}] watcher error:`, e.message));
          more7.passive(sock, msg); // NEW: remembers people you chat with (for .textall)
          Promise.resolve(extra.passive(sock, msg)).catch((e) => console.error(`[${number}] passive error:`, e.message));
          handle(sock, ui.fromListReply(withStickerCmd(sock, msg))).catch((e) => console.error(`[${number}] handler error:`, e));
        } catch (e) { console.error(`[${number}] message error:`, e.message); }
      }
    });
  }

  async function requestPairingCode() {
    const ask = async () => {
      if (!current) throw new Error('The bot is not ready yet. Try again.');
      const creds = current.authState.creds;
      if (creds.registered || creds.me) throw new Error('This number is already linked.');
      await sleep(3000); // the connection needs a moment before WhatsApp accepts the request
      if (!current || stopped) throw new Error('The connection was closed. Try again.');
      return current.requestPairingCode(number);
    };
    try {
      const code = await ask();
      if (identity === 'android') androidTried.set(number, Date.now()); // if this link never finishes, the next try uses the normal way
      return code;
    } catch (e) {
      if (identity !== 'android' || /already linked/i.test(e.message)) throw e;
      // NEW: the android way could not give a pairing code, so use the normal way instead (automatic)
      log('android identity failed (' + e.message + '), using the normal identity');
      webOnly.add(number);
      await switchIdentity('web');
      return ask();
    }
  }

  function stop() {
    stopped = true;
    clearInterval(watchdog);
    open = false;
    const s = current;
    current = null;
    if (!s) return;
    // every timer this socket started (always-online, schedules, reminders, auto bio ...)
    try { for (const [k, v] of Object.entries(s.hm || {})) if (/timer$/i.test(k)) clearInterval(v); } catch { /* ignore */ }
    try { s.ev.removeAllListeners('connection.update'); s.ev.removeAllListeners('messages.upsert'); } catch { /* ignore */ }
    try { s.end(undefined); } catch { /* ignore */ }
  }

  // used by the admin tools (manager.js)
  const sendText = async (to, text) => { if (!current || !open) throw new Error('not connected'); return current.sendMessage(to, { text }); };
  const logout = async () => { if (!current) throw new Error('not running'); return current.logout(); };

  return { number, config, stats, start: connect, stop, requestPairingCode, sendText, logout, isOpen: () => open, everOpen: () => everOpen };
}

module.exports = { createBot, commandCount: commands.length };
