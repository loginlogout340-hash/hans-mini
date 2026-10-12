'use strict';
/**
 * Hans-Mini interface: welcome banner, "Get Started" list, styled menu, default picture.
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
const LINE = '◁──────────────────▷';

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
  return `${LINE}
| ツ ${greeting(config.timezone)}
| ツ ${welcome ? 'Welcome back to' : 'This is'} *${name}*!${welcome ? ' Connection established.' : ''}

✨ *Bot Name:* ${name}
🔧 *Mode:* ${config.mode}
➡️ *Prefix:* ${config.prefix}
📚 *Commands:* ${count}
🕒 *Time:* ${time}
📖 *Library:* Baileys

| ツ *Owner:* ${config.ownerName || (config.owners[0] ? '+' + config.owners[0] : 'not set')}
${LINE}`;
}

const quickRows = (p) => [
  { id: p + 'menu', title: 'Menu', description: 'View all commands' },
  { id: p + 'settings', title: 'Settings', description: 'Bot configuration' },
  { id: p + 'ping', title: 'Ping', description: 'Check bot speed' },
  { id: p + 'uptime', title: 'Uptime', description: 'How long bot has been running' },
];

async function getStarted(sock, jid, config) {
  const rows = quickRows(config.prefix);
  const plain = () => sock.sendMessage(jid, { text: `*Bot is ready!*\nPick an option to get started:\n\n` + rows.map((r) => `› ${r.id}  (${r.description})`).join('\n') + `\n\nPowered by ${config.botName.toUpperCase()}` });
  if (/^(off|false|0)$/i.test(process.env.MENU_BUTTONS || '') || !B.proto || !B.generateWAMessageFromContent) return plain();
  try {
    const content = {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: B.proto.Message.InteractiveMessage.create({
            body: { text: '*Bot is ready!*\nPick an option below to get started.' },
            footer: { text: 'Powered by ' + config.botName.toUpperCase() },
            nativeFlowMessage: {
              buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: 'Get Started', sections: [{ title: 'Quick Actions', rows }] }) }],
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
    const cats = {};
    for (const c of commands) (cats[c.category] = cats[c.category] || []).push(c);
    const p = ctx.prefix;
    await sendWithImage(ctx.sock, ctx.jid, banner(ctx.config, commands.length, false), { quoted: ctx.msg });
    let list = '';
    for (const [cat, items] of Object.entries(cats)) {
      list += `\n┏━━ *${cat.toUpperCase()}* ━━\n` + items.map((c) => `┃ › ${p}${c.name}`).join('\n') + '\n┗━━━━━━━━━━\n';
    }
    list += `\nType ${p}help <command> for details.`;
    await ctx.reply(list.trim());
  };
}

function register(add) {
  add('start', 'General', '', 'Show the Get Started quick-actions list', (ctx) => getStarted(ctx.sock, ctx.jid, ctx.config), { aliases: ['getstarted'] });
  add('settings', 'Owner', '', 'Show the current bot settings', (ctx) => {
    const c = ctx.config, p = ctx.prefix, on = (v) => (v ? '✅ ON' : '❌ OFF');
    return `⚙️ *Settings*\n${LINE}\nMode: *${c.mode}*   (${p}mode public|private)\nPrefix: *${p}*\nAuto view status: ${on(c.autoStatus)}   (${p}autostatus)\nAuto like status: ${on(c.autoLikeStatus)} ${c.likeEmoji}   (${p}autolikestatus)\nAnti view-once: ${on(c.antiViewOnce)}   (${p}antiviewonce)\nAnti delete: ${on(c.antiDelete)}   (${p}antidelete)\nAlways online: (${p}alwaysonline on|off)\nGroup guards: (${p}antitag, ${p}antigroupmention)\n${LINE}`;
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
