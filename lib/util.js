'use strict';
const crypto = require('node:crypto');

const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randId = (n = 6) => Array.from(crypto.randomBytes(n), b => ALPH[b % ALPH.length]).join('');
const memberCode = () => 'ATM-ENU-' + randId(6);
const uid = (p = 'u') => p + '_' + crypto.randomBytes(9).toString('base64url');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const otpCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
const isoDate = d => new Date(d).toISOString().slice(0, 10);
const now = () => Date.now();
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ---------- validation (mirrors the client rules) ---------- */
const normPhone = p => String(p || '').replace(/[\s-]/g, '').replace(/^\+234/, '0');
const V = {
  phone: v => /^0[789][01]\d{8}$/.test(normPhone(v)),
  email: v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim()),
  pw: v => {
    v = String(v || '');
    if (v.length < 8) return 'Use at least 8 characters.';
    if (v.length > 200) return 'Password is too long.';
    if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return 'Include at least one letter and one number.';
    if (/^0\d{10}$/.test(v) || /ATM-ENU/i.test(v)) return 'Do not use a phone number or member ID as a password.';
    return null;
  },
  date: v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v)),
  oneOf: (v, list) => list.includes(v),
  int: (v, min = 0, max = 1e9) => v === '' || v === null || v === undefined ? true : (Number.isInteger(+v) && +v >= min && +v <= max)
};
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

const ROLES = { state: 'State Administrator', lga: 'LGA Coordinator', ward: 'Ward Coordinator', pu: 'Polling-Unit Coordinator', member: 'General Member' };
const CAPS = { state: ['*'], lga: ['report.submit', 'nominate.ward', 'content.submit', 'scope.read'], ward: ['report.submit', 'nominate.pu', 'scope.read'], pu: ['report.submit', 'scope.read'], member: [] };
const can = (u, c) => !!u && (CAPS[u.role].includes('*') || CAPS[u.role].includes(c));
const MCATS = ['General member', 'Volunteer', 'Campaign coordinator (requires approval)', 'Media and communications', 'Events and logistics', 'Digital operations'];
const CONTACTS = ['SMS', 'WhatsApp', 'Phone call', 'Email'];

/* Scope: a record {lga,ward,pu} is visible to a coordinator only inside their own area. */
function inScope(u, r) {
  if (!u) return false;
  if (u.role === 'state') return true;
  if (u.role === 'lga') return !!u.lga_id && r.lga === u.lga_id;
  if (u.role === 'ward') return !!u.ward_id && r.ward === u.ward_id;
  if (u.role === 'pu') return !!u.pu_id && r.pu === u.pu_id;
  return false;
}
/* SQL fragment for scoped queries on tables with lga_id/ward_id/pu_id columns */
function scopeSql(u, prefix = '') {
  if (u.role === 'state') return ['1=1', []];
  if (u.role === 'lga') return [`${prefix}lga_id=?`, [u.lga_id]];
  if (u.role === 'ward') return [`${prefix}ward_id=?`, [u.ward_id]];
  if (u.role === 'pu') return [`${prefix}pu_id=?`, [u.pu_id]];
  return ['0=1', []];
}

/* ---------- rate limiting (in-memory sliding window) ---------- */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now(); let b = buckets.get(key);
  if (!b || t - b.start > windowMs) { b = { start: t, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.start > 3600e3) buckets.delete(k); }, 600e3).unref();

/* ---------- CSV ---------- */
const csvEsc = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = (head, rows) => [head, ...rows].map(r => r.map(csvEsc).join(',')).join('\r\n');
function parseCSV(txt) { /* simple RFC4180 parser */
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (m, extra) => new HttpError(400, m, extra);

module.exports = { randId, memberCode, uid, token, sha256, otpCode, isoDate, now, safeEq, normPhone, V, str, ROLES, CAPS, can, MCATS, CONTACTS, inScope, scopeSql, rateLimit, csvEsc, toCSV, parseCSV, HttpError, bad };
