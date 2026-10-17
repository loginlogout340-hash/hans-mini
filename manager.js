'use strict';
/**
 * Keeps track of every user's bot: pairing a new number, restoring saved users on startup,
 * removing users who log out.
 *
 * Data layout (on the Railway volume):   <DATA_DIR>/users/<number>/session, settings.json, extra.json
 * DATA_DIR defaults to SESSION_DIR (so keep your volume mounted there, e.g. /app/session).
 */
const fs = require('fs');
const path = require('path');
const { createBot } = require('./bot');

const DATA_DIR = process.env.DATA_DIR || process.env.SESSION_DIR || './data';
const USERS_DIR = path.join(DATA_DIR, 'users');
const MAX_USERS = parseInt(process.env.MAX_USERS, 10) || 10;
const PAIR_WINDOW_MS = 4 * 60 * 1000; // how long a pairing code stays usable before the attempt is cleaned up

class UserError extends Error {}

const bots = new Map(); // number -> { bot, timer, fresh, announced }

/* ---------- admin: who is allowed, who is banned, alerts ---------- */
const ADMIN = String(process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
let admin = { banned: [], watch: false };
try { admin = { ...admin, ...JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')) }; } catch { /* first run */ }
const saveAdmin = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ADMIN_FILE, JSON.stringify(admin)); } catch (e) { console.error('could not save admin.json:', e.message); } };

/** sends a WhatsApp message to the admin, from the admin's own bot (message yourself) */
function notifyAdmin(text) {
  console.log('[admin]', text.replace(/\n/g, ' | '));
  if (!ADMIN) return;
  const e = bots.get(ADMIN);
  if (!e || !e.bot.isOpen()) return;
  e.bot.sendText(ADMIN + '@s.whatsapp.net', text).catch(() => {});
}
/** sends a WhatsApp message to any number from the admin's own bot (used for payment codes). Returns true when sent. */
async function sendFromAdmin(number, text) {
  if (!ADMIN) return false;
  const e = bots.get(ADMIN);
  if (!e || !e.bot.isOpen()) return false;
  try { await e.bot.sendText(String(number).replace(/\D/g, '') + '@s.whatsapp.net', text); return true; } catch { return false; }
}
const dirFor = (n) => path.join(USERS_DIR, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanNumber(raw) {
  const n = String(raw || '').replace(/\D/g, '');
  if (n.startsWith('0')) throw new UserError('Start with your country code, without a leading 0 (example: 233241234567).');
  if (n.length < 8 || n.length > 15) throw new UserError('That phone number does not look right. Use the country code and digits only.');
  return n;
}

// a login is complete once WhatsApp has stored "me" in the credentials
function readPaired(sessionDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8'));
    return !!(c.registered || c.me);
  } catch { return false; }
}

function remove(number, wipe) {
  const e = bots.get(number);
  if (e) {
    clearTimeout(e.timer);
    e.bot.stop();
    bots.delete(number);
  }
  if (wipe) {
    try { fs.rmSync(dirFor(number), { recursive: true, force: true }); }
    catch (err) { console.error(`[${number}] could not delete data:`, err.message); }
  }
}

function startBot(number) {
  let entry;
  const bot = createBot({
    number,
    dir: dirFor(number),
    onLoggedOut: () => { console.log(`[${number}] removed after logout`); remove(number, true); },
    onEvent: (type, d) => {
      if (type === 'connected' && entry?.fresh && !entry.announced) {
        entry.announced = true;
        notifyAdmin(`🟢 *New user linked*\n+${number}${d.name ? ' (' + d.name + ')' : ''}\nUsers: ${bots.size}/${MAX_USERS}`);
      } else if (type === 'loggedout' && number !== ADMIN) {
        notifyAdmin(`🔴 *User unlinked*\n+${number}`);
      } else if (type === 'command' && admin.watch && number !== ADMIN) {
        notifyAdmin(`👀 +${number}'s bot: ${d.by === number ? 'owner' : '+' + d.by} used .${d.name}${d.group ? ' (in a group)' : ''}`);
      }
    },
  });
  entry = { bot, timer: null, fresh: false, announced: false };
  bots.set(number, entry);
  return entry;
}

/** Starts a fresh login for this number and returns the pairing code. */
async function pair(rawNumber) {
  const number = cleanNumber(rawNumber);
  const existing = bots.get(number);
  if (existing && readPaired(existing.bot.config.sessionDir)) {
    throw new UserError('This number is already linked to the bot. On WhatsApp, send .unlink to the bot chat first if you want to link again.');
  }
  if (existing) remove(number, true); // an unfinished earlier attempt
  if (readPaired(path.join(dirFor(number), 'session'))) {
    throw new UserError('This number is already linked to the bot.');
  }
  if (admin.banned.includes(number)) throw new UserError('This number is not allowed to use the bot.');
  if (bots.size >= MAX_USERS) throw new UserError('The bot is full right now. Please try again later.');

  const entry = startBot(number);
  entry.fresh = true; // a brand-new user: the admin gets an alert when the link completes
  try {
    await entry.bot.start();
    const code = await entry.bot.requestPairingCode();
    notifyAdmin(`📲 Pairing code requested for +${number}`);
    // if the code is never used, free the space again
    entry.timer = setTimeout(() => {
      if (!entry.bot.everOpen()) { console.log(`[${number}] pairing expired`); remove(number, true); }
    }, PAIR_WINDOW_MS);
    return code;
  } catch (e) {
    remove(number, true);
    throw e;
  }
}

/** 'connected' | 'pending' | 'none' */
function status(rawNumber) {
  const number = String(rawNumber || '').replace(/\D/g, '');
  const e = bots.get(number);
  if (!e) return 'none';
  return e.bot.everOpen() ? 'connected' : 'pending';
}

/** Starts every saved user's bot after a restart or redeploy. */
async function restoreAll() {
  let names = [];
  try { names = fs.readdirSync(USERS_DIR); } catch { /* no users yet */ }
  let started = 0;
  for (const n of names) {
    if (!/^\d{8,15}$/.test(n) || bots.has(n)) continue;
    if (!readPaired(path.join(dirFor(n), 'session'))) { // leftovers of a pairing that was never finished
      try { fs.rmSync(dirFor(n), { recursive: true, force: true }); } catch { /* ignore */ }
      continue;
    }
    startBot(n).bot.start().catch((e) => console.error(`[${n}] could not start:`, e.message));
    started++;
    await sleep(2000); // stagger so many logins do not hit the server at once
  }
  console.log(`Restored ${started} saved user(s).`);
}

const stats = () => ({ users: bots.size, max: MAX_USERS });

/* ---------- admin tools (used by the admin commands in admin.js) ---------- */
const isAdmin = (n) => !!ADMIN && String(n) === ADMIN;
function users() {
  return [...bots.entries()].map(([number, e]) => ({
    number, name: e.bot.config.ownerName || '', online: e.bot.isOpen(), linked: e.bot.everOpen(),
    commands: e.bot.stats.commands, lastActive: e.bot.stats.lastActive, since: e.bot.stats.since,
  }));
}
const cleanDigits = (raw) => String(raw || '').replace(/\D/g, '');

/** logs the user's bot out of WhatsApp and deletes their data. 'removed' | 'deleted' | 'notfound' */
async function removeUser(raw, ban) {
  const number = cleanDigits(raw);
  if (number.length < 8) throw new UserError('Give the full number with the country code.');
  if (isAdmin(number)) throw new UserError('You cannot remove yourself.');
  if (ban && !admin.banned.includes(number)) { admin.banned.push(number); saveAdmin(); }
  const e = bots.get(number);
  if (!e) {
    if (fs.existsSync(dirFor(number))) { remove(number, true); return 'deleted'; }
    return 'notfound';
  }
  try { await e.bot.sendText(number + '@s.whatsapp.net', '🚫 Your access to this bot was removed by the admin.'); } catch { /* offline */ }
  try { await e.bot.logout(); } catch { /* offline: cleaned up below */ }
  setTimeout(() => { if (bots.get(number) === e) remove(number, true); }, 4000);
  return 'removed';
}
function unban(raw) {
  const number = cleanDigits(raw);
  const had = admin.banned.includes(number);
  admin.banned = admin.banned.filter((n) => n !== number);
  saveAdmin();
  return had;
}
const banned = () => [...admin.banned];
function setWatch(on) { admin.watch = !!on; saveAdmin(); }
const isWatching = () => admin.watch;

module.exports = { notifyAdmin, sendFromAdmin, pair, status, restoreAll, stats, users, removeUser, unban, banned, setWatch, isWatching, isAdmin, UserError, MAX_USERS, DATA_DIR };
