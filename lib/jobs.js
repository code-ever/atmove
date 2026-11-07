'use strict';
/* Background jobs: scheduled publishing, retention and deletion, cleanup, encrypted backups. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { now, isoDate } = require('./util');

function encryptFile(src, dst, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(fs.readFileSync(src)), c.final()]);
  fs.writeFileSync(dst, Buffer.concat([Buffer.from('ATMB1'), salt, iv, c.getAuthTag(), body]), { mode: 0o600 });
}
function decryptFile(src, dst, passphrase) {
  const b = fs.readFileSync(src);
  if (b.subarray(0, 5).toString() !== 'ATMB1') throw new Error('Not an ATM backup file');
  const salt = b.subarray(5, 21), iv = b.subarray(21, 33), tag = b.subarray(33, 49);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  fs.writeFileSync(dst, Buffer.concat([d.update(b.subarray(49)), d.final()]), { mode: 0o600 });
}
function backup(db, cfg, log) {
  if (!cfg.backupDir) return null;
  fs.mkdirSync(cfg.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const plain = path.join(cfg.backupDir, `atm-${stamp}.db`);
  db.exec(`VACUUM INTO '${plain.replace(/'/g, "''")}'`);
  let out = plain;
  if (cfg.backupKey) { out = plain + '.enc'; encryptFile(plain, out, cfg.backupKey); fs.rmSync(plain); }
  const files = fs.readdirSync(cfg.backupDir).filter(f => /^atm-.*\.db(\.enc)?$/.test(f)).sort();
  files.slice(0, Math.max(0, files.length - cfg.backupKeep)).forEach(f => fs.rmSync(path.join(cfg.backupDir, f), { force: true }));
  log({ level: 'info', msg: 'backup written', file: path.basename(out), encrypted: !!cfg.backupKey });
  return out;
}

function createJobs({ db, cfg, log, audit, api, notifier }) {
  const SYS = { uid: null, name: 'System (scheduled job)', role: 'state' };
  function hourly() {
    const t = now();
    db.run('DELETE FROM sessions WHERE last_seen < ?', t - 24 * 3600e3);
    db.run('DELETE FROM otps WHERE expires < ?', t - 24 * 3600e3);
    db.run("DELETE FROM outbox WHERE status IN ('sent','failed') AND created_at < ?", t - 30 * 864e5);
    /* scheduled articles go live on their date */
    const due = db.all("SELECT id, title FROM articles WHERE status='Scheduled' AND publish_date <= ?", isoDate(t));
    for (const a of due) { db.run("UPDATE articles SET status='Published', updated_at=? WHERE id=?", t, a.id); audit(SYS, 'Scheduled article published', a.title); }
    const ret = Object.assign({}, api.DEFAULTS.ret, db.setting('ret', {}));
    /* rejected applications: erase personal data after the retention period */
    const cutoff = new Date(t - (+ret.rej) * 864e5).toISOString();
    const old = db.all("SELECT uid, member_code FROM users WHERE status='Rejected' AND COALESCE(decided_at, created_at) < ?", cutoff);
    for (const r of old) { api.anonymise(r.uid); audit(SYS, 'Retention: erased rejected application', r.member_code); }
    /* inactive accounts: tell administrators once a month */
    const lastInactive = +db.meta('inactive_notice') || 0;
    if (t - lastInactive > 30 * 864e5) {
      const cut = t - (+ret.inactive) * 30 * 864e5;
      const n = db.get("SELECT COUNT(*) n FROM users u WHERE status='Approved' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.uid=u.uid) AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.actor_uid=u.uid AND a.t > ?)", isoDate(cut), cut).n;
      if (n) db.all("SELECT uid FROM users WHERE role='state' AND status='Approved'").forEach(a => notifier.inApp(a.uid, 'Inactive accounts to review', `${n} approved account(s) have had no activity for ${ret.inactive} months. Review them under User management.`, 'info'));
      db.setMeta('inactive_notice', t);
    }
  }
  function auditRetention(auditApi) {
    const ret = Object.assign({}, api.DEFAULTS.ret, db.setting('ret', {}));
    const id = auditApi.purgeBefore(now() - (+ret.audit) * 365 * 864e5);
    if (id) log({ level: 'info', msg: 'audit retention purge', throughId: id });
  }
  function daily(auditApi) {
    try { auditRetention(auditApi); } catch (e) { log({ level: 'error', msg: 'audit retention failed', err: e.message }); }
    try { backup(db, cfg, log); } catch (e) { log({ level: 'error', msg: 'backup failed', err: e.message }); }
  }
  return { hourly, daily, backup: () => backup(db, cfg, log) };
}
module.exports = { createJobs, backup, encryptFile, decryptFile };
