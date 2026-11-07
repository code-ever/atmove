'use strict';
/* Notification delivery: in-app notifications + an outbox for SMS / WhatsApp / email.
   Providers:
     console  – development: messages are printed and marked sent
     termii   – SMS and WhatsApp via Termii (api.ng.termii.com) – TERMII_API_KEY, TERMII_SENDER_ID
     resend   – email via Resend (api.resend.com)               – RESEND_API_KEY, MAIL_FROM
   Consent rules:
     transactional (codes, approvals, account notices) → sent to the member's own contact point
     update (announcements, event reminders)           → only if the member opted in to updates            */
const { now, uid } = require('./util');

function createNotifier(db, cfg, log) {
  function inApp(to, title, body, type = 'info') {
    const id = uid('n');
    db.run('INSERT INTO notifications(id,to_uid,title,body,type,created_at) VALUES(?,?,?,?,?,?)', id, to, String(title).slice(0, 140), String(body).slice(0, 600), type, now());
    return id;
  }
  /* Queue an external message for one user using their preferred contact method. */
  function external(user, subject, body, kind = 'transactional') {
    if (!user || user.status === 'Deleted') return;
    if (kind === 'update' && !user.consent_updates) { return; }
    let channel = { SMS: 'sms', WhatsApp: 'whatsapp', Email: 'email', 'Phone call': 'sms' }[user.contact] || 'sms';
    let to = channel === 'email' ? user.email : user.phone;
    if (!to) { channel = user.phone ? 'sms' : 'email'; to = user.phone || user.email; }
    if (!to) return;
    db.run('INSERT INTO outbox(uid,channel,to_addr,subject,body,kind,created_at) VALUES(?,?,?,?,?,?,?)', user.uid, channel, to, subject || null, body, kind, now());
  }
  /* OTPs always go by SMS to the phone being verified. */
  function sms(user, body, phone) {
    const to = phone || user.phone; if (!to) return;
    db.run('INSERT INTO outbox(uid,channel,to_addr,subject,body,kind,created_at) VALUES(?,?,?,?,?,?,?)', user.uid, 'sms', to, null, body, 'transactional', now());
  }
  const notify = (user, title, body, type = 'info', opts = {}) => { inApp(user.uid, title, body, type); if (opts.external !== false) external(user, title, title + ': ' + body, opts.kind || 'transactional'); };

  const intl = p => String(p).replace(/^0/, '234').replace(/^\+/, '');
  async function deliver(m) {
    const P = cfg.providers;
    if (m.channel === 'email') {
      if (P.email === 'resend') {
        const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.resendKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: cfg.mailFrom, to: [m.to_addr], subject: m.subject || 'ATM Enugu', text: m.body }) });
        if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text()).slice(0, 200));
        return;
      }
    } else if (P.sms === 'termii') {
      const r = await fetch('https://api.ng.termii.com/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: cfg.termiiKey, to: intl(m.to_addr), from: cfg.termiiSender, sms: m.body, type: 'plain', channel: m.channel === 'whatsapp' ? 'whatsapp' : 'dnd' }) });
        if (!r.ok) throw new Error('termii ' + r.status + ' ' + (await r.text()).slice(0, 200));
        return;
    }
    log({ level: 'info', msg: 'outbox (console provider)', channel: m.channel, to: m.to_addr.replace(/.(?=.{4})/g, '•'), body: m.body });
  }
  let busy = false;
  async function work() {
    if (busy) return; busy = true;
    try {
      const batch = db.all("SELECT * FROM outbox WHERE status='queued' AND attempts < 5 ORDER BY id LIMIT 25");
      for (const m of batch) {
        try { await deliver(m); db.run("UPDATE outbox SET status='sent', sent_at=?, attempts=attempts+1 WHERE id=?", now(), m.id); }
        catch (e) { db.run("UPDATE outbox SET attempts=attempts+1, last_error=?, status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'queued' END WHERE id=?", String(e.message).slice(0, 300), m.id); log({ level: 'warn', msg: 'delivery failed', id: m.id, err: e.message }); }
      }
    } finally { busy = false; }
  }
  return { inApp, external, sms, notify, work };
}
module.exports = { createNotifier };
