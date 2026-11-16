'use strict';
/**
 * selfheal.js - the bot keeps fixing itself.
 *
 * What it does by itself, with nobody asking:
 *  1. SOURCE DOCTOR   Every download source (music, video, pictures) is scored by how often it really worked.
 *                     The best sources are tried first, a source that keeps failing drops to the back, and
 *                     it moves forward again as soon as it works. The scores are saved, so a restart does not forget them.
 *  2. LIVE FIXES      Every hour the bot reads sources.json from your GitHub repo. When a free service dies you edit that
 *                     one JSON file (on your phone, on github.com) and every running bot switches within an hour.
 *                     No redeploy, no code change. The last good copy is kept, so a restart or a GitHub outage is fine.
 *  3. YT-DLP UPDATES  yt-dlp is updated every 12 hours, and straight away when YouTube keeps refusing the server.
 *  4. CLEAN-UP        Leftover temp files from crashed downloads are removed every 20 minutes.
 *  5. MEMORY          When the server memory is nearly full, caches are cleared before it can crash.
 *  6. CONNECTIONS     bot.js has a watchdog: a bot that is stuck or offline for 5 minutes reconnects by itself.
 *  7. REPORT          What was repaired is kept in a log (.selfheal) and sent to the admin in one short message
 *                     (at most every 6 hours, only when something real was fixed).
 *
 *   .selfheal            the admin sees the state (needs ADMIN_NUMBER, like .broadcast)
 *   .selfheal run        do everything now
 *   .errors              the commands that fail most often (phone numbers are hidden)
 *
 * The bot never rewrites its own code: a bot that edits itself without a human can break itself.
 * Code fixes go through GitHub (Railway redeploys on every commit); this file fixes everything that can be fixed safely at run time.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const dataDir = () => process.env.DATA_DIR || process.env.SESSION_DIR || './data';
const stateDir = () => path.join(dataDir(), 'selfheal');
const SOURCES_URL = process.env.SOURCES_URL || 'https://raw.githubusercontent.com/loginlogout340-hash/hans-mini/main/sources.json';
const mb = (n) => Math.round(n / 1048576);
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ago'; };

/* ============================== the log ============================== */
const events = []; // { t, kind, text }
const NOTABLE = new Set(['ytdlp', 'watchdog', 'config', 'pressure', 'conflict', 'sources']); // these are worth telling the admin
function noteEvent(kind, text) {
  events.push({ t: Date.now(), kind, text: String(text).slice(0, 180) });
  if (events.length > 200) events.shift();
  console.log(`[selfheal] ${kind}: ${text}`);
}

const errors = new Map(); // "label|message" -> { label, msg, n, last }
function noteError(label, err) {
  try {
    const msg = String(err?.message || err).split('\n')[0].replace(/\d{7,}/g, '#').slice(0, 110); // phone numbers are never kept
    const k = label + '|' + msg;
    const e = errors.get(k) || { label, msg, n: 0, last: 0 };
    e.n++; e.last = Date.now();
    errors.set(k, e);
    if (errors.size > 300) errors.delete(errors.keys().next().value);
  } catch { /* never breaks anything */ }
}

/* ============================== 1. the source doctor ============================== */
let stats = {}; // key -> { ok, fail, ms, last, lastOk, streak }
let dirty = false;
function loadStats() { try { stats = JSON.parse(fs.readFileSync(path.join(stateDir(), 'stats.json'), 'utf8')) || {}; } catch { stats = {}; } }
function saveStats() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const f = path.join(stateDir(), 'stats.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(stats));
    fs.renameSync(f + '.tmp', f);
  } catch { /* disk problem: the scores just are not saved this time */ }
}
/** a source was tried: did it work, and how long did it take */
function record(key, ok, ms = 0) {
  const s = (stats[key] ||= { ok: 0, fail: 0, ms: 0, last: 0, lastOk: 0, streak: 0 });
  // recent results count most: a source that works again is forgiven quickly, one that starts failing is noticed quickly
  if (ok) { s.ok++; s.fail = Math.floor(s.fail / 2); s.streak = 0; s.lastOk = Date.now(); s.ms = s.ms ? Math.round(s.ms * 0.7 + ms * 0.3) : ms; }
  else { s.fail++; s.ok = Math.ceil(s.ok * 0.85); s.streak++; }
  s.last = Date.now();
  if (s.ok + s.fail > 60) { s.ok = Math.round(s.ok / 2); s.fail = Math.round(s.fail / 2); } // old history fades, so a source that died is noticed fast
  dirty = true;
}
function score(key) {
  const s = stats[key];
  if (!s) return 0.5; // unknown sources get a fair chance
  let v = (s.ok + 1) / (s.ok + s.fail + 2);
  if (s.streak >= 4 && Date.now() - s.last < 30 * 60000) v *= 0.15; // failing right now
  if (Date.now() - s.lastOk < 3600000) v += 0.1; // worked within the last hour
  if (s.ms > 8000) v -= 0.05; // slow
  return v;
}
/** the same list, best source first (a stable sort: equal scores keep their order) */
function rank(items, keyOf) {
  return items.map((it, i) => ({ it, i, sc: score(keyOf(it)) })).sort((a, b) => b.sc - a.sc || a.i - b.i).map((x) => x.it);
}

/* ============================== 2. live fixes from sources.json ============================== */
const appliers = {}; // 'music' | 'community' -> function(list, disabled)
function onConfig(kind, fn) { appliers[kind] = fn; if (lastConfig) { try { fn(lastConfig[kind], lastConfig.disabled); } catch { /* ignore */ } } }
let lastConfig = null; // the last good, checked copy of sources.json
const remote = { version: '', at: 0, ok: null, error: '' };

const goodName = (n) => typeof n === 'string' && /^[\w .-]{1,30}$/.test(n);
const goodTpl = (t) => typeof t === 'string' && /^https:\/\/[^\s]+$/i.test(t) && t.includes('{u}') && t.length < 400;
/** checks the shape of sources.json; anything strange is dropped. It is DATA only: nothing in it is ever run as code. */
function parseConfig(j) {
  if (!j || typeof j !== 'object') throw new Error('sources.json is not a JSON object');
  const out = { disabled: [], music: null, community: null };
  if (Array.isArray(j.disabled)) out.disabled = j.disabled.filter(goodName).slice(0, 50);
  if (Array.isArray(j.music)) {
    out.music = j.music.filter((r) => r && goodName(r.name) && (goodTpl(r.get) || (typeof r.post === 'string' && /^https:\/\//i.test(r.post) && r.form && typeof r.form === 'object'))).slice(0, 20)
      .map((r) => (r.get ? { name: r.name, get: r.get } : { name: r.name, post: r.post, form: Object.fromEntries(Object.entries(r.form).slice(0, 8).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 100)])) }));
  }
  if (j.community && typeof j.community === 'object') {
    out.community = {};
    for (const [platform, list] of Object.entries(j.community)) {
      if (!/^[a-z]{3,12}$/.test(platform) || !Array.isArray(list)) continue;
      out.community[platform] = list.filter((p) => Array.isArray(p) && goodName(p[0]) && goodTpl(p[1])).slice(0, 20).map((p) => [p[0], p[1]]);
    }
  }
  return out;
}
function applyConfig(cfg) {
  lastConfig = cfg;
  for (const kind of ['music', 'community']) {
    if (!appliers[kind]) continue;
    try { appliers[kind](cfg[kind], cfg.disabled); } catch (e) { noteEvent('config', `could not apply ${kind}: ${e.message}`); }
  }
}
function loadConfigCache() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir(), 'remote.json'), 'utf8'));
    remote.version = String(j.version ?? '');
    applyConfig(parseConfig(j));
  } catch { /* no saved copy yet */ }
}
async function refreshRemote() {
  try {
    const r = await fetch(SOURCES_URL, { headers: { 'cache-control': 'no-cache', 'user-agent': 'Hans-Mini' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) { remote.ok = null; remote.error = 'no sources.json in the repo (that is fine)'; remote.at = Date.now(); return remote; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const cfg = parseConfig(j); // throws on garbage, so a broken edit never reaches the bot
    const ver = String(j.version ?? '');
    applyConfig(cfg);
    if (ver !== remote.version) noteEvent('config', `sources.json version ${ver || '?'} applied (was ${remote.version || 'none'})`);
    remote.version = ver; remote.ok = true; remote.error = ''; remote.at = Date.now();
    try { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(path.join(stateDir(), 'remote.json'), JSON.stringify(j)); } catch { /* ignore */ }
  } catch (e) {
    remote.ok = false; remote.error = String(e.cause?.code || e.message).slice(0, 80); remote.at = Date.now(); // the old good copy stays in use
  }
  return remote;
}

/* ============================== 3. yt-dlp updates ============================== */
const runCmd = (cmd, args, ms) => new Promise((ok) => execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (err, out, errout) => ok({ err, out: String(out || '').trim(), errout: String(errout || '').trim() })));
let lastUpdate = 0;
let ytFails = [];
async function updateYtdlp(reason, force = false) {
  if (!force && Date.now() - lastUpdate < 3 * 3600000) return 'skipped: updated less than 3 hours ago';
  lastUpdate = Date.now();
  const before = (await runCmd('yt-dlp', ['--version'], 8000)).out;
  if (!before) { noteEvent('ytdlp', 'yt-dlp is not installed on this server'); return 'yt-dlp is not installed'; }
  const r = await runCmd('yt-dlp', ['-U'], 120000);
  const after = (await runCmd('yt-dlp', ['--version'], 8000)).out;
  if (after && after !== before) { noteEvent('ytdlp', `yt-dlp updated ${before} -> ${after} (${reason})`); return `updated ${before} -> ${after}`; }
  if (r.err && !/up to date|latest/i.test(r.out + r.errout)) { noteEvent('info', `yt-dlp update did not work (${(r.errout || r.err.message).split('\n').slice(-1)[0].slice(0, 80)})`); return 'the update did not work'; }
  return `already the newest (${after})`;
}
/** called by the download code when something fails; YouTube refusing the server again and again triggers an update */
function noteFailure(kind, msg) {
  if (kind !== 'youtube') return;
  if (!/sign in|not a bot|nsig|unable to extract|player|HTTP Error 403|\b403\b/i.test(String(msg))) return;
  const now = Date.now();
  ytFails = ytFails.filter((t) => now - t < 30 * 60000);
  ytFails.push(now);
  if (ytFails.length >= 3) { ytFails = []; updateYtdlp('YouTube kept refusing', false).catch(() => {}); }
}

/* ============================== 4. clean-up ============================== */
function janitor() {
  let n = 0, bytes = 0;
  const cutoff = Date.now() - 30 * 60000;
  try {
    const dir = os.tmpdir();
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('hm-')) continue; // only files the bot made itself
      const p = path.join(dir, f);
      try { const st = fs.statSync(p); if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(p); n++; bytes += st.size; } } catch { /* gone already */ }
    }
  } catch { /* no temp folder to look in */ }
  if (n) noteEvent('janitor', `removed ${n} leftover temp file(s) (${mb(bytes)} MB)`);
  return n;
}

/* ============================== 5. memory ============================== */
const pressureFns = [];
function onPressure(fn) { pressureFns.push(fn); }
function memLimit() {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const n = Number(fs.readFileSync(f, 'utf8').trim()); if (n > 0 && n < 1e15) return n; } catch { /* try the next */ }
  }
  return os.totalmem();
}
let lastPressure = 0;
function memCheck() {
  const rss = process.memoryUsage().rss, limit = memLimit();
  if (rss / limit < 0.85) return false;
  if (Date.now() - lastPressure > 10 * 60000) { lastPressure = Date.now(); noteEvent('pressure', `memory ${mb(rss)} of ${mb(limit)} MB: caches cleared`); }
  for (const fn of pressureFns) { try { fn(); } catch { /* ignore */ } }
  return true;
}

/* ============================== 7. the report to the admin ============================== */
let lastDigest = Date.now() - 6 * 3600000 + 30 * 60000; // the first report can go out 30 minutes after the start, then at most every 6 hours
function digest() {
  const fresh = events.filter((e) => e.t > lastDigest && NOTABLE.has(e.kind));
  if (!fresh.length || Date.now() - lastDigest < 6 * 3600000) return false;
  lastDigest = Date.now();
  try {
    const lines = fresh.slice(-8).map((e) => '• ' + e.text);
    require('./manager').notifyAdmin(`🛠️ *Self-heal report*\n${lines.join('\n')}\n\nDetails: .selfheal`);
  } catch { /* no admin bot: the log still has everything */ }
  return true;
}

/* ============================== running it ============================== */
let started = false;
function start() {
  if (started) return;
  started = true;
  loadStats();
  loadConfigCache();
  const every = (fn, ms, first) => { setTimeout(() => { Promise.resolve().then(fn).catch(() => {}); }, first).unref(); setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms).unref(); };
  every(refreshRemote, 60 * 60000, 45000);
  every(janitor, 20 * 60000, 60000);
  every(() => updateYtdlp('scheduled'), 12 * 3600000, 5 * 60000);
  every(digest, 30 * 60000, 30 * 60000);
  setInterval(memCheck, 60000).unref();
  setInterval(saveStats, 60000).unref();
  process.on('beforeExit', saveStats);
}

/* ============================== commands ============================== */
/** only the admin bot (ADMIN_NUMBER) may use these: they show things about the whole server */
function adminOnly(ctx) {
  let m;
  try { m = require('./manager'); } catch { throw new Error('Admin tools are not available.'); }
  if (!process.env.ADMIN_NUMBER) throw new Error('Admin tools are off. Add the Railway variable ADMIN_NUMBER.');
  if (!ctx.isMainOwner || !m.isAdmin(ctx.config.owners[0])) throw new Error('This command only works on the admin bot.');
}

function stateText(prefix) {
  const keys = Object.keys(stats).sort((a, b) => score(b) - score(a));
  const row = (k) => { const s = stats[k]; return `${score(k) >= 0.5 ? '🟢' : score(k) >= 0.25 ? '🟡' : '🔴'} ${k} · ${s.ok} ok / ${s.fail} failed${s.lastOk ? ' · worked ' + ago(s.lastOk) : ''}`; };
  const out = ['🛠️ *Self-heal*', ''];
  out.push(`📥 sources.json: ${remote.ok === true ? `✅ version ${remote.version || '?'}, read ${ago(remote.at)}` : remote.ok === false ? `⚠️ could not be read (${remote.error}); the last good copy is in use` : remote.at ? 'not in the repo (the built-in lists are used)' : 'not read yet'}`);
  out.push(`🔧 yt-dlp: ${lastUpdate ? 'last update check ' + ago(lastUpdate) : 'updates every 12 hours'}`);
  out.push(`🔌 Reconnects by the watchdog since start: ${events.filter((e) => e.kind === 'watchdog').length}`);
  out.push('', '🏅 *Sources, best first*');
  if (!keys.length) out.push('Nothing has been tried yet.');
  else {
    out.push(...keys.slice(0, 8).map(row));
    if (keys.length > 8) out.push('…', ...keys.slice(-4).map(row));
  }
  out.push('', '📜 *What it repaired lately*');
  const rec = events.filter((e) => e.kind !== 'info').slice(-10).reverse();
  out.push(...(rec.length ? rec.map((e) => `• ${ago(e.t)}: ${e.text}`) : ['Nothing needed repairing.']));
  out.push('', `${prefix}selfheal run  ·  ${prefix}errors  ·  ${prefix}health`);
  return out.join('\n');
}

function register(add) {
  add('selfheal', 'Admin', '[run]', 'See what the bot repaired by itself, or run all repairs now', async (ctx) => {
    adminOnly(ctx);
    if ((ctx.args[0] || '').toLowerCase() === 'run') {
      await ctx.reply('🛠️ Running all repairs now...');
      const [src, up] = await Promise.all([refreshRemote(), updateYtdlp('asked by the admin', true)]);
      const cleaned = janitor();
      const mem = memCheck();
      return `✅ Done\n• sources.json: ${src.ok === true ? 'read, version ' + (src.version || '?') : src.ok === false ? 'could not be read (' + src.error + ')' : src.error}\n• yt-dlp: ${up}\n• Temp files removed: ${cleaned}\n• Memory: ${mem ? 'high, caches cleared' : 'fine'}`;
    }
    return stateText(ctx.prefix);
  }, { owner: true, aliases: ['autofix', 'heal'] });

  add('errors', 'Admin', '[clear]', 'The commands that fail most often (for the admin)', (ctx) => {
    adminOnly(ctx);
    if ((ctx.args[0] || '').toLowerCase() === 'clear') { errors.clear(); return '🧹 Error list cleared.'; }
    const rows = [...errors.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 12);
    if (!rows.length) return '✅ No errors since the bot started.';
    return `🐞 *Most common errors* (since the bot started)\n\n${rows.map((e) => `${e.n}× .${e.label} · ${e.msg} · ${ago(e.last)}`).join('\n')}\n\nSend this list to whoever maintains the bot. ${ctx.prefix}errors clear to reset.`;
  }, { owner: true, aliases: ['errorlog'] });
}

module.exports = {
  start, register, adminOnly,
  noteEvent, noteError, noteFailure,
  record, score, rank,
  onConfig, onPressure,
  refreshRemote, updateYtdlp, janitor, memCheck, digest,
  parseConfig, // exported so it can be tested
  get events() { return events; },
};
