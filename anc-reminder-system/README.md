# ANC Voice Reminder System
Backend + admin panel for the ICMR-STS 2026 study: *"Effectiveness of AI-Assisted
Voice Reminders in Improving Antenatal Follow-up..."*

Enter each patient's details once in the admin panel → the system automatically
places a phone call playing your recorded reminder message 48 hours before every
scheduled ANC visit or investigation, but **only for patients in the intervention
group**. Control-group patients are logged the same way but never called, so your
data stays clean for the trial's comparison.

---

## 1. What's actually happening here (no ML needed)

Since the same recorded message plays for every patient, there's no AI voice
generation involved — this is a **rules engine + telephony API**, which is simpler
and more reliable than an ML model for this job:

1. Admin enters a patient + her upcoming visit dates.
2. The server computes `reminder_time = visit_date − 48 hours` and stores it.
3. A background job checks every 30 minutes for reminders that are now due.
4. For each due reminder, it calls **Twilio's Voice API**, which dials the
   patient's number and plays your uploaded `reminder.mp3`.
5. Twilio reports back call status (answered, no-answer, failed, etc.), which
   gets logged — useful data for your "acceptability" secondary objective.

If you later want the message personalized per patient (name, date spoken aloud),
that needs Text-to-Speech — say so and this can be extended; not required for
what you asked for now.

---

## 2. Project structure

```
anc-reminder-system/
├── server.js           # Express app entry point
├── db.js                # SQLite connection + auto-migration
├── scheduler.js         # Cron job that fires due reminder calls
├── migrations/schema.sql
├── routes/
│   ├── patients.js      # Patient + visit CRUD, study summary
│   └── calls.js         # Twilio call trigger, TwiML, status webhook
├── public/               # Admin panel (plain HTML/CSS/JS, no build step)
│   ├── admin.html
│   ├── admin.css
│   └── admin.js
├── audio/
│   └── reminder.mp3     # <-- YOU add your recorded voice message here
├── .env.example
└── package.json
```

---

## 3. Local setup

Requirements: Node.js 18+, an internet connection, a Twilio account.

```bash
cd anc-reminder-system
npm install
cp .env.example .env
```

Drop your recorded message into `audio/reminder.mp3` (see `audio/README.txt`).

Fill in `.env`:
```
PUBLIC_BASE_URL=https://<your-public-url>      # see step 4
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
```

Run it:
```bash
npm start
```
Open the admin panel at **http://localhost:3000/admin.html**.

---

## 4. Setting up Twilio (real calling)

1. **Create a Twilio account** at twilio.com and verify it.
2. In the Twilio Console, grab your **Account SID** and **Auth Token**
   (Console → Account → API keys & tokens) → put these in `.env`.
3. **Buy/enable a phone number** capable of voice calls
   (Console → Phone Numbers → Buy a number). For calling Indian mobile numbers
   reliably, you may need Twilio's India voice permissions enabled, or
   consider **Exotel** instead (an India-first alternative with a very similar
   REST API — ask me and I'll swap `routes/calls.js` over to it).
4. Twilio needs to **reach your server** over the public internet to fetch the
   TwiML (`/api/voice/reminder`) and post call status (`/api/voice/status`).
   - **For testing:** run `ngrok http 3000` and put the ngrok HTTPS URL into
     `PUBLIC_BASE_URL` in `.env`.
   - **For production:** deploy this app to a server with a real domain
     (a small VPS, Render, Railway, or your institution's server) and put that
     domain in `PUBLIC_BASE_URL`.
5. Restart the server after changing `.env`.

**Test a single call without waiting for the scheduler:** in the admin panel,
open a patient with a scheduled visit and click **"Trigger now (test)"** next
to that visit — or call the API directly:
```bash
curl -X POST http://localhost:3000/api/visits/1/trigger-call
```

---

## 5. Hospital-side data captured

Matches the "Data Collection Procedures & Instruments Used" section of your
proposal: registration ID, name, age, phone, LMP/EDD, gestational age at
registration, height/weight/BMI (auto-calculated), occupation, obstetric &
personal history, study group, consent status, and exclusion flags
(high-risk pregnancy, hearing impairment). Attendance is recorded per visit
(`attended: yes/no/pending`) for your adherence analysis, and every call
attempt is logged with its outcome.

Add/remove fields in `migrations/schema.sql` and the form in `public/admin.html`
if your hospital's exact intake form differs.

---

## 6. Ethics/data handling notes (per your proposal's confidentiality section)

- Patient phone numbers and health data are stored in a local SQLite file —
  keep the server behind your institution's firewall/VPN, not open to the
  public internet beyond the two Twilio webhook endpoints.
- Restrict `/admin.html` and the `/api/*` routes with authentication before
  real deployment — this build intentionally leaves that out so you can wire
  it into your institution's existing login system. Ask if you want a basic
  password gate added.
- Export data for analysis via `GET /api/summary` or by querying
  `data/anc.db` directly (it's a standard SQLite file — importable into
  Excel via any SQLite-to-CSV tool, or opened with DB Browser for SQLite).

---

## 7. Next steps you may want

- Multi-language audio files (currently one file for all patients, as requested)
- SMS fallback if a call goes unanswered (Twilio supports this too)
- Basic login for the admin panel
- CSV export button for the study summary
