'use strict';
/* End-to-end API tests: node --test test/  (spins up a demo server on a random port with a temporary database) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-test-'));
process.env.SKIP_PLACEHOLDERS = '';
const { createApp } = require('../server');
const app = createApp({ demo: true, dataDir: dir, dbFile: path.join(dir, 'atm.db'), backupDir: path.join(dir, 'bk'), backupKey: 'test-passphrase', rateApi: 100000 });
let base;
test.before(() => new Promise(r => app.server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + app.server.address().port; r(); })));
test.after(() => { app.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, p, body, raw) => {
    const h = { 'X-ATM': '1' }; if (cookie) h.Cookie = cookie; if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    if (raw) return r;
    const j = await r.json().catch(() => ({})); return { s: r.status, j };
  };
  return { get: p => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p), raw: (m, p, b) => call(m, p, b, true) };
}
async function login(phone, pw = 'Demo#1234') {
  const c = client(); let r = await c.post('/api/auth/login', { id: phone, pw });
  if (r.j.mfa) r = await c.post('/api/auth/mfa', { ticket: r.j.ticket, code: '123456' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); return c;
}
const PHONES = { state: '08000000001', lga: '08000000002', ward: '08000000003', pu: '08000000004', member: '08000000005' };

test('public snapshot exposes no member records', async () => {
  const c = client(); const r = await c.get('/api/state');
  assert.equal(r.s, 200); assert.equal(r.j.members, undefined); assert.ok(r.j.counts.total > 100);
  assert.ok(r.j.geo.lgas.length === 17);
  for (const p of Object.values(r.j.people)) assert.equal(p.id, '', 'member codes hidden from the public');
  assert.ok(r.j.ap.every(a => a.status === 'Approved'));
});

test('mutating requests need the X-ATM header (CSRF guard)', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  const r2 = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ATM': '1', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r2.status, 403);
});

test('wrong passwords count down, then lock the account', async () => {
  const c = client();
  let r = await c.post('/api/auth/login', { id: '08000000005', pw: 'nope12345' });
  assert.equal(r.s, 401); assert.equal(r.j.left, 4);
  for (let i = 0; i < 3; i++) await c.post('/api/auth/login', { id: '08000000005', pw: 'nope12345' });
  r = await c.post('/api/auth/login', { id: '08000000005', pw: 'nope12345' });
  assert.equal(r.s, 423);
  r = await c.post('/api/auth/login', { id: '08000000005', pw: 'Demo#1234' });
  assert.equal(r.s, 423, 'correct password still refused while locked');
  app.db.run("UPDATE users SET locked_until=0, failed_logins=0 WHERE phone='08000000005'");
});

test('member sees only their own record and cannot reach admin routes', async () => {
  const c = await login(PHONES.member);
  const r = await c.get('/api/state');
  assert.equal(r.j.members.length, 1); assert.equal(r.j.members[0].uid, 'u_mem'); assert.ok(r.j.me.token);
  const d = await c.post('/api/admin/members/m10/decision', { decision: 'Approved' });
  assert.equal(d.s, 403);
  const log = app.db.get("SELECT * FROM audit_logs WHERE action LIKE 'Blocked:%' ORDER BY id DESC LIMIT 1");
  assert.match(log.action, /missing permission/);
});

test('LGA coordinator is confined to their LGA, with masked phones', async () => {
  const c = await login(PHONES.lga);
  const r = await c.get('/api/state');
  assert.ok(r.j.members.length > 3);
  assert.ok(r.j.members.every(m => m.lga === 'L13'));
  const other = r.j.members.find(m => m.uid !== 'u_lga'); assert.match(other.phone, /•••/); assert.equal(other.email, '');
  const n = await c.post('/api/nominations', { level: 'ward', geo: 'L04W01', member: 'u_mem', note: 'test' });
  assert.equal(n.s, 403);
  const n2 = await c.post('/api/nominations', { level: 'pu', geo: 'L13W02P02', member: 'x', note: 'test' });
  assert.equal(n2.s, 403, 'LGA coordinators cannot nominate PU coordinators');
});

test('State admin needs a two-step code and can approve a pending member', async () => {
  const c = client();
  const r = await c.post('/api/auth/login', { id: 'state@atm.example', pw: 'Demo#1234' });
  assert.equal(r.j.mfa, true);
  const bad = await c.post('/api/auth/mfa', { ticket: r.j.ticket, code: '000000' }); assert.equal(bad.s, 400);
  const ok = await c.post('/api/auth/mfa', { ticket: r.j.ticket, code: '123456' }); assert.equal(ok.s, 200);
  const st = await c.get('/api/state'); const p = st.j.members.find(m => m.status === 'Pending');
  assert.ok(st.j.log.length > 0);
  const d = await c.post(`/api/admin/members/${p.uid}/decision`, { decision: 'Approved' }); assert.equal(d.s, 200);
  const again = await c.post(`/api/admin/members/${p.uid}/decision`, { decision: 'Approved' }); assert.equal(again.s, 400);
  const outbox = app.db.get('SELECT * FROM outbox WHERE uid=? ORDER BY id DESC', p.uid); assert.match(outbox.body, /approved/i);
  const rej = await c.post(`/api/admin/members/${st.j.members.find(m => m.status === 'Pending' && m.uid !== p.uid).uid}/decision`, { decision: 'Rejected' });
  assert.equal(rej.s, 400, 'reason required');
});

test('registration → duplicate check → phone verification → login while pending', async () => {
  const c = client();
  const body = { name: 'Test Person', phone: '0803 123 4567', email: 'test@example.ng', contact: 'SMS', pw: 'Secret123', lga: 'L13', ward: 'L13W02', pu: 'L13W02P01', cat: 'Volunteer', c1: true, c3: true };
  const bad = await c.post('/api/register', { ...body, ward: 'L04W01' }); assert.equal(bad.s, 400); assert.ok(bad.j.fields.ward);
  const r = await c.post('/api/register', body); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.match(r.j.member.id, /^ATM-ENU-/); assert.equal(r.j.member.status, 'Pending');
  const dup = await c.post('/api/register', body); assert.equal(dup.s, 409);
  const v = await c.post('/api/auth/verify-phone', { ticket: r.j.ticket, code: '123456' }); assert.equal(v.s, 200);
  const l = await login('08031234567', 'Secret123'); const s = await l.get('/api/state');
  assert.equal(s.j.me.verified, true); assert.equal(s.j.me.status, 'Pending');
  const u = app.db.get("SELECT pw_hash FROM users WHERE phone='08031234567'"); assert.match(u.pw_hash, /^scrypt\$/);
});

test('password reset is non-enumerating and revokes sessions', async () => {
  const c = client();
  const a = await c.post('/api/auth/forgot', { id: '08099999999' }); assert.equal(a.s, 200);
  const b = await c.post('/api/auth/forgot', { id: '08031234567' }); assert.deepEqual(a.j, b.j);
  const s1 = await login('08031234567', 'Secret123');
  const wrong = await c.post('/api/auth/reset', { id: '08031234567', code: '111111', pw: 'NewSecret456' }); assert.equal(wrong.s, 400);
  const ok = await c.post('/api/auth/reset', { id: '08031234567', code: '123456', pw: 'NewSecret456' }); assert.equal(ok.s, 200);
  const after = await s1.get('/api/state'); assert.equal(after.j.me, undefined, 'old session revoked');
  await login('08031234567', 'NewSecret456');
});

test('situation reports flow from polling unit to ward, LGA and State', async () => {
  const pu = await login(PHONES.pu);
  const bad = await pu.post('/api/sitreps', { status: 'Voting ongoing', accr: 10, cast: 20 }); assert.equal(bad.s, 400); assert.ok(bad.j.fields.cast);
  const r = await pu.post('/api/sitreps', { status: 'Voting ongoing', accr: 120, cast: 80, inc: 'Disruption or intimidation', sev: 'High', desc: 'Crowd pushed into the queue area.' });
  assert.equal(r.s, 200);
  const ward = await login(PHONES.ward); const ws = await ward.get('/api/state');
  assert.ok(ws.j.sits.some(s => s.id === r.j.id)); assert.ok(ws.j.sits.every(s => s.ward === 'L13W02'));
  assert.ok(ws.j.notifs.some(n => /High incident/.test(n.t)));
  const res = await ward.post(`/api/sitreps/${r.j.id}/ack`, { status: 'Resolved' }); assert.equal(res.s, 403, 'only State resolves');
  const ack = await ward.post(`/api/sitreps/${r.j.id}/ack`, { status: 'Acknowledged' }); assert.equal(ack.s, 200);
  const mem = await login(PHONES.member); assert.equal((await mem.post('/api/sitreps', { status: 'Voting ongoing' })).s, 403);
  const csv = await ward.raw('GET', '/api/sitreps.csv'); assert.equal(csv.status, 200); assert.match(await csv.text(), /Confidential/);
});

test('nomination by ward coordinator → State approval changes the role and scope', async () => {
  const ward = await login(PHONES.ward); const st = await ward.get('/api/state');
  const vacant = st.j.geo.pus.filter(p => p.ward === 'L13W02').find(p => !st.j.ap.some(a => a.level === 'pu' && a.geo === p.id && ['Approved', 'Pending'].includes(a.status)));
  const cand = st.j.members.find(m => m.status === 'Approved' && m.role === 'member' && m.ward === 'L13W02');
  assert.ok(vacant && cand, 'demo data has a vacant PU and an eligible member');
  const n = await ward.post('/api/nominations', { level: 'pu', geo: vacant.id, member: cand.uid, note: 'Reliable volunteer.' }); assert.equal(n.s, 200, JSON.stringify(n.j));
  const admin = await login(PHONES.state);
  assert.equal((await admin.post(`/api/admin/appointments/${n.j.id}/decision`, { ok: true })).s, 200);
  const u = app.db.get('SELECT role, pu_id FROM users WHERE uid=?', cand.uid); assert.equal(u.role, 'pu'); assert.equal(u.pu_id, vacant.id);
});

test('role rules: cannot change own role; at least one State admin', async () => {
  const admin = await login(PHONES.state);
  assert.equal((await admin.post('/api/admin/members/u_state/role', { role: 'member' })).s, 400);
  const r = await admin.post('/api/admin/members/u_mem/role', { role: 'ward' }); assert.equal(r.s, 200);
  assert.equal(app.db.get("SELECT role FROM users WHERE uid='u_mem'").role, 'ward');
  assert.equal((await admin.post('/api/admin/members/u_mem/role', { role: 'member' })).s, 200);
});

test('content: drafts stay private, published articles are public', async () => {
  const admin = await login(PHONES.state);
  const d = await admin.post('/api/admin/articles', { title: 'Private draft', summary: 's', body: ['b'], action: 'draft' }); assert.equal(d.s, 200);
  const p = await admin.post('/api/admin/articles', { title: 'Hello Enugu', summary: 's', body: ['b'], action: 'publish' }); assert.equal(p.j.status, 'Published');
  const pub = await client().get('/api/state');
  assert.ok(pub.j.arts.some(a => a.title === 'Hello Enugu')); assert.ok(!pub.j.arts.some(a => a.title === 'Private draft'));
  const lga = await login(PHONES.lga); assert.equal((await lga.post('/api/announcements', { title: 'Local news', body: 'Meeting on Friday.' })).s, 200);
  assert.ok(!(await client().get('/api/state')).j.arts.some(a => a.title === 'Local news'));
});

test('image upload checks the file signature', async () => {
  const admin = await login(PHONES.state);
  const png = 'data:image/png;base64,' + Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8FFFF3F0005FE02FEA7D6A1D20000000049454E44AE426082', 'hex').toString('base64');
  const ok = await admin.post('/api/uploads/image', { dataUrl: png }); assert.equal(ok.s, 200); assert.match(ok.j.url, /^\/uploads\/.+\.png$/);
  const img = await fetch(base + ok.j.url); assert.equal(img.headers.get('content-type'), 'image/png');
  const fake = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await admin.post('/api/uploads/image', { dataUrl: fake })).s, 400);
  const mem = await login(PHONES.member); assert.equal((await mem.post('/api/uploads/image', { dataUrl: png })).s, 403);
});

test('report export produces a real .xlsx and is logged', async () => {
  const admin = await login(PHONES.state);
  const r = await admin.raw('POST', '/api/admin/export', { title: 'Membership totals by LGA', type: 'lga', fmt: 'xlsx', head: ['LGA', 'Members'], rows: [['Nsukka', 24], ['Udi', 17]] });
  assert.equal(r.status, 200); const b = Buffer.from(await r.arrayBuffer()); assert.equal(b.subarray(0, 2).toString(), 'PK');
  assert.ok(app.db.get("SELECT 1 FROM audit_logs WHERE action='Exported report' AND target LIKE '%XLSX%'"));
});

test('directory import validates before committing', async () => {
  const admin = await login(PHONES.state);
  const badCsv = 'lga,ward,ward_code,pu,pu_code\nAtlantis,Ward 1,OFF-9,PU 1,OFF-9-1';
  assert.equal((await admin.post('/api/admin/directory/import', { csv: badCsv })).s, 400);
  const good = 'lga,ward,ward_code,pu,pu_code\nNsukka,Ward 9,OFF-0001,PU 1,OFF-0001-001\nNsukka,Ward 9,OFF-0001,PU 2,OFF-0001-002';
  const r = await admin.post('/api/admin/directory/import', { csv: good }); assert.equal(r.s, 200); assert.deepEqual(r.j, { wards: 1, pus: 2 });
  assert.equal((await admin.post('/api/admin/directory/import', { csv: good })).j.pus, 0, 'idempotent');
});

test('account deletion erases personal data but keeps the audit trail', async () => {
  const c = await login('08031234567', 'NewSecret456');
  assert.equal((await c.post('/api/me/delete', { confirm: 'nope' })).s, 400);
  assert.equal((await c.post('/api/me/delete', { confirm: 'DELETE' })).s, 200);
  const u = app.db.get("SELECT * FROM users WHERE name='Deleted member'"); assert.ok(u); assert.equal(u.phone, null); assert.equal(u.pw_hash, null);
  assert.equal((await client().post('/api/auth/login', { id: '08031234567', pw: 'NewSecret456' })).s, 401);
});

test('audit chain verifies, and tampering is detected', async () => {
  assert.equal(app.auditApi.verify().ok, true);
  const admin = await login(PHONES.state); assert.equal((await admin.get('/api/admin/audit/verify')).j.ok, true);
  assert.throws(() => app.db.run("UPDATE audit_logs SET action='x' WHERE id=1"), /append-only/);
  app.db.exec('DROP TRIGGER audit_no_update'); app.db.run("UPDATE audit_logs SET target='tampered' WHERE id=2");
  const v = app.auditApi.verify(); assert.equal(v.ok, false); assert.equal(v.brokenAt, 2);
});

test('encrypted backup round-trips', async () => {
  const { decryptFile } = require('../lib/jobs');
  const f = app.jobs.backup(); assert.match(f, /\.db\.enc$/);
  const out = path.join(dir, 'restored.db'); decryptFile(f, out, 'test-passphrase');
  const { open } = require('../lib/db'); const d = open(out); assert.ok(d.get('SELECT COUNT(*) n FROM users').n > 100); d.close();
});
