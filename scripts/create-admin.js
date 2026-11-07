#!/usr/bin/env node
'use strict';
/* Create a State Administrator account.
   node scripts/create-admin.js --name "Full Name" --phone 08012345678 [--email a@b.ng]
   The password is read from the terminal (not echoed) or from ADMIN_PASSWORD. */
const path = require('node:path');
const readline = require('node:readline');
const { open } = require('../lib/db');
const { hashPassword } = require('../lib/auth');
const { createAudit } = require('../lib/audit');
const U = require('../lib/util');
const geo = require('../lib/geo');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const dbFile = process.env.DB_FILE || path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')), 'atm.db');

function askHidden(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a); });
  });
}
(async () => {
  const name = arg('name'), phone = U.normPhone(arg('phone') || ''), email = (arg('email') || '').toLowerCase();
  if (!name || !U.V.phone(phone)) { console.error('Usage: node scripts/create-admin.js --name "Full Name" --phone 08012345678 [--email you@example.ng]'); process.exit(1); }
  const pw = process.env.ADMIN_PASSWORD || await askHidden('Password (min 8, letter + number): ');
  const pe = U.V.pw(pw); if (pe) { console.error(pe); process.exit(1); }
  const db = open(dbFile); geo.seedLgas(db);
  if (db.get('SELECT 1 FROM users WHERE phone=?', phone)) { console.error('That phone number is already registered.'); process.exit(1); }
  if (db.get("SELECT COUNT(*) n FROM users WHERE role='state' AND status<>'Deleted'").n >= 3) { console.error('Limit of three State Administrators reached.'); process.exit(1); }
  const uidv = U.uid('m'), code = U.memberCode(), t = new Date().toISOString();
  db.run("INSERT INTO users(uid,member_code,name,phone,email,contact,category,status,role,pw_hash,verified_at,card_token,consent_processing_at,consent_version,created_at) VALUES(?,?,?,?,?,'SMS','Campaign coordinator','Approved','state',?,?,?,?,?,?)",
    uidv, code, name, phone, email || null, hashPassword(pw), t, U.token(24), t, process.env.PRIVACY_VERSION || '2026-draft', t.slice(0, 10));
  createAudit(db).audit(null, 'State Administrator created from the command line', code);
  console.log(`Created State Administrator ${name} (${code}). Sign in with ${phone}.`);
  db.close();
})();
