'use strict';
/**
 * Message helpers shared by bot.js (and the other files):
 *   unwrap(message)             -> the real message content (removes ephemeral / view-once / edited wrappers)
 *   getText(message)            -> the text or caption of a message ('' if none)
 *   isViewOnce(message)         -> true when the message is a view-once picture, video or voice note
 *   makeForwarder(download)     -> async (sock, to, msg, header) that re-sends any message (also media) to a chat
 *   relayViewOnce(sock, to, msg, extra)  -> NEW: a last-resort way to hand off a view-once item (see below)
 */

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

/** removes the wrappers around a message (a few levels deep) */
function unwrap(m) {
  let x = m || {};
  for (let i = 0; i < 6; i++) {
    let inner = null;
    for (const w of WRAPPERS) {
      if (x[w]?.message) { inner = x[w].message; break; }
    }
    if (!inner) break;
    x = inner;
  }
  return x;
}

/** the text of a message: normal text, a caption, or the id of a tapped button / list row */
function getText(m) {
  const x = unwrap(m);
  if (!x) return '';
  let nativeId = '';
  try {
    const p = x.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    if (p) nativeId = JSON.parse(p).id || '';
  } catch { /* not JSON */ }
  return (
    x.conversation ||
    x.extendedTextMessage?.text ||
    x.imageMessage?.caption ||
    x.videoMessage?.caption ||
    x.documentMessage?.caption ||
    x.buttonsResponseMessage?.selectedButtonId ||
    x.listResponseMessage?.singleSelectReply?.selectedRowId ||
    x.templateButtonReplyMessage?.selectedId ||
    nativeId ||
    ''
  );
}

/** true for a view-once picture, video or voice note */
function isViewOnce(m) {
  if (!m) return false;
  // wrapped form (older and newer WhatsApp versions)
  let x = m;
  for (let i = 0; i < 6; i++) {
    if (x.viewOnceMessage || x.viewOnceMessageV2 || x.viewOnceMessageV2Extension) return true;
    const inner = x.ephemeralMessage?.message || x.documentWithCaptionMessage?.message || x.editedMessage?.message;
    if (!inner) break;
    x = inner;
  }
  // flag form
  return !!(x.imageMessage?.viewOnce || x.videoMessage?.viewOnce || x.audioMessage?.viewOnce);
}

/**
 * makeForwarder(download) gives forward(sock, to, msg, header)
 *   download(msg) -> Buffer   (bot.js passes Baileys' downloadMediaMessage)
 *   msg           -> { key, message } of the message to re-send
 *   header        -> text put in front of the caption (for example "Deleted message ...")
 * Media is downloaded and uploaded again, text is sent as text.
 */
function makeForwarder(download) {
  return async function forward(sock, to, msg, header = '') {
    const c = unwrap(msg.message);
    const head = header ? String(header) : '';
    const join = (a, b) => [a, b].filter(Boolean).join('\n\n');

    // plain text
    const text = c.conversation || c.extendedTextMessage?.text;
    if (text) return sock.sendMessage(to, { text: join(head, text) });

    if (c.imageMessage) {
      const buffer = await download(msg);
      return sock.sendMessage(to, { image: buffer, caption: join(head, c.imageMessage.caption) });
    }
    if (c.videoMessage) {
      const buffer = await download(msg);
      return sock.sendMessage(to, {
        video: buffer,
        caption: join(head, c.videoMessage.caption),
        gifPlayback: !!c.videoMessage.gifPlayback,
      });
    }
    if (c.audioMessage) {
      const buffer = await download(msg);
      if (head) await sock.sendMessage(to, { text: head });
      return sock.sendMessage(to, { audio: buffer, mimetype: c.audioMessage.mimetype || 'audio/ogg; codecs=opus', ptt: !!c.audioMessage.ptt });
    }
    if (c.documentMessage) {
      const buffer = await download(msg);
      return sock.sendMessage(to, {
        document: buffer,
        mimetype: c.documentMessage.mimetype || 'application/octet-stream',
        fileName: c.documentMessage.fileName || 'file',
        caption: join(head, c.documentMessage.caption),
      });
    }
    if (c.stickerMessage) {
      const buffer = await download(msg);
      if (head) await sock.sendMessage(to, { text: head });
      return sock.sendMessage(to, { sticker: buffer });
    }

    throw new Error('this message type cannot be re-sent');
  };
}

/**
 * relayViewOnce(sock, to, msg, extra) - a different, LAST-RESORT way to hand off a view-once item.
 *
 * Everywhere else in this file, "forward" means: this server downloads the media into a buffer, then
 * uploads that buffer again as a new message. That needs the server to successfully fetch the media
 * itself, which is exactly what fails when WhatsApp withholds a view-once item from this linked device.
 *
 * relayViewOnce never downloads anything. It takes the view-once message exactly as this device received
 * it, removes only the "view once" flag, and hands the resulting message straight to Baileys' own relay
 * step (generateForwardMessageContent + relayMessage) so WhatsApp delivers it to the new chat the normal
 * way - the same thing that happens whenever any message is forwarded on a phone. The receiving chat's own
 * device ends up doing the fetching, not this server.
 *
 * This can occasionally succeed when the normal download fails for a reason specific to this server (a
 * network hiccup, a media-host quirk), but it cannot invent a media reference that was never there: when
 * WhatsApp withheld the item entirely (no mediaKey, no directPath, no url on the message this device got -
 * the case bot.js already detects and reports as "WhatsApp does not send view-once pictures to the way
 * your bot is linked"), there is nothing here to relay either, and this throws the same way the normal
 * download does. It is tried as one extra, cheap attempt - never a replacement for linking the bot the way
 * that lets WhatsApp hand over the media in the first place (see .fixviewonce).
 */
async function relayViewOnce(sock, to, msg, extra = {}) {
  const baileys = await import('@whiskeysockets/baileys');
  const B = baileys.default && (baileys.default.generateForwardMessageContent || baileys.default.default) ? baileys.default : baileys;

  // find the viewOnce wrapper and the picture/video/voice-note part inside it
  let node = msg.message;
  for (const w of WRAPPERS) { if (node?.[w]?.message) { node = node[w].message; break; } }
  const vwrap = node?.viewOnceMessage || node?.viewOnceMessageV2 || node?.viewOnceMessageV2Extension;
  const plain = vwrap?.message;
  const kind = plain && Object.keys(plain)[0];
  if (!kind || !plain[kind]) throw new Error('this is not a view-once message');
  const part = plain[kind];
  if (!part.mediaKey && !part.directPath && !part.url) throw new Error('WhatsApp did not give this device a media reference for it');

  const stripped = { ...plain, [kind]: { ...part, viewOnce: false } };
  const content = B.generateForwardMessageContent({ key: msg.key, message: stripped }, false);
  const type = B.getContentType(content);
  if (extra.caption) content[type].caption = extra.caption;
  if (extra.mentions?.length) content[type].contextInfo = { ...(content[type].contextInfo || {}), mentionedJid: extra.mentions };
  const wa = B.generateWAMessageFromContent(to, content, {});
  await sock.relayMessage(to, wa.message, { messageId: wa.key.id });
}

module.exports = { unwrap, getText, isViewOnce, makeForwarder, relayViewOnce };
