'use strict';
/**
 * Paid access codes. Saved in DATA_DIR/paid-codes.json (the Railway Volume), so they survive redeploys.
 * One code per phone number. A new payment for the same number extends the same code.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DIR, 'paid-codes.json');
const DAY = 86400000;

let db = { settings: { price: Number(process.env.PRICE_GHS) || 20, days: Number(process.env.PLAN_DAYS) || 30 }, codes: {}, refs: {}, members: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  db = { ...db, ...j, settings: { ...db.settings, ...(j.settings || {}) } };
} catch { /* first run */ }

let timer;
function flush() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('[codes] could not save:', e.message); }
}
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 300); };

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  for (;;) {
    const b = crypto.randomBytes(6);
    const c = 'HM-' + [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
    if (!db.codes[c]) return c;
  }
}
const clean = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');
const digits = (n) => String(n || '').replace(/\D/g, '');

const settings = () => ({ ...db.settings });
function setSettings({ price, days }) {
  if (price != null) { const p = Number(price); if (!(p > 0 && p < 100000)) throw new Error('Bad price.'); db.settings.price = Math.round(p * 100) / 100; }
  if (days != null) { const d = Math.floor(Number(days)); if (!(d >= 1 && d <= 366)) throw new Error('Days must be 1 to 366.'); db.settings.days = d; }
  save();
  return settings();
}

/** Create a code for a number, or extend the number's existing one. ref makes payments idempotent. */
function issue({ number, days, ref, source }) {
  number = digits(number);
  if (number.length < 8 || number.length > 15) throw new Error('Bad phone number.');
  if (ref && db.refs[ref]) return { ...db.codes[db.refs[ref]], code: db.refs[ref], repeated: true };
  days = Math.floor(Number(days) || db.settings.days);
  const now = Date.now();
  let code = Object.keys(db.codes).find((c) => db.codes[c].number === number);
  if (code) {
    const rec = db.codes[code];
    rec.expiresAt = Math.max(now, rec.expiresAt) + days * DAY;
    rec.revoked = false;
  } else {
    code = makeCode();
    db.codes[code] = { number, createdAt: now, expiresAt: now + days * DAY, source: source || 'manual' };
  }
  if (ref) db.refs[ref] = code;
  save();
  return { ...db.codes[code], code };
}

const exists = (code) => !!db.codes[clean(code)];

/** { ok, reason } - reason is a message safe to show the visitor */
function check(code, number) {
  const c = clean(code), rec = db.codes[c];
  if (!rec || rec.revoked) return { ok: false, reason: 'This code is not valid.' };
  if (rec.number !== digits(number)) return { ok: false, reason: 'This code belongs to a different phone number.' };
  if (rec.expiresAt <= Date.now()) return { ok: false, reason: 'This code has expired. Pay again to renew it.' };
  return { ok: true, rec };
}

const list = () => Object.entries(db.codes).map(([code, r]) => ({ code, ...r, active: !r.revoked && r.expiresAt > Date.now(), member: !!db.members[r.number] }))
  .sort((a, b) => b.createdAt - a.createdAt);

function revoke(code) {
  const c = clean(code), rec = db.codes[c];
  if (!rec) return false;
  rec.revoked = true;
  rec.expiresAt = Math.min(rec.expiresAt, Date.now());
  save();
  return true;
}

/* numbers that linked with a paid code (they get removed when the time ends; owner-code users never are) */
function markMember(number) { db.members[digits(number)] = Date.now(); save(); }
function unmember(number) { delete db.members[digits(number)]; save(); }
function expiredMembers() {
  const out = [];
  for (const n of Object.keys(db.members)) {
    const rec = Object.values(db.codes).find((r) => r.number === n);
    if (!rec || rec.revoked || rec.expiresAt <= Date.now()) out.push(n);
  }
  return out;
}

process.on('beforeExit', flush);
module.exports = { settings, setSettings, issue, exists, check, list, revoke, markMember, unmember, expiredMembers, flush, DAY };
