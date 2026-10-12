// End-to-end test of the hospital reminder flow, using a throw-away database,
// DRY_RUN (no Twilio) and a simulated clock.
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.DRY_RUN = 'true';
process.env.APP_TIMEZONE = 'Asia/Kolkata';
delete process.env.ADMIN_PASSWORD;

const dates = require('../lib/dates');
const { buildPlan, VISITS } = require('../config/schedule');
const reminders = require('../services/reminders');
const db = require('../db');
const app = require('../server');

let base;
let server;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { server.close(); db.close(); });

const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const at = (ymd, time = '10:00:00') => new Date(`${ymd}T${time}+05:30`);
const TODAY = dates.today();

test('protocol matches the hospital sheet', () => {
  assert.deepEqual(VISITS.map((v) => [v.startWeek, v.endWeek]),
    [[6, 9], [10, 11], [14, 15], [20, 22], [26, 28], [30, 32], [34, 36]]);
  // Visit 3: week 14, week 15, then the LAST call in week 16
  const lmp = '2026-01-05';
  const v3 = buildPlan(lmp).find((v) => v.visit_no === 3);
  assert.deepEqual(v3.attempts.map((a) => a.due_date),
    [dates.addDays(lmp, 98), dates.addDays(lmp, 105), dates.addDays(lmp, 112)]);
  const v4 = buildPlan(lmp).find((v) => v.visit_no === 4);
  assert.equal(v4.attempts[2].due_date, dates.addDays(lmp, 23 * 7)); // 22 + 1
});

test('enrolment validates input and builds 7 visits', async () => {
  let r = await api('POST', '/patients', { registration_id: 'X1', full_name: 'A', phone_number: '123', study_group: 'intervention', consent_given: true, gestational_age_weeks: 5 });
  assert.equal(r.status, 400);
  r = await api('POST', '/patients', { registration_id: 'X1', full_name: 'A', phone_number: '9876543210', study_group: 'intervention', consent_given: true });
  assert.equal(r.status, 400, 'needs LMP / EDD / GA');
  r = await api('POST', '/patients', { registration_id: 'X1', full_name: 'A', phone_number: '9876543210', study_group: 'intervention', consent_given: false, gestational_age_weeks: 5 });
  assert.equal(r.status, 400, 'intervention needs consent');
  r = await api('POST', '/patients', { registration_id: 'X1', full_name: 'A', phone_number: '9876543210', study_group: 'intervention', consent_given: true, lmp_date: dates.addDays(TODAY, 3) });
  assert.equal(r.status, 400, 'future LMP');
  r = await api('POST', '/patients', { registration_id: 'REG-1', full_name: 'Test Mother', phone_number: '98765 43210', study_group: 'intervention', consent_given: true, gestational_age_weeks: 5 });
  assert.equal(r.status, 201);
  assert.equal(r.body.phone_number, '+919876543210');
  assert.equal(r.body.visits.length, 7);
  assert.equal(r.body.visits[2].attempts.length, 3);
  r = await api('POST', '/patients', { registration_id: 'REG-1', full_name: 'Dup', phone_number: '9876543210', study_group: 'control', gestational_age_weeks: 5 });
  assert.equal(r.status, 409);
});

test('3 unanswered calls -> Not responding; calls follow the sheet', async () => {
  const p = db.prepare("SELECT * FROM patients WHERE registration_id = 'REG-1'").get();
  const lmp = p.reference_lmp;
  const placedDates = {};
  for (let d = 0; d <= 120; d++) {
    const day = dates.addDays(TODAY, d);
    const res = await reminders.runSweep({ now: at(day) });
    assert.ok(res.placed <= 1, 'never more than one call per patient per day');
    for (const a of db.prepare("SELECT * FROM reminder_attempts WHERE status = 'dialing'").all()) {
      (placedDates[a.visit_id] ||= []).push([a.attempt_no, day]);
      reminders.applyCallStatus(a.id, { status: 'no-answer', duration: 0 }, at(day, '10:05:00'));
    }
  }
  const v3 = db.prepare('SELECT * FROM visits WHERE patient_id = ? AND visit_no = 3').get(p.id);
  assert.deepEqual(placedDates[v3.id], [
    [1, dates.addDays(lmp, 98)], [2, dates.addDays(lmp, 105)], [3, dates.addDays(lmp, 112)],
  ]);
  assert.equal(v3.reminder_state, 'not_responding');
  assert.ok(v3.flagged_at);

  const list = (await api('GET', '/not-responding')).body;
  assert.ok(list.some((x) => x.id === v3.id && x.full_name === 'Test Mother'));
  assert.equal(list.find((x) => x.id === v3.id).attempts.length, 3);

  // staff resolve -> leaves the open list, stays in history
  assert.equal((await api('POST', `/visits/${v3.id}/resolve`, { note: 'Phoned husband' })).status, 200);
  assert.ok(!(await api('GET', '/not-responding')).body.some((x) => x.id === v3.id));
  assert.ok((await api('GET', '/not-responding?resolved=true')).body.some((x) => x.id === v3.id));
});

test('answered call stops further reminders for that visit', async () => {
  const r = await api('POST', '/patients', { registration_id: 'REG-2', full_name: 'Answers', phone_number: '9123456780', study_group: 'intervention', consent_given: true, gestational_age_weeks: 5 });
  const p = r.body;
  const lmp = p.reference_lmp;
  const v4 = db.prepare('SELECT * FROM visits WHERE patient_id = ? AND visit_no = 4').get(p.id);
  for (let d = 0; d <= 150; d++) {
    const day = dates.addDays(TODAY, d);
    await reminders.runSweep({ now: at(day) });
    for (const a of db.prepare("SELECT * FROM reminder_attempts WHERE status = 'dialing' AND patient_id = ?").all(p.id)) {
      const answer = a.visit_id === v4.id && a.attempt_no === 2;
      reminders.applyCallStatus(a.id, answer ? { status: 'completed', duration: 40 } : { status: 'no-answer', duration: 0 }, at(day, '10:05:00'));
    }
  }
  const att = db.prepare('SELECT attempt_no, status FROM reminder_attempts WHERE visit_id = ? ORDER BY attempt_no').all(v4.id);
  assert.deepEqual(att, [{ attempt_no: 1, status: 'unanswered' }, { attempt_no: 2, status: 'answered' }, { attempt_no: 3, status: 'cancelled' }]);
  assert.equal(db.prepare('SELECT reminder_state FROM visits WHERE id = ?').get(v4.id).reminder_state, 'reached');
  void lmp;
});

test('a hang-up under 10 seconds does not count as listened', () => {
  const p = db.prepare("SELECT * FROM patients WHERE registration_id = 'REG-2'").get();
  const v = db.prepare('SELECT id FROM visits WHERE patient_id = ? AND visit_no = 7').get(p.id);
  const id = db.prepare("INSERT INTO reminder_attempts (visit_id, patient_id, attempt_no, manual, due_date, status, placed_at, placed_on) VALUES (?,?,?,?,?,'dialing',?,?)")
    .run(v.id, p.id, 9, 1, TODAY, new Date().toISOString(), TODAY).lastInsertRowid;
  reminders.applyCallStatus(Number(id), { status: 'completed', duration: 3 });
  assert.equal(db.prepare('SELECT status FROM reminder_attempts WHERE id = ?').get(id).status, 'unanswered');
});

test('attendance closes the reminders; control group is never called', async () => {
  const r = await api('POST', '/patients', { registration_id: 'REG-3', full_name: 'Attends', phone_number: '9000000001', study_group: 'intervention', consent_given: true, gestational_age_weeks: 1 });
  const v = r.body.visits.find((x) => x.visit_no === 1);
  const out = await api('PATCH', `/visits/${v.id}`, { attended: true });
  assert.equal(out.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reminder_attempts WHERE visit_id = ? AND status = 'scheduled'").get(v.id).c, 0);
  assert.equal(db.prepare('SELECT reminder_state FROM visits WHERE id = ?').get(v.id).reminder_state, 'closed');

  const c = await api('POST', '/patients', { registration_id: 'REG-4', full_name: 'Control', phone_number: '9000000002', study_group: 'control', gestational_age_weeks: 1 });
  assert.equal(c.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reminder_attempts WHERE patient_id = ?').get(c.body.id).c, 0);
});

test('late enrolment: windows already open are not phoned', async () => {
  const r = await api('POST', '/patients', { registration_id: 'REG-5', full_name: 'Late', phone_number: '9000000003', study_group: 'intervention', consent_given: true, gestational_age_weeks: 16 });
  const states = Object.fromEntries(r.body.visits.map((v) => [v.visit_no, v.reminder_state]));
  assert.deepEqual([states[1], states[2], states[3]], ['skipped', 'skipped', 'skipped']);
  assert.equal(states[4], 'pending');
});

test('LMP correction rebuilds untouched visits only', async () => {
  const r = await api('POST', '/patients', { registration_id: 'REG-6', full_name: 'Fix', phone_number: '9000000004', study_group: 'intervention', consent_given: true, lmp_date: dates.addDays(TODAY, -30) });
  const before = r.body.visits.find((v) => v.visit_no === 3).window_start_date;
  const u = await api('PATCH', `/patients/${r.body.id}`, { lmp_date: dates.addDays(TODAY, -37) });
  assert.equal(u.status, 200);
  assert.equal(u.body.visits.find((v) => v.visit_no === 3).window_start_date, dates.addDays(before, -7));
  assert.equal(u.body.visits.length, 7);
});

test('dashboard, summary and csv endpoints respond', async () => {
  for (const url of ['/dashboard', '/summary', '/config', '/protocol', '/patients?q=Test']) {
    assert.equal((await api('GET', url)).status, 200, url);
  }
  const csv = await fetch(`${base}/export/visits.csv`);
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /registration_id/);
});
