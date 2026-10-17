'use strict';
/**
 * Admin commands. They work ONLY on the admin's own bot (the number in the Railway variable
 * ADMIN_NUMBER), and only for the real owner of that bot.
 *   .users                 list everyone using the bot
 *   .removeuser <number>   log them out of WhatsApp and delete their data
 *   .banuser <number>      remove them AND stop them from linking again
 *   .unbanuser <number>    allow them again
 *   .banned                list banned numbers
 *   .watch on|off          get an alert in your chat every time a user runs a command
 *   .requests              Mobile Money payment requests waiting for you
 *   .approve <ref> [days]  you checked the payment: send the person their one-time access code
 *   .reject <ref> [reason] payment not found: tell the person to check the Transaction ID
 */
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

function register(add) {
  const guard = (ctx) => {
    const m = require('./manager');
    if (!process.env.ADMIN_NUMBER) throw new Error('Admin tools are off. Add the Railway variable ADMIN_NUMBER (your number with country code, digits only).');
    if (!ctx.isMainOwner || !m.isAdmin(ctx.config.owners[0])) throw new Error('Admin commands only work on the admin bot.');
    return m;
  };
  const target = (ctx, name) => {
    const n = (ctx.args[0] || '').replace(/\D/g, '') || (ctx.mentioned[0] || ctx.quoted?.participant || '').split('@')[0].replace(/\D/g, '');
    if (!n) throw new Error(`Give the number with the country code.\nExample: ${ctx.prefix}${name} 233241234567`);
    return n;
  };

  add('users', 'Admin', '', 'List everyone using your bot', (ctx) => {
    const m = guard(ctx);
    const list = m.users();
    const st = m.stats();
    if (!list.length) return 'No users yet.';
    return `👥 *Users* (${st.users}/${st.max})\n` + list.map((u, i) =>
      `${i + 1}. +${u.number}${u.name ? ' (' + u.name + ')' : ''} ${u.online ? '🟢' : '⚪'}\n    ${u.commands} commands · last used ${ago(u.lastActive)} · up ${ago(u.since).replace(' ago', '')}`).join('\n') +
      `\n\nRemove one: ${ctx.prefix}removeuser <number>`;
  }, { owner: true, aliases: ['listusers', 'botusers'] });

  add('removeuser', 'Admin', '<number>', 'Log a user out of your bot and delete their data', async (ctx) => {
    const m = guard(ctx);
    const r = await m.removeUser(target(ctx, 'removeuser'), false);
    return r === 'notfound' ? 'ℹ️ That number is not using the bot.' : '✅ User removed. They can link again unless you ban them.';
  }, { owner: true, aliases: ['kickuser', 'deluser'] });

  add('banuser', 'Admin', '<number>', 'Remove a user and stop them from linking again', async (ctx) => {
    const m = guard(ctx);
    const r = await m.removeUser(target(ctx, 'banuser'), true);
    return r === 'notfound' ? '✅ Number banned (it was not using the bot).' : '🚫 User removed and banned.';
  }, { owner: true });

  add('unbanuser', 'Admin', '<number>', 'Allow a banned number to link again', (ctx) => {
    const m = guard(ctx);
    return m.unban(target(ctx, 'unbanuser')) ? '✅ Unbanned.' : 'ℹ️ That number was not banned.';
  }, { owner: true });

  add('banned', 'Admin', '', 'List banned numbers', (ctx) => {
    const b = guard(ctx).banned();
    return b.length ? '🚫 *Banned*\n' + b.map((n) => '+' + n).join('\n') : 'No banned numbers.';
  }, { owner: true });

  /* ----- Mobile Money payments (see momo.js) ----- */
  const site = () => (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/+$/, '');

  add('requests', 'Admin', '', 'Mobile Money payment requests waiting for you', (ctx) => {
    guard(ctx);
    const momo = require('./momo');
    const list = momo.pending();
    if (!list.length) return '✅ No payment requests waiting.';
    return `💰 *Waiting for you* (${list.length})\n` + list.map((r) => `\n*${r.ref}*  +${r.number}${r.name ? ' (' + r.name + ')' : ''}\nTransaction ID: ${r.txn}  ·  GH₵${r.amount}  ·  ${ago(r.createdAt)}`).join('\n') +
      `\n\n${ctx.prefix}approve <ref>   or   ${ctx.prefix}reject <ref> <reason>`;
  }, { owner: true, aliases: ['payments', 'pending'] });

  add('approve', 'Admin', '<ref> [days]', 'You checked the payment: send the person their one-time access code', async (ctx) => {
    const m = guard(ctx);
    const momo = require('./momo');
    const ref = (ctx.args[0] || '').toUpperCase();
    if (!ref) throw new Error(`Give the reference.\nExample: ${ctx.prefix}approve K7F2P\nSee the list with ${ctx.prefix}requests`);
    const days = parseInt(ctx.args[1], 10) || undefined;
    let r;
    try { r = momo.approve(ref, days); } catch (e) { throw new Error(e.message); }
    if (r.again) return `ℹ️ ${ref} was already approved. Code: ${r.code}`;
    const sent = await m.sendFromAdmin(r.request.number, momo.userText(r.code, r.expiresAt, site()));
    return `✅ Approved ${ref} for +${r.request.number}\nCode: *${r.code}*\n${sent ? 'The code was sent to their WhatsApp and appears on their page.' : 'It appears on their page. I could not message them, so send it to them yourself if they do not see it.'}`;
  }, { owner: true, aliases: ['confirmpay', 'accept'] });

  add('reject', 'Admin', '<ref> [reason]', 'Payment not found: tell the person to check the Transaction ID', async (ctx) => {
    const m = guard(ctx);
    const momo = require('./momo');
    const ref = (ctx.args[0] || '').toUpperCase();
    if (!ref) throw new Error(`Give the reference.\nExample: ${ctx.prefix}reject K7F2P wrong transaction id`);
    let r;
    try { r = momo.reject(ref, ctx.args.slice(1).join(' ')); } catch (e) { throw new Error(e.message); }
    const sent = await m.sendFromAdmin(r.number, `❌ We could not confirm your payment (ref ${r.ref}).\n${r.reason}\nCheck the Transaction ID in your MoMo message and send it again on the website.`);
    return `✅ Rejected ${ref}. ${sent ? 'They were told on WhatsApp.' : 'They will see it on the page.'}`;
  }, { owner: true, aliases: ['decline'] });

  add('watch', 'Admin', 'on|off', 'Get an alert every time a user runs a command', (ctx) => {
    const m = guard(ctx);
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) return `Watch is *${m.isWatching() ? 'ON' : 'OFF'}*.\nUsage: ${ctx.prefix}watch on|off`;
    m.setWatch(v === 'on');
    return `✅ Watch turned *${v.toUpperCase()}*.`;
  }, { owner: true });
}

module.exports = { register };
