const express = require('express');
const db = require('../db');
const dates = require('../lib/dates');
const reminders = require('../services/reminders');
const telephony = require('../services/telephony');
const { VISITS, MAX_ATTEMPTS } = require('../config/schedule');

const router = express.Router();

router.get('/config', (req, res) => {
  const hours = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
  res.json({
    dryRun: telephony.isDryRun(),
    twilioConfigured: telephony.isConfigured(),
    timezone: dates.TIMEZONE,
    today: dates.today(),
    callWindow: { startHour: hours('CALL_WINDOW_START_HOUR', 9), endHour: hours('CALL_WINDOW_END_HOUR', 18) },
  });
});

// The protocol, as shown to staff.
router.get('/protocol', (req, res) => {
  res.json({ maxAttempts: MAX_ATTEMPTS, visits: VISITS });
});

router.get('/dashboard', (req, res) => {
  const today = dates.today();
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const patients = one(`SELECT COUNT(*) AS total,
      SUM(study_group = 'intervention') AS intervention, SUM(study_group = 'control') AS control
    FROM patients WHERE active = 1`);
  const openFollowups = one(`SELECT COUNT(*) AS c FROM visits
    WHERE reminder_state = 'not_responding' AND followup_resolved_at IS NULL`).c;
  const dueToday = reminders.findDueAttempts(today);
  const placedToday = one(`SELECT COUNT(*) AS placed,
      SUM(status = 'answered') AS answered, SUM(status = 'dialing') AS in_progress
    FROM reminder_attempts WHERE placed_on = ?`, today);
  const flow = one(`SELECT SUM(reminder_state = 'reached') AS reached,
      SUM(reminder_state = 'not_responding') AS not_responding,
      SUM(reminder_state = 'pending') AS pending
    FROM visits WHERE visit_no IS NOT NULL`);

  const upcoming = db.prepare(`
    SELECT a.id, a.due_date, a.attempt_no, v.id AS visit_id, v.label, p.id AS patient_id, p.full_name
    FROM reminder_attempts a
    JOIN visits v ON v.id = a.visit_id JOIN patients p ON p.id = a.patient_id
    WHERE a.status = 'scheduled' AND a.manual = 0 AND v.reminder_state = 'pending'
      AND a.due_date > ? AND a.due_date <= ? AND p.active = 1
    ORDER BY a.due_date, p.full_name LIMIT 30
  `).all(today, dates.addDays(today, 14));

  res.json({
    today,
    patients: { total: patients.total || 0, intervention: patients.intervention || 0, control: patients.control || 0 },
    open_followups: openFollowups,
    due_today: dueToday.map((d) => ({ attempt_id: d.id, attempt_no: d.attempt_no, label: d.label, full_name: d.full_name, due_date: d.due_date })),
    calls_today: { placed: placedToday.placed || 0, answered: placedToday.answered || 0, in_progress: placedToday.in_progress || 0 },
    flow: { reached: flow.reached || 0, not_responding: flow.not_responding || 0, pending: flow.pending || 0 },
    in_progress: db.prepare(`
      SELECT a.id, a.attempt_no, a.manual, v.label, p.full_name FROM reminder_attempts a
      JOIN visits v ON v.id = a.visit_id JOIN patients p ON p.id = a.patient_id
      WHERE a.status = 'dialing' ORDER BY a.placed_at`).all(),
    upcoming,
  });
});

// The "Not responding" block: every visit whose 3 calls all went unanswered.
router.get('/not-responding', (req, res) => {
  const includeResolved = req.query.resolved === 'true';
  const rows = db.prepare(`
    SELECT v.*, p.full_name, p.registration_id, p.phone_number, p.language, p.reference_lmp
    FROM visits v JOIN patients p ON p.id = v.patient_id
    WHERE v.reminder_state = 'not_responding' ${includeResolved ? '' : 'AND v.followup_resolved_at IS NULL'}
    ORDER BY v.followup_resolved_at IS NOT NULL, v.flagged_at
  `).all();
  const today = dates.today();
  const attemptsFor = db.prepare('SELECT * FROM reminder_attempts WHERE visit_id = ? ORDER BY attempt_no');
  res.json(rows.map((r) => ({
    ...reminders.decorateVisit(r, attemptsFor.all(r.id), today),
    full_name: r.full_name, registration_id: r.registration_id, phone_number: r.phone_number,
    patient_id: r.patient_id,
    ga_weeks: r.reference_lmp ? dates.gestationalAge(r.reference_lmp, today).weeks : null,
    days_waiting: r.flagged_at ? Math.max(0, dates.diffDays(dates.today(new Date(r.flagged_at)), today)) : 0,
  })));
});

// Study summary: adherence by group + how the reminder flow turned out.
router.get('/summary', (req, res) => {
  const byGroup = db.prepare(`
    SELECT p.study_group,
           COUNT(DISTINCT p.id) AS patients,
           SUM(CASE WHEN v.attended = 1 THEN 1 ELSE 0 END) AS attended,
           SUM(CASE WHEN v.attended = 0 THEN 1 ELSE 0 END) AS missed,
           SUM(CASE WHEN v.attended IS NULL AND v.id IS NOT NULL THEN 1 ELSE 0 END) AS pending
    FROM patients p LEFT JOIN visits v ON v.patient_id = p.id
    GROUP BY p.study_group
  `).all();
  const callStats = db.prepare(`
    SELECT status, COUNT(*) AS count FROM reminder_attempts
    WHERE status IN ('answered','unanswered','dialing','failed') GROUP BY status
  `).all();
  const flow = db.prepare(`
    SELECT reminder_state AS state, COUNT(*) AS count FROM visits
    WHERE visit_no IS NOT NULL AND reminder_state IN ('pending','reached','not_responding','closed')
    GROUP BY reminder_state
  `).all();
  const byAttempt = db.prepare(`
    SELECT attempt_no, COUNT(*) AS placed, SUM(status = 'answered') AS answered
    FROM reminder_attempts WHERE manual = 0 AND status IN ('answered','unanswered') GROUP BY attempt_no ORDER BY attempt_no
  `).all();
  res.json({ byGroup, callStats, flow, byAttempt });
});

// CSV for analysis (Excel opens it directly).
router.get('/export/visits.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT p.registration_id, p.full_name, p.study_group, p.reference_lmp, v.label, v.window_start_date, v.window_end_date,
           v.reminder_state, v.attended, v.flagged_at, v.followup_resolved_at, v.followup_note, v.id AS visit_id
    FROM visits v JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_no IS NOT NULL ORDER BY p.registration_id, v.visit_no
  `).all();
  const att = db.prepare('SELECT attempt_no, status, due_date, placed_at FROM reminder_attempts WHERE visit_id = ? AND manual = 0 ORDER BY attempt_no');
  const safe = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['registration_id', 'name', 'group', 'lmp', 'visit', 'window_start', 'window_end', 'reminder_state', 'attended',
    'call1_due', 'call1_result', 'call2_due', 'call2_result', 'call3_due', 'call3_result', 'flagged_not_responding_at', 'followup_resolved_at', 'followup_note'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const a = att.all(r.visit_id);
    const cell = (n) => { const x = a.find((y) => y.attempt_no === n); return x ? [x.due_date, x.status] : ['', '']; };
    lines.push([r.registration_id, r.full_name, r.study_group, r.reference_lmp, r.label, r.window_start_date, r.window_end_date,
      r.reminder_state, r.attended === null ? '' : r.attended ? 'yes' : 'no', ...cell(1), ...cell(2), ...cell(3),
      r.flagged_at, r.followup_resolved_at, r.followup_note].map(safe).join(','));
  }
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="anc-visits.csv"').send('﻿' + lines.join('\n'));
});

module.exports = { router };
