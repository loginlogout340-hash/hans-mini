'use strict';
/**
 * health.js - a strict self-check. It tests, from THIS server, everything the bot depends on:
 *   the server itself (memory, disk, tools), the network, and every free download source.
 *
 *   .health        the owner gets a report in WhatsApp (about 15 seconds)
 *   .health full   also tests YouTube through yt-dlp (about 45 seconds)
 *
 * The same quick check runs once, a little after the bot starts, and is written to the Railway logs
 * (lines that start with [selfcheck]), so a dead source or a missing tool is noticed without anyone asking.
 *
 * ✅ works   🟡 answers but gave nothing for the test link (maybe fine, maybe changed)   ❌ down or broken
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const UPDATES = require('./updates');

const enc = encodeURIComponent;
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const TESTS = { // a public post for each site, used to ask the free services something real
  instagram: 'https://www.instagram.com/reel/C0000000000/',
  facebook: 'https://www.facebook.com/watch/?v=1234567890',
  tiktok: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
  twitter: 'https://x.com/jack/status/20',
  pinterest: 'https://www.pinterest.com/pin/99360735500167749/',
  threads: 'https://www.threads.net/@zuck/post/C0000000000',
  youtube: YT,
};

const run = (cmd, args, ms = 8000) => new Promise((ok) => execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (err, out, errout) => ok({ err, out: String(out || '').trim(), errout: String(errout || '').trim() })));
const why = (e) => String(e?.cause?.code || e?.message || e).replace(/\s+/g, ' ').slice(0, 48);
const secs = (ms) => (ms / 1000).toFixed(1) + 's';
const mb = (n) => Math.round(n / 1048576);

async function timed(fn) {
  const t = Date.now();
  try { return { ok: true, r: await fn(), ms: Date.now() - t }; } catch (e) { return { ok: false, e, ms: Date.now() - t }; }
}
// a probe returns { icon, text }
const good = (name, ms) => ({ icon: '✅', text: `${name} ${secs(ms)}` });
const maybe = (name, note) => ({ icon: '🟡', text: `${name} (${note})` });
const bad = (name, e) => ({ icon: '❌', text: `${name} (${why(e)})` });

/* ---------------------------- the server ---------------------------- */
async function serverLines() {
  const lines = [];
  const m = process.memoryUsage();
  lines.push(`Node ${process.version} · up ${Math.round(process.uptime() / 60)} min · memory ${mb(m.rss)} MB of ${mb(os.totalmem())} MB`);

  const dataDir = process.env.DATA_DIR || process.env.SESSION_DIR || './data';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const f = path.join(dataDir, '.selfcheck');
    fs.writeFileSync(f, String(Date.now()));
    fs.unlinkSync(f);
    const df = await run('df', ['-Pk', dataDir], 5000);
    const free = (df.out.split('\n')[1] || '').split(/\s+/)[3];
    lines.push(`✅ Data folder ${dataDir} can be written${free ? ' · ' + (Number(free) / 1048576).toFixed(1) + ' GB free' : ''}`);
  } catch (e) { lines.push(`❌ Data folder ${dataDir} cannot be written (${why(e)}). Users would lose their links on every restart.`); }

  const [yt, ff] = await Promise.all([run('yt-dlp', ['--version']), run('ffmpeg', ['-version'])]);
  lines.push(yt.err ? '❌ yt-dlp is missing (downloads from YouTube and many sites will fail)' : `✅ yt-dlp ${yt.out.split('\n')[0]}`);
  lines.push(ff.err ? '❌ ffmpeg is missing (stickers, audio and video conversion will fail)' : `✅ ffmpeg ${(ff.out.match(/version (\S+)/) || [])[1] || ''}`.trim());
  let mega = true;
  try { require.resolve('megajs'); } catch { mega = false; }
  lines.push(mega ? '✅ megajs installed (.mega works)' : '🟡 megajs is not installed (.mega will not work; check package.json)');
  let mixer = true;
  try { require.resolve('emoji-mixer'); } catch { mixer = false; }
  lines.push(mixer ? '✅ emoji-mixer installed' : '🟡 emoji-mixer is not installed (.emojimix will not work; check package.json)');

  const env = (n) => (process.env[n] ? '✅' : '➖');
  lines.push(`Settings: ADMIN_NUMBER ${env('ADMIN_NUMBER')} · PUBLIC_URL ${env('PUBLIC_URL')} · ACCESS_CODE ${env('ACCESS_CODE')} · ADMIN_KEY ${env('ADMIN_KEY')} · PAYSTACK ${env('PAYSTACK_SECRET')}  (➖ = not set)`);
  return lines;
}

/* ---------------------------- the network ---------------------------- */
async function reach(name, url) {
  const t = await timed(async () => {
    const r = await fetch(url, { method: 'GET', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
    if (r.status >= 500) throw new Error('HTTP ' + r.status);
    return r.status;
  });
  return t.ok ? good(name, t.ms) : bad(name, t.e);
}

/* ---------------------------- the music sources ---------------------------- */
async function musicProbes() {
  let m;
  try { m = require('./music'); } catch (e) { return [bad('music.js', e)]; }
  return Promise.all(m.PROVIDERS.map(async (p) => {
    const t = await timed(() => m.linkFrom(p, YT));
    if (t.ok) return good(p.name, t.ms);
    if (/no link in the answer/.test(t.e.message)) return maybe(p.name, 'answers, no link');
    return bad(p.name, t.e);
  }));
}

/* ---------------------------- the video and picture sources ---------------------------- */
async function mediaProbes() {
  let g;
  try { g = require('./getmedia'); } catch (e) { return { Error: [bad('getmedia.js', e)] }; }
  const out = {};
  const put = (k, r) => { (out[k] ||= []).push(r); };
  const jobs = [];

  // dedicated free services
  jobs.push((async () => {
    const t = await timed(() => g.getJson('https://www.tikwm.com/api/?url=' + enc(TESTS.tiktok), 15000));
    if (!t.ok) return put('tiktok', bad('tikwm', t.e));
    if (t.r.code === 0) return put('tiktok', good('tikwm', t.ms));
    put('tiktok', /limit/i.test(String(t.r.msg)) ? maybe('tikwm', 'busy, normal') : maybe('tikwm', String(t.r.msg || 'no data').slice(0, 30)));
  })());
  for (const [name, url] of [['fxtwitter', 'https://api.fxtwitter.com/jack/status/20'], ['vxtwitter', 'https://api.vxtwitter.com/jack/status/20']]) {
    jobs.push((async () => {
      const t = await timed(() => g.getJson(url, 12000));
      if (!t.ok) return put('twitter', bad(name, t.e));
      put('twitter', t.r.tweet || t.r.text || t.r.user_name ? good(name, t.ms) : maybe(name, 'answers, no tweet'));
    })());
  }

  // community services, one test per site
  for (const [platform, list] of Object.entries(g.COMMUNITY)) {
    for (const [name, tpl] of list) {
      jobs.push((async () => {
        const u = tpl.replace('{u}', enc(TESTS[platform] || YT)).replace('{q}', '360');
        const t = await timed(async () => g.mediaFromJson(await g.getJson(u, 15000)));
        if (!t.ok) return put(platform, bad(name, t.e));
        put(platform, t.r.videos.length || t.r.images.length ? good(name, t.ms) : maybe(name, 'answers, no media'));
      })());
    }
  }
  await Promise.all(jobs);
  return out;
}

/* ---------------------------- the full YouTube test ---------------------------- */
async function youtubeProbe() {
  const t = await timed(() => new Promise((ok, no) => {
    execFile('yt-dlp', ['--simulate', '--no-warnings', '--no-playlist', '--force-ipv4', '--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=tv,android_vr,web_safari', '--print', 'title', YT],
      { timeout: 60000, maxBuffer: 1 << 20 }, (err, out, errout) => (err ? no(new Error(String(errout || err.message).split('\n').filter(Boolean).slice(-1)[0] || 'failed')) : ok(out.trim())));
  }));
  if (t.ok) return { icon: '✅', text: `YouTube through yt-dlp works from this server ${secs(t.ms)}` };
  const msg = why(t.e);
  return { icon: '❌', text: `YouTube blocks this server for yt-dlp (${msg}). The free sources and SoundCloud still work for music.` };
}

/* ---------------------------- the report ---------------------------- */
const line = (r) => `${r.icon} ${r.text}`;
const score = (list) => `${list.filter((r) => r.icon === '✅').length}/${list.length}`;
const PLATFORM_NAMES = { terabox: 'TeraBox', tiktok: 'TikTok', twitter: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', pinterest: 'Pinterest', threads: 'Threads', youtube: 'YouTube video' };

async function collect(full) {
  const [server, wa, ai, music, media, yt] = await Promise.all([
    serverLines(),
    reach('WhatsApp', 'https://web.whatsapp.com/'),
    reach('AI service', 'https://text.pollinations.ai/'),
    musicProbes(),
    mediaProbes(),
    full ? youtubeProbe() : Promise.resolve(null),
  ]);
  const [meme, apk, mf, gd, pb] = await Promise.all([
    reach('Meme service', 'https://meme-api.com/gimme'),
    reach('Aptoide (.apk)', 'https://ws75.aptoide.com/api/7/apps/search?query=a&limit=1'),
    reach('MediaFire', 'https://www.mediafire.com/'),
    reach('Google Drive', 'https://drive.usercontent.google.com/'),
    reach('Pastebin', 'https://pastebin.com/'),
  ]);
  return { server, net: [wa, ai, meme, apk, mf, gd, pb], music, media, yt };
}

function format(rep, full) {
  const out = [`🩺 *Hans-Mini health* v${UPDATES.version}`, '', '🖥️ *Server*', ...rep.server.map((l) => (/^[✅❌🟡]/.test(l) ? l : '• ' + l)), '', '🌐 *Network*', ...rep.net.map(line)];
  out.push('', `🎵 *Music sources* (${score(rep.music)} work)`, ...rep.music.map(line));
  out.push('', '🎬 *Video and picture sources*');
  for (const [k, list] of Object.entries(rep.media)) out.push(`${PLATFORM_NAMES[k] || k} (${score(list)}): ` + list.map((r) => `${r.icon}${r.text.split(' ')[0]}${r.icon === '✅' ? '' : r.text.slice(r.text.indexOf(' '))}`).join(' · '));
  if (rep.yt) out.push('', rep.yt.icon + ' ' + rep.yt.text);
  out.push('', '✅ works · 🟡 answers but gave nothing for the test link · ❌ down or broken');
  if (!full) out.push('Add "full" to also test YouTube: .health full');
  return out.join('\n');
}

async function report(full) { return format(await collect(full), full); }

// quick check for the Railway logs, a little after the bot starts
let logged = false;
function logOnce() {
  if (logged) return;
  logged = true;
  setTimeout(async () => {
    try {
      const rep = await collect(false);
      for (const l of format(rep, false).split('\n')) if (l.trim()) console.log('[selfcheck] ' + l);
    } catch (e) { console.error('[selfcheck] failed:', e.message); }
  }, 20000).unref();
}

function register(add) {
  add('health', 'Owner', '[full]', 'Check that the server, the tools and every download source work', async (ctx) => {
    // it shows details of the whole server, so only the admin bot may use it (falls back to the owner when selfheal.js is missing)
    try { require('./selfheal').adminOnly(ctx); } catch (e) { if (!/Admin tools are not available/.test(e.message)) throw e; if (!ctx.isMainOwner) throw new Error('Only the owner of this bot can use this command.'); }
    const full = /^full$/i.test(ctx.args[0] || '');
    await ctx.reply(`🩺 Checking everything from this server${full ? ' (including YouTube)' : ''}. This takes about ${full ? '45' : '15'} seconds...`);
    return report(full);
  }, { owner: true, aliases: ['selfcheck', 'diagnose'] });
}

module.exports = { register, report, logOnce };
