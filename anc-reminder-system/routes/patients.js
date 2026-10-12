const express = require('express');
const router = express.Router();
const db = require('../db');
const dates = require('../lib/dates');
const { resolveDating, normalizePhone } = require('../lib/dating');
const reminders = require('../services/reminders');

// Wraps a handler so thrown errors (incl. httpError) reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function computeBmi(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const h = heightCm / 100;
  return +(weightKg / (h * h)).toFixed(1);
}

const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const numOrNull = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const textOrNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

function patientView(p, todayStr = dates.today()) {
  const ga = p.reference_lmp ? dates.gestationalAge(p.reference_lmp, todayStr) : null;
  return {
    ...p,
    ga_weeks: ga ? ga.weeks : null,
    ga_days: ga ? ga.days : null,
    expected_delivery: p.reference_lmp ? dates.addDays(p.reference_lmp, 280) : null,
  };
}

function loadVisits(patientId, todayStr) {
  const visits = db.prepare(`
    SELECT * FROM visits WHERE patient_id = ?
    ORDER BY visit_no IS NULL, visit_no, scheduled_date
  `).all(patientId);
  const attempts = db.prepare('SELECT * FROM reminder_attempts WHERE patient_id = ? ORDER BY visit_id, attempt_no').all(patientId);
  return visits.map((v) => reminders.decorateVisit(v, attempts.filter((a) => a.visit_id === v.id), todayStr));
}

// ---- Patients ----------------------------------------------------------------

router.post('/patients', (req, res) => {
  const b = req.body || {};
  for (const f of ['registration_id', 'full_name', 'phone_number', 'study_group']) {
    if (b[f] === undefined || b[f] === null || String(b[f]).trim() === '') {
      return res.status(400).json({ error: `Missing required field: ${f}` });
    }
  }
  const phone = normalizePhone(b.phone_number);
  if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number, e.g. 9876543210 or +919876543210.' });
  if (!['intervention', 'control'].includes(b.study_group)) {
    return res.status(400).json({ error: "study_group must be 'intervention' or 'control'" });
  }
  if (b.age !== undefined && b.age !== null && b.age !== '' && !(Number(b.age) >= 10 && Number(b.age) <= 60)) {
    return res.status(400).json({ error: 'Age looks wrong (expected 10–60).' });
  }
  if (b.study_group === 'intervention' && !bool(b.consent_given)) {
    return res.status(400).json({ error: 'Written informed consent is required before a patient can receive reminder calls.' });
  }

  const now = new Date();
  const todayStr = dates.today(now);
  let dating;
  try {
    dating = resolveDating(b, todayStr);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  try {
    const info = db.prepare(`
      INSERT INTO patients (
        registration_id, full_name, age, phone_number, language,
        lmp_date, edd_date, gestational_age_weeks, reference_lmp, dating_source,
        height_cm, weight_kg, bmi, occupation, obstetric_history, personal_history,
        study_group, consent_given, high_risk, hearing_impairment, enrolled_at
      ) VALUES (@registration_id, @full_name, @age, @phone_number, @language,
        @lmp_date, @edd_date, @gestational_age_weeks, @reference_lmp, @dating_source,
        @height_cm, @weight_kg, @bmi, @occupation, @obstetric_history, @personal_history,
        @study_group, @consent_given, @high_risk, @hearing_impairment, @enrolled_at)
    `).run({
      registration_id: String(b.registration_id).trim(),
      full_name: String(b.full_name).trim(),
      age: numOrNull(b.age),
      phone_number: phone,
      language: b.language || 'or',
      lmp_date: textOrNull(b.lmp_date),
      edd_date: textOrNull(b.edd_date),
      gestational_age_weeks: numOrNull(b.gestational_age_weeks),
      reference_lmp: dating.reference_lmp,
      dating_source: dating.dating_source,
      height_cm: numOrNull(b.height_cm),
      weight_kg: numOrNull(b.weight_kg),
      bmi: computeBmi(numOrNull(b.height_cm), numOrNull(b.weight_kg)),
      occupation: textOrNull(b.occupation),
      obstetric_history: textOrNull(b.obstetric_history),
      personal_history: textOrNull(b.personal_history),
      study_group: b.study_group,
      consent_given: bool(b.consent_given),
      high_risk: bool(b.high_risk),
      hearing_impairment: bool(b.hearing_impairment),
      enrolled_at: now.toISOString(),
    });
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
    reminders.generateVisits(patient, dating.reference_lmp, now);
    res.status(201).json({ ...patientView(patient, todayStr), visits: loadVisits(patient.id, todayStr) });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A patient with this registration ID already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// List patients (filters: study_group, active, q = name / reg. id / phone)
router.get('/patients', (req, res) => {
  const { study_group, active, q } = req.query;
  const where = ['1=1'];
  const params = [];
  if (study_group) { where.push('p.study_group = ?'); params.push(study_group); }
  if (active !== undefined && active !== '') { where.push('p.active = ?'); params.push(active === 'true' ? 1 : 0); }
  if (q) {
    where.push('(p.full_name LIKE ? OR p.registration_id LIKE ? OR p.phone_number LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id AND v.reminder_state = 'not_responding'
         AND v.followup_resolved_at IS NULL) AS open_followups,
      (SELECT MIN(a.due_date) FROM reminder_attempts a
         JOIN visits v ON v.id = a.visit_id
        WHERE a.patient_id = p.id AND a.status = 'scheduled' AND a.manual = 0
          AND v.reminder_state = 'pending') AS next_call_date
    FROM patients p WHERE ${where.join(' AND ')}
    ORDER BY p.enrolled_at DESC
  `).all(...params);
  const todayStr = dates.today();
  res.json(rows.map((r) => patientView(r, todayStr)));
});

// One patient with the full 7-visit timeline
router.get('/patients/:id', (req, res) => {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const todayStr = dates.today();
  res.json({ ...patientView(patient, todayStr), visits: loadVisits(patient.id, todayStr) });
});

// Update a patient. Changing dating or eligibility rebuilds the not-yet-started visits.
router.patch('/patients/:id', (req, res) => {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const b = req.body || {};
  const updates = {};

  if (b.full_name !== undefined) {
    if (!String(b.full_name).trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    updates.full_name = String(b.full_name).trim();
  }
  if (b.phone_number !== undefined) {
    const phone = normalizePhone(b.phone_number);
    if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number.' });
    updates.phone_number = phone;
  }
  if (b.language !== undefined) updates.language = b.language;
  for (const k of ['active', 'consent_given', 'high_risk', 'hearing_impairment']) {
    if (b[k] !== undefined) updates[k] = bool(b[k]);
  }
  for (const k of ['height_cm', 'weight_kg']) if (b[k] !== undefined) updates[k] = numOrNull(b[k]);
  if (updates.height_cm !== undefined || updates.weight_kg !== undefined) {
    updates.bmi = computeBmi(updates.height_cm ?? patient.height_cm, updates.weight_kg ?? patient.weight_kg);
  }

  let redate = false;
  if (['lmp_date', 'edd_date', 'gestational_age_weeks'].some((k) => b[k] !== undefined)) {
    const merged = {
      lmp_date: b.lmp_date !== undefined ? textOrNull(b.lmp_date) : patient.lmp_date,
      edd_date: b.edd_date !== undefined ? textOrNull(b.edd_date) : patient.edd_date,
      gestational_age_weeks: b.gestational_age_weeks !== undefined ? numOrNull(b.gestational_age_weeks) : patient.gestational_age_weeks,
    };
    try {
      const enrolDay = dates.today(new Date(patient.enrolled_at));
      Object.assign(updates, merged, resolveDating(merged, enrolDay));
      redate = true;
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
  }

  const eligibilityChanged = ['active', 'consent_given', 'high_risk', 'hearing_impairment']
    .some((k) => updates[k] !== undefined && updates[k] !== patient[k]);

  const cols = Object.keys(updates);
  if (cols.length) {
    db.prepare(`UPDATE patients SET ${cols.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...updates, id: patient.id });
  }
  const fresh = db.prepare('SELECT * FROM patients WHERE id = ?').get(patient.id);
  if ((redate || eligibilityChanged) && fresh.reference_lmp) reminders.generateVisits(fresh, fresh.reference_lmp);

  const todayStr = dates.today();
  res.json({ ...patientView(fresh, todayStr), visits: loadVisits(fresh.id, todayStr) });
});

// ---- Visits ------------------------------------------------------------------

// Attendance: true = attended, false = missed, null = not recorded yet
router.patch('/visits/:id', wrap(async (req, res) => {
  const { attended } = req.body || {};
  if (![true, false, null].includes(attended)) {
    return res.status(400).json({ error: 'attended must be true, false or null.' });
  }
  res.json(reminders.markAttendance(Number(req.params.id), attended));
}));

// Staff closes a "Not responding" follow-up (called / visited the patient)
router.post('/visits/:id/resolve', wrap(async (req, res) => {
  res.json(reminders.resolveFollowup(Number(req.params.id), (req.body || {}).note));
}));

router.post('/visits/:id/reopen', wrap(async (req, res) => {
  res.json(reminders.reopenFollowup(Number(req.params.id)));
}));

module.exports = router;
