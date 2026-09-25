'use strict';

/**
 * Dados de exemplo para apresentar o sistema à diretoria. São todos fictícios
 * e ficam marcados pelo domínio de e-mail DEMO_DOMAIN, para serem apagados
 * com um clique antes do uso real.
 */

const { localParts } = require('./domain/schedule');

const DEMO_DOMAIN = '@exemplo.demo';
const MANAGERS = ['Gerente Paulo', 'Gerente Renata', 'Gerente Marcos'];
const NAMES = [
  'Ana Exemplo', 'Bruno Exemplo', 'Carla Exemplo', 'Diego Exemplo', 'Elisa Exemplo', 'Fábio Exemplo',
  'Gabi Exemplo', 'Heitor Exemplo', 'Íris Exemplo', 'João Exemplo', 'Karina Exemplo', 'Lucas Exemplo',
];
const DAY_MS = 24 * 60 * 60 * 1000;

// Gerador pseudoaleatório com semente: os mesmos dados a cada geração.
function rng(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const addMinutes = (hhmm, m) => {
  const [h, mi] = hhmm.split(':').map(Number);
  const total = h * 60 + mi + m;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

/** Converte data/hora local do fuso configurado em ISO com deslocamento. */
function localIso(date, time, timezone) {
  const name = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName').value; // ex.: "GMT-03:00"
  const offset = name === 'GMT' ? 'Z' : name.slice(3);
  return new Date(`${date}T${time}:00${offset}`).toISOString();
}

function hasDemoData(repo) {
  return Boolean(repo.raw.prepare('SELECT 1 FROM brokers WHERE email LIKE ? LIMIT 1').get(`%${DEMO_DOMAIN}`));
}

function clearDemo(repo) {
  const db = repo.raw;
  return repo.tx(() => {
    const ids = db.prepare('SELECT id FROM brokers WHERE email LIKE ?').all(`%${DEMO_DOMAIN}`).map((r) => r.id);
    if (!ids.length) return 0;
    const list = ids.join(',');
    db.exec(`DELETE FROM lead_assignments WHERE broker_id IN (${list}) OR rd_deal_id LIKE 'DEMO-%'`);
    db.exec(`DELETE FROM checkins WHERE broker_id IN (${list})`);
    db.exec(`DELETE FROM brokers WHERE id IN (${list})`);
    return ids.length;
  });
}

/**
 * Cria corretores fictícios e 10 dias úteis de histórico, mais os check-ins
 * de hoje no turno em demonstração.
 */
function seedDemo(repo, { now, currentShift }) {
  if (hasDemoData(repo)) clearDemo(repo);
  const sched = repo.getSchedule();
  const rand = rng(42);
  const db = repo.raw;

  return repo.tx(() => {
    const brokers = NAMES.map((name, i) =>
      repo.createBroker({
        name,
        email: `${name.split(' ')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}${DEMO_DOMAIN}`,
        manager_name: MANAGERS[i % MANAGERS.length],
        rd_user_id: `demo-${i + 1}`,
      }),
    );

    const insertLead = db.prepare(
      `INSERT INTO lead_assignments (rd_deal_id, broker_id, owner_id, shift_id, local_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'dry_run', ?)`,
    );
    let dealSeq = 1;
    let checkins = 0;

    const addCheckin = (broker, shift, localDate, time, iso) => {
      repo.insertCheckin({
        broker_id: broker.id, shift_id: shift.id, local_date: localDate, local_time: time,
        checkin_at: iso, method: rand() < 0.93 ? 'face' : 'manual',
        distance: Number((0.28 + rand() * 0.15).toFixed(4)),
        note: null,
      });
      checkins += 1;
    };

    // Histórico: últimos dias de funcionamento (sem hoje).
    let daysDone = 0;
    for (let back = 1; daysDone < 10 && back < 30; back += 1) {
      const day = new Date(now.getTime() - back * DAY_MS);
      const lp = localParts(day, sched.timezone);
      if (!sched.workdays.includes(lp.weekday)) continue;
      daysDone += 1;
      for (const shift of sched.shifts) {
        const present = brokers.filter(() => rand() < 0.75);
        for (const b of present) {
          const time = addMinutes(shift.checkinStart, Math.floor(rand() * 30));
          const iso = localIso(lp.date, time, sched.timezone);
          addCheckin(b, shift, lp.date, time, iso);
          const leads = Math.floor(rand() * 4);
          for (let k = 0; k < leads; k += 1) {
            insertLead.run(`DEMO-${dealSeq}`, b.id, b.rd_user_id, shift.id, lp.date, iso);
            dealSeq += 1;
          }
        }
      }
    }

    // Hoje: 8 corretores já no turno em demonstração.
    const today = localParts(now, sched.timezone);
    brokers.slice(0, 8).forEach((b, i) => {
      const time = addMinutes(currentShift.checkinStart, i * 3 + 1);
      addCheckin(b, currentShift, today.date, time, localIso(today.date, time, sched.timezone));
    });

    return { brokers: brokers.length, checkins, leads: dealSeq - 1 };
  });
}

module.exports = { seedDemo, clearDemo, hasDemoData, DEMO_DOMAIN };
