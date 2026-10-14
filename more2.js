'use strict';
/**
 * Hans-Mini more2.js
 *   AI:        .ai  .imagine  .translate  .summarize  .chatbot
 *   Reaction:  .reaction  (auto-react to incoming messages)
 *   Admin:     .broadcast  .msguser   (admin bot only, like admin.js)
 * Loaded from the last lines of more.js. Settings live in sock.hm.db (chatbot, reaction).
 *
 * AI service: by default a free keyless service (Pollinations). To use your own
 * OpenAI-compatible service set these Railway variables (optional):
 *   AI_URL   full chat-completions address, e.g. https://api.openai.com/v1/chat/completions
 *   AI_KEY   your key
 *   AI_MODEL model name (default gpt-4o-mini when AI_URL is set)
 */
const num = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmOf = (sock) => sock.hm;

const BOT_NAME = process.env.BOT_NAME || 'Hans-Mini';
const OWNER_NAME = process.env.OWNER_NAME || 'Hanson';
const SYSTEM = `You are ${BOT_NAME}, a friendly WhatsApp assistant made by ${OWNER_NAME}. Reply in the same language as the user. Keep answers short and clear (under 120 words unless asked for more). No markdown headings.`;

const unwrap = (m) => {
  let x = m || {};
  for (let i = 0; i < 4; i++) x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x;
  return x;
};
const textOf = (c) => c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';
const ctxInfo = (c) => Object.values(c || {}).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;

/** text of the message the command replied to */
function quotedText(ctx) {
  const q = ctxInfo(unwrap(ctx.msg?.message))?.quotedMessage;
  return q ? textOf(unwrap(q)).trim() : '';
}

/* ---------------- AI ---------------- */
async function askAI(messages) {
  const url = process.env.AI_URL;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AI_KEY) headers.Authorization = 'Bearer ' + process.env.AI_KEY;
  const body = { model: process.env.AI_MODEL || (url ? 'gpt-4o-mini' : 'openai'), messages };
  const r = await fetch(url || 'https://text.pollinations.ai/openai', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  if (!r.ok) throw new Error(`The AI service returned HTTP ${r.status}. Try again, or set AI_URL and AI_KEY on Railway to use your own service.`);
  const j = await r.json();
  const out = String(j.choices?.[0]?.message?.content || '').trim();
  if (!out) throw new Error('The AI sent an empty answer. Try again.');
  return out.slice(0, 3500);
}

async function makeImage(prompt) {
  const u = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
  if (!r.ok || !String(r.headers.get('content-type') || '').startsWith('image')) throw new Error(`The image service returned HTTP ${r.status}. Try again in a minute.`);
  return Buffer.from(await r.arrayBuffer());
}

/* ---------------- admin guard (same rules as admin.js) ---------------- */
function guard(ctx) {
  const m = require('./manager');
  if (!process.env.ADMIN_NUMBER) throw new Error('Admin tools are off. Add the Railway variable ADMIN_NUMBER.');
  if (!ctx.isMainOwner || !m.isAdmin(ctx.config.owners[0])) throw new Error('This command only works on the admin bot.');
  return m;
}

const histories = new Map(); // chat -> [{role, content}]
const lastBot = new Map();   // chat -> time of last chatbot answer
const lastReact = new Map(); // chat -> time of last reaction
const busy = new Set();

/* ---------------- register ---------------- */
function register(add) {
  /* ----- AI commands ----- */
  add('ai', 'AI', '<question>', 'Ask the AI anything (or reply to a message)', async (ctx) => {
    const q = ctx.text.trim() || quotedText(ctx);
    if (!q) throw new Error(`Ask something.\nExample: ${ctx.prefix}ai What is a diesel engine?`);
    return await askAI([{ role: 'system', content: SYSTEM }, { role: 'user', content: q.slice(0, 3000) }]);
  }, { aliases: ['ask', 'gpt', 'chatgpt'] });

  add('imagine', 'AI', '<description>', 'Make a picture with AI', async (ctx) => {
    const p = ctx.text.trim() || quotedText(ctx);
    if (!p) throw new Error(`Describe the picture.\nExample: ${ctx.prefix}imagine a red sports car at sunset`);
    const img = await makeImage(p.slice(0, 400));
    await ctx.sock.sendMessage(ctx.jid, { image: img, caption: `🎨 ${p.slice(0, 100)}` }, { quoted: ctx.msg });
  }, { aliases: ['aiimage', 'draw'] });

  add('translate', 'AI', '<language> | <text>  (or reply)', 'Translate text with AI', async (ctx) => {
    let lang, text;
    if (ctx.text.includes('|')) {
      const [l, ...r] = ctx.text.split('|');
      lang = l.trim(); text = r.join('|').trim();
    } else {
      lang = (ctx.args[0] || '').trim();
      text = ctx.args.slice(1).join(' ').trim();
    }
    text = text || quotedText(ctx);
    if (!lang || !text) throw new Error(`Usage: ${ctx.prefix}translate french | good morning\nor reply to a message: ${ctx.prefix}translate french`);
    return await askAI([
      { role: 'system', content: 'You are a translator. Reply with the translation only, nothing else.' },
      { role: 'user', content: `Translate into ${lang.slice(0, 30)}:\n\n${text.slice(0, 3000)}` },
    ]);
  }, { aliases: ['tr', 'trt'] });

  add('summarize', 'AI', '<text> (or reply)', 'Summarize a text or the message you reply to', async (ctx) => {
    const t = ctx.text.trim() || quotedText(ctx);
    if (!t) throw new Error(`Reply to a long message with ${ctx.prefix}summarize, or write the text after it.`);
    return await askAI([
      { role: 'system', content: 'Summarize the text in a few short bullet points, in the same language as the text.' },
      { role: 'user', content: t.slice(0, 6000) },
    ]);
  }, { aliases: ['summary', 'tldr'] });

  /* ----- chatbot ----- */
  add('chatbot', 'AI', 'on|off|private|group|all|clear', 'The bot answers people who message you, like a chatbot', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = (db.chatbot ||= { on: false, scope: 'private' });
    const v = (ctx.args[0] || '').toLowerCase();
    if (v === 'clear') { histories.clear(); return '🧹 Chatbot memory cleared.'; }
    if (['private', 'group', 'all'].includes(v)) { cfg.scope = v; cfg.on = true; save(); return `✅ Chatbot is *ON* for: ${v === 'all' ? 'private chats and groups' : v + ' chats'}.`; }
    if (v === 'on' || v === 'off') { cfg.on = v === 'on'; save(); return `✅ Chatbot turned *${v.toUpperCase()}*${cfg.on ? ` (${cfg.scope}).` : '.'}`; }
    return `🤖 Chatbot is *${cfg.on ? 'ON' : 'OFF'}* (${cfg.scope})\n\nUsage:\n${ctx.prefix}chatbot on|off\n${ctx.prefix}chatbot private  (only private chats)\n${ctx.prefix}chatbot group  (groups, when someone mentions or replies to the bot)\n${ctx.prefix}chatbot all\n${ctx.prefix}chatbot clear`;
  }, { owner: true, aliases: ['aichat', 'autoreply'] });

  /* ----- auto reaction ----- */
  add('reaction', 'Owner', 'on|off|set <emojis>|private|group|all', 'React with an emoji to incoming messages automatically', (ctx) => {
    const { db, save } = hmOf(ctx.sock);
    const cfg = (db.reaction ||= { on: false, scope: 'all', emojis: ['❤️', '🔥', '😂', '👍', '😮'] });
    const v = (ctx.args[0] || '').toLowerCase();
    if (v === 'set') {
      const list = ctx.args.slice(1).filter((e) => e.length <= 8).slice(0, 10);
      if (!list.length) throw new Error(`Give some emojis.\nExample: ${ctx.prefix}reaction set 😂 🔥 ❤️`);
      cfg.emojis = list; cfg.on = true; save();
      return `✅ Auto reaction is *ON* with: ${list.join(' ')}`;
    }
    if (['private', 'group', 'all'].includes(v)) { cfg.scope = v; cfg.on = true; save(); return `✅ Auto reaction is *ON* for: ${v === 'all' ? 'all chats' : v + ' chats'}.`; }
    if (v === 'on' || v === 'off') { cfg.on = v === 'on'; save(); return `✅ Auto reaction turned *${v.toUpperCase()}*.`; }
    return `😀 Auto reaction is *${cfg.on ? 'ON' : 'OFF'}* (${cfg.scope})\nEmojis: ${cfg.emojis.join(' ')}\n\nUsage:\n${ctx.prefix}reaction on|off\n${ctx.prefix}reaction set 😂 🔥 ❤️\n${ctx.prefix}reaction private|group|all`;
  }, { owner: true, aliases: ['autoreact', 'areact'] });

  /* ----- admin: message users ----- */
  add('broadcast', 'Admin', '<message> (or reply)', 'Send a message to every user of your bot', async (ctx) => {
    const m = guard(ctx);
    const text = ctx.text.trim() || quotedText(ctx);
    if (!text) throw new Error(`Write the message.\nExample: ${ctx.prefix}broadcast Hello everyone, the bot has new commands!`);
    const me = num(ctx.config.owners[0]);
    const numbers = [...new Set(m.users().map((u) => String(u.number)))].filter((n) => n && n !== me);
    if (!numbers.length) return 'No users to message yet.';
    const sock = ctx.sock, back = ctx.jid;
    (async () => {
      let ok = 0, fail = 0;
      for (const n of numbers) {
        try { await sock.sendMessage(n + '@s.whatsapp.net', { text: `📢 *${BOT_NAME}*\n\n${text}` }); ok++; } catch { fail++; }
        await sleep(2000 + Math.random() * 2000); // slow on purpose, so WhatsApp does not flag the account
      }
      await sock.sendMessage(back, { text: `✅ Broadcast finished: ${ok} sent, ${fail} failed.` }).catch(() => {});
    })();
    return `📢 Sending to ${numbers.length} user(s), one by one. I will tell you when it is done.`;
  }, { owner: true, aliases: ['bc', 'announce'] });

  add('msguser', 'Admin', '<number> <message>', 'Send a message to one user of your bot', async (ctx) => {
    const m = guard(ctx);
    const n = (ctx.args[0] || '').replace(/\D/g, '');
    const text = ctx.args.slice(1).join(' ').trim() || quotedText(ctx);
    if (n.length < 8 || !text) throw new Error(`Usage: ${ctx.prefix}msguser 233241234567 Hello, your plan ends tomorrow`);
    if (!m.users().some((u) => String(u.number) === n)) throw new Error(`That number is not using the bot. Check the list with ${ctx.prefix}users`);
    await ctx.sock.sendMessage(n + '@s.whatsapp.net', { text: `📩 *${BOT_NAME}*\n\n${text}` });
    return `✅ Sent to +${n}.`;
  }, { owner: true, aliases: ['dmuser'] });
}

/* ---------------- passive: chatbot + auto reaction ---------------- */
async function passive(sock, m) {
  try {
    const jid = m?.key?.remoteJid;
    if (!jid || !m.message || m.key.fromMe || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
    const hm = hmOf(sock);
    const c = unwrap(m.message);
    if (c.reactionMessage || c.protocolMessage || c.senderKeyDistributionMessage) return;
    const isGroup = jid.endsWith('@g.us');
    const now = Date.now();

    /* auto reaction */
    const rc = hm.db.reaction;
    if (rc?.on && rc.emojis?.length && (rc.scope === 'all' || (rc.scope === 'group') === isGroup) && now - (lastReact.get(jid) || 0) > 3000) {
      lastReact.set(jid, now);
      const emoji = pick(rc.emojis);
      setTimeout(() => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {}), 500 + Math.random() * 2000);
    }

    /* chatbot */
    const cb = hm.db.chatbot;
    if (!cb?.on) return;
    if (!(cb.scope === 'all' || (cb.scope === 'group') === isGroup)) return;
    const text = textOf(c).trim();
    if (!text || text.length > 1500 || /^[.!#\/$~,]/.test(text)) return; // empty, too long, or a command
    if (isGroup) {
      const info = ctxInfo(c) || {};
      const mine = [sock.user?.id, sock.user?.lid].filter(Boolean).map(num);
      const mentioned = (info.mentionedJid || []).map(num).some((x) => mine.includes(x));
      const replied = info.participant && mine.includes(num(info.participant));
      if (!mentioned && !replied) return;
    }
    if (busy.has(jid) || now - (lastBot.get(jid) || 0) < 2500) return;
    busy.add(jid);
    try {
      const h = histories.get(jid) || [];
      h.push({ role: 'user', content: text });
      while (h.length > 8) h.shift();
      sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const ans = await askAI([{ role: 'system', content: SYSTEM }, ...h]);
      h.push({ role: 'assistant', content: ans });
      histories.set(jid, h);
      if (histories.size > 200) histories.delete(histories.keys().next().value);
      lastBot.set(jid, Date.now());
      await sock.sendMessage(jid, { text: ans }, { quoted: m });
    } finally { busy.delete(jid); sock.sendPresenceUpdate('paused', jid).catch(() => {}); }
  } catch (e) { console.error('[more2] passive:', e.message); }
}

function boot() { /* nothing to start */ }

module.exports = { register, boot, passive };
