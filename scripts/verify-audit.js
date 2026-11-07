#!/usr/bin/env node
'use strict';
/* Verify the audit-log hash chain. Exit code 0 = intact, 2 = tampered. */
const path = require('node:path');
const { open } = require('../lib/db');
const { createAudit } = require('../lib/audit');
const db = open(process.env.DB_FILE || path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')), 'atm.db'));
const r = createAudit(db).verify();
if (r.ok) console.log(`Audit chain intact: ${r.checked} entries verified.`); else console.error(`AUDIT CHAIN BROKEN at entry #${r.brokenAt} (after ${r.checked} good entries). Investigate immediately.`);
db.close(); process.exit(r.ok ? 0 : 2);
