#!/usr/bin/env node
'use strict';
/* ATM Enugu Platform server. Node 22.5+ with no npm dependencies.
   Start:  node server.js        (reads .env if present)
   Demo:   DEMO_SEED=1 node server.js                                                  */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ---------- configuration ---------- */
(function loadEnv() { const f = path.join(__dirname, '.env'); if (!fs.existsSync(f)) return; for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } })();
const env = (k, d) => process.env[k] ?? d;
const cfg = {
  version: require('./package.json').version,
  port: +env('PORT', 3000), host: env('HOST', '0.0.0.0'),
  production: env('NODE_ENV') === 'production',
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, 'data'))),
  demo: env('DEMO_SEED') === '1',
  trustProxy: env('TRUST_PROXY') === '1',
  cookieSecure: env('COOKIE_SECURE', 'auto'), /* auto | always | never */
  origins: env('ALLOWED_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean),
  maxBody: 4 * 1024 * 1024, rateApi: +env('RATE_API_PER_MIN', 600),
  privacyVersion: env('PRIVACY_VERSION', '2026-draft'),
  providers: { sms: env('SMS_PROVIDER', 'console'), email: env('EMAIL_PROVIDER', 'console') },
  termiiKey: env('TERMII_API_KEY', ''), termiiSender: env('TERMII_SENDER_ID', 'ATM'),
  resendKey: env('RESEND_API_KEY', ''), mailFrom: env('MAIL_FROM', 'ATM Enugu <no-reply@example.org>'),
  scanCmd: env('SCAN_CMD', ''), scanArgs: env('SCAN_ARGS', '--no-summary').split(' ').filter(Boolean),
  backupDir: env('BACKUP_DIR', ''), backupKey: env('BACKUP_KEY', ''), backupKeep: +env('BACKUP_KEEP', 14)
};
cfg.dbFile = env('DB_FILE', path.join(cfg.dataDir, 'atm.db'));
const log = o => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

if (cfg.production && cfg.demo) { console.error('Refusing to start: DEMO_SEED=1 is not allowed with NODE_ENV=production.'); process.exit(1); }
if (cfg.production && cfg.providers.sms === 'console') log({ level: 'warn', msg: 'SMS_PROVIDER=console in production: codes are printed to the log, not delivered.' });

/* ---------- boot ---------- */
const { open } = require('./lib/db');
const { createAuth, hashPassword } = require('./lib/auth');
const { createAudit } = require('./lib/audit');
const { createNotifier } = require('./lib/notify');
const { createApi } = require('./lib/api');
const { createJobs } = require('./lib/jobs');
const geo = require('./lib/geo');
const { seedDemo, seedContent } = require('./lib/demo');
const U = require('./lib/util');

function createApp(over = {}) {
  const c = Object.assign({}, cfg, over);
  const db = open(c.dbFile);
  const auditApi = createAudit(db); const audit = auditApi.audit;
  geo.seedLgas(db);
  if (!db.get('SELECT COUNT(*) n FROM wards').n && env('SKIP_PLACEHOLDERS') !== '1') geo.seedPlaceholders(db);
  seedContent(db, { demo: c.demo });
  if (c.demo && seedDemo(db, audit)) log({ level: 'warn', msg: 'Demo data loaded. Demo password: Demo#1234. Never use this database in production.' });
  /* first administrator from the environment (only when none exists) */
  if (!db.get("SELECT 1 FROM users WHERE role='state'") && env('ADMIN_PHONE') && env('ADMIN_PASSWORD')) {
    const pe = U.V.pw(env('ADMIN_PASSWORD')); if (pe) { console.error('ADMIN_PASSWORD: ' + pe); process.exit(1); }
    const uidv = U.uid('m');
    db.run("INSERT INTO users(uid,member_code,name,phone,email,contact,category,status,role,pw_hash,verified_at,card_token,consent_processing_at,consent_version,created_at) VALUES(?,?,?,?,?,'SMS','Campaign coordinator','Approved','state',?,?,?,?,?,?)",
      uidv, U.memberCode(), env('ADMIN_NAME', 'State Administrator'), U.normPhone(env('ADMIN_PHONE')), env('ADMIN_EMAIL', '') || null, hashPassword(env('ADMIN_PASSWORD')), new Date().toISOString(), U.token(24), new Date().toISOString(), c.privacyVersion, U.isoDate(Date.now()));
    audit(null, 'First State Administrator created from environment', env('ADMIN_PHONE').slice(0, 4) + '…');
    log({ level: 'warn', msg: 'First State Administrator created. Remove ADMIN_PASSWORD from the environment now.' });
  }
  if (!db.get("SELECT 1 FROM users WHERE role='state'")) log({ level: 'warn', msg: 'No State Administrator yet. Run: node scripts/create-admin.js' });

  const auth = createAuth(db, c);
  const notifier = createNotifier(db, c, log);
  const api = createApi({ db, auth, audit, notifier, cfg: c, log });
  const jobs = createJobs({ db, cfg: c, log, audit, api, notifier });

  /* the single-page app, with a CSP that pins the exact inline script by hash */
  const htmlFile = path.join(__dirname, 'public', 'index.html');
  let html, csp;
  function loadHtml() {
    html = fs.readFileSync(htmlFile, 'utf8');
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
    csp = [`default-src 'self'`, `script-src 'self' ${hashes.join(' ')} https://cdnjs.cloudflare.com`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, `font-src https://fonts.gstatic.com`, `img-src 'self' data: blob:`, `connect-src 'self'`, `frame-src 'self'`, `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`].join('; ');
  }
  loadHtml();
  const uploadsDir = path.join(c.dataDir, 'uploads');
  const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  const sec = res => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); if (c.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); };

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const ip = c.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    let url; try { url = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400).end(); return; }
    sec(res);
    res.on('finish', () => { if (url.pathname.startsWith('/api/') || res.statusCode >= 400) log({ level: res.statusCode >= 500 ? 'error' : 'info', method: req.method, path: url.pathname.replace(/\/[A-Za-z0-9_-]{20,}/g, '/:id'), status: res.statusCode, ms: Date.now() - t0 }); });
    try {
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        const out = await api.handle(req, res, url, ip);
        if (out && out.__file) { res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.name}"` }); res.end(out.data); }
        else { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(out ?? { ok: true })); }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!c.production) loadHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : html); return;
      }
      const up = /^\/uploads\/([A-Za-z0-9_-]+)\.(png|jpg|webp)$/.exec(url.pathname);
      if (up) { const fp = path.join(uploadsDir, up[1] + '.' + up[2]); if (fs.existsSync(fp)) { res.writeHead(200, { 'Content-Type': TYPES[up[2]], 'Cache-Control': 'public, max-age=604800, immutable', 'Content-Security-Policy': "default-src 'none'" }); fs.createReadStream(fp).pipe(res); return; } }
      if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('User-agent: *\nDisallow: /api/\n'); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log({ level: 'error', msg: 'unhandled', err: e.stack });
      if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: status >= 500 ? 'Something went wrong. Try again.' : e.message, ...(e.extra || {}) })); }
    }
  });
  server.headersTimeout = 20e3; server.requestTimeout = 30e3;
  const timers = [];
  function startJobs() {
    timers.push(setInterval(() => notifier.work().catch(e => log({ level: 'error', msg: 'outbox', err: e.message })), 10e3));
    const h = () => { try { jobs.hourly(); } catch (e) { log({ level: 'error', msg: 'hourly job', err: e.message }); } };
    const d = () => jobs.daily(auditApi);
    timers.push(setInterval(h, 3600e3), setInterval(d, 24 * 3600e3)); setTimeout(h, 5e3).unref();
    timers.forEach(t => t.unref());
  }
  return { server, db, startJobs, notifier, jobs, auditApi, cfg: c, stop: () => { timers.forEach(clearInterval); server.close(); db.close(); } };
}

if (require.main === module) {
  const app = createApp();
  app.startJobs();
  app.server.listen(cfg.port, cfg.host, () => log({ level: 'info', msg: `ATM Enugu Platform listening on http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`, demo: cfg.demo, db: cfg.dbFile }));
  const bye = () => { log({ level: 'info', msg: 'shutting down' }); app.stop(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
module.exports = { createApp };
