'use strict';
/**
 * Message helpers shared by bot.js (and the other files):
 *   unwrap(message)          -> the real message content (removes ephemeral / view-once / edited wrappers)
 *   getText(message)         -> the text or caption of a message ('' if none)
 *   isViewOnce(message)      -> true when the message is a view-once picture, video or voice note
 *   makeForwarder(download)  -> async (sock, to, msg, header) that re-sends any message (also media) to a chat
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

module.exports = { unwrap, getText, isViewOnce, makeForwarder };
