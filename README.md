# Hans-Mini

A small WhatsApp bot with 81 commands, built on Baileys. Files: `index.js`, `commands.js`, `media.js`, `package.json`, `Dockerfile`.

## Settings (environment variables)

| Variable | Required | Meaning |
|---|---|---|
| `PAIR_NUMBER` | first run only | Your WhatsApp number with country code, digits only (e.g. `233XXXXXXXXX`) |
| `OWNER_NUMBER` | yes | Owner number(s), comma separated, digits only |
| `PREFIX` | no | Command prefix (default `.`) |
| `BOT_NAME` | no | Name shown in the menu (default `Hans-Mini`) |
| `MODE` | no | `public` (everyone) or `private` (owner only) |
| `TIMEZONE` | no | Default `Africa/Accra` |
| `AUTO_STATUS` | no | `on` to automatically view contacts' statuses |
| `AUTO_LIKE_STATUS` | no | `on` to automatically react to statuses |
| `LIKE_EMOJI` | no | Reaction emoji (default 💚) |
| `ANTI_VIEWONCE` | no | `on` to copy view-once media to the owner chat |
| `ANTI_DELETE` | no | `on` to send deleted messages to the owner chat |
| `SESSION_DIR` | no | Where the login is saved (default `./session`) |

## Deploy on Railway

1. Put all the files (index.js, commands.js, media.js, package.json, Dockerfile) + this README in a GitHub repo.
2. Railway > New Project > Deploy from GitHub repo.
3. Add the variables above (`PAIR_NUMBER`, `OWNER_NUMBER`).
4. Add a **Volume** mounted at `/app/session` and set `SESSION_DIR=/app/session`. Without it, the login is lost on every redeploy and you must pair again.
5. Open the deploy logs, find the **PAIRING CODE**, then on the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number, and type the code.
6. Send `.menu` from any chat.

Use a spare number while testing.

## Commands

General: menu, help, ping, alive, uptime, owner, about, sysinfo
Utility: calc, time, date, weather, convert, crypto, define, translate, wiki, country, github, bible, shorten, qr, password, uuid, random
Text: upper, lower, title, reverse, mock, clap, wordcount, b64e, b64d, binary, unbinary, morse, unmorse, rot13, palindrome, repeat, hash
Fun: 8ball, flip, dice, choose, truth, dare, pickup, wyr, riddle, love, rate, joke, fact, advice, quote
Group: groupinfo, admins, tagall, hidetag, kick, add, promote, demote, mute, unmute, link, revoke, setname, setdesc, leave, delete, getpp
Owner: mode, autostatus, autolikestatus, antiviewonce, antidelete, retrieve, restart

Many commands also have short aliases (see `.help <command>`).

## Adding your own command

In `commands.js`:

```js
add('hello', 'Fun', '', 'Say hello', (ctx) => 'Hello from Hans-Mini!');
```
