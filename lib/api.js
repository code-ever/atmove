'use strict';
/* REST API. Every route checks authentication, role capability and geographic scope on the server.
   The browser only ever receives records the signed-in user is allowed to see. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const U = require('./util');
const { hashPassword, verifyPassword } = require('./auth');
const geo = require('./geo');
const { xlsx } = require('./xlsx');
const { DEMO_ACCOUNTS } = require('./demo');
const { HttpError, bad, V, str, ROLES, can, now, isoDate } = U;

const SIT_ST = ['Not yet opened', 'Materials arrived', 'Accreditation started', 'Voting ongoing', 'Voting closed', 'Counting', 'Result announced'];
const SIT_INC = ['None', 'Late arrival of materials', 'Technical or BVAS problem', 'Disruption or intimidation', 'Violence', 'Vote-buying report', 'Other'];
const ART_CATS = ['Announcements', 'Press Releases', 'Organisation', 'Community', 'Events Recap'];
const MEDIA_CATS = ['Campaign activities', 'Community engagements', 'Press coverage'];
const SUPPORT_CATS = ['Cannot log in', 'Wrong location', 'Card issue', 'Update my details', 'Delete my data', 'Other'];
const CONTACT_TOPICS = ['General enquiry', 'Membership', 'Account problem', 'Media enquiry', 'Report a privacy concern'];
const REPORT_TYPES = ['Meeting', 'Outreach', 'Training', 'Registration drive', 'Community listening session', 'Activity record'];
const ADMIN_REQ = ['Update polling-unit information', 'Need materials', 'Add a volunteer', 'Other'];

const DEFAULTS = {
  cfg: { headline: 'Enugu, organised from the ground up.', lead: 'ATM brings supporters, volunteers and coordinators into one accountable structure across all 17 LGAs, every ward and every polling unit.', slogan: '[Approved slogan placeholder]', c1: '[Candidate name — to be supplied]', c2: '[Candidate name — to be supplied]', contactEmail: 'info@atm.example', contactPhone: '0800 000 9000', address: '[ATM State Secretariat address — to be supplied], Enugu', reg: true },
  sec: { mfa: true, timeout: '30', lock: '5', rate: true },
  ret: { rej: '90', inactive: '24', audit: '7' },
  elec: { on: false, name: 'General election', date: isoDate(Date.now()) },
  palette: {}
};

function createApi({ db, auth, audit, notifier, cfg, log }) {
  const S = k => Object.assign({}, DEFAULTS[k], db.setting(k, {}));
  const uploadsDir = path.join(cfg.dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  /* ---------- shaping ---------- */
  const mask = p => p ? String(p).slice(0, 4) + '•••' + String(p).slice(-4) : '';
  function memberOut(r, viewer) {
    const self = viewer && viewer.uid === r.uid, full = self || (viewer && viewer.role === 'state');
    return { uid: r.uid, id: r.member_code, name: r.name, phone: full ? (r.phone || '') : mask(r.phone), email: full ? (r.email || '') : '', contact: r.contact, cat: r.category, status: r.status, role: r.role, lga: r.lga_id || '', ward: r.ward_id || '', pu: r.pu_id || '', date: r.created_at, verified: !!r.verified_at, token: self ? r.card_token : null, ...(self ? { consentUpdates: !!r.consent_updates, pwSet: !!r.pw_hash } : {}) };
  }
  const geoOf = {
    ward: id => db.get('SELECT * FROM wards WHERE id=?', id),
    pu: id => db.get('SELECT * FROM polling_units WHERE id=?', id),
    lga: id => db.get('SELECT * FROM lgas WHERE id=?', id)
  };
  function apGeo(a) {
    if (a.level === 'lga') return { lga: a.geo_id, ward: null, pu: null };
    if (a.level === 'ward') { const w = geoOf.ward(a.geo_id); return { lga: w && w.lga_id, ward: a.geo_id, pu: null }; }
    const p = geoOf.pu(a.geo_id); return { lga: p && p.lga_id, ward: p && p.ward_id, pu: a.geo_id };
  }
  const apName = a => { const g = apGeo(a); const l = geoOf.lga(g.lga); if (a.level === 'lga') return l ? l.name : a.geo_id; const x = a.level === 'ward' ? geoOf.ward(a.geo_id) : geoOf.pu(a.geo_id); return (l ? l.name : '') + ' / ' + (x ? x.name : a.geo_id); };
  const geoValid = (l, w, p) => !!geoOf.lga(l) && (!w || (geoOf.ward(w) || {}).lga_id === l) && (!p || (!!w && (geoOf.pu(p) || {}).ward_id === w));
  const stateAdmins = () => db.all("SELECT * FROM users WHERE role='state' AND status='Approved'");
  const userBy = uid => db.get('SELECT * FROM users WHERE uid=?', uid);
  const findLogin = id => {
    id = String(id || '').trim().toLowerCase().replace(/[\s-]/g, '');
    if (!id) return null;
    if (id.includes('@')) return db.get("SELECT * FROM users WHERE lower(email)=? AND status<>'Deleted'", id);
    return db.get("SELECT * FROM users WHERE phone=? AND status<>'Deleted'", U.normPhone(id));
  };
  const toPeople = (uids, viewer, aps) => {
    const out = {};
    for (const a of aps) {
      if (out[a.uid]) continue; const m = userBy(a.uid); if (!m) continue;
      const g = apGeo(a);
      const allowed = viewer && (viewer.role === 'state' || U.inScope(viewer, g) || viewer.uid === m.uid);
      out[a.uid] = { uid: m.uid, name: (a.public && a.status === 'Approved') || allowed ? m.name : 'Name not disclosed', id: allowed ? m.member_code : '', phone: allowed ? mask(m.phone) : '', status: allowed ? m.status : '', lga: allowed ? m.lga_id || '' : '', ward: allowed ? m.ward_id || '' : '', pu: allowed ? m.pu_id || '' : '', role: m.role, cat: allowed ? m.category : '', date: allowed ? m.created_at : '', stub: true };
    }
    return out;
  };

  /* ---------- the state snapshot ---------- */
  function snapshot(viewer, session) {
    const out = { app: 'atm-enugu', demo: !!cfg.demo, now: now() };
    if (cfg.demo) out.demoAccounts = Object.fromEntries(Object.entries(DEMO_ACCOUNTS).map(([k, a]) => [k, { phone: a.phone, name: a.name }]));
    out.cfg = S('cfg'); out.palette = S('palette'); out.elec = S('elec');
    out.geo = {
      lgas: db.all('SELECT id,name,official_code official FROM lgas ORDER BY id'),
      wards: db.all('SELECT id,lga_id lga,name,code,official,info_office,info_note FROM wards ORDER BY lga_id,id').map(w => { const o = { id: w.id, lga: w.lga, name: w.name, code: w.code, official: w.official ? w.code : null }; if (viewer && (viewer.role === 'state' || (viewer.role === 'ward' && viewer.ward_id === w.id))) o.info = { office: w.info_office || '', note: w.info_note || '' }; return o; }),
      pus: db.all('SELECT id,ward_id ward,lga_id lga,name,code,official FROM polling_units ORDER BY ward_id,id').map(p => ({ ...p, official: p.official ? p.code : null }))
    };
    const c = { total: 0, approved: 0, pending: 0, lga: {}, ward: {}, pu: {} };
    for (const r of db.all("SELECT status, COUNT(*) n FROM users WHERE status<>'Deleted' GROUP BY status")) { c.total += r.n; if (r.status === 'Approved') c.approved = r.n; if (r.status === 'Pending') c.pending = r.n; }
    for (const k of ['lga', 'ward', 'pu']) for (const r of db.all(`SELECT ${k}_id g, COUNT(*) n FROM users WHERE status NOT IN ('Rejected','Deleted') AND ${k}_id IS NOT NULL GROUP BY ${k}_id`)) c[k][r.g] = r.n;
    out.counts = c;
    out.rsum = Object.fromEntries(db.all('SELECT ward_id w, COUNT(*) n, SUM(att) att FROM activity_reports WHERE ward_id IS NOT NULL GROUP BY ward_id').map(r => [r.w, { n: r.n, att: r.att || 0 }]));
    const today = isoDate(now());
    const artRows = viewer && viewer.role === 'state' ? db.all('SELECT * FROM articles ORDER BY publish_date DESC')
      : db.all("SELECT * FROM articles WHERE status='Published' OR (status='Scheduled' AND publish_date<=?) OR (author_uid IS NOT NULL AND author_uid=?) ORDER BY publish_date DESC", today, viewer ? viewer.uid : '-');
    out.arts = artRows.map(a => ({ id: a.id, title: a.title, cat: a.cat, summary: a.summary, body: JSON.parse(a.body), status: a.status, featured: !!a.featured, author: a.author, date: a.publish_date, img: a.img || '' }));
    out.evts = db.all('SELECT e.*, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id) n, (SELECT 1 FROM event_rsvps r WHERE r.event_id=e.id AND r.uid=?) mine FROM events e ORDER BY starts_at', viewer ? viewer.uid : '-')
      .map(e => ({ id: e.id, title: e.title, desc: e.descr, date: e.starts_at, venue: e.venue, org: e.org, reg: !!e.reg, status: e.status, lga: e.lga_id || '', cap: e.cap, rsvpCount: e.n, mine: !!e.mine }));
    out.media = db.all('SELECT id,title t,cat,type,cls c,url FROM media WHERE approved=1 ORDER BY created_at, id');
    /* appointments */
    let aps;
    if (!viewer || viewer.role === 'member') aps = db.all("SELECT * FROM appointments WHERE status='Approved'");
    else if (viewer.role === 'state') aps = db.all('SELECT * FROM appointments');
    else aps = db.all('SELECT * FROM appointments').filter(a => a.status === 'Approved' || U.inScope(viewer, apGeo(a)) || a.uid === viewer.uid || a.nominated_by === viewer.uid);
    out.ap = aps.map(a => ({ id: a.id, level: a.level, geo: a.geo_id, member: a.uid, status: a.status, date: a.created_at, by: a.by_text || '', note: (viewer && (viewer.role === 'state' || a.nominated_by === viewer.uid)) ? a.note || a.reason || '' : '', public: !!a.public }));
    out.people = toPeople(null, viewer, aps);
    if (!viewer) return out;
    /* signed-in */
    const me = memberOut(viewer, viewer);
    me.sessions = db.all('SELECT id, created_at, last_seen, ua FROM sessions WHERE uid=? ORDER BY last_seen DESC', viewer.uid).map(s => ({ id: s.id.slice(0, 16), current: session && s.id === session.id, ua: s.ua, created: s.created_at, last: s.last_seen }));
    out.me = me;
    let mem;
    if (viewer.role === 'state') mem = db.all("SELECT * FROM users WHERE status<>'Deleted' ORDER BY created_at DESC");
    else if (viewer.role === 'member') mem = [viewer];
    else { const [w, p] = U.scopeSql(viewer); mem = db.all(`SELECT * FROM users WHERE status<>'Deleted' AND (${w} OR uid=?) ORDER BY created_at DESC`, ...p, viewer.uid); }
    out.members = mem.map(m => memberOut(m, viewer));
    if (viewer.role === 'state') { out.sec = S('sec'); out.ret = S('ret'); }
    if (viewer.role !== 'member') {
      const [w, p] = U.scopeSql(viewer);
      out.reports = db.all(`SELECT * FROM activity_reports WHERE ${w} ORDER BY date DESC`, ...p).map(r => ({ id: r.id, level: r.level, geo: r.geo || '', lga: r.lga_id || '', ward: r.ward_id || '', pu: r.pu_id || '', by: r.by_name, title: r.title, type: r.type, date: r.date, att: r.att, status: r.status, summary: r.summary || '' }));
      out.sits = db.all(`SELECT * FROM sitreps WHERE ${w} ORDER BY t`, ...p).map(r => ({ id: r.id, pu: r.pu_id, ward: r.ward_id, lga: r.lga_id, t: r.t, status: r.status, accr: r.accr, cast: r.cast, mat: r.mat, inc: r.inc, sev: r.sev, desc: r.descr || '', regv: r.regv || '', valid: r.valid || '', ours: r.ours || '', by: r.by_name || '', ack: r.ack }));
    } else { out.reports = []; out.sits = []; }
    out.notifs = db.all("SELECT n.*, (SELECT 1 FROM notif_reads r WHERE r.nid=n.id AND r.uid=?) rd FROM notifications n WHERE n.to_uid IN (?, 'all') ORDER BY created_at DESC LIMIT 200", viewer.uid, viewer.uid)
      .map(n => ({ id: n.id, to: n.to_uid === 'all' ? 'all' : viewer.uid, t: n.title, b: n.body, type: n.type, date: n.created_at, read: !!n.rd }));
    out.tasks = db.all('SELECT t.*, (SELECT 1 FROM task_done d WHERE d.task_id=t.id AND d.uid=?) done FROM tasks t ORDER BY due', viewer.uid)
      .filter(t => t.roles.split(',').includes(viewer.role)).map(t => ({ id: t.id, to: t.roles.split(','), t: t.title, due: t.due, done: !!t.done }));
    const tk = viewer.role === 'state' ? db.all('SELECT * FROM tickets ORDER BY created_at DESC LIMIT 1000')
      : viewer.role === 'ward' ? db.all('SELECT * FROM tickets WHERE by_uid=? OR scope_ward=? ORDER BY created_at DESC', viewer.uid, viewer.ward_id)
        : db.all('SELECT * FROM tickets WHERE by_uid=? ORDER BY created_at DESC', viewer.uid);
    out.tickets = tk.map(t => ({ id: t.id, by: t.by_uid || 'public', name: t.name || '', contact: viewer.role === 'state' ? t.contact || '' : '', cat: t.cat, msg: t.message, status: t.status, date: t.created_at, reply: t.reply || '', payload: t.payload ? JSON.parse(t.payload) : null }));
    if (viewer.role === 'state') out.log = db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1500').map(e => ({ id: e.id, t: e.t, actor: e.actor, role: e.role, action: e.action, target: e.target, outcome: e.outcome, ip: e.ip, hash: e.hash.slice(0, 12) }));
    return out;
  }

  /* ---------- routing ---------- */
  const routes = [];
  const R = (method, pattern, opts, fn) => {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, opts, fn });
  };
  const deny = (ctx, what) => { audit(ctx.user, 'Blocked: ' + what, ctx.path, 'Blocked', ctx.ip); return new HttpError(403, 'You do not have permission to do that. The attempt was logged.'); };
  const need = (ctx, c) => { if (!can(ctx.user, c)) throw deny(ctx, 'missing permission ' + c); };
  const A = (ctx, action, target, outcome) => audit(ctx.user, action, target, outcome || 'Success', ctx.ip);
  const limit = (ctx, key, max, win) => { if (!U.rateLimit(key + ':' + ctx.ip, max, win)) throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.'); };
  const notifyAdmins = (title, body, type = 'warn') => stateAdmins().forEach(a => notifier.inApp(a.uid, title, body, type));

  R('GET', '/api/health', () => ({ ok: true, app: 'atm-enugu', version: cfg.version, demo: !!cfg.demo, time: new Date().toISOString() }));
  R('GET', '/api/state', ctx => snapshot(ctx.user, ctx.session));

  /* ===== authentication ===== */
  const unknownFails = new Map();
  R('POST', '/api/auth/login', ctx => {
    limit(ctx, 'login', 30, 10 * 60e3);
    const { id, pw } = ctx.body; if (!id || !pw) throw bad('Enter your phone number or email and your password.');
    const sec = S('sec'); const lockN = +sec.lock || 5;
    const u = findLogin(id);
    if (u && u.locked_until > now()) { A(ctx, 'Login attempt on locked account', u.member_code, 'Blocked'); throw new HttpError(423, 'Too many attempts. This account is temporarily locked.', { until: u.locked_until }); }
    const ok = verifyPassword(String(pw), u && u.pw_hash);
    if (!ok) {
      const key = String(id).toLowerCase().slice(0, 60);
      let fails;
      if (u) { fails = u.failed_logins + 1; db.run('UPDATE users SET failed_logins=? WHERE uid=?', fails, u.uid); }
      else { fails = (unknownFails.get(key) || 0) + 1; unknownFails.set(key, fails); }
      audit(null, 'Failed login', String(id).slice(0, 4) + '…', 'Failed', ctx.ip);
      if (fails >= lockN) {
        const until = now() + 15 * 60e3;
        if (u) db.run('UPDATE users SET failed_logins=0, locked_until=? WHERE uid=?', until, u.uid); else unknownFails.delete(key);
        audit(null, 'Account locked after repeated failures', String(id).slice(0, 4) + '…', 'Blocked', ctx.ip);
        throw new HttpError(423, 'Too many attempts. Locked for 15 minutes.', { until });
      }
      throw new HttpError(401, 'Incorrect details.', { left: lockN - fails });
    }
    if (['Suspended', 'Rejected'].includes(u.status)) { A(ctx, 'Login refused (account ' + u.status.toLowerCase() + ')', u.member_code, 'Blocked'); throw new HttpError(403, 'This account cannot sign in. Contact support.'); }
    db.run('UPDATE users SET failed_logins=0, locked_until=0 WHERE uid=?', u.uid);
    if (u.role === 'state' && sec.mfa) {
      const { code, ticket } = auth.issueOtp(u.uid, 'mfa');
      notifier.sms(u, `ATM sign-in code: ${code}. It expires in 10 minutes. Do not share it.`);
      audit(u, 'Two-step code sent', 'Login', 'Success', ctx.ip);
      return { mfa: true, ticket, hint: cfg.demo ? 'Demo code: 123456' : 'We sent a 6-digit code to your phone.' };
    }
    auth.startSession(ctx.res, ctx.req, u, ctx.ip);
    audit(u, 'Login', 'Session started', 'Success', ctx.ip);
    return { ok: true };
  });
  R('POST', '/api/auth/mfa', ctx => {
    limit(ctx, 'mfa', 20, 10 * 60e3);
    const r = auth.checkOtp({ ticket: ctx.body.ticket, purpose: 'mfa', code: ctx.body.code });
    if (r.r !== 'ok') { audit(null, 'Two-step code rejected', r.r, 'Failed', ctx.ip); throw new HttpError(r.r === 'bad' ? 400 : 410, r.r === 'bad' ? 'That code is incorrect.' : 'That code has expired. Sign in again.'); }
    const u = userBy(r.uid); auth.startSession(ctx.res, ctx.req, u, ctx.ip);
    audit(u, 'Login', 'Session started (two-step)', 'Success', ctx.ip);
    return { ok: true };
  });
  R('POST', '/api/auth/logout', ctx => { if (ctx.user) A(ctx, 'Logout', 'Session ended'); auth.endSession(ctx.res, ctx.req, ctx.session && ctx.session.id); return { ok: true }; });
  R('POST', '/api/auth/forgot', ctx => {
    limit(ctx, 'forgot', 8, 10 * 60e3);
    const u = findLogin(ctx.body.id);
    if (u && u.status !== 'Suspended' && u.phone) { const { code } = auth.issueOtp(u.uid, 'reset'); notifier.sms(u, `ATM password reset code: ${code}. It expires in 10 minutes. If you did not ask for this, ignore it.`); }
    audit(null, 'Password reset requested', 'Generic response shown', 'Success', ctx.ip);
    return { ok: true };
  });
  R('POST', '/api/auth/reset', ctx => {
    limit(ctx, 'reset', 15, 10 * 60e3);
    const { id, code, pw } = ctx.body; const pe = V.pw(pw); if (pe) throw bad(pe, { field: 'pw' });
    const u = findLogin(id);
    const r = u ? auth.checkOtp({ uid: u.uid, purpose: 'reset', code }) : { r: 'bad' };
    if (r.r !== 'ok') { audit(null, 'Password reset code rejected', '', 'Failed', ctx.ip); throw bad('That code is incorrect or has expired.', { field: 'code' }); }
    db.run('UPDATE users SET pw_hash=?, failed_logins=0, locked_until=0 WHERE uid=?', hashPassword(pw), u.uid);
    auth.revokeAll(u.uid);
    audit(u, 'Password reset completed', 'All sessions revoked', 'Success', ctx.ip);
    return { ok: true };
  });
  R('POST', '/api/auth/verify-phone', ctx => {
    limit(ctx, 'verify', 20, 10 * 60e3);
    const r = ctx.user ? auth.checkOtp({ uid: ctx.user.uid, purpose: 'verify', code: ctx.body.code }) : auth.checkOtp({ ticket: ctx.body.ticket, purpose: 'verify', code: ctx.body.code });
    if (r.r !== 'ok') throw bad(r.r === 'bad' ? 'That code is incorrect. Request a new one.' : 'That code has expired. Request a new one.');
    db.run('UPDATE users SET verified_at=? WHERE uid=?', new Date().toISOString(), r.uid);
    audit(userBy(r.uid), 'Phone verified', userBy(r.uid).member_code, 'Success', ctx.ip);
    return { ok: true };
  });
  R('POST', '/api/auth/resend', ctx => {
    limit(ctx, 'resend', 5, 10 * 60e3);
    const uidv = ctx.user ? ctx.user.uid : auth.uidForTicket(ctx.body.ticket, 'verify');
    const u = uidv && userBy(uidv); if (!u) return { ok: true };
    if (u.verified_at) return { ok: true, verified: true };
    const { code, ticket } = auth.issueOtp(u.uid, 'verify'); notifier.sms(u, `ATM verification code: ${code}. It expires in 10 minutes.`);
    return { ok: true, ticket, hint: cfg.demo ? 'Code sent. Demo code: 123456.' : 'Code sent.' };
  });
  R('POST', '/api/auth/password', { auth: 1 }, ctx => {
    const { cur, pw } = ctx.body;
    if (!verifyPassword(String(cur || ''), ctx.user.pw_hash)) { A(ctx, 'Password change refused', 'Wrong current password', 'Failed'); throw bad('Current password is incorrect.', { field: 'cur' }); }
    const pe = V.pw(pw); if (pe) throw bad(pe, { field: 'new' });
    if (pw === cur) throw bad('Choose a password you have not used before.', { field: 'new' });
    db.run('UPDATE users SET pw_hash=? WHERE uid=?', hashPassword(pw), ctx.user.uid);
    auth.revokeAll(ctx.user.uid, ctx.session.id);
    A(ctx, 'Changed password', ctx.user.member_code);
    return { ok: true };
  });
  R('DELETE', '/api/auth/sessions/:sid', { auth: 1 }, ctx => {
    const s = db.all('SELECT id FROM sessions WHERE uid=?', ctx.user.uid).find(x => x.id.startsWith(ctx.params.sid));
    if (!s) throw new HttpError(404, 'Session not found.');
    db.run('DELETE FROM sessions WHERE id=?', s.id); A(ctx, 'Ended a session', 'Account settings');
    return { ok: true };
  });

  /* ===== registration ===== */
  R('POST', '/api/register', ctx => {
    limit(ctx, 'register', 6, 10 * 60e3);
    if (!S('cfg').reg) throw new HttpError(403, 'Registration is closed at the moment.');
    const b = ctx.body; const E = {};
    const name = str(b.name, 80); if (name.length < 3) E.name = 'Enter your full name.';
    const phone = U.normPhone(b.phone); if (!V.phone(phone)) E.phone = 'Enter a valid Nigerian mobile number, e.g. 08012345678.';
    const email = str(b.email, 120).toLowerCase(); if (!V.email(email)) E.email = 'Enter a valid email address.';
    const contact = U.CONTACTS.includes(b.contact) ? b.contact : 'SMS'; if (contact === 'Email' && !email) E.email = 'Add an email address to be contacted by email.';
    const pe = V.pw(b.pw); if (pe) E.pw = pe;
    if (!geoValid(b.lga, b.ward, b.pu || null) || !b.ward) E.ward = 'That combination is not valid. Please reselect.';
    const cat = U.MCATS.includes(b.cat) ? b.cat : 'General member';
    if (!b.c1) E.c1 = 'Consent is required to create a membership record.';
    if (!b.c3) E.c3 = 'Please confirm your details are accurate.';
    if (Object.keys(E).length) throw bad('Please fix the highlighted fields.', { fields: E });
    if (db.get('SELECT 1 FROM users WHERE phone=?', phone)) throw new HttpError(409, 'This number is already registered.', { dup: 'phone' });
    if (email && db.get('SELECT 1 FROM users WHERE lower(email)=?', email)) throw new HttpError(409, 'This email address is already registered.', { dup: 'email' });
    const uidv = U.uid('m'); let code; do { code = U.memberCode(); } while (db.get('SELECT 1 FROM users WHERE member_code=?', code));
    const t = new Date().toISOString();
    db.run(`INSERT INTO users(uid,member_code,name,phone,email,contact,category,status,role,lga_id,ward_id,pu_id,pw_hash,card_token,consent_processing_at,consent_updates,consent_version,created_at)
      VALUES(?,?,?,?,?,?,?,'Pending','member',?,?,?,?,?,?,?,?,?)`, uidv, code, name, phone, email || null, contact, cat, b.lga, b.ward, b.pu || null, hashPassword(b.pw), U.token(24), t, b.c2 ? 1 : 0, cfg.privacyVersion, isoDate(now()));
    const u = userBy(uidv);
    notifier.inApp(uidv, 'Application received', 'Your membership is pending review. We will notify you when it is approved.', 'info');
    audit(u, 'New membership application', code, 'Success', ctx.ip);
    if (/coordinator/i.test(cat)) audit(u, 'Coordinator interest recorded (not appointed)', code, 'Success', ctx.ip);
    const { code: otp, ticket } = auth.issueOtp(uidv, 'verify');
    notifier.sms(u, `Welcome to ATM. Your member ID is ${code}. Phone verification code: ${otp} (expires in 10 minutes).`);
    return { member: memberOut(u, u), ticket };
  });

  /* ===== own account ===== */
  R('PATCH', '/api/me', { auth: 1 }, ctx => {
    const u = ctx.user, b = ctx.body; const E = {}; const set = {};
    if (b.phone !== undefined) { const p = U.normPhone(b.phone); if (!V.phone(p)) E.phone = 'Enter a valid Nigerian mobile number, e.g. 08012345678.'; else if (p !== u.phone) { if (db.get('SELECT 1 FROM users WHERE phone=? AND uid<>?', p, u.uid)) E.phone = 'This number belongs to another account.'; else { set.phone = p; set.verified_at = null; } } }
    if (b.email !== undefined) { const e = str(b.email, 120).toLowerCase(); if (!V.email(e)) E.email = 'Enter a valid email address.'; else if (e && db.get('SELECT 1 FROM users WHERE lower(email)=? AND uid<>?', e, u.uid)) E.email = 'This email belongs to another account.'; else set.email = e || null; }
    if (b.contact !== undefined) { if (!U.CONTACTS.includes(b.contact)) E.contact = 'Choose a contact method.'; else set.contact = b.contact; }
    if (b.updates !== undefined) set.consent_updates = b.updates ? 1 : 0;
    if ((set.contact || u.contact) === 'Email' && !(set.email !== undefined ? set.email : u.email)) E.email = 'Add an email address to be contacted by email.';
    if (Object.keys(E).length) throw bad('Please fix the highlighted fields.', { fields: E });
    const keys = Object.keys(set); if (!keys.length) return { ok: true };
    db.run(`UPDATE users SET ${keys.map(k => k + '=?').join(',')} WHERE uid=?`, ...keys.map(k => set[k]), u.uid);
    let phoneChanged = false;
    if ('phone' in set) { phoneChanged = true; const nu = userBy(u.uid); const { code } = auth.issueOtp(u.uid, 'verify'); notifier.sms(nu, `ATM verification code for your new number: ${code}.`); }
    A(ctx, 'Updated profile', u.member_code + (phoneChanged ? ' · phone changed' : ''));
    return { ok: true, phoneChanged };
  });
  R('GET', '/api/me/export', { auth: 1 }, ctx => {
    const u = ctx.user; A(ctx, 'Exported own data', u.member_code);
    const pick = r => { const o = { ...r }; delete o.pw_hash; delete o.failed_logins; delete o.locked_until; return o; };
    ctx.res.setHeader('Content-Disposition', `attachment; filename="ATM-my-data-${u.member_code}.json"`);
    return { exported_at: new Date().toISOString(), notice: 'Your ATM membership data. Keep it private.', profile: pick(u),
      appointments: db.all('SELECT level, geo_id, status, created_at, decided_at FROM appointments WHERE uid=?', u.uid),
      event_registrations: db.all('SELECT e.title, e.starts_at, r.created_at FROM event_rsvps r JOIN events e ON e.id=r.event_id WHERE r.uid=?', u.uid),
      notifications: db.all('SELECT title, body, created_at FROM notifications WHERE to_uid=?', u.uid),
      support_requests: db.all('SELECT id, cat, message, status, created_at, reply FROM tickets WHERE by_uid=?', u.uid),
      activity_reports: db.all('SELECT title, type, date, att, summary FROM activity_reports WHERE author_uid=?', u.uid),
      sessions: db.all('SELECT created_at, last_seen, ua FROM sessions WHERE uid=?', u.uid) };
  });
  function anonymise(uidv) {
    const u = userBy(uidv); if (!u) return;
    db.tx(() => {
      db.run("UPDATE appointments SET status='Superseded', decided_at=? WHERE uid=? AND status IN ('Approved','Pending')", isoDate(now()), uidv);
      db.run("UPDATE users SET name='Deleted member', phone=NULL, email=NULL, pw_hash=NULL, card_token=NULL, status='Deleted', role='member', consent_updates=0 WHERE uid=?", uidv);
      db.run('DELETE FROM sessions WHERE uid=?', uidv); db.run('DELETE FROM event_rsvps WHERE uid=?', uidv); db.run('DELETE FROM notifications WHERE to_uid=?', uidv); db.run('DELETE FROM otps WHERE uid=?', uidv);
      db.run("UPDATE tickets SET name=NULL, contact=NULL WHERE by_uid=?", uidv);
    });
  }
  R('POST', '/api/me/delete', { auth: 1 }, ctx => {
    if (ctx.body.confirm !== 'DELETE') throw bad('Type DELETE exactly to confirm.');
    if (ctx.user.role === 'state' && db.get("SELECT COUNT(*) n FROM users WHERE role='state' AND status='Approved'").n <= 1) throw bad('You are the only State Administrator. Appoint another before deleting this account.');
    const code = ctx.user.member_code; A(ctx, 'Account deleted (personal data erased)', code);
    anonymise(ctx.user.uid); auth.endSession(ctx.res, ctx.req, null);
    return { ok: true };
  });

  /* ===== public ===== */
  R('GET', '/api/verify/:token', ctx => {
    limit(ctx, 'qr', 60, 60e3);
    const u = db.get('SELECT member_code, status, lga_id FROM users WHERE card_token=?', ctx.params.token);
    if (!u || u.status !== 'Approved') return { valid: false };
    return { valid: true, id: u.member_code, status: 'Active', lga: u.lga_id };
  });
  R('POST', '/api/contact', ctx => {
    limit(ctx, 'contact', 5, 10 * 60e3);
    const b = ctx.body; const E = {};
    const name = str(b.name, 80), contact = str(b.contact, 120), msg = str(b.msg, 3000);
    if (!name) E.name = 'This field is required.'; if (!contact) E.contact = 'Enter a phone number or email so we can reply.'; if (!msg) E.msg = 'This field is required.';
    if (Object.keys(E).length) throw bad('Please fix the highlighted fields.', { fields: E });
    const id = 'MSG-' + U.randId(6);
    db.run('INSERT INTO tickets(id,by_uid,name,contact,cat,message,created_at) VALUES(?,?,?,?,?,?,?)', id, ctx.user ? ctx.user.uid : null, name, contact, CONTACT_TOPICS.includes(b.topic) ? b.topic : 'General enquiry', msg, now());
    notifyAdmins('New contact message', `${id}: ${CONTACT_TOPICS.includes(b.topic) ? b.topic : 'General enquiry'}`, 'info');
    audit(ctx.user, 'Contact message received', id, 'Success', ctx.ip);
    return { id };
  });
  R('POST', '/api/client-event', { auth: 1 }, ctx => {
    limit(ctx, 'cev', 30, 60e3);
    if (ctx.body.kind === 'route-blocked') A(ctx, 'Blocked: forbidden route', str(ctx.body.route, 80), 'Blocked');
    return { ok: true };
  });

  /* ===== member actions ===== */
  R('POST', '/api/tickets', { auth: 1 }, ctx => {
    const msg = str(ctx.body.msg, 3000); if (!msg) throw bad('Describe the problem so we can help.', { fields: { msg: 'Describe the problem so we can help.' } });
    const id = 'TKT-' + U.randId(6); const cat = SUPPORT_CATS.includes(ctx.body.cat) ? ctx.body.cat : 'Other';
    db.run('INSERT INTO tickets(id,by_uid,name,contact,cat,message,created_at) VALUES(?,?,?,?,?,?,?)', id, ctx.user.uid, ctx.user.name, ctx.user.phone, cat, msg, now());
    notifyAdmins('New support request', `${id}: ${cat}`, 'info'); A(ctx, 'Support request', id);
    return { id };
  });
  R('POST', '/api/requests/location', { auth: 1 }, ctx => {
    const b = ctx.body; if (!geoValid(b.lga, b.ward, b.pu || null) || !b.ward) throw bad('That combination is not valid.');
    const why = str(b.why, 1000); if (!why) throw bad('Tell us why the location should change.');
    const id = 'REQ-' + U.randId(6);
    db.run('INSERT INTO tickets(id,by_uid,name,contact,cat,message,payload,created_at) VALUES(?,?,?,?,?,?,?,?)', id, ctx.user.uid, ctx.user.name, ctx.user.phone, 'Location correction', why, JSON.stringify({ type: 'location', lga: b.lga, ward: b.ward, pu: b.pu || '' }), now());
    notifyAdmins('Location correction request', ctx.user.name + ' requested a location change.'); A(ctx, 'Requested location correction', ctx.user.member_code);
    return { id };
  });
  R('POST', '/api/requests/admin', { auth: 1 }, ctx => {
    if (ctx.user.role !== 'pu') throw deny(ctx, 'admin request (not a PU coordinator)');
    const msg = str(ctx.body.msg, 2000); if (!msg) throw bad('Add details.');
    const t = ADMIN_REQ.includes(ctx.body.type) ? ctx.body.type : 'Other'; const id = 'REQ-' + U.randId(6);
    db.run('INSERT INTO tickets(id,by_uid,name,contact,cat,message,scope_ward,created_at) VALUES(?,?,?,?,?,?,?,?)', id, ctx.user.uid, ctx.user.name, ctx.user.phone, 'Administrative request: ' + t, msg, ctx.user.ward_id, now());
    const wc = db.get("SELECT uid FROM appointments WHERE level='ward' AND geo_id=? AND status='Approved'", ctx.user.ward_id);
    if (wc) notifier.inApp(wc.uid, 'Request from a polling unit', `${t}: ${msg.slice(0, 120)}`, 'warn');
    A(ctx, 'Submitted administrative request', t);
    return { id };
  });
  R('POST', '/api/events/:id/rsvp', { auth: 1 }, ctx => {
    const e = db.get('SELECT * FROM events WHERE id=?', ctx.params.id); if (!e) throw new HttpError(404, 'Event not found.');
    if (!e.reg || e.status === 'Completed') throw bad('Registration is not open for this event.');
    if (db.get('SELECT 1 FROM event_rsvps WHERE event_id=? AND uid=?', e.id, ctx.user.uid)) return { ok: true };
    if (e.cap && db.get('SELECT COUNT(*) n FROM event_rsvps WHERE event_id=?', e.id).n >= e.cap) throw bad('This event is full.');
    db.run('INSERT INTO event_rsvps(event_id,uid,created_at) VALUES(?,?,?)', e.id, ctx.user.uid, now());
    notifier.notify(ctx.user, 'Event registration confirmed', `You are registered for ${e.title} on ${isoDate(e.starts_at)}.`, 'ok');
    A(ctx, 'Registered for event', e.title);
    return { ok: true };
  });
  R('DELETE', '/api/events/:id/rsvp', { auth: 1 }, ctx => { db.run('DELETE FROM event_rsvps WHERE event_id=? AND uid=?', ctx.params.id, ctx.user.uid); A(ctx, 'Cancelled event registration', ctx.params.id); return { ok: true }; });
  R('POST', '/api/notifications/read-all', { auth: 1 }, ctx => { db.run("INSERT OR IGNORE INTO notif_reads(nid,uid) SELECT id, ? FROM notifications WHERE to_uid IN (?, 'all')", ctx.user.uid, ctx.user.uid); return { ok: true }; });
  R('POST', '/api/notifications/:id/read', { auth: 1 }, ctx => { const n = db.get("SELECT id FROM notifications WHERE id=? AND to_uid IN (?, 'all')", ctx.params.id, ctx.user.uid); if (n) db.run('INSERT OR IGNORE INTO notif_reads(nid,uid) VALUES(?,?)', n.id, ctx.user.uid); return { ok: true }; });
  R('POST', '/api/tasks/:id/toggle', { auth: 1 }, ctx => {
    const t = db.get('SELECT * FROM tasks WHERE id=?', ctx.params.id); if (!t || !t.roles.split(',').includes(ctx.user.role)) throw deny(ctx, 'task outside role');
    if (db.get('SELECT 1 FROM task_done WHERE task_id=? AND uid=?', t.id, ctx.user.uid)) db.run('DELETE FROM task_done WHERE task_id=? AND uid=?', t.id, ctx.user.uid); else db.run('INSERT INTO task_done(task_id,uid) VALUES(?,?)', t.id, ctx.user.uid);
    return { ok: true };
  });

  /* ===== coordinators ===== */
  R('POST', '/api/reports', { auth: 1 }, ctx => {
    need(ctx, 'report.submit'); const u = ctx.user, b = ctx.body; const E = {};
    const title = str(b.title, 160); if (!title) E.title = 'This field is required.';
    if (!V.date(b.date)) E.date = 'This field is required.';
    if (b.att === '' || b.att === undefined || !V.int(b.att, 0, 1e6)) E.att = 'Enter zero or more.';
    const type = REPORT_TYPES.includes(b.type) ? b.type : 'Meeting';
    const summary = str(b.summary, 3000); if (!summary && type !== 'Activity record') E.summary = 'This field is required.';
    if (Object.keys(E).length) throw bad('Please complete the form.', { fields: E });
    const g = { lga: u.lga_id, ward: u.role === 'lga' ? null : u.ward_id, pu: u.role === 'pu' ? u.pu_id : null };
    const id = U.uid('r');
    db.run('INSERT INTO activity_reports(id,level,geo,lga_id,ward_id,pu_id,author_uid,by_name,title,type,date,att,status,summary,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, u.role, g.pu || g.ward || g.lga, g.lga, g.ward, g.pu, u.uid, u.name, title, type, b.date, +b.att, 'Submitted', summary, now());
    A(ctx, type === 'Activity record' ? 'Recorded activity' : 'Submitted activity report', title);
    return { id };
  });
  R('POST', '/api/nominations', { auth: 1 }, ctx => {
    const { level, geo: g } = ctx.body; const u = ctx.user;
    if (!['ward', 'pu'].includes(level)) throw bad('Unknown level.');
    need(ctx, 'nominate.' + level);
    const place = level === 'ward' ? geoOf.ward(g) : geoOf.pu(g); if (!place) throw bad('Unknown location.');
    const inArea = u.role === 'state' || (level === 'ward' ? place.lga_id === u.lga_id : place.ward_id === u.ward_id);
    if (!inArea) { A(ctx, 'Blocked: nomination outside scope', g, 'Blocked'); throw new HttpError(403, 'That location is outside your area.'); }
    const note = str(ctx.body.note, 1000); if (!note) throw bad('Give a reason for the nomination.', { fields: { why: 'Give a reason for the nomination.' } });
    const m = userBy(ctx.body.member);
    const eligible = m && m.status === 'Approved' && m.role === 'member' && (level === 'ward' ? m.ward_id === g : (m.pu_id === g || m.ward_id === place.ward_id));
    if (!eligible) throw bad('Only approved members of this area can be nominated.');
    if (db.get("SELECT 1 FROM appointments WHERE level=? AND geo_id=? AND status IN ('Approved','Pending')", level, g)) throw bad('This position already has a coordinator or a pending nomination.');
    const id = 'A' + U.randId(8);
    db.run('INSERT INTO appointments(id,level,geo_id,uid,status,by_text,nominated_by,note,public,created_at) VALUES(?,?,?,?,?,?,?,?,1,?)', id, level, g, m.uid, 'Pending', 'Nomination by ' + ROLES[u.role] + ' ' + u.name.replace(' (Demo)', ''), u.uid, note, isoDate(now()));
    notifyAdmins('New coordinator nomination', `${ROLES[u.role]} nominated ${m.name} for ${apName({ level, geo_id: g })}.`);
    A(ctx, 'Submitted coordinator nomination', m.member_code + ' · ' + place.code);
    return { id };
  });
  R('POST', '/api/announcements', { auth: 1 }, ctx => {
    need(ctx, 'content.submit'); const t = str(ctx.body.title, 160), b = str(ctx.body.body, 5000);
    if (!t || !b) throw bad('Add a headline and message.');
    const id = U.uid('n'); const l = geoOf.lga(ctx.user.lga_id);
    db.run("INSERT INTO articles(id,title,cat,summary,body,status,author,author_uid,publish_date,created_at,updated_at) VALUES(?,?,?,?,?,'In review',?,?,?,?,?)", id, t, 'Announcements', b.slice(0, 120), JSON.stringify(b.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)), ctx.user.name.replace(' (Demo)', '') + (l ? ` (${l.name} LGA)` : ''), ctx.user.uid, isoDate(now()), now(), now());
    notifyAdmins('Announcement awaiting review', t); A(ctx, 'Submitted local announcement', t);
    return { id };
  });
  R('PUT', '/api/ward-info', { auth: 1 }, ctx => {
    if (ctx.user.role !== 'ward') throw deny(ctx, 'ward information (not a ward coordinator)');
    db.run('UPDATE wards SET info_office=?, info_note=? WHERE id=?', str(ctx.body.office, 200), str(ctx.body.note, 2000), ctx.user.ward_id);
    A(ctx, 'Updated ward information', (geoOf.ward(ctx.user.ward_id) || {}).code); return { ok: true };
  });

  /* ===== election-day situation reports ===== */
  R('POST', '/api/sitreps', { auth: 1 }, ctx => {
    const u = ctx.user; if (u.role !== 'pu') throw deny(ctx, 'situation report (not a PU coordinator)');
    if (!S('elec').on) throw new HttpError(409, 'Election mode is off.');
    const b = ctx.body; const E = {}; const n = k => b[k] === undefined || b[k] === '' ? 0 : +b[k];
    for (const k of ['accr', 'cast', 'regv', 'valid', 'ours']) if (!V.int(b[k], 0, 1e6)) E[k] = 'Enter zero or more.';
    if (!E.cast && !E.accr && n('cast') > n('accr')) E.cast = 'Ballots cast cannot be more than accredited voters.';
    const status = SIT_ST.includes(b.status) ? b.status : SIT_ST[0];
    const inc = SIT_INC.includes(b.inc) ? b.inc : 'None', sev = ['None', 'Low', 'Medium', 'High'].includes(b.sev) ? b.sev : 'None';
    const desc = str(b.desc, 1500);
    if (inc !== 'None') { if (sev === 'None') E.sev = 'Choose a severity for the incident.'; if (desc.length < 10) E.desc = 'Describe what happened in at least 10 characters.'; } else if (sev !== 'None') E.sev = 'Severity applies only when an incident is selected.';
    if (b.valid && b.ours && +b.ours > +b.valid) E.ours = 'Votes for the candidate cannot exceed total valid votes.';
    if (b.valid && b.regv && +b.valid > +b.regv) E.valid = 'Valid votes cannot exceed registered voters.';
    if (Object.keys(E).length) throw bad('Please fix the highlighted fields.', { fields: E });
    const p = geoOf.pu(u.pu_id); const id = U.uid('S');
    db.run('INSERT INTO sitreps(id,pu_id,ward_id,lga_id,t,status,accr,cast,mat,inc,sev,descr,regv,valid,ours,by_uid,by_name,ack) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, p.id, p.ward_id, p.lga_id, now(), status, n('accr'), n('cast'), ['Yes', 'Partly', 'No'].includes(b.mat) ? b.mat : 'Yes', inc, sev, desc, String(b.regv || ''), String(b.valid || ''), String(b.ours || ''), u.uid, u.name, 'Open');
    A(ctx, 'Submitted situation report', p.code + ' · ' + status + (inc !== 'None' ? ' · incident ' + sev : ''));
    if (sev === 'High' || sev === 'Medium') {
      const to = new Set(stateAdmins().map(a => a.uid));
      for (const a of db.all("SELECT uid FROM appointments WHERE status='Approved' AND ((level='ward' AND geo_id=?) OR (level='lga' AND geo_id=?))", p.ward_id, p.lga_id)) to.add(a.uid);
      to.forEach(t => { const tu = userBy(t); notifier.inApp(t, sev + ' incident reported', `${p.code}: ${inc}.`, 'warn'); if (sev === 'High' && tu) notifier.external(tu, 'High incident', `ATM: High-severity incident at ${p.code}: ${inc}. Open the situation room.`); });
    }
    return { id };
  });
  R('POST', '/api/sitreps/:id/ack', { auth: 1 }, ctx => {
    const r = db.get('SELECT * FROM sitreps WHERE id=?', ctx.params.id);
    if (!r || !U.inScope(ctx.user, { lga: r.lga_id, ward: r.ward_id, pu: r.pu_id }) || ctx.user.role === 'pu') { A(ctx, 'Blocked: incident outside scope', ctx.params.id, 'Blocked'); throw new HttpError(403, 'Outside your area.'); }
    const st = ctx.body.status; if (!['Acknowledged', 'Resolved'].includes(st)) throw bad('Unknown status.');
    if (st === 'Resolved') need(ctx, '*');
    db.run('UPDATE sitreps SET ack=?, ack_by=?, ack_at=? WHERE id=?', st, ctx.user.uid, now(), r.id);
    A(ctx, st + ' incident', (geoOf.pu(r.pu_id) || {}).code + ' · ' + r.inc); return { ok: true };
  });
  R('GET', '/api/sitreps.csv', { auth: 1 }, ctx => {
    if (!['state', 'lga', 'ward'].includes(ctx.user.role)) throw deny(ctx, 'situation export');
    const [w, p] = U.scopeSql(ctx.user, 's.');
    const rows = db.all(`SELECT s.*, l.name lname, wd.name wname, pu.code pcode FROM sitreps s JOIN lgas l ON l.id=s.lga_id JOIN wards wd ON wd.id=s.ward_id JOIN polling_units pu ON pu.id=s.pu_id WHERE ${w} ORDER BY s.t`, ...p);
    A(ctx, 'Exported situation reports', rows.length + ' rows');
    return file(ctx, 'ATM-situation-reports.csv', 'text/csv; charset=utf-8', '﻿' + U.toCSV(['Time', 'LGA', 'Ward', 'Polling unit code', 'Status', 'Accredited', 'Cast', 'Materials', 'Incident', 'Severity', 'Description', 'Valid votes (unofficial)', 'Votes for supported candidate (unofficial)', 'Incident status'],
      [...rows.map(r => [new Date(r.t).toISOString(), r.lname, r.wname, r.pcode, r.status, r.accr, r.cast, r.mat, r.inc, r.sev, r.descr, r.valid, r.ours, r.ack]), [], [confLine(ctx)]]));
  });

  /* ===== State administrator ===== */
  const ST = { auth: 1, cap: '*' };
  R('POST', '/api/admin/members/:uid/decision', ST, ctx => {
    const m = userBy(ctx.params.uid); if (!m) throw new HttpError(404, 'Member not found.');
    if (m.status !== 'Pending') throw bad('This application has already been decided.');
    const d = ctx.body.decision, reason = str(ctx.body.reason, 300);
    if (d === 'Approved') {
      db.run("UPDATE users SET status='Approved', decided_by=?, decided_at=? WHERE uid=?", ctx.user.uid, new Date().toISOString(), m.uid);
      notifier.notify(m, 'Membership approved', 'Your membership was approved. Your digital card is ready.', 'ok');
      A(ctx, 'Approved membership', m.member_code);
    } else if (d === 'Rejected') {
      if (!reason) throw bad('Choose a reason before rejecting.');
      db.run("UPDATE users SET status='Rejected', decided_by=?, decided_at=?, decision_reason=? WHERE uid=?", ctx.user.uid, new Date().toISOString(), reason, m.uid);
      notifier.notify(m, 'Application update', 'Your application was not approved. Reason: ' + reason + '. You can contact support.', 'warn');
      A(ctx, 'Rejected membership', m.member_code + ' · ' + reason);
    } else throw bad('Unknown decision.');
    return { ok: true };
  });
  function setScopeForAppointment(uidv, level, g) {
    if (level === 'lga') { const m = userBy(uidv); const keep = m.lga_id === g; db.run('UPDATE users SET lga_id=?, ward_id=?, pu_id=? WHERE uid=?', g, keep ? m.ward_id : null, keep ? m.pu_id : null, uidv); }
    else if (level === 'ward') { const w = geoOf.ward(g); const m = userBy(uidv); const keep = m.ward_id === g; db.run('UPDATE users SET lga_id=?, ward_id=?, pu_id=? WHERE uid=?', w.lga_id, g, keep ? m.pu_id : null, uidv); }
    else { const p = geoOf.pu(g); db.run('UPDATE users SET lga_id=?, ward_id=?, pu_id=? WHERE uid=?', p.lga_id, p.ward_id, g, uidv); }
  }
  /* A person holds at most one coordinator post. Demote anyone left without one. */
  function supersede(where, params, by) {
    const old = db.all(`SELECT * FROM appointments WHERE status='Approved' AND ${where}`, ...params);
    for (const o of old) {
      db.run("UPDATE appointments SET status='Superseded', decided_by=?, decided_at=? WHERE id=?", by, isoDate(now()), o.id);
      if (!db.get("SELECT 1 FROM appointments WHERE uid=? AND status='Approved'", o.uid)) db.run("UPDATE users SET role='member' WHERE uid=? AND role<>'state'", o.uid);
    }
    return old;
  }
  R('POST', '/api/admin/appointments/:id/decision', ST, ctx => {
    const a = db.get('SELECT * FROM appointments WHERE id=?', ctx.params.id); if (!a) throw new HttpError(404, 'Not found.');
    if (a.status !== 'Pending') throw bad('This application has already been decided.');
    const m = userBy(a.uid); const reason = str(ctx.body.reason, 300);
    if (ctx.body.ok) {
      if (m.status !== 'Approved' && m.status !== 'Pending') throw bad('This member cannot be appointed (account ' + m.status.toLowerCase() + ').');
      db.tx(() => {
        supersede('level=? AND geo_id=? AND id<>?', [a.level, a.geo_id, a.id], ctx.user.uid);
        supersede('uid=? AND id<>?', [m.uid, a.id], ctx.user.uid);
        db.run("UPDATE appointments SET status='Approved', public=1, decided_by=?, decided_at=? WHERE id=?", ctx.user.uid, isoDate(now()), a.id);
        db.run("UPDATE users SET role=?, status=CASE WHEN status='Pending' THEN 'Approved' ELSE status END WHERE uid=?", a.level, m.uid);
        setScopeForAppointment(m.uid, a.level, a.geo_id);
      });
      notifier.notify(userBy(m.uid), 'Coordinator appointment approved', `You are now ${ROLES[a.level]} for ${apName(a)}. Log in again to see your new dashboard.`, 'ok');
    } else {
      if (!reason) throw bad('Add a reason before rejecting.');
      db.run("UPDATE appointments SET status='Rejected', reason=?, decided_by=?, decided_at=? WHERE id=?", reason, ctx.user.uid, isoDate(now()), a.id);
      notifier.notify(m, 'Coordinator application not approved', 'Reason: ' + reason, 'warn');
    }
    A(ctx, (ctx.body.ok ? 'Approved' : 'Rejected') + ' coordinator appointment', `${a.level.toUpperCase()} · ${apName(a)} · ${m.member_code}`);
    return { ok: true };
  });
  R('POST', '/api/admin/members/:uid/role', ST, ctx => {
    const m = userBy(ctx.params.uid); const r = ctx.body.role;
    if (!m || m.status === 'Deleted') throw new HttpError(404, 'Member not found.');
    if (!ROLES[r]) throw bad('Unknown role.');
    if (m.uid === ctx.user.uid) throw bad('You cannot change your own role.');
    if (r === m.role) return { ok: true };
    if (r === 'lga' && !m.lga_id) throw bad('This member has no LGA on record.');
    if (r === 'ward' && !m.ward_id) throw bad('This member has no ward on record.');
    if (r === 'pu' && !m.pu_id) throw bad('This member has no polling unit on record.');
    const states = db.get("SELECT COUNT(*) n FROM users WHERE role='state' AND status<>'Deleted'").n;
    if (r === 'state' && states >= 3) throw bad('Limit of three State Administrators reached.');
    if (m.role === 'state' && states <= 1) throw bad('At least one State Administrator is required.');
    if (r !== 'member' && m.status !== 'Approved') throw bad('Only approved members can hold a role.');
    db.tx(() => {
      supersede('uid=?', [m.uid], ctx.user.uid);
      if (['lga', 'ward', 'pu'].includes(r)) {
        const g = r === 'lga' ? m.lga_id : r === 'ward' ? m.ward_id : m.pu_id;
        supersede('level=? AND geo_id=?', [r, g], ctx.user.uid);
        db.run("INSERT INTO appointments(id,level,geo_id,uid,status,by_text,public,created_at,decided_by,decided_at) VALUES(?,?,?,?,'Approved','Direct appointment by State Administrator',1,?,?,?)", 'A' + U.randId(8), r, g, m.uid, isoDate(now()), ctx.user.uid, isoDate(now()));
      }
      db.run('UPDATE users SET role=? WHERE uid=?', r, m.uid);
      if (r !== m.role) db.run('DELETE FROM sessions WHERE uid=?', m.uid); /* new permissions take effect at next sign-in */
    });
    notifier.inApp(m.uid, 'Your role changed', `You are now ${ROLES[r]}. Sign in again to see your dashboard.`, 'info');
    A(ctx, 'Changed role', `${m.member_code}: ${ROLES[m.role]} → ${ROLES[r]}`);
    return { ok: true };
  });
  R('POST', '/api/admin/members/:uid/suspend', ST, ctx => {
    const m = userBy(ctx.params.uid); if (!m || m.status === 'Deleted') throw new HttpError(404, 'Member not found.');
    if (m.uid === ctx.user.uid) throw bad('You cannot suspend yourself.');
    const next = m.status === 'Suspended' ? 'Approved' : 'Suspended';
    db.run('UPDATE users SET status=? WHERE uid=?', next, m.uid);
    if (next === 'Suspended') db.run('DELETE FROM sessions WHERE uid=?', m.uid);
    A(ctx, next === 'Suspended' ? 'Suspended account' : 'Reinstated account', m.member_code);
    return { ok: true, status: next };
  });
  /* content */
  R('POST', '/api/admin/articles', ST, ctx => {
    const b = ctx.body; const E = {};
    const title = str(b.title, 200), summary = str(b.summary, 400); const body = (Array.isArray(b.body) ? b.body : []).map(s => str(s, 8000)).filter(Boolean).slice(0, 80);
    if (!title) E.title = 'Add a headline.'; if (!summary) E.summary = 'Add a short summary.';
    const action = ['draft', 'review', 'publish'].includes(b.action) ? b.action : 'draft';
    if (action !== 'draft' && !body.length) E.body = 'Write the article body.';
    const date = V.date(b.date) ? b.date : isoDate(now());
    if (b.img && !/^\/uploads\/[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(b.img)) E.img = 'Use an uploaded image.';
    if (Object.keys(E).length) throw bad('Please complete the highlighted fields.', { fields: E });
    const status = action === 'draft' ? 'Draft' : action === 'review' ? 'In review' : (date > isoDate(now()) ? 'Scheduled' : 'Published');
    const cat = ART_CATS.includes(b.cat) ? b.cat : 'Announcements';
    let id = b.id;
    if (id && db.get('SELECT 1 FROM articles WHERE id=?', id)) {
      db.run('UPDATE articles SET title=?, cat=?, summary=?, body=?, status=?, publish_date=?, img=COALESCE(?, img), updated_at=? WHERE id=?', title, cat, summary, JSON.stringify(body.length ? body : ['(No body yet)']), status, date, b.img || null, now(), id);
    } else {
      id = U.uid('n');
      db.run('INSERT INTO articles(id,title,cat,summary,body,status,author,author_uid,publish_date,img,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, title, cat, summary, JSON.stringify(body.length ? body : ['(No body yet)']), status, ctx.user.name.replace(' (Demo)', ''), ctx.user.uid, date, b.img || null, now(), now());
    }
    A(ctx, status === 'Published' ? 'Published article' : status === 'Scheduled' ? 'Scheduled article' : status === 'In review' ? 'Submitted article for approval' : 'Saved article draft', title);
    return { id, status, date };
  });
  R('POST', '/api/admin/articles/:id/status', ST, ctx => {
    const a = db.get('SELECT * FROM articles WHERE id=?', ctx.params.id); if (!a) throw new HttpError(404, 'Not found.');
    const st = ctx.body.status; if (!['Published', 'Archived'].includes(st)) throw bad('Unknown status.');
    db.run('UPDATE articles SET status=?, updated_at=? WHERE id=?', st, now(), a.id);
    A(ctx, st === 'Published' ? 'Approved and published article' : 'Archived article', a.title);
    if (st === 'Published' && a.author_uid) { const au = userBy(a.author_uid); if (au) notifier.inApp(au.uid, 'Your announcement was published', a.title, 'ok'); }
    return { ok: true };
  });
  R('POST', '/api/admin/events', ST, ctx => {
    const b = ctx.body; const E = {};
    for (const [k, l] of [['title', 160], ['desc', 2000], ['venue', 200], ['org', 120]]) if (!str(b[k], l)) E[k] = 'This field is required.';
    if (!V.date(b.date)) E.date = 'This field is required.';
    if (b.lga && !geoOf.lga(b.lga)) E.lga = 'Unknown LGA.';
    if (Object.keys(E).length) throw bad('Please complete the form.', { fields: E });
    const status = ['Upcoming', 'Ongoing', 'Completed'].includes(b.status) ? b.status : 'Upcoming';
    const starts = `${b.date}T10:00:00+01:00`; const cap = V.int(b.cap, 0, 1e6) ? +(b.cap || 0) : 0;
    let id = b.id;
    if (id && db.get('SELECT 1 FROM events WHERE id=?', id)) db.run('UPDATE events SET title=?, descr=?, starts_at=?, venue=?, org=?, reg=?, status=?, lga_id=?, cap=COALESCE(?,cap) WHERE id=?', str(b.title, 160), str(b.desc, 2000), new Date(starts).toISOString(), str(b.venue, 200), str(b.org, 120), b.reg ? 1 : 0, status, b.lga || null, b.cap === undefined ? null : cap, id);
    else { id = U.uid('e'); db.run('INSERT INTO events(id,title,descr,starts_at,venue,org,reg,status,lga_id,cap) VALUES(?,?,?,?,?,?,?,?,?,?)', id, str(b.title, 160), str(b.desc, 2000), new Date(starts).toISOString(), str(b.venue, 200), str(b.org, 120), b.reg ? 1 : 0, status, b.lga || null, cap); }
    A(ctx, b.id ? 'Updated event' : 'Created event', str(b.title, 160));
    return { id };
  });
  /* images: type checked by file signature, size-limited, optional virus scan, stored under random names */
  function saveImage(dataUrl) {
    const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw bad('Use a JPG, PNG or WebP image under 2 MB.');
    const buf = Buffer.from(m[3], 'base64'); if (buf.length > 2 * 1024 * 1024) throw bad('Use a JPG, PNG or WebP image under 2 MB.');
    const sig = buf.subarray(0, 12);
    const kind = sig[0] === 0x89 && sig.toString('latin1', 1, 4) === 'PNG' ? 'png' : (sig[0] === 0xFF && sig[1] === 0xD8 && sig[2] === 0xFF) ? 'jpg' : (sig.toString('latin1', 0, 4) === 'RIFF' && sig.toString('latin1', 8, 12) === 'WEBP') ? 'webp' : null;
    if (!kind) throw bad('That file is not a valid JPG, PNG or WebP image.');
    const name = U.token(16) + '.' + kind; const fp = path.join(uploadsDir, name);
    fs.writeFileSync(fp, buf, { mode: 0o640 });
    if (cfg.scanCmd) { try { execFileSync(cfg.scanCmd, [...cfg.scanArgs, fp], { stdio: 'ignore', timeout: 60e3 }); } catch (e) { fs.rmSync(fp, { force: true }); throw bad('The file failed the security scan.'); } }
    return '/uploads/' + name;
  }
  R('POST', '/api/uploads/image', { auth: 1 }, ctx => { if (!can(ctx.user, '*') && !can(ctx.user, 'content.submit')) throw deny(ctx, 'image upload'); limit(ctx, 'upload', 30, 10 * 60e3); const url = saveImage(ctx.body.dataUrl); A(ctx, 'Uploaded image', url); return { url }; });
  R('POST', '/api/admin/media', ST, ctx => {
    const title = str(ctx.body.title, 160); if (!title) throw bad('Add a caption.');
    const cat = MEDIA_CATS.includes(ctx.body.cat) ? ctx.body.cat : MEDIA_CATS[0];
    const url = saveImage(ctx.body.dataUrl); const id = U.uid('g');
    db.run("INSERT INTO media(id,title,cat,type,cls,url,approved,created_at) VALUES(?,?,?,'photo','p1',?,1,?)", id, title, cat, url, now());
    A(ctx, 'Added media', title); return { id, url };
  });
  R('PATCH', '/api/admin/media/:id', ST, ctx => {
    const cat = ctx.body.cat; if (!MEDIA_CATS.includes(cat)) throw bad('Unknown category.');
    db.run('UPDATE media SET cat=? WHERE id=?', cat, ctx.params.id); A(ctx, 'Changed media category', ctx.params.id + ' → ' + cat); return { ok: true };
  });
  R('DELETE', '/api/admin/media/:id', ST, ctx => {
    const m = db.get('SELECT * FROM media WHERE id=?', ctx.params.id); if (!m) throw new HttpError(404, 'Not found.');
    db.run('DELETE FROM media WHERE id=?', m.id); if (m.url) fs.rmSync(path.join(uploadsDir, path.basename(m.url)), { force: true });
    A(ctx, 'Removed media', m.title); return { ok: true };
  });
  /* audit */
  R('GET', '/api/admin/audit.csv', ST, ctx => {
    const rows = db.all('SELECT * FROM audit_logs ORDER BY id');
    A(ctx, 'Exported audit log', 'CSV · ' + rows.length + ' rows');
    return file(ctx, 'ATM-audit-log.csv', 'text/csv; charset=utf-8', '﻿' + U.toCSV(['ID', 'Time (UTC)', 'Actor', 'Role', 'Action', 'Target', 'Outcome', 'IP (masked)', 'Previous hash', 'Hash'], rows.map(e => [e.id, new Date(e.t).toISOString(), e.actor, e.role, e.action, e.target, e.outcome, e.ip, e.prev_hash, e.hash])));
  });
  R('GET', '/api/admin/audit/verify', ST, ctx => { const r = auditVerify(); A(ctx, 'Verified audit chain', r.ok ? `OK · ${r.checked} entries` : `BROKEN at #${r.brokenAt}`, r.ok ? 'Success' : 'Failed'); return r; });
  /* directory */
  R('POST', '/api/admin/directory/validate', ST, ctx => { const r = geo.validate(db, ctx.body.csv); A(ctx, 'Validated directory import', `${r.ok}/${r.total} rows valid`); return { errs: r.errs, ok: r.ok, total: r.total }; });
  R('POST', '/api/admin/directory/import', ST, ctx => {
    const r = geo.validate(db, ctx.body.csv);
    if (r.errs.length || !r.ok) throw bad('Fix the file and validate again before committing.', { errs: r.errs });
    const c = geo.commit(db, r.rows); A(ctx, 'Imported official directory', `${c.wards} wards, ${c.pus} polling units`);
    return c;
  });
  R('POST', '/api/admin/geo', ST, ctx => {
    const b = ctx.body; const E = {};
    const l = b.lga, w = b.ward || ''; const name = str(b.name, 120); const code = str(b.code, 40).toUpperCase();
    if (!geoOf.lga(l)) E.lga = 'Choose an LGA.'; if (!name) E.name = 'Enter a name.'; if (!code) E.code = 'Enter the official code.';
    if (code && (db.get('SELECT 1 FROM wards WHERE code=?', code) || db.get('SELECT 1 FROM polling_units WHERE code=?', code))) E.code = 'That code already exists. Codes must be unique.';
    if (w && (geoOf.ward(w) || {}).lga_id !== l) E.ward = 'This ward does not belong to the selected LGA.';
    if (!E.name && !w && db.get('SELECT 1 FROM wards WHERE lga_id=? AND lower(name)=?', l, name.toLowerCase())) E.name = 'A ward with this name already exists in this LGA.';
    if (!E.name && w && db.get('SELECT 1 FROM polling_units WHERE ward_id=? AND lower(name)=?', w, name.toLowerCase())) E.name = 'A polling unit with this name already exists in this ward.';
    if (Object.keys(E).length) throw bad('Please fix the highlighted fields.', { fields: E });
    const id = w ? geo.addPu(db, w, name, code) : geo.addWard(db, l, name, code);
    A(ctx, w ? 'Added polling unit' : 'Added ward', code); return { id };
  });
  /* settings */
  R('PUT', '/api/admin/settings', ST, ctx => {
    const b = ctx.body; const changed = [];
    if (b.cfg) { const c = S('cfg'); for (const k of ['headline', 'lead', 'slogan', 'c1', 'c2', 'contactEmail', 'contactPhone', 'address']) if (typeof b.cfg[k] === 'string') c[k] = str(b.cfg[k], k === 'lead' ? 600 : 200); if (typeof b.cfg.reg === 'boolean') c.reg = b.cfg.reg; db.setSetting('cfg', c); changed.push('Site text'); }
    if (b.sec) { const s = S('sec'); if (typeof b.sec.mfa === 'boolean') s.mfa = b.sec.mfa; if (['15', '30', '60'].includes(String(b.sec.timeout))) s.timeout = String(b.sec.timeout); if (['3', '5', '8'].includes(String(b.sec.lock))) s.lock = String(b.sec.lock); db.setSetting('sec', s); changed.push('Security policy'); }
    if (b.ret) { const r = S('ret'); if (['30', '90', '180'].includes(String(b.ret.rej))) r.rej = String(b.ret.rej); if (['12', '24', '36'].includes(String(b.ret.inactive))) r.inactive = String(b.ret.inactive); if (['3', '7'].includes(String(b.ret.audit))) r.audit = String(b.ret.audit); db.setSetting('ret', r); changed.push('Retention rules'); }
    if (b.palette) { const p = {}; for (const k of ['--brand', '--gold', '--ink', '--surface']) if (/^#[0-9a-fA-F]{6}$/.test(b.palette[k] || '')) p[k] = b.palette[k]; db.setSetting('palette', p); changed.push('Brand palette'); }
    if (!changed.length) throw bad('Nothing to save.');
    A(ctx, 'Changed settings', changed.join(', ')); return { ok: true };
  });
  R('POST', '/api/admin/election', ST, ctx => {
    const e = S('elec'); e.on = !!ctx.body.on; if (ctx.body.name) e.name = str(ctx.body.name, 120); if (V.date(ctx.body.date)) e.date = ctx.body.date;
    db.setSetting('elec', e); A(ctx, e.on ? 'Election mode turned on' : 'Election mode turned off', e.name); return e;
  });
  /* report export: aggregate tables only, confidentiality line, logged */
  const confLine = ctx => `Confidential · ATM Enugu · Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC by ${ctx.user.name} (${ctx.user.member_code}) · Do not share outside ATM · Not INEC data`;
  R('POST', '/api/admin/export', ST, ctx => {
    const b = ctx.body; const fmt = ['csv', 'html', 'xlsx'].includes(b.fmt) ? b.fmt : 'csv';
    const head = (Array.isArray(b.head) ? b.head : []).slice(0, 30).map(h => str(h, 80)); const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 50000).map(r => (Array.isArray(r) ? r : []).slice(0, 30).map(c => typeof c === 'number' ? c : str(c, 300)));
    if (!head.length) throw bad('Nothing to export.');
    const title = str(b.title, 120) || 'Report'; const slug = str(b.type, 30).replace(/[^a-z0-9-]/gi, '') || 'report'; const meta = confLine(ctx);
    A(ctx, 'Exported report', `${title} (${fmt.toUpperCase()}, ${rows.length} rows)`);
    if (fmt === 'xlsx') return file(ctx, `ATM-${slug}-report.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx({ sheet: title, head, rows, footer: meta }));
    if (fmt === 'csv') return file(ctx, `ATM-${slug}-report.csv`, 'text/csv; charset=utf-8', '﻿' + U.toCSV(head, [...rows, [], [meta]]));
    const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return file(ctx, `ATM-${slug}-report.html`, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><title>ATM report</title><style>body{font:14px Arial;margin:32px}h1{color:#0B5D3B}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:6px 8px;text-align:left}th{background:#eef3f0}small{color:#555}@media print{body{margin:12mm}}</style><h1>ATM · ${e(title)}</h1><table><tr>${head.map(h => `<th>${e(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${e(c)}</td>`).join('')}</tr>`).join('')}</table><p><small>${e(meta)}</small></p>`);
  });
  /* support inbox */
  R('POST', '/api/admin/tickets/:id/close', ST, ctx => {
    const t = db.get('SELECT * FROM tickets WHERE id=?', ctx.params.id); if (!t) throw new HttpError(404, 'Not found.');
    const reply = str(ctx.body.reply, 2000); let applied = '';
    if (ctx.body.apply) {
      const p = t.payload ? JSON.parse(t.payload) : null; const m = t.by_uid && userBy(t.by_uid);
      if (!p || p.type !== 'location' || !m) throw bad('This request has no change to apply.');
      if (!geoValid(p.lga, p.ward, p.pu || null)) throw bad('The requested location is no longer valid.');
      if (m.role !== 'member') throw bad('This person is a coordinator. Change their appointment first, then apply the location.');
      db.run('UPDATE users SET lga_id=?, ward_id=?, pu_id=? WHERE uid=?', p.lga, p.ward, p.pu || null, m.uid); applied = ' · location updated';
    }
    db.run("UPDATE tickets SET status='Closed', reply=?, closed_by=?, closed_at=? WHERE id=?", reply || null, ctx.user.uid, now(), t.id);
    if (t.by_uid && (reply || applied)) { const m = userBy(t.by_uid); if (m) notifier.notify(m, 'Reply to your request ' + t.id, (applied ? 'Your location was updated. ' : '') + (reply || ''), 'info'); }
    A(ctx, 'Closed support request', t.id + applied); return { ok: true };
  });

  /* ---------- dispatcher ---------- */
  const auditVerify = () => require('./audit').createAudit(db).verify();
  function file(ctx, name, type, data) { return { __file: true, name, type, data }; }
  async function handle(req, res, url, ip) {
    const method = req.method, p = url.pathname;
    const route = routes.find(r => r.method === method && r.re.test(p));
    if (!route) throw new HttpError(404, 'Not found.');
    const m = route.re.exec(p); const params = {}; route.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
    const sess = auth.readSession(req);
    const ctx = { req, res, ip, path: p, params, query: url.searchParams, user: sess && sess.user, session: sess && sess.session, body: {} };
    if (method !== 'GET') {
      if (req.headers['x-atm'] !== '1') throw new HttpError(403, 'Missing request header.');
      const origin = req.headers.origin;
      if (origin) { let ok; try { ok = cfg.origins.length ? cfg.origins.includes(origin) : new URL(origin).host === req.headers.host; } catch (_) { ok = false; } if (!ok) throw new HttpError(403, 'Cross-origin request refused.'); }
      ctx.body = await readJson(req, cfg.maxBody);
    }
    if (!U.rateLimit('api:' + ip, cfg.rateApi, 60e3)) throw new HttpError(429, 'Too many requests. Slow down.');
    if (route.opts.auth && !ctx.user) { audit(null, 'Blocked: unauthenticated access', p, 'Blocked', ip); throw new HttpError(401, 'Please log in to continue.'); }
    if (route.opts.cap) need(ctx, route.opts.cap);
    return route.fn(ctx);
  }
  function readJson(req, max) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', c => { n += c.length; if (n > max) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { if (!n) return resolve({}); try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch (e) { reject(bad('Invalid JSON.')); } });
      req.on('error', reject);
    });
  }
  return { handle, snapshot, anonymise, DEFAULTS };
}
module.exports = { createApi, DEFAULTS };
