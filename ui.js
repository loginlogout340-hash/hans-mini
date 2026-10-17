'use strict';
/**
 * Hans-Mini interface: welcome banner, "Get Started" list, styled menu, default picture.
 * Design: rounded frames, one icon per category, commands in compact lines (WhatsApp shows the left edge only,
 * so frames are open on the right and never look crooked).
 *
 * Default picture: put a file called menu.jpg (or .png) next to index.js in the repo,
 * or set the Railway variable MENU_IMAGE to a direct image link.
 * Set MENU_BUTTONS=off to use plain text instead of the tap-to-select list.
 * Set WELCOME=off to stop the startup welcome message.
 */
const fs = require('fs');
const path = require('path');

let B = {}; // { generateWAMessageFromContent, proto } from Baileys
const init = (b) => { B = b || {}; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (j) => String(j || '').replace(/:\d+@/, '@');
const LINE = '╾──────────────────╼';
const BAR = '╰────────────────';
const VERSION = (() => { try { return require('./package.json').version; } catch { return ''; } })();
const CAT_ICON = {
  general: '🏠', utility: '🧰', text: '✍️', fun: '🎉', games: '🎮', ai: '🤖', media: '🎵', downloader: '📥',
  group: '👥', owner: '👑', info: 'ℹ️', community: '🌍', admin: '🛡️', tools: '🛠️', status: '📸',
};
const iconFor = (cat) => CAT_ICON[String(cat).toLowerCase()] || '✨';

let cachedImg; // picture is read once, then reused for every .menu
function imageSource() {
  if (process.env.MENU_IMAGE) return { url: process.env.MENU_IMAGE };
  if (cachedImg) return cachedImg;
  // menu.* wins; otherwise the first image file found next to index.js is used
  let files = [];
  try { files = fs.readdirSync(__dirname); } catch { /* ignore */ }
  const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  images.sort((a, b) => (/^menu\./i.test(b) ? 1 : 0) - (/^menu\./i.test(a) ? 1 : 0));
  for (const f of images) {
    try { cachedImg = fs.readFileSync(path.join(__dirname, f)); return cachedImg; } catch { /* try next */ }
  }
  console.error('[ui] no picture found next to ui.js (' + __dirname + '). Upload menu.jpg or set MENU_IMAGE.');
  return null;
}

async function sendWithImage(sock, jid, caption, opts) {
  const img = imageSource();
  if (img) {
    try { return await sock.sendMessage(jid, { image: img, caption }, opts); }
    catch (e) { console.error('[ui] image send failed, using text:', e.message); }
  }
  return sock.sendMessage(jid, { text: caption }, opts);
}

function greeting(tz) {
  let h = 12;
  try { h = Number(new Date().toLocaleString('en-GB', { timeZone: tz, hour: 'numeric', hour12: false })) % 24; } catch { /* default */ }
  if (h >= 5 && h < 12) return 'Good morning! Ready to roll?';
  if (h >= 12 && h < 17) return 'Good afternoon! What are we building?';
  if (h >= 17 && h < 22) return "Good evening! Let's get to it.";
  return "Late night? Let's see what's cooking!";
}

function banner(config, count, welcome) {
  const time = new Date().toLocaleTimeString('en-US', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
  const name = config.botName.toUpperCase();
  const owner = config.ownerName || (config.owners[0] ? '+' + config.owners[0] : 'not set');
  return [
    '╭━━━━━━━━━━━━━━━━━━━━━━╮',
    `┃    ✦ *${name}* ✦${VERSION ? '  _v' + VERSION + '_' : ''}`,
    '╰━━━━━━━━━━━━━━━━━━━━━━╯',
    `_${greeting(config.timezone)}_`,
    ...(welcome ? [`Welcome back to *${name}*. Connection established ✅`] : []),
    '',
    '╭─ ⚙️ *STATUS*',
    `│ ◦ Mode      *${config.mode}*`,
    `│ ◦ Prefix    *${config.prefix}*`,
    `│ ◦ Commands  *${count}*`,
    `│ ◦ Time      *${time}*`,
    `│ ◦ Owner     *${owner}*`,
    BAR,
  ].join('\n');
}

const quickRows = (p) => [
  { id: p + 'menu', title: '📜 Menu', description: 'View all commands' },
  { id: p + 'settings', title: '⚙️ Settings', description: 'Bot configuration' },
  { id: p + 'ping', title: '⚡ Ping', description: 'Check bot speed' },
  { id: p + 'uptime', title: '⏱️ Uptime', description: 'How long the bot has been running' },
];

async function getStarted(sock, jid, config) {
  const rows = quickRows(config.prefix);
  const plain = () => sock.sendMessage(jid, { text: `✨ *Your bot is ready!*\nPick an option to get started:\n\n╭─ 🚀 *QUICK START*\n` + rows.map((r) => `│ ◦ ${r.id}  _${r.description}_`).join('\n') + `\n${BAR}\n\n_Powered by ${config.botName.toUpperCase()}_` });
  if (/^(off|false|0)$/i.test(process.env.MENU_BUTTONS || '') || !B.proto || !B.generateWAMessageFromContent) return plain();
  try {
    const content = {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: B.proto.Message.InteractiveMessage.create({
            body: { text: '✨ *Your bot is ready!*\nTap *Get Started* below and pick what you want to do.' },
            footer: { text: 'Powered by ' + config.botName.toUpperCase() },
            nativeFlowMessage: {
              buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: '🚀 Get Started', sections: [{ title: 'Quick Actions', rows }] }) }],
            },
          }),
        },
      },
    };
    const m = B.generateWAMessageFromContent(jid, content, { userJid: sock.user.id });
    await sock.relayMessage(jid, m.message, { messageId: m.key.id });
  } catch (e) {
    console.error('[ui] list message failed, using text:', e.message);
    await plain();
  }
}

// turns a tapped list option into a normal typed command (e.g. ".menu") so the bot runs it
function fromListReply(msg) {
  const m = msg.message || {};
  const ir = m.interactiveResponseMessage || m.viewOnceMessage?.message?.interactiveResponseMessage;
  let id = null;
  try { id = JSON.parse(ir?.nativeFlowResponseMessage?.paramsJson || 'null')?.id; } catch { /* not JSON */ }
  id = id || m.listResponseMessage?.singleSelectReply?.selectedRowId || null;
  if (!id) return msg;
  return { ...msg, message: { extendedTextMessage: { text: String(id) } } };
}

function menuRun(commands) {
  return async (ctx) => {
    // the Admin section is shown only on the admin's own bot, to its real owner
    let isAdminBot = false;
    try { isAdminBot = !!(process.env.ADMIN_NUMBER && ctx.isMainOwner && require('./manager').isAdmin(ctx.config.owners[0])); } catch { /* not admin */ }
    const seen = new Set(); // a command name that exists twice is listed once (the first one is the one that runs)
    const visible = commands.filter((c) => {
      if (!isAdminBot && String(c.category).toLowerCase() === 'admin') return false;
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
    const cats = {};
    for (const c of visible) (cats[c.category] = cats[c.category] || []).push(c);
    // the most used sections first, the rest in the order they were added
    const ORDER = ['general', 'ai', 'media', 'downloader', 'utility', 'fun', 'games', 'text', 'group', 'owner', 'community', 'info', 'admin'];
    const rank = (k) => { const i = ORDER.indexOf(String(k).toLowerCase()); return i < 0 ? ORDER.length : i; };
    const sorted = Object.entries(cats).sort((x, y) => rank(x[0]) - rank(y[0]));
    const p = ctx.prefix;
    const head = banner(ctx.config, visible.length, false) + '\n';
    let list = '';
    for (const [cat, items] of sorted) {
      list += `\n╭─ ${iconFor(cat)} *${cat.toUpperCase()}*  _${items.length}_\n│ ${items.map((c) => p + c.name).join(' · ')}\n${BAR}\n`;
    }
    list += `\n💡 Type *${p}help <command>* for details.\n_${ctx.config.botName.toUpperCase()}${VERSION ? ' v' + VERSION : ''} · by ${ctx.config.ownerName || 'the owner'}_`;
    // ONE message: the picture with the banner AND the whole command list as its caption
    const img = imageSource();
    if (img) {
      try { return void (await ctx.sock.sendMessage(ctx.jid, { image: img, caption: head + '\n' + list.trim() }, { quoted: ctx.msg })); }
      catch (e) { console.error('[ui] one-message menu failed, sending in two parts:', e.message); }
    }
    await sendWithImage(ctx.sock, ctx.jid, head, { quoted: ctx.msg });
    await ctx.reply(list.trim());
  };
}

function register(add) {
  add('start', 'General', '', 'Show the Get Started quick-actions list', (ctx) => getStarted(ctx.sock, ctx.jid, ctx.config), { aliases: ['getstarted'] });
  add('settings', 'Owner', '', 'Show the current bot settings', (ctx) => {
    const c = ctx.config, p = ctx.prefix, on = (v) => (v ? '✅ ON' : '❌ OFF');
    const db = ctx.sock.hm?.db || {};
    return [
      '⚙️ *SETTINGS*',
      '',
      '╭─ 🔧 *GENERAL*',
      `│ ◦ Mode: *${c.mode}*  _(${p}mode public|private)_`,
      `│ ◦ Prefix: *${p}*  _(${p}setprefix)_`,
      `│ ◦ Multi prefix: ${on(c.multiPrefix)}  _(${p}multiprefix)_`,
      `│ ◦ Always online: _(${p}alwaysonline on|off)_`,
      BAR,
      '╭─ 📸 *STATUS*',
      `│ ◦ Auto view: ${on(c.autoStatus)}  _(${p}autostatus)_`,
      `│ ◦ Auto like: ${on(c.autoLikeStatus)} ${c.likeEmoji}  _(${p}autolikestatus)_`,
      BAR,
      '╭─ 🛡️ *PROTECTION*',
      `│ ◦ Anti view-once: ${on(c.antiViewOnce)}  _(${p}antiviewonce)_`,
      `│ ◦ Anti delete: ${on(c.antiDelete)}  _(${p}antidelete)_`,
      `│ ◦ Group guards: _${p}antitag, ${p}antigroupmention, ${p}antisticker, ${p}antilink_`,
      `│ ◦ Group messages: _${p}welcome, ${p}goodbye_`,
      BAR,
      '╭─ 👤 *PEOPLE & TIMERS*',
      `│ ◦ Scheduled messages: *${(db.schedules || []).length}*  _(${p}schedule)_`,
      `│ ◦ Sudo users: *${(db.sudo || []).length}*  _(${p}setsudo, ${p}delsudo)_`,
      BAR,
    ].join('\n');
  }, { owner: true, aliases: ['config'] });
}

function install(registry, commands) {
  const m = registry.get('menu');
  if (m) m.run = menuRun(commands);
}

// the welcome banner is sent once per user (the flag is saved in that user's settings)
async function welcome(sock, config, count) {
  if (config.welcomed || /^(off|false|0)$/i.test(process.env.WELCOME || '')) return;
  config.welcomed = true;
  if (config.save) config.save();
  const jid = config.owners[0] ? config.owners[0] + '@s.whatsapp.net' : norm(sock.user.id);
  await sleep(2500);
  await sendWithImage(sock, jid, banner(config, count, true));
  await getStarted(sock, jid, config);
}

module.exports = { init, install, register, welcome, fromListReply, menuRun };
