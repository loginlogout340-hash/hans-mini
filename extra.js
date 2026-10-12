'use strict';
/**
 * Hans-Mini extras: play, song, react, antigroupmention, antitag, stickcmd, alwaysonline, unlink
 * Deps: npm i yt-search   (downloads use yt-dlp + ffmpeg installed in the Dockerfile)
 *
 * MULTI-USER: every connected user has their own settings. They live on the socket
 * (sock.hm) and are saved in that user's own folder (extra.json).
 *
 * commands.js  (just above module.exports):   require('./extra').register(add);
 * bot.js       (after socket is created):     extra.boot(sock, userDir);
 *              (every message):               extra.passive(sock, m);
 *
 * Optional Railway variables for music:
 *   YT_COOKIES_FILE = path to a cookies.txt   (strongest fix for the "not a bot" block)
 *   YT_PROXY        = http://user:pass@host:port  (residential proxy, if you ever get one)
 *   MALVIN_API      = base link of the download API (no trailing slash)
 *   MALVIN_KEY      = its API key   -> when both are set, play/song/video use the API first
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const yts = require('yt-search');

const MAX_MB = 40;

/* ---------- download API (optional: MALVIN_API + MALVIN_KEY) ---------- */
const apiBase = () => (process.env.MALVIN_API || '').trim().replace(/\/+$/, '');
const apiOn = () => !!(apiBase() && process.env.MALVIN_KEY);
async function apiGet(route, params, timeoutMs = 30000) {
  const url = new URL(apiBase() + route);
  url.searchParams.set('apikey', process.env.MALVIN_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || j?.status === false) throw new Error(String(j?.error || j?.message || 'Download service returned HTTP ' + r.status).slice(0, 200));
  return j?.data;
}
async function fetchBuf(url, maxMb) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error('Download failed (HTTP ' + r.status + ').');
  if (Number(r.headers.get('content-length') || 0) > maxMb * 1048576) throw new Error(`File is larger than ${maxMb}MB.`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxMb * 1048576) throw new Error(`File is larger than ${maxMb}MB.`);
  if (buf.length < 10240) throw new Error('The downloaded file is too small. Try again.');
  return buf;
}
const YT_URL = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i;
// turns any audio into a normal mp3 with ffmpeg (falls back to the original if that fails)
function toMp3(buf) {
  const base = path.join(os.tmpdir(), 'hm-cv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  return new Promise((ok) => {
    try { fs.writeFileSync(base + '.in', buf); } catch { return ok(buf); }
    execFile('ffmpeg', ['-y', '-i', base + '.in', '-vn', '-acodec', 'libmp3lame', '-q:a', '5', base + '.mp3'], { timeout: 120000 }, (err) => {
      let out = buf;
      if (!err) { try { out = fs.readFileSync(base + '.mp3'); } catch { /* keep original */ } }
      for (const e of ['in', 'mp3']) fs.unlink(base + '.' + e, () => {});
      ok(out);
    });
  });
}
const num = (j = '') => String(j).split('@')[0].split(':')[0];

/* ---------- per-user store (kept on the socket, saved in the user's own folder) ---------- */
function newState(dir) {
  const file = dir ? path.join(dir, 'extra.json') : null;
  let db = { groups: {}, stickers: {}, alwaysOnline: false, warns: {} };
  if (file) { try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ } }
  let t;
  const save = () => {
    if (!file) return;
    clearTimeout(t);
    t = setTimeout(() => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); } catch { /* ignore */ } }, 500);
  };
  return { db, save, timer: null, meta: new Map() };
}
const hmOf = (sock) => sock.hm || (sock.hm = newState(null));
const grp = (db, jid) => (db.groups[jid] ||= { antiGroupMention: 'off', antiTag: 'off' });
const DEFAULT_WARN_LIMIT = 3;

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

// YouTube blocks datacenter IPs on some clients but not others, so we try several in turn.
const CLIENTS = ['tv', 'tv_simply', 'web_safari', 'mweb', 'android_vr', 'ios', 'web_embedded', 'default'];

async function audioOf(url) {
  const base = path.join(os.tmpdir(), 'hm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const common = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '--max-filesize', MAX_MB + 'M',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--js-runtimes', 'node',
    '--force-ipv4',
    '--extractor-retries', '2',
    '-o', base + '.%(ext)s',
  ];
  if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) common.push('--cookies', process.env.YT_COOKIES_FILE);
  if (process.env.YT_PROXY) common.push('--proxy', process.env.YT_PROXY);

  let lastErr;
  try {
    for (const client of CLIENTS) {
      const args = [...common];
      if (client !== 'default') args.push('--extractor-args', 'youtube:player_client=' + client);
      args.push(url);
      try {
        await run(args);
        const file = base + '.mp3';
        if (fs.existsSync(file)) {
          if (process.env.DEBUG_EXTRA) console.log('[extra] download ok with client', client);
          return fs.readFileSync(file);
        }
        lastErr = new Error('Download failed (no file produced).');
      } catch (e) {
        lastErr = e;
        if (process.env.DEBUG_EXTRA) console.log('[extra] client', client, 'failed:', e.message);
        // File too large is not a client problem, stop early
        if (/larger than max-filesize|File is larger/i.test(e.message)) throw new Error(`Song is larger than ${MAX_MB}MB.`);
      }
    }
    if (/sign in|not a bot|cookies/i.test(lastErr?.message || '')) {
      throw new Error('YouTube is blocking this server right now. Try again later or add a cookies file.');
    }
    throw lastErr || new Error('Download failed.');
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
  let buf;
  if (apiOn()) {
    try {
      const d = await apiGet('/download/clutchplay', { query: /^https?:\/\//i.test(q) ? v.title : q });
      if (d?.audio) buf = await fetchBuf(d.audio, MAX_MB);
    } catch (e) { console.error('[extra] download API failed, using yt-dlp:', e.message); }
  }
  if (!buf) buf = await audioOf(v.url);
  const quoted = { quoted: ctx.msg };
  if (asFile) {
    const name = v.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
    await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'audio/mpeg', fileName: name + '.mp3' }, quoted);
  } else {
    await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, quoted);
  }
}

/* ---------- always online ---------- */
function applyOnline(sock) {
  const hm = hmOf(sock);
  clearInterval(hm.timer);
  if (!hm.db.alwaysOnline) return;
  const ping = () => sock.sendPresenceUpdate('available').catch(() => {});
  ping();
  hm.timer = setInterval(ping, 25000);
}

/* ---------- commands ---------- */
function register(add) {
  require('./ui').register(add);
  require('./dl').register(add);
  add('play', 'Media', '<name or link>', 'Search YouTube and send the song as audio', (ctx) => music(ctx, false), { aliases: ['music'] });
  add('song', 'Media', '<name or link>', 'Search YouTube and send the song as a downloadable file', (ctx) => music(ctx, true), { aliases: ['mp3'] });

  add('video', 'Media', '<name or link>', 'Search YouTube and send the video', async (ctx) => {
    if (!apiOn()) throw new Error('Video download is not set up yet. Add MALVIN_API and MALVIN_KEY in the Railway variables.');
    const q = ctx.text || ctx.quoted?.text;
    if (!q) throw new Error(`Usage: ${ctx.prefix}video <name or YouTube link>`);
    let url = q;
    if (!YT_URL.test(q)) {
      const found = await apiGet('/download/clutchplay', { query: q });
      if (!found?.url) throw new Error('No video found for your query.');
      url = found.url;
    }
    const r = await apiGet('/download/clutchyt', { url, quality: '720' });
    if (!r?.video) throw new Error('Failed to fetch the video. Try again.');
    const buf = await fetchBuf(r.video, 100);
    const title = r.title || 'Video';
    const quoted = { quoted: ctx.msg };
    if (buf.length > 50 * 1048576) await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'video/mp4', fileName: title.replace(/[^\w\s.-]/g, '').slice(0, 80) + '.mp4', caption: '📄 ' + title }, quoted);
    else await ctx.sock.sendMessage(ctx.jid, { video: buf, mimetype: 'video/mp4', caption: '🎥 ' + title }, quoted);
  }, { aliases: ['ytmp4', 'mp4'] });

  add('sendaudio', 'Media', '<audio link>', 'Download audio from a direct link and send it', async (ctx) => {
    const u = (ctx.text || ctx.quoted?.text || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error(`Usage: ${ctx.prefix}sendaudio <audio link>`);
    const buf = await toMp3(await fetchBuf(u, MAX_MB));
    await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, { quoted: ctx.msg });
  }, { aliases: ['sendmp3', 'dlmp3', 'dlaudio'] });

  add('sendvideo', 'Media', '<video link>', 'Download a video from a direct link and send it as a file', async (ctx) => {
    const u = (ctx.text || ctx.quoted?.text || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error(`Usage: ${ctx.prefix}sendvideo <video link>`);
    const buf = await fetchBuf(u, 100);
    await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'video/mp4', fileName: 'Video.mp4' }, { quoted: ctx.msg });
  }, { aliases: ['sendmp4', 'dlmp4', 'dvideo'] });

  add('react', 'Fun', '<emoji>', 'Reply to a message with this command to react to it', async (ctx) => {
    const emoji = (ctx.text.match(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*/u) || [])[0];
    if (!emoji) throw new Error(`Usage: reply to a message with ${ctx.prefix}react 😂`);
    const key = ctx.quoted
      ? { remoteJid: ctx.jid, id: ctx.quoted.id, participant: ctx.quoted.participant, fromMe: !!ctx.quoted.fromBot }
      : ctx.msg.key;
    await ctx.sock.sendMessage(ctx.jid, { react: { text: emoji, key } });
  });

  const guard = (name, key, label, desc) =>
    add(name, 'Group', 'on|delete|warn|kick|off', desc, (ctx) => {
      const { db, save } = hmOf(ctx.sock);
      const v = (ctx.args[0] || '').toLowerCase();
      const cfg = grp(db, ctx.jid);
      if (!['on', 'delete', 'warn', 'kick', 'off'].includes(v)) return `${label}: *${cfg[key]}*\nUsage: ${ctx.prefix}${name} on|delete|warn|kick|off\n(delete = remove the message, warn = delete + warning, kick after the warn limit, kick = remove at once)`;
      cfg[key] = v === 'on' ? 'delete' : v;
      save();
      return `✅ ${label} is now *${cfg[key]}*`;
    }, { group: true, admin: true, botAdmin: true });
  guard('antigroupmention', 'antiGroupMention', 'Anti group mention', 'Delete, warn or kick for messages that mention the group in a status');
  guard('antitag', 'antiTag', 'Anti tag', 'Delete, warn or kick for mass tagging by non-admins');

  add('warnlimit', 'Group', '<number>', 'How many warnings before a member is kicked (default 3)', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = grp(db, ctx.jid);
    const n = parseInt(ctx.args[0], 10);
    if (!n) return `Warn limit: *${cfg.warnLimit || DEFAULT_WARN_LIMIT}*\nUsage: ${ctx.prefix}warnlimit 3`;
    if (n < 1 || n > 20) throw new Error('Choose a number from 1 to 20.');
    cfg.warnLimit = n;
    save();
    return `✅ Members are kicked after *${n}* warnings.`;
  }, { group: true, admin: true });

  add('stickcmd', 'Owner', '<command> | del | list', 'Reply to a sticker to make it run a command, e.g. stickcmd vv', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
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

  add('unlink', 'Owner', '', 'Disconnect this bot from your WhatsApp and delete your saved data', async (ctx) => {
    await ctx.reply('👋 Disconnecting this bot from your WhatsApp. Your saved data will be deleted. Open the pairing website to link again anytime.');
    setTimeout(() => { ctx.sock.logout().catch((e) => console.error('[unlink]', e.message)); }, 1500);
  }, { owner: true });

  add('alwaysonline', 'Owner', 'on|off', 'Keep the bot showing as online', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) return `Always online is *${db.alwaysOnline ? 'ON' : 'OFF'}*.\nUsage: ${ctx.prefix}alwaysonline on|off`;
    db.alwaysOnline = v === 'on';
    save();
    applyOnline(ctx.sock);
    return `✅ Always online turned *${v.toUpperCase()}*.`;
  }, { owner: true, aliases: ['online'] });
}

/* ---------- boot (index.js) ---------- */
function boot(sock, dir) {
  sock.hm = newState(dir);
  applyOnline(sock);
  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'open') applyOnline(sock);
    if (connection === 'close') clearInterval(sock.hm.timer);
  });
}

/* ---------- passive: moderation (index.js, every message) ---------- */
async function groupMeta(sock, jid) {
  const meta = hmOf(sock).meta;
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
function stickerCommand(sock, m) {
  const st = unwrapContent(m).stickerMessage;
  if (!st) return null;
  return hmOf(sock).db.stickers[Buffer.from(st.fileSha256 || []).toString('base64')] || null;
}

async function passive(sock, m) {
  try {
    const jid = m?.key?.remoteJid;
    if (!jid?.endsWith('@g.us') || m.key.fromMe) return;
    const { db, save } = hmOf(sock);
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
    const tagName = num(sender);
    if (isAdminOf(senderIds)) {
      if (isGM) await sock.sendMessage(jid, { text: `Admin @${tagName} dropped a status mention. Admins get a pass, but keep it minimal.`, mentions: [sender] });
      return;
    }
    if (!isAdminOf(botIds)) {
      console.log('[extra] bot is not admin in this group');
      if (isGM) await sock.sendMessage(jid, { text: `@${tagName} sent a status mention. Make me admin so I can act on it.`, mentions: [sender] });
      return;
    }
    await sock.sendMessage(jid, { delete: m.key }).catch(() => {});
    const why = isGM ? 'group mentions' : 'mass tagging';
    if (mode === 'kick') {
      await sock.groupParticipantsUpdate(jid, [sender], 'remove').catch(() => {});
      await sock.sendMessage(jid, { text: `🚫 @${num(sender)} removed for ${why}.`, mentions: [sender] });
    } else if (mode === 'warn') {
      const limit = cfg.warnLimit || DEFAULT_WARN_LIMIT;
      const w = (db.warns[jid] ||= {});
      const n = (w[tagName] = (w[tagName] || 0) + 1);
      if (n >= limit) {
        delete w[tagName];
        save();
        await sock.groupParticipantsUpdate(jid, [sender], 'remove').catch(() => {});
        await sock.sendMessage(jid, { text: `🚨 @${tagName} removed.\nReason: ${why}\nWarns: ${n}/${limit}`, mentions: [sender] });
      } else {
        save();
        await sock.sendMessage(jid, { text: `⚠️ @${tagName}, warned for ${why}!\nMessage deleted.\nWarns: ${n}/${limit}. ${limit - n} more and you are removed.`, mentions: [sender] });
      }
    } else {
      await sock.sendMessage(jid, { text: `⚠️ @${tagName}, ${why} are not allowed here.`, mentions: [sender] });
    }
  } catch (e) { console.error('[extra]', e.message); }
}

module.exports = { register, boot, passive, stickerCommand, apiOn, apiBase, apiGet, fetchBuf, toMp3, MAX_MB };
