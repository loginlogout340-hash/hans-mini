'use strict';
/** Message helpers: unwrapping, view-once detection and copying media to another chat. */

function unwrap(m) {
  let cur = m;
  for (let i = 0; i < 5 && cur; i++) {
    const inner = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message || cur.viewOnceMessageV2Extension?.message || cur.documentWithCaptionMessage?.message || cur.editedMessage?.message?.protocolMessage?.editedMessage;
    if (!inner) break;
    cur = inner;
  }
  return cur || {};
}

function getText(m) {
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
}

const KINDS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

function isViewOnce(raw) {
  if (!raw) return false;
  const wrapped = raw.ephemeralMessage?.message || raw;
  if (wrapped.viewOnceMessage || wrapped.viewOnceMessageV2 || wrapped.viewOnceMessageV2Extension) return true;
  const inner = unwrap(wrapped);
  return KINDS.some((k) => inner[k]?.viewOnce === true);
}

/**
 * Build forward(sock, to, fullMsg, header): sends a copy of the message (media or text) to `to`.
 * `download(msg)` must return a Buffer for a media message. Throws if the media cannot be downloaded.
 */
function makeForwarder(download) {
  return async function forward(sock, to, fullMsg, header) {
    const inner = unwrap(fullMsg.message);
    const kind = KINDS.find((k) => inner[k]);
    if (!kind) {
      const t = getText(inner);
      return sock.sendMessage(to, { text: `${header}\n\n${t || '(this message type is not supported)'}` });
    }
    const node = inner[kind];
    const buf = await download({ key: fullMsg.key, message: inner });
    const cap = header + (node.caption ? '\n\n' + node.caption : '');
    if (kind === 'imageMessage') return sock.sendMessage(to, { image: buf, caption: cap });
    if (kind === 'videoMessage') return sock.sendMessage(to, { video: buf, caption: cap, mimetype: node.mimetype });
    if (kind === 'documentMessage') return sock.sendMessage(to, { document: buf, mimetype: node.mimetype, fileName: node.fileName || 'file', caption: header });
    await sock.sendMessage(to, { text: header });
    if (kind === 'audioMessage') return sock.sendMessage(to, { audio: buf, mimetype: node.mimetype || 'audio/ogg; codecs=opus', ptt: !!node.ptt });
    return sock.sendMessage(to, { sticker: buf });
  };
}

module.exports = { unwrap, getText, isViewOnce, makeForwarder };
