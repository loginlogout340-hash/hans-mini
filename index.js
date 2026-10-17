'use strict';
/**
 * Hans-Mini (multi-user): a pairing website plus one WhatsApp bot per connected user.
 * Start: node index.js
 */
const manager = require('./manager');
const server = require('./server');
const { commandCount } = require('./bot');

// one user's mistake must never take every other user's bot down
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const PORT = parseInt(process.env.PORT, 10) || 3000;
server.on('error', (e) => console.error('web server error:', e.message));
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch { /* ignore */ } });
server.listen(PORT, '0.0.0.0', () => {
  console.log(`${process.env.BOT_NAME || 'Hans-Mini'}: ${commandCount} commands, pairing site on port ${PORT}, up to ${manager.MAX_USERS} users, data in ${manager.DATA_DIR}`);
});

manager.restoreAll().catch((e) => console.error('restore failed:', e));

// memory and job report every 10 minutes (shows in the Railway logs, so you can see how much room 25 users need)
const heavy = require('./limit');
setInterval(() => {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576);
  console.log(`[health] users ${manager.stats().users}/${manager.MAX_USERS}, memory ${mb(m.rss)} MB (heap ${mb(m.heapUsed)} MB), heavy jobs ${JSON.stringify(heavy.stats())}`);
}, 10 * 60000).unref();

// Railway stops the old copy with SIGTERM during a deploy: save what is pending first
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { console.log(`${sig}: shutting down`); setTimeout(() => process.exit(0), 1500).unref(); try { process.emit('beforeExit'); } catch { /* ignore */ } });
}
