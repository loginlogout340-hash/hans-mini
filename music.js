'use strict';
/**
 * Music that works WITHOUT any variable (no MALVIN_API, no keys, no cookies): .play and .song
 *
 * Order:  1) free download sites (no key needed)
 *         2) the old method from extra.js (Malvin API if you ever set it, then yt-dlp from YouTube)
 *         3) SoundCloud search with yt-dlp (SoundCloud does not block servers like YouTube does)
 *
 * It is registered from more7.js, BEFORE extra.js, so these two commands replace the old play/song.
 * The old ones are still used as step 2.
 *
 * The free sites are community services. They come and go, so the list below is easy to change:
 * every site is one line, and the bot skips a dead one for 10 minutes by itself.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const heavy = require('./limit').run; // limits how many yt-dlp / ffmpeg jobs run at once
const heal = (() => { try { return require('./selfheal'); } catch { return null; } })(); // optional: the bot works without it

const MAX_MB = 40;
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const enc = encodeURIComponent;

// get(url) builds the request link; post + form is used for sites that want a form instead
const PROVIDERS = [
  { name: 'ytmp3.ge', post: 'https://ytmp3.ge/api/convert', form: (u) => ({ youtube_url: u }) },
  { name: 'siputzx', get: (u) => 'https://api.siputzx.my.id/api/d/ytmp3?url=' + enc(u) },
  { name: 'vreden', get: (u) => 'https://api.vreden.my.id/api/v1/download/youtube/audio?quality=128&url=' + enc(u) },
  { name: 'nekolabs', get: (u) => 'https://api.nekolabs.web.id/downloader/youtube/v1?format=mp3&url=' + enc(u) },
  { name: 'davidcyril', get: (u) => 'https://apis.davidcyriltech.my.id/youtube/mp3?url=' + enc(u) },
  { name: 'agatz', get: (u) => 'https://api.agatz.xyz/api/ytmp3?url=' + enc(u) },
];

const dead = new Map(); // site name -> skipped until this time
let lastGood = null; // the site that worked last is tried first

// live fixes: selfheal.js reads sources.json from GitHub and hands the music list here (no redeploy needed)
const BUILTIN = PROVIDERS.slice();
function fromRemote(r) {
  if (r.get) return { name: r.name, get: (u) => r.get.replace('{u}', enc(u)) };
  return { name: r.name, post: r.post, form: (u) => Object.fromEntries(Object.entries(r.form).map(([k, v]) => [k, String(v).replace('{u}', u)])) };
}
if (heal) {
  heal.onConfig('music', (list, disabled = []) => {
    const base = list ? list.map(fromRemote) : BUILTIN;
    PROVIDERS.splice(0, PROVIDERS.length, ...base.filter((p) => !disabled.includes(p.name)));
  });
}

/* ---------- finding the download link in whatever the site answers ---------- */
const WANT = /(download|dl|mp3|audio|link|url)/i;
const SKIP = /(thumb|image|img|cover|poster|avatar|page|watch|video_?url)/i;
function pickLink(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v) && WANT.test(k) && !SKIP.test(k) && !/youtube\.com|youtu\.be|\.(jpe?g|png|webp|gif)(\?|$)/i.test(v)) return v;
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') { const f = pickLink(v, depth + 1); if (f) return f; }
  }
  return null;
}

async function linkFrom(p, ytUrl) {
  const signal = AbortSignal.timeout(12000);
  const r = p.post
    ? await fetch(p.post, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p.form(ytUrl)), signal })
    : await fetch(p.get(ytUrl), { headers: { 'user-agent': UA, accept: 'application/json' }, signal });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('HTTP ' + r.status);
  const link = pickLink(j);
  if (!link) throw new Error(r.ok ? 'no link in the answer' : 'HTTP ' + r.status);
  return link;
}

const isMp3 = (b) => b.length > 4 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));

async function downloadAudio(link) {
  const r = await fetch(link, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error('file HTTP ' + r.status);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (/text\/|json|html/.test(ct)) throw new Error('not an audio file');
  if (Number(r.headers.get('content-length') || 0) > MAX_MB * 1048576) throw new Error(`larger than ${MAX_MB}MB`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_MB * 1048576) throw new Error(`larger than ${MAX_MB}MB`);
  if (buf.length < 30000) throw new Error('file too small');
  return buf;
}

const isDown = (e) => /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Timeout|aborted|fetch failed|HTTP (5\d\d|403|404|429)/i.test(String(e.cause?.code || '') + ' ' + e.message);

/** step 1: the free sites. Returns an mp3 buffer or throws. */
async function freeAudio(v, toMp3) {
  const now = Date.now();
  let list = PROVIDERS.filter((p) => (dead.get(p.name) || 0) < now);
  if (!list.length) list = PROVIDERS.slice(); // all marked dead: try them all again
  if (heal) list = heal.rank(list, (p) => 'music:' + p.name); // the best source (by its real results) goes first
  else list.sort((a, b) => (b.name === lastGood) - (a.name === lastGood));
  const deadline = now + 75000; // never wait more than about 75 seconds here
  const errs = [];
  for (const p of list) {
    if (Date.now() > deadline) break;
    const t0 = Date.now();
    try {
      let buf = await downloadAudio(await linkFrom(p, v.url));
      if (!isMp3(buf)) { buf = await toMp3(buf); if (!isMp3(buf)) throw new Error('not audio'); } // m4a / webm -> mp3
      lastGood = p.name;
      dead.delete(p.name);
      if (heal) heal.record('music:' + p.name, true, Date.now() - t0);
      return buf;
    } catch (e) {
      if (heal) heal.record('music:' + p.name, false);
      if (isDown(e)) dead.set(p.name, Date.now() + 10 * 60 * 1000); // only a site that is down is skipped, not one that failed for this song
      errs.push(p.name + ': ' + String(e.cause?.code || e.message).slice(0, 50));
    }
  }
  throw new Error(errs.join(' | ').slice(0, 300) || 'no free source answered');
}

/** step 3: SoundCloud search through yt-dlp (skips 30 second previews) */
function soundcloud(query) {
  const base = path.join(os.tmpdir(), 'hm-sc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress', '--max-filesize', MAX_MB + 'M',
    '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '5', '--force-ipv4',
    '--match-filter', 'duration>90', '--max-downloads', '1',
    '-o', base + '.%(ext)s', 'scsearch5:' + String(query).slice(0, 150),
  ];
  return new Promise((ok, no) => {
    heavy('yt-dlp', args, { timeout: 120000, maxBuffer: 1 << 24 }, (err, out, errout) => {
      let buf = null;
      try { if (fs.existsSync(base + '.mp3')) buf = fs.readFileSync(base + '.mp3'); } catch { /* none */ }
      for (const ext of ['mp3', 'webm', 'm4a', 'opus', 'ogg', 'part']) fs.unlink(base + '.' + ext, () => {});
      if (buf && buf.length > 30000) return ok(buf);
      const why = String(errout || (err && err.message) || 'nothing found').split('\n').filter(Boolean).slice(-1)[0] || 'nothing found';
      no(new Error(why.slice(0, 160)));
    });
  });
}

/* ---------- sending ---------- */
async function card(ctx, v) {
  const text = `🎵 *${v.title}*\n👤 ${v.author?.name || '-'}\n⏱ ${v.timestamp || '-'}\n🔗 ${v.url}`;
  if (v.thumbnail) await ctx.sendImage(v.thumbnail, text).catch(() => ctx.reply(text)); else await ctx.reply(text);
}
// sending to WhatsApp, with one more try; a failure here is NOT a download failure, so it is reported as what it is
async function deliver(ctx, v, buf, asFile) {
  try { await sendAudio(ctx, v, buf, asFile); }
  catch (e1) {
    await new Promise((r) => setTimeout(r, 2500));
    try { await sendAudio(ctx, v, buf, asFile); }
    catch (e2) { throw new Error('I got the song but could not send it to WhatsApp (' + String(e2.message || e1.message).slice(0, 80) + '). Please try again.'); }
  }
}
async function sendAudio(ctx, v, buf, asFile) {
  const quoted = { quoted: ctx.msg };
  if (asFile) {
    const name = String(v.title || 'song').replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
    await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'audio/mpeg', fileName: name + '.mp3' }, quoted);
  } else {
    await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, quoted);
  }
}

/* ---------- the commands ---------- */
function makeHandler(asFile) {
  const cmdName = asFile ? 'song' : 'play';
  const self = async (ctx) => {
    const extra = require('./extra'); // loaded now (not at the top) to avoid a loop between the files
    const old = () => (require('./commands').commands || []).find((c) => c.name === cmdName && c.run !== self);
    const react = (t) => ctx.sock.sendMessage(ctx.jid, { react: { text: t, key: ctx.msg.key } }).catch(() => {});
    const q = ctx.text || ctx.quoted?.text;
    if (!q) {
      const o = old();
      if (o) return o.run(ctx);
      throw new Error(`Usage: ${ctx.prefix}${cmdName} <name or YouTube link>`);
    }

    react('⏳');
    try {
      let v = null;
      try { v = await extra.findVideo(q); } catch { /* the old method below shows the real error */ }

      // 1) free sites
      let freeErr = 'not tried';
      if (v) {
        let buf = null;
        try { buf = await freeAudio(v, extra.toMp3); } catch (e) { freeErr = e.message; console.log('[music] free sources failed:', freeErr); }
        if (buf) { await card(ctx, v); await deliver(ctx, v, buf, asFile); return; }
      }

      // 2) the old method (Malvin API if set, then yt-dlp from YouTube)
      const o = old();
      try {
        if (!o) throw new Error('the old method is not available');
        return await o.run(ctx);
      } catch (e1) {
        if (!v) throw e1;
        // 3) SoundCloud
        try {
          const buf = await soundcloud(`${v.title} ${v.author?.name || ''}`);
          if (!o) await card(ctx, v); // the old method sends the card itself
          await deliver(ctx, v, buf, asFile);
          return;
        } catch (e2) {
          if (/could not send it to WhatsApp/.test(e2.message)) throw e2;
          if (heal) { heal.noteFailure('youtube', e1.message); heal.noteError(cmdName, e1); } // YouTube refusing the server again and again triggers a yt-dlp update
          const first = String(e1.message || '').replace(/\n- Download API: not set[^\n]*/g, '');
          throw new Error(`${first}\n- Free sources: ${freeErr}\n- SoundCloud: ${e2.message}\n\nOwner: send .health to see which sources work from this server.`.slice(0, 1100));
        }
      }
    } finally { react(''); }
  };
  self.isNew = true; // lets more7.js see that this is the new handler
  return self;
}

function register(add) {
  add('play', 'Media', '<name or link>', 'Search a song and send it as audio (works without any setup)', makeHandler(false), { aliases: ['music'] });
  add('song', 'Media', '<name or link>', 'Search a song and send it as a downloadable file', makeHandler(true), { aliases: ['mp3'] });
}

module.exports = { register, freeAudio, soundcloud, pickLink, PROVIDERS, linkFrom };
