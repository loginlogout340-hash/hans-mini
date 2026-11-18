  '📣 *Admin*: {p}relinkall messages every user who is still on the old WhatsApp link with clear steps to fix view-once, so people stop hitting the error by surprise.',
  '',
  '🔗 *Pairing, fixed twice more*: the brief disconnect WhatsApp sends right after a code is approved now finishes instantly instead of pausing a few seconds, and a pairing code is only requested once the connection is actually ready, with one quiet retry if it still needs it - both were ways a first code could look like it failed even though nothing was really wrong. {p}fixviewonce still upgrades a number to the way view-once needs, one time, for anyone who wants it. {p}retrieve also tries one extra, cheap way to hand off a view-once item before giving up.',
  '',
'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '3.6.0';

const notes = [
  '📥 *Everything downloads without keys now*',
  '› {p}play {p}song {p}video {p}yt {p}tiktok {p}ig {p}fb {p}twitter2 {p}threads {p}pinterest',
  '› New: {p}gdrive {p}mediafire {p}mega {p}terabox {p}apk {p}savefrom {p}spotify {p}pastebin',
  '',
  '🔧 *The bot fixes itself*',
  '› It learns which download sources work and tries the best first',
  '› It updates yt-dlp, cleans leftovers, reconnects a stuck connection, and reads fixes from GitHub',
  '› The admin sees it all with {p}selfheal, {p}errors and {p}health',
  '',
  '🛡️ *Also*: Hanson works again, real error reasons are shown, mistyped commands get a hint, flooding is slowed down.',
  '',
  '👁️ *View-once*: saved for 6 hours ({p}vvlist, {p}vvget, {p}retrieve). With {p}antiviewonce on, each one is sent to your own chat at once, with who sent it and where. Two ways of downloading are tried. WhatsApp only sends view-once pictures to bots linked the new way: send {p}fixviewonce, then {p}fixviewonce confirm.',
  '',
  '',
  '📣 *Admin*: {p}relinkall messages every user who is still on the old WhatsApp link with clear steps to fix view-once, so people stop hitting the error by surprise.',
  '',
  '*Earlier:* {p}emojimix, {p}meme, {p}textall, {p}updates and starter settings for new users.',
];

function text(prefix = '.') {
  return `🆕 *Hans-Mini updated to v${version}*\n\n` + notes.join('\n').replace(/\{p\}/g, prefix) + `\n\nType ${prefix}updates anytime to see this again.`;
}

module.exports = { version, notes, text };
