'use strict';
/* Demonstration data, mirroring the prototype. Loaded only when DEMO_SEED=1 and never in production. */
const { hashPassword } = require('./auth');
const { memberCode, token, uid: mkUid, now } = require('./util');

const DAY = 864e5;
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const ARTICLES = (iso, dOff) => [
  { id: 'n1', title: 'Membership registration opens across Enugu State', cat: 'Announcements', date: iso(dOff(-3)), status: 'Published', featured: 1, author: 'Media Desk', summary: 'Supporters can now register online and be assigned to their LGA, ward and polling unit.', body: ['ATM has opened online membership registration. Supporters choose their LGA, ward and, where they know it, their polling unit, then submit a short form.', 'Each application is reviewed by an administrator before a digital membership card is issued. Registration is a campaign membership step and is separate from INEC voter registration.', 'This is demonstration text. Replace with an approved press release before launch.'] },
  { id: 'n2', title: 'How coordinator appointments work', cat: 'Organisation', date: iso(dOff(-8)), status: 'Published', author: 'Organisation Desk', summary: 'LGA, ward and polling-unit roles are nominated, reviewed and approved. Nobody can appoint themselves.', body: ['Coordinator roles follow the structure: State, LGA, ward, polling unit. LGA coordinators nominate ward coordinators and ward coordinators nominate polling-unit coordinators.', 'Every appointment is approved by the State Administrator and recorded in an audit log.', 'Demonstration text only.'] },
  { id: 'n3', title: 'Town hall planned for Enugu North', cat: 'Events Recap', date: iso(dOff(-12)), status: 'Published', author: 'Events Desk', summary: 'A community town hall will bring members and coordinators together.', body: ['A town hall is scheduled for members in Enugu North. Registration is open to approved members.', 'Demonstration text only.'] },
  { id: 'n4', title: 'Your data, your control: ATM privacy notice', cat: 'Press Releases', date: iso(dOff(-15)), status: 'Published', author: 'Digital Operations', summary: 'What ATM collects, why, and how to correct or delete your information.', body: ['ATM collects only what the platform needs: name, contact details and location in the electoral structure. We do not collect PVC numbers, biometrics or government ID.', 'You can request correction or deletion at any time from your account settings.', 'Demonstration text only. A qualified lawyer must review the final notice under the Nigeria Data Protection Act 2023.'] },
  { id: 'n5', title: 'Volunteer training for ward teams', cat: 'Community', date: iso(dOff(-20)), status: 'Published', author: 'Events Desk', summary: 'Ward teams are invited to short, practical training sessions.', body: ['Training covers how to use the platform, handle member data and file activity reports.', 'Demonstration text only.'] },
  { id: 'n6', title: 'Draft: quarterly organisation update', cat: 'Organisation', date: iso(dOff(2)), status: 'Draft', author: 'Organisation Desk', summary: 'Unpublished draft.', body: ['Work in progress.'] },
  { id: 'n7', title: 'Scheduled: LGA coordinators briefing notes', cat: 'Announcements', date: iso(dOff(5)), status: 'Scheduled', author: 'Media Desk', summary: 'Scheduled for release.', body: ['Scheduled content.'] },
  { id: 'n8', title: 'Awaiting approval: community outreach recap', cat: 'Community', date: iso(dOff(-1)), status: 'In review', author: 'Ward team (Nsukka)', summary: 'Submitted by an LGA coordinator.', body: ['Awaiting approval by a State Administrator.'] }];
const EVENTS = dOff => [
  ['e1', 'Enugu North community town hall', 'Open forum for approved members and coordinators in Enugu North.', dOff(6), 'Venue to be confirmed, Enugu North', 'Events and Logistics', 1, 'Upcoming', 'L04', 300],
  ['e2', 'Coordinator orientation (State)', 'Orientation on the platform, the approval workflow and data protection.', dOff(10), 'ATM State Secretariat (placeholder)', 'Organisation', 0, 'Upcoming', '', 120],
  ['e3', 'Nsukka LGA stakeholders meeting', 'Meeting of ward and polling-unit coordinators in Nsukka.', dOff(4), 'Nsukka LGA venue (placeholder)', 'Nsukka LGA Coordinator', 1, 'Upcoming', 'L13', 80],
  ['e4', 'Ward volunteer training — Nsukka Ward 2', 'Practical training for ward volunteers.', dOff(14), 'Ward hall (placeholder)', 'Nsukka Ward 2', 1, 'Upcoming', 'L13', 60],
  ['e5', 'Digital operations workshop', 'Hands-on session for the digital operations team.', dOff(21), 'Online (link sent to registrants)', 'Digital Operations', 1, 'Upcoming', '', 50],
  ['e6', 'Awgu community outreach', 'Door-to-door membership information outreach.', dOff(0), 'Awgu (various)', 'Awgu LGA Team', 0, 'Ongoing', 'L02', 0],
  ['e7', 'Udi registration drive', 'Assisted registration for members without smartphones.', dOff(-9), 'Udi (placeholder)', 'Udi LGA Team', 0, 'Completed', 'L16', 0],
  ['e8', 'State launch meeting', 'Introduction of the structure and platform.', dOff(-30), 'Enugu (placeholder)', 'State Secretariat', 0, 'Completed', '', 0]];
const MEDIA = [['g1', 'Community meeting, Enugu North', 'Community engagements', 'photo', 'p1'], ['g2', 'Coordinator training session', 'Campaign activities', 'photo', 'p3'], ['g3', 'Town hall highlights', 'Campaign activities', 'video', 'p2'], ['g4', 'Market-day outreach, Nsukka', 'Community engagements', 'photo', 'p4'], ['g5', 'Press briefing', 'Press coverage', 'photo', 'p3'], ['g6', 'Newspaper clipping (placeholder)', 'Press coverage', 'photo', 'p2'], ['g7', 'Registration drive, Udi', 'Campaign activities', 'photo', 'p1'], ['g8', 'Youth volunteers', 'Community engagements', 'photo', 'p4'], ['g9', 'Radio interview clip', 'Press coverage', 'video', 'p3'], ['g10', 'Women leaders forum', 'Community engagements', 'photo', 'p2'], ['g11', 'Ward meeting, Awgu', 'Campaign activities', 'photo', 'p1'], ['g12', 'Platform walkthrough', 'Campaign activities', 'video', 'p4']];

const DEMO_ACCOUNTS = {
  state: { uid: 'u_state', name: 'State Admin (Demo)', phone: '08000000001', email: 'state@atm.example', role: 'state', lga: null, ward: null, pu: null, cat: 'Campaign coordinator', d: -130 },
  lga: { uid: 'u_lga', name: 'Ngozi Onah (Demo)', phone: '08000000002', email: 'lga@atm.example', role: 'lga', lga: 'L13', ward: null, pu: null, cat: 'Campaign coordinator', d: -120 },
  ward: { uid: 'u_ward', name: 'Emeka Agu (Demo)', phone: '08000000003', email: 'ward@atm.example', role: 'ward', lga: 'L13', ward: 'L13W02', pu: null, cat: 'Campaign coordinator', d: -110 },
  pu: { uid: 'u_pu', name: 'Adaeze Nweke (Demo)', phone: '08000000004', email: 'pu@atm.example', role: 'pu', lga: 'L13', ward: 'L13W02', pu: 'L13W02P01', cat: 'Campaign coordinator', d: -100 },
  member: { uid: 'u_mem', name: 'Chinedu Okafor (Demo)', phone: '08000000005', email: 'member@atm.example', role: 'member', lga: 'L04', ward: 'L04W01', pu: 'L04W01P02', cat: 'Volunteer', d: -40 }
};
const DEMO_PASSWORD = 'Demo#1234';

function seedContent(db, { demo }) {
  const NOW = now(); const dOff = n => new Date(NOW + n * DAY); const iso = d => new Date(d).toISOString().slice(0, 10);
  if (!db.get('SELECT COUNT(*) n FROM tasks').n) {
    [['t1', 'lga,ward,pu', 'Submit your weekly activity report', 2], ['t2', 'lga', 'Nominate coordinators for wards without one', 7], ['t3', 'ward,pu', 'Confirm polling-unit contacts are up to date', 5], ['t4', 'pu', 'Record the next planned community activity', 9]]
      .forEach(t => db.run('INSERT INTO tasks(id,roles,title,due) VALUES(?,?,?,?)', t[0], t[1], t[2], iso(dOff(t[3]))));
  }
  if (!demo || db.get('SELECT COUNT(*) n FROM articles').n) return;
  ARTICLES(iso, dOff).forEach(a => db.run('INSERT INTO articles(id,title,cat,summary,body,status,featured,author,publish_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', a.id, a.title, a.cat, a.summary, JSON.stringify(a.body), a.status, a.featured || 0, a.author, a.date, NOW, NOW));
  EVENTS(dOff).forEach(e => db.run('INSERT INTO events(id,title,descr,starts_at,venue,org,reg,status,lga_id,cap) VALUES(?,?,?,?,?,?,?,?,?,?)', e[0], e[1], e[2], e[3].toISOString(), e[4], e[5], e[6], e[7], e[8] || null, e[9]));
  MEDIA.forEach(m => db.run('INSERT INTO media(id,title,cat,type,cls,approved,created_at) VALUES(?,?,?,?,?,1,?)', ...m, NOW));
}

function seedDemo(db, audit) {
  if (db.get("SELECT 1 FROM users WHERE uid='u_state'")) return false;
  const R = rng(20261029), pick = a => a[Math.floor(R() * a.length)], rint = (a, b) => a + Math.floor(R() * (b - a + 1));
  const NOW = now(); const dOff = n => new Date(NOW + n * DAY); const iso = d => new Date(d).toISOString().slice(0, 10);
  const FN = ['Chinedu', 'Ngozi', 'Emeka', 'Chioma', 'Ifeanyi', 'Uche', 'Obiora', 'Adaeze', 'Kelechi', 'Nneka', 'Onyeka', 'Amaka', 'Tochukwu', 'Ebere', 'Chukwuma', 'Ugochi', 'Ikenna', 'Ogechi', 'Somto', 'Nkiruka', 'Ada', 'Obinna', 'Ifunanya', 'Kenechukwu', 'Oluchi', 'Ejike'];
  const LN = ['Okafor', 'Eze', 'Nwosu', 'Ugwu', 'Agu', 'Nnamani', 'Ozor', 'Asogwa', 'Ani', 'Ogbu', 'Chukwu', 'Onah', 'Attama', 'Nweke', 'Odo', 'Aneke', 'Ezugwu', 'Omeje', 'Nnaji', 'Egbo'];
  const MC = ['General member', 'Volunteer', 'Campaign coordinator (requires approval)', 'Media and communications', 'Events and logistics', 'Digital operations'];
  const LGAS = db.all('SELECT id FROM lgas ORDER BY id').map(r => r.id);
  const WARDS = db.all('SELECT id, lga_id lga FROM wards ORDER BY id');
  const PUS = db.all('SELECT id, ward_id ward, lga_id lga FROM polling_units ORDER BY id');
  const wardsOf = l => WARDS.filter(w => w.lga === l), pusOf = w => PUS.filter(p => p.ward === w), pusOfLga = l => PUS.filter(p => p.lga === l);
  const M = []; let phoneN = 100;
  const add = o => { const m = Object.assign({ uid: 'm' + (M.length + 1), name: pick(FN) + ' ' + pick(LN), phone: '0800000' + String(phoneN++).padStart(4, '0'), email: '', cat: 'General member', status: 'Approved', role: 'member', d: -rint(1, 120), verified: true }, o); M.push(m); return m; };
  const rndGeo = () => { const l = pick(LGAS); const w = pick(wardsOf(l)); return { lga: l, ward: w.id, pu: R() > .2 ? pick(pusOf(w.id)).id : null }; };
  const D = {}; for (const [k, a] of Object.entries(DEMO_ACCOUNTS)) D[k] = add(Object.assign({}, a));
  WARDS.forEach(w => { for (let i = 0; i < 2; i++) add(Object.assign(rndGeo(), { lga: w.lga, ward: w.id, pu: R() > .25 ? pick(pusOf(w.id)).id : null })); });
  for (let i = 0; i < 110; i++) add(rndGeo());
  M.forEach(m => { if (m.uid.startsWith('u_')) return; const r = R(); m.status = r < .66 ? 'Approved' : r < .9 ? 'Pending' : r < .96 ? 'Rejected' : 'Suspended'; m.cat = pick(MC); if (m.status === 'Pending') m.d = -rint(0, 14); m.verified = m.status !== 'Pending' || R() > .4; m.email = R() > .5 ? (m.name.split(' ')[0] + rint(1, 99) + '@example.ng').toLowerCase() : ''; });
  const AP = []; let apN = 1;
  const addAppt = (level, geo, m, status, extra = {}) => { const a = Object.assign({ id: 'A' + (apN++), level, geo, member: m.uid, status, d: -rint(2, 60), by: level === 'lga' ? 'Self-application' : 'Nomination', note: '' }, extra); AP.push(a); return a; };
  const byGeo = f => M.filter(m => m.status === 'Approved' && !m.uid.startsWith('u_') && f(m));
  addAppt('lga', 'L13', D.lga, 'Approved'); addAppt('ward', 'L13W02', D.ward, 'Approved', { by: 'Nomination by LGA Coordinator' }); addAppt('pu', 'L13W02P01', D.pu, 'Approved', { by: 'Nomination by Ward Coordinator' });
  LGAS.forEach((l, i) => {
    if (l === 'L13') return; const c = byGeo(m => m.lga === l)[0]; if (!c) return;
    if (l === 'L04') { addAppt('lga', l, c, 'Pending', { note: 'Active volunteer; has organised three ward meetings (demo text).', d: -3 }); const c2 = byGeo(m => m.lga === l)[1]; if (c2) addAppt('lga', l, c2, 'Pending', { note: 'Former ward secretary (demo text).', d: -1 }); return; }
    if (i < 9) { addAppt('lga', l, c, 'Approved'); c.role = 'lga'; }
    else if (l === 'L10' || l === 'L12') addAppt('lga', l, c, 'Pending', { note: 'Self-application (demo text).', d: -5 });
    else if (l === 'L16') addAppt('lga', l, c, 'Rejected', { note: 'Incomplete supporting information.' });
  });
  WARDS.forEach(w => { if (w.id === 'L13W02') return; const r = R(); const c = byGeo(m => m.ward === w.id && m.role === 'member')[0]; if (!c) return; if (r < .35) { addAppt('ward', w.id, c, 'Approved'); c.role = 'ward'; } else if (r < .5) addAppt('ward', w.id, c, 'Pending', { by: 'Nomination by LGA Coordinator' }); });
  PUS.forEach(p => { if (p.id === 'L13W02P01') return; const r = R(); const c = byGeo(m => m.pu === p.id && m.role === 'member')[0]; if (!c) return; if (r < .5) { addAppt('pu', p.id, c, 'Approved'); c.role = 'pu'; } else if (r < .6) addAppt('pu', p.id, c, 'Pending', { by: 'Nomination by Ward Coordinator' }); });
  AP.forEach(a => { a.public = a.status === 'Approved' && R() > .15 ? 1 : 0; });
  const seen = new Set(); M.forEach((m, i) => { if (m.email && seen.has(m.email)) m.email = m.email.replace('@', '.' + i + '@'); if (m.email) seen.add(m.email); });
  const pwDemo = hashPassword(DEMO_PASSWORD);
  db.tx(() => {
    for (const m of M) {
      const demoAcct = m.uid.startsWith('u_');
      db.run(`INSERT INTO users(uid,member_code,name,phone,email,contact,category,status,role,lga_id,ward_id,pu_id,pw_hash,verified_at,card_token,consent_processing_at,consent_updates,consent_version,created_at,demo)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, m.uid, memberCode(), m.name, m.phone, m.email || null, 'SMS', m.cat, m.status, m.role, m.lga || null, m.ward || null, m.pu || null,
        demoAcct ? pwDemo : null, m.verified ? new Date(NOW + m.d * DAY).toISOString() : null, token(24), new Date(NOW + m.d * DAY).toISOString(), 1, 'demo', iso(dOff(m.d)));
    }
    for (const a of AP) db.run('INSERT INTO appointments(id,level,geo_id,uid,status,by_text,note,public,created_at) VALUES(?,?,?,?,?,?,?,?,?)', a.id, a.level, a.geo, a.member, a.status, a.by, a.note, a.public, iso(dOff(a.d)));
    const approved = AP.filter(a => a.status === 'Approved');
    const apGeo = a => a.level === 'lga' ? { lga: a.geo, ward: null, pu: null } : a.level === 'ward' ? { lga: WARDS.find(w => w.id === a.geo).lga, ward: a.geo, pu: null } : (p => ({ lga: p.lga, ward: p.ward, pu: p.id }))(PUS.find(p => p.id === a.geo));
    for (let i = 0; i < 12; i++) { const a = pick(approved); const g = apGeo(a); const m = M.find(x => x.uid === a.member); db.run('INSERT INTO activity_reports(id,level,geo,lga_id,ward_id,pu_id,author_uid,by_name,title,type,date,att,status,summary,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 'r' + (i + 1), a.level, a.geo, g.lga, g.ward, g.pu, m.uid, m.name, pick(['Ward meeting held', 'Door-to-door outreach', 'Volunteer briefing', 'Membership drive', 'Community listening session']), pick(['Meeting', 'Outreach', 'Training', 'Registration drive']), iso(dOff(-rint(0, 25))), rint(8, 140), pick(['Submitted', 'Reviewed', 'Reviewed']), 'Demonstration report summary.', NOW); }
    [['q1', 'u_mem', 'Membership approved', 'Your membership application was approved. Your digital card is ready.', 'ok', -20, 1], ['q2', 'all', 'Town hall in Enugu North', 'Registration is open for the Enugu North community town hall.', 'info', -2, 0], ['q3', 'u_mem', 'Complete your profile', 'Add an email address to receive account alerts.', 'warn', -1, 0], ['q4', 'all', 'Privacy notice updated', 'We updated the privacy notice. Review the changes in Settings.', 'info', -6, 0], ['q5', 'u_lga', 'Ward nomination awaiting review', 'Your nomination for a ward coordinator is awaiting State approval.', 'warn', -2, 0], ['q6', 'u_state', 'Pending approvals', 'Membership and coordinator applications are waiting for review.', 'warn', -1, 0]]
      .forEach(n => { db.run('INSERT INTO notifications(id,to_uid,title,body,type,created_at) VALUES(?,?,?,?,?,?)', n[0], n[1], n[2], n[3], n[4], NOW + n[5] * DAY); if (n[6]) db.run('INSERT INTO notif_reads(nid,uid) VALUES(?,?)', n[0], n[1]); });
    /* election-day situation reports */
    const ST = ['Not yet opened', 'Materials arrived', 'Accreditation started', 'Voting ongoing', 'Voting closed', 'Counting', 'Result announced'];
    const INC = ['Late arrival of materials', 'Technical or BVAS problem', 'Disruption or intimidation', 'Violence', 'Vote-buying report', 'Other'];
    let sn = 1;
    PUS.forEach(p => {
      if (R() < .28) return; const stIdx = rint(0, 6); const n = rint(1, 3);
      for (let k = 0; k < n; k++) {
        const st = ST[Math.max(0, stIdx - (n - 1 - k))]; const accr = stIdx >= 2 ? rint(60, 420) : 0; const cast = stIdx >= 3 ? Math.min(accr, rint(Math.floor(accr * .5), accr)) : 0;
        const hasInc = R() < .12; const inc = hasInc ? pick(INC) : 'None'; const sev = hasInc ? pick(['Low', 'Medium', 'Medium', 'High']) : 'None'; const done = stIdx >= 5 && k === n - 1; const last = k === n - 1;
        db.run('INSERT INTO sitreps(id,pu_id,ward_id,lga_id,t,status,accr,cast,mat,inc,sev,descr,regv,valid,ours,by_uid,by_name,ack) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          'S' + (sn++), p.id, p.ward, p.lga, NOW - rint(5, 420) * 60e3 + k * 600e3, st, accr, cast, R() < .9 ? 'Yes' : 'Partly', last ? inc : 'None', last ? sev : 'None', last && hasInc ? 'Demonstration incident note (no personal details).' : '', String(rint(300, 900)), done ? String(rint(Math.floor(cast * .9), cast)) : '', done ? String(rint(10, Math.floor(cast * .6))) : '', null, 'Polling-unit coordinator (demo)', hasInc && R() < .3 ? 'Acknowledged' : 'Open');
      }
    });
  });
  db.setSetting('elec', { on: true, name: 'General election (demonstration)', date: iso(NOW) });
  const admin = db.get("SELECT * FROM users WHERE uid='u_state'");
  [['Approved membership', 'ATM-ENU-…'], ['Changed role to LGA Coordinator', 'Nsukka'], ['Exported report (aggregate)', 'Members by LGA'], ['Published article', 'Membership registration opens…']].forEach(x => audit(admin, x[0], x[1], 'Success', ''));
  return true;
}

module.exports = { seedDemo, seedContent, DEMO_ACCOUNTS, DEMO_PASSWORD };
