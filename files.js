'use strict';
/**
 * Everything else that used to need MALVIN_API / MALVIN_KEY, now WITHOUT any key or variable.
 * more7.js calls install() once when the bot starts; these existing commands get a keyless engine:
 *
 *   .gdrive     Google Drive file         the public download address, including the "file is too big to scan" page
 *   .mediafire  MediaFire file            reads the download button on the page
 *   .mega       MEGA file                 needs the "megajs" package (optional, listed in package.json)
 *   .terabox    TeraBox file              free community services (the least reliable one: TeraBox fights downloaders)
 *   .apk        Android app by name       Aptoide's public search (no key)
 *   .savefrom   SoundCloud / audio link   yt-dlp
 *   .spotify    track link or song name   reads the song and artist from the Spotify page, then finds the audio like .play
 *   .pastebin   text of a paste           pastebin's raw address
 *
 * If you ever set MALVIN_API + MALVIN_KEY the old method still goes first. Free services come and go, so the
 * lists can be changed in sources.json (see selfheal.js) without touching the code.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const heavy = require('./limit').run;
const heal = (() => { try { return require('./selfheal'); } catch { return null; } })(); // optional

const MAX_FILE_MB = 200; // biggest file the bot will send
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Date.now() + '-' + Math.random().toString(36).slice(2, 7);
const mbOf = (n) => Math.round((n || 0) / 1048576);
const safeName = (s, fb = 'file') => String(s || fb).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 100) || fb;
const unhtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function getText(url, ms = 15000, init = {}) {
  const r = await fetch(url, { redirect: 'follow', ...init, headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...(init.headers || {}) }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function getJson(url, ms = 15000) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('HTTP ' + r.status);
  return j;
}

/* ------------------------------ checking a download address ------------------------------ */
// asks the server about a file without downloading it: is it really a file (not a web page), how big, what is it called
async function probe(url, ms = 15000) {
  const h = { 'user-agent': UA };
  let r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: h, signal: AbortSignal.timeout(ms) }).catch(() => null);
  if (!r || !r.ok || !r.headers.get('content-length')) {
    r = await fetch(url, { headers: { ...h, range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    try { await r.arrayBuffer(); } catch { /* the first byte is enough */ }
  }
  if (!r.ok && r.status !== 206) throw new Error('file HTTP ' + r.status);
  const ct = (r.headers.get('content-type') || '').toLowerCase().split(';')[0];
  if (ct === 'text/html' || ct === 'application/json') return null; // a web page, not the file
  const cr = r.headers.get('content-range');
  const size = cr ? Number(cr.split('/')[1]) : Number(r.headers.get('content-length') || 0);
  const cd = r.headers.get('content-disposition') || '';
  let name = (cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i) || [])[1] || '';
  try { name = decodeURIComponent(name).trim(); } catch { name = name.trim(); }
  if (!name) { try { name = decodeURIComponent(new URL(r.url || url).pathname.split('/').pop() || ''); } catch { name = ''; } }
  return { url: r.url || url, type: ct, size, name };
}

/* ------------------------------ sending a file ------------------------------ */
const kindOf = (name, type) => {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (/^audio\//.test(type) || /^(mp3|m4a|wav|ogg|opus|aac|flac)$/.test(ext)) return 'audio';
  if (/^video\//.test(type) || /^(mp4|mkv|mov|webm|3gp)$/.test(ext)) return 'video';
  if (/^image\//.test(type) || /^(jpe?g|png|webp|gif)$/.test(ext)) return 'image';
  return 'document';
};
const MIME = { apk: 'application/vnd.android.package-archive', pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', txt: 'text/plain', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
async function sendFile(ctx, f, caption) {
  const q = { quoted: ctx.msg };
  const src = f.buf || { url: f.url }; // a link is streamed by WhatsApp's library, so a big file does not fill the server memory
  const size = f.size || (f.buf ? f.buf.length : 0);
  if (size > MAX_FILE_MB * 1048576) throw new Error(`This file is ${mbOf(size)} MB. The limit is ${MAX_FILE_MB} MB.`);
  const kind = kindOf(f.name, f.type);
  const ext = String(f.name || '').split('.').pop().toLowerCase();
  const small = size < 50 * 1048576;
  if (kind === 'audio' && small) return ctx.sock.sendMessage(ctx.jid, { audio: src, mimetype: f.type && /^audio\//.test(f.type) ? f.type : 'audio/mpeg', ptt: false }, q);
  if (kind === 'video' && small) return ctx.sock.sendMessage(ctx.jid, { video: src, mimetype: 'video/mp4', caption }, q);
  if (kind === 'image' && small) return ctx.sock.sendMessage(ctx.jid, { image: src, caption }, q);
  return ctx.sock.sendMessage(ctx.jid, { document: src, fileName: safeName(f.name), mimetype: MIME[ext] || (f.type && f.type !== 'application/octet-stream' ? f.type : 'application/octet-stream'), caption }, q);
}
const info = (f) => `${safeName(f.name)}${f.size ? ' · ' + mbOf(f.size) + ' MB' : ''}`;

/* ------------------------------ Google Drive ------------------------------ */
async function gdrive(link) {
  const id = (link.match(/\/d\/([\w-]{15,})/) || link.match(/[?&]id=([\w-]{15,})/) || [])[1];
  if (!id) throw new Error('That does not look like a Google Drive file link.');
  const direct = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  let f = await probe(direct).catch(() => null);
  if (!f) {
    // big files show a "cannot scan for viruses" page: its hidden fields give the real address
    const html = await getText(`https://drive.google.com/uc?export=download&id=${id}`);
    if (/quota exceeded|too many users|can't view or download|you need access|sign in/i.test(html)) throw new Error('The file is not public, or Google blocked the download for today. Check that "Anyone with the link" can open it.');
    const field = (n) => (html.match(new RegExp('name="' + n + '"\\s+value="([^"]*)"')) || [])[1];
    const confirm = field('confirm') || 't', uuid = field('uuid');
    const u = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirm}${uuid ? '&uuid=' + uuid : ''}`;
    f = await probe(u);
    if (!f) throw new Error('Google Drive did not give the file. Check that "Anyone with the link" can open it.');
  }
  return f;
}

/* ------------------------------ MediaFire ------------------------------ */
async function mediafire(link) {
  if (!/mediafire\.com\/(file|view|download)/i.test(link)) throw new Error('Send a MediaFire file link (mediafire.com/file/...).');
  const html = await getText(link);
  let url = (html.match(/data-scrambled-url="([^"]+)"/) || [])[1];
  if (url) { try { url = Buffer.from(url, 'base64').toString('utf8'); } catch { url = null; } }
  if (!url) url = unhtml((html.match(/id="downloadButton"[^>]*href="([^"]+)"/) || html.match(/href="(https?:\/\/download\d*\.mediafire\.com[^"]+)"/) || [])[1] || '');
  if (!/^https?:\/\//.test(url || '')) throw new Error('I could not find the download button. The file may be removed or private.');
  const f = await probe(url);
  if (!f) throw new Error('MediaFire gave a web page instead of the file. Try again later.');
  if (!f.name) f.name = unhtml((html.match(/<div class="filename">([^<]+)</) || [])[1] || '');
  return f;
}

/* ------------------------------ MEGA ------------------------------ */
async function mega(link) {
  let m;
  try { m = require('megajs'); } catch { throw new Error('MEGA support is not installed on this server. The owner must add "megajs" to package.json and redeploy.'); }
  if (!/mega\.nz\/(file|#!)/i.test(link)) throw new Error('Send a MEGA file link (folders are not supported).');
  const file = m.File.fromURL(link);
  await file.loadAttributes();
  if (file.directory) throw new Error('That is a folder. Send the link of one file.');
  if (file.size > MAX_FILE_MB * 1048576) throw new Error(`This file is ${mbOf(file.size)} MB. The limit is ${MAX_FILE_MB} MB.`);
  const buf = await Promise.race([file.downloadBuffer(), sleep(180000).then(() => { throw new Error('MEGA took too long (its free transfer limit may be used up). Try again later.'); })]);
  return { buf, name: file.name, size: buf.length, type: '' };
}

/* ------------------------------ TeraBox (community services) ------------------------------ */
async function terabox(link) {
  if (!['terabox.com', '1024terabox.com', 'teraboxapp.com', 'terabox.app', 'teraboxlink.com'].some((x) => link.includes(x))) throw new Error('Send a TeraBox share link (terabox.com/s/...).');
  const g = require('./getmedia');
  const list = g.COMMUNITY.terabox || [];
  const errs = [];
  for (const [name, tpl] of list) {
    const t0 = Date.now();
    try {
      const j = await g.getJson(tpl.replace('{u}', enc(link)), 25000);
      const m = g.mediaFromJson(j);
      for (const u of [...m.videos, ...m.images].slice(0, 4)) {
        const f = await probe(u, 20000).catch(() => null);
        if (f && f.size > 10000) { if (heal) heal.record('terabox:' + name, true, Date.now() - t0); return { ...f, name: f.name || (j.title || j.file_name || j.filename || 'terabox_file') }; }
      }
      throw new Error('no file in the answer');
    } catch (e) { if (heal) heal.record('terabox:' + name, false); errs.push(name + ': ' + String(e.cause?.code || e.message).slice(0, 40)); }
  }
  throw new Error('TeraBox blocks free downloaders most of the time.\n' + (errs.join(' | ') || 'no service is listed'));
}

/* ------------------------------ APK by name (Aptoide) ------------------------------ */
async function apk(name) {
  const j = await getJson(`https://ws75.aptoide.com/api/7/apps/search?query=${enc(name.slice(0, 60))}&limit=8`, 20000);
  const list = (j?.datalist?.list || []).filter((a) => a?.file?.path);
  if (!list.length) throw new Error('App not found. Try a different name.');
  // trusted files first, then the most downloaded
  list.sort((a, b) => (b.file.malware?.rank === 'TRUSTED') - (a.file.malware?.rank === 'TRUSTED') || (b.stats?.downloads || 0) - (a.stats?.downloads || 0));
  const a = list[0];
  return { url: a.file.path, name: `${safeName(a.name)}.apk`, size: a.file.filesize || a.size || 0, type: 'application/vnd.android.package-archive', meta: a };
}

/* ------------------------------ audio links (SoundCloud and others) via yt-dlp ------------------------------ */
function audioFromLink(link) {
  const base = path.join(os.tmpdir(), 'hm-fa-' + rnd());
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--max-filesize', '60M', '--force-ipv4', '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '5', '-o', base + '.%(ext)s', link];
  return new Promise((ok, no) => {
    heavy('yt-dlp', args, { timeout: 150000, maxBuffer: 1 << 24 }, (err, out, errout) => {
      let buf = null;
      try { if (fs.existsSync(base + '.mp3')) buf = fs.readFileSync(base + '.mp3'); } catch { /* none */ }
      for (const e of ['mp3', 'webm', 'm4a', 'opus', 'ogg', 'part']) fs.unlink(base + '.' + e, () => {});
      if (buf && buf.length > 20000) return ok(buf);
      no(new Error((String(errout || (err && err.message) || 'nothing found').split('\n').filter(Boolean).slice(-1)[0] || 'nothing found').slice(0, 160)));
    });
  });
}

/* ------------------------------ Spotify: read the song, then find the audio like .play ------------------------------ */
async function spotifyQuery(link) {
  const url = link.split('?')[0];
  if (!/open\.spotify\.com\/(intl-[a-z]+\/)?track\//i.test(url)) throw new Error('Send a Spotify TRACK link (open.spotify.com/track/...). Albums and playlists are not supported.');
  const html = await getText(url, 15000);
  const t = unhtml((html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '');
  let title = '', artist = '';
  let m = t.match(/^(.+?)\s+-\s+(?:song|single|album|ep)\b.*?\bby\s+(.+?)\s*\|\s*Spotify/i);
  if (m) { title = m[1]; artist = m[2]; }
  if (!title) {
    const og = (p) => unhtml((html.match(new RegExp('<meta[^>]+property="' + p + '"[^>]+content="([^"]*)"', 'i')) || [])[1] || '');
    title = og('og:title');
    artist = og('og:description').split('·')[0].trim();
  }
  if (!title) throw new Error('I could not read that Spotify page.');
  return `${title} ${artist}`.trim();
}

/* ------------------------------ Pastebin ------------------------------ */
async function pastebin(link) {
  const id = (link.match(/pastebin\.com\/(?:raw\/|u\/[^/]+\/)?([A-Za-z0-9]{6,12})/) || [])[1];
  if (!id) throw new Error('Send a Pastebin link (pastebin.com/abc123).');
  const text = await getText(`https://pastebin.com/raw/${id}`, 15000);
  if (!text.trim()) throw new Error('The paste is empty, private or deleted.');
  return { id, text };
}

/* ------------------------------ plugging into the old commands ------------------------------ */
const NAMES = new Set(['gdrive', 'mediafire', 'mega', 'terabox', 'apk', 'savefrom', 'spotify', 'pastebin']);

function makeRun(cmd, orig) {
  return async (ctx) => {
    const extra = require('./extra'); // loaded now (not at the top) to avoid a loop between the files
    const raw = (ctx.text || ctx.quoted?.text || '').trim();
    const p = ctx.prefix;
    const usage = {
      gdrive: `Usage: ${p}gdrive <google drive link>`, mediafire: `Usage: ${p}mediafire <mediafire link>`, mega: `Usage: ${p}mega <mega.nz file link>`,
      terabox: `Usage: ${p}terabox <terabox link>`, apk: `Usage: ${p}apk <app name>   (example: ${p}apk WhatsApp)`, savefrom: `Usage: ${p}savefrom <soundcloud or audio link>`,
      spotify: `Usage: ${p}spotify <track link or song name> [doc]`, pastebin: `Usage: ${p}pastebin <pastebin link>`,
    }[cmd.name];
    const old = () => (extra.apiOn() ? orig(ctx) : Promise.reject(new Error(usage)));
    if (!raw) return old();

    const errs = [];
    if (extra.apiOn()) { try { return await orig(ctx); } catch (e) { errs.push('Download API: ' + String(e.message).split('\n')[0]); } } // the old keyed method (if you set it) goes first
    const react = (t) => ctx.sock.sendMessage(ctx.jid, { react: { text: t, key: ctx.msg.key } }).catch(() => {});
    const link = raw.split(/\s+/)[0];
    react('⏳');
    try {
      switch (cmd.name) {
        case 'gdrive': { const f = await gdrive(link); return void (await sendFile(ctx, f, `📁 *Google Drive*\n📄 ${info(f)}`)); }
        case 'mediafire': { const f = await mediafire(link); return void (await sendFile(ctx, f, `🔥 *MediaFire*\n📄 ${info(f)}`)); }
        case 'mega': { const f = await mega(link); return void (await sendFile(ctx, f, `💾 *MEGA*\n📄 ${info(f)}`)); }
        case 'terabox': { const f = await terabox(link); return void (await sendFile(ctx, f, `📦 *TeraBox*\n📄 ${info(f)}`)); }
        case 'apk': {
          const f = await apk(raw);
          const a = f.meta;
          const cap = `*APK DOWNLOADER*\n\n*App:* ${a.name}\n*Package:* ${a.package}\n*Version:* ${a.file.vername || '?'}\n*Size:* ${mbOf(f.size)} MB\n*Developer:* ${a.developer?.name || 'Unknown'}\n*Check:* ${a.file.malware?.rank || 'not scanned'}\n\n_From Aptoide, a third-party app store. Only install apps you trust._`;
          if (a.icon) await ctx.sock.sendMessage(ctx.jid, { image: { url: a.icon }, caption: cap }, { quoted: ctx.msg }).catch(() => ctx.reply(cap)); else await ctx.reply(cap);
          return void (await sendFile(ctx, f));
        }
        case 'savefrom': {
          if (!/^https?:\/\//i.test(link)) throw new Error(usage);
          const buf = await audioFromLink(link);
          return void (await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, { quoted: ctx.msg }));
        }
        case 'spotify': {
          const asDoc = /\sdoc$/i.test(raw);
          const q0 = raw.replace(/\s+doc$/i, '').trim();
          const query = /open\.spotify\.com/i.test(q0) ? await spotifyQuery(q0.split(/\s+/)[0]) : q0;
          // the song is found and sent by the same keyless engine as .play (or .song for a file)
          const list = require('./commands').commands || [];
          const target = list.find((c) => c.name === (asDoc ? 'song' : 'play') && c.run && c.run.isNew) || list.find((c) => c.name === 'play');
          if (!target) throw new Error('The music engine is not loaded.');
          return await target.run({ ...ctx, text: query, args: query.split(/\s+/) });
        }
        case 'pastebin': {
          const { id, text } = await pastebin(link);
          const msg = `*PASTEBIN*\n*Paste ID:* ${id}\n━━━━━━━━━━━━━━━━━━━━\n\n${text}`;
          if (msg.length > 60000) return void (await ctx.sock.sendMessage(ctx.jid, { document: Buffer.from(text, 'utf8'), fileName: `pastebin_${id}.txt`, mimetype: 'text/plain', caption: `📋 Paste ID: ${id}\n_Too long, sent as a file_` }, { quoted: ctx.msg }));
          return void (await ctx.reply(msg));
        }
        default: return old();
      }
    } catch (e) {
      if (heal) heal.noteError(cmd.name, e);
      throw new Error([`Could not get that ${cmd.name === 'apk' ? 'app' : 'file'}.`, ...errs.map((x) => '- ' + x), '- ' + e.message].join('\n').slice(0, 900));
    } finally { react(''); }
  };
}

function install(commands) {
  for (const c of commands || []) {
    if (!c || !NAMES.has(c.name) || c.keylessFiles) continue;
    c.keylessFiles = true;
    c.run = makeRun(c, c.run);
  }
}

module.exports = { install, probe, gdrive, mediafire, mega, terabox, apk, audioFromLink, spotifyQuery, pastebin, NAMES };
