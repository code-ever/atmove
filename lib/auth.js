'use strict';
const crypto = require('node:crypto');
const { token, sha256, otpCode, now, safeEq } = require('./util');

/* scrypt password hashing (Node built-in). Format: scrypt$N$r$p$salt$hash */
const N = 16384, R = 8, P = 1, KEYLEN = 64;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw).normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
const DUMMY = hashPassword('dummy-password-for-timing-1');
function verifyPassword(pw, stored) {
  const s = stored || DUMMY; /* always do the work, so timing does not reveal whether the account exists */
  const [alg, n, r, p, salt, h] = s.split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return !!stored && crypto.timingSafeEqual(want, got);
}

function createAuth(db, cfg) {
  const COOKIE = 'atm_sid';
  const idleMs = () => (+db.setting('sec', {}).timeout || 30) * 60e3;
  const ABS_MS = 12 * 3600e3; /* absolute session lifetime */

  function cookieFor(tok, req, maxAge) {
    const secure = cfg.cookieSecure === 'always' || (cfg.cookieSecure !== 'never' && (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted));
    return `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  function startSession(res, req, user, ip) {
    const tok = token(32);
    db.run('INSERT INTO sessions(id,uid,created_at,last_seen,ua,ip) VALUES(?,?,?,?,?,?)', sha256(tok), user.uid, now(), now(), String(req.headers['user-agent'] || '').slice(0, 200), ip);
    res.setHeader('Set-Cookie', cookieFor(tok, req, Math.floor(ABS_MS / 1000)));
    return sha256(tok);
  }
  function readSession(req) {
    const m = /(?:^|;\s*)atm_sid=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '');
    if (!m) return null;
    const id = sha256(m[1]);
    const s = db.get('SELECT * FROM sessions WHERE id=?', id);
    if (!s) return null;
    const t = now();
    if (t - s.last_seen > idleMs() || t - s.created_at > ABS_MS) { db.run('DELETE FROM sessions WHERE id=?', id); return null; }
    const u = db.get('SELECT * FROM users WHERE uid=?', s.uid);
    if (!u || u.status === 'Suspended' || u.status === 'Rejected' || u.status === 'Deleted') { db.run('DELETE FROM sessions WHERE id=?', id); return null; }
    if (t - s.last_seen > 30e3) db.run('UPDATE sessions SET last_seen=? WHERE id=?', t, id);
    return { session: s, user: u };
  }
  function endSession(res, req, sid) {
    if (sid) db.run('DELETE FROM sessions WHERE id=?', sid);
    res.setHeader('Set-Cookie', cookieFor('', req, 0));
  }
  const revokeAll = (uid, exceptSid) => db.run('DELETE FROM sessions WHERE uid=? AND id IS NOT ?', uid, exceptSid || null);

  /* One-time codes: 6 digits, hashed, 10-minute expiry, single use, 5 attempts. */
  function issueOtp(uidv, purpose) {
    db.run('UPDATE otps SET used=1 WHERE uid=? AND purpose=? AND used=0', uidv, purpose);
    const code = cfg.demo ? '123456' : otpCode();
    const ticket = token(24);
    db.run('INSERT INTO otps(uid,purpose,code_hash,ticket_hash,expires,created) VALUES(?,?,?,?,?,?)', uidv, purpose, sha256(uidv + ':' + code), sha256(ticket), now() + 10 * 60e3, now());
    return { code, ticket };
  }
  /* returns 'ok' | 'bad' | 'expired' | 'locked' */
  function checkOtp({ uid: uidv, ticket, purpose, code }) {
    const o = ticket
      ? db.get('SELECT * FROM otps WHERE ticket_hash=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1', sha256(ticket), purpose)
      : db.get('SELECT * FROM otps WHERE uid=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1', uidv, purpose);
    if (!o) return { r: 'expired' };
    if (o.expires < now()) { db.run('UPDATE otps SET used=1 WHERE id=?', o.id); return { r: 'expired' }; }
    if (o.attempts >= 5) { db.run('UPDATE otps SET used=1 WHERE id=?', o.id); return { r: 'locked' }; }
    if (!safeEq(o.code_hash, sha256(o.uid + ':' + String(code || '').trim()))) { db.run('UPDATE otps SET attempts=attempts+1 WHERE id=?', o.id); return { r: 'bad' }; }
    db.run('UPDATE otps SET used=1 WHERE id=?', o.id);
    return { r: 'ok', uid: o.uid };
  }
  const uidForTicket = (ticket, purpose) => { const o = db.get('SELECT uid FROM otps WHERE ticket_hash=? AND purpose=? ORDER BY id DESC LIMIT 1', sha256(ticket || ''), purpose); return o && o.uid; };

  return { startSession, readSession, endSession, revokeAll, issueOtp, checkOtp, uidForTicket };
}

module.exports = { hashPassword, verifyPassword, createAuth };
