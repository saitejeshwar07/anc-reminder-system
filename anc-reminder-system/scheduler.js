const cron = require('node-cron');
const { runSweep } = require('./services/reminders');

// Every 10 minutes the sweep places whichever planned calls are due today.
// It only dials during calling hours (default 9:00–18:00 hospital time) and never
// calls the same patient twice in one day, so running it often is safe.
async function tick() {
  try {
    const r = await runSweep();
    if (r && r.due) console.log(`[scheduler] due=${r.due} placed=${r.placed} failed=${r.failed}`);
  } catch (err) {
    console.error(`[scheduler] sweep failed: ${err.message}`);
  }
}

let task = null;
function start() {
  task = cron.schedule('*/10 * * * *', tick);
  setTimeout(tick, 5000); // also catch up shortly after a restart
  console.log('[scheduler] Reminder sweep runs every 10 minutes.');
}
function stop() { if (task) task.stop(); }

module.exports = { start, stop, tick };
