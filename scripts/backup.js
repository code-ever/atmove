#!/usr/bin/env node
'use strict';
/* Backups.
   node scripts/backup.js                      write a backup now (BACKUP_DIR, optional BACKUP_KEY encryption)
   node scripts/backup.js --restore FILE OUT   decrypt/copy a backup to OUT (stop the server, then replace data/atm.db) */
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../lib/db');
const { backup, decryptFile } = require('../lib/jobs');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const cfg = { backupDir: process.env.BACKUP_DIR || path.join(dataDir, 'backups'), backupKey: process.env.BACKUP_KEY || '', backupKeep: +(process.env.BACKUP_KEEP || 14) };
const i = process.argv.indexOf('--restore');
if (i > 0) {
  const src = process.argv[i + 1], out = process.argv[i + 2];
  if (!src || !out) { console.error('Usage: node scripts/backup.js --restore backup-file output.db'); process.exit(1); }
  if (src.endsWith('.enc')) { if (!cfg.backupKey) { console.error('Set BACKUP_KEY to decrypt.'); process.exit(1); } decryptFile(src, out, cfg.backupKey); } else fs.copyFileSync(src, out);
  const db = open(out); const n = db.get('SELECT COUNT(*) n FROM users').n; db.close();
  console.log(`Restored to ${out} (${n} users). Stop the server, move it to ${path.join(dataDir, 'atm.db')}, delete any atm.db-wal/-shm files, then start the server.`);
} else {
  const db = open(process.env.DB_FILE || path.join(dataDir, 'atm.db'));
  const f = backup(db, cfg, o => console.log(o.msg, o.file || ''));
  db.close(); console.log('Backup:', f);
}
