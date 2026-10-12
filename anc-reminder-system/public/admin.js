const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let CONFIG = { dryRun: false, today: '' };
let openPatientId = null;

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message, 'error'); }
}

// ---- date helpers (dates are plain YYYY-MM-DD strings) -----------------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
}
const fmtWeeks = (a, b) => (a === b ? `Week ${a}` : `Weeks ${a}–${b}`);
const ga = (p) => (p.ga_weeks === null || p.ga_weeks === undefined ? '—' : `${p.ga_weeks}w ${p.ga_days}d`);

// ---- tabs ---------------------------------------------------------------------
function showTab(name) {
  $$('.tab-btn').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  ({ dashboard: loadDashboard, notresp: loadNotResponding, registry: loadRegistry, summary: loadSummary }[name] || (() => {}))();
}
$$('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- Today ----------------------------------------------------------------------
async function loadDashboard() {
  const d = await run(() => api('GET', '/dashboard'));
  if (!d) return;
  setBadge(d.open_followups);
  const stat = (n, label, cls = '') => `<div class="stat ${cls}"><div class="stat-n">${n}</div><div class="stat-l">${label}</div></div>`;
  $('#stat-row').innerHTML =
    stat(d.patients.intervention, 'Intervention patients') +
    stat(d.patients.control, 'Control patients') +
    stat(d.due_today.length, 'Calls due today') +
    stat(`${d.calls_today.answered}<small>/${d.calls_today.placed}</small>`, 'Answered today') +
    stat(d.open_followups, 'Need follow-up', d.open_followups ? 'alert' : '');

  const dialing = d.in_progress.map((a) => `
    <li class="row"><div><strong>${esc(a.full_name)}</strong><span class="muted"> · ${esc(a.label)}${a.manual ? ' · manual call' : `, call ${a.attempt_no}`}</span></div>
      ${CONFIG.dryRun ? `<div class="btn-group"><button class="chip-btn ok" data-sim="answered" data-id="${a.id}">She answered</button><button class="chip-btn" data-sim="unanswered" data-id="${a.id}">No answer</button></div>` : '<span class="pill calling">Calling…</span>'}
    </li>`).join('');
  const due = d.due_today.map((a) => `
    <li class="row"><div><strong>${esc(a.full_name)}</strong><span class="muted"> · ${esc(a.label)}, call ${a.attempt_no} of 3</span></div><span class="pill upcoming">Waiting</span></li>`).join('');
  $('#due-today').innerHTML = (dialing || due) ? `<ul class="list">${dialing}${due}</ul>` : '<p class="empty">No calls due right now.</p>';

  $('#upcoming').innerHTML = d.upcoming.length
    ? `<ul class="list">${d.upcoming.map((a) => `
      <li class="row"><div><strong>${esc(a.full_name)}</strong><span class="muted"> · ${esc(a.label)}, call ${a.attempt_no}</span></div><span class="muted">${fmtDate(a.due_date)}</span></li>`).join('')}</ul>`
    : '<p class="empty">Nothing scheduled in the next 14 days.</p>';
}

$('#sweep-btn').addEventListener('click', () => run(async () => {
  const r = await api('POST', '/sweep', { ignoreHours: CONFIG.dryRun });
  toast(r.skipped ? (r.skipped === 'outside-calling-hours' ? 'Outside calling hours — calls will go out during the day.' : 'A call round is already running.') : `${r.placed} call(s) placed.`);
  loadDashboard();
}));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sim]');
  if (!b) return;
  run(async () => { await api('POST', `/attempts/${b.dataset.id}/simulate`, { outcome: b.dataset.sim }); toast('Call result recorded.'); refreshAll(); });
});

async function loadProtocol() {
  const p = await run(() => api('GET', '/protocol'));
  if (!p) return;
  $('#protocol').innerHTML = p.visits.map((v) => `
    <div class="proto-row"><span class="proto-no">${v.no}</span>
      <div><strong>${fmtWeeks(v.startWeek, v.endWeek)}</strong>
        <div class="chips">${v.tests.length ? v.tests.map((t) => `<span class="chip">${esc(t)}</span>`).join('') : '<span class="muted">Check-up visit</span>'}</div></div>
      <div class="muted small">Calls: wk ${v.startWeek}${v.startWeek + 1 <= v.endWeek ? `, wk ${v.startWeek + 1}` : ''}, final wk ${v.endWeek + 1}</div></div>`).join('');
}

// ---- Not responding ---------------------------------------------------------------
function setBadge(n) { const b = $('#nr-badge'); b.textContent = n; b.hidden = !n; }

async function loadNotResponding() {
  const rows = await run(() => api('GET', `/not-responding?resolved=${$('#nr-resolved').checked}`));
  if (!rows) return;
  setBadge(rows.filter((r) => !r.followup_resolved_at).length);
  $('#nr-list').innerHTML = rows.length ? rows.map((r) => `
    <article class="nr-card ${r.followup_resolved_at ? 'done' : ''}">
      <div class="nr-main">
        <div><button class="link-btn strong" data-open="${r.patient_id}">${esc(r.full_name)}</button>
          <span class="muted"> · ${esc(r.registration_id)}</span></div>
        <div class="nr-phone"><a href="tel:${esc(r.phone_number)}">${esc(r.phone_number)}</a></div>
        <div><strong>${esc(r.label)}</strong> <span class="muted">(${fmtWeeks(r.window_start_week, r.window_end_week)} · now ${r.ga_weeks ?? '—'} wks)</span></div>
        <div class="chips">${r.tests.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        ${attemptDots(r.attempts)}
        <div class="muted small">${r.followup_resolved_at ? `Done: ${esc(r.followup_note || '')}` : `Flagged ${fmtDate(r.flagged_at)} · waiting ${r.days_waiting} day(s)`}</div>
      </div>
      <div class="nr-actions">
        ${r.followup_resolved_at
          ? `<button class="btn-secondary" data-reopen="${r.id}">Reopen</button>`
          : `<button class="btn-primary" data-resolve="${r.id}">Follow-up done</button>
             <button class="btn-secondary" data-callnow="${r.id}">Call again</button>`}
      </div>
    </article>`).join('') : '<p class="empty">Nobody is waiting for follow-up. 🎉</p>';
}
$('#nr-resolved').addEventListener('change', loadNotResponding);

function attemptDots(attempts) {
  const planned = attempts.filter((a) => !a.manual);
  const manual = attempts.filter((a) => a.manual);
  const lbl = { answered: 'Answered', unanswered: 'No answer', dialing: 'Calling', scheduled: 'Scheduled', skipped: 'Skipped', cancelled: 'Not needed', failed: 'Failed' };
  const one = (a, i) => `<div class="att ${a.status}"><span class="att-dot"></span><div><div class="att-t">${a.manual ? 'Extra call' : `Call ${i + 1}`}</div>
    <div class="att-s">${lbl[a.status] || a.status}</div><div class="att-d">${fmtDate(a.due_date)}</div></div></div>`;
  return `<div class="attempts">${planned.map(one).join('')}${manual.map(one).join('')}</div>`;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.open) openPatient(Number(t.dataset.open));
  if (t.dataset.resolve) {
    const note = prompt('Short note (e.g. "Phoned husband, will visit Monday"):', '');
    if (note === null) return;
    run(async () => { await api('POST', `/visits/${t.dataset.resolve}/resolve`, { note }); toast('Follow-up marked done.'); refreshAll(); });
  }
  if (t.dataset.reopen) run(async () => { await api('POST', `/visits/${t.dataset.reopen}/reopen`); refreshAll(); });
  if (t.dataset.callnow) {
    if (!confirm('Place an extra reminder call to this patient now?')) return;
    run(async () => { await api('POST', `/visits/${t.dataset.callnow}/call-now`); toast('Call placed.'); refreshAll(); });
  }
  if (t.dataset.attend !== undefined) {
    const val = t.dataset.attend === 'null' ? null : t.dataset.attend === 'true';
    run(async () => { await api('PATCH', `/visits/${t.dataset.visit}`, { attended: val }); refreshAll(); });
  }
});

// ---- Registry ---------------------------------------------------------------------------
let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadRegistry, 250); });
$('#filter-group').addEventListener('change', loadRegistry);

async function loadRegistry() {
  const q = new URLSearchParams();
  if ($('#filter-group').value) q.set('study_group', $('#filter-group').value);
  if ($('#search').value.trim()) q.set('q', $('#search').value.trim());
  const rows = await run(() => api('GET', `/patients?${q}`));
  if (!rows) return;
  $('#registry-empty').hidden = rows.length > 0;
  $('#registry-body').innerHTML = rows.map((p) => `
    <tr class="${p.active ? '' : 'inactive'}">
      <td>${esc(p.registration_id)}</td>
      <td><button class="link-btn strong" data-open="${p.id}">${esc(p.full_name)}</button>
        ${p.open_followups ? `<span class="pill alert">Follow-up</span>` : ''}${p.active ? '' : '<span class="pill muted">Closed</span>'}</td>
      <td>${esc(p.phone_number)}</td>
      <td><span class="pill ${p.study_group}">${p.study_group}</span></td>
      <td>${ga(p)}</td>
      <td>${p.study_group === 'control' ? '<span class="muted">—</span>' : fmtDate(p.next_call_date)}</td>
      <td><button class="btn-secondary small" data-open="${p.id}">Open</button></td>
    </tr>`).join('');
}

// ---- Patient dialog ---------------------------------------------------------------------
const STATUS = {
  attended: ['Attended', 'ok'], missed: ['Missed', 'alert'], not_responding: ['Not responding', 'alert'],
  followed_up: ['Follow-up done', 'ok'], reached: ['Reminder heard', 'ok'], calling: ['Calling', 'calling'],
  upcoming: ['Upcoming', 'upcoming'], skipped: ['Handled at enrolment', 'muted'], due_now: ['Due now', 'calling'], overdue: ['Past window', 'muted'],
};

async function openPatient(id) {
  openPatientId = id;
  const p = await run(() => api('GET', `/patients/${id}`));
  if (!p) return;
  renderPatient(p);
  const dlg = $('#patient-dialog');
  if (!dlg.open) dlg.showModal();
}

function renderPatient(p) {
  $('#pd-title').textContent = p.full_name;
  $('#pd-sub').textContent = `${p.registration_id} · ${p.phone_number} · ${p.study_group}`;
  const src = { lmp: 'LMP', edd: 'EDD', ga: 'gestation at registration' }[p.dating_source] || '';
  const callable = p.study_group === 'intervention' && p.consent_given && p.active && !p.high_risk && !p.hearing_impairment;
  $('#pd-body').innerHTML = `
    <div class="pd-facts">
      <div><span class="muted">Gestation today</span><strong>${ga(p)}</strong></div>
      <div><span class="muted">Dated from</span><strong>${esc(src)}</strong></div>
      <div><span class="muted">Expected delivery</span><strong>${fmtDate(p.expected_delivery)}</strong></div>
      <div><span class="muted">Reminder calls</span><strong>${callable ? 'On' : 'Off'}</strong></div>
    </div>
    ${!callable && p.study_group === 'intervention' ? `<p class="notice">Calls are off: ${[!p.consent_given && 'no consent', !p.active && 'case closed', p.high_risk && 'high-risk exclusion', p.hearing_impairment && 'hearing impairment'].filter(Boolean).join(', ')}.</p>` : ''}
    <div class="timeline">${p.visits.map(visitCard).join('')}</div>
    <div class="dialog-foot">
      <button class="btn-secondary" id="pd-toggle">${p.active ? 'Close case (delivered / withdrawn)' : 'Reopen case'}</button>
    </div>`;
  $('#pd-toggle').onclick = () => {
    if (p.active && !confirm('Close this case? No more reminder calls will be made.')) return;
    run(async () => { await api('PATCH', `/patients/${p.id}`, { active: !p.active }); refreshAll(); });
  };
}

function visitCard(v) {
  const [label, cls] = STATUS[v.status] || [v.status, 'muted'];
  const inProgress = v.attempts.find((a) => a.status === 'dialing');
  const canCall = !['not_applicable', 'legacy'].includes(v.reminder_state) && v.attended !== 1 && !inProgress;
  return `
    <section class="visit ${v.status}">
      <header><div><span class="v-no">${v.visit_no ?? '•'}</span><strong>${esc(v.label)}</strong>
        <span class="muted"> · ${fmtWeeks(v.window_start_week, v.window_end_week)} · ${fmtDate(v.window_start_date)} – ${fmtDate(v.window_end_date)}</span></div>
        <span class="pill ${cls}">${label}</span></header>
      <div class="chips">${v.tests.length ? v.tests.map((t) => `<span class="chip">${esc(t)}</span>`).join('') : '<span class="muted small">Routine check-up</span>'}</div>
      ${v.attempts.length ? attemptDots(v.attempts) : ''}
      ${inProgress && CONFIG.dryRun ? `<div class="btn-group"><span class="muted small">Dry run:</span><button class="chip-btn ok" data-sim="answered" data-id="${inProgress.id}">She answered</button><button class="chip-btn" data-sim="unanswered" data-id="${inProgress.id}">No answer</button></div>` : ''}
      <div class="visit-actions">
        <span class="muted small">Attendance:</span>
        <button class="chip-btn ${v.attended === 1 ? 'ok on' : ''}" data-visit="${v.id}" data-attend="${v.attended === 1 ? 'null' : 'true'}">Attended</button>
        <button class="chip-btn ${v.attended === 0 ? 'bad on' : ''}" data-visit="${v.id}" data-attend="${v.attended === 0 ? 'null' : 'false'}">Missed</button>
        ${canCall ? `<button class="chip-btn" data-callnow="${v.id}">Call now</button>` : ''}
      </div>
    </section>`;
}
$('#pd-close').addEventListener('click', () => $('#patient-dialog').close());
$('#patient-dialog').addEventListener('click', (e) => { if (e.target.id === 'patient-dialog') e.target.close(); });
$('#patient-dialog').addEventListener('close', () => { openPatientId = null; });

// ---- Enroll -------------------------------------------------------------------------------
function updateDatingPreview() {
  const lmp = $('#lmp_date').value; const edd = $('#edd_date').value; const g = $('#gestational_age_weeks').value;
  const el = $('#dating-preview');
  const t = new Date(`${CONFIG.today || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  let ref = null; let src = '';
  if (lmp) { ref = new Date(`${lmp}T00:00:00Z`); src = 'LMP'; }
  else if (edd) { ref = new Date(new Date(`${edd}T00:00:00Z`).getTime() - 280 * 864e5); src = 'EDD'; }
  else if (g !== '') { ref = new Date(t.getTime() - Number(g) * 7 * 864e5); src = 'gestation'; }
  if (!ref) { el.textContent = 'The visit schedule is worked out from this. LMP is used first, then EDD, then gestation.'; el.className = 'hint'; return; }
  const days = Math.round((t - ref) / 864e5);
  const bad = days < 0 || days > 294;
  el.textContent = bad ? `That gives ${Math.floor(days / 7)} weeks — please check the date.` : `Using ${src}: she is ${Math.floor(days / 7)} weeks ${days % 7} days pregnant today.`;
  el.className = bad ? 'hint error' : 'hint ok';
}
['lmp_date', 'edd_date', 'gestational_age_weeks'].forEach((id) => $(`#${id}`).addEventListener('input', updateDatingPreview));

$('#patient-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('#enroll-status');
  const v = (id) => $(`#${id}`).value.trim();
  const n = (id) => (v(id) === '' ? null : Number(v(id)));
  const payload = {
    registration_id: v('registration_id'), full_name: v('full_name'), age: n('age'), phone_number: v('phone_number'),
    language: v('language'), study_group: v('study_group'),
    lmp_date: v('lmp_date') || null, edd_date: v('edd_date') || null, gestational_age_weeks: n('gestational_age_weeks'),
    height_cm: n('height_cm'), weight_kg: n('weight_kg'), occupation: v('occupation'),
    obstetric_history: v('obstetric_history'), personal_history: v('personal_history'),
    consent_given: $('#consent_given').checked, high_risk: $('#high_risk').checked, hearing_impairment: $('#hearing_impairment').checked,
  };
  const missing = [['registration_id', 'Registration ID'], ['full_name', 'Name'], ['phone_number', 'Mobile number']].find(([k]) => !payload[k]);
  if (missing) { st.textContent = `${missing[1]} is required.`; st.className = 'status-msg error'; return; }
  st.textContent = 'Saving…'; st.className = 'status-msg';
  try {
    const p = await api('POST', '/patients', payload);
    st.textContent = `Enrolled ${p.full_name}.`; st.className = 'status-msg ok';
    e.target.reset(); updateDatingPreview();
    toast(`Enrolled ${p.full_name} — visit schedule created.`);
    openPatient(p.id);
  } catch (err) { st.textContent = err.message; st.className = 'status-msg error'; }
});

// ---- Summary -------------------------------------------------------------------------------
async function loadSummary() {
  const d = await run(() => api('GET', '/summary'));
  if (!d) return;
  $('#summary-table tbody').innerHTML = d.byGroup.map((r) => `<tr><td><span class="pill ${r.study_group}">${r.study_group}</span></td><td>${r.patients}</td><td>${r.attended || 0}</td><td>${r.missed || 0}</td><td>${r.pending || 0}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No data yet.</td></tr>';
  const names = { reached: 'Heard the reminder', not_responding: 'Not responding', pending: 'Still in progress', closed: 'Attended before call' };
  $('#flow-table tbody').innerHTML = d.flow.map((r) => `<tr><td>${names[r.state] || r.state}</td><td>${r.count}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">No calls yet.</td></tr>';
  $('#attempt-table tbody').innerHTML = d.byAttempt.map((r) => `<tr><td>Call ${r.attempt_no}</td><td>${r.placed}</td><td>${r.answered || 0}${r.placed ? ` <span class="muted">(${Math.round(100 * (r.answered || 0) / r.placed)}%)</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No calls yet.</td></tr>';
}

// ---- boot -----------------------------------------------------------------------------------------
function refreshAll() {
  const active = $('.tab-btn.active').dataset.tab;
  showTab(active);
  if (openPatientId) openPatient(openPatientId);
  else loadBadge();
}
async function loadBadge() {
  const r = await api('GET', '/not-responding').catch(() => null);
  if (r) setBadge(r.length);
}

(async function init() {
  try { CONFIG = await api('GET', '/config'); } catch { /* banner stays hidden */ }
  const b = $('#env-banner');
  if (CONFIG.dryRun) { b.hidden = false; b.className = 'env-banner demo'; b.textContent = 'Demo mode (DRY_RUN): no real calls are placed. Use the “She answered / No answer” buttons to test the flow.'; }
  else if (CONFIG.twilioConfigured === false) { b.hidden = false; b.className = 'env-banner warn'; b.textContent = 'Twilio is not configured yet — reminder calls cannot be placed. See README step 4.'; }
  updateDatingPreview();
  loadProtocol();
  loadDashboard();
  loadBadge();
  setInterval(() => { if (document.visibilityState === 'visible' && $('#tab-dashboard').classList.contains('active')) loadDashboard(); }, 30000);
})();
