'use strict';
/**
 * Hans-Mini more6.js - group admin tools and handy utilities
 *   Group       : .poll   (kick, add, promote and demote already exist in commands.js)
 *   Stickers    : .sticker (photo / short video -> sticker)   .toimg (sticker -> picture)
 *   Utilities   : .remind  .reminders  .tts  .shorten  .ss  .ytsearch
 *
 * Loaded from more.js with two lines:
 *   require('./more6').register(add);     (in register)
 *   require('./more6').boot(sock);        (in boot, so reminders keep working after a restart)
 * Needs: ffmpeg (already in the Dockerfile) and "sharp" + "yt-search" (already in package.json).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const heavy = require('./limit').run; // limits how many ffmpeg jobs run at once

const num = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
const norm = (j) => String(j || '').replace(/:\d+@/, '@');
const jidOf = (d) => d + '@s.whatsapp.net';
const hmOf = (sock) => sock.hm;

/** who the command is about: @mentions, the replied person, or numbers typed after the command */
function targets(ctx) {
  if (ctx.mentioned.length) return ctx.mentioned;
  if (ctx.quoted?.participant) return [ctx.quoted.participant];
  return ctx.args.map((a) => a.replace(/\D/g, '')).filter((d) => d.length >= 7).map(jidOf);
}

const tmp = (ext) => path.join(os.tmpdir(), 'hm6-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext);
function ffmpeg(args, timeout = 90000) {
  return new Promise((ok, no) => heavy('ffmpeg', ['-y', ...args], { timeout }, (err, _o, e) => (err ? no(new Error(String(e || err.message).split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed')) : ok())));
}
const rm = (...f) => f.forEach((x) => fs.unlink(x, () => {}));
const sharpLib = () => {
  try { return require('sharp'); } catch { throw new Error('The picture tool is missing on the server (add "sharp" to package.json and redeploy).'); }
};
const isImage = (b) => (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') || b.slice(0, 3).toString() === 'GIF';

/* ---------------- stickers ---------------- */
async function toSticker(buf) {
  if (isImage(buf) && buf.slice(0, 3).toString() !== 'GIF') {
    return sharpLib()(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
  }
  // video / gif -> animated webp (max 6 seconds)
  const inp = tmp('in'); const out = tmp('webp');
  try {
    fs.writeFileSync(inp, buf);
    for (const q of [45, 30, 18]) {
      await ffmpeg(['-i', inp, '-t', '6', '-an', '-vf',
        'fps=12,scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
        '-loop', '0', '-vcodec', 'libwebp', '-q:v', String(q), out]);
      const o = fs.readFileSync(out);
      if (o.length < 900 * 1024 || q === 18) return o;
    }
  } finally { rm(inp, out); }
}

/* ---------------- reminders ---------------- */
const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseWait(s) {
  const m = String(s || '').toLowerCase().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  return m ? Math.round(Number(m[1]) * UNITS[m[2]]) : 0;
}
const fmtLeft = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return s + ' sec';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 129600) return Math.round(s / 3600 * 10) / 10 + ' h';
  return Math.round(s / 86400 * 10) / 10 + ' days';
};

function boot(sock) {
  const hm = hmOf(sock);
  if (!hm) return;
  clearInterval(hm.remindTimer);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const list = hm.db.reminders || [];
      const now = Date.now();
      let changed = false;
      for (const r of [...list]) {
        if (r.at > now) continue;
        try {
          await sock.sendMessage(r.to, { text: `⏰ *Reminder*\n${r.text}`, mentions: r.who ? [r.who] : [] });
          list.splice(list.indexOf(r), 1); changed = true;
        } catch (e) {
          if (now - r.at > 3600000) { list.splice(list.indexOf(r), 1); changed = true; }
        }
      }
      if (changed) hm.save();
    } finally { busy = false; }
  };
  hm.remindTimer = setInterval(tick, 10000);
  sock.ev.on('connection.update', ({ connection }) => { if (connection === 'close') clearInterval(hm.remindTimer); });
}

/* ---------------- register ---------------- */
function register(add) {
  add('poll', 'Group', 'Question | option 1 | option 2 ...', 'Create a poll', async (ctx) => {
    const parts = ctx.text.split('|').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) throw new Error(`Usage: ${ctx.prefix}poll Best food? | Jollof | Waakye | Banku`);
    if (parts.length > 13) throw new Error('A poll can have at most 12 options.');
    await ctx.sock.sendMessage(ctx.jid, { poll: { name: parts[0].slice(0, 200), values: parts.slice(1).map((o) => o.slice(0, 90)), selectableCount: 1 } });
  }, { aliases: ['vote'] });

  /* ----- stickers ----- */
  add('sticker', 'Media', '(reply to a photo or short video)', 'Turn a photo or short video into a sticker', async (ctx) => {
    let buf;
    try { buf = await ctx.downloadMedia(); } catch { throw new Error(`Reply to a photo or short video with ${ctx.prefix}sticker.`); }
    const webp = await toSticker(buf);
    await ctx.sock.sendMessage(ctx.jid, { sticker: webp }, { quoted: ctx.msg });
  }, { aliases: ['s', 'stick', 'tosticker'] });

  add('toimg', 'Media', '(reply to a sticker)', 'Turn a sticker back into a picture', async (ctx) => {
    let buf;
    try { buf = await ctx.downloadMedia(); } catch { throw new Error(`Reply to a sticker with ${ctx.prefix}toimg.`); }
    const png = await sharpLib()(buf).png().toBuffer();
    await ctx.sock.sendMessage(ctx.jid, { image: png, caption: '🖼️ Done' }, { quoted: ctx.msg });
  }, { aliases: ['toimage', 'unsticker'] });

  /* ----- reminders ----- */
  add('remind', 'Utility', '<10m|2h|1d> <what>', 'Get a reminder message after a time', (ctx) => {
    const wait = parseWait(ctx.args[0]);
    const text = ctx.args.slice(1).join(' ').trim();
    if (!wait || !text) throw new Error(`Usage: ${ctx.prefix}remind 30m call mum\nTime: 30s, 10m, 2h or 1d (max 30 days).`);
    if (wait > 30 * 86400000) throw new Error('The longest reminder is 30 days.');
    const { db, save } = hmOf(ctx.sock);
    const who = ctx.isGroup ? ctx.msg.key.participant || ctx.msg.participant : undefined;
    (db.reminders ||= []).push({ to: ctx.jid, at: Date.now() + wait, text: text.slice(0, 500), who: who ? norm(who) : undefined });
    save();
    return `⏰ OK, I will remind you in *${fmtLeft(wait)}*: ${text}`;
  }, { aliases: ['reminder', 'remindme'] });

  add('reminders', 'Utility', '', 'List your pending reminders here', (ctx) => {
    const list = (hmOf(ctx.sock).db.reminders || []).filter((r) => r.to === ctx.jid);
    if (!list.length) return 'You have no pending reminders in this chat.';
    return '⏰ *Reminders*\n' + list.map((r, i) => `${i + 1}. in ${fmtLeft(r.at - Date.now())}: ${r.text}`).join('\n');
  }, { aliases: ['myreminders'] });

  /* ----- text to speech ----- */
  add('tts', 'Utility', '[language] <text>', 'Turn text into a voice note (example: .tts en Hello)', async (ctx) => {
    let lang = 'en'; let text = ctx.text || ctx.quoted?.text || '';
    const m = text.match(/^([a-z]{2}(?:-[A-Za-z]{2})?)\s+([\s\S]+)$/);
    if (m && ctx.text) { lang = m[1]; text = m[2]; }
    text = text.trim();
    if (!text) throw new Error(`Usage: ${ctx.prefix}tts Hello how are you\nOther language: ${ctx.prefix}tts fr Bonjour`);
    if (text.length > 190) throw new Error('Keep it under 190 characters.');
    const r = await fetch('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text), {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('The voice service did not answer (HTTP ' + r.status + ').');
    const mp3 = Buffer.from(await r.arrayBuffer());
    const inp = tmp('mp3'); const out = tmp('ogg');
    try {
      fs.writeFileSync(inp, mp3);
      await ffmpeg(['-i', inp, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', out]);
      await ctx.sock.sendMessage(ctx.jid, { audio: fs.readFileSync(out), mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: ctx.msg });
    } finally { rm(inp, out); }
  }, { aliases: ['speak', 'say'] });

  /* ----- links ----- */
  add('shorten', 'Utility', '<link>', 'Make a long link short', async (ctx) => {
    const u = (ctx.text || ctx.quoted?.text || '').trim();
    if (!/^https?:\/\/\S+$/i.test(u)) throw new Error(`Usage: ${ctx.prefix}shorten https://example.com/very/long/link`);
    const r = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(u), { signal: AbortSignal.timeout(15000) });
    const t = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//.test(t)) throw new Error('Could not shorten that link.');
    return '🔗 ' + t;
  }, { aliases: ['short', 'tinyurl'] });

  add('ss', 'Utility', '<website link>', 'Take a screenshot of a website', async (ctx) => {
    let u = (ctx.text || '').trim();
    if (!u) throw new Error(`Usage: ${ctx.prefix}ss https://example.com`);
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u)) throw new Error('That does not look like a website link.');
    const r = await fetch('https://image.thum.io/get/width/1280/crop/800/noanimate/' + u, { signal: AbortSignal.timeout(45000) });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok || buf.length < 2000) throw new Error('Could not take a screenshot of that site.');
    await ctx.sock.sendMessage(ctx.jid, { image: buf, caption: '🖥️ ' + u }, { quoted: ctx.msg });
  }, { aliases: ['screenshot', 'ssweb'] });

  add('ytsearch', 'Media', '<what to look for>', 'Search YouTube and list the top results', async (ctx) => {
    const q = (ctx.text || ctx.quoted?.text || '').trim();
    if (!q) throw new Error(`Usage: ${ctx.prefix}ytsearch burna boy`);
    const yts = require('yt-search');
    const res = await yts(q);
    const list = (res.videos || []).slice(0, 6);
    if (!list.length) return '❌ Nothing found.';
    return '🔎 *YouTube results*\n\n' + list.map((v, i) => `${i + 1}. *${v.title}*\n   ${v.author?.name || '-'} · ${v.timestamp || '-'}\n   ${v.url}`).join('\n\n')
      + `\n\nGet one with ${ctx.prefix}song <name>`;
  }, { aliases: ['yts', 'youtube'] });
}

/* ---------------- always online: delivery ticks ----------------
 * While .alwaysonline is ON, every message people send you gets an explicit "delivered" receipt (double grey tick)
 * from the bot, and the bot shows as online right when the message arrives. This works even if your phone is off,
 * as long as the bot itself is connected. Blue ticks are NOT sent (that stays up to .autoread / your privacy settings).
 */
const lastAck = new WeakMap();
function passive(sock, m) {
  try {
    const hm = hmOf(sock);
    if (!hm?.db?.alwaysOnline || !m?.key || m.key.fromMe) return;
    const jid = m.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
    if (!m.message || m.message.protocolMessage || m.message.reactionMessage) return;
    const participant = jid.endsWith('@g.us') ? m.key.participant : undefined;
    sock.sendReceipt(jid, participant, [m.key.id], undefined).catch(() => {}); // undefined type = "delivered"
    const now = Date.now();
    if (now - (lastAck.get(sock) || 0) > 5000) { lastAck.set(sock, now); sock.sendPresenceUpdate('available').catch(() => {}); }
  } catch { /* never break message handling */ }
}

module.exports = { register, boot, passive, toSticker, parseWait };
'use strict';
/**
 * Hans-Mini more6.js - group admin tools and handy utilities
 *   Group       : .poll   (kick, add, promote and demote already exist in commands.js)
 *   Stickers    : .sticker (photo / short video -> sticker)   .toimg (sticker -> picture)
 *   Utilities   : .remind  .reminders  .tts  .shorten  .ss  .ytsearch
 *
 * Loaded from more.js with two lines:
 *   require('./more6').register(add);     (in register)
 *   require('./more6').boot(sock);        (in boot, so reminders keep working after a restart)
 * Needs: ffmpeg (already in the Dockerfile) and "sharp" + "yt-search" (already in package.json).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const num = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
const norm = (j) => String(j || '').replace(/:\d+@/, '@');
const jidOf = (d) => d + '@s.whatsapp.net';
const hmOf = (sock) => sock.hm;

/** who the command is about: @mentions, the replied person, or numbers typed after the command */
function targets(ctx) {
  if (ctx.mentioned.length) return ctx.mentioned;
  if (ctx.quoted?.participant) return [ctx.quoted.participant];
  return ctx.args.map((a) => a.replace(/\D/g, '')).filter((d) => d.length >= 7).map(jidOf);
}

const tmp = (ext) => path.join(os.tmpdir(), 'hm6-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext);
function ffmpeg(args, timeout = 90000) {
  return new Promise((ok, no) => execFile('ffmpeg', ['-y', ...args], { timeout }, (err, _o, e) => (err ? no(new Error(String(e || err.message).split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed')) : ok())));
}
const rm = (...f) => f.forEach((x) => fs.unlink(x, () => {}));
const sharpLib = () => {
  try { return require('sharp'); } catch { throw new Error('The picture tool is missing on the server (add "sharp" to package.json and redeploy).'); }
};
const isImage = (b) => (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') || b.slice(0, 3).toString() === 'GIF';

/* ---------------- stickers ---------------- */
async function toSticker(buf) {
  if (isImage(buf) && buf.slice(0, 3).toString() !== 'GIF') {
    return sharpLib()(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
  }
  // video / gif -> animated webp (max 6 seconds)
  const inp = tmp('in'); const out = tmp('webp');
  try {
    fs.writeFileSync(inp, buf);
    for (const q of [45, 30, 18]) {
      await ffmpeg(['-i', inp, '-t', '6', '-an', '-vf',
        'fps=12,scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
        '-loop', '0', '-vcodec', 'libwebp', '-q:v', String(q), out]);
      const o = fs.readFileSync(out);
      if (o.length < 900 * 1024 || q === 18) return o;
    }
  } finally { rm(inp, out); }
}

/* ---------------- reminders ---------------- */
const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseWait(s) {
  const m = String(s || '').toLowerCase().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  return m ? Math.round(Number(m[1]) * UNITS[m[2]]) : 0;
}
const fmtLeft = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return s + ' sec';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 129600) return Math.round(s / 3600 * 10) / 10 + ' h';
  return Math.round(s / 86400 * 10) / 10 + ' days';
};

function boot(sock) {
  const hm = hmOf(sock);
  if (!hm) return;
  clearInterval(hm.remindTimer);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const list = hm.db.reminders || [];
      const now = Date.now();
      let changed = false;
      for (const r of [...list]) {
        if (r.at > now) continue;
        try {
          await sock.sendMessage(r.to, { text: `⏰ *Reminder*\n${r.text}`, mentions: r.who ? [r.who] : [] });
          list.splice(list.indexOf(r), 1); changed = true;
        } catch (e) {
          if (now - r.at > 3600000) { list.splice(list.indexOf(r), 1); changed = true; }
        }
      }
      if (changed) hm.save();
    } finally { busy = false; }
  };
  hm.remindTimer = setInterval(tick, 10000);
  sock.ev.on('connection.update', ({ connection }) => { if (connection === 'close') clearInterval(hm.remindTimer); });
}

/* ---------------- register ---------------- */
function register(add) {
  add('poll', 'Group', 'Question | option 1 | option 2 ...', 'Create a poll', async (ctx) => {
    const parts = ctx.text.split('|').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) throw new Error(`Usage: ${ctx.prefix}poll Best food? | Jollof | Waakye | Banku`);
    if (parts.length > 13) throw new Error('A poll can have at most 12 options.');
    await ctx.sock.sendMessage(ctx.jid, { poll: { name: parts[0].slice(0, 200), values: parts.slice(1).map((o) => o.slice(0, 90)), selectableCount: 1 } });
  }, { aliases: ['vote'] });

  /* ----- stickers ----- */
  add('sticker', 'Media', '(reply to a photo or short video)', 'Turn a photo or short video into a sticker', async (ctx) => {
    let buf;
    try { buf = await ctx.downloadMedia(); } catch { throw new Error(`Reply to a photo or short video with ${ctx.prefix}sticker.`); }
    const webp = await toSticker(buf);
    await ctx.sock.sendMessage(ctx.jid, { sticker: webp }, { quoted: ctx.msg });
  }, { aliases: ['s', 'stick', 'tosticker'] });

  add('toimg', 'Media', '(reply to a sticker)', 'Turn a sticker back into a picture', async (ctx) => {
    let buf;
    try { buf = await ctx.downloadMedia(); } catch { throw new Error(`Reply to a sticker with ${ctx.prefix}toimg.`); }
    const png = await sharpLib()(buf).png().toBuffer();
    await ctx.sock.sendMessage(ctx.jid, { image: png, caption: '🖼️ Done' }, { quoted: ctx.msg });
  }, { aliases: ['toimage', 'unsticker'] });

  /* ----- reminders ----- */
  add('remind', 'Utility', '<10m|2h|1d> <what>', 'Get a reminder message after a time', (ctx) => {
    const wait = parseWait(ctx.args[0]);
    const text = ctx.args.slice(1).join(' ').trim();
    if (!wait || !text) throw new Error(`Usage: ${ctx.prefix}remind 30m call mum\nTime: 30s, 10m, 2h or 1d (max 30 days).`);
    if (wait > 30 * 86400000) throw new Error('The longest reminder is 30 days.');
    const { db, save } = hmOf(ctx.sock);
    const who = ctx.isGroup ? ctx.msg.key.participant || ctx.msg.participant : undefined;
    (db.reminders ||= []).push({ to: ctx.jid, at: Date.now() + wait, text: text.slice(0, 500), who: who ? norm(who) : undefined });
    save();
    return `⏰ OK, I will remind you in *${fmtLeft(wait)}*: ${text}`;
  }, { aliases: ['reminder', 'remindme'] });

  add('reminders', 'Utility', '', 'List your pending reminders here', (ctx) => {
    const list = (hmOf(ctx.sock).db.reminders || []).filter((r) => r.to === ctx.jid);
    if (!list.length) return 'You have no pending reminders in this chat.';
    return '⏰ *Reminders*\n' + list.map((r, i) => `${i + 1}. in ${fmtLeft(r.at - Date.now())}: ${r.text}`).join('\n');
  }, { aliases: ['myreminders'] });

  /* ----- text to speech ----- */
  add('tts', 'Utility', '[language] <text>', 'Turn text into a voice note (example: .tts en Hello)', async (ctx) => {
    let lang = 'en'; let text = ctx.text || ctx.quoted?.text || '';
    const m = text.match(/^([a-z]{2}(?:-[A-Za-z]{2})?)\s+([\s\S]+)$/);
    if (m && ctx.text) { lang = m[1]; text = m[2]; }
    text = text.trim();
    if (!text) throw new Error(`Usage: ${ctx.prefix}tts Hello how are you\nOther language: ${ctx.prefix}tts fr Bonjour`);
    if (text.length > 190) throw new Error('Keep it under 190 characters.');
    const r = await fetch('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text), {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('The voice service did not answer (HTTP ' + r.status + ').');
    const mp3 = Buffer.from(await r.arrayBuffer());
    const inp = tmp('mp3'); const out = tmp('ogg');
    try {
      fs.writeFileSync(inp, mp3);
      await ffmpeg(['-i', inp, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', out]);
      await ctx.sock.sendMessage(ctx.jid, { audio: fs.readFileSync(out), mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: ctx.msg });
    } finally { rm(inp, out); }
  }, { aliases: ['speak', 'say'] });

  /* ----- links ----- */
  add('shorten', 'Utility', '<link>', 'Make a long link short', async (ctx) => {
    const u = (ctx.text || ctx.quoted?.text || '').trim();
    if (!/^https?:\/\/\S+$/i.test(u)) throw new Error(`Usage: ${ctx.prefix}shorten https://example.com/very/long/link`);
    const r = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(u), { signal: AbortSignal.timeout(15000) });
    const t = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//.test(t)) throw new Error('Could not shorten that link.');
    return '🔗 ' + t;
  }, { aliases: ['short', 'tinyurl'] });

  add('ss', 'Utility', '<website link>', 'Take a screenshot of a website', async (ctx) => {
    let u = (ctx.text || '').trim();
    if (!u) throw new Error(`Usage: ${ctx.prefix}ss https://example.com`);
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u)) throw new Error('That does not look like a website link.');
    const r = await fetch('https://image.thum.io/get/width/1280/crop/800/noanimate/' + u, { signal: AbortSignal.timeout(45000) });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok || buf.length < 2000) throw new Error('Could not take a screenshot of that site.');
    await ctx.sock.sendMessage(ctx.jid, { image: buf, caption: '🖥️ ' + u }, { quoted: ctx.msg });
  }, { aliases: ['screenshot', 'ssweb'] });

  add('ytsearch', 'Media', '<what to look for>', 'Search YouTube and list the top results', async (ctx) => {
    const q = (ctx.text || ctx.quoted?.text || '').trim();
    if (!q) throw new Error(`Usage: ${ctx.prefix}ytsearch burna boy`);
    const yts = require('yt-search');
    const res = await yts(q);
    const list = (res.videos || []).slice(0, 6);
    if (!list.length) return '❌ Nothing found.';
    return '🔎 *YouTube results*\n\n' + list.map((v, i) => `${i + 1}. *${v.title}*\n   ${v.author?.name || '-'} · ${v.timestamp || '-'}\n   ${v.url}`).join('\n\n')
      + `\n\nGet one with ${ctx.prefix}song <name>`;
  }, { aliases: ['yts', 'youtube'] });
}

/* ---------------- always online: delivery ticks ----------------
 * While .alwaysonline is ON, every message people send you gets an explicit "delivered" receipt (double grey tick)
 * from the bot, and the bot shows as online right when the message arrives. This works even if your phone is off,
 * as long as the bot itself is connected. Blue ticks are NOT sent (that stays up to .autoread / your privacy settings).
 */
const lastAck = new WeakMap();
function passive(sock, m) {
  try {
    const hm = hmOf(sock);
    if (!hm?.db?.alwaysOnline || !m?.key || m.key.fromMe) return;
    const jid = m.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
    if (!m.message || m.message.protocolMessage || m.message.reactionMessage) return;
    const participant = jid.endsWith('@g.us') ? m.key.participant : undefined;
    sock.sendReceipt(jid, participant, [m.key.id], undefined).catch(() => {}); // undefined type = "delivered"
    const now = Date.now();
    if (now - (lastAck.get(sock) || 0) > 5000) { lastAck.set(sock, now); sock.sendPresenceUpdate('available').catch(() => {}); }
  } catch { /* never break message handling */ }
}

module.exports = { register, boot, passive, toSticker, parseWait };
