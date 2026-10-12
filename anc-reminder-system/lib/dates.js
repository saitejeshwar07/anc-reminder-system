// Date helpers. All "calendar day" logic runs in the hospital's timezone
// (default Asia/Kolkata) so reminders never drift by a day because the server
// happens to be in UTC. Dates are plain 'YYYY-MM-DD' strings.

const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidYmd(s) {
  if (typeof s !== 'string') return false;
  const m = YMD.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUtcDate(ymd) {
  const m = YMD.exec(ymd);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function fromUtcDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  const d = toUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtcDate(d);
}

// whole days from a to b (b - a)
function diffDays(a, b) {
  return Math.round((toUtcDate(b) - toUtcDate(a)) / 86400000);
}

// Calendar date + clock hour in the hospital timezone for a given instant.
function nowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function today(now = new Date()) {
  return nowParts(now).date;
}

// Gestational age on a given date, from LMP.
function gestationalAge(lmp, onDate) {
  const totalDays = diffDays(lmp, onDate);
  return { totalDays, weeks: Math.floor(totalDays / 7), days: ((totalDays % 7) + 7) % 7 };
}

module.exports = {
  TIMEZONE, isValidYmd, addDays, diffDays, nowParts, today, gestationalAge,
};
