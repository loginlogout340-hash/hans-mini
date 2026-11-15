'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '2.7.0';

const notes = [
  '🛠️ *Smarter bot* : Hanson works again. Mistyped commands get a "did you mean ...?" hint. Errors are shown in plain words, a stuck command is stopped by itself, and flooding the bot is slowed down.',
  '',
  '👁️ *View-once vault* : view-once messages are kept for 6 hours, even after a restart. {p}retrieve now also works without replying (it sends the newest one). New: {p}vvlist and {p}vvget 1.',
  '',
  '🤖 *AI* : {p}ai, {p}translate, {p}summarize and Hanson retry by themselves when the free AI service is busy.',
  '',
  '👁️ *View-once fix* : WhatsApp only sends view-once pictures to bots that are linked the new way. Send {p}fixviewonce, then {p}fixviewonce confirm. The bot unlinks you, sends you a new pairing code in a WhatsApp message, and you enter it in Linked devices. Your settings are kept. After that {p}retrieve can save view-once pictures. New users are already linked the new way.',
  '',
  '🎵 *Music* : {p}play and {p}song now work on their own, with no setup or keys. If one source is down, the bot tries the next.',
  '',
  '🎬 *Videos and pictures* : {p}video, {p}yt, {p}tiktok, {p}ig, {p}fb, {p}twitter2, {p}threads and {p}pinterest now work on their own, with no setup or keys. Photos and slideshows work too. Add "audio" after a link to get only the sound.',
  '',
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
