// mailer.js — Transactional email for the recorder server (missed-recording alerts).
//
// Uses the SAME SMTP identity as the ERP (BETA-CRM-BASE-GCP → EmailUtil / Constants): AWS SES over
// STARTTLS, sender "BETA HIVE <no-reply@mybeta.ca>". Credentials come from env (see .env) so they
// aren't hard-coded here; the .env is pre-filled with the Base codebase values.

const nodemailer = require('nodemailer');
const logger = require('./logger');

function createMailer(config) {
  const enabled = false; // config.smtpEnabled && config.smtpHost && config.smtpUser && config.smtpPass;
  let transport = null;

  /*
  if (enabled) {
    transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,        // 587 uses STARTTLS (secure:false + requireTLS)
      requireTLS: config.smtpPort !== 465,
      auth: { user: config.smtpUser, pass: config.smtpPass }
    });
    logger.info({ host: config.smtpHost, port: config.smtpPort }, 'Mailer ready (SMTP)');
  } else {
    logger.warn('Mailer disabled — SMTP not fully configured; missed-recording emails will be logged only');
  }
  */
  logger.warn('Mailer disabled by default');

  return {
    enabled,

    async send({ to, cc, subject, html }) {
      if (!to && !(cc && cc.length)) return { sent: false, reason: 'no-recipients' };
      if (!transport) {
        logger.info({ to, cc, subject }, '[mailer disabled] would send email');
        return { sent: false, reason: 'disabled' };
      }
      try {
        const info = await transport.sendMail({
          from: config.senderEmail,
          to,
          cc: cc && cc.length ? cc : undefined,
          subject,
          html
        });
        logger.info({ to, cc, subject, messageId: info.messageId }, 'Email sent');
        return { sent: true, messageId: info.messageId };
      } catch (err) {
        logger.error({ err: err.message, to, subject }, 'Email send failed');
        return { sent: false, reason: err.message };
      }
    }
  };
}

// Branded HTML for the "class started but no recording received" alert.
function missedRecordingEmail(occ, graceMinutes) {
  const when = occ.startAt ? new Date(occ.startAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' }) : 'the scheduled time';
  const cls = [occ.batchName, occ.meetingId].filter(Boolean).join(' — ');
  const link = occ.meetingLink ? `<a href="${occ.meetingLink}">${occ.meetingLink}</a>` : (occ.meetingId || '');
  return {
    subject: `Action needed: recording not started for ${occ.batchName || 'your class'} (${occ.meetingId})`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1c1c1e;line-height:1.5;max-width:560px">
        <p>Hi ${occ.facultyName || 'there'},</p>
        <p>Your class <b>${cls || 'session'}</b> was scheduled to start at <b>${when}</b>, but
        <b>no recording has been received</b> more than ${graceMinutes} minutes in.</p>
        <p>If the class is still running, please open the meeting and start the
        <b>Google Meet Recorder</b> (click the extension, then <b>Start Recording</b> and choose to
        share the tab with audio) so the session, participants, and transcript are captured.</p>
        <p>Meeting: ${link}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
        <p style="color:#888;font-size:12px">This is an automated reminder from the BETA HIVE meeting recorder.
        If the class was cancelled or recorded on another device, you can ignore this message.</p>
      </div>`
  };
}

module.exports = { createMailer, missedRecordingEmail };
