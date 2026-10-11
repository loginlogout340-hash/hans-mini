'use strict';
/**
 * Hans-Mini commands. Every command is registered with add():
 *   add(name, category, usage, description, run, options)
 * options: { aliases: [], group: bool, admin: bool, botAdmin: bool, owner: bool }
 * run(ctx) may return a string (it is sent as the reply) or reply itself.
 */
const os = require('os');
const crypto = require('crypto');

const commands = [];
const add = (name, category, usage, desc, run, opts = {}) =>
  commands.push({ name, category, usage, desc, run, aliases: opts.aliases || [], group: !!opts.group, admin: !!opts.admin, botAdmin: !!opts.botAdmin, owner: !!opts.owner });

// ---------- helpers ----------
const http = {
  async json(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Hans-Mini-Bot/1.0' } });
    if (!r.ok) throw new Error('Service returned HTTP ' + r.status);
    return r.json();
  },
  async text(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Hans-Mini-Bot/1.0' } });
    if (!r.ok) throw new Error('Service returned HTTP ' + r.status);
    return r.text();
  },
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const need = (ctx, msg) => { if (!ctx.text) throw new Error(msg); };
const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m ${s % 60}s`;
};
const num = (jid) => String(jid || '').split('@')[0].split(':')[0];
const targetsOf = (ctx) => {
  if (ctx.mentioned.length) return ctx.mentioned;
  if (ctx.quoted && ctx.quoted.participant) return [ctx.quoted.participant];
  return ctx.args.map((a) => a.replace(/\D/g, '')).filter((d) => d.length >= 7).map((d) => d + '@s.whatsapp.net');
};
const MORSE = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
const CRYPTO_IDS = { btc: 'bitcoin', eth: 'ethereum', bnb: 'binancecoin', sol: 'solana', xrp: 'ripple', ada: 'cardano', doge: 'dogecoin', usdt: 'tether', ltc: 'litecoin', trx: 'tron', dot: 'polkadot', matic: 'matic-network', ton: 'the-open-network' };

// ---------- GENERAL ----------
add('menu', 'General', '', 'Show all commands', (ctx) => {
  const cats = {};
  for (const c of commands) (cats[c.category] = cats[c.category] || []).push(c);
  let out = `╭─「 *${ctx.config.botName}* 」\n│ Prefix: ${ctx.prefix}   Mode: ${ctx.config.mode}\n│ Commands: ${commands.length}\n╰──────────\n`;
  for (const [cat, list] of Object.entries(cats)) {
    out += `\n*${cat.toUpperCase()}*\n` + list.map((c) => `› ${ctx.prefix}${c.name}`).join('\n') + '\n';
  }
  out += `\nType ${ctx.prefix}help <command> for details.`;
  return out;
}, { aliases: ['commands', 'list'] });

add('help', 'General', '<command>', 'Explain how to use a command', (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}help <command>`);
  const name = ctx.args[0].toLowerCase().replace(ctx.prefix, '');
  const c = commands.find((x) => x.name === name || x.aliases.includes(name));
  if (!c) return `No command called "${name}". Try ${ctx.prefix}menu`;
  const flags = [c.group && 'groups only', c.admin && 'admins only', c.botAdmin && 'bot must be admin', c.owner && 'owner only'].filter(Boolean).join(', ');
  return `*${ctx.prefix}${c.name}* ${c.usage}\n${c.desc}` + (c.aliases.length ? `\nAliases: ${c.aliases.map((a) => ctx.prefix + a).join(', ')}` : '') + (flags ? `\nNote: ${flags}` : '');
});

add('ping', 'General', '', 'Check if the bot is responding', (ctx) => {
  const ts = Number(ctx.msg?.messageTimestamp || 0) * 1000;
  return `🏓 Pong! ${ts ? Math.max(0, Date.now() - ts) : '?'} ms`;
}, { aliases: ['p'] });

add('alive', 'General', '', 'Confirm the bot is online', (ctx) => `✅ ${ctx.config.botName} is online.\nUptime: ${fmtDuration(Date.now() - ctx.config.startedAt)}`);
add('uptime', 'General', '', 'How long the bot has been running', (ctx) => `⏱️ Uptime: ${fmtDuration(Date.now() - ctx.config.startedAt)}`, { aliases: ['runtime'] });
add('owner', 'General', '', "Show the owner's contact", (ctx) => ctx.config.owners.length ? 'Owner: ' + ctx.config.owners.map((o) => 'wa.me/' + o).join('\n') : 'No owner number has been set.');
add('about', 'General', '', 'About this bot', (ctx) => `*${ctx.config.botName}*\nA small WhatsApp bot with ${commands.length} commands, built on Baileys.\nType ${ctx.prefix}menu to see them.`, { aliases: ['info'] });
add('sysinfo', 'General', '', 'Server memory and CPU info', () => {
  const used = (process.memoryUsage().rss / 1048576).toFixed(0);
  return `🖥️ *System*\nNode: ${process.version}\nPlatform: ${os.platform()} ${os.arch()}\nCPU cores: ${os.cpus().length}\nBot memory: ${used} MB\nServer RAM: ${((os.totalmem() - os.freemem()) / 1073741824).toFixed(1)} / ${(os.totalmem() / 1073741824).toFixed(1)} GB`;
}, { aliases: ['stats'] });

// ---------- UTILITY ----------
add('calc', 'Utility', '<expression>', 'Calculator: + - * / % ^ ( ) sqrt sin cos tan log abs pi', (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}calc 2*(3+4)^2`);
  const fns = 'sqrt|sin|cos|tan|log10|log|abs|floor|ceil|round|pi|e';
  const expr = ctx.text.toLowerCase().replace(/\^/g, '**').replace(/×/g, '*').replace(/÷/g, '/');
  if (!/^[\d+\-*/%().,\s]*$/.test(expr.replace(new RegExp(`\\b(${fns})\\b`, 'g'), ''))) throw new Error('Only numbers and math functions are allowed.');
  const js = expr.replace(new RegExp(`\\b(${fns})\\b`, 'g'), (m) => (m === 'pi' ? 'Math.PI' : m === 'e' ? 'Math.E' : 'Math.' + m));
  const result = Function('"use strict"; return (' + js + ')')();
  if (typeof result !== 'number' || !isFinite(result)) throw new Error('That does not give a valid number.');
  return `🧮 ${ctx.text} = *${+result.toFixed(10)}*`;
}, { aliases: ['math'] });

add('time', 'Utility', '[timezone]', 'Current time, e.g. time Asia/Tokyo (default: bot timezone)', (ctx) => {
  const tz = ctx.text || ctx.config.timezone;
  try {
    return `🕒 ${tz}\n` + new Date().toLocaleString('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'medium' });
  } catch { throw new Error('Unknown timezone. Use a name like Africa/Accra or Europe/London.'); }
});
add('date', 'Utility', '', "Today's date", (ctx) => '📅 ' + new Date().toLocaleDateString('en-GB', { timeZone: ctx.config.timezone, dateStyle: 'full' }));

add('weather', 'Utility', '<city>', 'Current weather for a city', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}weather Takoradi`);
  const t = await http.text(`https://wttr.in/${encodeURIComponent(ctx.text)}?format=${encodeURIComponent('%l: %c %C, %t (feels %f)\nHumidity: %h | Wind: %w | Rain: %p')}`);
  return '🌤️ ' + t.trim();
});

add('convert', 'Utility', '<amount> <from> <to>', 'Currency conversion, e.g. convert 100 usd ghs', async (ctx) => {
  const [amt, from, to] = ctx.args;
  const n = parseFloat(amt);
  if (!n || !from || !to) throw new Error(`Usage: ${ctx.prefix}convert 100 usd ghs`);
  const d = await http.json(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`);
  const rate = d.rates && d.rates[to.toUpperCase()];
  if (!rate) throw new Error('Unknown currency code.');
  return `💱 ${n} ${from.toUpperCase()} = *${(n * rate).toFixed(2)} ${to.toUpperCase()}*\n(rate ${rate.toFixed(4)})`;
}, { aliases: ['currency'] });

add('crypto', 'Utility', '<coin> [currency]', 'Crypto price, e.g. crypto btc usd', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}crypto btc usd`);
  const id = CRYPTO_IDS[ctx.args[0].toLowerCase()] || ctx.args[0].toLowerCase();
  const cur = (ctx.args[1] || 'usd').toLowerCase();
  const d = await http.json(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${cur}&include_24hr_change=true`);
  if (!d[id]) throw new Error('Coin or currency not found.');
  const ch = d[id][cur + '_24h_change'];
  return `🪙 *${id}*: ${d[id][cur].toLocaleString()} ${cur.toUpperCase()}` + (ch !== undefined ? `\n24h: ${ch >= 0 ? '📈 +' : '📉 '}${ch.toFixed(2)}%` : '');
}, { aliases: ['coin'] });

add('define', 'Utility', '<word>', 'English dictionary definition', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}define serendipity`);
  const d = await http.json('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(ctx.args[0]));
  const e = d[0];
  const m = e.meanings.slice(0, 2).map((x) => `_${x.partOfSpeech}_: ${x.definitions[0].definition}`).join('\n');
  return `📖 *${e.word}*${e.phonetic ? ' ' + e.phonetic : ''}\n${m}`;
}, { aliases: ['dict', 'meaning'] });

add('translate', 'Utility', '<lang-code> <text>', 'Translate text, e.g. translate fr good morning', async (ctx) => {
  const [lang, ...rest] = ctx.args;
  const text = rest.join(' ') || ctx.quoted?.text;
  if (!lang || !text) throw new Error(`Usage: ${ctx.prefix}translate fr good morning (or reply to a message)`);
  const d = await http.json(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${encodeURIComponent(lang)}`);
  return `🌍 *${lang}*: ${d.responseData.translatedText}`;
}, { aliases: ['tr'] });

add('wiki', 'Utility', '<topic>', 'Short Wikipedia summary', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}wiki Takoradi`);
  const d = await http.json('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(ctx.text.replace(/\s+/g, '_')));
  if (!d.extract) throw new Error('No article found.');
  return `📚 *${d.title}*\n${d.extract.slice(0, 900)}\n${d.content_urls?.mobile?.page || ''}`;
}, { aliases: ['wikipedia'] });

add('country', 'Utility', '<name>', 'Facts about a country', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}country ghana`);
  const d = (await http.json(`https://restcountries.com/v3.1/name/${encodeURIComponent(ctx.text)}?fields=name,capital,population,region,currencies,languages,area,flag`))[0];
  return `${d.flag} *${d.name.common}*\nCapital: ${(d.capital || []).join(', ')}\nRegion: ${d.region}\nPopulation: ${d.population.toLocaleString()}\nArea: ${d.area.toLocaleString()} km²\nCurrency: ${Object.values(d.currencies || {}).map((c) => c.name + ' ' + (c.symbol || '')).join(', ')}\nLanguages: ${Object.values(d.languages || {}).join(', ')}`;
});

add('github', 'Utility', '<username>', 'Look up a GitHub profile', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}github torvalds`);
  const d = await http.json('https://api.github.com/users/' + encodeURIComponent(ctx.args[0]));
  return `🐙 *${d.login}*${d.name ? ' (' + d.name + ')' : ''}\n${d.bio || ''}\nRepos: ${d.public_repos} | Followers: ${d.followers}\n${d.html_url}`;
}, { aliases: ['gh'] });

add('bible', 'Utility', '<reference>', 'Bible verse, e.g. bible john 3:16', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}bible john 3:16`);
  const d = await http.json('https://bible-api.com/' + encodeURIComponent(ctx.text));
  if (!d.text) throw new Error('Verse not found.');
  return `📖 *${d.reference}*\n${d.text.trim()}`;
}, { aliases: ['verse'] });

add('shorten', 'Utility', '<url>', 'Shorten a link', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}shorten https://example.com/very/long`);
  const t = await http.text('https://is.gd/create.php?format=simple&url=' + encodeURIComponent(ctx.args[0]));
  if (!t.startsWith('http')) throw new Error(t.trim());
  return '🔗 ' + t.trim();
}, { aliases: ['short'] });

add('qr', 'Utility', '<text or link>', 'Make a QR code image', async (ctx) => {
  need(ctx, `Usage: ${ctx.prefix}qr https://example.com`);
  await ctx.sendImage('https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=' + encodeURIComponent(ctx.text), 'QR code');
});

add('password', 'Utility', '[length]', 'Generate a strong random password (8-64)', (ctx) => {
  const n = Math.min(64, Math.max(8, parseInt(ctx.args[0]) || 16));
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  let p = '';
  for (let i = 0; i < n; i++) p += chars[crypto.randomInt(chars.length)];
  return '🔐 `' + p + '`';
}, { aliases: ['pass'] });

add('uuid', 'Utility', '', 'Generate a random UUID', () => '🆔 ' + crypto.randomUUID());
add('random', 'Utility', '[min] [max]', 'Random number (default 1-100)', (ctx) => {
  let a = parseInt(ctx.args[0]), b = parseInt(ctx.args[1]);
  if (isNaN(a)) { a = 1; b = 100; } else if (isNaN(b)) { b = a; a = 1; }
  if (a > b) [a, b] = [b, a];
  return `🎲 ${crypto.randomInt(a, b + 1)}`;
}, { aliases: ['rand'] });

// ---------- TEXT TOOLS ----------
const textOf = (ctx) => ctx.text || ctx.quoted?.text || '';
const textCmd = (name, usage, desc, fn, aliases = []) =>
  add(name, 'Text', usage, desc, (ctx) => { const t = textOf(ctx); if (!t) throw new Error(`Usage: ${ctx.prefix}${name} ${usage} (or reply to a message)`); return fn(t, ctx); }, { aliases });

textCmd('upper', '<text>', 'UPPERCASE text', (t) => t.toUpperCase(), ['uppercase']);
textCmd('lower', '<text>', 'lowercase text', (t) => t.toLowerCase(), ['lowercase']);
textCmd('title', '<text>', 'Title Case text', (t) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
textCmd('reverse', '<text>', 'Reverse text', (t) => [...t].reverse().join(''), ['rev']);
textCmd('mock', '<text>', 'sPoNgEbOb mOcKiNg tExT', (t) => [...t.toLowerCase()].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(''));
textCmd('clap', '<text>', 'Put 👏 between words', (t) => t.trim().split(/\s+/).join(' 👏 ') + ' 👏');
textCmd('wordcount', '<text>', 'Count words and characters', (t) => `📝 Words: ${t.trim().split(/\s+/).length}\nCharacters: ${t.length}\nWithout spaces: ${t.replace(/\s/g, '').length}`, ['count', 'wc']);
textCmd('b64e', '<text>', 'Base64 encode', (t) => Buffer.from(t).toString('base64'), ['base64']);
textCmd('b64d', '<base64>', 'Base64 decode', (t) => { const out = Buffer.from(t.trim(), 'base64').toString('utf8'); if (!out) throw new Error('Not valid Base64.'); return out; });
textCmd('binary', '<text>', 'Text to binary', (t) => [...Buffer.from(t)].map((b) => b.toString(2).padStart(8, '0')).join(' '));
textCmd('unbinary', '<binary>', 'Binary to text', (t) => {
  const bytes = t.trim().split(/\s+/);
  if (!bytes.every((b) => /^[01]{8}$/.test(b))) throw new Error('Give groups of 8 bits separated by spaces.');
  return Buffer.from(bytes.map((b) => parseInt(b, 2))).toString('utf8');
});
textCmd('morse', '<text>', 'Text to Morse code', (t) => t.toLowerCase().split('').map((c) => (c === ' ' ? '/' : MORSE[c] || '')).filter(Boolean).join(' '));
textCmd('unmorse', '<morse>', 'Morse code to text (use / between words)', (t) => t.trim().split(' ').map((c) => (c === '/' ? ' ' : MORSE_REV[c] || '?')).join(''));
textCmd('rot13', '<text>', 'ROT13 cipher', (t) => t.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26)));
textCmd('palindrome', '<text>', 'Is it a palindrome?', (t) => { const s = t.toLowerCase().replace(/[^a-z0-9]/g, ''); return s && s === [...s].reverse().join('') ? '✅ Yes, it is a palindrome.' : '❌ No, it is not a palindrome.'; });
add('repeat', 'Text', '<times> <text>', 'Repeat text up to 20 times', (ctx) => {
  const n = Math.min(20, parseInt(ctx.args[0]));
  const t = ctx.args.slice(1).join(' ');
  if (!n || !t) throw new Error(`Usage: ${ctx.prefix}repeat 5 hello`);
  return Array(n).fill(t).join('\n');
});
add('hash', 'Text', '<md5|sha1|sha256|sha512> <text>', 'Hash some text', (ctx) => {
  const algo = (ctx.args[0] || '').toLowerCase();
  const t = ctx.args.slice(1).join(' ');
  if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo) || !t) throw new Error(`Usage: ${ctx.prefix}hash sha256 hello`);
  return '#️⃣ ' + crypto.createHash(algo).update(t).digest('hex');
});

// ---------- FUN ----------
const BALL = ['It is certain.', 'Without a doubt.', 'Yes, definitely.', 'You may rely on it.', 'Most likely.', 'Outlook good.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.', 'Cannot predict now.', "Don't count on it.", 'My sources say no.', 'Outlook not so good.', 'Very doubtful.'];
const TRUTH = ['What is your biggest fear?', 'What is the most embarrassing thing you have done?', 'Who was your first crush?', 'What is a secret you have never told anyone?', 'What is the last lie you told?', 'What is your most childish habit?', 'Which app do you waste the most time on?', 'What is the worst gift you have ever received?'];
const DARE = ['Send a voice note singing the chorus of any song.', 'Change your WhatsApp status to "I love homework" for an hour.', 'Text the 5th person in your chat list "I miss you".', 'Do 15 push-ups and send proof.', 'Speak in rhymes for the next 10 minutes.', 'Send your most recent photo in the gallery.', 'Talk without using the letter "a" for 2 minutes.'];
const PICKUP = ['Are you Wi-Fi? Because I am feeling a connection.', 'Do you have a map? I keep getting lost in your eyes.', 'Is your name Google? Because you have everything I am searching for.', 'Are you a magician? Whenever I look at you, everyone else disappears.', 'If you were a vegetable, you would be a cute-cumber.'];
const WYR = ['Would you rather be able to fly or be invisible?', 'Would you rather never use social media again or never watch TV again?', 'Would you rather always be 10 minutes late or 20 minutes early?', 'Would you rather have unlimited data or unlimited airtime?', 'Would you rather speak every language or play every instrument?', 'Would you rather lose your phone or lose your wallet?'];
const RIDDLES = [['What has keys but cannot open locks?', 'A keyboard'], ['What gets wetter the more it dries?', 'A towel'], ['What has hands but cannot clap?', 'A clock'], ['What can you catch but not throw?', 'A cold'], ['The more you take, the more you leave behind. What am I?', 'Footsteps'], ['What has a head and a tail but no body?', 'A coin']];

add('8ball', 'Fun', '<question>', 'Ask the magic 8-ball', (ctx) => { need(ctx, `Usage: ${ctx.prefix}8ball will I pass?`); return `🎱 ${pick(BALL)}`; }, { aliases: ['ball'] });
add('flip', 'Fun', '', 'Flip a coin', () => (Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails'), { aliases: ['coin-flip', 'coinflip'] });
add('dice', 'Fun', '[sides]', 'Roll a dice (default 6 sides)', (ctx) => `🎲 You rolled a *${crypto.randomInt(1, Math.max(2, Math.min(1000, parseInt(ctx.args[0]) || 6)) + 1)}*`, { aliases: ['roll'] });
add('choose', 'Fun', '<a | b | c>', 'Pick one option, separated by |', (ctx) => {
  const opts = ctx.text.split('|').map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) throw new Error(`Usage: ${ctx.prefix}choose pizza | rice | banku`);
  return `🤔 I choose: *${pick(opts)}*`;
}, { aliases: ['pick'] });
add('truth', 'Fun', '', 'A random truth question', () => '🗣️ ' + pick(TRUTH));
add('dare', 'Fun', '', 'A random dare', () => '😈 ' + pick(DARE));
add('pickup', 'Fun', '', 'A cheesy pickup line', () => '💘 ' + pick(PICKUP), { aliases: ['flirt'] });
add('wyr', 'Fun', '', 'Would you rather...', () => '🤷 ' + pick(WYR));
add('riddle', 'Fun', '', 'A riddle (answer is further down, so try not to peek)', () => { const [q, a] = pick(RIDDLES); return `🧩 ${q}\n\n\n\n\n\n\n\n\n\nAnswer: ${a}`; });
add('love', 'Fun', '<name> & <name>', 'Love compatibility (just for fun)', (ctx) => {
  const [a, b] = ctx.text.split(/&|\band\b/i).map((s) => s.trim());
  if (!a || !b) throw new Error(`Usage: ${ctx.prefix}love Ama & Kofi`);
  const pct = parseInt(crypto.createHash('md5').update([a, b].map((s) => s.toLowerCase()).sort().join('+')).digest('hex').slice(0, 6), 16) % 101;
  return `💞 ${a} + ${b} = *${pct}%*`;
}, { aliases: ['ship'] });
add('rate', 'Fun', '<anything>', 'Rate something out of 10', (ctx) => { need(ctx, `Usage: ${ctx.prefix}rate my cooking`); return `⭐ I rate "${ctx.text}" *${crypto.randomInt(0, 11)}/10*`; });
add('joke', 'Fun', '', 'A random joke', async () => { const d = await http.json('https://official-joke-api.appspot.com/random_joke'); return `😂 ${d.setup}\n\n${d.punchline}`; });
add('fact', 'Fun', '', 'A random fact', async () => '🧠 ' + (await http.json('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en')).text);
add('advice', 'Fun', '', 'A piece of random advice', async () => '💡 ' + (await http.json('https://api.adviceslip.com/advice')).slip.advice);
add('quote', 'Fun', '', 'An inspirational quote', async () => { const d = (await http.json('https://zenquotes.io/api/random'))[0]; return `💬 "${d.q}"\n— ${d.a}`; }, { aliases: ['inspire'] });

// ---------- GROUP ----------
add('groupinfo', 'Group', '', 'Show group details', async (ctx) => {
  const g = await ctx.getGroup();
  const admins = g.participants.filter((p) => p.admin).length;
  return `👥 *${g.subject}*\nMembers: ${g.participants.length}\nAdmins: ${admins}\nCreated: ${g.creation ? new Date(g.creation * 1000).toLocaleDateString('en-GB') : 'unknown'}\n\n${g.desc || '(no description)'}`;
}, { group: true, aliases: ['ginfo'] });

add('admins', 'Group', '', 'List and tag the group admins', async (ctx) => {
  const g = await ctx.getGroup();
  const a = g.participants.filter((p) => p.admin);
  await ctx.send({ text: '👮 *Admins*\n' + a.map((p, i) => `${i + 1}. @${num(p.id)}`).join('\n'), mentions: a.map((p) => p.id) });
}, { group: true });

add('tagall', 'Group', '[message]', 'Mention everyone in the group', async (ctx) => {
  const g = await ctx.getGroup();
  await ctx.send({ text: `📢 ${ctx.text || 'Attention everyone!'}\n\n` + g.participants.map((p) => '@' + num(p.id)).join(' '), mentions: g.participants.map((p) => p.id) });
}, { group: true, admin: true, aliases: ['everyone'] });

add('hidetag', 'Group', '<message>', 'Notify everyone without showing the mentions', async (ctx) => {
  const g = await ctx.getGroup();
  await ctx.send({ text: ctx.text || ctx.quoted?.text || '📢', mentions: g.participants.map((p) => p.id) });
}, { group: true, admin: true, aliases: ['ht'] });

const groupAction = (name, action, verb, desc, opts = {}) =>
  add(name, 'Group', '@user (or reply)', desc, async (ctx) => {
    const t = targetsOf(ctx);
    if (!t.length) throw new Error(`Mention someone, reply to their message, or give a number.\nExample: ${ctx.prefix}${name} 2335XXXXXXXX`);
    const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, t, action);
    const failed = (res || []).filter((r) => String(r.status) !== '200');
    return failed.length ? `⚠️ ${verb} failed for ${failed.length} of ${t.length} (status ${failed[0].status}).` : `✅ ${verb}: ${t.length} user(s).`;
  }, { group: true, admin: true, botAdmin: true, ...opts });
groupAction('kick', 'remove', 'Removed', 'Remove a member', { aliases: ['remove'] });
groupAction('add', 'add', 'Added', 'Add a member by phone number (with country code)');
groupAction('promote', 'promote', 'Promoted', 'Make a member admin');
groupAction('demote', 'demote', 'Demoted', 'Remove admin rights');

add('mute', 'Group', '', 'Only admins can send messages', async (ctx) => { await ctx.sock.groupSettingUpdate(ctx.jid, 'announcement'); return '🔇 Group muted: only admins can send messages.'; }, { group: true, admin: true, botAdmin: true, aliases: ['close'] });
add('unmute', 'Group', '', 'Let everyone send messages', async (ctx) => { await ctx.sock.groupSettingUpdate(ctx.jid, 'not_announcement'); return '🔊 Group unmuted: everyone can send messages.'; }, { group: true, admin: true, botAdmin: true, aliases: ['open'] });
add('link', 'Group', '', 'Get the group invite link', async (ctx) => '🔗 https://chat.whatsapp.com/' + (await ctx.sock.groupInviteCode(ctx.jid)), { group: true, admin: true, botAdmin: true, aliases: ['invite'] });
add('revoke', 'Group', '', 'Reset the group invite link', async (ctx) => { await ctx.sock.groupRevokeInvite(ctx.jid); return '♻️ Invite link reset. Use link to get the new one.'; }, { group: true, admin: true, botAdmin: true });
add('setname', 'Group', '<new name>', 'Change the group name', async (ctx) => { need(ctx, `Usage: ${ctx.prefix}setname New Name`); await ctx.sock.groupUpdateSubject(ctx.jid, ctx.text); return '✅ Group name updated.'; }, { group: true, admin: true, botAdmin: true });
add('setdesc', 'Group', '<description>', 'Change the group description', async (ctx) => { need(ctx, `Usage: ${ctx.prefix}setdesc text`); await ctx.sock.groupUpdateDescription(ctx.jid, ctx.text); return '✅ Group description updated.'; }, { group: true, admin: true, botAdmin: true });
add('leave', 'Group', '', 'Make the bot leave this group', async (ctx) => { await ctx.reply('👋 Goodbye!'); await ctx.sock.groupLeave(ctx.jid); }, { group: true, owner: true });

add('delete', 'Group', '(reply to a message)', "Delete a replied message (bot's own, or anyone's if the bot is admin)", async (ctx) => {
  if (!ctx.quoted) throw new Error('Reply to the message you want deleted.');
  const mine = ctx.quoted.fromBot;
  if (!mine && !(ctx.isGroup && ctx.isBotAdmin)) throw new Error('I can only delete my own messages (or any message if I am a group admin).');
  await ctx.sock.sendMessage(ctx.jid, { delete: { remoteJid: ctx.jid, fromMe: mine, id: ctx.quoted.id, participant: ctx.quoted.participant } });
}, { aliases: ['del'] });

add('getpp', 'Group', '[@user]', "Get someone's profile picture", async (ctx) => {
  const t = targetsOf(ctx)[0] || ctx.sender;
  let url;
  try { url = await ctx.sock.profilePictureUrl(t, 'image'); } catch { throw new Error('No profile picture found (or it is private).'); }
  await ctx.sendImage(url, 'Profile picture');
}, { aliases: ['pp'] });

// ---------- OWNER ----------
add('mode', 'Owner', '<public|private>', 'Switch who can use the bot', (ctx) => {
  const m = (ctx.args[0] || '').toLowerCase();
  if (!['public', 'private'].includes(m)) return `Current mode: ${ctx.config.mode}\nUsage: ${ctx.prefix}mode public|private`;
  ctx.config.mode = m;
  if (ctx.config.save) ctx.config.save();
  return `✅ Mode set to *${m}* (saved).`;
}, { owner: true });
const toggle = (name, key, label, desc) =>
  add(name, 'Owner', 'on|off', desc, (ctx) => {
    const v = (ctx.args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) return `${label} is currently *${ctx.config[key] ? 'ON' : 'OFF'}*.\nUsage: ${ctx.prefix}${name} on|off`;
    ctx.config[key] = v === 'on';
    ctx.config.save();
    return `✅ ${label} turned *${v.toUpperCase()}*.`;
  }, { owner: true });
toggle('autostatus', 'autoStatus', 'Auto view status', 'Automatically view (mark as seen) your contacts\' statuses');
add('autolikestatus', 'Owner', 'on|off|emoji <emoji>', 'Automatically react to your contacts\' statuses', (ctx) => {
  const v = (ctx.args[0] || '').toLowerCase();
  if (v === 'emoji') {
    if (!ctx.args[1]) throw new Error(`Usage: ${ctx.prefix}autolikestatus emoji 🔥`);
    ctx.config.likeEmoji = ctx.args[1]; ctx.config.save();
    return `✅ Status reaction emoji set to ${ctx.args[1]}`;
  }
  if (!['on', 'off'].includes(v)) return `Auto like status is currently *${ctx.config.autoLikeStatus ? 'ON' : 'OFF'}* (emoji ${ctx.config.likeEmoji}).\nUsage: ${ctx.prefix}autolikestatus on|off\n${ctx.prefix}autolikestatus emoji 🔥`;
  ctx.config.autoLikeStatus = v === 'on';
  if (v === 'on') ctx.config.autoStatus = true; // reacting needs the status to be viewed
  ctx.config.save();
  return `✅ Auto like status turned *${v.toUpperCase()}* (emoji ${ctx.config.likeEmoji})` + (v === 'on' ? '\nAuto view status was switched on too.' : '');
}, { owner: true, aliases: ['autolike'] });
toggle('antiviewonce', 'antiViewOnce', 'Anti view-once', 'Save a copy of every view-once photo/video/voice note sent to you (sent to your owner chat)');
toggle('antidelete', 'antiDelete', 'Anti delete', 'Send you a copy of messages other people delete (sent to your owner chat)');
add('retrieve', 'Owner', '[here]', 'Reply to a view-once or media message to get a copy (sent to your owner chat; add "here" to send it in this chat)', async (ctx) => {
  const here = (ctx.args[0] || '').toLowerCase() === 'here';
  await ctx.forwardQuoted(here ? ctx.jid : ctx.ownerJid, '📥 *Retrieved*');
  if (!here && ctx.jid !== ctx.ownerJid) return '✅ Sent to your owner chat.';
}, { owner: true, aliases: ['vv', 'readvo'] });
add('restart', 'Owner', '', 'Restart the bot', async (ctx) => { await ctx.reply('♻️ Restarting...'); setTimeout(() => process.exit(0), 1000); }, { owner: true, aliases: ['reboot'] });

module.exports = { commands, targetsOf };
