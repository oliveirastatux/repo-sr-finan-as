const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'plantao.adminToken';
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const STATUS_LABEL = {
  assigned: ['ok', 'Distribuído'],
  dry_run: ['warn', 'Simulado'],
  fallback: ['warn', 'Reserva (ninguém apto)'],
  pending: ['warn', 'Enviando'],
  error: ['err', 'Erro'],
};

let token = sessionGet();
let brokers = [];
let overviewTimer = null;

function sessionGet() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function sessionSet(v) {
  try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignora */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/api/admin/login') {
    logout();
    throw new Error('Sessão expirada.');
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha na requisição.');
  return data;
}

// ---------------- login ----------------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token: t } = await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    token = t;
    sessionSet(t);
    start();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  }
});

function logout() {
  token = '';
  sessionSet('');
  clearInterval(overviewTimer);
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}
$('logout').addEventListener('click', logout);

// ---------------- abas ----------------
document.querySelectorAll('[role=tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab));
    if (btn.dataset.tab === 'report') loadReport();
    if (btn.dataset.tab === 'schedule') loadSchedule();
    if (btn.dataset.tab === 'brokers') loadBrokers();
  });
});

// ---------------- AGORA ----------------
async function loadOverview() {
  const o = await api('/api/admin/overview');
  $('dry-run').classList.toggle('hidden', !o.rdDryRun);
  $('now-time').textContent = o.localTime;
  $('now-window').textContent = o.open
    ? `Check-in ${o.open.label} aberto até ${o.open.checkinEnd}`
    : o.next ? `Próximo check-in: ${o.next.label} às ${o.next.checkinStart}` : 'Sem janela de check-in hoje';
  $('now-eligible').textContent = o.eligibleIds.length;
  $('now-shift').textContent = o.eligibleShift ? `Turno ${o.eligibleShift.label} · até ${o.eligibleShift.eligibleUntil}` : 'Fora de turno';
  $('now-leads').textContent = o.leadsToday;

  const eligible = new Set(o.eligibleIds);
  $('now-shifts').innerHTML = o.shifts.map((sh) => `
    <div class="card">
      <h2 style="margin-top:0">${esc(sh.label)} <span class="muted" style="font-size:14px">${esc(sh.checkinStart)}–${esc(sh.checkinEnd)} · apto até ${esc(sh.eligibleUntil)}</span></h2>
      ${sh.roster.length ? `<table><thead><tr><th>Hora</th><th>Corretor</th><th>Gerente</th><th>Leads</th><th></th></tr></thead><tbody>
        ${sh.roster.map((r) => `<tr>
          <td>${esc(r.local_time)}${r.method === 'manual' ? ' <span class="badge warn">manual</span>' : ''}</td>
          <td>${esc(r.name)} ${eligible.has(r.broker_id) && o.eligibleShift?.id === sh.id ? '<span class="badge ok">apto</span>' : ''}${!r.rd_user_id ? ' <span class="badge err" title="Sem ID do RD: não recebe leads">sem RD</span>' : ''}</td>
          <td>${esc(r.manager_name)}</td><td>${r.leads_in_shift}</td>
          <td><button class="danger" data-del-checkin="${r.checkin_id}" title="Remover check-in">✕</button></td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">Nenhum check-in ainda.</p>'}
    </div>`).join('');

  $('leads-body').innerHTML = o.leads.map((l) => {
    const [cls, label] = STATUS_LABEL[l.status] || ['warn', l.status];
    const at = new Date(l.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<tr><td>${esc(at)}</td><td>${esc(l.rd_deal_id)}</td><td>${esc(l.broker_name || '—')}</td>
      <td><span class="badge ${cls}" title="${esc(l.error || '')}">${esc(label)}</span></td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">Nenhum lead ainda.</td></tr>';
}

$('now-shifts').addEventListener('click', async (e) => {
  const id = e.target.dataset.delCheckin;
  if (!id || !confirm('Remover este check-in? O corretor deixa de receber leads neste turno.')) return;
  try { await api(`/api/admin/checkins/${id}`, { method: 'DELETE' }); await loadOverview(); } catch (err) { toast(err.message); }
});

$('simulate').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/leads/simulate', { method: 'POST' });
    toast(r.lead.broker_id ? 'Lead simulado distribuído.' : `Lead simulado: ${r.lead.error || 'enviado ao responsável reserva'}`);
    await loadOverview();
  } catch (err) { toast(err.message); }
});

$('manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/admin/checkins/manual', {
      method: 'POST',
      body: { brokerId: Number($('manual-broker').value), note: $('manual-note').value },
    });
    toast(r.alreadyCheckedIn ? `${r.broker.name} já estava no plantão.` : `Check-in de ${r.broker.name} registrado.`);
    $('manual-note').value = '';
    await loadOverview();
  } catch (err) { toast(err.message); }
});

// ---------------- CORRETORES ----------------
async function loadBrokers() {
  brokers = await api('/api/admin/brokers');
  $('manual-broker').innerHTML = brokers.filter((b) => b.active).map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $('brokers-body').innerHTML = brokers.map((b) => `<tr>
    <td>${esc(b.name)}<div class="muted" style="font-size:12px">${esc(b.email || '')}</div></td>
    <td>${esc(b.manager_name)}</td>
    <td>${b.rd_user_id ? esc(b.rd_user_id) : '<span class="badge err">faltando</span>'}</td>
    <td>${b.face_samples ? `<span class="badge ok">${b.face_samples} amostras</span>` : '<span class="badge warn">sem cadastro</span>'}</td>
    <td>${b.active ? '<span class="badge ok">ativo</span>' : '<span class="badge err">inativo</span>'}</td>
    <td style="white-space:nowrap">
      <button data-edit="${b.id}">Editar</button>
      <button data-face="${b.id}">Rosto</button>
      ${b.face_samples ? `<button class="danger" data-unface="${b.id}" title="Apagar biometria">Apagar rosto</button>` : ''}
    </td></tr>`).join('') || '<tr><td colspan="6" class="muted">Cadastre o primeiro corretor acima.</td></tr>';
}

function resetBrokerForm() {
  $('broker-form').reset();
  $('broker-id').value = '';
  $('broker-active').checked = true;
  $('broker-form-title').textContent = 'Novo corretor';
  $('broker-cancel').classList.add('hidden');
}
$('broker-cancel').addEventListener('click', resetBrokerForm);

$('broker-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('broker-id').value;
  const body = {
    name: $('broker-name').value,
    email: $('broker-email').value,
    manager_name: $('broker-manager').value,
    rd_user_id: $('broker-rd').value,
    active: $('broker-active').checked,
  };
  try {
    await api(id ? `/api/admin/brokers/${id}` : '/api/admin/brokers', { method: id ? 'PUT' : 'POST', body });
    toast('Corretor salvo.');
    resetBrokerForm();
    await loadBrokers();
  } catch (err) { toast(err.message); }
});

$('brokers-body').addEventListener('click', async (e) => {
  const { edit, face, unface } = e.target.dataset;
  if (edit) {
    const b = brokers.find((x) => x.id === Number(edit));
    $('broker-id').value = b.id;
    $('broker-name').value = b.name;
    $('broker-email').value = b.email || '';
    $('broker-manager').value = b.manager_name;
    $('broker-rd').value = b.rd_user_id || '';
    $('broker-active').checked = b.active;
    $('broker-form-title').textContent = `Editar: ${b.name}`;
    $('broker-cancel').classList.remove('hidden');
    $('broker-name').focus();
  }
  if (face) openFaceDialog(brokers.find((x) => x.id === Number(face)));
  if (unface && confirm('Apagar a biometria deste corretor? Ele precisará ser cadastrado de novo.')) {
    try { await api(`/api/admin/brokers/${unface}/face`, { method: 'DELETE' }); await loadBrokers(); } catch (err) { toast(err.message); }
  }
});

// Cadastro facial: carrega o módulo só quando necessário.
let stopCamera = null;
async function openFaceDialog(broker) {
  const dlg = $('face-dialog');
  $('face-name').textContent = broker.name;
  $('face-consent').checked = false;
  $('face-capture').disabled = true;
  $('face-hint').textContent = 'Carregando câmera e modelos…';
  dlg.showModal();
  dlg.dataset.brokerId = broker.id;
  try {
    const face = await import('./face.js');
    await face.loadModels();
    stopCamera = await face.startCamera($('face-video'));
    $('face-hint').textContent = 'Posicione o rosto do corretor de frente, bem iluminado.';
    $('face-capture').disabled = false;
    $('face-capture').onclick = () => captureSamples(face, broker);
  } catch (err) {
    $('face-hint').textContent = `Erro: ${err.message}`;
  }
}
$('face-dialog').addEventListener('close', () => { stopCamera?.(); stopCamera = null; });

async function captureSamples(face, broker) {
  if (!$('face-consent').checked) return toast('Marque o consentimento do corretor antes de capturar.');
  $('face-capture').disabled = true;
  const samples = [];
  let attempts = 0;
  while (samples.length < 5 && attempts < 40) {
    attempts += 1;
    const { count, face: f } = await face.detect($('face-video'));
    if (count === 1 && f.boxRatio > 0.2) {
      samples.push(Array.from(f.descriptor));
      $('face-hint').textContent = `Amostra ${samples.length}/5 — mexa levemente a cabeça.`;
      await new Promise((r) => setTimeout(r, 400));
    } else {
      $('face-hint').textContent = count > 1 ? 'Só uma pessoa na câmera.' : 'Rosto não encontrado — aproxime-se.';
    }
  }
  if (samples.length < 5) {
    $('face-hint').textContent = 'Não foi possível capturar. Melhore a iluminação e tente de novo.';
    $('face-capture').disabled = false;
    return;
  }
  try {
    await api(`/api/admin/brokers/${broker.id}/face`, { method: 'POST', body: { descriptors: samples, consent: true } });
    toast(`Rosto de ${broker.name} cadastrado.`);
    $('face-dialog').close();
    await loadBrokers();
  } catch (err) {
    toast(err.message);
    $('face-capture').disabled = false;
  }
}

// ---------------- RELATÓRIO ----------------
function reportRange() {
  return `from=${encodeURIComponent($('report-from').value)}&to=${encodeURIComponent($('report-to').value)}`;
}
async function loadReport() {
  const r = await api(`/api/admin/report?${reportRange()}`);
  $('report-from').value = r.from;
  $('report-to').value = r.to;
  $('report-body').innerHTML = r.rows.map((x) => `<tr>
    <td>${esc(x.local_date.split('-').reverse().join('/'))}</td><td>${esc(x.shift_id)}</td><td>${esc(x.local_time)}</td>
    <td>${esc(x.name)}</td><td>${esc(x.manager_name)}</td><td>${esc(x.method)}</td><td>${x.leads}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">Sem check-ins no período.</td></tr>';
}
$('report-form').addEventListener('submit', (e) => { e.preventDefault(); loadReport().catch((err) => toast(err.message)); });
$('report-csv').addEventListener('click', async () => {
  try {
    const res = await api(`/api/admin/report?${reportRange()}&format=csv`, { raw: true });
    if (!res.ok) throw new Error('Falha ao exportar.');
    const blob = await res.blob();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `plantao_${$('report-from').value}_a_${$('report-to').value}.csv`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { toast(err.message); }
});

// ---------------- HORÁRIOS ----------------
let currentSchedule = null;
async function loadSchedule() {
  currentSchedule = await api('/api/admin/schedule');
  $('shifts-edit').innerHTML = currentSchedule.shifts.map((sh, i) => `
    <div class="row" data-shift="${i}">
      <div><label>Turno</label><input data-k="label" value="${esc(sh.label)}" required></div>
      <div><label>Check-in abre</label><input type="time" data-k="checkinStart" value="${esc(sh.checkinStart)}" required></div>
      <div><label>Check-in fecha (incluso)</label><input type="time" data-k="checkinEnd" value="${esc(sh.checkinEnd)}" required></div>
      <div><label>Apto até</label><input type="time" data-k="eligibleUntil" value="${esc(sh.eligibleUntil)}" required></div>
    </div>`).join('');
  $('workdays').innerHTML = WEEKDAYS.map((d, i) => `<label style="flex:0 0 auto;color:var(--text)">
    <input type="checkbox" value="${i}" style="width:auto" ${currentSchedule.workdays.includes(i) ? 'checked' : ''}> ${d}</label>`).join('');
}
$('schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const shifts = currentSchedule.shifts.map((sh, i) => {
    const row = document.querySelector(`[data-shift="${i}"]`);
    const get = (k) => row.querySelector(`[data-k="${k}"]`).value;
    return { ...sh, label: get('label'), checkinStart: get('checkinStart'), checkinEnd: get('checkinEnd'), eligibleUntil: get('eligibleUntil') };
  });
  const workdays = [...document.querySelectorAll('#workdays input:checked')].map((x) => Number(x.value));
  try {
    currentSchedule = await api('/api/admin/schedule', { method: 'PUT', body: { ...currentSchedule, shifts, workdays } });
    toast('Horários salvos.');
  } catch (err) { toast(err.message); }
});

// ---------------- início ----------------
async function start() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  try {
    await Promise.all([loadOverview(), loadBrokers()]);
    clearInterval(overviewTimer);
    overviewTimer = setInterval(() => loadOverview().catch(() => {}), 15_000);
  } catch (err) { toast(err.message); }
}

if (token) start(); else $('login').classList.remove('hidden');
