// ---------------------------------------------------------------------------
// Reminder engine — the hospital call flow, in one file.
//
//   enrol patient ──► 7 protocol visits, each with 3 planned call attempts
//
//   attempt due ──► call placed ──► patient listens ──► visit = REACHED (stop)
//                                └─► no answer / busy / hung up
//                                      └─► next attempt (or, after attempt 3,
//                                          visit = NOT_RESPONDING → staff list)
//
// Visit reminder_state:  pending | reached | not_responding | closed |
//                        skipped | not_applicable | legacy
// Attempt status:        scheduled | dialing | answered | unanswered |
//                        skipped | cancelled | failed
// ---------------------------------------------------------------------------
const db = require('../db');
const dates = require('../lib/dates');
const { buildPlan } = require('../config/schedule');
const telephony = require('./telephony');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const CALL_START_HOUR = () => num(process.env.CALL_WINDOW_START_HOUR, 9);
const CALL_END_HOUR = () => num(process.env.CALL_WINDOW_END_HOUR, 18);
const MIN_ANSWER_SECONDS = () => num(process.env.MIN_ANSWER_SECONDS, 10);
const MAX_API_ERRORS = 3;
const STALE_AFTER_MIN = 15;     // ask Twilio what happened to a call with no result
const NO_SID_AFTER_MIN = 5;     // claimed but Twilio was never reached (crash)
const GIVE_UP_AFTER_MIN = 60;   // still unknown after an hour -> count as unanswered

const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

const iso = (now) => now.toISOString();

// ---- eligibility ----------------------------------------------------------

function isCallable(p) {
  return p.study_group === 'intervention' && p.consent_given === 1 && p.active === 1
    && p.high_risk === 0 && p.hearing_impairment === 0;
}

// ---- schedule generation --------------------------------------------------

function isLocked(visit) {
  if (visit.attended !== null) return true;
  const used = db.prepare(`
    SELECT COUNT(*) AS c FROM reminder_attempts
    WHERE visit_id = ? AND status IN ('dialing','answered','unanswered','failed')
  `).get(visit.id).c;
  return used > 0;
}

// Creates the 7 protocol visits (+ call attempts for intervention patients).
// Safe to call again after an LMP correction: visits that already have call
// history or an attendance record are kept, the rest are rebuilt.
// Attempts whose date has already passed, and every attempt of a window that was
// already open on the enrolment day, are marked 'skipped' (e.g. a patient who
// enrols at 15 weeks never gets calls for the 6-9 week window).
function generateVisits(patient, lmp, now = new Date()) {
  const todayStr = dates.today(now);
  // The patient is physically at the hospital on her enrolment day, so any visit
  // window that had already opened by then is handled in person, not by phone.
  const enrolDay = patient.enrolled_at ? dates.today(new Date(patient.enrolled_at)) : todayStr;
  const callable = isCallable(patient);
  const existing = db.prepare('SELECT * FROM visits WHERE patient_id = ? AND visit_no IS NOT NULL').all(patient.id);

  const insVisit = db.prepare(`
    INSERT INTO visits (patient_id, visit_type, label, scheduled_date, visit_no,
      window_start_week, window_end_week, window_start_date, window_end_date, tests, reminder_state)
    VALUES (@patient_id, 'anc_visit', @label, @window_start_date, @visit_no,
      @window_start_week, @window_end_week, @window_start_date, @window_end_date, @tests, @state)
  `);
  const insAttempt = db.prepare(`
    INSERT INTO reminder_attempts (visit_id, patient_id, attempt_no, due_date, status)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const p of buildPlan(lmp)) {
      const ex = existing.find((v) => v.visit_no === p.visit_no);
      if (ex) {
        if (isLocked(ex)) continue;
        db.prepare('DELETE FROM visits WHERE id = ?').run(ex.id);
      }
      const inPerson = p.window_start_date <= enrolDay;
      const live = !inPerson && p.attempts.some((a) => a.due_date >= todayStr);
      const state = !callable ? 'not_applicable' : live ? 'pending' : 'skipped';
      const info = insVisit.run({
        patient_id: patient.id,
        label: p.label,
        visit_no: p.visit_no,
        window_start_week: p.window_start_week,
        window_end_week: p.window_end_week,
        window_start_date: p.window_start_date,
        window_end_date: p.window_end_date,
        tests: JSON.stringify(p.tests),
        state,
      });
      if (callable) {
        for (const a of p.attempts) {
          insAttempt.run(info.lastInsertRowid, patient.id, a.attempt_no, a.due_date,
            inPerson || a.due_date < todayStr ? 'skipped' : 'scheduled');
        }
      }
    }
  })();
}

// ---- attempt lifecycle ----------------------------------------------------

// Records the result of an attempt and moves the visit through the flow.
// Only acts on attempts still 'dialing', so duplicate/late webhooks are harmless.
const finalizeAttempt = db.transaction((attemptId, outcome, info, now) => {
  const a = db.prepare('SELECT * FROM reminder_attempts WHERE id = ?').get(attemptId);
  if (!a || a.status !== 'dialing') return false;

  db.prepare(`
    UPDATE reminder_attempts
    SET status = @outcome, call_status = COALESCE(@call_status, call_status),
        duration_sec = COALESCE(@duration, duration_sec), completed_at = @ts,
        last_error = COALESCE(@error, last_error)
    WHERE id = @id
  `).run({
    outcome, id: attemptId, ts: iso(now),
    call_status: info.status ?? null, duration: info.duration ?? null, error: info.error ?? null,
  });

  const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(a.visit_id);

  if (outcome === 'answered') {
    if (['pending', 'not_responding', 'skipped'].includes(v.reminder_state)) {
      db.prepare(`UPDATE reminder_attempts SET status = 'cancelled' WHERE visit_id = ? AND status = 'scheduled'`).run(v.id);
      db.prepare(`
        UPDATE visits SET reminder_state = 'reached',
          followup_resolved_at = CASE WHEN reminder_state = 'not_responding' AND followup_resolved_at IS NULL THEN @ts ELSE followup_resolved_at END,
          followup_note = CASE WHEN reminder_state = 'not_responding' AND followup_resolved_at IS NULL THEN 'Reached by a later call' ELSE followup_note END
        WHERE id = @id
      `).run({ id: v.id, ts: iso(now) });
    }
  } else if (v.reminder_state === 'pending') {
    const remaining = db.prepare(`
      SELECT COUNT(*) AS c FROM reminder_attempts WHERE visit_id = ? AND status IN ('scheduled','dialing')
    `).get(v.id).c;
    if (remaining === 0) {
      db.prepare(`UPDATE visits SET reminder_state = 'not_responding', flagged_at = ? WHERE id = ?`).run(iso(now), v.id);
    }
  }
  return true;
});

// Twilio status update (webhook or reconciliation) -> attempt state.
function applyCallStatus(attemptId, { status, duration = null, sid = null }, now = new Date()) {
  const a = db.prepare('SELECT * FROM reminder_attempts WHERE id = ?').get(attemptId);
  if (!a || a.status !== 'dialing') return false;
  if (sid && !a.twilio_call_sid) {
    db.prepare('UPDATE reminder_attempts SET twilio_call_sid = ? WHERE id = ?').run(sid, attemptId);
  }
  if (!TERMINAL.has(status)) {
    db.prepare('UPDATE reminder_attempts SET call_status = ? WHERE id = ?').run(status, attemptId);
    return true;
  }
  const listened = status === 'completed' && (duration ?? 0) >= MIN_ANSWER_SECONDS();
  return finalizeAttempt(attemptId, listened ? 'answered' : 'unanswered', { status, duration }, now);
}

// ---- placing calls --------------------------------------------------------

// Atomically reserves a planned attempt. Fails (returns false) if it was already
// taken, an earlier attempt for the visit is unresolved, or this patient has
// already been called today — that last rule keeps attempts a day apart and
// stops two visits' reminders from landing on the same day.
function claimAttempt(id, todayStr, now) {
  const r = db.prepare(`
    UPDATE reminder_attempts
    SET status = 'dialing', placed_at = @ts, placed_on = @today
    WHERE id = @id AND status = 'scheduled'
      AND NOT EXISTS (SELECT 1 FROM reminder_attempts o
                      WHERE o.patient_id = reminder_attempts.patient_id AND o.placed_on = @today)
      AND NOT EXISTS (SELECT 1 FROM reminder_attempts o
                      WHERE o.visit_id = reminder_attempts.visit_id
                        AND (o.status = 'dialing'
                             OR (o.status = 'scheduled' AND o.attempt_no < reminder_attempts.attempt_no)))
  `).run({ id, today: todayStr, ts: iso(now) });
  return r.changes === 1;
}

async function placeAttempt(attemptId, now = new Date()) {
  const todayStr = dates.today(now);
  if (!claimAttempt(attemptId, todayStr, now)) return 'not-claimed';

  const a = db.prepare('SELECT * FROM reminder_attempts WHERE id = ?').get(attemptId);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(a.patient_id);
  try {
    const call = await telephony.placeCall({ to: patient.phone_number, attemptId });
    db.prepare('UPDATE reminder_attempts SET twilio_call_sid = ?, call_status = ? WHERE id = ?')
      .run(call.sid, call.status, attemptId);
    return 'placed';
  } catch (err) {
    const errors = a.error_count + 1;
    db.prepare('UPDATE reminder_attempts SET error_count = ?, last_error = ? WHERE id = ?')
      .run(errors, err.message, attemptId);
    if (errors >= MAX_API_ERRORS) {
      // The number is probably invalid or Twilio keeps rejecting it: count it as a failed attempt.
      finalizeAttempt(attemptId, 'unanswered', { status: 'failed', error: err.message }, now);
      return 'failed';
    }
    // Transient (network, config): put it back and try again on the next sweep.
    db.prepare(`UPDATE reminder_attempts SET status = 'scheduled', placed_at = NULL, placed_on = NULL WHERE id = ?`).run(attemptId);
    return 'retry-later';
  }
}

function findDueAttempts(todayStr) {
  return db.prepare(`
    SELECT a.id, a.attempt_no, a.due_date, a.visit_id, v.label, p.full_name
    FROM reminder_attempts a
    JOIN visits v ON v.id = a.visit_id
    JOIN patients p ON p.id = a.patient_id
    WHERE a.status = 'scheduled' AND a.manual = 0 AND a.due_date <= ?
      AND v.reminder_state = 'pending' AND v.attended IS NOT 1
      AND p.study_group = 'intervention' AND p.consent_given = 1 AND p.active = 1
      AND p.high_risk = 0 AND p.hearing_impairment = 0
    ORDER BY a.due_date, v.visit_no, a.attempt_no
  `).all(todayStr);
}

// Calls that never got a result (webhook lost, server restarted mid-call).
async function reconcileStale(now = new Date()) {
  if (telephony.isDryRun()) return; // dry-run calls are completed by hand
  const staleBefore = iso(new Date(now.getTime() - STALE_AFTER_MIN * 60000));
  const rows = db.prepare(`SELECT * FROM reminder_attempts WHERE status = 'dialing' AND placed_at < ?`).all(staleBefore);
  for (const a of rows) {
    const ageMin = (now.getTime() - new Date(a.placed_at).getTime()) / 60000;
    if (!a.twilio_call_sid) {
      if (ageMin >= NO_SID_AFTER_MIN && !a.manual) {
        db.prepare(`UPDATE reminder_attempts SET status = 'scheduled', placed_at = NULL, placed_on = NULL WHERE id = ?`).run(a.id);
      } else if (a.manual) {
        db.prepare(`UPDATE reminder_attempts SET status = 'failed', completed_at = ? WHERE id = ?`).run(iso(now), a.id);
      }
      continue;
    }
    try {
      const c = await telephony.fetchCall(a.twilio_call_sid);
      if (c && TERMINAL.has(c.status)) { applyCallStatus(a.id, { status: c.status, duration: c.duration }, now); continue; }
    } catch (err) {
      console.error(`[reminders] could not fetch call ${a.twilio_call_sid}: ${err.message}`);
    }
    if (ageMin >= GIVE_UP_AFTER_MIN) {
      finalizeAttempt(a.id, 'unanswered', { status: 'failed', error: 'No result received from Twilio' }, now);
    }
  }
}

let sweeping = false;

// One pass of the scheduler: place every call that is due today.
async function runSweep({ now = new Date(), ignoreHours = false } = {}) {
  if (sweeping) return { skipped: 'already-running' };
  sweeping = true;
  try {
    await reconcileStale(now);
    const { date, hour } = dates.nowParts(now);
    if (!ignoreHours && (hour < CALL_START_HOUR() || hour >= CALL_END_HOUR())) return { skipped: 'outside-calling-hours' };
    const due = findDueAttempts(date);
    const result = { due: due.length, placed: 0, failed: 0 };
    for (const a of due) {
      const r = await placeAttempt(a.id, now);
      if (r === 'placed') { result.placed++; console.log(`[scheduler] Called ${a.full_name} — ${a.label}, attempt ${a.attempt_no}`); }
      if (r === 'failed') result.failed++;
    }
    return result;
  } finally {
    sweeping = false;
  }
}

// ---- staff actions --------------------------------------------------------

// Place an extra call right now (staff clicked "Call now"); ignores the daily cap.
async function manualCall(visitId, now = new Date()) {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) throw httpError(404, 'Visit not found');
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(visit.patient_id);
  if (!isCallable(patient)) throw httpError(400, 'This patient is not eligible for reminder calls (control group, excluded, withdrawn or no consent).');
  if (['not_applicable', 'legacy'].includes(visit.reminder_state)) throw httpError(400, 'No reminders apply to this visit.');
  if (visit.attended === 1) throw httpError(400, 'This visit is already marked as attended.');

  const busy = db.prepare(`SELECT 1 FROM reminder_attempts WHERE visit_id = ? AND status = 'dialing'`).get(visitId);
  if (busy) throw httpError(409, 'A call for this visit is already in progress.');

  const todayStr = dates.today(now);
  const attemptNo = db.prepare('SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM reminder_attempts WHERE visit_id = ?').get(visitId).n;
  const id = db.prepare(`
    INSERT INTO reminder_attempts (visit_id, patient_id, attempt_no, manual, due_date, status, placed_at, placed_on)
    VALUES (?, ?, ?, 1, ?, 'dialing', ?, ?)
  `).run(visitId, patient.id, attemptNo, todayStr, iso(now), todayStr).lastInsertRowid;

  try {
    const call = await telephony.placeCall({ to: patient.phone_number, attemptId: id });
    db.prepare('UPDATE reminder_attempts SET twilio_call_sid = ?, call_status = ? WHERE id = ?').run(call.sid, call.status, id);
    return { attemptId: Number(id), sid: call.sid, status: call.status };
  } catch (err) {
    db.prepare(`UPDATE reminder_attempts SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?`).run(err.message, iso(now), id);
    throw httpError(400, err.message);
  }
}

const markAttendance = db.transaction((visitId, attended, now = new Date()) => {
  const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!v) throw httpError(404, 'Visit not found');
  db.prepare('UPDATE visits SET attended = ? WHERE id = ?').run(attended === null ? null : attended ? 1 : 0, visitId);
  if (attended) {
    // She came — no more calls for this visit, and any open follow-up is closed.
    db.prepare(`UPDATE reminder_attempts SET status = 'cancelled' WHERE visit_id = ? AND status = 'scheduled'`).run(visitId);
    if (v.reminder_state === 'pending') {
      db.prepare(`UPDATE visits SET reminder_state = 'closed' WHERE id = ?`).run(visitId);
    } else if (v.reminder_state === 'not_responding' && !v.followup_resolved_at) {
      db.prepare(`UPDATE visits SET followup_resolved_at = ?, followup_note = COALESCE(followup_note, 'Attended the visit') WHERE id = ?`).run(iso(now), visitId);
    }
  }
  return db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
});

function resolveFollowup(visitId, note, now = new Date()) {
  const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!v) throw httpError(404, 'Visit not found');
  if (v.reminder_state !== 'not_responding') throw httpError(400, 'This visit is not in the Not responding list.');
  db.prepare('UPDATE visits SET followup_resolved_at = ?, followup_note = ? WHERE id = ?')
    .run(iso(now), (note || '').trim() || 'Follow-up done', visitId);
  return db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
}

// Reopen a resolved follow-up (clicked "Resolve" by mistake).
function reopenFollowup(visitId) {
  const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!v) throw httpError(404, 'Visit not found');
  if (v.reminder_state !== 'not_responding') throw httpError(400, 'This visit is not in the Not responding list.');
  db.prepare('UPDATE visits SET followup_resolved_at = NULL, followup_note = NULL WHERE id = ?').run(visitId);
  return db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
}

// ---- presentation helpers -------------------------------------------------

// Adds a human-friendly `status` and `phase` to a visit row for the UI.
function decorateVisit(v, attempts, todayStr) {
  const phase = todayStr < v.window_start_date ? 'future' : todayStr <= v.window_end_date ? 'open' : 'past';
  let status;
  if (v.attended === 1) status = 'attended';
  else if (v.attended === 0) status = 'missed';
  else if (v.reminder_state === 'not_responding') status = v.followup_resolved_at ? 'followed_up' : 'not_responding';
  else if (v.reminder_state === 'reached') status = 'reached';
  else if (v.reminder_state === 'skipped') status = 'skipped';
  else if (v.reminder_state === 'pending') status = attempts.some((a) => a.status !== 'scheduled' && a.status !== 'skipped') ? 'calling' : 'upcoming';
  else status = phase === 'past' ? 'overdue' : phase === 'open' ? 'due_now' : 'upcoming';
  return { ...v, tests: v.tests ? JSON.parse(v.tests) : [], phase, status, attempts };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  isCallable, generateVisits, applyCallStatus, finalizeAttempt, placeAttempt, findDueAttempts,
  runSweep, reconcileStale, manualCall, markAttendance, resolveFollowup, reopenFollowup,
  decorateVisit, httpError, MIN_ANSWER_SECONDS,
};
