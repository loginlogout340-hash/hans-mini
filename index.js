'use strict';
/**
 * Hans-Mini (multi-user): a pairing website plus one WhatsApp bot per connected user.
 * Start: node index.js
 */
const manager = require('./manager');
const server = require('./server');
const { commandCount } = require('./bot');

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`${process.env.BOT_NAME || 'Hans-Mini'}: ${commandCount} commands, pairing site on port ${PORT}, up to ${manager.MAX_USERS} users, data in ${manager.DATA_DIR}`);
});

manager.restoreAll().catch((e) => console.error('restore failed:', e));
