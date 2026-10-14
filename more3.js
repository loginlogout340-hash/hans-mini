'use strict';
/**
 * Hans-Mini more3.js - advanced features
 *   .anticall on|off|msg <text>          reject calls automatically
 *   .antibadword on|delete|warn|kick|off + .addbadword .delbadword .badwords   (groups)
 *   .antispam on|delete|warn|kick|off    stop message flooding (groups)
 *   .afk [reason] / .afk off             auto-reply while you are away
 *   .autoread on|off                     mark incoming messages as read
 *   .autotyping off|typing|recording     show "typing..." or "recording..." in private chats
 *   .autobio on|off|set <text>           keep your WhatsApp About text fresh ({time} = clock)
 * Loaded from more.js (register, boot, passive). Settings live in sock.hm.db.
 */
const num = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
const hmOf = (sock) => sock.hm;
const DEFAULT_WARN_LIMIT = 3;

const unwrap = (m) => {
  let x = m || {};
  for (let i = 0; i < 4; i++) x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x;
  return x;
};
const textOf = (c) => c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '';
const ctxInfo = (c) => Object.values(c || {}).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;
const ago = (t) => {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'a moment';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  return Math.floor(s / 86400) + ' d';
};
const onOff = (v) => (v ? '✅ ON' : '❌ OFF');

/* ---------------- group helpers ---------------- */
const metaCache = new Map();
async function groupMeta(sock, jid) {
  const h = metaCache.get(jid);
  if (h && Date.now() - h.t < 60000) return h.d;
  const d = await sock.groupMetadata(jid);
  metaCache.set(jid, { t: Date.now(), d });
  if (metaCache.size > 200) metaCache.delete(metaCache.keys().next().value);
  return d;
}
const idsOfP = (p) => [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean).map(num);
const isAdminOf = (md, ids) => md.participants.some((p) => p.admin && idsOfP(p).some((x) => ids.includes(x)));

/** delete the message, then warn / kick according to the mode */
async function punish(sock, m, mode, why, key) {
  const jid = m.key.remoteJid;
  const sender = m.key.participant || m.participant;
  const { db, save } = hmOf(sock);
  const tag = num(sender);
  await sock.sendMessage(jid, { delete: m.key }).catch(() => {});
  if (mode === 'kick') {
    await sock.groupParticipantsUpdate(jid, [sender], 'remove').catch(() => {});
    return sock.sendMessage(jid, { text: `🚫 @${tag} removed for ${why}.`, mentions: [sender] });
  }
  if (mode === 'warn') {
    const limit = db.groups?.[jid]?.warnLimit || DEFAULT_WARN_LIMIT;
    const w = ((db.warns ||= {})[jid] ||= {});
    const n = (w[key + tag] = (w[key + tag] || 0) + 1);
    if (n >= limit) {
      delete w[key + tag]; save();
      await sock.groupParticipantsUpdate(jid, [sender], 'remove').catch(() => {});
      return sock.sendMessage(jid, { text: `🚨 @${tag} removed.\nReason: ${why}\nWarns: ${n}/${limit}`, mentions: [sender] });
    }
    save();
    return sock.sendMessage(jid, { text: `⚠️ @${tag}, warned for ${why}!\nMessage deleted.\nWarns: ${n}/${limit}.`, mentions: [sender] });
  }
  return sock.sendMessage(jid, { text: `⚠️ @${tag}, ${why} is not allowed here.`, mentions: [sender] });
}

/* ---------------- register ---------------- */
function register(add) {
  /* ----- anti call ----- */
  add('anticall', 'Owner', 'on|off|msg <text>', 'Reject WhatsApp calls automatically and send a message', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = (db.anticall ||= { on: false, msg: '' });
    const v = (ctx.args[0] || '').toLowerCase();
    if (v === 'msg') {
      const t = ctx.text.replace(/^msg\s*/i, '').trim();
      if (!t) throw new Error(`Usage: ${ctx.prefix}anticall msg Sorry, I do not take calls. Please send a message.`);
      cfg.msg = t.slice(0, 300); save();
      return '✅ Call message saved.';
    }
    if (v === 'on' || v === 'off') { cfg.on = v === 'on'; save(); return `✅ Anti call turned *${v.toUpperCase()}*.`; }
    return `📵 Anti call is *${cfg.on ? 'ON' : 'OFF'}*\nMessage: ${cfg.msg || 'default'}\n\nUsage:\n${ctx.prefix}anticall on|off\n${ctx.prefix}anticall msg <text>`;
  }, { owner: true, aliases: ['nocall', 'rejectcall'] });

  /* ----- bad words ----- */
  add('antibadword', 'Group', 'on|delete|warn|kick|off', 'Delete, warn or kick for bad words (admins are exempt)', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = ((db.badword ||= {})[ctx.jid] ||= { mode: 'off', words: [] });
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['on', 'delete', 'warn', 'kick', 'off'].includes(v)) {
      return `Anti bad word: *${cfg.mode}*  (${cfg.words.length} word(s))\nUsage: ${ctx.prefix}antibadword on|delete|warn|kick|off\nAdd words: ${ctx.prefix}addbadword <word>\nList: ${ctx.prefix}badwords`;
    }
    cfg.mode = v === 'on' ? 'delete' : v; save();
    return `✅ Anti bad word is now *${cfg.mode}*${cfg.words.length ? '' : `\nNo words yet. Add some with ${ctx.prefix}addbadword <word>`}`;
  }, { group: true, admin: true, botAdmin: true, aliases: ['badwordfilter'] });

  add('addbadword', 'Group', '<word>', 'Add a word to the group bad word list', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = ((db.badword ||= {})[ctx.jid] ||= { mode: 'off', words: [] });
    const w = ctx.text.trim().toLowerCase();
    if (!w || w.length > 40) throw new Error(`Usage: ${ctx.prefix}addbadword <word>  (up to 40 characters)`);
    if (cfg.words.length >= 100) throw new Error('The list is full (100 words).');
    if (cfg.words.includes(w)) return 'ℹ️ That word is already in the list.';
    cfg.words.push(w); save();
    return `✅ Added. ${cfg.words.length} word(s) in the list. Filter is *${cfg.mode}*${cfg.mode === 'off' ? ` (turn it on with ${ctx.prefix}antibadword on)` : ''}.`;
  }, { group: true, admin: true });

  add('delbadword', 'Group', '<word>', 'Remove a word from the group bad word list', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = ((db.badword ||= {})[ctx.jid] ||= { mode: 'off', words: [] });
    const w = ctx.text.trim().toLowerCase();
    const before = cfg.words.length;
    cfg.words = cfg.words.filter((x) => x !== w); save();
    return before !== cfg.words.length ? '🗑️ Removed.' : 'ℹ️ That word is not in the list.';
  }, { group: true, admin: true });

  add('badwords', 'Group', '', 'Show the group bad word list', (ctx) => {
    const cfg = hmOf(ctx.sock).db.badword?.[ctx.jid];
    return cfg?.words?.length ? `🚫 *Bad words* (${cfg.mode})\n` + cfg.words.map((w, i) => `${i + 1}. ${w}`).join('\n') : `No bad words yet. Add one with ${ctx.prefix}addbadword <word>`;
  }, { group: true, admin: true });

  /* ----- anti spam ----- */
  add('antispam', 'Group', 'on|delete|warn|kick|off', 'Stop message flooding: 6 messages in 8 seconds by a non-admin', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const spam = (db.antispam ||= {});
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['on', 'delete', 'warn', 'kick', 'off'].includes(v)) return `Anti spam: *${spam[ctx.jid] || 'off'}*\nUsage: ${ctx.prefix}antispam on|delete|warn|kick|off`;
    spam[ctx.jid] = v === 'on' ? 'delete' : v; save();
    return `✅ Anti spam is now *${spam[ctx.jid]}*`;
  }, { group: true, admin: true, botAdmin: true, aliases: ['noflood', 'antiflood'] });

  /* ----- afk ----- */
  add('afk', 'Owner', '[reason] | off', 'Reply automatically while you are away', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const t = ctx.text.trim();
    if (/^(off|back)$/i.test(t)) { db.afk = { on: false }; save(); return '👋 Welcome back! AFK is *OFF*.'; }
    db.afk = { on: true, reason: (t || 'I am away right now.').slice(0, 200), since: Date.now() };
    afkSeen.clear(); save();
    return `💤 AFK is *ON*: ${db.afk.reason}\nPeople who message you get this reply once. It turns off when you send a normal message, or use ${ctx.prefix}afk off.`;
  }, { owner: true, aliases: ['away'] });

  /* ----- auto read / typing ----- */
  add('autoread', 'Owner', 'on|off', 'Mark incoming messages as read automatically', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) return `Auto read is *${db.autoread ? 'ON' : 'OFF'}*.\nUsage: ${ctx.prefix}autoread on|off`;
    db.autoread = v === 'on'; save();
    return `✅ Auto read turned *${v.toUpperCase()}*.`;
  }, { owner: true, aliases: ['readmessages'] });

  add('autotyping', 'Owner', 'off|typing|recording', 'Show typing or recording in private chats when someone messages you', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['off', 'typing', 'recording', 'on'].includes(v)) return `Auto presence: *${db.autotyping || 'off'}*\nUsage: ${ctx.prefix}autotyping typing|recording|off`;
    db.autotyping = v === 'on' ? 'typing' : v; save();
    return `✅ Auto presence is now *${db.autotyping}*.`;
  }, { owner: true, aliases: ['typing'] });

  /* ----- auto bio ----- */
  add('autobio', 'Owner', 'on|off|set <text>', 'Keep your WhatsApp About text updated, {time} shows the clock', async (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = (db.autobio ||= { on: false, text: '🤖 Hans-Mini online | {time}', tz: 'Africa/Accra' });
    const v = (ctx.args[0] || '').toLowerCase();
    if (v === 'set') {
      const t = ctx.text.replace(/^set\s*/i, '').trim();
      if (!t) throw new Error(`Usage: ${ctx.prefix}autobio set Online | {time}`);
      cfg.text = t.slice(0, 120); cfg.on = true; save(); startBio(ctx.sock);
      await applyBio(ctx.sock);
      return `✅ Auto bio is *ON*: ${renderBio(cfg)}`;
    }
    if (v === 'on' || v === 'off') {
      cfg.on = v === 'on'; save(); startBio(ctx.sock);
      if (cfg.on) await applyBio(ctx.sock);
      return `✅ Auto bio turned *${v.toUpperCase()}*.`;
    }
    return `📝 Auto bio is *${cfg.on ? 'ON' : 'OFF'}*\nText: ${cfg.text}\n\nUsage:\n${ctx.prefix}autobio on|off\n${ctx.prefix}autobio set <text>  ({time} = clock)\nIt updates every 10 minutes.`;
  }, { owner: true, aliases: ['setautobio'] });
}

/* ---------------- auto bio ---------------- */
function renderBio(cfg) {
  let time = '';
  try { time = new Date().toLocaleTimeString('en-GB', { timeZone: cfg.tz || 'Africa/Accra', hour: '2-digit', minute: '2-digit' }); } catch { time = ''; }
  return String(cfg.text || '').replace(/\{time\}/gi, time).slice(0, 139);
}
async function applyBio(sock) {
  const cfg = hmOf(sock).db.autobio;
  if (!cfg?.on) return;
  try { await sock.updateProfileStatus(renderBio(cfg)); } catch (e) { console.error('[more3] autobio:', e.message); }
}
function startBio(sock) {
  const hm = hmOf(sock);
  clearInterval(hm.bioTimer);
  if (!hm.db.autobio?.on) return;
  hm.bioTimer = setInterval(() => applyBio(sock), 10 * 60000);
  hm.bioTimer.unref?.();
}

/* ---------------- boot: calls + bio ---------------- */
function boot(sock) {
  const hm = hmOf(sock);
  sock.ev.on('call', async (calls) => {
    try {
      const cfg = hm.db.anticall;
      if (!cfg?.on) return;
      for (const c of calls || []) {
        if (c.status !== 'offer') continue;
        const n = num(c.from || c.chatId);
        if (n === hm.owner || (hm.db.sudo || []).includes(n)) continue;
        await sock.rejectCall(c.id, c.from).catch((e) => console.error('[more3] rejectCall:', e.message));
        await sock.sendMessage(c.from, { text: cfg.msg || '📵 Sorry, calls are not answered on this number. Please send a message instead.' }).catch(() => {});
      }
    } catch (e) { console.error('[more3] anticall:', e.message); }
  });
  startBio(sock);
  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'open') { startBio(sock); applyBio(sock); }
    if (connection === 'close') clearInterval(hm.bioTimer);
  });
}

/* ---------------- passive ---------------- */
const afkSeen = new Map();   // chat -> time of the last afk reply
const spamLog = new Map();   // chat:sender -> timestamps
const PREFIX_RE = /^[.!#\/$~,]/;

async function passive(sock, m) {
  try {
    const jid = m?.key?.remoteJid;
    if (!jid || !m.message || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
    const hm = hmOf(sock);
    const { db } = hm;
    const c = unwrap(m.message);
    if (c.reactionMessage || c.protocolMessage || c.senderKeyDistributionMessage) return;
    const isGroup = jid.endsWith('@g.us');
    const text = textOf(c);

    /* my own messages: a normal message ends AFK */
    if (m.key.fromMe) {
      if (db.afk?.on && text && !PREFIX_RE.test(text.trim()) && Date.now() - (db.afk.since || 0) > 5000) { db.afk = { on: false }; hm.save(); }
      return;
    }

    /* auto read + typing */
    if (db.autoread) sock.readMessages([m.key]).catch(() => {});
    if (!isGroup && db.autotyping && db.autotyping !== 'off') {
      const kind = db.autotyping === 'recording' ? 'recording' : 'composing';
      sock.sendPresenceUpdate(kind, jid).catch(() => {});
      setTimeout(() => sock.sendPresenceUpdate('paused', jid).catch(() => {}), 3000 + Math.random() * 2000);
    }

    /* afk reply */
    if (db.afk?.on && text && !PREFIX_RE.test(text.trim())) {
      let reply = !isGroup;
      if (isGroup) {
        const info = ctxInfo(c) || {};
        const mine = [sock.user?.id, sock.user?.lid].filter(Boolean).map(num);
        reply = (info.mentionedJid || []).map(num).some((x) => mine.includes(x)) || (info.participant && mine.includes(num(info.participant)));
      }
      if (reply && Date.now() - (afkSeen.get(jid) || 0) > 30 * 60000) {
        afkSeen.set(jid, Date.now());
        if (afkSeen.size > 500) afkSeen.delete(afkSeen.keys().next().value);
        await sock.sendMessage(jid, { text: `💤 *I'm away right now*\n${db.afk.reason}\n_Away for ${ago(db.afk.since)}. I will reply when I'm back._` }, { quoted: m });
      }
    }

    /* group moderation: bad words and spam */
    if (!isGroup) return;
    const badCfg = db.badword?.[jid];
    const spamMode = db.antispam?.[jid] || 'off';
    const badOn = badCfg && badCfg.mode !== 'off' && badCfg.words?.length && text;
    if (!badOn && spamMode === 'off') return;
    const sender = m.key.participant || m.participant;
    if (!sender) return;
    const ids = [sender, m.key.participantAlt].filter(Boolean).map(num);
    if (ids.some((x) => x === hm.owner || (db.sudo || []).includes(x))) return;

    let mode = null, why = '', key = '';
    if (badOn) {
      const t = ' ' + text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ') + ' ';
      if (badCfg.words.some((w) => t.includes(' ' + w.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() + ' '))) { mode = badCfg.mode; why = 'bad words'; key = 'b:'; }
    }
    if (!mode && spamMode !== 'off') {
      const k = jid + ':' + num(sender), now = Date.now();
      const arr = (spamLog.get(k) || []).filter((t) => now - t < 8000);
      arr.push(now); spamLog.set(k, arr);
      if (spamLog.size > 2000) spamLog.delete(spamLog.keys().next().value);
      if (arr.length >= 6) { mode = spamMode; why = 'spamming'; key = 's:'; spamLog.set(k, []); }
    }
    if (!mode) return;
    const md = await groupMeta(sock, jid);
    if (isAdminOf(md, ids)) return;
    if (!isAdminOf(md, [sock.user?.id, sock.user?.lid].filter(Boolean).map(num))) return; // the bot must be admin to act
    await punish(sock, m, mode, why, key);
  } catch (e) { console.error('[more3] passive:', e.message); }
}

module.exports = { register, boot, passive };
