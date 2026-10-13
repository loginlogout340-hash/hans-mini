'use strict';
/**
 * Hans-Mini extra commands (per-user settings live in sock.hm.db, saved by extra.js):
 *   setsudo / delsudo / getsudo, antisticker, welcome, goodbye, games (rps, guess, trivia, ttt),
 *   pp, gpp, block, unblock, savestatus, owner (about the owner)
 * extra.js loads this file:  register(add, { hmOf, grp }), boot(sock, { hmOf }).
 * The anti-sticker detection itself lives in extra.js (passive); here is only the command.
 * bot.js gives every command: ctx.isMainOwner (real owner, not sudo) and ctx.downloadMedia() (picture).
 */
const fs = require('fs');
const path = require('path');

const num = (j = '') => String(j).split('@')[0].split(':')[0].replace(/\D/g, '');
const norm = (j) => String(j || '').replace(/:\d+@/, '@');
const jidOf = (n) => n + '@s.whatsapp.net';
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const hmOf = (sock) => sock.hm;

/* ---------------- owner card (edit these lines to change what .owner shows) ---------------- */
const OWNER = {
  name: '𝙷𝚊𝚗𝚜𝚘𝚗 ✪',
  bio: 'My determination set me apart',
  phone: '233204908710',              // 0204908710 in international format (Ghana +233)
  github: process.env.OWNER_GITHUB || '', // optional: set OWNER_GITHUB on Railway, e.g. https://github.com/yourname
};

function ownerCard() {
  const lines = [
    '╭─❖ *OWNER INFO* ❖─╮',
    '',
    `👤 *Name:* ${OWNER.name}`,
    `💬 *Bio:* ${OWNER.bio}`,
    `📞 *WhatsApp:* wa.me/${OWNER.phone}`,
  ];
  if (OWNER.github) lines.push(`💻 *GitHub:* ${OWNER.github}`);
  lines.push('', '╰──────────────╯');
  return lines.join('\n');
}

/** who the command refers to: @mention, replied message, a number, or the private chat itself */
function targets(ctx) {
  if (ctx.mentioned.length) return ctx.mentioned;
  if (ctx.quoted?.participant) return [ctx.quoted.participant];
  const given = ctx.args.map((a) => a.replace(/\D/g, '')).filter((d) => d.length >= 7).map(jidOf);
  if (given.length) return given;
  if (!ctx.isGroup) return [ctx.jid];
  return [];
}

const unwrap = (m) => {
  let x = m || {};
  for (let i = 0; i < 4; i++) x = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.viewOnceMessageV2?.message || x.documentWithCaptionMessage?.message || x;
  return x;
};
const idsOfP = (p) => [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean).map(num);
const isAdminOf = (md, ids) => md.participants.some((p) => p.admin && idsOfP(p).some((x) => ids.includes(x)));

async function groupMeta(sock, jid) {
  const meta = hmOf(sock).meta;
  const h = meta.get(jid);
  if (h && Date.now() - h.t < 60000) return h.d;
  const d = await sock.groupMetadata(jid);
  meta.set(jid, { t: Date.now(), d });
  return d;
}

const DEFAULT_WARN_LIMIT = 3;

/* ---------------- games ---------------- */
const games = (sock) => (hmOf(sock).gm ||= new Map());

const WINS = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const NUMS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const drawBoard = (b) => [0, 3, 6].map((r) => b.slice(r, r + 3).map((c, i) => c || NUMS[r + i]).join('')).join('\n');
const winner = (b) => { for (const [a, c, d] of WINS) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a]; return null; };

async function trivia() {
  const r = await fetch('https://opentdb.com/api.php?amount=1&type=multiple&encode=url3986', { signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  const q = j.results?.[0];
  if (!q) throw new Error('Could not get a question right now. Try again.');
  const d = decodeURIComponent;
  const correct = d(q.correct_answer);
  const options = [correct, ...q.incorrect_answers.map(d)].sort(() => Math.random() - 0.5);
  return { question: d(q.question), category: d(q.category), options, answer: 'abcd'[options.indexOf(correct)], correct };
}

/* ---------------- register ---------------- */
function register(add) {
  /* ----- about the owner ----- */
  add('ownerinfo', 'Info', '', 'About the owner of this bot', async (ctx) => {
    const card = ownerCard();
    // optional picture: upload a file named owner.jpg (or owner.png) next to this file in the repo
    const file = ['owner.jpg', 'owner.jpeg', 'owner.png'].map((f) => path.join(__dirname, f)).find((f) => fs.existsSync(f));
    if (file) {
      await ctx.sock.sendMessage(ctx.jid, { image: fs.readFileSync(file), caption: card }, { quoted: ctx.msg });
      return; // picture + card sent, nothing more to say
    }
    return card;
  }, { aliases: ['hanson', 'creator', 'dev', 'developer'] });

  /* ----- sudo ----- */
  add('setsudo', 'Owner', '@user (or reply)', 'Give someone owner powers on your bot (sudo)', (ctx) => {
    if (!ctx.isMainOwner) throw new Error('Only the real owner can add sudo users.');
    const t = targets(ctx).map(num);
    if (!t.length) throw new Error(`Mention someone, reply to their message or give a number.\nExample: ${ctx.prefix}setsudo 233241234567`);
    const { db, save } = hmOf(ctx.sock);
    db.sudo ||= [];
    let added = 0;
    for (const n of t) if (!db.sudo.includes(n) && !ctx.config.owners.includes(n)) { db.sudo.push(n); added++; }
    save();
    return added ? `✅ ${added} sudo user(s) added. They can now use owner commands.` : 'ℹ️ Already a sudo user (or the owner).';
  }, { owner: true, aliases: ['addsudo'] });

  add('delsudo', 'Owner', '@user (or reply)', 'Remove a sudo user', (ctx) => {
    if (!ctx.isMainOwner) throw new Error('Only the real owner can remove sudo users.');
    const t = targets(ctx).map(num);
    if (!t.length) throw new Error(`Mention someone, reply to their message or give a number.\nExample: ${ctx.prefix}delsudo 233241234567`);
    const { db, save } = hmOf(ctx.sock);
    const before = (db.sudo || []).length;
    db.sudo = (db.sudo || []).filter((n) => !t.includes(n));
    save();
    return before !== db.sudo.length ? '🗑️ Sudo user removed.' : 'ℹ️ That person is not a sudo user.';
  }, { owner: true, aliases: ['removesudo'] });

  add('getsudo', 'Owner', '', 'List your sudo users', (ctx) => {
    const s = hmOf(ctx.sock).db.sudo || [];
    return s.length ? '👑 *Sudo users*\n' + s.map((n, i) => `${i + 1}. +${n}`).join('\n') : 'You have no sudo users.';
  }, { owner: true, aliases: ['sudolist', 'listsudo'] });

  /* ----- welcome / goodbye ----- */
  const greet = (kind, def, desc) =>
    add(kind, 'Group', 'on|off|set <message>', desc, (ctx) => {
      const { db, save } = hmOf(ctx.sock);
      const g = ((db.greet ||= {})[ctx.jid] ||= {});
      const s = (g[kind] ||= { on: false, msg: '' });
      const v = (ctx.args[0] || '').toLowerCase();
      if (v === 'set') {
        const text = ctx.text.replace(/^set\s*/i, '').trim();
        if (!text) throw new Error(`Usage: ${ctx.prefix}${kind} set Hello @user, welcome to {group}!\n(@user = the member, {group} = group name, {count} = members)`);
        s.msg = text.slice(0, 500); s.on = true; save();
        return `✅ ${kind} message saved and turned *ON*.`;
      }
      if (v !== 'on' && v !== 'off') return `${kind} is *${s.on ? 'ON' : 'OFF'}*.\nMessage: ${s.msg || def}\n\nUsage: ${ctx.prefix}${kind} on|off\n${ctx.prefix}${kind} set <message>`;
      s.on = v === 'on'; save();
      return `✅ ${kind} turned *${v.toUpperCase()}*.`;
    }, { group: true, admin: true });
  greet('welcome', '👋 Welcome @user to *{group}*! You are member #{count}.', 'Greet new members (on|off|set <message>)');
  greet('goodbye', '👋 @user left *{group}*. Goodbye!', 'Say goodbye when a member leaves (on|off|set <message>)');

  /* ----- block / unblock ----- */
  const blockCmd = (name, action, done) =>
    add(name, 'Owner', '@user (or reply, or number)', `${action === 'block' ? 'Block' : 'Unblock'} a WhatsApp user`, async (ctx) => {
      const t = targets(ctx);
      if (!t.length) throw new Error(`Mention someone, reply to their message, give a number, or use it in their private chat.\nExample: ${ctx.prefix}${name} 233241234567`);
      let ok = 0;
      for (const j of t) {
        if (ctx.config.owners.includes(num(j))) continue; // never block the owner
        try { await ctx.sock.updateBlockStatus(norm(j), action); ok++; } catch (e) { console.error(`[${name}]`, e.message); }
      }
      if (!ok) throw new Error(`Could not ${name} that number.`);
      return `✅ ${done}: ${ok} user(s).`;
    }, { owner: true });
  blockCmd('block', 'block', 'Blocked');
  blockCmd('unblock', 'unblock', 'Unblocked');

  /* ----- profile pictures ----- */
  const picError = (e) => (/jimp|sharp|Cannot find module/i.test(e.message)
    ? new Error('The picture tool is missing on the server. Add "jimp" to the dependencies in package.json and redeploy.')
    : e);
  add('pp', 'Owner', '(reply to a photo)', "Set the bot's WhatsApp profile picture", async (ctx) => {
    const img = await ctx.downloadMedia();
    try { await ctx.sock.updateProfilePicture(norm(ctx.sock.user.id), img); } catch (e) { throw picError(e); }
    return '✅ Profile picture updated.';
  }, { owner: true, aliases: ['setpp', 'setbotpp'] });

  add('gpp', 'Group', '(reply to a photo)', 'Set the group profile picture', async (ctx) => {
    const img = await ctx.downloadMedia();
    try { await ctx.sock.updateProfilePicture(ctx.jid, img); } catch (e) { throw picError(e); }
    return '✅ Group picture updated.';
  }, { group: true, admin: true, botAdmin: true, aliases: ['setgpp', 'setgrouppp'] });

  /* ----- save a status ----- */
  add('savestatus', 'Owner', '(reply to a status)', 'Reply to a status with this to get a copy in your chat', async (ctx) => {
    await ctx.forwardQuoted(ctx.ownerJid, '📥 *Status saved*');
    // silent on purpose: no confirmation message in the chat
  }, { owner: true, aliases: ['sendme', 'statusdl', 'sendstatus'] });

  /* ----- games ----- */
  add('games', 'Games', '', 'List the games you can play', (ctx) => {
    const p = ctx.prefix;
    return `🎮 *Games*\n› ${p}rps <rock|paper|scissors>\n› ${p}guess  (guess my number 1-50)\n› ${p}trivia  (then answer with ${p}answer a)\n› ${p}ttt @user  (tic-tac-toe, then ${p}ttt 5)\n› ${p}flip  ${p}dice  ${p}8ball  ${p}riddle  ${p}truth  ${p}dare`;
  }, { aliases: ['game'] });

  add('rps', 'Games', '<rock|paper|scissors>', 'Rock paper scissors against the bot', (ctx) => {
    const map = { rock: '🪨', paper: '📄', scissors: '✂️', r: 'rock', p: 'paper', s: 'scissors' };
    let me = (ctx.args[0] || '').toLowerCase();
    if (map[me] && map[me].length > 2) me = map[me];
    if (!['rock', 'paper', 'scissors'].includes(me)) throw new Error(`Usage: ${ctx.prefix}rps rock`);
    const bot = pick(['rock', 'paper', 'scissors']);
    const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const res = me === bot ? "It's a draw 🤝" : beats[me] === bot ? 'You win! 🎉' : 'I win! 😎';
    return `You: ${map[me]} ${me}\nMe: ${map[bot]} ${bot}\n\n${res}`;
  });

  add('guess', 'Games', '[number]', 'Guess the number between 1 and 50 (7 tries)', (ctx) => {
    const g = games(ctx.sock), key = 'guess:' + ctx.jid + ':' + ctx.sender;
    const n = parseInt(ctx.args[0], 10);
    let s = g.get(key);
    if (!n) {
      s = { secret: 1 + Math.floor(Math.random() * 50), left: 7 };
      g.set(key, s);
      return `🔢 I picked a number from 1 to 50. You have 7 tries.\nGuess with ${ctx.prefix}guess 25`;
    }
    if (!s) return `Start a game first with ${ctx.prefix}guess`;
    s.left--;
    if (n === s.secret) { g.delete(key); return `🎉 Correct! It was *${s.secret}*.`; }
    if (s.left <= 0) { g.delete(key); return `😢 Out of tries. The number was *${s.secret}*.`; }
    return `${n < s.secret ? '⬆️ Higher' : '⬇️ Lower'}! ${s.left} tries left.`;
  });

  add('trivia', 'Games', '', 'A random trivia question', async (ctx) => {
    const q = await trivia();
    games(ctx.sock).set('trivia:' + ctx.jid, q);
    return `🧠 *Trivia* (${q.category})\n${q.question}\n\n` + q.options.map((o, i) => `${'ABCD'[i]}. ${o}`).join('\n') + `\n\nAnswer with ${ctx.prefix}answer a`;
  });

  add('answer', 'Games', '<a|b|c|d>', 'Answer the trivia question', (ctx) => {
    const g = games(ctx.sock), key = 'trivia:' + ctx.jid;
    const q = g.get(key);
    if (!q) return `No question yet. Use ${ctx.prefix}trivia`;
    const a = (ctx.args[0] || '').toLowerCase();
    if (!'abcd'.includes(a) || a.length !== 1) throw new Error(`Usage: ${ctx.prefix}answer a`);
    g.delete(key);
    return a === q.answer ? `✅ Correct! *${q.correct}*` : `❌ Wrong. The answer was *${q.answer.toUpperCase()}. ${q.correct}*`;
  });

  add('ttt', 'Games', '@user | <1-9> | end', 'Tic-tac-toe with another person', (ctx) => {
    const g = games(ctx.sock), key = 'ttt:' + ctx.jid;
    const me = [ctx.sender, ctx.msg.key.participantAlt, ctx.msg.key.remoteJidAlt].filter(Boolean).map(num);
    const a = (ctx.args[0] || '').toLowerCase();
    let s = g.get(key);
    if (a === 'end') { g.delete(key); return '🛑 Game ended.'; }
    const cell = parseInt(a, 10);
    if (!(cell >= 1 && cell <= 9)) {
      const opp = ctx.mentioned[0] || ctx.quoted?.participant || (!ctx.isGroup ? ctx.jid : null);
      if (!opp) throw new Error(`Start with ${ctx.prefix}ttt @friend (or reply to their message)`);
      if (s) throw new Error(`A game is already running here. Use ${ctx.prefix}ttt end to stop it.`);
      s = { board: Array(9).fill(''), x: num(ctx.sender), o: num(opp), turn: 'x' };
      g.set(key, s);
      return `❌⭕ *Tic-tac-toe*\n❌ @${s.x}  vs  ⭕ @${s.o}\n\n${drawBoard(s.board)}\n\n❌ goes first: ${ctx.prefix}ttt <1-9>`;
    }
    if (!s) return `No game running. Start with ${ctx.prefix}ttt @friend`;
    if (!me.includes(s[s.turn])) return `⏳ It is not your turn. Waiting for @${s[s.turn]}.`;
    if (s.board[cell - 1]) throw new Error('That square is taken.');
    const mark = s.turn === 'x' ? '❌' : '⭕';
    s.board[cell - 1] = mark;
    const w = winner(s.board);
    if (w) { g.delete(key); return `${drawBoard(s.board)}\n\n🏆 ${w} wins!`; }
    if (s.board.every(Boolean)) { g.delete(key); return `${drawBoard(s.board)}\n\n🤝 It's a draw.`; }
    s.turn = s.turn === 'x' ? 'o' : 'x';
    return `${drawBoard(s.board)}\n\n${s.turn === 'x' ? '❌' : '⭕'} your turn: ${ctx.prefix}ttt <1-9>`;
  });
}

/* ---------------- boot: welcome / goodbye ---------------- */
function boot(sock) {
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      const { id, participants, action } = ev;
      if (action !== 'add' && action !== 'remove') return;
      const kind = action === 'add' ? 'welcome' : 'goodbye';
      const s = hmOf(sock).db.greet?.[id]?.[kind];
      if (!s?.on) return;
      let md = null;
      try { md = await groupMeta(sock, id); } catch { /* use fallbacks */ }
      const def = kind === 'welcome' ? '👋 Welcome @user to *{group}*! You are member #{count}.' : '👋 @user left *{group}*. Goodbye!';
      for (const p of participants || []) {
        const jid = typeof p === 'string' ? p : p.id;
        if (!jid) continue;
        const text = (s.msg || def)
          .replace(/@user/gi, '@' + num(jid))
          .replace(/\{group\}/gi, md?.subject || 'the group')
          .replace(/\{count\}/gi, String(md?.participants?.length || ''));
        await sock.sendMessage(id, { text, mentions: [jid] }).catch(() => {});
      }
    } catch (e) { console.error('[more] greet:', e.message); }
  });
}

module.exports = { register, boot };
