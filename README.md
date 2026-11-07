# ATM Enugu Platform

Membership, structure and election-day situation-room platform for ATM across Enugu State's 17 LGAs, wards and polling units.

- **Server:** Node.js 22.5 or newer. **No npm packages.** It uses Node's built-in `node:sqlite`, `node:crypto` and `node:http`.
- **Frontend:** `public/index.html`, the single-page app from the prototype. When the server serves it, it switches to live data automatically. If you open the file directly, it still runs as the standalone demo prototype.

---

## Quick start

### 1. Try it with demo data

```bash
npm run demo          # same as: DEMO_SEED=1 DATA_DIR=./data-demo node server.js
```

Open http://localhost:3000. The demo accounts all use the password `Demo#1234`, and every SMS code is `123456`:

| Role | Phone |
|---|---|
| State Administrator | 08000000001 |
| LGA Coordinator (Nsukka) | 08000000002 |
| Ward Coordinator (Nsukka Ward 2) | 08000000003 |
| Polling-Unit Coordinator | 08000000004 |
| General Member | 08000000005 |

The "Prototype guide" button switches between roles. The server refuses to start in demo mode when `NODE_ENV=production`.

### 2. Run the tests

```bash
npm test              # 18 API tests: permissions, scope, auth, exports, audit chain, backups
```

---

## Going live: launch checklist

1. **Server.** Any Linux VPS with Node 22.5+ (e.g. 1 vCPU / 1 GB RAM to start). Put it behind Nginx or Caddy with HTTPS. See `deploy/`.
2. **Configure.** `cp .env.example .env` and fill it in. At minimum set `NODE_ENV=production`, `TRUST_PROXY=1`, `BACKUP_DIR`, `BACKUP_KEY` and the SMS provider keys.
3. **SMS.** Create a [Termii](https://termii.com) account, get a registered Sender ID approved and set `SMS_PROVIDER=termii`, `TERMII_API_KEY`, `TERMII_SENDER_ID`. Without this, sign-in codes, registration codes and password-reset codes are only printed to the server log.
4. **Email (optional).** For members who choose email contact: set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `MAIL_FROM` from a verified domain.
5. **Import the official directory.** Get the verified INEC ward and polling-unit list as CSV with the columns `lga,ward,ward_code,pu,pu_code`. Then:
   ```bash
   node scripts/import-directory.js inec-directory.csv --dry-run              # check first
   node scripts/import-directory.js inec-directory.csv --remove-placeholders  # import and remove the demo wards/PUs
   ```
   You can also paste smaller files under **Admin → Geographic directory**.
6. **Create the first State Administrator.**
   ```bash
   node scripts/create-admin.js --name "Full Name" --phone 080XXXXXXXX --email you@example.ng
   ```
   It prompts for the password. Two-step sign-in by SMS is on by default for administrators.
7. **Replace placeholder content.** In **Site settings**: headline, slogan, candidate captions, contact details, brand colours. In **Content**: publish real news and events and upload approved photos. State leadership names and bios are in `public/index.html` (`STATE_LEADERS`).
8. **Legal.** Have counsel review the privacy notice and terms (`TXT` in `public/index.html`) against the Nigeria Data Protection Act 2023. Appoint a Data Protection Officer and register with the NDPC where required.
9. **Before election day.** In the Situation room, the State Administrator turns election mode on. Polling-unit coordinators can only report while it is on.

---

## What's built

| Area | Details |
|---|---|
| **Database** | SQLite (WAL mode) with versioned migrations, foreign keys, unique codes and a trigger that guarantees a polling unit's LGA matches its ward's LGA. |
| **Accounts** | scrypt password hashing. Session cookies are HttpOnly, SameSite=Strict and Secure behind HTTPS, with an idle timeout (configurable 15/30/60 min) and a 12-hour absolute limit. |
| **One-time codes** | 6 digits, stored hashed, 10-minute expiry, single use, 5 attempts. Used for phone verification, password reset and administrator two-step sign-in. |
| **Abuse limits** | Per-account lockout after N failures (configurable 3/5/8) for 15 minutes, plus per-IP rate limits on login, registration, reset, contact, uploads and the whole API. |
| **Authorisation** | Checked on **every** route. Coordinators only ever receive records in their own LGA, ward or polling unit. Phone numbers are masked and emails hidden for everyone except the member and the State. The public receives aggregate counts only. |
| **CSRF / XSS** | Mutating requests need an `X-ATM` header and a same-origin `Origin`. A strict Content-Security-Policy pins the page's inline script by SHA-256 hash, and all output is escaped. |
| **Audit log** | Append-only. Database triggers block edits and deletes, and every entry is SHA-256 hash-chained. Check it with **Audit logs → Verify chain** or `npm run verify-audit`. IPs are partially masked. |
| **Notifications** | In-app notifications plus an outbox for SMS and WhatsApp (Termii) and email (Resend), retried up to 5 times. Updates go only to members who opted in; account messages go to everyone. |
| **Workflows** | Registration, phone verification, approval queue, coordinator nominations (ward → PU, LGA → ward), State approval (one post per person; the scope moves to the new post), role changes, suspension, content workflow (Draft → In review → Scheduled/Published → Archived), events and RSVP with capacity, activity reports, ward information, support inbox (reply and apply location corrections), situation reports with incident alerts. |
| **Exports** | CSV, printable HTML and real `.xlsx`, all aggregate-only with a confidentiality line naming who exported it. Every export is audit-logged. Also: audit-log CSV, situation-report CSV (scoped) and "Download my data" (JSON) for members. |
| **Uploads** | Images checked by file signature (not the extension), max 2 MB, stored under random names, served with `nosniff` and a locked-down CSP. Set `SCAN_CMD=clamscan` to virus-scan each upload. |
| **Data rights** | Members can export their data and delete their account. Deletion erases personal data straight away and keeps only the anonymised audit trail. |
| **Scheduled jobs** | Hourly: publish scheduled articles, erase rejected applications after the retention period, clean up expired sessions and codes, and a monthly "inactive accounts" notice. Daily: audit-log retention (with a checkpoint so the chain still verifies) and an encrypted backup (AES-256-GCM, keeps the last 14). |
| **Monitoring** | `GET /api/health`, plus JSON-lines request and error logs on stdout (session tokens are never logged). |

### Fixed along the way (also in the standalone prototype)

- The situation room crashed when you sorted incidents by severity (`SEV` was undefined).
- The event form opened an empty dialog on a validation error; it now keeps your input and shows the errors.
- The activity-report form hid its validation errors.

---

## Backups and restore

```bash
npm run backup                                         # one-off backup to BACKUP_DIR (encrypted if BACKUP_KEY is set)
node scripts/backup.js --restore backups/atm-….db.enc restored.db
# stop the server → replace data/atm.db with restored.db → delete atm.db-wal / atm.db-shm → start
```

The server also backs up automatically once a day. **Copy `BACKUP_DIR` off the server** (object storage or another machine) and test a restore every quarter. Keep `BACKUP_KEY` somewhere safe: without it, encrypted backups cannot be read.

---

## Configuration (`.env`)

See `.env.example` for every variable. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | — | `production` turns on HSTS and blocks demo mode |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | Database and uploads |
| `TRUST_PROXY` | `0` | Set to `1` behind Nginx/Caddy so rate limits see real client IPs |
| `ALLOWED_ORIGINS` | same host | Comma-separated, only if the site is served on several domains |
| `SMS_PROVIDER` | `console` | `termii` in production |
| `EMAIL_PROVIDER` | `console` | `resend` to send email |
| `BACKUP_DIR` / `BACKUP_KEY` / `BACKUP_KEEP` | — / — / `14` | Daily encrypted backups |
| `SCAN_CMD` / `SCAN_ARGS` | — / `--no-summary` | e.g. `clamscan`; a non-zero exit rejects the upload |

---

## Project layout

```
server.js               HTTP server, static files, security headers, job scheduler
lib/db.js               schema and migrations (node:sqlite)
lib/api.js              every API route, with permission and scope checks
lib/auth.js             password hashing, sessions, one-time codes
lib/audit.js            hash-chained audit log
lib/notify.js           in-app notifications and the SMS/WhatsApp/email outbox
lib/geo.js              directory seeding, CSV validation and import
lib/jobs.js             retention, scheduled publishing, encrypted backups
lib/xlsx.js             dependency-free Excel writer
lib/demo.js             demo data (DEMO_SEED=1 only)
public/index.html       the web app (works standalone as a demo, or live with the server)
scripts/                create-admin, import-directory, backup/restore, verify-audit
test/api.test.js        API test suite (node --test)
deploy/                 nginx, systemd and Docker examples
```

---

## Known limits and next steps

- **Scale.** The State dashboard loads all member records into the browser, so it filters and charts instantly. That is comfortable up to roughly 30,000–50,000 members. Beyond that, move the admin member tables to server-side search and paging (the API is already scoped, so this only changes the admin tables).
- **Single server.** SQLite suits one server well, including on election day (the writes are small). To run several app servers, move to PostgreSQL. The SQL is plain and portable.
- **Third-party assets.** The QR-code library (cdnjs) and Google Fonts load from CDNs. For full control, download them into `public/` and drop the CDN hosts from the CSP in `server.js`.
- **Images** are not resized on upload. Ask editors to upload web-sized photos, or add an image service later.
- **Leadership bios** for the State team are still in the page code, not editable in the admin.
- **SMS cost.** Every registration, reset and admin sign-in sends an SMS. Watch your Termii balance and the `outbox` table (rows with `status='failed'`).
