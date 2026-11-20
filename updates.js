'use strict';
/**
 * What's new in Hans-Mini.
 * When you publish a new update: change `version` and `notes`. Every user who was already linked gets
 * the notes once, in their own chat, the next time their bot connects. They can read them again with .updates
 */
const version = '3.9.2';

const notes = [
  '🤖 *{p}antibot*: a group command that detects and removes other WhatsApp bots. {p}antibot on kick to remove automatically, {p}antibot on warn (the default) to just delete the message and point it out, {p}antibot on mute to silence instead of removing, {p}antibot add <number> for a block list that is always removed on sight. {p}antibot mute / unmute <number> works on its own too, any time, whether or not antibot is turned on - once muted, that person\'s messages are deleted until unmuted. It never touches group admins, the owner, or its own messages, and only removes or mutes someone when it is itself a group admin.',
  '',
  '👁️ *View-once, fixed for real this time*',
  '› {p}retrieve, {p}vvlist and {p}vvget now work the same for every user - no relinking, no special setup',
  '› A sticker bound with {p}stickcmd to {p}retrieve works the same way',
  '› The earlier claim that relinking the bot ("android identity") was needed for this was wrong - it was based on a feature that does not exist in the WhatsApp library this bot actually uses. View-once has always worked the same for every linked device; the real, only requirement is that the bot is online when the item is sent',
  '› {p}fixviewonce no longer relinks your number - there is nothing left for it to fix',
  '› All of it now lives in its own file (viewonce.js), separate from the rest of the bot',
  '',
  '🔗 *Pairing*: linking was pinned to an unstable, pre-release build of the WhatsApp library (npm\'s "latest" tag currently points at one), which had an open, unresolved bug causing "Couldn\'t link device" right after a code was issued. The bot now uses a specific, stable release instead.',
  '',
  '📥 *Everything downloads without keys*',
  '› {p}play {p}song {p}video {p}yt {p}tiktok {p}ig {p}fb {p}twitter2 {p}threads {p}pinterest',
  '› {p}gdrive {p}mediafire {p}mega {p}terabox {p}apk {p}savefrom {p}spotify {p}pastebin',
  '',
  '🔧 *The bot fixes itself*: it learns which download sources work and tries the best first, updates yt-dlp, cleans up leftovers, reconnects a stuck connection, and reads live fixes from GitHub. The admin sees it all with {p}selfheal, {p}errors and {p}health.',
  '',
  '📣 *Admin*: {p}relinkall was for telling everyone to relink for view-once - no longer needed, since view-once just works now.',
  '',
  '🛡️ *Fixed*: a reply could get permanently stuck showing "Waiting for this message" on the other end. The bot now keeps a copy of everything it sends the instant it sends it, so it can resupply that content if WhatsApp ever needs to retry delivering it - before, that only worked by chance.',
  '',
  '🛡️ *Also*: Hanson works again, real error reasons are shown instead of vague ones, a mistyped command gets a "did you mean" hint, and flooding the bot is slowed down.',
  '',
  '*Earlier:* {p}emojimix, {p}meme, {p}textall, {p}updates, and starter settings for new users.',
];

function text(prefix = '.') {
  return `🆕 *Hans-Mini updated to v${version}*\n\n` + notes.join('\n').replace(/\{p\}/g, prefix) + `\n\nType ${prefix}updates anytime to see this again.`;
}

module.exports = { version, notes, text };
