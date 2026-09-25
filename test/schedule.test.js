'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/domain/schedule');

const sched = s.validateSchedule(s.DEFAULT_SCHEDULE);
// São Paulo = UTC-3. 2026-09-25 é sexta; 2026-09-27 é domingo.
const at = (local, day = '2026-09-25') => new Date(`${day}T${local}:00-03:00`);

test('janela da manhã: 09:30 a 09:59:59', () => {
  assert.equal(s.openCheckinShift(sched, at('09:29')), null);
  assert.equal(s.openCheckinShift(sched, at('09:30')).id, 'manha');
  assert.equal(s.openCheckinShift(sched, new Date('2026-09-25T09:59:59-03:00')).id, 'manha');
  assert.equal(s.openCheckinShift(sched, at('10:00')), null);
});

test('janela da tarde: 14:00 a 14:59:59', () => {
  assert.equal(s.openCheckinShift(sched, at('13:59')), null);
  assert.equal(s.openCheckinShift(sched, at('14:00')).id, 'tarde');
  assert.equal(s.openCheckinShift(sched, at('14:59')).id, 'tarde');
  assert.equal(s.openCheckinShift(sched, at('15:00')), null);
});

test('aptidão da manhã expira às 14:00 e a tarde exige novo check-in', () => {
  const manha = { shift_id: 'manha', local_date: '2026-09-25' };
  assert.equal(s.isCheckinEligible(sched, manha, at('09:45')), true);
  assert.equal(s.isCheckinEligible(sched, manha, at('13:59')), true);
  assert.equal(s.isCheckinEligible(sched, manha, at('14:00')), false);
  const tarde = { shift_id: 'tarde', local_date: '2026-09-25' };
  assert.equal(s.isCheckinEligible(sched, tarde, at('14:30')), true);
  assert.equal(s.isCheckinEligible(sched, tarde, at('18:59')), true);
  assert.equal(s.isCheckinEligible(sched, tarde, at('19:00')), false);
});

test('check-in de ontem não vale hoje', () => {
  const ontem = { shift_id: 'manha', local_date: '2026-09-24' };
  assert.equal(s.isCheckinEligible(sched, ontem, at('10:30')), false);
});

test('domingo fechado por padrão', () => {
  assert.equal(s.openCheckinShift(sched, at('09:45', '2026-09-27')), null);
  assert.equal(s.activeShift(sched, at('11:00', '2026-09-27')), null);
});

test('próxima janela', () => {
  assert.equal(s.nextCheckinShift(sched, at('08:00')).id, 'manha');
  assert.equal(s.nextCheckinShift(sched, at('11:00')).id, 'tarde');
  assert.equal(s.nextCheckinShift(sched, at('16:00')), null);
});

test('validação recusa configurações incoerentes', () => {
  assert.throws(() => s.validateSchedule({ shifts: [] }), /ao menos um turno/);
  assert.throws(
    () => s.validateSchedule({ shifts: [{ id: 'x', checkinStart: '10:00', checkinEnd: '09:00', eligibleUntil: '12:00' }] }),
    /início do check-in depois do fim/,
  );
  assert.throws(
    () => s.validateSchedule({ shifts: [{ id: 'x', checkinStart: '09:00', checkinEnd: '09:30', eligibleUntil: '09:30' }] }),
    /terminar depois/,
  );
  assert.throws(() => s.validateSchedule({ timezone: 'Marte/Base' }), /Fuso/);
  assert.throws(() => s.validateSchedule({ shifts: [{ id: 'x', checkinStart: '9h', checkinEnd: '09:30', eligibleUntil: '12:00' }] }), /HH:MM/);
});

test('modo demonstração escolhe o turno mais próximo em qualquer horário', () => {
  assert.equal(s.demoShift(sched, at('07:00')).id, 'manha');
  assert.equal(s.demoShift(sched, at('11:00')).id, 'manha');
  assert.equal(s.demoShift(sched, at('14:30')).id, 'tarde');
  assert.equal(s.demoShift(sched, at('22:00')).id, 'tarde');
  assert.equal(s.demoShift(sched, at('11:00', '2026-09-27')).id, 'manha'); // domingo também
});
