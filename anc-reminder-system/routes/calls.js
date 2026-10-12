const express = require('express');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const db = require('../db');
const reminders = require('../services/reminders');
const telephony = require('../services/telephony');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const AUDIO_DIR = path.join(__dirname, '..', 'audio');

// Twilio webhooks must really come from Twilio.
function requireTwilio(req, res, next) {
  if (!telephony.validateWebhook(req)) return res.status(403).type('text/plain').send('Invalid signature');
  next();
}

// ---- 1. TwiML: what Twilio plays when the patient picks up -------------------
// One recording for everyone. If audio/reminder_<lang>.mp3 exists it is used for
// patients with that language (e.g. reminder_or.mp3); otherwise audio/reminder.mp3.
router.all('/voice/reminder', requireTwilio, (req, res) => {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const attemptId = Number(req.query.attempt) || null;
  let lang = null;
  if (attemptId) {
    const row = db.prepare(`
      SELECT p.language FROM reminder_attempts a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?
    `).get(attemptId);
    lang = row && /^[a-z]{2,3}$/.test(row.language || '') ? row.language : null;
  }
  const file = [lang && `reminder_${lang}.mp3`, 'reminder.mp3']
    .filter(Boolean).find((f) => fs.existsSync(path.join(AUDIO_DIR, f)));

  const twiml = new twilio.twiml.VoiceResponse();
  if (file) {
    const url = `${base}/audio/${file}`;
    twiml.play(url);
    twiml.pause({ length: 1 });
    twiml.play(url); // repeated once in case the line was noisy at pickup
  } else {
    console.error('[voice] audio/reminder.mp3 is missing — playing a spoken fallback.');
    twiml.say('This is a reminder from the hospital for your antenatal check-up. Please visit the hospital for your tests. Thank you.');
  }
  res.type('text/xml').send(twiml.toString());
});

// ---- 2. Twilio status callback: call progress -> attempt result ---------------
router.post('/voice/status', requireTwilio, (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body || {};
  let attemptId = Number(req.query.attempt) || null;
  if (!attemptId && CallSid) {
    const a = db.prepare('SELECT id FROM reminder_attempts WHERE twilio_call_sid = ?').get(CallSid);
    attemptId = a ? a.id : null;
  }
  if (attemptId && CallStatus) {
    try {
      reminders.applyCallStatus(attemptId, {
        status: CallStatus,
        duration: CallDuration !== undefined && CallDuration !== '' ? Number(CallDuration) : null,
        sid: CallSid || null,
      });
    } catch (err) {
      console.error(`[voice] status update failed for attempt ${attemptId}: ${err.message}`);
    }
  }
  res.sendStatus(204);
});

// ---- 3. Staff actions ---------------------------------------------------------

// "Call now": an extra, manual call for one visit.
router.post('/visits/:id/call-now', wrap(async (req, res) => {
  res.json(await reminders.manualCall(Number(req.params.id)));
}));

// Dry-run only: finish a pretend call so the whole flow can be demonstrated without Twilio.
router.post('/attempts/:id/simulate', wrap(async (req, res) => {
  if (!telephony.isDryRun()) throw reminders.httpError(400, 'Simulation is only available when DRY_RUN=true.');
  const outcome = (req.body || {}).outcome;
  if (!['answered', 'unanswered'].includes(outcome)) throw reminders.httpError(400, "outcome must be 'answered' or 'unanswered'.");
  const ok = reminders.applyCallStatus(Number(req.params.id), outcome === 'answered'
    ? { status: 'completed', duration: 45 }
    : { status: 'no-answer', duration: 0 });
  if (!ok) throw reminders.httpError(409, 'That call is not in progress.');
  res.json({ ok: true });
}));

// Run the scheduler pass now (dry-run demos can also ignore calling hours).
router.post('/sweep', wrap(async (req, res) => {
  const ignoreHours = telephony.isDryRun() && (req.body || {}).ignoreHours === true;
  res.json(await reminders.runSweep({ ignoreHours }));
}));

module.exports = { router };
