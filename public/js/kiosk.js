import { loadModels, startCamera, detect, BlinkDetector } from './face.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'plantao.kioskToken';
const LIVENESS_TIMEOUT_MS = 6000;
const RESULT_MS = 4000;
const MIN_FACE_RATIO = 0.22; // rosto precisa ocupar ~1/4 da largura (pessoa perto do tablet)

let token = readToken();
let status = null;
let busy = false;

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showSetup();
    throw new Error(body.error || 'Tablet não autorizado.');
  }
  if (!res.ok) throw Object.assign(new Error(body.error || 'Falha na comunicação.'), { status: res.status });
  return body;
}

function showSetup() {
  $('setup').classList.remove('hidden');
}

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* modo privado: vale só nesta sessão */ }
  $('setup').classList.add('hidden');
  refreshStatus();
});

function tickClock() {
  // Usa o fuso configurado no sistema, não o do aparelho.
  const now = new Date();
  const timeZone = status?.timezone || 'America/Sao_Paulo';
  $('clock').textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone });
  $('date').textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone });
}

async function refreshStatus() {
  if (!token) return showSetup();
  try {
    status = await api('/api/kiosk/status');
    const w = $('window');
    if (status.demo) {
      w.innerHTML = `<span class="badge warn">DEMONSTRAÇÃO</span> Check-in ${status.open.label} aberto`;
    } else if (status.open) {
      w.innerHTML = `<span class="badge ok">ABERTO</span> Check-in ${status.open.label} até ${status.open.checkinEnd}`;
    } else if (status.next) {
      w.innerHTML = `<span class="badge warn">FECHADO</span> Próximo: ${status.next.label} às ${status.next.checkinStart}`;
    } else {
      w.innerHTML = '<span class="badge err">FECHADO</span> Sem check-in hoje';
    }
  } catch (e) {
    $('window').textContent = e.message;
  }
}

function showResult(kind, html) {
  const el = $('result');
  el.className = `result ${kind}`;
  el.innerHTML = `<div>${html}</div>`;
  return new Promise((r) => setTimeout(() => { el.className = 'result hidden'; r(); }, RESULT_MS));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function submit(descriptor) {
  try {
    const r = await api('/api/kiosk/checkin', {
      method: 'POST',
      body: JSON.stringify({ descriptor, liveness: true }),
    });
    const title = r.alreadyCheckedIn ? `${escapeHtml(r.name)}, você já está no plantão` : `Bem-vindo(a), ${escapeHtml(r.name)}!`;
    await showResult('ok', `✅ ${title}<small>${escapeHtml(r.shift.label)} · check-in às ${escapeHtml(r.time)} · apto até ${escapeHtml(r.shift.eligibleUntil)}</small>`);
  } catch (e) {
    await showResult('err', `⛔ ${escapeHtml(e.message)}`);
  }
}

async function loop(video) {
  const blink = new BlinkDetector();
  let startedAt = 0;

  const step = async () => {
    if (busy || !status?.open || !token) {
      $('hint').textContent = status?.open ? '' : 'Check-in fechado neste horário.';
      video.classList.remove('ready');
      blink.reset();
      return setTimeout(step, 500);
    }
    try {
      const { count, face } = await detect(video);
      if (count === 0) {
        $('hint').textContent = 'Aproxime-se e olhe para a câmera';
        video.classList.remove('ready');
        blink.reset();
      } else if (count > 1) {
        $('hint').textContent = 'Uma pessoa por vez, por favor';
        blink.reset();
      } else if (face.boxRatio < MIN_FACE_RATIO) {
        $('hint').textContent = 'Chegue um pouco mais perto';
        blink.reset();
      } else {
        video.classList.add('ready');
        if (!startedAt) startedAt = Date.now();
        $('hint').textContent = '👁️ Agora dê uma piscada';
        if (blink.push(face)) {
          busy = true;
          $('hint').textContent = 'Verificando…';
          await submit(blink.descriptor());
          blink.reset();
          startedAt = 0;
          busy = false;
        } else if (Date.now() - startedAt > LIVENESS_TIMEOUT_MS) {
          blink.reset();
          startedAt = Date.now();
        }
      }
    } catch (e) {
      console.error(e);
    }
    return requestAnimationFrame(step);
  };
  step();
}

async function main() {
  tickClock();
  setInterval(tickClock, 1000);
  await refreshStatus();
  setInterval(refreshStatus, 20_000);

  const video = $('video');
  try {
    $('hint').textContent = 'Carregando reconhecimento facial…';
    await Promise.all([loadModels(), startCamera(video)]);
    loop(video);
  } catch (e) {
    $('hint').textContent = `Não foi possível abrir a câmera: ${e.message}`;
  }
}

main();
