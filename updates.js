'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '3.0.0';

const notes = [
  '🛡️ *Strict mode*',
  '› {p}health : the owner checks the server, the tools and every download source in one message',
  '› If a song or video fails you now see the real reason, not just "network problem"',
  '› Songs: a failed WhatsApp upload is tried again, and a download source is only skipped when it is really down',
  '› Hanson works again, and the AI tries again by itself when the free service is busy',
  '› A mistyped command gets a "did you mean" hint, flooding is slowed down, and a stuck command is stopped',
  '',
  '👁️ *View-once* : saved for 6 hours, even after a restart. {p}vvlist, {p}vvget 1, and {p}retrieve works without replying. WhatsApp only sends view-once pictures to bots linked the new way: send {p}fixviewonce, then {p}fixviewonce confirm. You get a new pairing code in a WhatsApp message and your settings are kept.',
  '',
  '*Earlier:* {p}emojimix, {p}meme, {p}textall, {p}updates, {p}play {p}song {p}video {p}tiktok {p}ig {p}fb {p}twitter2 {p}pinterest with no keys, and starter settings for new users.',
];

function text(prefix = '.') {
  return `🆕 *Hans-Mini updated to v${version}*\n\n` + notes.join('\n').replace(/\{p\}/g, prefix) + `\n\nType ${prefix}updates anytime to see this again.`;
}

module.exports = { version, notes, text };
