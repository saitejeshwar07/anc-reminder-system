require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');

const db = require('./db');
const patientsRouter = require('./routes/patients');
const { router: callsRouter } = require('./routes/calls');
const { router: reportsRouter } = require('./routes/reports');
const scheduler = require('./scheduler');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false })); // Twilio posts as form-encoded

app.get('/health', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); }
});

// Optional password gate for the admin panel + API (set ADMIN_PASSWORD in .env).
// Twilio's webhooks and the audio file stay open — Twilio can't log in.
const { ADMIN_USER = 'admin', ADMIN_PASSWORD } = process.env;
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
app.use((req, res, next) => {
  if (!ADMIN_PASSWORD || req.path.startsWith('/api/voice/') || req.path.startsWith('/audio/') || req.path === '/health') return next();
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && token) {
    const [u, ...rest] = Buffer.from(token, 'base64').toString().split(':');
    if (safeEq(u, ADMIN_USER) && safeEq(rest.join(':'), ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="ANC Reminder Admin"').status(401).send('Login required');
});

app.get('/', (req, res) => res.redirect('/admin.html'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

app.use('/api', patientsRouter);
app.use('/api', callsRouter);
app.use('/api', reportsRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`ANC reminder system running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
    if (!ADMIN_PASSWORD) console.warn('[security] ADMIN_PASSWORD is not set — the admin panel and patient data are open to anyone who can reach this server.');
    if (process.env.DRY_RUN === 'true') console.warn('[telephony] DRY_RUN=true — no real calls will be placed.');
    scheduler.start();
  });
  const shutdown = () => { scheduler.stop(); server.close(() => { db.close(); process.exit(0); }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
