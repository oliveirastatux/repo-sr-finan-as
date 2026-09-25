'use strict';

/**
 * Motor de regras do plantão de leads.
 *
 * Regra de negócio:
 *   - Cada turno tem uma janela de check-in (ex.: 09:30–09:59) e um horário
 *     em que a aptidão expira (ex.: 14:00).
 *   - Quem faz check-in dentro da janela fica APTO a receber leads do momento
 *     do check-in até o fim do turno.
 *   - Quem perdeu a manhã pode entrar na tarde.
 *
 * Tudo aqui é puro (sem I/O) para ser 100% testável.
 */

const DEFAULT_SCHEDULE = Object.freeze({
  timezone: 'America/Sao_Paulo',
  // 0 = domingo ... 6 = sábado
  workdays: [1, 2, 3, 4, 5, 6],
  shifts: [
    { id: 'manha', label: 'Manhã', checkinStart: '09:30', checkinEnd: '09:59', eligibleUntil: '14:00' },
    { id: 'tarde', label: 'Tarde', checkinStart: '14:00', checkinEnd: '14:59', eligibleUntil: '19:00' },
  ],
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm) {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`Horário inválido: "${hhmm}" (use HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Converte um instante para data/hora local do fuso configurado. */
function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: weekdays[p.weekday],
    minutes: Number(p.hour) * 60 + Number(p.minute),
    seconds: Number(p.second),
    time: `${p.hour}:${p.minute}`,
  };
}

/** Valida e normaliza uma configuração de horários vinda do painel. */
function validateSchedule(input) {
  const errors = [];
  const s = { ...DEFAULT_SCHEDULE, ...(input || {}) };

  try {
    new Intl.DateTimeFormat('en', { timeZone: s.timezone });
  } catch {
    errors.push(`Fuso horário inválido: ${s.timezone}`);
  }

  if (!Array.isArray(s.workdays) || s.workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.push('Dias de trabalho devem ser números de 0 (domingo) a 6 (sábado).');
  }

  if (!Array.isArray(s.shifts) || s.shifts.length === 0) {
    errors.push('Configure ao menos um turno.');
  } else {
    const ids = new Set();
    s.shifts.forEach((sh, i) => {
      const tag = `Turno ${i + 1}`;
      if (!sh.id || !/^[a-z0-9_-]+$/.test(sh.id)) errors.push(`${tag}: id inválido.`);
      if (ids.has(sh.id)) errors.push(`${tag}: id duplicado "${sh.id}".`);
      ids.add(sh.id);
      try {
        const a = toMinutes(sh.checkinStart);
        const b = toMinutes(sh.checkinEnd);
        const c = toMinutes(sh.eligibleUntil);
        if (a > b) errors.push(`${tag}: início do check-in depois do fim.`);
        if (c <= b) errors.push(`${tag}: a aptidão precisa terminar depois da janela de check-in.`);
      } catch (e) {
        errors.push(`${tag}: ${e.message}`);
      }
    });
  }

  if (errors.length) {
    const err = new Error(errors.join(' '));
    err.status = 400;
    throw err;
  }
  return {
    timezone: s.timezone,
    workdays: [...new Set(s.workdays)].sort(),
    shifts: s.shifts.map((sh) => ({
      id: sh.id,
      label: sh.label || sh.id,
      checkinStart: sh.checkinStart,
      checkinEnd: sh.checkinEnd,
      eligibleUntil: sh.eligibleUntil,
    })),
  };
}

/**
 * Retorna o turno cuja janela de check-in está aberta agora, ou null.
 * O minuto final é inclusivo: "09:59" aceita até 09:59:59.
 */
function openCheckinShift(schedule, now) {
  const lp = localParts(now, schedule.timezone);
  if (!schedule.workdays.includes(lp.weekday)) return null;
  return (
    schedule.shifts.find(
      (sh) => lp.minutes >= toMinutes(sh.checkinStart) && lp.minutes <= toMinutes(sh.checkinEnd),
    ) || null
  );
}

/** Turno em vigor (entre a abertura do check-in e a expiração), ou null. */
function activeShift(schedule, now) {
  const lp = localParts(now, schedule.timezone);
  if (!schedule.workdays.includes(lp.weekday)) return null;
  return (
    schedule.shifts.find(
      (sh) => lp.minutes >= toMinutes(sh.checkinStart) && lp.minutes < toMinutes(sh.eligibleUntil),
    ) || null
  );
}

/** Próxima janela de check-in de hoje (para mostrar no tablet), ou null. */
function nextCheckinShift(schedule, now) {
  const lp = localParts(now, schedule.timezone);
  if (!schedule.workdays.includes(lp.weekday)) return null;
  return (
    schedule.shifts
      .filter((sh) => toMinutes(sh.checkinStart) > lp.minutes)
      .sort((a, b) => toMinutes(a.checkinStart) - toMinutes(b.checkinStart))[0] || null
  );
}

/**
 * Um check-in dá aptidão se foi feito hoje, no turno em vigor, e o turno
 * ainda não expirou.
 */
function isCheckinEligible(schedule, checkin, now) {
  const lp = localParts(now, schedule.timezone);
  const shift = activeShift(schedule, now);
  return Boolean(shift && checkin.shift_id === shift.id && checkin.local_date === lp.date);
}

module.exports = {
  DEFAULT_SCHEDULE,
  toMinutes,
  localParts,
  validateSchedule,
  openCheckinShift,
  activeShift,
  nextCheckinShift,
  isCheckinEligible,
};
