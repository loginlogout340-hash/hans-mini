'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '2.2.0';

const notes = [
  '✨ *New commands*',
  '› {p}emojimix 😀😍 : mix two emojis into one sticker',
  '› {p}meme : a random meme (or {p}meme dankmemes)',
  '› {p}textall <message> : send one message to all your contacts, one by one with a safety delay',
  '› {p}updates : see this list again',
  '',
  '🛠️ *Fixes*',
  '› You can now write a space after the dot: ". play burna boy" works like ".play burna boy"',
  '› View-once photos, videos and voice notes are saved when they arrive, so {p}retrieve and your sticker command work after they are opened',
  '',
  '🆕 *New users* get these switched on automatically: auto view status, auto like status (random emoji), always online, anti delete, and private mode.',
];

function text(prefix = '.') {
  return `🆕 *Hans-Mini updated to v${version}*\n\n` + notes.join('\n').replace(/\{p\}/g, prefix) + `\n\nType ${prefix}updates anytime to see this again.`;
}

module.exports = { version, notes, text };
