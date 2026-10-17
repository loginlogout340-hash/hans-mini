'use strict';
/**
 * Keeps heavy jobs (ffmpeg, yt-dlp) from running all at once, so 25 users cannot use up the server's memory.
 * At most HEAVY_JOBS run together (default 3); the rest wait in a queue (HEAVY_QUEUE, default 30). When even
 * the queue is full the user is asked to try again in a minute, instead of the bot running out of memory.
 */
const { execFile } = require('child_process');

const MAX = Math.max(1, parseInt(process.env.HEAVY_JOBS, 10) || 3);
const QUEUE_MAX = Math.max(5, parseInt(process.env.HEAVY_QUEUE, 10) || 30);
let running = 0;
const queue = [];

function next() {
  while (running < MAX && queue.length) { running++; queue.shift()(); }
}

/** same arguments as child_process.execFile(cmd, args, options, callback) */
function run(cmd, args, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (queue.length >= QUEUE_MAX) {
    const e = new Error('The bot is busy right now. Please try again in a minute.');
    process.nextTick(() => cb(e, '', e.message));
    return;
  }
  queue.push(() => {
    let done = false;
    const fin = (...a) => { if (done) return; done = true; running--; next(); cb(...a); };
    try { execFile(cmd, args, options || {}, fin); } catch (e) { fin(e, '', String(e.message)); }
  });
  next();
}

module.exports = { run, stats: () => ({ running, queued: queue.length, max: MAX }) };
