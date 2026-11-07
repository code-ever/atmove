'use strict';
/* SQLite storage using Node's built-in node:sqlite (Node 22.5+). No external dependencies. */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [
/* 1 — core schema */
`
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE lgas(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  official_code TEXT UNIQUE
);
CREATE TABLE wards(
  id TEXT PRIMARY KEY,
  lga_id TEXT NOT NULL REFERENCES lgas(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  official INTEGER NOT NULL DEFAULT 0,
  info_office TEXT, info_note TEXT,
  UNIQUE(lga_id, name)
);
CREATE TABLE polling_units(
  id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards(id),
  lga_id TEXT NOT NULL REFERENCES lgas(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  official INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ward_id, name)
);
CREATE TRIGGER pu_parent_check BEFORE INSERT ON polling_units
BEGIN
  SELECT RAISE(ABORT,'polling unit LGA must match its ward LGA')
  WHERE (SELECT lga_id FROM wards WHERE id=NEW.ward_id) IS NOT NEW.lga_id;
END;

CREATE TABLE users(
  uid TEXT PRIMARY KEY,
  member_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT,
  contact TEXT NOT NULL DEFAULT 'SMS',
  category TEXT NOT NULL DEFAULT 'General member',
  status TEXT NOT NULL CHECK(status IN ('Pending','Approved','Rejected','Suspended','Deleted')),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('state','lga','ward','pu','member')),
  lga_id TEXT REFERENCES lgas(id),
  ward_id TEXT REFERENCES wards(id),
  pu_id TEXT REFERENCES polling_units(id),
  pw_hash TEXT,
  verified_at TEXT,
  card_token TEXT UNIQUE,
  consent_processing_at TEXT,
  consent_updates INTEGER NOT NULL DEFAULT 0,
  consent_version TEXT,
  created_at TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, decision_reason TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX users_email_u ON users(lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX users_geo ON users(lga_id, ward_id, pu_id);
CREATE INDEX users_status ON users(status);

CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ua TEXT, ip TEXT
);
CREATE TABLE otps(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ticket_hash TEXT,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

CREATE TABLE appointments(
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK(level IN ('lga','ward','pu')),
  geo_id TEXT NOT NULL,
  uid TEXT NOT NULL REFERENCES users(uid),
  status TEXT NOT NULL CHECK(status IN ('Pending','Approved','Rejected','Superseded')),
  by_text TEXT, nominated_by TEXT, note TEXT,
  public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, reason TEXT
);
CREATE INDEX appt_geo ON appointments(level, geo_id, status);

CREATE TABLE articles(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, cat TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('Draft','In review','Scheduled','Published','Archived')),
  featured INTEGER NOT NULL DEFAULT 0,
  author TEXT, author_uid TEXT,
  publish_date TEXT NOT NULL,
  img TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE events(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, descr TEXT NOT NULL,
  starts_at TEXT NOT NULL, venue TEXT NOT NULL, org TEXT NOT NULL,
  reg INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('Upcoming','Ongoing','Completed')),
  lga_id TEXT, cap INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE event_rsvps(
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(event_id, uid)
);
CREATE TABLE media(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, cat TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('photo','video')),
  cls TEXT, url TEXT,
  approved INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE activity_reports(
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL, geo TEXT,
  lga_id TEXT, ward_id TEXT, pu_id TEXT,
  author_uid TEXT, by_name TEXT,
  title TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL,
  att INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Submitted',
  summary TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE notifications(
  id TEXT PRIMARY KEY,
  to_uid TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX notif_to ON notifications(to_uid);
CREATE TABLE notif_reads(nid TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY(nid, uid));
CREATE TABLE tasks(id TEXT PRIMARY KEY, roles TEXT NOT NULL, title TEXT NOT NULL, due TEXT NOT NULL);
CREATE TABLE task_done(task_id TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY(task_id, uid));
CREATE TABLE tickets(
  id TEXT PRIMARY KEY,
  by_uid TEXT, name TEXT, contact TEXT,
  cat TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Closed')),
  payload TEXT, scope_ward TEXT,
  created_at INTEGER NOT NULL,
  reply TEXT, closed_by TEXT, closed_at INTEGER
);
CREATE TABLE sitreps(
  id TEXT PRIMARY KEY,
  pu_id TEXT NOT NULL REFERENCES polling_units(id),
  ward_id TEXT NOT NULL, lga_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  status TEXT NOT NULL,
  accr INTEGER NOT NULL DEFAULT 0, cast INTEGER NOT NULL DEFAULT 0,
  mat TEXT, inc TEXT NOT NULL DEFAULT 'None', sev TEXT NOT NULL DEFAULT 'None',
  descr TEXT, regv TEXT, valid TEXT, ours TEXT,
  by_uid TEXT, by_name TEXT,
  ack TEXT NOT NULL DEFAULT 'Open', ack_by TEXT, ack_at INTEGER
);
CREATE INDEX sit_pu ON sitreps(pu_id, t);

CREATE TABLE audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  actor_uid TEXT, actor TEXT NOT NULL, role TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL, ip TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs
WHEN (SELECT v FROM meta WHERE k='audit_purge') IS NOT '1'
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;

CREATE TABLE outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT, channel TEXT NOT NULL, to_addr TEXT NOT NULL,
  subject TEXT, body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'transactional',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER
);
`
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get();
  let v = row ? row.v : 0;
  if (!row) db.prepare('INSERT INTO schema_version(v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.prepare('UPDATE schema_version SET v=?').run(v + 1); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  /* statement cache + helpers */
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const api = {
    raw: db,
    all: (sql, ...p) => st(sql).all(...p),
    get: (sql, ...p) => st(sql).get(...p),
    run: (sql, ...p) => st(sql).run(...p),
    exec: sql => db.exec(sql),
    tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
    setting(k, def) { const r = st('SELECT v FROM settings WHERE k=?').get(k); return r ? JSON.parse(r.v) : def; },
    setSetting(k, v) { st('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); },
    meta(k) { const r = st('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; },
    setMeta(k, v) { st('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); },
    close: () => db.close()
  };
  return api;
}

module.exports = { open, SCHEMA_VERSION: MIGRATIONS.length };
