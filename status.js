'use strict';
/**
 * status.js  (Hans-Mini)
 * Does two jobs:
 *   1) handleStatus()  -> auto view + auto like (react to) contacts' statuses
 *   2) register(add)   -> adds the .react command
 *
 * You do not need to edit this file. Just put it next to commands.js and bot.js.
 */

// Each connected user has their own socket, so each gets their own "already handled" list.
const seenBySock = new WeakMap();
const lidCache = new Map();

const LIKE_EMOJIS = ['❤️', '🔥', '💚', '💯', '✨', '😍', '🎉', '🤍', '😎'];

// "233123456789:12@s.whatsapp.net" -> "233123456789@s.whatsapp.net"
const bareJid = (jid) => (jid ? jid.replace(/:\d+@/, '@') : jid);

// Find the real phone-number JID of whoever posted the status.
async function resolvePoster(sock, key) {
  const alt = key.participantAlt;
  if (alt && !alt.endsWith('@lid')) return bareJid(alt);

  const raw = key.participant || '';
  if (!raw.endsWith('@lid')) return bareJid(raw);

  const lid = raw.split('@')[0].split(':')[0];
  if (lidCache.has(lid)) return lidCache.get(lid) + '@s.whatsapp.net';

  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(raw);
    const digits = pn && String(pn).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (digits && digits.length >= 7) {
      lidCache.set(lid, digits);
      return digits + '@s.whatsapp.net';
    }
  } catch (e) { /* fall through */ }

  return raw; // could not convert, use as is
}

/**
 * Call this for every message that comes from 'status@broadcast'.
 *   sock = the WhatsApp connection
 *   mek  = the incoming message
 *   cfg  = { autoview: true/false, autolike: true/false, emoji: '🔥' or 'random' }
 */
async function handleStatus(sock, mek, cfg) {
  try {
    const key = mek && mek.key;
    if (!key || !key.id || key.fromMe) return;
    if (mek.message && mek.message.protocolMessage) return;
    if (!cfg || (!cfg.autoview && !cfg.autolike)) return;

    // skip statuses we already handled (WhatsApp can send the same one twice)
    let seen = seenBySock.get(sock);
    if (!seen) { seen = new Set(); seenBySock.set(sock, seen); }
    if (seen.has(key.id)) return;
    seen.add(key.id);
    if (seen.size > 300) seen.delete(seen.values().next().value);

    const poster = await resolvePoster(sock, key);
    const reactKey = { ...key, participant: poster };

    // 1) mark the status as seen
    try {
      await sock.readMessages([reactKey]);
    } catch (e) {
      try { await sock.readMessages([key]); } catch (e2) { /* ignore */ }
    }

    // 2) react to it
    if (cfg.autolike) {
      let emoji = cfg.emoji;
      if (!emoji || emoji === 'random') emoji = LIKE_EMOJIS[Math.floor(Math.random() * LIKE_EMOJIS.length)];

      await sock.sendMessage(
        'status@broadcast',
        { react: { text: emoji, key: reactKey } },
        { statusJidList: [poster, bareJid(sock.user && sock.user.id)].filter(Boolean) }
      );
    }
  } catch (err) {
    console.error('[status]', err && err.message ? err.message : err);
  }
}

// Adds the .react command. commands.js calls this once.
function register(add) {
  add('react', 'Fun', '<emoji>', 'Reply to a message to react to it (use "off" to remove your reaction)', async (ctx) => {
    if (!ctx.quoted) throw new Error(`Reply to a message with ${ctx.prefix}react 😂`);

    const raw = (ctx.args[0] || '❤️').trim();
    let text = '';
    if (raw.toLowerCase() !== 'off') {
      text = [...new Intl.Segmenter().segment(raw)][0].segment; // keep only the first emoji
      if (!/\p{Extended_Pictographic}/u.test(text)) {
        throw new Error(`Give a real emoji, for example ${ctx.prefix}react 🔥`);
      }
    }

    await ctx.sock.sendMessage(ctx.jid, {
      react: {
        text,
        key: {
          remoteJid: ctx.jid,
          id: ctx.quoted.id,
          fromMe: !!ctx.quoted.fromBot,
          ...(ctx.isGroup ? { participant: ctx.quoted.participant } : {}),
        },
      },
    });
  }, { aliases: ['rx'] });
}

module.exports = { handleStatus, register };
