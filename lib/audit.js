'use strict';
const { sha256, now, ROLES } = require('./util');

/* Append-only audit log with a SHA-256 hash chain.
   hash = sha256(prev_hash | t | actor_uid | action | target | outcome). Any edit breaks every later hash. */
function createAudit(db) {
  const GENESIS = '0'.repeat(64);
  const lineHash = e => sha256([e.prev_hash, e.t, e.actor_uid || '', e.action, e.target, e.outcome].join('|'));
  function audit(actor, action, target = '', outcome = 'Success', ip = '') {
    const last = db.get('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
    const prev = last ? last.hash : (db.meta('audit_checkpoint') || GENESIS);
    const e = { t: now(), actor_uid: actor ? actor.uid : null, actor: actor ? actor.name : 'Anonymous', role: actor ? ROLES[actor.role] : '—', action: String(action).slice(0, 200), target: String(target || '').slice(0, 300), outcome, ip: maskIp(ip), prev_hash: prev };
    e.hash = lineHash(e);
    db.run('INSERT INTO audit_logs(t,actor_uid,actor,role,action,target,outcome,ip,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?)', e.t, e.actor_uid, e.actor, e.role, e.action, e.target, e.outcome, e.ip, e.prev_hash, e.hash);
    return e;
  }
  function verify() {
    let prev = db.meta('audit_checkpoint') || GENESIS, n = 0;
    for (const e of db.raw.prepare('SELECT * FROM audit_logs ORDER BY id').iterate()) {
      if (e.prev_hash !== prev || lineHash(e) !== e.hash) return { ok: false, brokenAt: e.id, checked: n };
      prev = e.hash; n++;
    }
    return { ok: true, checked: n };
  }
  /* Retention: delete entries older than the cutoff, keeping the chain verifiable via a checkpoint. */
  function purgeBefore(t) {
    const last = db.get('SELECT hash, id FROM audit_logs WHERE t < ? ORDER BY id DESC LIMIT 1', t);
    if (!last) return 0;
    db.tx(() => { db.setMeta('audit_purge', '1'); db.run('DELETE FROM audit_logs WHERE id <= ?', last.id); db.setMeta('audit_purge', '0'); db.setMeta('audit_checkpoint', last.hash); });
    return last.id;
  }
  return { audit, verify, purgeBefore };
}
/* Keep enough of the IP for abuse investigation without storing it in full. */
function maskIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 2).join('.') + '.•••.' + ip.split('.')[3];
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':•••';
  return ip;
}
module.exports = { createAudit, maskIp };
