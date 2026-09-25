'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_SCHEDULE, validateSchedule } = require('./domain/schedule');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brokers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  email            TEXT,
  manager_name     TEXT NOT NULL DEFAULT '',
  rd_user_id       TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  face_descriptors TEXT NOT NULL DEFAULT '[]',
  consent_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  broker_id   INTEGER NOT NULL REFERENCES brokers(id),
  shift_id    TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  local_time  TEXT NOT NULL,
  checkin_at  TEXT NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('face','manual')),
  distance    REAL,
  note        TEXT,
  UNIQUE (broker_id, local_date, shift_id)
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(local_date, shift_id);

CREATE TABLE IF NOT EXISTS lead_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rd_deal_id  TEXT NOT NULL UNIQUE,
  broker_id   INTEGER REFERENCES brokers(id),
  owner_id    TEXT,
  shift_id    TEXT,
  local_date  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','assigned','dry_run','fallback','error')),
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_date ON lead_assignments(local_date, shift_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return createRepo(db);
}

function parseBroker(row) {
  if (!row) return null;
  const descriptors = JSON.parse(row.face_descriptors || '[]');
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    manager_name: row.manager_name,
    rd_user_id: row.rd_user_id,
    active: Boolean(row.active),
    consent_at: row.consent_at,
    face_samples: descriptors.length,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createRepo(db) {
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    raw: db,
    close: () => db.close(),
    tx,

    audit(actor, action, detail) {
      db.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)').run(
        actor, action, detail ? JSON.stringify(detail) : null,
      );
    },

    // ---------- configurações ----------
    getSchedule() {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'schedule'").get();
      return row ? validateSchedule(JSON.parse(row.value)) : validateSchedule(DEFAULT_SCHEDULE);
    },
    saveSchedule(schedule) {
      const valid = validateSchedule(schedule);
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('schedule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(valid));
      return valid;
    },

    // ---------- corretores ----------
    listBrokers() {
      return db.prepare('SELECT * FROM brokers ORDER BY active DESC, name').all().map(parseBroker);
    },
    getBroker(id) {
      return parseBroker(db.prepare('SELECT * FROM brokers WHERE id = ?').get(id));
    },
    createBroker({ name, email, manager_name, rd_user_id }) {
      const r = db
        .prepare('INSERT INTO brokers (name, email, manager_name, rd_user_id) VALUES (?, ?, ?, ?)')
        .run(name, email || null, manager_name || '', rd_user_id || null);
      return this.getBroker(Number(r.lastInsertRowid));
    },
    updateBroker(id, { name, email, manager_name, rd_user_id, active }) {
      db.prepare(
        `UPDATE brokers SET name = ?, email = ?, manager_name = ?, rd_user_id = ?, active = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(name, email || null, manager_name || '', rd_user_id || null, active ? 1 : 0, id);
      return this.getBroker(id);
    },
    setFace(id, descriptors, consentAt) {
      db.prepare(
        `UPDATE brokers SET face_descriptors = ?, consent_at = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(JSON.stringify(descriptors), consentAt, id);
      return this.getBroker(id);
    },
    clearFace(id) {
      db.prepare(
        `UPDATE brokers SET face_descriptors = '[]', consent_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(id);
      return this.getBroker(id);
    },
    faceGallery() {
      return db
        .prepare("SELECT id, face_descriptors FROM brokers WHERE active = 1 AND face_descriptors != '[]'")
        .all()
        .map((r) => ({ id: r.id, descriptors: JSON.parse(r.face_descriptors) }));
    },

    // ---------- check-ins ----------
    findCheckin(brokerId, localDate, shiftId) {
      return db
        .prepare('SELECT * FROM checkins WHERE broker_id = ? AND local_date = ? AND shift_id = ?')
        .get(brokerId, localDate, shiftId);
    },
    insertCheckin({ broker_id, shift_id, local_date, local_time, checkin_at, method, distance, note }) {
      const r = db
        .prepare(
          `INSERT INTO checkins (broker_id, shift_id, local_date, local_time, checkin_at, method, distance, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(broker_id, shift_id, local_date, local_time, checkin_at, method, distance ?? null, note ?? null);
      return db.prepare('SELECT * FROM checkins WHERE id = ?').get(Number(r.lastInsertRowid));
    },
    deleteCheckin(id) {
      return db.prepare('DELETE FROM checkins WHERE id = ?').run(id).changes > 0;
    },

    /** Check-ins do turno com contagem de leads — base do painel "aptos agora" e do rodízio. */
    shiftRoster(localDate, shiftId) {
      return db
        .prepare(
          `SELECT c.id AS checkin_id, c.broker_id, c.checkin_at, c.local_time, c.method,
                  b.name, b.manager_name, b.rd_user_id, b.active,
                  (SELECT COUNT(*) FROM lead_assignments l
                     WHERE l.broker_id = c.broker_id AND l.local_date = c.local_date AND l.shift_id = c.shift_id
                       AND l.status IN ('pending','assigned','dry_run')) AS leads_in_shift,
                  (SELECT MAX(l.created_at) FROM lead_assignments l
                     WHERE l.broker_id = c.broker_id AND l.status IN ('pending','assigned','dry_run')) AS last_assigned_at
             FROM checkins c JOIN brokers b ON b.id = c.broker_id
            WHERE c.local_date = ? AND c.shift_id = ?
            ORDER BY c.checkin_at`,
        )
        .all(localDate, shiftId);
    },

    checkinReport(fromDate, toDate) {
      return db
        .prepare(
          `SELECT c.local_date, c.shift_id, c.local_time, c.method, c.distance, c.note,
                  b.id AS broker_id, b.name, b.manager_name,
                  (SELECT COUNT(*) FROM lead_assignments l
                     WHERE l.broker_id = c.broker_id AND l.local_date = c.local_date AND l.shift_id = c.shift_id
                       AND l.status IN ('pending','assigned','dry_run')) AS leads
             FROM checkins c JOIN brokers b ON b.id = c.broker_id
            WHERE c.local_date BETWEEN ? AND ?
            ORDER BY c.local_date DESC, c.shift_id, c.checkin_at`,
        )
        .all(fromDate, toDate);
    },

    // ---------- leads ----------
    findLead(rdDealId) {
      return db.prepare('SELECT * FROM lead_assignments WHERE rd_deal_id = ?').get(rdDealId);
    },
    insertLead(row) {
      db.prepare(
        `INSERT INTO lead_assignments (rd_deal_id, broker_id, owner_id, shift_id, local_date, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.rd_deal_id, row.broker_id ?? null, row.owner_id ?? null, row.shift_id ?? null,
        row.local_date, row.status, row.error ?? null, row.created_at,
      );
      return this.findLead(row.rd_deal_id);
    },
    updateLead(rdDealId, { status, error }) {
      db.prepare('UPDATE lead_assignments SET status = ?, error = ? WHERE rd_deal_id = ?').run(
        status, error ?? null, rdDealId,
      );
      return this.findLead(rdDealId);
    },
    countLeads(localDate) {
      return db
        .prepare("SELECT COUNT(*) AS n FROM lead_assignments WHERE local_date = ? AND status != 'error'")
        .get(localDate).n;
    },
    recentLeads(limit = 50) {
      return db
        .prepare(
          `SELECT l.*, b.name AS broker_name FROM lead_assignments l
             LEFT JOIN brokers b ON b.id = l.broker_id
            ORDER BY l.id DESC LIMIT ?`,
        )
        .all(limit);
    },
  };
}

module.exports = { openDb };
