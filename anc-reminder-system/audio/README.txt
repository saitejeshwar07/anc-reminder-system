Place your recorded reminder audio here as: reminder.mp3

This is the SAME recording that will be played to every patient in the
intervention group. Requirements:
- Format: MP3 (or WAV)
- Keep it short (30-60 seconds is typical for a reminder)
- Recorded in Odia (or update routes/calls.js to point to a different
  language file per patient if you later add multi-language support)

The file is served automatically at:
  {PUBLIC_BASE_URL}/audio/reminder.mp3
and Twilio fetches it directly when placing each call.
