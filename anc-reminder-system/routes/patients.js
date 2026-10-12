const express = require('express');
const router = express.Router();
const db = require('../db');

function computeBmi(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const h = heightCm / 100;
  return +(weightKg / (h * h)).toFixed(1);
}

function minus48h(dateStr) {
  // dateStr: 'YYYY-MM-DD' -> ISO datetime 48h earlier, at 09:00 local time of that day
  const d = new Date(`${dateStr}T09:00:00`);
  d.setHours(d.getHours() - 48);
  return d.toISOString();
}

// ---- Patients ----

// Create patient
router.post('/patients', (req, res) => {
  const b = req.body;
  const required = ['registration_id', 'full_name', 'phone_number', 'study_group', 'consent_given'];
  for (const f of required) {
    if (b[f] === undefined || b[f] === null || b[f] === '') {
      return res.status(400).json({ error: `Missing required field: ${f}` });
    }
  }
  if (!/^\+\d{10,15}$/.test(b.phone_number)) {
    return res.status(400).json({ error: 'phone_number must be in E.164 format, e.g. +91XXXXXXXXXX' });
  }
  if (!['intervention', 'control'].includes(b.study_group)) {
    return res.status(400).json({ error: "study_group must be 'intervention' or 'control'" });
  }

  const bmi = computeBmi(b.height_cm, b.weight_kg);

  try {
    const stmt = db.prepare(`
      INSERT INTO patients (
        registration_id, full_name, age, phone_number, language,
        lmp_date, edd_date, gestational_age_weeks,
        height_cm, weight_kg, bmi, occupation, obstetric_history, personal_history,
        study_group, consent_given, high_risk, hearing_impairment
      ) VALUES (@registration_id, @full_name, @age, @phone_number, @language,
        @lmp_date, @edd_date, @gestational_age_weeks,
        @height_cm, @weight_kg, @bmi, @occupation, @obstetric_history, @personal_history,
        @study_group, @consent_given, @high_risk, @hearing_impairment)
    `);
    const info = stmt.run({
      registration_id: b.registration_id,
      full_name: b.full_name,
      age: b.age ?? null,
      phone_number: b.phone_number,
      language: b.language || 'or',
      lmp_date: b.lmp_date ?? null,
      edd_date: b.edd_date ?? null,
      gestational_age_weeks: b.gestational_age_weeks ?? null,
      height_cm: b.height_cm ?? null,
      weight_kg: b.weight_kg ?? null,
      bmi,
      occupation: b.occupation ?? null,
      obstetric_history: b.obstetric_history ?? null,
      personal_history: b.personal_history ?? null,
      study_group: b.study_group,
      consent_given: b.consent_given ? 1 : 0,
      high_risk: b.high_risk ? 1 : 0,
      hearing_impairment: b.hearing_impairment ? 1 : 0,
    });
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(patient);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A patient with this registration_id already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// List patients (with optional group filter)
router.get('/patients', (req, res) => {
  const { study_group, active } = req.query;
  let query = 'SELECT * FROM patients WHERE 1=1';
  const params = [];
  if (study_group) { query += ' AND study_group = ?'; params.push(study_group); }
  if (active !== undefined) { query += ' AND active = ?'; params.push(active === 'true' ? 1 : 0); }
  query += ' ORDER BY enrolled_at DESC';
  res.json(db.prepare(query).all(...params));
});

// Get one patient with visits + call logs
router.get('/patients/:id', (req, res) => {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const visits = db.prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY scheduled_date').all(req.params.id);
  const visitIds = visits.map(v => v.id);
  const logs = visitIds.length
    ? db.prepare(`SELECT * FROM call_logs WHERE visit_id IN (${visitIds.map(() => '?').join(',')}) ORDER BY triggered_at`).all(...visitIds)
    : [];
  res.json({ ...patient, visits, call_logs: logs });
});

// Update patient (e.g. mark withdrawn, correct a field)
router.patch('/patients/:id', (req, res) => {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const allowed = ['full_name', 'phone_number', 'language', 'active', 'consent_given', 'weight_kg', 'height_cm'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (updates.height_cm || updates.weight_kg) {
    updates.bmi = computeBmi(updates.height_cm ?? patient.height_cm, updates.weight_kg ?? patient.weight_kg);
  }
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  if (setClause) {
    db.prepare(`UPDATE patients SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.params.id });
  }
  res.json(db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id));
});

// ---- Visits ----

// Add a scheduled ANC visit or investigation for a patient
router.post('/patients/:id/visits', (req, res) => {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const { visit_type, label, scheduled_date } = req.body;
  if (!visit_type || !label || !scheduled_date) {
    return res.status(400).json({ error: 'visit_type, label and scheduled_date are required' });
  }
  if (!['anc_visit', 'investigation'].includes(visit_type)) {
    return res.status(400).json({ error: "visit_type must be 'anc_visit' or 'investigation'" });
  }

  const reminderAt = patient.study_group === 'intervention' ? minus48h(scheduled_date) : null;

  const info = db.prepare(`
    INSERT INTO visits (patient_id, visit_type, label, scheduled_date, reminder_scheduled_for)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, visit_type, label, scheduled_date, reminderAt);

  res.status(201).json(db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid));
});

// Mark a visit's attendance outcome (used for study analysis)
router.patch('/visits/:id', (req, res) => {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  const { attended } = req.body;
  db.prepare('UPDATE visits SET attended = ? WHERE id = ?').run(attended ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id));
});

// Dashboard summary — quick adherence counts for the study
router.get('/summary', (req, res) => {
  const byGroup = db.prepare(`
    SELECT p.study_group,
           COUNT(DISTINCT p.id) AS patients,
           SUM(CASE WHEN v.attended = 1 THEN 1 ELSE 0 END) AS attended,
           SUM(CASE WHEN v.attended = 0 THEN 1 ELSE 0 END) AS missed,
           SUM(CASE WHEN v.attended IS NULL THEN 1 ELSE 0 END) AS pending
    FROM patients p
    LEFT JOIN visits v ON v.patient_id = p.id
    GROUP BY p.study_group
  `).all();
  const callStats = db.prepare(`
    SELECT status, COUNT(*) AS count FROM call_logs GROUP BY status
  `).all();
  res.json({ byGroup, callStats });
});

module.exports = router;
