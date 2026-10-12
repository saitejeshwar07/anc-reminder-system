-- ANC Voice Reminder System — schema
-- Mirrors the data points listed in the ICMR-STS 2026 proposal's
-- "Data Collection Procedures & Instruments Used" section.

CREATE TABLE IF NOT EXISTS patients (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id     TEXT UNIQUE NOT NULL,   -- hospital ANC registration number
    full_name           TEXT NOT NULL,
    age                 INTEGER,
    phone_number        TEXT NOT NULL,          -- E.164 format, e.g. +91XXXXXXXXXX
    language             TEXT DEFAULT 'or',      -- 'or' = Odia
    lmp_date            TEXT,                   -- last menstrual period (YYYY-MM-DD)
    edd_date            TEXT,                   -- expected date of delivery (YYYY-MM-DD)
    gestational_age_weeks INTEGER,               -- at registration
    height_cm           REAL,
    weight_kg           REAL,
    bmi                 REAL,
    occupation          TEXT,
    obstetric_history   TEXT,
    personal_history    TEXT,
    study_group         TEXT NOT NULL CHECK (study_group IN ('intervention','control')),
    consent_given        INTEGER NOT NULL DEFAULT 0,   -- 1 = written consent obtained
    high_risk           INTEGER NOT NULL DEFAULT 0,    -- 1 = excluded per exclusion criteria
    hearing_impairment  INTEGER NOT NULL DEFAULT 0,
    enrolled_at         TEXT DEFAULT CURRENT_TIMESTAMP,
    active              INTEGER NOT NULL DEFAULT 1     -- 0 = withdrawn / delivered / closed out
);

CREATE TABLE IF NOT EXISTS visits (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id          INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    visit_type          TEXT NOT NULL,          -- 'anc_visit' | 'investigation'
    label               TEXT NOT NULL,          -- e.g. 'ANC Visit 2', 'Ultrasound - 2nd trimester'
    scheduled_date      TEXT NOT NULL,          -- YYYY-MM-DD
    attended             INTEGER,                -- NULL = unknown yet, 1 = attended, 0 = missed
    reminder_sent       INTEGER NOT NULL DEFAULT 0,
    reminder_scheduled_for TEXT,                -- computed: scheduled_date - 48h, ISO datetime
    created_at          TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id            INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    patient_id          INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    twilio_call_sid     TEXT,
    status              TEXT NOT NULL,          -- queued | ringing | in-progress | completed | failed | no-answer | busy
    attempt_number      INTEGER NOT NULL DEFAULT 1,
    triggered_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_reminder_due ON visits(reminder_scheduled_for, reminder_sent);
CREATE INDEX IF NOT EXISTS idx_call_logs_visit ON call_logs(visit_id);
