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

const bots = new Map(); // number -> { bot, timer }
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
  const bot = createBot({
    number,
    dir: dirFor(number),
    onLoggedOut: () => { console.log(`[${number}] removed after logout`); remove(number, true); },
  });
  const entry = { bot, timer: null };
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
  if (bots.size >= MAX_USERS) throw new UserError('The bot is full right now. Please try again later.');

  const entry = startBot(number);
  try {
    await entry.bot.start();
    const code = await entry.bot.requestPairingCode();
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

module.exports = { pair, status, restoreAll, stats, UserError, MAX_USERS, DATA_DIR };
