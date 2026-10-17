'use strict';
/**
 * Manual Mobile Money payments, checked by you.
 *
 *  1. The visitor sends the money to your MoMo number, then types their WhatsApp number and the
 *     Transaction ID from the MoMo message on the pairing website.
 *  2. You get a WhatsApp message on your admin bot with a short reference (for example K7F2P).
 *  3. You compare the Transaction ID with the message on your own phone, then reply:
 *        .approve K7F2P          (gives the access code)      .reject K7F2P wrong id
 *     (the /admin page has the same Approve and Reject buttons).
 *  4. The visitor's page fills in their one-time access code by itself, and the code is also sent to their WhatsApp.
 *
 * Railway variables:  MOMO_NUMBER (shown to the visitor, turns this on)   MOMO_NAME (account name, optional)
 *                     MOMO_NETWORK (for example MTN MoMo, optional)
 * Data: DATA_DIR/momo-requests.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const codes = require('./codes');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DIR, 'momo-requests.json');
const KEEP_MS = 60 * 86400000;      // finished requests are forgotten after 60 days
const PENDING_MAX_PER_NUMBER = 3;
const SITE_WAIT_MS = 7 * 86400000;  // a request nobody answered for a week is closed

const enabled = () => !!(process.env.MOMO_NUMBER || '').trim();
const details = () => ({ number: (process.env.MOMO_NUMBER || '').trim(), name: (process.env.MOMO_NAME || '').trim(), network: (process.env.MOMO_NETWORK || 'Mobile Money').trim() });

let db = { requests: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
for (const [k, r] of Object.entries(db.requests)) if (r.status !== 'pending' && Date.now() - (r.doneAt || r.createdAt) > KEEP_MS) delete db.requests[k];

let timer;
function flush() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('[momo] could not save:', e.message); }
}
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 300); };
process.on('beforeExit', flush);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const shortRef = () => {
  for (;;) {
    const r = [...crypto.randomBytes(5)].map((x) => ALPHABET[x % ALPHABET.length]).join('');
    if (!db.requests[r]) return r;
  }
};
const digits = (s) => String(s || '').replace(/\D/g, '');
const cleanTxn = (s) => String(s || '').trim().toUpperCase().replace(/[\s-]/g, '');
const rank = { pending: 0, approved: 1, rejected: 2 };

class MomoError extends Error {}

function expireOld() {
  const now = Date.now();
  for (const r of Object.values(db.requests)) {
    if (r.status === 'pending' && now - r.createdAt > SITE_WAIT_MS) { r.status = 'rejected'; r.reason = 'This request expired. Send a new one.'; r.doneAt = now; }
  }
}

/** a visitor says "I paid". Returns { key, ref } (key is private to the visitor's browser) */
function submit({ number, txn, name }) {
  if (!enabled()) throw new MomoError('Mobile Money payment is not switched on.');
  number = digits(number);
  if (number.startsWith('0')) throw new MomoError('Start with your country code, without a leading 0 (example: 233241234567).');
  if (number.length < 8 || number.length > 15) throw new MomoError('Enter your WhatsApp number with the country code.');
  const t = cleanTxn(txn);
  if (!/^[A-Z0-9.]{6,32}$/.test(t)) throw new MomoError('That Transaction ID does not look right. Copy it from the MoMo message (6 to 32 letters and numbers).');
  expireOld();
  const all = Object.values(db.requests);
  const dup = all.find((r) => r.txn === t && r.status !== 'rejected');
  if (dup) throw new MomoError(dup.status === 'approved' ? 'This Transaction ID was already used.' : 'This Transaction ID was already sent. Please wait for the confirmation.');
  if (all.filter((r) => r.number === number && r.status === 'pending').length >= PENDING_MAX_PER_NUMBER) throw new MomoError('You already have requests waiting. Please wait for the confirmation.');
  const ref = shortRef();
  const key = crypto.randomBytes(16).toString('hex');
  const price = codes.settings();
  db.requests[ref] = { ref, key, number, txn: t, name: String(name || '').trim().slice(0, 40), amount: price.price, days: price.days, status: 'pending', createdAt: Date.now() };
  save();
  return { key, ref };
}

/** what the visitor's page asks every few seconds */
function status(key) {
  const k = String(key || '');
  const r = Object.values(db.requests).find((x) => x.key === k);
  if (!r) return { state: 'none' };
  if (r.status === 'approved') {
    const c = codes.list().find((x) => x.code === r.code);
    return { state: 'approved', code: r.code, number: r.number, expiresAt: c ? c.expiresAt : null };
  }
  if (r.status === 'rejected') return { state: 'rejected', reason: r.reason || 'We could not confirm this payment.' };
  return { state: 'pending' };
}

const find = (ref) => db.requests[String(ref || '').trim().toUpperCase()];
const pending = () => Object.values(db.requests).filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
const recent = (n = 15) => Object.values(db.requests).sort((a, b) => b.createdAt - a.createdAt).slice(0, n);

/** you checked the money: give the code */
function approve(ref, days) {
  const r = find(ref);
  if (!r) throw new MomoError('No request with that reference.');
  if (r.status === 'approved') return { request: r, code: r.code, again: true };
  if (r.status === 'rejected') throw new MomoError('That request was rejected. The person must send a new one.');
  const rec = codes.issue({ number: r.number, days: days || undefined, ref: 'momo:' + r.txn, source: 'momo' });
  r.status = 'approved'; r.code = rec.code; r.doneAt = Date.now(); r.approvedDays = days || r.days;
  save();
  return { request: r, code: rec.code, expiresAt: rec.expiresAt };
}

function reject(ref, reason) {
  const r = find(ref);
  if (!r) throw new MomoError('No request with that reference.');
  if (r.status !== 'pending') throw new MomoError('That request is already ' + r.status + '.');
  r.status = 'rejected'; r.reason = String(reason || '').trim().slice(0, 120) || 'We could not find that payment. Check the Transaction ID and send it again.'; r.doneAt = Date.now();
  save();
  return r;
}

/* ---------------- WhatsApp messages ---------------- */
const money = (r) => `GH₵${r.amount}`;
const adminText = (r, prefix = '.') => [
  '💰 *New payment request*',
  `Ref: *${r.ref}*`,
  `WhatsApp: +${r.number}`,
  r.name ? `Name: ${r.name}` : '',
  `Transaction ID: *${r.txn}*`,
  `Plan: ${money(r)} for ${r.days} days`,
  '',
  'Open the MoMo message on your phone and check that this Transaction ID and the amount match.',
  `✅ ${prefix}approve ${r.ref}`,
  `❌ ${prefix}reject ${r.ref} <reason>`,
].filter((x) => x !== '').join('\n');

const userText = (code, expiresAt, site) => [
  '✅ *Payment confirmed*',
  `Your one-time access code: *${code}*`,
  expiresAt ? `Valid until ${new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.` : '',
  site ? `Enter it on ${site} to link your WhatsApp.` : 'Enter it on the pairing website to link your WhatsApp.',
  'Keep it private: it only works for this number.',
].filter(Boolean).join('\n');

module.exports = { enabled, details, submit, status, approve, reject, pending, recent, find, adminText, userText, MomoError };
