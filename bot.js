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

// name/alias -> command (shared by every user, built once)
const registry = new Map();
for (const c of commands) {
  for (const n of [c.name, ...c.aliases]) {
    if (registry.has(n)) { console.warn('Duplicate command name ignored: ' + n + ' (the first one is kept)'); continue; }
    registry.set(n, c);
  }
}
ui.install(registry, commands); // styled menu with the default picture

// .autolikestatus emoji random  ->  a different emoji from this list for every status
const STATUS_EMOJIS = ['❤️', '🔥', '😂', '😍', '👏', '🥰', '💯', '😭', '🤣', '🙏', '👌', '💪', '🤩', '😎', '🥳', '✨', '💀', '🤯', '😤', '💅', '👀', '🎉', '😈', '🤫', '🫶'];
const SAVED_KEYS = ['autoStatus', 'autoLikeStatus', 'likeEmoji', 'mode', 'antiViewOnce', 'antiDelete', 'welcomed', 'prefix', 'multiPrefix'];
const MULTI_PREFIXES = ['.', '!', '#', '/', '$', '~', ','];
const STORE_MAX = 600; // recent messages kept per user (for antidelete)

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
  const stats = { since: Date.now(), commands: 0, lastActive: 0 }; // for the admin (.users)
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
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    for (const k of SAVED_KEYS) if (saved[k] !== undefined) config[k] = saved[k];
  } catch { /* no saved settings yet */ }
  config.save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(Object.fromEntries(SAVED_KEYS.map((k) => [k, config[k]]))));
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

  async function getGroup(sock, jid) {
    const hit = groupCache.get(jid);
    if (hit && Date.now() - hit.t < 60000) return hit.data;
    const data = await sock.groupMetadata(jid);
    groupCache.set(jid, { t: Date.now(), data });
    return data;
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

    const message = unwrap(msg.message);
    const body = getText(message).trim();
    const prefixes = config.multiPrefix ? [config.prefix, ...MULTI_PREFIXES.filter((p) => p !== config.prefix)] : [config.prefix];
    const usedPrefix = prefixes.find((p) => body.startsWith(p));
    if (!usedPrefix) return;

    const m = body.slice(usedPrefix.length).match(/^(\S+)\s*([\s\S]*)$/);
    if (!m) return;
    const cmd = registry.get(m[1].toLowerCase());
    if (!cmd) return;
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
      // the picture sent with the command, or the one it replies to
      downloadMedia: async () => {
        if (!download) throw new Error('The bot is not ready yet. Try again.');
        if (message.imageMessage) return download(msg);
        if (!ctxInfo.quotedMessage) throw new Error('Reply to a picture, or send a picture with this command as its caption.');
        return download({ key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant }, message: ctxInfo.quotedMessage });
      },
      forwardQuoted: async (to, header) => {
        if (!ctxInfo.quotedMessage) throw new Error('Reply to the message you want to retrieve.');
        try {
          return await forward(sock, to, { key: { remoteJid: jid, id: ctxInfo.stanzaId, participant: ctxInfo.participant }, message: ctxInfo.quotedMessage }, header);
        } catch (e) { throw new Error('Could not retrieve that media (it may have expired): ' + e.message); }
      },
    };

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

      const out = await cmd.run(ctx);
      if (typeof out === 'string' && out) await ctx.reply(out);
    } catch (err) {
      console.error(`[${number}] [${cmd.name}]`, err);
      await ctx.reply('⚠️ ' + (err && err.message ? err.message : 'Something went wrong.')).catch(() => {});
    }
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

    fs.mkdirSync(config.sessionDir, { recursive: true });
    const { state, saveCreds } = await B.useMultiFileAuthState(config.sessionDir);
    if (stopped) return;

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      browser: B.Browsers ? B.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
      markOnlineOnConnect: false,
      // when a phone cannot decrypt a message it asks for it again; without this the chat shows
      // "Waiting for this message. This may take a while."
      getMessage: async (key) => store.get(key.id)?.msg?.message || undefined,
    });
    current = sock;

    sock.ev.on('creds.update', saveCreds);
    extra.boot(sock, dir);
    download = (m) => B.downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    forward = makeForwarder(download);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (sock !== current) return; // an old socket
      if (connection === 'open') {
        open = true;
        everOpen = true;
        retry = 0;
        // the owner is shown by name (OWNER_NAME overrides it for every user), not by number
        config.ownerName = (process.env.OWNER_NAME || sock.user?.name || '').trim();
        log('connected as', sock.user?.id);
        emit('connected', { name: config.ownerName });
        ui.welcome(sock, config, commands.length).catch((e) => console.error(`[${number}] welcome error:`, e.message));
      }
      if (connection === 'close') {
        open = false;
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
        log('connection closed (code ' + code + '), reconnecting...');
        setTimeout(() => connect().catch((e) => console.error(`[${number}] reconnect failed:`, e.message)), Math.min(30000, 3000 * retry));
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        // statuses can arrive as "notify" or "append", so they are handled before the type check
        if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJidAlt === 'status@broadcast') { handleStatus(sock, msg); continue; }
        remember(msg); // also the bot's own sent messages (type "append"), so they can be re-sent on request
        if (type !== 'notify') continue;
        watchers(sock, msg);
        extra.passive(sock, msg);
        handle(sock, ui.fromListReply(withStickerCmd(sock, msg))).catch((e) => console.error(`[${number}] handler error:`, e));
      }
    });
  }

  async function requestPairingCode() {
    if (!current) throw new Error('The bot is not ready yet. Try again.');
    const creds = current.authState.creds;
    if (creds.registered || creds.me) throw new Error('This number is already linked.');
    await sleep(3000); // the connection needs a moment before WhatsApp accepts the request
    if (!current || stopped) throw new Error('The connection was closed. Try again.');
    return current.requestPairingCode(number);
  }

  function stop() {
    stopped = true;
    open = false;
    const s = current;
    current = null;
    if (!s) return;
    try { clearInterval(s.hm?.timer); } catch { /* ignore */ }
    try { s.ev.removeAllListeners('connection.update'); s.ev.removeAllListeners('messages.upsert'); } catch { /* ignore */ }
    try { s.end(undefined); } catch { /* ignore */ }
  }

  // used by the admin tools (manager.js)
  const sendText = async (to, text) => { if (!current || !open) throw new Error('not connected'); return current.sendMessage(to, { text }); };
  const logout = async () => { if (!current) throw new Error('not running'); return current.logout(); };

  return { number, config, stats, start: connect, stop, requestPairingCode, sendText, logout, isOpen: () => open, everOpen: () => everOpen };
}

module.exports = { createBot, commandCount: commands.length };
