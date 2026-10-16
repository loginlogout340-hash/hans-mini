'use strict';
/**
 * Hans-Mini hanson.js - "Hanson", the AI assistant built into the bot.
 *
 *   .hanson on | off      turn the assistant on or off (saved per user)
 *   .hanson owner | all   who may talk to Hanson: only you (default) or everybody who can use your bot
 *   .hanson forget        clear Hanson's memory of the chats
 *   .hanson               show the status
 *
 * When Hanson is ON, start a message with his name and say what you want:
 *   "Hanson play burna boy last last"        -> he runs .play for you
 *   "Hanson translate this to french"        -> (reply to a message) he runs .translate
 *   "Hanson what does antitag do?"           -> he answers in the chat
 * Hanson never has more power than the person talking: he types the command as that person,
 * so owner-only and admin-only commands are still refused for everybody else.
 *
 * Loaded from: more.js  (require('./hanson').register(add))  and bot.js (wants + route, at the top of handle).
 * Uses the same AI service as .ai (more2.js): free keyless by default, or AI_URL / AI_KEY / AI_MODEL on Railway.
 */
const NAME = 'Hanson';
const hmOf = (sock) => sock.hm;
const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// commands Hanson will never run for you (type them yourself): they change who controls the bot or message other people
const NEVER = new Set(['hanson', 'setsudo', 'addsudo', 'delsudo', 'unlink', 'broadcast', 'bc', 'announce', 'msguser', 'dmuser',
  'removeuser', 'banuser', 'unbanuser', 'block', 'unblock', 'users', 'banned', 'watch']);

const TRIGGER = /^\s*(?:(?:hey|hi|hello|yo|ok|okay)[\s,]+)?hanson\b[\s,:!.\-]*/i;
const textOf = (m) => {
  let x = m || {};
  for (let i = 0; i < 4; i++) x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x.editedMessage?.message || x;
  return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || x.documentMessage?.caption || '';
};
const unwrapMsg = (m) => {
  let x = m || {};
  for (let i = 0; i < 4; i++) x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x.editedMessage?.message || x;
  return x;
};
const ctxInfoOf = (x) => Object.values(x || {}).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo || {};
const cfgOf = (sock) => (hmOf(sock).db.hanson ||= { on: false, scope: 'owner' });
const stOf = (sock) => (hmOf(sock).hn ||= { hist: new Map(), busy: new Set(), rate: new Map() });

/* ---------------- who is talking ---------------- */
function whoIs(sock, msg, config) {
  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const ids = [msg.key.fromMe ? sock.user?.id : (isGroup ? msg.key.participant || msg.participant : jid), msg.key.participantAlt, msg.key.remoteJidAlt]
    .filter(Boolean).map(digits);
  const main = !!msg.key.fromMe || ids.some((s) => config.owners.includes(s));
  const sudo = hmOf(sock).db.sudo || [];
  return { isGroup, ids, isOwner: main || ids.some((s) => sudo.includes(s)) };
}

/* ---------------- the command list Hanson is allowed to use ---------------- */
const catalogCache = new Map();
function catalog(registry, isOwner) {
  const key = isOwner ? 'o' : 'u';
  if (catalogCache.has(key) && catalogCache.get(key).size === registry.size) return catalogCache.get(key).text;
  const seen = new Set();
  const lines = [];
  for (const c of registry.values()) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (NEVER.has(c.name) || String(c.category).toLowerCase() === 'admin' || (c.owner && !isOwner)) continue;
    lines.push(`${c.name}${c.usage ? ' ' + c.usage : ''} - ${String(c.desc || '').slice(0, 70)}`);
  }
  const text = lines.join('\n');
  catalogCache.set(key, { size: registry.size, text });
  return text;
}

/* ---------------- ask the AI ---------------- */
function systemPrompt(botName, owner, cat, facts) {
  return `You are ${NAME}, the built-in assistant of the WhatsApp bot ${botName}, made by ${owner}.
You help people use the bot's commands. You can either run ONE command for them or just answer.
Answer with JSON only, in one of these two shapes:
{"cmd":"<command name and arguments, no prefix>","say":"<optional very short line>"}
{"say":"<your answer>"}

Rules:
- If the person asks you to DO something a command can do, use "cmd". Example: "play burna boy last last" -> {"cmd":"play burna boy last last"}.
- Use only commands from the list. Never invent a command. If none fits, answer in "say" and mention the closest command.
- If a command needs a picture, audio, video or a replied message and the facts below say there is none, do not run it: tell the person to reply to one (or send it) and name the command.
- For questions, chat, advice or "how do I..." answer in "say": short, clear, in the person's language, no markdown headings. Mention the command with the prefix "${facts.prefix}".
- "say" is plain WhatsApp text, under 120 words.

Facts about this message: ${facts.group ? 'sent in a group' : 'sent in a private chat'}; ${facts.media ? 'it has attached media' : 'no attached media'}; ${facts.quoted ? 'it replies to another message' + (facts.quotedText ? ' that says: "' + facts.quotedText + '"' : '') : 'it does not reply to anything'}; the person is ${facts.owner ? 'the bot owner' : 'a normal user (owner-only commands are not in your list)'}.

Commands (name usage - description):
${cat}`;
}

function parseAnswer(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      return { cmd: typeof j.cmd === 'string' ? j.cmd.trim().replace(/^[.!#\/$~,]+/, '') : '', say: typeof j.say === 'string' ? j.say.trim() : '' };
    } catch { /* fall through: treat as plain text */ }
  }
  return { cmd: '', say: s.replace(/^```(?:json)?|```$/g, '').trim() };
}

/* ---------------- hooks used by bot.js ---------------- */
/** quick, synchronous: is this message for Hanson? */
function wants(sock, msg, config) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || !msg.message) return false;
    if (!cfgOf(sock).on) return false;
    const t = textOf(msg.message).trim();
    if (!t || !TRIGGER.test(t)) return false;
    if ([config.prefix, '.', '!', '#', '/', '$', '~', ','].some((p) => t.startsWith(p))) return false; // a normal command
    return true;
  } catch { return false; }
}

/**
 * Handles the message. Returns a rewritten message (the command Hanson decided on, typed as the same person)
 * for bot.js to run as usual, or null when Hanson already answered / nothing to do.
 */
async function route(sock, msg, { config, registry }) {
  const jid = msg.key.remoteJid;
  const hm = hmOf(sock);
  const cfg = cfgOf(sock);
  const st = stOf(sock);
  const who = whoIs(sock, msg, config);
  if (!who.isOwner && (cfg.scope !== 'all' || config.mode === 'private')) return null; // Hanson only talks to the owner

  const reply = (text) => sock.sendMessage(jid, { text: `🤖 *${NAME}*\n${text}` }, { quoted: msg }).catch(() => {});

  // strangers: at most 12 questions per 10 minutes each
  if (!who.isOwner) {
    const k = who.ids[0] || jid, now = Date.now();
    const arr = (st.rate.get(k) || []).filter((t) => now - t < 600000);
    if (arr.length >= 12) { await reply('I need a short break. Ask me again in a few minutes.'); return null; }
    arr.push(now); st.rate.set(k, arr);
    if (st.rate.size > 500) st.rate.delete(st.rate.keys().next().value);
  }
  if (st.busy.has(jid)) return null;
  st.busy.add(jid);
  try {
    const x = unwrapMsg(msg.message);
    const original = textOf(msg.message).trim();
    const request = original.replace(TRIGGER, '').trim();
    if (!request) {
      await reply(`Yes? Tell me what to do or ask me anything.\nExample: *${NAME} play burna boy last last*`);
      return null;
    }
    const info = ctxInfoOf(x);
    const quotedMsg = info.quotedMessage ? unwrapMsg(info.quotedMessage) : null;
    const facts = {
      prefix: config.prefix,
      group: who.isGroup,
      owner: who.isOwner,
      media: !!(x.imageMessage || x.videoMessage || x.audioMessage || x.stickerMessage || x.documentMessage),
      quoted: !!quotedMsg,
      quotedText: quotedMsg ? textOf(quotedMsg).slice(0, 300).replace(/\s+/g, ' ') : '',
    };
    const cat = catalog(registry, who.isOwner);
    const hist = st.hist.get(jid) || [];
    const { askAI } = require('./more2');
    sock.sendPresenceUpdate('composing', jid).catch(() => {});
    let raw;
    try {
      raw = await askAI([
        { role: 'system', content: systemPrompt(config.botName, process.env.OWNER_NAME || 'Hanson', cat, facts) },
        ...hist,
        { role: 'user', content: request.slice(0, 1000) },
      ]);
    } catch (e) { await reply('⚠️ ' + e.message); return null; }
    finally { sock.sendPresenceUpdate('paused', jid).catch(() => {}); }

    const ans = parseAnswer(raw);
    const remember = (assistant) => {
      hist.push({ role: 'user', content: request.slice(0, 300) }, { role: 'assistant', content: assistant.slice(0, 300) });
      while (hist.length > 8) hist.shift();
      st.hist.set(jid, hist);
      if (st.hist.size > 100) st.hist.delete(st.hist.keys().next().value);
    };

    /* just an answer */
    if (!ans.cmd) {
      remember(ans.say || '(no answer)');
      await reply(ans.say || 'I did not understand that. Try: *' + NAME + ' what can you do?*');
      return null;
    }

    /* a command: check it, then let bot.js run it exactly as if the person had typed it */
    const name = ans.cmd.split(/\s+/)[0].toLowerCase();
    const cmd = registry.get(name);
    if (!cmd || String(cmd.category).toLowerCase() === 'admin') {
      remember(ans.say || 'unknown command');
      await reply(ans.say || `I could not find a command for that. Type *${config.prefix}menu* to see everything.`);
      return null;
    }
    if (NEVER.has(cmd.name) || NEVER.has(name)) {
      remember('refused ' + name);
      await reply(`For safety I do not run *${config.prefix}${cmd.name}* myself. Type it yourself if you really want it.`);
      return null;
    }
    if (cmd.owner && !who.isOwner) {
      remember('refused ' + name);
      await reply(`*${config.prefix}${cmd.name}* is for the bot owner only.`);
      return null;
    }
    remember(`ran ${config.prefix}${ans.cmd}`);
    if (ans.say) await reply(ans.say);
    return rewrite(msg, config.prefix + ans.cmd.slice(0, 500));
  } catch (e) {
    console.error('[hanson]', e.message);
    await reply('⚠️ Something went wrong. Try again.');
    return null;
  } finally { st.busy.delete(jid); }
}

/** the same message, but its text is now the command (reply context and attached picture/video are kept) */
function rewrite(msg, text) {
  const inner = unwrapMsg(msg.message);
  const keep = { ...msg };
  if (inner.imageMessage) keep.message = { imageMessage: { ...inner.imageMessage, caption: text } };
  else if (inner.videoMessage) keep.message = { videoMessage: { ...inner.videoMessage, caption: text } };
  else if (inner.documentMessage) keep.message = { documentMessage: { ...inner.documentMessage, caption: text } };
  else keep.message = { extendedTextMessage: { text, contextInfo: ctxInfoOf(inner) } };
  return keep;
}

/* ---------------- the .hanson command ---------------- */
function register(add) {
  add('hanson', 'AI', 'on | off | owner | all | forget', 'Hanson, the AI assistant inside the bot: turn him on or off', (ctx) => {
    const { save } = hmOf(ctx.sock);
    const cfg = cfgOf(ctx.sock);
    const v = (ctx.args[0] || '').toLowerCase();
    const p = ctx.prefix;
    const who = cfg.scope === 'all' ? 'everybody who can use the bot' : 'only you';
    if (v === 'on' || v === 'off') {
      cfg.on = v === 'on'; save();
      return cfg.on
        ? `🤖 *${NAME} is ON*\nStart a message with his name:\n› ${NAME} play burna boy last last\n› ${NAME} what does ${p}antitag do?\n› (reply to a message) ${NAME} translate this to french\n\nWho can talk to him: ${who}.\nChange it with ${p}hanson all  or  ${p}hanson owner`
        : `🤖 *${NAME} is OFF.* Turn him back on with ${p}hanson on`;
    }
    if (v === 'all' || v === 'owner') {
      cfg.scope = v; save();
      return v === 'all'
        ? `✅ Everybody who can use your bot can now talk to ${NAME}. He only runs commands they are allowed to use.${cfg.on ? '' : `\n(He is still OFF: ${p}hanson on)`}`
        : `✅ Only you can talk to ${NAME} now.${cfg.on ? '' : `\n(He is still OFF: ${p}hanson on)`}`;
    }
    if (v === 'forget' || v === 'clear') { const st = stOf(ctx.sock); st.hist.clear(); return `🧹 ${NAME} forgot the earlier chats.`; }
    return `🤖 *${NAME}* is *${cfg.on ? 'ON' : 'OFF'}*\nWho can talk to him: ${who}\n\n${p}hanson on | off\n${p}hanson all | owner\n${p}hanson forget\n\nExample: *${NAME} make this a sticker* (reply to a picture)`;
  }, { owner: true, aliases: ['assistant', 'jarvis'] });
}

module.exports = { register, wants, route, NAME };
