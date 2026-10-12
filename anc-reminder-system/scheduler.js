const cron = require('node-cron');
const db = require('./db');
const { triggerCallForVisit } = require('./routes/calls');

// Runs every 30 minutes. Finds intervention-group visits whose 48h-before
// reminder time has arrived, the patient is still active & consented,
// and no call has been sent yet — then places the call.
function findDueVisits() {
  const nowIso = new Date().toISOString();
  return db.prepare(`
    SELECT v.id AS visit_id, v.label, p.full_name, p.phone_number
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    WHERE v.reminder_sent = 0
      AND v.reminder_scheduled_for IS NOT NULL
      AND v.reminder_scheduled_for <= ?
      AND p.study_group = 'intervention'
      AND p.consent_given = 1
      AND p.active = 1
  `).all(nowIso);
}

async function runReminderSweep() {
  const due = findDueVisits();
  if (due.length === 0) return;
  console.log(`[scheduler] ${due.length} reminder call(s) due — dispatching...`);
  for (const v of due) {
    try {
      await triggerCallForVisit(v.visit_id);
      console.log(`[scheduler] Called ${v.full_name} (${v.phone_number}) for "${v.label}"`);
    } catch (err) {
      console.error(`[scheduler] Failed for visit ${v.visit_id}: ${err.message}`);
    }
  }
}

function start() {
  // Every 30 minutes. Adjust the cron expression if you want finer granularity.
  cron.schedule('*/30 * * * *', runReminderSweep);
  console.log('[scheduler] Reminder sweep scheduled every 30 minutes.');
}

module.exports = { start, runReminderSweep, findDueVisits };
