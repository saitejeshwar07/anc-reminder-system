// Works out the "reference LMP" that every week calculation is based on.
// Priority: entered LMP  >  EDD - 280 days  >  gestational age at registration.
const dates = require('./dates');

const MAX_GA_DAYS = 42 * 7;

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

// input: { lmp_date, edd_date, gestational_age_weeks }
// enrolDay: YYYY-MM-DD the patient was enrolled (the gestational age field is "at registration")
function resolveDating(input, enrolDay) {
  const lmp = input.lmp_date || null;
  const edd = input.edd_date || null;
  const gaRaw = input.gestational_age_weeks;
  const ga = gaRaw === null || gaRaw === undefined || gaRaw === '' ? null : Number(gaRaw);

  let ref; let source;
  if (lmp) {
    if (!dates.isValidYmd(lmp)) throw bad('LMP date is not a valid date.');
    ref = lmp; source = 'lmp';
  } else if (edd) {
    if (!dates.isValidYmd(edd)) throw bad('EDD date is not a valid date.');
    ref = dates.addDays(edd, -280); source = 'edd';
  } else if (ga !== null) {
    if (!Number.isFinite(ga) || ga < 0 || ga > 42) throw bad('Gestational age must be between 0 and 42 weeks.');
    ref = dates.addDays(enrolDay, -Math.round(ga * 7)); source = 'ga';
  } else {
    throw bad('Enter the LMP date, the EDD, or the gestational age at registration — the visit schedule is calculated from it.');
  }

  const days = dates.diffDays(ref, enrolDay);
  if (days < 0 || days > MAX_GA_DAYS) {
    throw bad(`These dates give a gestational age of ${Math.floor(days / 7)} weeks at enrolment, which is outside 0–42 weeks. Please check the LMP / EDD.`);
  }
  return { reference_lmp: ref, dating_source: source };
}

// Accepts "+919876543210", "9876543210", "98765 43210" ...
function normalizePhone(raw) {
  const s = String(raw || '').replace(/[\s\-().]/g, '');
  if (/^[6-9]\d{9}$/.test(s)) return `+91${s}`;
  if (/^0[6-9]\d{9}$/.test(s)) return `+91${s.slice(1)}`;
  if (/^\+\d{10,15}$/.test(s)) return s;
  return null;
}

module.exports = { resolveDating, normalizePhone };
