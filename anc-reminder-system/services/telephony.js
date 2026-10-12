// Thin wrapper around Twilio so the rest of the app never touches the SDK.
// DRY_RUN=true places no real calls (useful for demos and tests).
const twilio = require('twilio');

let client = null;
let injected = false;

function env() {
  const e = process.env;
  return {
    sid: e.TWILIO_ACCOUNT_SID,
    token: e.TWILIO_AUTH_TOKEN,
    from: e.TWILIO_FROM_NUMBER,
    base: (e.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    dryRun: e.DRY_RUN === 'true',
  };
}

function isDryRun() { return env().dryRun; }

function getClient() {
  if (injected) return client;
  const { sid, token } = env();
  if (!sid || !token) return null;
  if (!client) client = twilio(sid, token);
  return client;
}

// Tests can inject a fake Twilio client.
function setClientForTests(fake) { client = fake; injected = fake !== null; }

function assertConfigured() {
  const { from, base } = env();
  if (!getClient()) {
    throw new Error('Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env (or DRY_RUN=true).');
  }
  if (!from) throw new Error('TWILIO_FROM_NUMBER is not set in .env');
  if (!base) throw new Error('PUBLIC_BASE_URL is not set in .env');
}

let dryCounter = 0;

// Place one reminder call. attemptId is echoed back on the status webhook so we
// can match the result to the attempt even before the call SID is saved.
async function placeCall({ to, attemptId }) {
  const e = env();
  if (e.dryRun) {
    return { sid: `DRYRUN-${Date.now()}-${++dryCounter}`, status: 'queued' };
  }
  assertConfigured();
  const call = await getClient().calls.create({
    to,
    from: e.from,
    url: `${e.base}/api/voice/reminder?attempt=${attemptId}`,
    method: 'POST',
    statusCallback: `${e.base}/api/voice/status?attempt=${attemptId}`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: 30, // ring for 30s before counting it as no-answer
  });
  return { sid: call.sid, status: call.status };
}

// Ask Twilio for a call's current state (used if a status webhook never arrives).
async function fetchCall(sid) {
  if (env().dryRun) return null;
  assertConfigured();
  const c = await getClient().calls(sid).fetch();
  return { status: c.status, duration: c.duration != null ? Number(c.duration) : null };
}

function validateWebhook(req) {
  const { token, base, dryRun } = env();
  if (dryRun || process.env.TWILIO_VALIDATE === 'false') return true;
  if (!token) return false;
  const signature = req.get('X-Twilio-Signature');
  if (!signature) return false;
  return twilio.validateRequest(token, signature, `${base}${req.originalUrl}`, req.body || {});
}

module.exports = { placeCall, fetchCall, isDryRun, isConfigured: () => { try { assertConfigured(); return true; } catch { return false; } }, validateWebhook, setClientForTests };
