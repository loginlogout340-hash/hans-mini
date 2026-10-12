'use strict';
/**
 * Hans-Mini: a small WhatsApp bot on Baileys.
 * Settings come from environment variables (see README.md).
 */
const fs = require('fs');
const pino = require('pino');
const { commands } = require('./commands');
const extra = require('./extra');
const { unwrap, getText, isViewOnce, makeForwarder } = require('./media');
const ui = require('./ui');

const config = {
  botName: process.env.BOT_NAME || 'Hans-Mini',
  prefix: process.env.PREFIX || '.',
  mode: (process.env.MODE || 'public').toLowerCase(), // public | private
  owners: (process.env.OWNER_NUMBER || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  pairNumber: (process.env.PAIR_NUMBER || '').replace(/\D/g, ''),
  sessionDir: process.env.SESSION_DIR || './session',
  timezone: process.env.TIMEZONE || 'Africa/Accra',
  startedAt: Date.now(),
  // status features (can be switched with .autostatus / .autolikestatus; saved in the session folder)
  autoStatus: /^(on|true|1)$/i.test(process.env.AUTO_STATUS || ''),
  autoLikeStatus: /^(on|true|1)$/i.test(process.env.AUTO_LIKE_STATUS || ''),
  likeEmoji: process.env.LIKE_EMOJI || '💚',
  antiViewOnce: /^(on|true|1)$/i.test(process.env.ANTI_VIEWONCE || ''),
  antiDelete: /^(on|true|1)$/i.test(process.env.ANTI_DELETE || ''),
};
const settingsFile = () => config.sessionDir + '/settings.json';
try {
  const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  for (const k of ['autoStatus', 'autoLikeStatus', 'likeEmoji', 'mode', 'antiViewOnce', 'antiDelete']) if (saved[k] !== undefined) config[k] = saved[k];
} catch { /* no saved settings yet */ }
config.save = () => {
  try {
    fs.mkdirSync(config.sessionDir, { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ autoStatus: config.autoStatus, autoLikeStatus: config.autoLikeStatus, likeEmoji: config.likeEmoji, mode: config.mode, antiViewOnce: config.antiViewOnce, antiDelete: config.antiDelete }));
  } catch (e) { console.error('Could not save settings:', e.message); }
};

// name/alias -> command
const registry = new Map();
for (const c of commands) {
  for (const n of [c.name, ...c.aliases]) {
    if (registry.has(n)) throw new Error('Duplicate command name: ' + n);
    registry.set(n, c);
  }
}

ui.install(registry, commands); // styled menu with the default picture

const norm = (j) => String(j || '').replace(/:\d+@/, '@');
const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');

const groupCache = new Map();
async function getGroup(sock, jid) {
  const hit = groupCache.get(jid);
  if (hit && Date.now() - hit.t < 60000) return hit.data;
  const data = await sock.groupMetadata(jid);
  groupCache.set(jid, { t: Date.now(), data });
  return data;
}
const idsOf = (p) => [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean).map(norm);

// a sticker bound with .stickcmd runs its command (owner only); the sticker's reply context is kept
function withStickerCmd(msg) {
  const cmd = extra.stickerCommand(msg);
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
  if (!body.startsWith(config.prefix)) return;

  const m = body.slice(config.prefix.length).match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return;
  const cmd = registry.get(m[1].toLowerCase());
  if (!cmd) return;
  const text = m[2].trim();

  const isGroup = jid.endsWith('@g.us');
  const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(norm);
  const senderRaw = msg.key.fromMe ? sock.user.id : isGroup ? msg.key.participant || msg.participant : jid;
  const sender = norm(senderRaw);
  const senderIds = [sender, msg.key.participantAlt, msg.key.remoteJidAlt].filter(Boolean).map(norm);

  const isOwner = msg.key.fromMe || senderIds.some((s) => config.owners.includes(digits(s)));
  if (config.mode === 'private' && !isOwner) return;

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
    sock, msg, jid, isGroup, sender, isOwner, quoted, config, prefix: config.prefix,
    text, args: text ? text.split(/\s+/) : [],
    mentioned: (ctxInfo.mentionedJid || []).map(norm),
    isAdmin: false, isBotAdmin: false,
    reply: (t) => send({ text: String(t) }),
    send,
    sendImage: (url, caption) => send({ image: { url }, caption }),
    getGroup: () => getGroup(sock, jid),
    ownerJid: ownerJid(sock),
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
    console.error(`[${cmd.name}]`, err);
    await ctx.reply('⚠️ ' + (err && err.message ? err.message : 'Something went wrong.')).catch(() => {});
  }
}

// --- recent message store (for antidelete) and media copying ---
const store = new Map();
const STORE_MAX = 1000;
function remember(msg) {
  if (!msg.message || !msg.key.id) return;
  store.set(msg.key.id, { msg });
  if (store.size > STORE_MAX) store.delete(store.keys().next().value);
}
let forward = null; // set in start() once Baileys is loaded
const ownerJid = (sock) => (config.owners[0] ? config.owners[0] + '@s.whatsapp.net' : norm(sock.user.id));

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
      try { await forward(sock, ownerJid(sock), old.msg, header); }
      catch { await sock.sendMessage(ownerJid(sock), { text: header + '\n\n(the media could not be recovered)' }); }
      return;
    }
    // someone sent a view-once message
    if (config.antiViewOnce && !msg.key.fromMe && isViewOnce(msg.message)) {
      const header = `👁️ *View-once message*\nFrom: ${msg.pushName || ''} (+${digits(msg.key.participant || msg.key.remoteJid)})\nIn: ${where}`;
      try { await forward(sock, ownerJid(sock), msg, header); }
      catch { await sock.sendMessage(ownerJid(sock), { text: header + '\n\n(the media could not be recovered)' }); }
    }
  } catch (e) { console.error('watcher error:', e.message); }
}

async function handleStatus(sock, msg) {
  if (msg.key.fromMe || !msg.message) return;
  // ignore old statuses replayed after a reconnect (older than 1 hour)
  const ts = Number(msg.messageTimestamp || 0);
  if (ts && Date.now() / 1000 - ts > 3600) return;
  const posters = [msg.key.participant, msg.key.participantAlt, msg.participant].filter(Boolean).map(norm);
  if (!posters.length) return;
  try {
    // viewing the status first makes the like show up reliably
    if (config.autoStatus || config.autoLikeStatus) await sock.readMessages([msg.key]).catch((e) => console.error('status read error:', e.message));
    if (config.autoLikeStatus) {
      const list = [...new Set([...posters, norm(sock.user.id), sock.user?.lid ? norm(sock.user.lid) : null].filter(Boolean))];
      await sock.sendMessage('status@broadcast',
        { react: { key: msg.key, text: config.likeEmoji } },
        { statusJidList: list });
      console.log('[status] liked status from', posters[0]);
    }
  } catch (e) { console.error('status handler error:', e.message); }
}

async function start() {
  const baileys = await import('@whiskeysockets/baileys');
  // Works whether the installed Baileys is CommonJS (v6) or ESM (v7)
  const B = baileys.default && (baileys.default.useMultiFileAuthState || baileys.default.default) ? baileys.default : baileys;
  const makeWASocket = typeof B.default === 'function' ? B.default : B.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage, generateWAMessageFromContent, proto } = B;
  ui.init({ generateWAMessageFromContent, proto });
  const logger = pino({ level: 'silent' });

  fs.mkdirSync(config.sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use Baileys default */ }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);
  extra.boot(sock);
  forward = makeForwarder((m) => downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }));

  if (!sock.authState.creds.registered) {
    if (!config.pairNumber) {
      console.error('Not logged in yet. Set PAIR_NUMBER (your number with country code, digits only) and restart.');
    } else {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(config.pairNumber);
          console.log('\n=====================================');
          console.log('  PAIRING CODE: ' + (code.match(/.{1,4}/g) || [code]).join('-'));
          console.log('  WhatsApp > Settings > Linked devices > Link with phone number');
          console.log('=====================================\n');
        } catch (e) { console.error('Could not get a pairing code:', e.message); }
      }, 3000);
    }
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log(`✅ ${config.botName} connected as ${sock.user?.id}`);
      ui.welcome(sock, config, commands.length).catch((e) => console.error('welcome error:', e.message));
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('Logged out from WhatsApp. Delete the session folder, then restart to pair again.');
        process.exit(1);
      }
      console.log('Connection closed (code ' + code + '), reconnecting...');
      setTimeout(() => start().catch((e) => console.error('Restart failed:', e)), 3000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      // statuses can arrive as "notify" or "append", so they are handled before the type check
      if (msg.key.remoteJid === 'status@broadcast') { handleStatus(sock, msg); continue; }
      if (type !== 'notify') continue;
      remember(msg);
      watchers(sock, msg);
      extra.passive(sock, msg);
      handle(sock, ui.fromListReply(withStickerCmd(msg))).catch((e) => console.error('handler error:', e));
    }
  });
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

console.log(`${config.botName}: ${commands.length} commands loaded, prefix "${config.prefix}", mode ${config.mode}`);
start().catch((e) => { console.error('Fatal:', e); process.exit(1); });
