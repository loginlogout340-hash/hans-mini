'use strict';
/**
 * .antibot - a group protection command that detects and removes OTHER WhatsApp bots from a group.
 *
 * BE HONEST ABOUT WHAT THIS CAN AND CANNOT KNOW: WhatsApp does not mark any account as "a bot" - there is
 * no field for it. Every bot that has this feature (and most of the well-known ones do) is really working
 * from two signals, combined here the same way:
 *
 *   1. A BLACKLIST the group's admins build up (.antibot add <number>). Zero guesswork: if that number
 *      sends anything, or even just joins the group, it is removed. This is the only 100% reliable part.
 *
 *   2. A MESSAGE-ID HEURISTIC. Baileys (the library Hans-Mini, and most other unofficial WhatsApp bots,
 *      are built on) generates its own message ids with a recognisable "BAE5" prefix unless a bot author
 *      changes that - the real WhatsApp app never produces ids that look like this. So a message whose id
 *      starts with BAE5, from someone who is not an admin, is quite likely to have been sent by another
 *      bot, not typed by a person. It is a strong signal, not a certainty - a bot author who overrides the
 *      id generator slips past it, and it only looks at id SHAPE, nothing private.
 *
 * Because signal 2 can occasionally be wrong, the default action is "warn" (delete the message, point it
 * out, no removal). ".antibot on kick" switches to removing the sender outright. ".antibot on mute" is
 * gentler than kick: instead of removing them, it silences them - every message they send from then on is
 * deleted, without being removed from the group. A blacklisted number is always removed on sight either
 * way, since there is no guesswork involved there.
 *
 * MUTE, specifically: WhatsApp has no "silence this one person" setting - group settings only cover the
 * whole group (e.g. "only admins can send"), never a single member. So this is enforced by the bot, not
 * WhatsApp: a muted person's messages keep arriving and are deleted the instant they do, for as long as
 * they are on that group's muted list. ".antibot mute <number>" and ".antibot unmute <number>" manage
 * that list directly, and it is checked (and enforced) even while .antibot itself is turned off, since a
 * specific mute is its own decision, separate from the automatic detection.
 *
 * This never acts on a group admin, the group owner, or the bot's own messages, and it only removes or
 * mutes someone when the bot itself is a group admin - otherwise it still deletes the message if it can
 * and says why it could not go further.
 *
 * Settings are per group (one group's list does not affect another), stored in the user's own extra.json
 * under sock.hm.db.groups[<group jid>].antibot, the same place every other per-group setting lives.
 */
const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const norm = (j) => String(j || '').replace(/:\d+@/, '@');
const BOT_ID_RE = /^BAE5/i;

function groupCfg(sock, jid) {
  const groups = (sock.hm.db.groups ||= {});
  const g = (groups[jid] ||= {});
  const cfg = (g.antibot ||= { on: false, action: 'warn', blacklist: [] });
  if (!cfg.muted) cfg.muted = []; // added later: numbers whose messages are deleted on sight, independent of on/off
  return cfg;
}

async function groupAdmins(sock, jid) {
  const meta = await sock.groupMetadata(jid);
  const admins = new Set();
  for (const p of meta.participants) if (p.admin) for (const id of [p.id, p.lid, p.jid].filter(Boolean)) admins.add(norm(id));
  const botIds = [sock.user?.id, sock.user?.lid].filter(Boolean).map(norm);
  return { meta, admins, botIsAdmin: botIds.some((b) => admins.has(b)) };
}

async function tryDelete(sock, jid, key) {
  try { await sock.sendMessage(jid, { delete: key }); return true; } catch { return false; }
}
async function tryRemove(sock, jid, participant) {
  try { await sock.groupParticipantsUpdate(jid, [participant], 'remove'); return true; } catch { return false; }
}

/** called for every incoming group message (bot.js -> more7.js -> here) */
async function passive(sock, msg) {
  try {
    const jid = msg?.key?.remoteJid;
    if (!jid?.endsWith('@g.us') || !msg.message || msg.key.fromMe || !sock.hm) return;
    const cfg = groupCfg(sock, jid);

    const participant = norm(msg.key.participant || jid);
    const num = digits(participant);

    // a mute is enforced even while .antibot itself is off - it is its own standing decision
    if (cfg.muted.includes(num)) {
      const { admins } = await groupAdmins(sock, jid);
      if (admins.has(participant)) { cfg.muted = cfg.muted.filter((n) => n !== num); sock.hm.save(); } // promoted since: a group admin is never kept muted
      else { await tryDelete(sock, jid, msg.key); return; }
    }

    if (!cfg.on) return;
    const blacklisted = cfg.blacklist.includes(num);
    const looksAutomated = BOT_ID_RE.test(msg.key.id || '');
    if (!blacklisted && !looksAutomated) return;

    const { admins, botIsAdmin } = await groupAdmins(sock, jid);
    if (admins.has(participant)) return; // never act on an admin (or the owner, who is always an admin)

    const deleted = await tryDelete(sock, jid, msg.key);
    const action = blacklisted ? 'kick' : cfg.action;
    const why = blacklisted ? ' and it was on the block list' : '';

    if (action === 'kick' || action === 'mute') {
      if (!botIsAdmin) {
        await sock.sendMessage(jid, { text: `🤖 Found a likely bot (+${num}${why}), but I am not an admin here, so I could only${deleted ? '' : ' try to'} delete its message.` }).catch(() => {});
        return;
      }
      if (action === 'kick') {
        const removed = await tryRemove(sock, jid, participant);
        await sock.sendMessage(jid, { text: removed ? `🤖 Removed +${num} - its message looked automated${why}.` : `🤖 Tried to remove +${num} but could not (it may already be gone, or hold a role I cannot remove).` }).catch(() => {});
      } else {
        if (!cfg.muted.includes(num)) { cfg.muted.push(num); sock.hm.save(); }
        await sock.sendMessage(jid, { text: `🤖 Muted +${num} - its message looked automated${why}. Its messages will be deleted from now on.\nLift it with .antibot unmute ${num}` }).catch(() => {});
      }
      return;
    }
    // warn: delete only, say why, no removal
    await sock.sendMessage(jid, { text: `⚠️ @${num}, that message looked automated (common with other WhatsApp bots) and was removed.\nIf this is wrong, an admin can turn it off with .antibot off, or switch to .antibot on kick or .antibot on mute instead of warn.`, mentions: [participant] }).catch(() => {});
  } catch (e) { console.error('[antibot] passive:', e.message); }
}

/** installed once per connection: screens anyone who joins a blacklisted number straight away */
function boot(sock) {
  try {
    sock.ev.on('group-participants.update', async ({ id: jid, participants, action }) => {
      try {
        if (action !== 'add' || !sock.hm) return;
        const cfg = groupCfg(sock, jid);
        if (!cfg.on || !cfg.blacklist.length) return;
        const { botIsAdmin } = await groupAdmins(sock, jid);
        if (!botIsAdmin) return;
        for (const p of participants) {
          const pn = norm(p);
          if (!cfg.blacklist.includes(digits(pn))) continue;
          const removed = await tryRemove(sock, jid, pn);
          if (removed) await sock.sendMessage(jid, { text: `🤖 +${digits(pn)} just joined and is on this group's antibot block list, so it was removed.` }).catch(() => {});
        }
      } catch (e) { console.error('[antibot] join screen:', e.message); }
    });
  } catch (e) { console.error('[antibot] boot:', e.message); }
}

/* -------------------------------- the command -------------------------------- */
async function antibot(ctx) {
  if (!ctx.isAdmin) throw new Error('⛔ Only group admins can use this command.');
  const cfg = groupCfg(ctx.sock, ctx.jid);
  const save = () => ctx.sock.hm.save();
  const p = ctx.prefix;
  const word = (ctx.args[0] || '').toLowerCase();

  if (word === 'on') {
    const act = (ctx.args[1] || '').toLowerCase();
    if (act === 'kick' || act === 'warn' || act === 'mute') cfg.action = act;
    cfg.on = true; save();
    return `✅ Antibot is *ON* for this group (action: ${cfg.action}).\nSwitch it with ${p}antibot on kick  or  ${p}antibot on warn  or  ${p}antibot on mute`;
  }
  if (word === 'off') { cfg.on = false; save(); return '✅ Antibot is now *OFF* for this group. (Any existing mutes still stand - see ' + p + 'antibot muted)'; }

  if (word === 'add') {
    const n = digits(ctx.mentioned[0] || ctx.args[1]);
    if (n.length < 8) throw new Error(`Give a number or @mention.\nExample: ${p}antibot add 15551234567`);
    if (!cfg.blacklist.includes(n)) { cfg.blacklist.push(n); save(); }
    return `✅ +${n} added to this group's antibot block list. It is removed on sight, no guessing needed.`;
  }
  if (word === 'remove' || word === 'del') {
    const n = digits(ctx.mentioned[0] || ctx.args[1]);
    const had = cfg.blacklist.includes(n);
    cfg.blacklist = cfg.blacklist.filter((x) => x !== n);
    save();
    return had ? `✅ +${n} removed from the block list.` : 'ℹ️ That number was not on the block list.';
  }
  if (word === 'mute') {
    const n = digits(ctx.mentioned[0] || ctx.args[1]);
    if (n.length < 8) throw new Error(`Give a number or @mention.\nExample: ${p}antibot mute 15551234567`);
    if (!cfg.muted.includes(n)) { cfg.muted.push(n); save(); }
    return `🔇 +${n} is muted in this group - its messages will be deleted from now on, whether or not antibot is on.\nLift it with ${p}antibot unmute ${n}`;
  }
  if (word === 'unmute') {
    const n = digits(ctx.mentioned[0] || ctx.args[1]);
    const had = cfg.muted.includes(n);
    cfg.muted = cfg.muted.filter((x) => x !== n);
    save();
    return had ? `✅ +${n} can send messages again.` : 'ℹ️ That number was not muted.';
  }
  if (word === 'muted') {
    if (!cfg.muted.length) return 'ℹ️ Nobody is muted in this group right now.';
    return `🔇 *Muted in this group*\n${cfg.muted.map((n, i) => `${i + 1}. +${n}`).join('\n')}`;
  }
  if (word === 'list') {
    if (!cfg.blacklist.length) return `📋 The block list is empty. Add a known bot's number with ${p}antibot add <number>`;
    return `📋 *Antibot block list for this group*\n${cfg.blacklist.map((n, i) => `${i + 1}. +${n}`).join('\n')}`;
  }

  return `🤖 *Antibot* is *${cfg.on ? 'ON' : 'OFF'}* here (action: ${cfg.action})${cfg.muted.length ? ` · ${cfg.muted.length} muted` : ''}\n\nDetects other WhatsApp bots by a message-id pattern common to unofficial bots, plus a block list you keep - never admins, the owner, or real people by name or guesswork. Mute silences a specific person (their messages get deleted) without removing them from the group.\n\n${p}antibot on [kick|warn|mute]\n${p}antibot off\n${p}antibot add / remove <number or @mention>\n${p}antibot mute / unmute <number or @mention>\n${p}antibot list   ·   ${p}antibot muted`;
}

function register(add) {
  add('antibot', 'Group', '[on|off|add|remove|list]', 'Detect and remove other WhatsApp bots from this group', antibot, { group: true, admin: true, aliases: ['nobot'] });
}

module.exports = { register, boot, passive };
