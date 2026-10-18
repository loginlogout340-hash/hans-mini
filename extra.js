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
 *   MALVIN_KEY_2, MALVIN_KEY_3 ... = more keys (or put several in MALVIN_KEY separated by commas):
 *                     when one key reaches its daily limit the next one is used automatically
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const heavy = require('./limit').run; // limits how many ffmpeg / yt-dlp jobs run at once
const yts = require('yt-search');

const MAX_MB = 40;

/* ---------- download API (optional: MALVIN_API + MALVIN_KEY) ---------- */
// forgiving: a missing https://, quotes or spaces around the value no longer cause "Invalid URL"
const apiBase = () => {
  let v = String(process.env.MALVIN_API || '').trim().replace(/^["']+|["']+$/g, '').trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
};
// every key you added: MALVIN_KEY, MALVIN_KEY_2 ... MALVIN_KEY_9, MALVIN_KEYS (several keys can be comma separated)
const apiKeyList = () => {
  const raw = [process.env.MALVIN_KEY, process.env.MALVIN_KEYS];
  for (let i = 2; i <= 9; i++) raw.push(process.env['MALVIN_KEY_' + i]);
  return [...new Set(raw.flatMap((k) => String(k || '').split(',')).map((k) => k.trim()).filter(Boolean))];
};
const apiOn = () => !!(apiBase() && apiKeyList().length);
// a key that said "daily limit reached" is skipped for the rest of that UTC day (it is tried again if every key is used up)
const spentKeys = new Map();
const utcDay = () => new Date().toISOString().slice(0, 10);
async function withKey(call) {
  const keys = apiKeyList();
  const fresh = keys.filter((k) => spentKeys.get(k) !== utcDay());
  let lastErr;
  for (const k of fresh.length ? fresh : keys) {
    try { return await call(k); } catch (e) {
      lastErr = e;
      if (/limit|quota|too many requests/i.test(String(e.message))) { spentKeys.set(k, utcDay()); continue; }
      throw e;
    }
  }
  throw lastErr || new Error('No download key is set.');
}
async function apiGet(route, params, timeoutMs = 30000) {
  return withKey((key) => apiGetKey(key, route, params, timeoutMs));
}
async function apiGetKey(key, route, params, timeoutMs) {
  const once = async (p) => {
    const url = new URL(apiBase() + p);
    url.searchParams.set('apikey', key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) {
      const why = e.cause?.code || e.cause?.message || e.name || 'network error';
      const hint = /ENOTFOUND|EAI_AGAIN/.test(why) ? 'that address does not exist, check MALVIN_API' : /ECONNREFUSED/.test(why) ? 'the service refused the connection' : /Timeout|ETIMEDOUT/.test(why) ? 'the service did not answer in time' : 'could not reach the service';
      throw new Error('cannot reach ' + url.host + ' (' + why + '): ' + hint);
    }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || j?.status === false) {
      const e = new Error(String(j?.error || j?.message || 'Download service returned HTTP ' + r.status + ' for ' + p).slice(0, 200));
      e.status = r.status;
      throw e;
    }
    return j?.data;
  };
  try {
    return await once(route);
  } catch (e) {
    // some of these APIs keep their paths under /api; if the plain path does not exist, try that one
    if (e.status === 404 && !route.startsWith('/api/')) {
      try { return await once('/api' + route); } catch (e2) { if (e2.status !== 404) throw e2; }
    }
    throw e;
  }
}
// pulls the download link out of whatever shape the API answers with
const linkOf = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return /^https?:\/\//i.test(d) ? d : null;
  for (const k of ['download_url', 'downloadUrl', 'url', 'audio', 'link', 'mp3']) {
    if (typeof d[k] === 'string' && /^https?:\/\//i.test(d[k])) return d[k];
  }
  return null;
};
// Malvin API: /api/download/savenow takes ?url=<youtube link>&format=mp3 (audio) or 144..4k (video).
// The other two general downloaders are tried if savenow fails.
// Malvin API (same call the official MALVIN-XD bot uses for .play): /api/download/clutchplay?query=<name>
// searches by name and returns a ready mp3 link in data.audio (plus title and url).
async function apiClutchPlay(query) {
  const d = await apiGet('/api/download/clutchplay', { query: String(query).slice(0, 150) }, 45000);
  const link = (d && typeof d.audio === 'string' && /^https?:\/\//i.test(d.audio)) ? d.audio : linkOf(d);
  if (!link) throw new Error('clutchplay: no link in the answer');
  return { link, title: d && d.title };
}
async function apiMedia(ytUrl, format) {
  const errs = [];
  for (const route of ['/api/download/savenow']) {
    try {
      const d = await apiGet(route, { url: ytUrl, format }, 70000);
      const link = linkOf(d);
      if (link) return { link, title: d && d.title };
      errs.push(route.split('/').pop() + ': no link in the answer');
    } catch (e) { errs.push(route.split('/').pop() + ': ' + e.message); }
  }
  throw new Error(errs.join(' | ').slice(0, 300));
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
    heavy('ffmpeg', ['-y', '-i', base + '.in', '-vn', '-acodec', 'libmp3lame', '-q:a', '5', base + '.mp3'], { timeout: 120000 }, (err) => {
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
    t = setTimeout(() => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch { /* ignore */ } }, 500);
  };
  return { db, save, timer: null, meta: new Map(), owner: dir ? path.basename(dir) : '', games: { guess: {}, trivia: {} } };
}
const hmOf = (sock) => sock.hm || (sock.hm = newState(null));
const grp = (db, jid) => (db.groups[jid] ||= { antiGroupMention: 'off', antiTag: 'off', antiSticker: 'off' });
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
    heavy('yt-dlp', args, { timeout: 180000, maxBuffer: 1 << 24 }, (err, out, errout) => {
      if (err) return no(new Error(String(errout || err.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 250)));
      ok(out);
    });
  });
}

// YouTube blocks datacenter IPs on some clients but not others, so we try several in turn.
const CLIENTS = ['tv', 'tv_simply', 'web_safari', 'mweb', 'android_vr', 'ios', 'web_embedded', 'default'];

// yt-dlp is downloaded when the Docker image is built, and Railway can reuse an OLD copy of that step.
// So it is updated in the background at start-up, and again (at most every 10 minutes) if downloads fail.
let lastUpdate = 0;
function updateYtdlp(force) {
  if (Date.now() - lastUpdate < (force ? 10 * 60 * 1000 : 6 * 3600 * 1000)) return Promise.resolve();
  lastUpdate = Date.now();
  const say = (tag, out, errout, err) => String(out || errout || (err && err.message) || '').trim().split('\n').pop().slice(0, 160);
  return new Promise((ok) => {
    // the "nightly" build gets YouTube fixes first; if that is not possible, fall back to the normal update
    execFile('yt-dlp', ['--update-to', 'nightly'], { timeout: 120000 }, (err, out, errout) => {
      if (err) {
        console.log('[extra] yt-dlp nightly update failed (' + say('n', out, errout, err) + '), trying normal update');
        return execFile('yt-dlp', ['-U'], { timeout: 120000 }, (e2, o2, er2) => {
          console.log('[extra] yt-dlp update:', say('u', o2, er2, e2));
          execFile('yt-dlp', ['--version'], { timeout: 15000 }, (e3, o3) => { console.log('[extra] yt-dlp version:', String(o3 || '').trim()); ok(); });
        });
      }
      console.log('[extra] yt-dlp update:', say('n', out, errout, err));
      execFile('yt-dlp', ['--version'], { timeout: 15000 }, (e3, o3) => { console.log('[extra] yt-dlp version:', String(o3 || '').trim()); ok(); });
    });
  });
}
updateYtdlp(true).catch(() => {});

// cookies: a file path (YT_COOKIES_FILE) or the cookies text itself in a Railway variable (YT_COOKIES)
function cookiesFile() {
  if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) return process.env.YT_COOKIES_FILE;
  if (process.env.YT_COOKIES) {
    const f = path.join(os.tmpdir(), 'hm-yt-cookies.txt');
    try { fs.writeFileSync(f, process.env.YT_COOKIES.replace(/\\n/g, '\n')); return f; } catch { /* ignore */ }
  }
  return null;
}

function runYt(args, timeoutMs) {
  return new Promise((ok, no) => {
    heavy('yt-dlp', args, { timeout: timeoutMs, maxBuffer: 1 << 24 }, (err, out, errout) => {
      if (err) return no(new Error(String(errout || err.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 250)));
      ok(out);
    });
  });
}

async function audioOf(url, retried) {
  const base = path.join(os.tmpdir(), 'hm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  let jsRuntime = true; // dropped automatically if this yt-dlp is too old to know the option
  const build = (client) => {
    const a = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '--max-filesize', MAX_MB + 'M',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '5',
      '--force-ipv4',
      '--extractor-retries', '2',
      '-o', base + '.%(ext)s',
    ];
    if (jsRuntime) a.push('--js-runtimes', 'node');
    const ck = cookiesFile();
    if (ck) a.push('--cookies', ck);
    if (process.env.YT_PROXY) a.push('--proxy', process.env.YT_PROXY);
    if (client !== 'default') a.push('--extractor-args', 'youtube:player_client=' + client);
    a.push(url);
    return a;
  };

  const deadline = Date.now() + 150000; // never spend more than ~2.5 minutes on one song
  let lastErr;
  try {
    for (const client of CLIENTS) {
      if (Date.now() > deadline) break;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await runYt(build(client), 60000);
          const file = base + '.mp3';
          if (fs.existsSync(file)) {
            if (process.env.DEBUG_EXTRA) console.log('[extra] download ok with client', client);
            return fs.readFileSync(file);
          }
          lastErr = new Error('Download failed (no file produced).');
          break;
        } catch (e) {
          lastErr = e;
          if (process.env.DEBUG_EXTRA) console.log('[extra] client', client, 'failed:', e.message);
          if (jsRuntime && /no such option|unrecognized arguments/i.test(e.message)) { jsRuntime = false; continue; } // old yt-dlp: retry without that option
          if (/larger than max-filesize|File is larger/i.test(e.message)) throw new Error(`Song is larger than ${MAX_MB}MB.`);
          break;
        }
      }
    }
  } finally {
    for (const ext of ['mp3', 'webm', 'm4a', 'opus', 'part']) fs.unlink(base + '.' + ext, () => {});
  }
  // everything failed: update yt-dlp once and try again
  if (!retried && Date.now() - lastUpdate > 10 * 60 * 1000) {
    await updateYtdlp(true);
    return audioOf(url, true);
  }
  const msg = lastErr?.message || '';
  if (/sign in|not a bot|cookies|confirm you|needs to be reloaded/i.test(msg)) {
    throw new Error('YouTube is rejecting this server (' + msg.replace(/^ERROR: \[youtube\] \S+: /, '').slice(0, 80) + '). Fix the download API address or add cookies (Railway variable YT_COOKIES).');
  }
  throw new Error(msg || 'Download failed.');
}

async function music(ctx, asFile) {
  const q = ctx.text || ctx.quoted?.text;
  if (!q) throw new Error(`Usage: ${ctx.prefix}${asFile ? 'song' : 'play'} <name or YouTube link>`);
  const v = await findVideo(q);
  if (!v) throw new Error('No results found.');
  const card = `🎵 *${v.title}*\n👤 ${v.author?.name || '-'}\n⏱ ${v.timestamp || '-'}\n🔗 ${v.url}`;
  if (v.thumbnail) await ctx.sendImage(v.thumbnail, card); else await ctx.reply(card);

  let buf;
  const problems = [];

  // 1) the Malvin download API (if MALVIN_API + MALVIN_KEY are set)
  if (apiOn()) {
    try {
      let m;
      try { m = await apiClutchPlay(v.title + ' ' + (v.author?.name || '')); }
      catch (e1) { console.error('[extra] clutchplay failed:', e1.message); problems.push('clutchplay: ' + e1.message); m = await apiMedia(v.url, 'mp3'); }
      buf = await fetchBuf(m.link, MAX_MB);
    } catch (e) {
      console.error('[extra] download API failed:', e.message);
      problems.push('Download API: ' + e.message);
    }
  } else {
    problems.push('Download API: not set (add MALVIN_API and MALVIN_KEY in Railway)');
  }

  // 2) yt-dlp straight from YouTube
  if (!buf) {
    try { buf = await audioOf(v.url); }
    catch (e) { problems.push('YouTube: ' + e.message); }
  }

  if (!buf) throw new Error('Could not get that song.\n' + problems.map((p) => '- ' + p).join('\n'));

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
  require('./more').register(add, { hmOf, grp });
  require('./admin').register(add);
  add('play', 'Media', '<name or link>', 'Search YouTube and send the song as audio', (ctx) => music(ctx, false), { aliases: ['music'] });
  add('song', 'Media', '<name or link>', 'Search YouTube and send the song as a downloadable file', (ctx) => music(ctx, true), { aliases: ['mp3'] });

  add('video', 'Media', '<name or link>', 'Search YouTube and send the video', async (ctx) => {
    if (!apiOn()) throw new Error('Video download is not set up yet. Add MALVIN_API and MALVIN_KEY in the Railway variables.');
    const q = ctx.text || ctx.quoted?.text;
    if (!q) throw new Error(`Usage: ${ctx.prefix}video <name or YouTube link>`);
    let url = q, title = 'Video';
    if (!YT_URL.test(q)) {
      const found = await findVideo(q);
      if (!found) throw new Error('No results found.');
      url = found.url; title = found.title;
    }
    let buf, last;
    for (const fmt of ['720', '360']) { // smaller quality if the file is too big
      try {
        const m = await apiMedia(url, fmt);
        if (m.title) title = m.title;
        buf = await fetchBuf(m.link, 100);
        break;
      } catch (e) { last = e; if (!/larger than/i.test(e.message)) break; }
    }
    if (!buf) throw new Error('Could not get that video. ' + (last ? last.message : ''));
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

  // FIXED react: reply to a message with  .react 😂   (use  .react off  to remove your reaction).
  // The key is built the way WhatsApp expects: "participant" is only added in groups, and only
  // for messages sent by other people.
  add('react', 'Fun', '<emoji>', 'Reply to a message with this command to react to it (use "off" to remove)', async (ctx) => {
    const wantsOff = (ctx.args[0] || '').toLowerCase() === 'off';
    let emoji = '';
    if (!wantsOff) {
      emoji = (ctx.text.match(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*/u) || [])[0];
      if (!emoji) throw new Error(`Usage: reply to a message with ${ctx.prefix}react 😂`);
    }
    const key = ctx.quoted
      ? {
          remoteJid: ctx.jid,
          id: ctx.quoted.id,
          fromMe: !!ctx.quoted.fromBot,
          ...(ctx.isGroup && !ctx.quoted.fromBot && ctx.quoted.participant ? { participant: ctx.quoted.participant } : {}),
        }
      : ctx.msg.key; // no reply: react to the command message itself
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
  guard('antisticker', 'antiSticker', 'Anti sticker', 'Delete, warn or kick for stickers sent by non-admins');

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
    if (!ctx.isMainOwner) throw new Error('Only the real owner can unlink this bot.');
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
  require('./more').boot(sock, { hmOf });
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
  require('./more').passive(sock, m); // anti link
  try {
    const jid = m?.key?.remoteJid;
    if (!jid?.endsWith('@g.us') || m.key.fromMe) return;
    const { db, save } = hmOf(sock);
    const cfg = db.groups[jid];
    if (!cfg || (cfg.antiGroupMention === 'off' && cfg.antiTag === 'off' && (cfg.antiSticker || 'off') === 'off')) return;
    const raw = m.message || {};
    const c = unwrapContent(m);
    if (process.env.DEBUG_EXTRA) console.log('[extra] group msg keys:', Object.keys(raw), 'inner:', Object.keys(c));
    const hasKey = (o, re, d = 0) => !!o && typeof o === 'object' && !ArrayBuffer.isView(o) && d < 4 && Object.keys(o).some((k) => re.test(k) || hasKey(o[k], re, d + 1));
    const proto = raw.protocolMessage || c.protocolMessage;
    const isGM = hasKey(raw, /^(groupStatusMentionMessage|groupMentionedMessage|statusMentionMessage)$/) || proto?.type === 25 || proto?.type === 'STATUS_MENTION_MESSAGE';
    const mentions = Object.values(c).map((v) => v?.contextInfo?.mentionedJid).find((a) => Array.isArray(a)) || [];
    const txt = c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';
    const isTag = mentions.length >= 5 || /(^|\s)@(everyone|all)\b/i.test(txt);
    const isSticker = !isGM && !isTag && !!c.stickerMessage;
    const mode = isGM ? cfg.antiGroupMention : isTag ? cfg.antiTag : isSticker ? (cfg.antiSticker || 'off') : 'off';
    if (mode === 'off') return;
    const sender = m.key.participant || m.participant;
    const md = await groupMeta(sock, jid);
    const senderIds = [sender, m.key.participantAlt].filter(Boolean).map(num);
    const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(num);
    const isAdminOf = (ids) => md.participants.some((p) => p.admin && [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean).map(num).some((x) => ids.includes(x)));
    const tagName = num(sender);
    if (isSticker) { const ok = [hmOf(sock).owner, ...(db.sudo || [])]; if (senderIds.some((x) => ok.includes(x))) return; } // the owner and sudo users may send stickers
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
    const why = isGM ? 'group mentions' : isSticker ? 'stickers' : 'mass tagging';
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

module.exports = { register, boot, passive, stickerCommand, apiOn, apiBase, apiGet, withKey, apiMedia, findVideo, fetchBuf, toMp3, MAX_MB };
