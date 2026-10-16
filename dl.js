'use strict';
/**
 * Hans-Mini downloaders, converted from the FEE-XMD "downloads" plugin.
 * Most of them call the same download API as .play/.video, so they need two Railway variables:
 *   MALVIN_API = base link of the API (no trailing slash)
 *   MALVIN_KEY = its API key
 * Only .gitclone works without them.
 *
 * NEW: every "link -> video" downloader first tries its own dedicated API path; if that path does not exist
 * or fails, it falls back to the general downloader (/api/download/savenow, aio2, 9xbuddy), which works for
 * YouTube, Instagram, TikTok, Facebook, Twitter and many more. .spotify with a song name falls back to
 * searching YouTube.
 *
 * Options after the link:  .tiktok <link> audio    .yt <link> 720    .yt <link> mp3    .spotify <name> doc
 */
const extra = require('./extra');

const NEEDS_API = 'This downloader is not set up yet. Add MALVIN_API and MALVIN_KEY in the Railway variables.';
const isAudioOpt = (o) => /^(audio|mp3)$/i.test(o);
const safeName = (s, fallback = 'file') => String(s || fallback).replace(/[^\w\s.-]/g, '').trim().slice(0, 80) || fallback;

const EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac',
  mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', apk: 'application/vnd.android.package-archive',
  txt: 'text/plain', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const mimeOf = (name) => EXT[String(name || '').split('?')[0].split('.').pop().toLowerCase()] || 'application/octet-stream';

// picks the right kind of WhatsApp message for a downloaded file
function fileItem(name, url) {
  const mime = mimeOf(name || url);
  if (mime.startsWith('audio/')) return { type: 'audio', url };
  if (mime.startsWith('video/')) return { type: 'video', url };
  if (mime.startsWith('image/')) return { type: 'image', url };
  return { type: 'document', url, fileName: name || 'file', mimetype: mime };
}

// like extra.apiGet but returns the whole JSON (some endpoints do not use the {status,data} shape)
async function apiRaw(route, params, timeoutMs = 30000) {
  const url = new URL(extra.apiBase() + route);
  url.searchParams.set('apikey', process.env.MALVIN_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(String((j && (j.error || j.message)) || 'Download service returned HTTP ' + r.status).slice(0, 200));
  return j;
}

/* ---------- sending ---------- */
async function sendItems(ctx, items, caption, wantAudio, audioUrl) {
  const quoted = { quoted: ctx.msg };
  if (wantAudio) {
    if (!audioUrl) throw new Error('No audio could be found for this link.');
    const buf = await extra.toMp3(await extra.fetchBuf(audioUrl, 60));
    await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, quoted);
    return;
  }
  if (!items.length) throw new Error('Nothing downloadable was found.');
  let first = true;
  for (const it of items) {
    const cap = first && caption ? caption : undefined;
    first = false;
    if (it.type === 'image') await ctx.sock.sendMessage(ctx.jid, { image: { url: it.url }, caption: cap }, quoted);
    else if (it.type === 'video') await ctx.sock.sendMessage(ctx.jid, { video: { url: it.url }, mimetype: 'video/mp4', caption: cap }, quoted);
    else if (it.type === 'audio') {
      const buf = await extra.toMp3(await extra.fetchBuf(it.url, 60));
      await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, quoted);
    } else await ctx.sock.sendMessage(ctx.jid, { document: { url: it.url }, fileName: it.fileName || 'file', mimetype: it.mimetype || 'application/octet-stream', caption: cap }, quoted);
  }
}

/* ---------- general fallback (works for most sites) ---------- */
// downloaders whose job is simply "link in, video out"; these may use the general fallback
const GENERIC = new Set([
  'fb', 'tiktok', 'ig', 'yt', 'tiktokv2', 'tiktok2', 'tiktok5', 'tiktok7', 'twitter2', 'douyin',
  'snack', 'snackvideo2', 'vidsplay', 'alamy', 'lahelu', 'capcut', 'threads', 'pinterest',
]);
// tells a picture from a video by its first bytes
const sniff = (buf) => {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image';
  return 'video';
};
async function sendGeneric(ctx, link, opts) {
  const wantAudio = opts.some(isAudioOpt);
  const qo = opts.find((o) => /^(144|240|360|480|720|1080|1440|4k)p?$/i.test(o));
  const fmt = wantAudio ? 'mp3' : (qo ? qo.replace(/p$/i, '') : '720');
  const m = await extra.apiMedia(link, fmt);
  const quoted = { quoted: ctx.msg };
  if (wantAudio) {
    const buf = await extra.toMp3(await extra.fetchBuf(m.link, 60));
    return ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, quoted);
  }
  const buf = await extra.fetchBuf(m.link, 100);
  const caption = m.title ? '🎬 ' + String(m.title).slice(0, 120) : undefined;
  if (sniff(buf) === 'image') return ctx.sock.sendMessage(ctx.jid, { image: buf, caption }, quoted);
  if (buf.length > 50 * 1048576) return ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'video/mp4', fileName: safeName(m.title, 'video') + '.mp4', caption }, quoted);
  return ctx.sock.sendMessage(ctx.jid, { video: buf, mimetype: 'video/mp4', caption }, quoted);
}

// Spotify song NAME -> find it on YouTube and download that as mp3
async function spotifyViaYoutube(q) {
  const v = await extra.findVideo(q);
  if (!v) throw new Error('No tracks found.');
  const m = await extra.apiMedia(v.url, 'mp3');
  return { buf: await extra.toMp3(await extra.fetchBuf(m.link, extra.MAX_MB)), title: v.title };
}

/* ---------- the simple "give a link, get the media" downloaders ---------- */
const vid = (url, caption, audioUrl) => ({ items: url ? [{ type: 'video', url }] : [], caption, audioUrl: audioUrl || url });
const stat = (d) => `❤️ ${d.like_count || 0} | 💬 ${d.comment_count || 0} | 🔁 ${d.share_count || 0}`;

const SPECS = [
  {
    name: 'fb', aliases: ['fbdl', 'facebookdl', 'facebook'], usage: '<facebook link> [audio]', desc: 'Download Facebook videos',
    check: /facebook\.com|fb\.watch/i, label: 'Facebook', ep: '/download/fbdown',
    resolve: (d) => {
      const medias = d?.medias || [];
      const best = medias.find((m) => /hd/i.test(m.quality || '')) || medias[0];
      const url = best?.download_url || best?.direct_url;
      if (!url) throw new Error('No video found in this post.');
      return vid(url, d.title ? '📝 ' + String(d.title).slice(0, 100) : '');
    },
  },
  {
    name: 'tiktok', aliases: ['tiktokdl', 'ttdl', 'tt'], usage: '<tiktok link> [audio]', desc: 'Download TikTok videos (no watermark)',
    check: /tiktok\.com/i, label: 'TikTok', ep: '/download/tikwm',
    resolve: (d) => {
      const medias = d?.medias || [];
      const v = medias.find((m) => m.type === 'video' && /hd/i.test(m.quality || '')) || medias.find((m) => m.type === 'video' && /no watermark/i.test(m.quality || '')) || medias.find((m) => m.type === 'video');
      const a = medias.find((m) => m.type === 'audio');
      if (!v) {
        const imgs = medias.filter((m) => m.type === 'image');
        if (!imgs.length) throw new Error('No downloadable video found.');
        return { items: imgs.map((m) => ({ type: 'image', url: m.url })), caption: '' };
      }
      const s = d.stats || {};
      const cap = `*${d.title || 'TikTok Video'}*\n👤 ${d.author?.name || d.author?.username || 'Unknown'}\n❤️ ${s.likes || 0} | 👁️ ${s.views || 0}`;
      return vid(v.url, cap, a?.url || v.url);
    },
  },
  {
    name: 'ig', aliases: ['insta', 'instadl', 'igdl', 'instagram'], usage: '<instagram link> [audio]', desc: 'Download Instagram reels, videos and photos',
    check: /instagram\.com/i, label: 'Instagram', ep: '/download/instagram2',
    resolve: (d) => {
      const media = d?.media || [];
      const v = media.find((m) => m.type === 'video' && m.url);
      if (v) return vid(v.url, '');
      const imgs = media.filter((m) => m.type === 'image' && m.url);
      if (!imgs.length) throw new Error('No downloadable content found.');
      return { items: imgs.map((m) => ({ type: 'image', url: m.url })), caption: '' };
    },
  },
  {
    name: 'yt', aliases: ['ytdl', 'youtube'], usage: '<youtube link> [360|720|1080|mp3]', desc: 'Download a YouTube video at a chosen quality, or the audio',
    check: /youtube\.com|youtu\.be/i, label: 'YouTube', ep: '/download/youtube2',
    resolve: (d, opts) => {
      const videos = d?.videos || {};
      const audioUrl = d?.audio;
      if (!Object.keys(videos).length && !audioUrl) throw new Error('No downloadable formats found for this video.');
      const qo = opts.find((o) => /^(144|240|360|480|720|1080)p?$/i.test(o));
      const want = qo ? qo.replace(/p$/i, '') : '360';
      const url = videos[want] || videos['360'] || videos['720'] || Object.values(videos)[0];
      return { items: url ? [{ type: 'video', url }] : [], caption: `*${d.title || 'YouTube Video'}*` + (d.creator ? `\n👤 ${d.creator}` : ''), audioUrl };
    },
  },
  {
    name: 'gdrive', aliases: ['googledrive', 'drive', 'gdrivedl'], usage: '<google drive link>', desc: 'Download a public Google Drive file',
    check: /drive\.google\.com/i, label: 'Google Drive', ep: '/download/gdrive', timeout: 60000,
    resolve: (d) => {
      if (!d?.download_url) throw new Error('Failed to fetch the file. Make sure it is publicly accessible.');
      return { items: [fileItem(d.file_name, d.download_url)], caption: `📁 *Google Drive*\n📄 ${d.file_name || 'File'}\n📦 ${d.file_size || 'Unknown'}` };
    },
  },
  {
    name: 'mediafire', aliases: ['mfire', 'mediafiredl', 'mfiredl'], usage: '<mediafire link>', desc: 'Download from MediaFire',
    check: /mediafire\.com/i, label: 'MediaFire', ep: '/download/mediafire', timeout: 60000,
    resolve: (d) => {
      if (!d?.download) throw new Error('Failed to fetch the file from MediaFire.');
      return { items: [fileItem(d.filename, d.download)], caption: `🔥 *MediaFire*\n📄 ${d.filename}\n📦 ${d.filesize || 'Unknown'}` };
    },
  },
  {
    name: 'mega', aliases: ['megadl', 'meganz'], usage: '<mega.nz link>', desc: 'Download from MEGA.nz',
    check: /mega\.nz/i, label: 'MEGA', ep: '/download/mega', timeout: 60000,
    resolve: (d) => {
      if (!d?.download) throw new Error('Failed to resolve the MEGA link.');
      return { items: [fileItem(d.name || 'mega_file', d.download)], caption: `💾 *MEGA*\n📄 ${d.name || 'File'}\n📦 ${d.size || 'Unknown'}` };
    },
  },
  {
    name: 'alamy', aliases: ['alamydl', 'alamyvideo'], usage: '<alamy video link>', desc: 'Download videos from Alamy',
    check: /alamy\.com/i, label: 'Alamy', ep: '/download/alamy',
    resolve: (d) => { if (!d?.video_url) throw new Error('Failed to fetch the video from Alamy.'); return vid(d.video_url, '📷 *Alamy Video*'); },
  },
  {
    name: 'snack', aliases: ['snackvideo', 'snackdl', 'sck'], usage: '<snackvideo link>', desc: 'Download from SnackVideo', label: 'SnackVideo', ep: '/download/snack',
    resolve: (d) => { if (!d?.video_url) throw new Error('Failed to fetch the video from SnackVideo.'); return vid(d.video_url, '🍿 *SnackVideo*'); },
  },
  {
    name: 'vidsplay', aliases: ['vidsplaydl', 'vplay'], usage: '<vidsplay link>', desc: 'Download from Vidsplay', label: 'Vidsplay', ep: '/download/vidsplay',
    resolve: (d) => { if (!d?.video_url) throw new Error('Failed to fetch the video from Vidsplay.'); return vid(d.video_url, '🎬 *Vidsplay Video*'); },
  },
  {
    name: 'tiktokv2', aliases: ['ttv2', 'tikv2'], usage: '<tiktok link> [audio]', desc: 'TikTok download (second engine)',
    check: /tiktok/i, label: 'TikTok', ep: '/download/tiktokv2',
    resolve: (d) => {
      if (!d?.video_url) throw new Error('Failed to fetch the TikTok video.');
      const s = d.stats || {};
      return vid(d.video_url, `📱 *TikTok V2*\n👤 ${d.author?.username || 'Unknown'}\n❤️ ${s.likes || 0} | 💬 ${s.comments || 0} | 🔁 ${s.shares || 0}\n\n${d.title || ''}`);
    },
  },
  {
    name: 'tiktok2', aliases: ['ttaplmate', 'tiktokaplmate', 'tt2'], usage: '<tiktok link> [audio]', desc: 'TikTok download (Aplmate engine)',
    check: /tiktok/i, label: 'TikTok', ep: '/download/tiktok2/aplmate',
    resolve: (d) => {
      if (!d?.download_url) throw new Error('Failed to fetch the TikTok video.');
      return vid(d.download_url, `📱 *TikTok (Aplmate)*\n👤 ${d.author || 'Unknown'}\n\n${d.title || ''}`);
    },
  },
  {
    name: 'tiktok5', aliases: ['tt5', 'tiktokv5'], usage: '<tiktok link> [audio]', desc: 'TikTok download (engine v5)',
    check: /tiktok/i, label: 'TikTok', ep: '/download/tiktok5',
    resolve: (d) => {
      const url = d?.no_watermark_link || d?.no_watermark_link_hd || d?.watermark_link;
      if (!url) throw new Error('No video link found.');
      return vid(url, `📱 *TikTok v5*\n👤 ${d.author_nickname || 'Unknown'}\n${stat(d)}`);
    },
  },
  {
    name: 'tiktok7', aliases: ['tt7', 'tiktokv7'], usage: '<tiktok link> [audio]', desc: 'TikTok download (TikCDN engine)',
    check: /tiktok/i, label: 'TikTok', ep: '/download/tiktok7',
    resolve: (d) => {
      const url = d?.no_watermark_link || d?.no_watermark_link_hd;
      if (!url) throw new Error('No video link found.');
      return vid(url, `📱 *TikTok v7*\n👤 ${d.author_nickname || 'Unknown'}\n${stat(d)}`);
    },
  },
  {
    name: 'capcut', aliases: ['capcutdl', 'cct'], usage: '<capcut template link>', desc: 'Download CapCut template videos', label: 'CapCut', ep: '/download/capcut',
    resolve: (d) => {
      if (!d?.originalVideoUrl) throw new Error('Failed to fetch the CapCut template.');
      return vid(d.originalVideoUrl, `🎬 *CapCut Template*\n📝 ${d.title || 'No title'}\n👤 ${d.authorName || 'Unknown'}`);
    },
  },
  {
    name: 'savefrom', aliases: ['sf', 'savefromdl'], usage: '<soundcloud or other audio link>', desc: 'Download audio from SoundCloud and similar sites', label: 'media', ep: '/download/savefrom',
    resolve: (d) => {
      const media = Array.isArray(d) ? d[0] : null;
      if (!media) throw new Error('Failed to fetch the media.');
      if (media.type !== 'audio') throw new Error('Only audio links are supported here.');
      const url = media.data?.url?.[0]?.url;
      if (!url) throw new Error('No audio link found.');
      return { items: [{ type: 'audio', url }], caption: '' };
    },
  },
  {
    name: 'twitter2', aliases: ['x2', 'twitterdl2'], usage: '<twitter/x link>', desc: 'Download Twitter/X videos', label: 'Twitter/X', ep: '/download/twitter2',
    resolve: (d) => {
      if (!d?.downloadLink) throw new Error('Failed to fetch the Twitter video.');
      return vid(d.downloadLink, `🐦 *Twitter/X*\n📝 ${d.videoTitle || 'Video'}`);
    },
  },
  {
    name: 'douyin', aliases: ['douyindl', 'dydl'], usage: '<douyin link>', desc: 'Download Douyin (Chinese TikTok) videos', label: 'Douyin', ep: '/download/douyin',
    resolve: (d) => {
      const url = d?.downloads?.[0]?.url || d?.downloads?.[1]?.url;
      if (!url) throw new Error('No video link found.');
      return vid(url, `🎬 *Douyin*\n📝 ${d.title || 'Video'}`);
    },
  },
  {
    name: 'snackvideo2', aliases: ['snack2', 'sv2'], usage: '<snackvideo link>', desc: 'SnackVideo download (second engine)', label: 'SnackVideo', ep: '/download/snackvideo2',
    resolve: (d) => {
      if (!d?.videoUrl) throw new Error('Failed to fetch the SnackVideo.');
      return vid(d.videoUrl, `🍿 *SnackVideo*\n📝 ${d.title || 'Video'}\n👤 ${d.creator?.name || 'Unknown'}`);
    },
  },
  {
    name: 'lahelu', aliases: ['laheludl', 'lhl'], usage: '<lahelu post link>', desc: 'Download videos from Lahelu', label: 'Lahelu', ep: '/download/lahelu',
    resolve: (d) => {
      if (!d?.media) throw new Error('Failed to fetch the Lahelu post.');
      return vid(d.media, `🎬 *Lahelu*\n📝 ${d.title || 'Video'}\n👤 ${d.userUsername || 'Unknown'}`);
    },
  },
  {
    name: 'threads', aliases: ['threadsdl'], usage: '<threads post link>', desc: 'Download media from a Threads post',
    check: /threads\.(net|com)\/@[^/]+\/post\//i, label: 'Threads post', ep: '/download/threads',
    resolve: (d) => {
      const medias = d?.medias || [];
      if (!medias.length) throw new Error('No downloadable media found in this post.');
      return { items: medias.map((m) => ({ type: m.type === 'video' ? 'video' : 'image', url: m.url })), caption: `🧵 *Threads*\n👤 ${d.author?.username ? '@' + d.author.username : 'Unknown'}\n📝 ${(d.description || '').slice(0, 150)}` };
    },
  },
  {
    name: 'pinterest', aliases: ['pin', 'pinterestdl'], usage: '<pinterest pin link>', desc: 'Download a Pinterest pin (image, video or carousel)',
    check: /pinterest\.com\/pin\/|pin\.it\//i, label: 'Pinterest pin', ep: '/download/pinterestdl',
    resolve: (d) => {
      const medias = d?.medias || [];
      if (!medias.length) throw new Error('No media found on this pin.');
      return { items: medias.map((m) => ({ type: m.type === 'video' ? 'video' : 'image', url: m.url })), caption: `📌 *${d.title || 'Pinterest'}*\n📝 ${(d.description || '').slice(0, 150)}` };
    },
  },
  {
    name: 'fastdl', aliases: ['fdl', 'fastinstagram'], usage: '<instagram username or link>', desc: 'Instagram profile details', label: 'Instagram username or link', ep: '/download/fastdl',
    resolve: (d) => {
      const u = d?.data?.[0]?.user;
      if (!u) throw new Error('Failed to fetch the Instagram data.');
      return { items: [{ type: 'image', url: u.profile_pic_url }], caption: `📸 *Instagram*\n👤 ${u.username}\n📛 ${u.full_name || 'No name'}\n👥 Followers: ${u.follower_count || 0}\n📷 Posts: ${u.media_count || 0}` };
    },
  },
  {
    name: 'ummy', aliases: ['ummydl', 'instagramdl'], usage: '<instagram username>', desc: 'Instagram profile details (second engine)', label: 'Instagram username', ep: '/download/ummy',
    resolve: (d) => {
      const u = d?.data?.[0]?.user;
      if (!u) throw new Error('Failed to fetch the Instagram data.');
      return { items: [{ type: 'image', url: u.profile_pic_url }], caption: `🖼️ *Instagram*\n👤 @${u.username}\n📛 ${u.full_name || 'No name'}\n📝 ${u.biography || 'No bio'}\n✅ Verified: ${u.is_verified ? 'Yes' : 'No'}\n👥 Followers: ${u.follower_count || 0}\n👤 Following: ${u.following_count || 0}\n📷 Posts: ${u.media_count || 0}` };
    },
  },
];

function register(add) {
  for (const s of SPECS) {
    add(s.name, 'Downloader', s.usage, s.desc, async (ctx) => {
      if (!extra.apiOn()) throw new Error(NEEDS_API);
      const text = (ctx.text || ctx.quoted?.text || '').trim();
      const parts = text.split(/\s+/).filter(Boolean);
      if (!parts.length) throw new Error(`Usage: ${ctx.prefix}${s.name} ${s.usage}`);
      const link = parts[0];
      const opts = parts.slice(1);
      if (s.check && !s.check.test(link)) throw new Error(`Please send a valid ${s.label} link.\nUsage: ${ctx.prefix}${s.name} ${s.usage}`);

      // 1) this downloader's own dedicated API path
      let out, primaryErr;
      try {
        const d = await extra.apiGet(s.ep, { url: link }, s.timeout || 30000);
        out = s.resolve(d, opts);
      } catch (e) {
        if (!GENERIC.has(s.name)) throw e; // gdrive, mediafire, mega, profile lookups: no general fallback
        primaryErr = e;
      }
      if (out) return void (await sendItems(ctx, out.items, out.caption, opts.some(isAudioOpt), out.audioUrl));

      // 2) the general downloader (savenow, then aio2, then 9xbuddy)
      try {
        await sendGeneric(ctx, link, opts);
      } catch (e2) {
        throw new Error('Could not download that link.\n- Dedicated service: ' + primaryErr.message + '\n- General service: ' + e2.message);
      }
    }, { aliases: s.aliases });
  }

  /* ---- GitHub repo as a zip (no API needed) ---- */
  add('gitclone', 'Downloader', '<github repo link>', 'Download a public GitHub repository as a zip file', async (ctx) => {
    const q = (ctx.text || ctx.quoted?.text || '').trim();
    const m = q.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
    if (!m) throw new Error(`Usage: ${ctx.prefix}gitclone https://github.com/user/repo`);
    const user = m[1], repo = m[2].replace(/\.git$/i, '');
    const r = await fetch(`https://api.github.com/repos/${user}/${repo}`, { headers: { 'user-agent': 'Hans-Mini-Bot/1.0' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) throw new Error('Repository not found. Make sure it is public.');
    if (!r.ok) throw new Error('GitHub returned HTTP ' + r.status + ' (rate limit?). Try again later.');
    const info = await r.json();
    await ctx.send({ document: { url: `https://api.github.com/repos/${user}/${repo}/zipball` }, fileName: `${user}-${repo}-${info.default_branch || 'main'}.zip`, mimetype: 'application/zip' });
  }, { aliases: ['gitdl', 'git', 'repodl', 'clone'] });

  /* ---- Pastebin text ---- */
  add('pastebin', 'Downloader', '<pastebin link>', 'Show the text of a Pastebin paste', async (ctx) => {
    if (!extra.apiOn()) throw new Error(NEEDS_API);
    const q = (ctx.text || ctx.quoted?.text || '').trim().split(/\s+/)[0];
    if (!/pastebin\.com/i.test(q)) throw new Error(`Usage: ${ctx.prefix}pastebin https://pastebin.com/abc123`);
    let content = await extra.apiGet('/download/pastebin', { url: q });
    if (typeof content !== 'string' || !content) throw new Error('Failed to fetch the paste. It may be private or deleted.');
    content = content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const id = q.split('/').pop().split('?')[0];
    const msg = `*PASTEBIN*\n*Paste ID:* ${id}\n━━━━━━━━━━━━━━━━━━━━\n\n${content}`;
    if (msg.length > 60000) await ctx.send({ document: Buffer.from(content, 'utf8'), fileName: `pastebin_${id}.txt`, mimetype: 'text/plain', caption: `📋 Paste ID: ${id}\n_Too long, sent as a file_` });
    else await ctx.reply(msg);
  }, { aliases: ['getpaste', 'paste', 'pastedl', 'pastebindl'] });

  /* ---- Spotify: link or song name ---- */
  add('spotify', 'Downloader', '<spotify link or song name> [doc]', 'Download a Spotify track as audio (add doc to get it as a file)', async (ctx) => {
    if (!extra.apiOn()) throw new Error(NEEDS_API);
    let q = (ctx.text || ctx.quoted?.text || '').trim();
    const asDoc = /\sdoc$/i.test(q);
    if (asDoc) q = q.replace(/\s+doc$/i, '').trim();
    if (!q) throw new Error(`Usage: ${ctx.prefix}spotify The Spectre Alan Walker\n${ctx.prefix}spotify https://open.spotify.com/track/...`);

    let buf, title;
    try {
      let trackUrl = q;
      if (!/spotify\.com/i.test(q)) {
        const j = await apiRaw('/search/spotifysearch', { query: q });
        const list = [j?.results, j?.data?.results, j?.data].find((x) => Array.isArray(x)) || [];
        const t = list[0];
        trackUrl = t && (t.url || t.link || t.spotify_url);
        if (!trackUrl) throw new Error('No tracks found. Try a direct Spotify link.');
      }
      const d = await extra.apiGet('/download/spotidown', { url: trackUrl });
      if (!d?.download_url) throw new Error(d?.type && d.type !== 'track' ? 'That is a playlist or album link. Send a single track.' : 'Could not get that track.');
      buf = await extra.toMp3(await extra.fetchBuf(d.download_url, extra.MAX_MB));
      title = d.title;
    } catch (e) {
      if (/spotify\.com/i.test(q)) throw e; // a Spotify link cannot be searched on YouTube
      try { ({ buf, title } = await spotifyViaYoutube(q)); }
      catch (e2) { throw new Error('Could not get that song.\n- Spotify service: ' + e.message + '\n- YouTube route: ' + e2.message); }
    }
    const quoted = { quoted: ctx.msg };
    if (asDoc) await ctx.sock.sendMessage(ctx.jid, { document: buf, mimetype: 'audio/mpeg', fileName: safeName(title, 'spotify_track') + '.mp3', caption: '🎧 ' + (title || 'Spotify Track') }, quoted);
    else await ctx.sock.sendMessage(ctx.jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, quoted);
  }, { aliases: ['spotifydl', 'spotidl', 'spoti'] });

  /* ---- TeraBox: one or several files ---- */
  add('terabox', 'Downloader', '<terabox link> [file number]', 'Download from TeraBox (if the link has several files, add the number)', async (ctx) => {
    if (!extra.apiOn()) throw new Error(NEEDS_API);
    const parts = (ctx.text || ctx.quoted?.text || '').trim().split(/\s+/).filter(Boolean);
    const link = parts[0] || '';
    if (!['terabox.com', '1024terabox.com', 'teraboxapp.com', 'terabox.app'].some((x) => link.includes(x))) throw new Error(`Usage: ${ctx.prefix}terabox https://1024terabox.com/s/xxxxx`);
    const d = await extra.apiGet('/download/terabox', { url: link }, 45000);
    const files = d?.files || [];
    if (!files.length) throw new Error('Failed to fetch the file from TeraBox.');
    const n = parseInt(parts[1], 10);
    if (files.length > 1 && !n) {
      return `📦 *${d.total_files || files.length} files found*\n` + files.slice(0, 20).map((f, i) => `${i + 1}. ${f.title} (${f.size || '?'})`).join('\n') + `\n\nReply with ${ctx.prefix}terabox ${link} <number> to download one.`;
    }
    const f = files[(n || 1) - 1];
    if (!f) throw new Error('There is no file with that number.');
    await ctx.send({ document: { url: f.download_url }, fileName: f.title || 'terabox_file', mimetype: mimeOf(f.title), caption: `📦 *TeraBox*\n📄 ${f.title}\n📦 ${f.size || 'Unknown'}` });
  }, { aliases: ['teraboxdl', 'tbdl', '1024terabox'] });

  /* ---- APK by app name ---- */
  add('apk', 'Downloader', '<app name>', 'Download an Android APK by app name', async (ctx) => {
    if (!extra.apiOn()) throw new Error(NEEDS_API);
    const q = (ctx.text || ctx.quoted?.text || '').trim();
    if (!q) throw new Error(`Usage: ${ctx.prefix}apk WhatsApp`);
    const d = await extra.apiGet('/api/download/apkdl', { appName: q }, 60000);
    if (!d) throw new Error('App not found. Try a different name.');
    if (!d.download_url) throw new Error('No download link is available for this app.');
    const caption = `*APK DOWNLOADER*\n\n*App:* ${d.appname || q}\n*Developer:* ${d.developer || 'Unknown'}\n\n_Downloading APK..._`;
    if (d.appicon) await ctx.send({ image: { url: d.appicon }, caption }); else await ctx.reply(caption);
    await ctx.send({ document: { url: d.download_url }, fileName: safeName(d.appname || q, 'app') + '.apk', mimetype: 'application/vnd.android.package-archive' });
  }, { aliases: ['app', 'apkdl', 'appdownload'] });
}

module.exports = { register, SPECS };
