require('dotenv').config();
const express = require('express');
const path = require('path');

const patientsRouter = require('./routes/patients');
const { router: callsRouter } = require('./routes/calls');
const scheduler = require('./scheduler');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio posts as form-encoded

// Static admin UI
app.use(express.static(path.join(__dirname, 'public')));
// Static audio files (the single recorded reminder message)
app.use('/audio', express.static(path.join(__dirname, 'audio')));

// API routes
app.use('/api', patientsRouter);
app.use('/api', callsRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ANC reminder system running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
  scheduler.start();
});
