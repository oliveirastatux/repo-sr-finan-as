'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findBestMatch, isValidDescriptor } = require('../src/domain/faceMatch');
const { pickNextBroker } = require('../src/domain/distribution');

const vec = (v) => new Array(128).fill(v);

test('descritor precisa ter 128 números finitos', () => {
  assert.equal(isValidDescriptor(vec(0.1)), true);
  assert.equal(isValidDescriptor(vec(0.1).slice(1)), false);
  assert.equal(isValidDescriptor([...vec(0.1).slice(1), NaN]), false);
  assert.equal(isValidDescriptor('x'), false);
});

test('reconhece a pessoa mais próxima dentro do limite', () => {
  const people = [
    { id: 1, descriptors: [vec(0)] },
    { id: 2, descriptors: [vec(0.2)] },
  ];
  const r = findBestMatch(vec(0.001), people, { threshold: 0.5, margin: 0.05 });
  assert.equal(r.match.id, 1);
});

test('recusa rosto desconhecido', () => {
  const r = findBestMatch(vec(1), [{ id: 1, descriptors: [vec(0)] }], { threshold: 0.5 });
  assert.equal(r.match, null);
  assert.equal(r.reason, 'not_recognized');
});

test('recusa quando duas pessoas ficam empatadas (evita check-in no nome errado)', () => {
  const people = [
    { id: 1, descriptors: [vec(0)] },
    { id: 2, descriptors: [vec(0.002)] },
  ];
  const r = findBestMatch(vec(0.001), people, { threshold: 0.5, margin: 0.05 });
  assert.equal(r.reason, 'ambiguous');
});

test('rodízio: menos leads primeiro, depois quem espera há mais tempo, depois quem chegou antes', () => {
  const base = { checkin_at: '2026-09-25T12:40:00Z', last_assigned_at: null };
  assert.equal(pickNextBroker([]), null);
  assert.equal(
    pickNextBroker([
      { ...base, broker_id: 1, leads_in_shift: 2 },
      { ...base, broker_id: 2, leads_in_shift: 1 },
    ]).broker_id,
    2,
  );
  assert.equal(
    pickNextBroker([
      { ...base, broker_id: 1, leads_in_shift: 1, last_assigned_at: '2026-09-25T13:10:00Z' },
      { ...base, broker_id: 2, leads_in_shift: 1, last_assigned_at: '2026-09-25T13:00:00Z' },
    ]).broker_id,
    2,
  );
  assert.equal(
    pickNextBroker([
      { ...base, broker_id: 1, leads_in_shift: 0, checkin_at: '2026-09-25T12:50:00Z' },
      { ...base, broker_id: 2, leads_in_shift: 0, checkin_at: '2026-09-25T12:35:00Z' },
    ]).broker_id,
    2,
  );
});
