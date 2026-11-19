  '📣 *Admin*: {p}relinkall messages every user who is still on the old WhatsApp link with clear steps to fix view-once, so people stop hitting the error by surprise.',
  '',
  '🔗 *The real pairing fix*: linking was pinned to an unstable, pre-release build of the WhatsApp library (npm\'s "latest" tag currently points at one), which has an open, unresolved bug causing exactly this: a code is issued, the phone says "Couldn\'t link device", and the connection is rejected right away. The bot now uses a specific, stable release instead. The earlier timing fixes stay in place too; they were real improvements, just not the main cause.',
  '',
  '🛠️ *Correction on {p}fixviewonce*: it does relink the number, but the "android" identity it was meant to switch to turns out not to exist in the WhatsApp library this bot actually uses - so it has not been changing anything beyond a normal relink. True view-once support through that route is not available right now; this will stay honest about that until there is a real way to do it.',
  '',
'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '3.7.0';

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
