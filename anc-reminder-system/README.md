# ANC Voice Reminder System
Backend + admin panel for the ICMR-STS 2026 study: *"Effectiveness of AI-Assisted
Voice Reminders in Improving Antenatal Follow-up..."*

Enter a patient once (with her LMP, EDD or gestational age) → the system builds her
**7-visit ANC schedule** from the hospital protocol and phones her with the recorded
reminder at the right weeks. Only **intervention** patients are called; control patients
get the same schedule for attendance tracking but are never called.

---

## 1. The hospital flow

| Visit | Weeks | Tests |
|---|---|---|
| 1 | 6–9 | HIV, HBsAg, HCV, CBC, Urine routine & microscopy, Thyroid profile, OGTT, Obstetric ultrasound |
| 2 | 10–11 | Double marker test, NT scan |
| 3 | 14–15 | — (check-up) |
| 4 | 20–22 | CBC, OGTT, Thyroid profile, Anomaly scan |
| 5 | 26–28 | — (check-up) |
| 6 | 30–32 | Growth scan |
| 7 | 34–36 | CBC, Obstetric ultrasound |

**Three calls per visit**

1. **Call 1** – first week of the window
2. **Call 2** – the next week (still inside the window)
3. **Last call** – one week *after* the window ends

Example, visit 3 (weeks 14–15): call in week 14 → call in week 15 → last call in week 16.

* She **listens** (call connected ≥ 10 s) → reminders for that visit stop.
* **All 3 calls unanswered** → the visit moves to the **Not responding** block with her
  name, phone, visit, tests and the 3 attempts. Staff contact her another way and press
  **Follow-up done** (a note is saved). If she is reached later, or attends, it closes by itself.
* Calls go out 9:00–18:00 hospital time, at most **one call per patient per day**.
* Staff can place an extra call any time with **Call now**, and record **Attended / Missed**.
* A patient enrolled when a visit window is already open is handled in person for that visit
  (no phone calls for it); calls start with the next window.

Not automated: the weekly check-ups at 37–40 weeks from the bottom of the sheet.

**To change a window or test list, edit only `config/schedule.js`.**

---

## 2. Structure

```
server.js              Express app (+ optional password gate)
scheduler.js           Runs the call sweep every 10 minutes
config/schedule.js     The 7 visits, windows, tests and call rule  <-- the protocol
services/reminders.js  The reminder engine (attempts, Not responding, attendance)
services/telephony.js  Twilio wrapper, DRY_RUN support
routes/patients.js     Enrol / update patients, attendance, follow-up actions
routes/calls.js        Twilio voice + status webhooks, "Call now", dry-run simulator
routes/reports.js      Today dashboard, Not responding list, summary, CSV export
lib/                   Date and dating helpers
migrations/            SQLite schema (applied automatically, once each)
public/                Admin panel (plain HTML/CSS/JS)
tests/flow.test.js     End-to-end test of the whole flow:  npm test
```

---

## 3. Setup

Requires Node.js 18+.

```bash
npm install
cp .env.example .env      # then fill it in
npm start                 # http://localhost:3000
```

Put your recording at `audio/reminder.mp3`. Optionally add `audio/reminder_or.mp3` (Odia),
`reminder_hi.mp3`, `reminder_en.mp3` — a patient's language file is used if it exists.

**Try it without Twilio:** set `DRY_RUN=true`, enrol a patient, press **Run calls now** on the
Today screen, then use **She answered / No answer** to see the flow.

**Existing database:** just start the app — it upgrades itself. Old manually-scheduled visits
are kept but no longer called.

---

## 4. Twilio (real calls)

1. Create a Twilio account; copy the Account SID and Auth Token into `.env`.
2. Buy a voice-capable number (enable India voice permissions) → `TWILIO_FROM_NUMBER`.
3. Twilio must reach your server: `ngrok http 3000` for testing (put the HTTPS URL in
   `PUBLIC_BASE_URL`), or a real domain in production. Restart after editing `.env`.
4. Webhooks are verified with Twilio's signature, so `PUBLIC_BASE_URL` must match the URL
   Twilio calls exactly.

---

## 5. Data & privacy

* Data is a local SQLite file (`data/anc.db`, **not** committed to git). Keep the server inside
  the hospital network and **set `ADMIN_PASSWORD`** — without it anyone who can reach the server
  can see patient data. Only `/api/voice/*` and `/audio/*` stay open (Twilio needs them).
* Back up `data/anc.db` regularly.
* **Summary → Download CSV** exports every visit with its three call results for analysis.

If `data/anc.db` was committed earlier, remove it from git (keeps your local copy):
`git rm --cached -r data`
