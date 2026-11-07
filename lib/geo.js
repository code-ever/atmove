'use strict';
/* Geographic directory: Enugu State → LGA → ward → polling unit.
   Placeholder records exist only until the verified INEC directory is imported. */
const { parseCSV } = require('./util');

const LGA_NAMES = ['Aninri', 'Awgu', 'Enugu East', 'Enugu North', 'Enugu South', 'Ezeagu', 'Igbo-Etiti', 'Igbo-Eze North', 'Igbo-Eze South', 'Isi-Uzo', 'Nkanu East', 'Nkanu West', 'Nsukka', 'Oji River', 'Udenu', 'Udi', 'Uzo-Uwani'];
const pad = (n, l = 2) => String(n).padStart(l, '0');

function seedLgas(db) {
  if (db.get('SELECT COUNT(*) n FROM lgas').n) return;
  LGA_NAMES.forEach((n, i) => db.run('INSERT INTO lgas(id,name) VALUES(?,?)', 'L' + pad(i + 1), n));
}
/* Same placeholder structure as the prototype, so demo IDs line up. */
function seedPlaceholders(db) {
  if (db.get('SELECT COUNT(*) n FROM wards').n) return;
  db.tx(() => {
    LGA_NAMES.forEach((_, i) => {
      const lid = 'L' + pad(i + 1); const nw = 3 + (i % 2);
      for (let w = 1; w <= nw; w++) {
        const wid = lid + 'W' + pad(w);
        db.run('INSERT INTO wards(id,lga_id,name,code,official) VALUES(?,?,?,?,0)', wid, lid, `Ward ${w} (placeholder)`, `DEMO-${wid}`);
        const np = 2 + ((i + w) % 2);
        for (let p = 1; p <= np + 1; p++) db.run('INSERT INTO polling_units(id,ward_id,lga_id,name,code,official) VALUES(?,?,?,?,?,0)', wid + 'P' + pad(p), wid, lid, `Polling Unit ${p} (placeholder)`, `DEMO-${wid}P${pad(p)}`);
      }
    });
  });
}

/* Validate an import file. Columns: lga, ward, ward_code, pu, pu_code */
function validate(db, txt) {
  const rows = parseCSV(String(txt || '').replace(/^﻿/, ''));
  const errs = []; const need = ['lga', 'ward', 'ward_code', 'pu', 'pu_code'];
  const head = (rows[0] || []).map(s => s.trim().toLowerCase());
  if (need.join() !== head.join()) return { errs: ['Header must be exactly: ' + need.join(',')], ok: 0, total: 0, rows: [] };
  const lgas = Object.fromEntries(db.all('SELECT id,name FROM lgas').map(l => [l.name.toLowerCase(), l.id]));
  const wc = {}, pc = {}; const good = [];
  rows.slice(1).forEach((c, i) => {
    c = c.map(s => s.trim()); const n = i + 2; let isBad = false;
    if (c.length !== 5 || c.some(x => !x)) { errs.push(`Line ${n}: all five columns are required.`); return; }
    const [lga, ward, wcode, pu, pcode] = c; const lid = lgas[lga.toLowerCase()];
    if (!lid) { errs.push(`Line ${n}: LGA “${lga}” does not exist in Enugu State.`); isBad = true; }
    const key = lga.toLowerCase() + '|' + ward.toLowerCase();
    if (wc[wcode] && wc[wcode] !== key) { errs.push(`Line ${n}: ward code ${wcode} already belongs to ${wc[wcode].replace('|', ' / ')}.`); isBad = true; }
    wc[wcode] = wc[wcode] || key;
    if (pc[pcode]) { errs.push(`Line ${n}: duplicate polling-unit code ${pcode} (first seen on line ${pc[pcode]}).`); isBad = true; }
    pc[pcode] = pc[pcode] || n;
    if (!pcode.startsWith(wcode)) { errs.push(`Line ${n}: polling-unit code ${pcode} does not start with its ward code ${wcode}.`); isBad = true; }
    const exW = db.get('SELECT w.*, l.name lname FROM wards w JOIN lgas l ON l.id=w.lga_id WHERE w.code=?', wcode);
    if (exW && (exW.lga_id !== lid || exW.name.toLowerCase() !== ward.toLowerCase())) { errs.push(`Line ${n}: ward code ${wcode} is already used by ${exW.lname} / ${exW.name}.`); isBad = true; }
    const exP = db.get('SELECT p.id, w.code wcode FROM polling_units p JOIN wards w ON w.id=p.ward_id WHERE p.code=?', pcode);
    if (exP && exP.wcode !== wcode) { errs.push(`Line ${n}: polling-unit code ${pcode} already exists in another ward.`); isBad = true; }
    if (!isBad) good.push({ lid, ward, wcode, pu, pcode });
  });
  return { errs, ok: good.length, total: rows.length - 1, rows: good };
}

function nextId(db, table, parentCol, parentId, prefix) {
  const ids = db.all(`SELECT id FROM ${table} WHERE ${parentCol}=?`, parentId).map(r => +r.id.slice(prefix.length) || 0);
  return prefix + pad((ids.length ? Math.max(...ids) : 0) + 1);
}
function addWard(db, lid, name, code, official = 1) {
  const id = nextId(db, 'wards', 'lga_id', lid, lid + 'W');
  db.run('INSERT INTO wards(id,lga_id,name,code,official) VALUES(?,?,?,?,?)', id, lid, name, code, official ? 1 : 0); return id;
}
function addPu(db, wid, name, code, official = 1) {
  const w = db.get('SELECT * FROM wards WHERE id=?', wid);
  const id = nextId(db, 'polling_units', 'ward_id', wid, wid + 'P');
  db.run('INSERT INTO polling_units(id,ward_id,lga_id,name,code,official) VALUES(?,?,?,?,?,?)', id, wid, w.lga_id, name, code, official ? 1 : 0); return id;
}
/* Commit validated rows. Existing codes are skipped (idempotent re-imports). */
function commit(db, rows) {
  let wards = 0, pus = 0;
  db.tx(() => {
    for (const r of rows) {
      let w = db.get('SELECT id FROM wards WHERE code=?', r.wcode);
      if (!w) { w = { id: addWard(db, r.lid, r.ward, r.wcode) }; wards++; }
      if (!db.get('SELECT 1 FROM polling_units WHERE code=?', r.pcode)) { addPu(db, w.id, r.pu, r.pcode); pus++; }
    }
  });
  return { wards, pus };
}
/* Remove placeholder wards and polling units that nothing references (used once, before launch). */
function removeUnusedPlaceholders(db) {
  return db.tx(() => {
    const p = db.run(`DELETE FROM polling_units WHERE official=0 AND id NOT IN (SELECT pu_id FROM users WHERE pu_id IS NOT NULL)
      AND id NOT IN (SELECT geo_id FROM appointments WHERE level='pu') AND id NOT IN (SELECT pu_id FROM sitreps)`).changes;
    const w = db.run(`DELETE FROM wards WHERE official=0 AND id NOT IN (SELECT ward_id FROM polling_units) AND id NOT IN (SELECT ward_id FROM users WHERE ward_id IS NOT NULL)
      AND id NOT IN (SELECT geo_id FROM appointments WHERE level='ward')`).changes;
    return { wards: w, pus: p };
  });
}
module.exports = { LGA_NAMES, seedLgas, seedPlaceholders, validate, commit, addWard, addPu, removeUnusedPlaceholders };
