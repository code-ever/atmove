#!/usr/bin/env node
'use strict';
/* Import the verified INEC directory from CSV (columns: lga,ward,ward_code,pu,pu_code).
   node scripts/import-directory.js path/to/directory.csv [--remove-placeholders] [--dry-run] */
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../lib/db');
const geo = require('../lib/geo');
const { createAudit } = require('../lib/audit');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/import-directory.js directory.csv [--remove-placeholders] [--dry-run]'); process.exit(1); }
const dbFile = process.env.DB_FILE || path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')), 'atm.db');
const db = open(dbFile); geo.seedLgas(db);
const r = geo.validate(db, fs.readFileSync(file, 'utf8'));
console.log(`${r.ok} of ${r.total} rows valid.`);
if (r.errs.length) { r.errs.slice(0, 50).forEach(e => console.log('  ' + e)); if (r.errs.length > 50) console.log(`  … and ${r.errs.length - 50} more`); console.error('Nothing imported. Fix the file and try again.'); process.exit(1); }
if (process.argv.includes('--dry-run')) { console.log('Dry run: nothing written.'); process.exit(0); }
const c = geo.commit(db, r.rows);
console.log(`Imported ${c.wards} wards and ${c.pus} polling units.`);
const audit = createAudit(db).audit;
audit(null, 'Imported official directory (command line)', `${c.wards} wards, ${c.pus} polling units`);
if (process.argv.includes('--remove-placeholders')) { const x = geo.removeUnusedPlaceholders(db); console.log(`Removed ${x.wards} placeholder wards and ${x.pus} placeholder polling units that nothing referenced.`); audit(null, 'Removed unused placeholder directory records', `${x.wards} wards, ${x.pus} polling units`); }
db.close();
