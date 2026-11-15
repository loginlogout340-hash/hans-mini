'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '2.5.0';

const notes = [
  '👁️ *View-once fix* : WhatsApp only sends view-once pictures to bots that are linked the new way. Send {p}fixviewonce once: the bot unlinks you, you link again on the website, and after that {p}retrieve can save view-once pictures. New users are already linked the new way.',
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
