// ---------------------------------------------------------------------------
// ANC visit protocol — the ONE place that defines the 7 visits.
// Taken from the hospital's handwritten protocol sheet. If the hospital changes
// a window or a test list, edit it here; nothing else needs to change.
//
// Weeks are gestational weeks counted from LMP. A window [startWeek, endWeek]
// means the visit/tests should happen during those weeks (inclusive).
//
// Reminder call rule (same for every visit):
//   Attempt 1 : first day of the window                (start week)
//   Attempt 2 : one week later, still inside the window (start week + 1)
//               -> if the window is a single week, 3 days after attempt 1
//   Attempt 3 : LAST call, one week after the window ends (end week + 1)
//   Patient picks up and listens -> reminders for that visit stop.
//   All 3 attempts unanswered    -> patient goes to the "Not responding" list.
//
// Example (visit 3, weeks 14-15): call in week 14, call in week 15,
// final call in week 16, otherwise -> Not responding.
//
// Not automated (not part of the 7 tests): the weekly check-ups at 37, 38, 39
// and 40 weeks listed at the bottom of the protocol sheet.
// ---------------------------------------------------------------------------
const { addDays } = require('../lib/dates');

const MAX_ATTEMPTS = 3;
const SAME_WEEK_RETRY_DAYS = 3;

const VISITS = [
  {
    no: 1, startWeek: 6, endWeek: 9,
    tests: [
      'HIV', 'HBsAg', 'HCV', 'CBC', 'Urine routine & microscopy',
      'Thyroid profile', 'OGTT', 'Obstetric ultrasound',
    ],
  },
  { no: 2, startWeek: 10, endWeek: 11, tests: ['Double marker test', 'NT scan'] },
  { no: 3, startWeek: 14, endWeek: 15, tests: [] },
  { no: 4, startWeek: 20, endWeek: 22, tests: ['CBC', 'OGTT', 'Thyroid profile', 'Anomaly scan'] },
  { no: 5, startWeek: 26, endWeek: 28, tests: [] },
  { no: 6, startWeek: 30, endWeek: 32, tests: ['Growth scan'] },
  { no: 7, startWeek: 34, endWeek: 36, tests: ['CBC', 'Obstetric ultrasound'] },
];

function visitLabel(v) {
  return `ANC Visit ${v.no}`;
}

// Day offsets (from LMP) of the three call attempts for a window.
function attemptOffsets(startWeek, endWeek) {
  const a1 = startWeek * 7;
  const a2 = startWeek + 1 <= endWeek ? (startWeek + 1) * 7 : a1 + SAME_WEEK_RETRY_DAYS;
  const a3 = (endWeek + 1) * 7;
  return [a1, a2, a3];
}

// Full plan for a patient with the given LMP (YYYY-MM-DD).
function buildPlan(lmp) {
  return VISITS.map((v) => ({
    visit_no: v.no,
    label: visitLabel(v),
    tests: v.tests,
    window_start_week: v.startWeek,
    window_end_week: v.endWeek,
    window_start_date: addDays(lmp, v.startWeek * 7),
    window_end_date: addDays(lmp, v.endWeek * 7 + 6),
    attempts: attemptOffsets(v.startWeek, v.endWeek).map((off, i) => ({
      attempt_no: i + 1,
      due_date: addDays(lmp, off),
    })),
  }));
}

module.exports = { VISITS, MAX_ATTEMPTS, buildPlan, attemptOffsets, visitLabel };
