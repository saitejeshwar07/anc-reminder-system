-- Migration 2: protocol-driven visits + 3-attempt reminder flow.
-- Runs once (tracked with PRAGMA user_version), so it is safe on databases
-- that were created with the original schema.

-- Dating: the LMP that all week calculations are based on. It is the entered
-- LMP, or EDD - 280 days, or (today - gestational age at registration).
ALTER TABLE patients ADD COLUMN reference_lmp TEXT;
ALTER TABLE patients ADD COLUMN dating_source TEXT;           -- 'lmp' | 'edd' | 'ga'

-- Visits now come from the 7-visit protocol (config/schedule.js).
ALTER TABLE visits ADD COLUMN visit_no INTEGER;               -- 1..7 (NULL = legacy manual row)
ALTER TABLE visits ADD COLUMN window_start_week INTEGER;
ALTER TABLE visits ADD COLUMN window_end_week INTEGER;
ALTER TABLE visits ADD COLUMN window_start_date TEXT;         -- YYYY-MM-DD
ALTER TABLE visits ADD COLUMN window_end_date TEXT;           -- YYYY-MM-DD
ALTER TABLE visits ADD COLUMN tests TEXT;                     -- JSON array of test names
-- pending | reached | not_responding | closed | skipped | not_applicable | legacy
ALTER TABLE visits ADD COLUMN reminder_state TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE visits ADD COLUMN flagged_at TEXT;                -- when it entered "Not responding"
ALTER TABLE visits ADD COLUMN followup_resolved_at TEXT;      -- staff closed the follow-up
ALTER TABLE visits ADD COLUMN followup_note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_visits_patient_visitno
    ON visits(patient_id, visit_no) WHERE visit_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visits_state ON visits(reminder_state);

-- One row per planned (or manual) call attempt. This is the source of truth
-- for the reminder flow; the old call_logs / reminder_sent columns are legacy.
CREATE TABLE IF NOT EXISTS reminder_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id        INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    attempt_no      INTEGER NOT NULL,                 -- 1..3 planned, 4+ = manual extra calls
    manual          INTEGER NOT NULL DEFAULT 0,
    due_date        TEXT NOT NULL,                    -- YYYY-MM-DD (hospital timezone)
    -- scheduled | dialing | answered | unanswered | skipped | cancelled | failed
    status          TEXT NOT NULL DEFAULT 'scheduled',
    twilio_call_sid TEXT,
    call_status     TEXT,                             -- last raw Twilio status
    duration_sec    INTEGER,
    placed_at       TEXT,                             -- ISO UTC timestamp
    placed_on       TEXT,                             -- YYYY-MM-DD, enforces 1 call/patient/day
    completed_at    TEXT,
    error_count     INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    UNIQUE (visit_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_attempts_due ON reminder_attempts(status, due_date);
CREATE INDEX IF NOT EXISTS idx_attempts_patient ON reminder_attempts(patient_id, placed_on);
CREATE INDEX IF NOT EXISTS idx_attempts_sid ON reminder_attempts(twilio_call_sid);
