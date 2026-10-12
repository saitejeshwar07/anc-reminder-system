const express = require('express');
const router = express.Router();
const db = require('../db');
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  PUBLIC_BASE_URL, // e.g. https://your-domain.com — must be publicly reachable by Twilio
} = process.env;

const client = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// ---- 1. TwiML: what Twilio plays when the call connects ----
// Same recording for every patient, as requested. Drop your file at
// public/audio/reminder.mp3 (or reminder_or.mp3 for Odia) and it's served statically.
router.get('/voice/reminder', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const audioUrl = `${PUBLIC_BASE_URL}/audio/reminder.mp3`;
  twiml.play(audioUrl);
  // Optional: repeat once in case the line was noisy at pickup
  twiml.pause({ length: 1 });
  twiml.play(audioUrl);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ---- 2. Twilio status callback: call progress updates land here ----
router.post('/voice/status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  db.prepare(`
    UPDATE call_logs SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE twilio_call_sid = ?
  `).run(CallStatus, CallSid);
  res.sendStatus(204);
});

// ---- 3. Trigger a single reminder call for a given visit ----
// Called by the scheduler automatically, or manually for testing.
async function triggerCallForVisit(visitId) {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) throw new Error('Visit not found');
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(visit.patient_id);
  if (!patient) throw new Error('Patient not found');

  if (!client) {
    throw new Error('Twilio is not configured. Set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER in .env');
  }

  const attemptNumber = db.prepare('SELECT COUNT(*) AS c FROM call_logs WHERE visit_id = ?').get(visitId).c + 1;

  const call = await client.calls.create({
    to: patient.phone_number,
    from: TWILIO_FROM_NUMBER,
    url: `${PUBLIC_BASE_URL}/api/voice/reminder`,
    statusCallback: `${PUBLIC_BASE_URL}/api/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });

  db.prepare(`
    INSERT INTO call_logs (visit_id, patient_id, twilio_call_sid, status, attempt_number)
    VALUES (?, ?, ?, ?, ?)
  `).run(visitId, patient.id, call.sid, call.status, attemptNumber);

  db.prepare('UPDATE visits SET reminder_sent = 1 WHERE id = ?').run(visitId);

  return call;
}

// Manual/test trigger endpoint — lets the admin fire a reminder call on demand
router.post('/visits/:id/trigger-call', async (req, res) => {
  try {
    const call = await triggerCallForVisit(req.params.id);
    res.json({ ok: true, callSid: call.sid, status: call.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = { router, triggerCallForVisit };
