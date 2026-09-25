'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createServices } = require('../src/services');
const { createApp } = require('../src/app');
const { createLogger } = require('../src/lib/logger');
const { loadConfig } = require('../src/config');

const vec = (v) => new Array(128).fill(v);
const ENV = {
  ADMIN_PASSWORD: 'senha-teste',
  SESSION_SECRET: 'x'.repeat(40),
  KIOSK_TOKEN: 'k'.repeat(20),
  RD_WEBHOOK_SECRET: 'w'.repeat(20),
  RD_FALLBACK_OWNER_ID: 'gerente-rd',
  DB_PATH: ':memory:',
};

async function setup({ rdFails = false } = {}) {
  const cfg = loadConfig(ENV);
  const repo = openDb(':memory:');
  let current = new Date('2026-09-25T09:45:00-03:00');
  const calls = [];
  const rd = {
    dryRun: false,
    async assignDealOwner(dealId, ownerId) {
      calls.push({ dealId, ownerId });
      if (rdFails) throw Object.assign(new Error('RD fora do ar'), { status: 503 });
    },
  };
  const logger = createLogger({ silent: true });
  const services = createServices({ repo, rd, cfg, logger, clock: () => current });
  const app = createApp({ cfg, repo, services, logger });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  const { body: { token: admin } } = await call('/api/admin/login', { method: 'POST', body: { password: 'senha-teste' } });

  return {
    call, admin, kiosk: ENV.KIOSK_TOKEN, calls, repo,
    setTime: (iso) => { current = new Date(iso); },
    close: () => new Promise((r) => server.close(r)),
  };
}

async function createBroker(t, name, face, rd) {
  const { body } = await t.call('/api/admin/brokers', { method: 'POST', token: t.admin, body: { name, manager_name: 'Carla', rd_user_id: rd } });
  await t.call(`/api/admin/brokers/${body.id}/face`, { method: 'POST', token: t.admin, body: { descriptors: [vec(face)], consent: true } });
  return body;
}

test('fluxo completo: check-in facial, rodízio, troca de turno e relatório', async () => {
  const t = await setup();
  try {
    await createBroker(t, 'Ana', 0, 'rd-ana');
    await createBroker(t, 'Bruno', 0.3, 'rd-bruno');

    // Sem token de tablet → bloqueado
    assert.equal((await t.call('/api/kiosk/checkin', { method: 'POST', body: { descriptor: vec(0), liveness: true } })).status, 401);

    // Sem prova de vida → recusado
    const noLive = await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0) } });
    assert.equal(noLive.status, 400);

    // 09:45 — Ana e Bruno fazem check-in
    const ana = await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0.001), liveness: true } });
    assert.equal(ana.status, 200);
    assert.equal(ana.body.name, 'Ana');
    assert.equal(ana.body.alreadyCheckedIn, false);
    const bruno = await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0.301), liveness: true } });
    assert.equal(bruno.body.name, 'Bruno');

    // Repetir não duplica
    const again = await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0.001), liveness: true } });
    assert.equal(again.body.alreadyCheckedIn, true);

    // Desconhecido
    const stranger = await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0.9), liveness: true } });
    assert.equal(stranger.status, 404);

    // 10:05 — janela fechada
    t.setTime('2026-09-25T10:05:00-03:00');
    const late = await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0.001), liveness: true } });
    assert.equal(late.status, 409);
    assert.match(late.body.error, /Tarde às 14:00/);

    // Leads alternam entre Ana e Bruno
    const hook = `/api/webhooks/rd/${ENV.RD_WEBHOOK_SECRET}`;
    for (const id of ['D1', 'D2', 'D3', 'D4']) {
      const r = await t.call(hook, { method: 'POST', body: { document: { id } } });
      assert.equal(r.body.status, 'assigned');
    }
    assert.deepEqual(t.calls.map((c) => c.ownerId), ['rd-ana', 'rd-bruno', 'rd-ana', 'rd-bruno']);

    // Reentrega do mesmo webhook não redistribui
    const dup = await t.call(hook, { method: 'POST', body: { document: { id: 'D1' } } });
    assert.equal(dup.body.duplicate, true);
    assert.equal(t.calls.length, 4);

    // Segredo errado → 404
    assert.equal((await t.call('/api/webhooks/rd/errado', { method: 'POST', body: { id: 'X' } })).status, 404);

    // 14:10 — manhã expirou; ninguém renovou → responsável reserva
    t.setTime('2026-09-25T14:10:00-03:00');
    const fb = await t.call(hook, { method: 'POST', body: { deal: { id: 'D5' } } });
    assert.equal(fb.body.status, 'fallback');
    assert.equal(t.calls.at(-1).ownerId, 'gerente-rd');

    // Bruno renova na tarde e passa a receber sozinho
    await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0.301), liveness: true } });
    await t.call(hook, { method: 'POST', body: { id: 'D6' } });
    assert.equal(t.calls.at(-1).ownerId, 'rd-bruno');

    const ov = await t.call('/api/admin/overview', { token: t.admin });
    assert.equal(ov.body.eligibleIds.length, 1);
    assert.equal(ov.body.leadsToday, 6);

    // Relatório CSV
    const csv = await t.call('/api/admin/report?from=2026-09-25&to=2026-09-25&format=csv', { token: t.admin });
    assert.equal(csv.status, 200);
    assert.match(csv.body, /Data;Turno;Horário;Corretor;Gerente/);
    assert.match(csv.body, /2026-09-25;manha;09:45;Ana;Carla;face;2/);
    assert.match(csv.body, /2026-09-25;tarde;14:10;Bruno;Carla;face;1/);
  } finally {
    await t.close();
  }
});

test('check-in manual do gerente vale após a janela, dentro do turno, e exige motivo', async () => {
  const t = await setup();
  try {
    const b = await createBroker(t, 'Carlos', 0, 'rd-c');
    t.setTime('2026-09-25T11:00:00-03:00');
    const noNote = await t.call('/api/admin/checkins/manual', { method: 'POST', token: t.admin, body: { brokerId: b.id } });
    assert.equal(noNote.status, 400);
    const ok = await t.call('/api/admin/checkins/manual', { method: 'POST', token: t.admin, body: { brokerId: b.id, note: 'tablet sem internet' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.shift.id, 'manha');

    t.setTime('2026-09-25T20:00:00-03:00');
    const closed = await t.call('/api/admin/checkins/manual', { method: 'POST', token: t.admin, body: { brokerId: b.id, note: 'x' } });
    assert.equal(closed.status, 409);
  } finally {
    await t.close();
  }
});

test('falha no RD fica registrada como erro e a reentrega tenta de novo', async () => {
  const t = await setup({ rdFails: true });
  try {
    await createBroker(t, 'Ana', 0, 'rd-ana');
    await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0), liveness: true } });
    const hook = `/api/webhooks/rd/${ENV.RD_WEBHOOK_SECRET}`;
    const r1 = await t.call(hook, { method: 'POST', body: { id: 'E1' } });
    assert.equal(r1.body.status, 'error');
    const r2 = await t.call(hook, { method: 'POST', body: { id: 'E1' } });
    assert.equal(r2.body.duplicate, false);
    assert.equal(t.calls.length, 2);
  } finally {
    await t.close();
  }
});

test('segurança: painel exige login, cadastro facial exige consentimento, CSV neutraliza fórmulas', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('/api/admin/brokers')).status, 401);
    assert.equal((await t.call('/api/admin/login', { method: 'POST', body: { password: 'errada' } })).status, 401);
    const { body } = await t.call('/api/admin/brokers', { method: 'POST', token: t.admin, body: { name: '=HYPERLINK("x")' } });
    const noConsent = await t.call(`/api/admin/brokers/${body.id}/face`, { method: 'POST', token: t.admin, body: { descriptors: [vec(0)] } });
    assert.equal(noConsent.status, 400);
    await t.call(`/api/admin/brokers/${body.id}/face`, { method: 'POST', token: t.admin, body: { descriptors: [vec(0)], consent: true } });
    await t.call('/api/kiosk/checkin', { method: 'POST', token: t.kiosk, body: { descriptor: vec(0), liveness: true } });
    const csv = await t.call('/api/admin/report?format=csv', { token: t.admin });
    assert.match(csv.body, /'=HYPERLINK/);
  } finally {
    await t.close();
  }
});
