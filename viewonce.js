'use strict';
/**
 * Hans-Mini's view-once handling, all in one place.
 *
 * WHY THIS WORKS FOR EVERYONE, WITH NO SPECIAL SETUP:
 * WhatsApp's "can't re-open this" rule for view-once media is enforced by the OFFICIAL app, after a
 * person has opened it once. A bot that is online at the moment the message is delivered gets the full
 * media reference right then, the same as any other message - that is the whole trick every working
 * "save view-once" bot actually uses. There is no special way to link the bot that changes this (an
 * earlier version of this file believed otherwise; that turned out to be based on a feature that does
 * not exist in the WhatsApp library Hans-Mini uses). The one real requirement is simply that the bot is
 * online when the item is sent - if it is offline, WhatsApp has nothing to hand it later, for any bot.
 *
 * createVault(dir) gives one user's bot a small disk-backed store: a view-once picture, video or voice
 * note is saved the moment it arrives, before it is ever opened, and stays there for a few hours - even
 * across a restart. .retrieve, .vvlist, .vvget and a sticker bound with .stickcmd to .retrieve all read
 * from this same store, so they all work the same way for every user.
 *
 * bot.js calls:
 *   createVault(dir)                                    once, when a user's bot is created
 *   vault.handleArrival(msg, deps)                       for every incoming message
 *   vault.get(id) / vault.list(chat) / vault.has(id)      used by .vvlist, .vvget, .retrieve
 *   vault.sendSaved(sock, to, hit, header, mentions)      sends a saved item
 *   vault.recoverQuoted(sock, to, key, message, header, mentions)
 *                                                        used by .retrieve: the vault, then one last
 *                                                        cheap try, then a plain, honest error
 */
const fs = require('fs');
const path = require('path');
const { unwrap, isViewOnce, relayViewOnce } = require('./media');

const VV_MAX = 20; // items kept per user (the oldest is dropped first)
const VV_MAX_BYTES = 25 * 1024 * 1024; // anything bigger than this is not kept
const VV_MAX_AGE = 6 * 60 * 60 * 1000; // kept for 6 hours
const MISSING_NOTICE_GAP = 60 * 60 * 1000; // at most one "could not be recovered" note to the owner per hour
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');

function createVault(dir) {
  const vvDir = path.join(dir, 'vv');
  const index = new Map(); // message id -> { id, t, kind, caption, mimetype, ptt, chat, from, name, size }
  const file = (id) => path.join(vvDir, String(id).replace(/[^A-Za-z0-9_-]/g, '_'));
  let loaded = false;
  let lastMissingNotice = 0;

  function drop(id) { index.delete(id); for (const e of ['.bin', '.json']) fs.unlink(file(id) + e, () => {}); }
  function purge() {
    const now = Date.now();
    for (const [id, m] of index) if (now - m.t > VV_MAX_AGE) drop(id); // too old
    const list = [...index.values()].sort((a, b) => a.t - b.t);
    while (list.length > VV_MAX) drop(list.shift().id); // too many: the oldest go first
  }
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      for (const f of fs.readdirSync(vvDir)) {
        if (!f.endsWith('.json')) continue;
        try { const m = JSON.parse(fs.readFileSync(path.join(vvDir, f), 'utf8')); if (m && m.id) index.set(m.id, m); } catch { /* skip a broken file */ }
      }
    } catch { /* no vault yet */ }
    purge();
  }
  function put(meta, buffer) {
    fs.mkdirSync(vvDir, { recursive: true });
    fs.writeFileSync(file(meta.id) + '.bin', buffer);
    fs.writeFileSync(file(meta.id) + '.json', JSON.stringify(meta));
    index.set(meta.id, meta);
    purge();
  }
  function get(id) {
    load();
    const m = id && index.get(id);
    if (!m) return null;
    try { return { ...m, buffer: fs.readFileSync(file(id) + '.bin') }; } catch { index.delete(id); return null; }
  }
  const list = (chat) => { load(); return [...index.values()].filter((m) => !chat || m.chat === chat).sort((a, b) => b.t - a.t); };
  const has = (id) => { load(); return index.has(id); };

  // one way, then the other, then both again after a short pause - one sometimes works when the other does not
  async function downloadAny(msg, part, kind, deps) {
    const ways = [() => deps.download(msg), () => (deps.downloadPart ? deps.downloadPart(part, kind) : Promise.reject(new Error('no stream download')))];
    let last;
    for (let round = 0; round < 2; round++) {
      for (const way of ways) {
        try { const b = await way(); if (b && b.length) return b; } catch (e) { last = e; }
      }
      if (round === 0) await sleep(1500);
    }
    throw last || new Error('the download gave nothing');
  }

  async function sendSaved(sock, to, hit, header = '', mentions = []) {
    const cap = [header, hit.caption].filter(Boolean).join('\n\n');
    if (hit.kind === 'image') return sock.sendMessage(to, { image: hit.buffer, caption: cap, mentions });
    if (hit.kind === 'video') return sock.sendMessage(to, { video: hit.buffer, caption: cap, mentions });
    if (header) await sock.sendMessage(to, { text: header, mentions });
    return sock.sendMessage(to, { audio: hit.buffer, mimetype: hit.mimetype || 'audio/ogg; codecs=opus', ptt: !!hit.ptt });
  }

  function headerFor(msg) {
    const where = String(msg.key.remoteJid || '').endsWith('@g.us') ? 'a group' : 'a private chat';
    return `👁️ *View-once message*\nFrom: ${msg.pushName || ''} (+${digits(msg.key.participant || msg.key.remoteJid)})\nIn: ${where}`;
  }

  /**
   * Called for every incoming message. Saves it if it is a fresh view-once item not seen before, and
   * forwards it straight to the owner when antiViewOnce is on.
   * deps: { download, downloadPart, log, sock, ownerJid, antiViewOnce }
   */
  async function handleArrival(msg, deps) {
    try {
      load();
      if (!deps.download || !msg.key?.id || index.has(msg.key.id)) return;
      const c = unwrap(msg.message);
      const kind = c.imageMessage ? 'image' : c.videoMessage ? 'video' : c.audioMessage ? 'audio' : null;
      if (!kind) return;
      const part = c[kind + 'Message'];
      if (!part.mediaKey && !part.directPath && !part.url) {
        // WhatsApp did not hand this device any media for it - most often because the bot was briefly
        // offline when it arrived. There is no setting that fixes this after the fact; the sender has to
        // send a new one while the bot is online.
        deps.log?.('view-once ' + kind + ' arrived with nothing to download (the bot was likely offline for a moment)');
        if (deps.antiViewOnce && !msg.key.fromMe && deps.sock && Date.now() - lastMissingNotice > MISSING_NOTICE_GAP) {
          lastMissingNotice = Date.now();
          deps.sock.sendMessage(deps.ownerJid, { text: headerFor(msg) + '\n\n(the media could not be recovered - the bot was likely offline for a moment)' }).catch(() => {});
        }
        return;
      }
      const buffer = await downloadAny(msg, part, kind, deps);
      if (!buffer || !buffer.length || buffer.length > VV_MAX_BYTES) return;
      put({
        id: msg.key.id, t: Date.now(), kind, caption: part.caption || '', mimetype: part.mimetype || '', ptt: !!part.ptt,
        chat: msg.key.remoteJid, from: digits(msg.key.participant || msg.key.remoteJid), name: msg.pushName || '', size: buffer.length,
      }, buffer);
      deps.log?.('view-once ' + kind + ' saved in the vault (' + Math.round(buffer.length / 1024) + ' KB)');
      if (deps.antiViewOnce && !msg.key.fromMe && deps.sock) {
        const who = msg.key.participant || msg.key.remoteJid;
        await sendSaved(deps.sock, deps.ownerJid, get(msg.key.id), headerFor(msg), /@/.test(who || '') ? [who] : [])
          .catch((e) => deps.log?.('could not send the view-once item to the owner:', e.message));
      }
    } catch (e) {
      deps.log?.('could not save view-once:', e.message);
      if (deps.antiViewOnce && !msg.key.fromMe && deps.sock && Date.now() - lastMissingNotice > MISSING_NOTICE_GAP) {
        lastMissingNotice = Date.now();
        deps.sock.sendMessage(deps.ownerJid, { text: headerFor(msg) + '\n\n(the media could not be recovered)' }).catch(() => {});
      }
    }
  }

  /**
   * Used by .retrieve (and by .stickcmd, since a bound sticker just runs .retrieve): the vault first,
   * then one last, cheap try - handing the message straight to WhatsApp's own relay step instead of
   * downloading it here (see media.js) - then a plain error, with no mention of relinking, because
   * relinking has nothing to do with whether this works.
   */
  async function recoverQuoted(sock, to, quotedKey, quotedMessage, header, mentions = []) {
    const saved = get(quotedKey.id);
    if (saved) return sendSaved(sock, to, saved, header, mentions);
    if (!isViewOnce(quotedMessage)) throw new Error('Could not retrieve that message.');
    try {
      await relayViewOnce(sock, to, { key: quotedKey, message: quotedMessage }, { caption: header, mentions });
      return;
    } catch { /* falls through to the plain error below */ }
    throw new Error('That view-once message was not saved. The bot must be online when it is sent - ask for a new one and reply to it right away.');
  }

  return { get, list, has, put, sendSaved, handleArrival, recoverQuoted, headerFor };
}

module.exports = { createVault };
