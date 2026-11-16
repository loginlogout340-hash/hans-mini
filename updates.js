'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '3.2.0';

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
  '👁️ *View-once*: saved for 6 hours ({p}vvlist, {p}vvget, {p}retrieve). WhatsApp only sends view-once pictures to bots linked the new way: send {p}fixviewonce, then {p}fixviewonce confirm.',
  '',
  '*Earlier:* {p}emojimix, {p}meme, {p}textall, {p}updates and starter settings for new users.',
];

function text(prefix = '.') {
  return `🆕 *Hans-Mini updated to v${version}*\n\n` + notes.join('\n').replace(/\{p\}/g, prefix) + `\n\nType ${prefix}updates anytime to see this again.`;
}

module.exports = { version, notes, text };
