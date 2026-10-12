'use strict';
/**
 * Hans-Mini extras: play, song, react, antigroupmention, antitag, stickcmd, alwaysonline
 * Deps: npm i yt-search   (downloads use yt-dlp + ffmpeg installed in the Dockerfile)
 *
 * commands.js  (just above module.exports):   require('./extra').register(add);
 * index.js     (after socket is created):     const extra = require('./extra'); extra.boot(sock);
 *              (top of messages.upsert loop): extra.passive(sock, m);
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const yts = require('yt-search');

const DB_FILE = path.join(process.env.SESSION_DIR || './session', '..', 'extra-settings.json');
const MAX_MB = 40;
const num = (j = '') => String(j).split('@')[0].split(':')[0];

/* ---------- persistent store ---------- */
let db = { groups: {}, stickers: {}, alwaysOnline: false };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
let t;
const save = () => { clearTimeout(t); t = setTimeout(() => { try { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {} }, 500); };
const grp = (jid) => (db.groups[jid] ||= { antiGroupMention: 'off', antiTag: 'off' });

/* ---------- music (yt-dlp) ---------- */
const videoIdOf = (u) => {
  const m = String(u).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m && m[1];
};
async function findVideo(q) {
  if (/^https?:\/\//i.test(q)) {
    const id = videoIdOf(q);
    if (!id) throw new Error('That does not look like a YouTube link.');
    return yts({ videoId: id });
  }
  const r = await yts(q);
  return r.videos.find((v) => v.seconds > 0 && v.seconds <= 3600);
}
function run(args) {
  return new Promise((ok, no) => {
    execFile('yt-dlp', args, { timeout: 180000, maxBuffer: 1 << 24 }, (err, out, errout) => {
      if (err) return no(new Error(String(errout || err.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 250)));
      ok(out);
    });
  });
}
async function audioOf(url) {
  const base = path.join(os.tmpdir(), 'hm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '--max-filesize', MAX_MB + 'M',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--js-runtimes', 'node',
    '-o', base + '.%(ext)s',
  ];
  if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) args.push('--cookies', process.env.YT_COOKIES_FILE);
  args.push(url);
  try {
    await run(args);
    const file = base + '.mp3';
    if (!fs.existsSync(file)) throw new Error('Download failed (no file produced).');
    return fs.readFileSync(file);
  } finally {
    for (const ext of ['mp3', 'webm', 'm4a', 'opus', 'part']) fs.unlink(base + '.' + ext, () => {});
  }
}
async function music(ctx, asFile) {
  const q = ctx.text || ctx.quoted?.text;
  if (!q) throw new Error(`Usage: ${ctx.prefix}${asFile ? 'song' : 'play'} <name or YouTube link>`);
  const v = await findVideo(q);
  if (!v) throw new Error('No results found.');
  const card = `🎵 *${v.title}*\n👤 ${v.author?.name || '-'}\n⏱ ${v.timestamp || '-'}\n🔗 ${v.url}`;
  if (v.thumbnail) await ctx.sendImage(v.thumbnail, card); else await ctx.reply(card);
  const buf = await audioOf(v.url);
  const quoted = { quoted: ctx.msg };
  if (asFile) {
    const name = v.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
    await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'audio/mpeg', fileName: name + '.mp3' }, quoted);
  } else {
    await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, quoted);
  }
}

/* ---------- always online ---------- */
let timer;
function applyOnline(sock) {
  clearInterval(timer);
  if (!db.alwaysOnline) return;
  const ping = () => sock.sendPresenceUpdate('available').catch(() => {});
  ping();
  timer = setInterval(ping, 25000);
}

/* ---------- commands ---------- */
function register(add) {
  require('./ui').register(add);
  add('play', 'Media', '<name or link>', 'Search YouTube and send the song as audio', (ctx) => music(ctx, false), { aliases: ['music'] });
  add('song', 'Media', '<name or link>', 'Search YouTube and send the song as a downloadable file', (ctx) => music(ctx, true), { aliases: ['mp3'] });

  add('react', 'Fun', '<emoji>', 'Reply to a message with this command to react to it', async (ctx) => {
    const emoji = (ctx.text.match(/\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/u) || [])[0];
    if (!emoji) throw new Error(`Usage: reply to a message with ${ctx.prefix}react 😂`);
    const key = ctx.quoted
      ? { remoteJid: ctx.jid, id: ctx.quoted.id, participant: ctx.quoted.participant, fromMe: !!ctx.quoted.fromBot }
      : ctx.msg.key;
    await ctx.sock.sendMessage(ctx.jid, { react: { text: emoji, key } });
  });

  const guard = (name, key, label, desc) =>
    add(name, 'Group', 'on|delete|kick|off', desc, (ctx) => {
      const v = (ctx.args[0] || '').toLowerCase();
      const cfg = grp(ctx.jid);
      if (!['on', 'delete', 'kick', 'off'].includes(v)) return `${label}: *${cfg[key]}*\nUsage: ${ctx.prefix}${name} on|delete|kick|off`;
      cfg[key] = v === 'on' ? 'delete' : v;
      save();
      return `✅ ${label} is now *${cfg[key]}*`;
    }, { group: true, admin: true, botAdmin: true });
  guard('antigroupmention', 'antiGroupMention', 'Anti group mention', 'Delete (or kick for) messages that mention the group in a status');
  guard('antitag', 'antiTag', 'Anti tag', 'Delete (or kick for) mass tagging by non-admins');

  add('stickcmd', 'Owner', '<command> | del | list', 'Reply to a sticker to make it run a command, e.g. stickcmd vv', (ctx) => {
    const arg = (ctx.args[0] || '').toLowerCase().replace(/^[^a-z0-9]+/, '');
    if (arg === 'list') return `Bound stickers: ${Object.keys(db.stickers).length}\n` + Object.values(db.stickers).map((c) => '› ' + c).join('\n');
    const st = ctx.msg && (ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage);
    if (!st) throw new Error(`Reply to a sticker: ${ctx.prefix}stickcmd vv\n${ctx.prefix}stickcmd del  (unbind)\n${ctx.prefix}stickcmd list`);
    const sha = Buffer.from(st.fileSha256 || []).toString('base64');
    if (arg === 'del') { delete db.stickers[sha]; save(); return '🗑️ Sticker unbound.'; }
    if (!arg) throw new Error(`Usage: ${ctx.prefix}stickcmd vv`);
    db.stickers[sha] = arg;
    save();
    return `✅ That sticker now runs *${ctx.prefix}${arg}*`;
  }, { owner: true, aliases: ['setcmd'] });

  add('alwaysonline', 'Owner', 'on|off', 'Keep the bot showing as online', (ctx) => {
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) return `Always online is *${db.alwaysOnline ? 'ON' : 'OFF'}*.\nUsage: ${ctx.prefix}alwaysonline on|off`;
    db.alwaysOnline = v === 'on';
    save();
    applyOnline(ctx.sock);
    return `✅ Always online turned *${v.toUpperCase()}*.`;
  }, { owner: true, aliases: ['online'] });
}

/* ---------- boot (index.js) ---------- */
function boot(sock) {
  applyOnline(sock);
  sock.ev.on('connection.update', ({ connection }) => { if (connection === 'open') applyOnline(sock); });
}

/* ---------- passive: moderation (index.js, every message) ---------- */
const meta = new Map();
async function groupMeta(sock, jid) {
  const h = meta.get(jid);
  if (h && Date.now() - h.t < 60000) return h.d;
  const d = await sock.groupMetadata(jid);
  meta.set(jid, { t: Date.now(), d });
  return d;
}
const unwrapContent = (m) => {
  let x = m.message || {};
  for (let i = 0; i < 4; i++) x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x;
  return x;
};
/** returns a command string like "vv" when a bound sticker is sent by the owner, else null */
function stickerCommand(m) {
  const st = unwrapContent(m).stickerMessage;
  if (!st) return null;
  return db.stickers[Buffer.from(st.fileSha256 || []).toString('base64')] || null;
}

async function passive(sock, m) {
  try {
    const jid = m?.key?.remoteJid;
    if (!jid?.endsWith('@g.us') || m.key.fromMe) return;
    const cfg = db.groups[jid];
    if (!cfg || (cfg.antiGroupMention === 'off' && cfg.antiTag === 'off')) return;
    const raw = m.message || {};
    const c = unwrapContent(m);
    if (process.env.DEBUG_EXTRA) console.log('[extra] group msg keys:', Object.keys(raw), 'inner:', Object.keys(c));
    const hasKey = (o, re, d = 0) => !!o && typeof o === 'object' && !ArrayBuffer.isView(o) && d < 4 && Object.keys(o).some((k) => re.test(k) || hasKey(o[k], re, d + 1));
    const proto = raw.protocolMessage || c.protocolMessage;
    const isGM = hasKey(raw, /^(groupStatusMentionMessage|groupMentionedMessage|statusMentionMessage)$/) || proto?.type === 25 || proto?.type === 'STATUS_MENTION_MESSAGE';
    const mentions = Object.values(c).map((v) => v?.contextInfo?.mentionedJid).find((a) => Array.isArray(a)) || [];
    const txt = c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';
    const isTag = mentions.length >= 5 || /(^|\s)@(everyone|all)\b/i.test(txt);
    const mode = isGM ? cfg.antiGroupMention : isTag ? cfg.antiTag : 'off';
    if (mode === 'off') return;
    const sender = m.key.participant || m.participant;
    const md = await groupMeta(sock, jid);
    const senderIds = [sender, m.key.participantAlt].filter(Boolean).map(num);
    const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(num);
    const isAdminOf = (ids) => md.participants.some((p) => p.admin && [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean).map(num).some((x) => ids.includes(x)));
    if (isAdminOf(senderIds)) return;
    if (!isAdminOf(botIds)) { console.log('[extra] bot is not admin in this group'); return; }
    await sock.sendMessage(jid, { delete: m.key }).catch(() => {});
    const why = isGM ? 'group mentions' : 'mass tagging';
    if (mode === 'kick') {
      await sock.groupParticipantsUpdate(jid, [sender], 'remove').catch(() => {});
      await sock.sendMessage(jid, { text: `🚫 @${num(sender)} removed for ${why}.`, mentions: [sender] });
    } else {
      await sock.sendMessage(jid, { text: `⚠️ @${num(sender)}, ${why} are not allowed here.`, mentions: [sender] });
    }
  } catch (e) { console.error('[extra]', e.message); }
}

module.exports = { register, boot, passive, stickerCommand };
