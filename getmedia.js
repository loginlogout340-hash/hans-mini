'use strict';
/**
 * Videos and pictures from links WITHOUT any key or variable.
 *
 * It upgrades these existing commands (more7.js calls install() once when the bot starts):
 *   .video  .yt  .tiktok  .ig  .fb  .twitter2  .threads  .pinterest
 * Each one now works like this:
 *   1) if you ever set MALVIN_API + MALVIN_KEY, the old method goes first (nothing changes for you)
 *   2) then the free sources for that site, one after another (dedicated free APIs, the post's own web page, yt-dlp,
 *      and free community download services)
 *   3) the first source that gives a real video or picture wins; a source that is down is skipped for 10 minutes
 *
 * Pictures work too: Instagram photos and carousels, Pinterest pins, TikTok slideshows, X (Twitter) photos.
 * Add "audio" after the link to get only the sound (.tiktok <link> audio), or a quality (.yt <link> 720).
 *
 * Free services come and go. Every source is one entry in SOURCES / COMMUNITY below, so a dead one is easy to swap.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const heavy = require('./limit').run; // limits how many yt-dlp / ffmpeg jobs run at once

const MAX_MB = 64; // biggest file the bot will download (protects the server memory)
const MAX = MAX_MB * 1048576;
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);

/* ------------------------------ small helpers ------------------------------ */
async function getText(url, ms = 15000, init = {}) {
  const r = await fetch(url, { redirect: 'follow', ...init, headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...(init.headers || {}) }, signal: AbortSignal.timeout(ms) });
  if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function getJson(url, ms = 15000) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('HTTP ' + r.status);
  return j;
}

const isVid = (u) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u);
const isImg = (u) => /\.(jpe?g|png|webp)(\?|$)/i.test(u);

// every link inside a JSON answer, with the path of the field it was found in
function allUrls(o, key = '', out = [], depth = 0) {
  if (depth > 6 || out.length > 300) return out;
  if (typeof o === 'string') { if (/^https?:\/\//i.test(o)) out.push({ key, url: o }); }
  else if (Array.isArray(o)) o.forEach((v) => allUrls(v, key, out, depth + 1));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) allUrls(v, key ? key + '.' + k : k, out, depth + 1);
  return out;
}
const BAD_KEY = /(thumb|cover|avatar|profile|icon|poster|logo|preview|music|audio|sound|author|user)/i;
const PAGE = /(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|pinterest\.|threads\.)\//i;
function pickTitle(j, depth = 0) {
  if (!j || typeof j !== 'object' || depth > 4) return '';
  for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && /^(title|caption|desc|description|text)$/i.test(k) && v.trim()) return v.trim().slice(0, 150);
  for (const v of Object.values(j)) { const t = pickTitle(v, depth + 1); if (t) return t; }
  return '';
}
// turns whatever a download service answers into { videos: [...], images: [...] }
function mediaFromJson(j) {
  const videos = [], images = [], maybe = [];
  for (const { key, url } of allUrls(j)) {
    if (BAD_KEY.test(key)) continue;
    if (isVid(url)) videos.push(url);
    else if (isImg(url)) images.push(url);
    else if (!PAGE.test(url) && /(video|hd|sd|play|download|dl|mp4|link|url|media)/i.test(key)) maybe.push(url);
  }
  const uniq = (a) => [...new Set(a)];
  return { videos: uniq([...videos, ...maybe]), images: uniq(images), title: pickTitle(j) };
}

// tells what a downloaded file really is by its first bytes
function sniff(b) {
  if (!b || b.length < 12) return 'other';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'image';
  if (b.toString('latin1', 4, 8) === 'ftyp') return b.toString('latin1', 8, 11) === 'M4A' ? 'audio' : 'video';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video'; // webm / mkv
  return 'other';
}

async function fetchMedia(url, ms = 45000) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('file HTTP ' + r.status);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|json/.test(ct)) throw new Error('not a media file');
  if (Number(r.headers.get('content-length') || 0) > MAX) throw new Error(`larger than ${MAX_MB}MB`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX) throw new Error(`larger than ${MAX_MB}MB`);
  const kind = sniff(buf);
  if (kind === 'other' || kind === 'audio') throw new Error('not a picture or video');
  return { buf, kind };
}

// webm / mkv do not play as a WhatsApp video, so they are converted to mp4
function toMp4(buf) {
  const base = path.join(os.tmpdir(), 'hm-mp4-' + rnd());
  return new Promise((ok) => {
    try { fs.writeFileSync(base + '.in', buf); } catch { return ok(buf); }
    heavy('ffmpeg', ['-y', '-i', base + '.in', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-movflags', '+faststart', base + '.mp4'], { timeout: 170000 }, (err) => {
      let out = buf;
      if (!err) { try { out = fs.readFileSync(base + '.mp4'); } catch { /* keep the original */ } }
      for (const e of ['in', 'mp4']) fs.unlink(base + '.' + e, () => {});
      ok(out);
    });
  });
}

/* ------------------------------ the sources ------------------------------ */
// TikTok: tikwm allows 1 request per second, so calls are spaced out
let tikNext = 0;
async function tikGate() {
  const now = Date.now();
  const wait = Math.max(0, tikNext - now);
  tikNext = Math.max(now, tikNext) + 1200;
  if (wait) await sleep(wait);
}
async function tikwm(link) {
  const abs = (u) => (!u ? null : u.startsWith('/') ? 'https://www.tikwm.com' + u : u);
  for (let i = 0; i < 3; i++) {
    await tikGate();
    const j = await getJson('https://www.tikwm.com/api/?hd=1&url=' + enc(link), 20000);
    if (j.code === 0 && j.data) {
      const d = j.data;
      const by = d.author?.nickname || d.author?.unique_id;
      return {
        videos: [abs(d.hdplay), abs(d.play)].filter(Boolean),
        images: (d.images || []).map(abs).filter(Boolean),
        title: [d.title, by ? '👤 ' + by : ''].filter(Boolean).join('\n').slice(0, 200),
      };
    }
    if (!/limit/i.test(String(j.msg))) throw new Error(String(j.msg || 'no data').slice(0, 80));
  }
  throw new Error('rate limited');
}

// X / Twitter: fxtwitter and vxtwitter give the media links of a post
const tweetParts = (link) => (link.match(/(?:twitter|x)\.com\/([^/?#]+)\/status\/(\d+)/i) || []).slice(1, 3);
async function fxtwitter(link) {
  const [user, id] = tweetParts(link);
  if (!id) throw new Error('not a tweet link');
  const j = await getJson(`https://api.fxtwitter.com/${user}/status/${id}`);
  const t = j.tweet;
  if (!t) throw new Error(String(j.message || 'tweet not found').slice(0, 80));
  const m = t.media || {};
  return {
    videos: (m.videos || m.all?.filter((x) => x.type === 'video' || x.type === 'gif') || []).map((x) => x.url).filter(Boolean),
    images: (m.photos || m.all?.filter((x) => x.type === 'photo') || []).map((x) => x.url).filter(Boolean),
    title: String(t.text || '').slice(0, 150),
  };
}
async function vxtwitter(link) {
  const [user, id] = tweetParts(link);
  if (!id) throw new Error('not a tweet link');
  const j = await getJson(`https://api.vxtwitter.com/${user}/status/${id}`);
  const list = j.media_extended || [];
  return {
    videos: list.filter((x) => x.type === 'video' || x.type === 'gif').map((x) => x.url),
    images: list.filter((x) => x.type === 'image').map((x) => x.url),
    title: String(j.text || '').slice(0, 150),
  };
}

// Instagram: the public "embed" page of a post holds the media links
async function instaEmbed(link) {
  const code = (link.match(/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/) || [])[1];
  if (!code) throw new Error('no post code in the link');
  const html = await getText(`https://www.instagram.com/p/${code}/embed/captioned/`);
  const un = (s) => s.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const videos = [...html.matchAll(/"video_url"\s*:\s*"([^"]+)"/g)].map((m) => un(m[1]));
  const images = [...html.matchAll(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/g)].map((m) => un(m[1]));
  for (const m of html.matchAll(/"display_url"\s*:\s*"([^"]+)"/g)) images.push(un(m[1]));
  if (!videos.length && !images.length) throw new Error('nothing public found');
  return { videos, images, title: '' };
}

// Pinterest: the pin's own web page
async function pinPage(link) {
  const html = await getText(link, 15000);
  const un = (s) => s.replace(/&amp;/g, '&').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  const meta = (p) => (html.match(new RegExp('<meta[^>]+(?:property|name)="' + p + '"[^>]+content="([^"]+)"', 'i')) || [])[1];
  const videos = [...html.matchAll(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/g)].map((m) => un(m[1]));
  const ogv = meta('og:video');
  if (ogv) videos.push(un(ogv));
  const img = meta('og:image');
  const images = img ? [un(img).replace(/\/\d+x(\d+)?\//, '/originals/')] : [];
  if (!videos.length && !images.length) throw new Error('nothing found on the page');
  return { videos, images, title: un(meta('og:title') || '').slice(0, 120) };
}

// yt-dlp: works for most sites when the server is not blocked (TikTok, Facebook, Pinterest, X, Threads ...)
function ytdlpRun(args) {
  return new Promise((ok, no) => {
    heavy('yt-dlp', args, { timeout: 150000, maxBuffer: 1 << 24 }, (err, out, errout) => {
      if (err) return no(new Error(String(errout || err.message).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)));
      ok(out);
    });
  });
}
async function ytdlp(link, o) {
  const base = path.join(os.tmpdir(), 'hm-vd-' + rnd());
  const h = o.height || 720;
  const build = (withJs) => {
    const a = ['--no-playlist', '--no-warnings', '--no-progress', '--max-filesize', MAX_MB + 'M', '--force-ipv4',
      '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4', '-o', base + '.%(ext)s'];
    if (o.youtube) { if (withJs) a.push('--js-runtimes', 'node'); a.push('--extractor-args', 'youtube:player_client=tv,android_vr,web_safari,mweb'); }
    a.push(link);
    return a;
  };
  try {
    try { await ytdlpRun(build(true)); }
    catch (e) { if (/no such option|unrecognized arguments/i.test(e.message)) await ytdlpRun(build(false)); else throw e; }
    const file = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith(path.basename(base) + '.') && !f.endsWith('.part'));
    if (!file) throw new Error('no file produced');
    const buf = fs.readFileSync(path.join(os.tmpdir(), file));
    return { buf, kind: sniff(buf), title: '' };
  } finally {
    try { for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(path.basename(base) + '.')) fs.unlink(path.join(os.tmpdir(), f), () => {}); } catch { /* ignore */ }
  }
}

// free community download services (their JSON is read with mediaFromJson, whatever the exact shape is)
const COMMUNITY = {
  youtube: [
    ['siputzx', 'https://api.siputzx.my.id/api/d/ytmp4?url={u}'],
    ['vreden', 'https://api.vreden.my.id/api/v1/download/youtube/video?quality={q}&url={u}'],
    ['nekolabs', 'https://api.nekolabs.web.id/downloader/youtube/v1?format={q}&url={u}'],
    ['davidcyril', 'https://apis.davidcyriltech.my.id/youtube/mp4?url={u}'],
    ['agatz', 'https://api.agatz.xyz/api/ytmp4?url={u}'],
  ],
  instagram: [
    ['siputzx', 'https://api.siputzx.my.id/api/d/igdl?url={u}'],
    ['vreden', 'https://api.vreden.my.id/api/v1/download/instagram?url={u}'],
    ['davidcyril', 'https://apis.davidcyriltech.my.id/instagram?url={u}'],
    ['agatz', 'https://api.agatz.xyz/api/instagram?url={u}'],
  ],
  facebook: [
    ['siputzx', 'https://api.siputzx.my.id/api/d/facebook?url={u}'],
    ['vreden', 'https://api.vreden.my.id/api/v1/download/facebook?url={u}'],
    ['davidcyril', 'https://apis.davidcyriltech.my.id/facebook?url={u}'],
    ['agatz', 'https://api.agatz.xyz/api/facebook?url={u}'],
  ],
  tiktok: [
    ['siputzx', 'https://api.siputzx.my.id/api/d/tiktok?url={u}'],
    ['vreden', 'https://api.vreden.my.id/api/v1/download/tiktok?url={u}'],
    ['davidcyril', 'https://apis.davidcyriltech.my.id/tiktok?url={u}'],
  ],
  twitter: [
    ['siputzx', 'https://api.siputzx.my.id/api/d/twitter?url={u}'],
    ['vreden', 'https://api.vreden.my.id/api/v1/download/twitter?url={u}'],
    ['davidcyril', 'https://apis.davidcyriltech.my.id/twitter?url={u}'],
  ],
  pinterest: [
    ['vreden', 'https://api.vreden.my.id/api/v1/download/pinterest?url={u}'],
    ['siputzx', 'https://api.siputzx.my.id/api/d/pinterest?url={u}'],
  ],
  threads: [
    ['vreden', 'https://api.vreden.my.id/api/v1/download/threads?url={u}'],
  ],
};
const community = (platform) => (COMMUNITY[platform] || []).map(([name, tpl]) => ({
  name,
  run: async (link, o) => mediaFromJson(await getJson(tpl.replace('{u}', enc(link)).replace('{q}', String(o.height || 360)))),
}));

const SRC = (name, run) => ({ name, run });
const SOURCES = {
  tiktok: [SRC('tikwm', tikwm), SRC('yt-dlp', ytdlp), ...community('tiktok')],
  twitter: [SRC('fxtwitter', fxtwitter), SRC('vxtwitter', vxtwitter), SRC('yt-dlp', ytdlp), ...community('twitter')],
  instagram: [SRC('embed page', instaEmbed), ...community('instagram'), SRC('yt-dlp', ytdlp)],
  facebook: [SRC('yt-dlp', ytdlp), ...community('facebook')],
  pinterest: [SRC('pin page', pinPage), SRC('yt-dlp', ytdlp), ...community('pinterest')],
  threads: [SRC('yt-dlp', ytdlp), ...community('threads')],
  youtube: [...community('youtube'), SRC('yt-dlp', (l, o) => ytdlp(l, { ...o, youtube: true }))],
};

const PLATFORMS = [
  ['tiktok', /(?:tiktok\.com|vm\.tiktok|vt\.tiktok)/i],
  ['instagram', /(?:instagram\.com|instagr\.am)/i],
  ['facebook', /(?:facebook\.com|fb\.watch|fb\.com)/i],
  ['twitter', /(?:twitter|x)\.com\/[^/?#]+\/status\/\d+/i],
  ['pinterest', /(?:pinterest\.[a-z.]+\/pin\/|pin\.it\/)/i],
  ['threads', /threads\.(?:net|com)\//i],
  ['youtube', /(?:youtube\.com|youtu\.be)/i],
];
const detect = (link) => (PLATFORMS.find(([, re]) => re.test(link)) || [])[0] || null;

/* ------------------------------ finding the media ------------------------------ */
const dead = new Map(); // "platform:source" -> skipped until this time
const isDown = (e) => /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Timeout|aborted|fetch failed|HTTP (5\d\d|403|429)/i.test(String(e.cause?.code || '') + ' ' + e.message);

// a source answered: download what it points to and check that it is really a picture or a video
async function realize(r) {
  if (r.buf) return { kind: r.kind, buf: r.buf, title: r.title };
  let lastErr = '';
  const pics = [];
  for (const u of (r.videos || []).slice(0, 4)) {
    try {
      const g = await fetchMedia(u);
      if (g.kind === 'video') return { kind: 'video', buf: g.buf, title: r.title };
      pics.push(g.buf); // a "video" link that was really a picture
    } catch (e) { lastErr = e.message; }
  }
  for (const u of (r.images || []).slice(0, 10)) {
    try { const g = await fetchMedia(u); if (g.kind === 'image') pics.push(g.buf); } catch (e) { lastErr = e.message; }
  }
  if (pics.length) return { kind: 'images', bufs: pics, title: r.title };
  throw new Error(lastErr || 'no media found');
}

async function getMedia(link, o = {}) {
  const platform = detect(link);
  if (!platform) throw new Error('That link is not supported. I can download from TikTok, Instagram, Facebook, X (Twitter), Pinterest, Threads and YouTube.');
  const now = Date.now();
  let list = SOURCES[platform].filter((s) => (dead.get(platform + ':' + s.name) || 0) < now);
  if (!list.length) list = SOURCES[platform];
  const deadline = now + 110000; // never wait more than about 2 minutes
  const errs = [];
  for (const s of list) {
    if (Date.now() > deadline) break;
    const key = platform + ':' + s.name;
    try {
      const got = await realize(await s.run(link, o));
      dead.delete(key);
      return got;
    } catch (e) {
      if (isDown(e)) dead.set(key, Date.now() + 10 * 60 * 1000); // only a source that is down is skipped, not one that just lacks this post
      errs.push(s.name + ': ' + (e.cause?.code || e.message).toString().slice(0, 70));
    }
  }
  throw new Error(errs.join(' | ').slice(0, 450) || 'no source answered');
}

/* ------------------------------ sending ------------------------------ */
async function deliver(ctx, got, wantAudio, toMp3) {
  const q = { quoted: ctx.msg };
  const cap = got.title ? '🎬 ' + String(got.title).slice(0, 150) : undefined;
  if (got.kind === 'images') {
    let first = true;
    for (const b of got.bufs) { await ctx.sock.sendMessage(ctx.jid, { image: b, caption: first ? cap : undefined }, q); first = false; }
    return;
  }
  let buf = got.buf;
  if (wantAudio) {
    const mp3 = await toMp3(buf);
    return void (await ctx.sock.sendMessage(ctx.jid, { audio: mp3, mimetype: 'audio/mpeg', ptt: false }, q));
  }
  if (buf[0] === 0x1a) buf = await toMp4(buf); // webm / mkv -> mp4
  if (buf.length > 50 * 1048576) await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'video/mp4', fileName: 'video.mp4', caption: cap }, q);
  else await ctx.sock.sendMessage(ctx.jid, { video: buf, mimetype: 'video/mp4', caption: cap }, q);
}

/* ------------------------------ plugging into the old commands ------------------------------ */
const NAMES = new Set(['video', 'yt', 'tiktok', 'ig', 'fb', 'twitter2', 'threads', 'pinterest']);

function makeRun(cmd, orig) {
  return async (ctx) => {
    const extra = require('./extra'); // loaded now (not at the top) to avoid a loop between the files
    const raw = (ctx.text || ctx.quoted?.text || '').trim();
    const usage = cmd.name === 'video' ? `Usage: ${ctx.prefix}video <name or link>` : `Usage: ${ctx.prefix}${cmd.name} <link> [audio]`;
    // when nothing can be downloaded, the old code answers if the keyed API is set; otherwise a plain usage line is shown
    const old = (msg) => (extra.apiOn() ? orig(ctx) : Promise.reject(new Error(msg || usage)));
    if (!raw) return old();
    const words = raw.split(/\s+/);
    const opts = [];
    while (words.length > 1 && /^(audio|mp3|\d{3,4}p?|4k)$/i.test(words[words.length - 1])) opts.unshift(words.pop());
    const wantAudio = opts.some((x) => /^(audio|mp3)$/i.test(x));
    const qo = opts.find((x) => /^\d{3,4}p?$/.test(x));
    const height = qo ? parseInt(qo, 10) : (cmd.name === 'video' || cmd.name === 'yt' ? 360 : 720);

    let link = words[0];
    let title = '';
    if (!/^https?:\/\//i.test(link)) {
      if (cmd.name !== 'video') return old();
      const v = await extra.findVideo(words.join(' ')).catch(() => null); // .video <name>: search YouTube
      if (!v) return old('No results found.');
      link = v.url; title = v.title;
    }
    if (!detect(link)) return old('That link is not supported. I can download from TikTok, Instagram, Facebook, X (Twitter), Pinterest, Threads and YouTube.');

    const errs = [];
    if (extra.apiOn()) { // the old keyed method (if you set it) still goes first
      try { return await orig(ctx); } catch (e) { errs.push('Download API: ' + String(e.message).split('\n')[0]); }
    }
    const react = (t) => ctx.sock.sendMessage(ctx.jid, { react: { text: t, key: ctx.msg.key } }).catch(() => {});
    react('⏳');
    try {
      const got = await getMedia(link, { height, audio: wantAudio });
      if (title && !got.title) got.title = title;
      await deliver(ctx, got, wantAudio, extra.toMp3);
    } catch (e) {
      throw new Error(['Could not download that.', ...errs.map((x) => '- ' + x), '- Free sources: ' + e.message].join('\n').slice(0, 900));
    } finally { react(''); }
  };
}

function install(commands) {
  for (const c of commands || []) {
    if (!c || !NAMES.has(c.name) || c.keyless) continue;
    c.keyless = true;
    c.run = makeRun(c, c.run);
  }
}

module.exports = { install, getMedia, detect, mediaFromJson, sniff, SOURCES };
