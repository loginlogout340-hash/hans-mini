# Hans-Mini  (v2.1.0)
by 𝙷𝚊𝚗𝚜𝚘𝚗 ✪

A multi-user WhatsApp bot with **170+ commands**, built on Baileys. Visitors open the pairing website, type their number, get a code, link WhatsApp, and the bot is theirs. No setup, no coding, no Railway account needed on their side.

## What you get

- **Pairing website**: enter a number, get a pairing code, link it in WhatsApp > Linked devices.
- **One bot per user**: every linked number has its own settings, session and saved data.
- **Access control**: your own `ACCESS_CODE` (never expires), manual codes made on `/admin`, or paid codes through Paystack (mobile money and cards) that expire after the plan.
- **Hanson, the built-in AI assistant**: start a message with his name and say what you want. He runs the right command for you or answers questions. Turn him on and off with `.hanson on` / `.hanson off`.
- **Hans Pulse**: per-user stats and a private web dashboard (`.pulse`, `.pulse link`).
- **Community**: chat between users under nicknames. Everyone who links a number is added automatically as `Member1234` (change it with `.community nick`, leave with `.community leave`; leavers are not added back). Set `COMMUNITY_AUTOJOIN=off` to make it opt-in again.
- **Admin tools** (only on the admin bot): `.users`, `.removeuser`, `.banuser`, `.broadcast`, `.msguser` and more.

## Files

| File | What it does |
|---|---|
| `index.js` | Starts the website and restores every linked user |
| `server.js`, `page.js` | The pairing + payment website (`/`, `/admin`, `/pulse/<token>`, `/health`) |
| `codes.js` | Paid and manual access codes, price and plan length |
| `manager.js` | Keeps one bot per user, user limit, bans |
| `bot.js` | One user's WhatsApp connection and command handling |
| `limit.js` | Keeps heavy jobs (ffmpeg, yt-dlp) from running all at once |
| `commands.js`, `extra.js`, `ui.js`, `dl.js`, `media.js`, `status.js` | Core commands, menu design, downloaders, media tools, status handling |
| `more.js` ... `more6.js`, `hanson.js`, `admin.js` | More commands: owner tools, AI, guards, media, Hanson, admin |
| `pulse.js`, `pulsepage.js`, `community.js` | Hans Pulse dashboard and the community |
| `Dockerfile`, `package.json` | Build: Node 20, ffmpeg and yt-dlp |

## Settings (Railway variables)

**Main**

| Variable | Meaning |
|---|---|
| `ACCESS_CODE` | Your own code(s), comma separated. Never expire, work for any number |
| `ADMIN_NUMBER` | Your number with country code, digits only. Turns on the admin tools |
| `OWNER_NAME` | Your name, shown instead of a number |
| `MAX_USERS` | How many people can link a number (default 25). Your own admin bot does not count |
| `DATA_DIR` | Folder on the Volume where everything is saved (example `/data`). Add a Volume at that path, or users are logged out on every deploy |
| `PREFIX` | Command prefix (default `.`) |
| `BOT_NAME` | Name shown in the menu (default `Hans-Mini`) |
| `MODE` | `public` (everyone) or `private` (owner only) |
| `TIMEZONE` | Default `Africa/Accra` |
| `PUBLIC_URL` | Your website address (used for the `.pulse link` dashboard) |

**Payments and the website**

| Variable | Meaning |
|---|---|
| `PAYSTACK_SECRET` | Paystack secret key. Turns on the Pay button. Keep it only in Railway |
| `ADMIN_KEY` | Password for the `/admin` page (manual codes, price) |
| `PRICE_GHS`, `PLAN_DAYS` | First-time price and plan length (default 20 and 30). Change them later on `/admin` |
| `TUTORIAL_URL` | Link to your tutorial video (shows a Watch tutorial button) |

Paystack webhook address: `https://YOUR-DOMAIN/api/pay/webhook`

**Downloads and AI**

| Variable | Meaning |
|---|---|
| `MALVIN_API`, `MALVIN_KEY` | Download API address and key. Add more keys as `MALVIN_KEY_2`, `MALVIN_KEY_3` (or comma separated in `MALVIN_KEY`): when one reaches its daily limit the next one is used |
| `YT_COOKIES` | YouTube cookies (text of a cookies.txt from a spare account). Helps when YouTube blocks the server |
| `YT_PROXY` | Optional proxy for YouTube |
| `AI_URL`, `AI_KEY`, `AI_MODEL` | Your own OpenAI-compatible AI service for `.ai`, the chatbot and Hanson. Without them a free service is used |
| `AUDD_TOKEN` | Token for `.shazam` (free at dashboard.audd.io) |

**Look and extras**

| Variable | Meaning |
|---|---|
| `MENU_IMAGE` | Picture link for `.menu` (otherwise the first picture in the repo is used) |
| `MENU_BUTTONS`, `WELCOME` | Set to `off` to switch off the button menu or the welcome message |
| `LIKE_EMOJI` | Default status reaction (or `random`) |
| `COMMUNITY_MAX` | Community size limit (default 300) |
| `COMMUNITY_AUTOJOIN` | Set to `off` to stop adding new users to the community automatically |
| `OWNER_GITHUB` | Your GitHub link, shown by `.ownerinfo` |
| `HEAVY_JOBS`, `HEAVY_QUEUE` | How many ffmpeg / YouTube jobs run at the same time (default 3) and how many may wait (default 30). Protects the server's memory when many users download at once |
| `DEBUG_EXTRA` | Set to `1` to see more logs |

## Deploy on Railway

1. Put all the files in a GitHub repo.
2. Railway > New Project > Deploy from GitHub repo.
3. Add a **Volume** (example mount `/data`) and set `DATA_DIR=/data`.
4. Add the variables: at least `ACCESS_CODE`, `ADMIN_NUMBER`, `OWNER_NAME`, `DATA_DIR`. Add `MAX_USERS`, `ADMIN_KEY` and the Paystack and download variables when you need them.
5. Open the Railway domain, enter a number, link it with the code in WhatsApp > Settings > Linked devices > Link with phone number.
6. Send `.menu` from any chat.

Tip: every push to GitHub redeploys the bot and disconnects users for a moment. Turn off auto deploy while you upload many files, then deploy once.

## Commands

General: menu, help, ping, alive, uptime, owner, about, sysinfo, start
Utility: calc, date, weather, convert, crypto, define, translate, wiki, country, github, bible, qr, password, remind, reminders, tts, shorten, ss
Text: title, reverse, mock, clap, wordcount, binary, unbinary, morse, unmorse, rot13, hash
Fun: 8ball, flip, dice, choose, truth, dare, pickup, wyr, riddle, love, rate, joke, fact, advice, quote, react
Games: games, rps, guess, trivia, answer, ttt
AI: hanson, ai, imagine, translate, summarize, chatbot
Media: play, song, video, sendaudio, sendvideo, ytsearch, lyrics, shazam, sticker, toimg, blackvideo, profilepic
Downloader: fb, tiktok, ig, yt, gdrive, mediafire, mega, savefrom, twitter2, threads, pinterest, gitclone, pastebin, spotify, terabox, apk
Group: groupinfo, admins, tagall, hidetag, kick, add, promote, demote, mute, unmute, link, revoke, setname, setdesc, leave, delete, getpp, gpp, poll, welcome, goodbye, antilink, antibadword, addbadword, delbadword, badwords, antispam, antigroupmention, antitag, antisticker, warnlimit
Owner: mode, settings, restart, setprefix, multiprefix, autostatus, autolikestatus, antiviewonce, antidelete, retrieve, savestatus, stickcmd, reaction, anticall, afk, autoread, autotyping, autobio, alwaysonline, onetick, stealth, schedule, schedules, unschedule, setsudo, delsudo, getsudo, block, unblock, pp, unlink
Info: ownerinfo, pulse
Community: community, csay
Admin (admin bot only): users, removeuser, banuser, unbanuser, banned, watch, requests, approve, reject, broadcast, msguser, cmute, cunmute, cban, cunban, cpin, cannounce, cwho, cclose, copen

Many commands also have short aliases (see `.help <command>`).

## Hanson, the AI assistant

```
.hanson on          turn Hanson on
.hanson off         turn him off
.hanson owner       only you can talk to him (default)
.hanson all         everybody who can use your bot can talk to him
.hanson forget      clear his memory
```

With Hanson on, start a message with his name:

- `Hanson play burna boy last last` runs `.play` for you
- reply to a message: `Hanson translate this to french`
- `Hanson what does antitag do?` he answers in the chat

He types the command as the person talking, so he never has more power than that person. For safety he does not run commands that change who controls the bot or message other people (`.setsudo`, `.block`, `.unlink`, `.broadcast`, ...).

## Adding your own command

In any command file (for example `more5.js`, inside `register(add)`):

```js
add('hello', 'Fun', '', 'Say hello', (ctx) => 'Hello from Hans-Mini!');
```

`add(name, category, usage, description, run, options)`. Options: `aliases`, `owner`, `group`, `admin`, `botAdmin`.
