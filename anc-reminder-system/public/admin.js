const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentPatientId = null;

// ---- Tabs ----
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'registry') loadRegistry();
    if (btn.dataset.tab === 'summary') loadSummary();
  });
});

// ---- Enroll patient ----
$('#patient-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = $('#enroll-status');
  statusEl.textContent = 'Saving...';
  statusEl.className = 'status-msg';

  const payload = {
    registration_id: $('#registration_id').value.trim(),
    full_name: $('#full_name').value.trim(),
    age: $('#age').value ? Number($('#age').value) : null,
    phone_number: $('#phone_number').value.trim(),
    language: $('#language').value,
    study_group: $('#study_group').value,
    lmp_date: $('#lmp_date').value || null,
    edd_date: $('#edd_date').value || null,
    gestational_age_weeks: $('#gestational_age_weeks').value ? Number($('#gestational_age_weeks').value) : null,
    height_cm: $('#height_cm').value ? Number($('#height_cm').value) : null,
    weight_kg: $('#weight_kg').value ? Number($('#weight_kg').value) : null,
    occupation: $('#occupation').value.trim(),
    obstetric_history: $('#obstetric_history').value.trim(),
    personal_history: $('#personal_history').value.trim(),
    consent_given: $('#consent_given').checked,
    high_risk: $('#high_risk').checked,
    hearing_impairment: $('#hearing_impairment').checked,
  };

  try {
    const res = await fetch('/api/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to enroll patient');

    statusEl.textContent = `Enrolled ${data.full_name} (ID ${data.id}).`;
    statusEl.className = 'status-msg ok';
    currentPatientId = data.id;
    $('#visit-patient-name').textContent = data.full_name;
    $('#visit-card').style.display = 'block';
    loadVisits(data.id);
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'status-msg error';
  }
});

// ---- Schedule visits ----
$('#visit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentPatientId) return;
  const payload = {
    visit_type: $('#visit_type').value,
    label: $('#visit_label').value.trim(),
    scheduled_date: $('#scheduled_date').value,
  };
  const res = await fetch(`/api/patients/${currentPatientId}/visits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    $('#visit-form').reset();
    loadVisits(currentPatientId);
  } else {
    const data = await res.json();
    alert(data.error || 'Failed to add visit');
  }
});

async function loadVisits(patientId) {
  const res = await fetch(`/api/patients/${patientId}`);
  const patient = await res.json();
  const tbody = $('#visit-table tbody');
  tbody.innerHTML = '';
  patient.visits.forEach(v => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${v.visit_type === 'anc_visit' ? 'ANC visit' : 'Investigation'}</td>
      <td>${v.label}</td>
      <td>${v.scheduled_date}</td>
      <td>${v.reminder_scheduled_for ? new Date(v.reminder_scheduled_for).toLocaleString() : '—'}</td>
      <td>${v.reminder_sent ? 'Yes' : 'No'}</td>
      <td>${v.reminder_scheduled_for ? `<button class="link-btn" data-visit="${v.id}">Trigger now (test)</button>` : ''}</td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-visit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = 'Calling...';
      const r = await fetch(`/api/visits/${btn.dataset.visit}/trigger-call`, { method: 'POST' });
      const d = await r.json();
      btn.textContent = r.ok ? `Sent (${d.status})` : `Error: ${d.error}`;
    });
  });
}

// ---- Registry ----
async function loadRegistry() {
  const group = $('#filter-group').value;
  const res = await fetch(`/api/patients${group ? `?study_group=${group}` : ''}`);
  const patients = await res.json();
  const tbody = $('#registry-body');
  tbody.innerHTML = '';
  patients.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.registration_id}</td>
      <td>${p.full_name}</td>
      <td>${p.phone_number}</td>
      <td><span class="pill ${p.study_group}">${p.study_group}</span></td>
      <td>${p.consent_given ? '✓' : '—'}</td>
      <td>${new Date(p.enrolled_at).toLocaleDateString()}</td>
      <td><button class="link-btn" data-open="${p.id}">Open</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPatientId = Number(btn.dataset.open);
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      $('.tab-btn[data-tab="enroll"]').classList.add('active');
      $('#tab-enroll').classList.add('active');
      $('#visit-card').style.display = 'block';
      const p = patients.find(x => x.id === currentPatientId);
      $('#visit-patient-name').textContent = p ? p.full_name : '';
      loadVisits(currentPatientId);
    });
  });
}
$('#filter-group').addEventListener('change', loadRegistry);

// ---- Summary ----
async function loadSummary() {
  const res = await fetch('/api/summary');
  const data = await res.json();
  const body = $('#summary-table tbody');
  body.innerHTML = '';
  data.byGroup.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.study_group}</td><td>${row.patients}</td><td>${row.attended || 0}</td><td>${row.missed || 0}</td><td>${row.pending || 0}</td>`;
    body.appendChild(tr);
  });
  const callBody = $('#call-summary-table tbody');
  callBody.innerHTML = '';
  data.callStats.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.status}</td><td>${row.count}</td>`;
    callBody.appendChild(tr);
  });
}
