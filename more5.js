'use strict';
/**
 * Hans-Mini more5.js
 *   .shazam            reply to a song / voice note / video -> tells you the song name and artist
 *   .lyrics <song>     look up the lyrics of a song (or reply to a message with the song name)
 *   .stealth on|off    ghost mode: hides your last seen, online status and read receipts
 *                      (with read receipts off, people also cannot see that you viewed their status)
 *
 * Loaded from more.js with one line:  require('./more5').register(add);
 *
 * Optional Railway variable:
 *   AUDD_TOKEN   token from https://dashboard.audd.io (free tier) - used by .shazam
 * Lyrics come from the free community database lrclib.net (no key needed).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const hmOf = (sock) => sock.hm;

/* ---------------- .shazam ---------------- */
// cut the first 25 seconds and turn it into a small mp3 (audio or video in, mp3 out)
function clip(buf) {
  const base = path.join(os.tmpdir(), 'hm-sz-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  return new Promise((ok) => {
    try { fs.writeFileSync(base + '.in', buf); } catch { return ok(buf); }
    execFile('ffmpeg', ['-y', '-i', base + '.in', '-vn', '-t', '25', '-ac', '1', '-ar', '44100', '-b:a', '96k', base + '.mp3'],
      { timeout: 60000 }, (err) => {
        let out = buf;
        if (!err) { try { out = fs.readFileSync(base + '.mp3'); } catch { /* keep original */ } }
        for (const e of ['in', 'mp3']) fs.unlink(base + '.' + e, () => {});
        ok(out);
      });
  });
}

async function identify(buf) {
  const form = new FormData();
  if (process.env.AUDD_TOKEN) form.set('api_token', process.env.AUDD_TOKEN.trim());
  form.set('return', 'apple_music,spotify');
  form.set('file', new Blob([buf], { type: 'audio/mpeg' }), 'clip.mp3');
  const r = await fetch('https://api.audd.io/', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!j) throw new Error('The music service did not answer (HTTP ' + r.status + ').');
  if (j.status === 'error') {
    const msg = String(j.error?.error_message || 'unknown error');
    if (/token|limit|requests/i.test(msg)) throw new Error('The music service needs a token or its free limit is used up. Get a free token at dashboard.audd.io and add it in Railway as AUDD_TOKEN.');
    throw new Error(msg.slice(0, 150));
  }
  return j.result || null;
}

/* ---------------- .lyrics ---------------- */
async function findLyrics(q) {
  const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': 'Hans-Mini WhatsApp bot' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('Lyrics service returned HTTP ' + r.status + '.');
  const list = await r.json();
  return (Array.isArray(list) ? list : []).find((x) => x && x.plainLyrics && String(x.plainLyrics).trim());
}
// WhatsApp handles long text, but small pieces are safer
function chunks(text, size = 3500) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if ((cur + '\n' + line).length > size && cur) { out.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------------- .stealth ---------------- */
async function stealthOn(sock) {
  const { db, save } = hmOf(sock);
  if (!db.stealth?.on) {
    let prev = {};
    try { prev = (await sock.fetchPrivacySettings(true)) || {}; } catch { /* keep going with defaults */ }
    db.stealth = { on: true, prev: { last: prev.last || 'contacts', online: prev.online || 'all', readreceipts: prev.readreceipts || 'all' } };
    save();
  }
  const steps = [
    ['last seen', () => sock.updateLastSeenPrivacy('none')],
    ['online', () => sock.updateOnlinePrivacy('match_last_seen')],
    ['read receipts', () => sock.updateReadReceiptsPrivacy('none')],
  ];
  const failed = [];
  for (const [name, fn] of steps) { try { await fn(); } catch (e) { console.error('[stealth]', name, e.message); failed.push(name); } }
  return failed;
}
async function stealthOff(sock) {
  const { db, save } = hmOf(sock);
  const prev = db.stealth?.prev || { last: 'contacts', online: 'all', readreceipts: 'all' };
  const steps = [
    ['last seen', () => sock.updateLastSeenPrivacy(prev.last)],
    ['online', () => sock.updateOnlinePrivacy(prev.online)],
    ['read receipts', () => sock.updateReadReceiptsPrivacy(prev.readreceipts)],
  ];
  const failed = [];
  for (const [name, fn] of steps) { try { await fn(); } catch (e) { console.error('[stealth]', name, e.message); failed.push(name); } }
  db.stealth = { on: false, prev };
  save();
  return failed;
}

/* ---------------- register ---------------- */
function register(add) {
  add('shazam', 'Media', '(reply to a song, voice note or video)', 'Find out which song is playing in an audio or video', async (ctx) => {
    let buf;
    try { buf = await ctx.downloadMedia(); }
    catch (e) { throw new Error(`Reply to a song, voice note or video with ${ctx.prefix}shazam.`); }
    if (!buf || !buf.length) throw new Error('Could not read that file.');
    await ctx.reply('🎧 Listening...');
    const res = await identify(await clip(buf));
    if (!res) return '❌ I could not recognise that song. Try a clearer or longer part (10-20 seconds of the music, no talking).';
    const links = [res.song_link, res.spotify?.external_urls?.spotify].filter(Boolean);
    return [
      '🎵 *Song found*',
      `*Title:* ${res.title || '-'}`,
      `*Artist:* ${res.artist || '-'}`,
      res.album ? `*Album:* ${res.album}` : '',
      res.release_date ? `*Released:* ${res.release_date}` : '',
      links.length ? '\n🔗 ' + links.join('\n🔗 ') : '',
      `\nGet it with ${ctx.prefix}song ${res.title || ''} ${res.artist || ''}`.trimEnd(),
    ].filter(Boolean).join('\n');
  }, { aliases: ['whatsong', 'findsong', 'identify'] });

  add('lyrics', 'Media', '<song name and artist>', 'Look up the lyrics of a song', async (ctx) => {
    const q = (ctx.text || ctx.quoted?.text || '').trim();
    if (!q) throw new Error(`Usage: ${ctx.prefix}lyrics <song name and artist>\nExample: ${ctx.prefix}lyrics burna boy last last`);
    const hit = await findLyrics(q);
    if (!hit) return `❌ No lyrics found for "${q}". Try the song name with the artist name.`;
    const head = `🎤 *${hit.trackName}* - ${hit.artistName}\n\n`;
    const parts = chunks(head + String(hit.plainLyrics).trim());
    for (const p of parts.slice(0, 4)) await ctx.reply(p);
    if (parts.length > 4) await ctx.reply('(Lyrics cut here because the song is very long.)');
  }, { aliases: ['lyric', 'songlyrics'] });

  add('stealth', 'Owner', 'on | off | status', 'Ghost mode: hide last seen, online and read receipts (also hides that you viewed statuses)', async (ctx) => {
    const sock = ctx.sock;
    const v = (ctx.args[0] || 'status').toLowerCase();
    const { db } = hmOf(sock);
    if (v === 'on') {
      const failed = await stealthOn(sock);
      return '👻 *Stealth mode ON*\nLast seen: hidden\nOnline: hidden\nRead receipts: off (nobody sees your blue ticks or status views)'
        + (failed.length ? `\n\n⚠️ Could not change: ${failed.join(', ')}.` : '')
        + (db.alwaysOnline ? `\n\nNote: ${ctx.prefix}alwaysonline is ON and keeps showing you online. Turn it off with ${ctx.prefix}alwaysonline off.` : '')
        + `\n\nTurn it off with ${ctx.prefix}stealth off.`;
    }
    if (v === 'off') {
      const failed = await stealthOff(sock);
      return '👁️ *Stealth mode OFF*\nYour privacy settings are back to what they were before.'
        + (failed.length ? `\n\n⚠️ Could not restore: ${failed.join(', ')}.` : '');
    }
    if (v === 'status') return `👻 Stealth mode is *${db.stealth?.on ? 'ON' : 'OFF'}*.\nUsage: ${ctx.prefix}stealth on | off`;
    throw new Error(`Usage: ${ctx.prefix}stealth on | off | status`);
  }, { owner: true, aliases: ['ghost', 'ghostmode'] });
}

module.exports = { register };
