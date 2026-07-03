// backendNotifier.js — Push a finished recording session to the ERP webhook.
//
// This replaces the old "provider fires a webhook, ERP pulls the data back" model. Because the
// recorder server already HAS the recording (in GCS), the participants, and the transcript, we push
// the full payload straight to the ERP's existing endpoint:
//
//     POST {BACKEND_WEBHOOK_URL}   (default https://erp.lmsmybeta.com/crm/api/schedule/v1/meeting-data/webhook)
//
// The ERP maps meetingId -> class/split schedule (by date) and stores everything in
// crm_036_meeting_session_data, then generates the AI summary — exactly as before.
//
// Auth: a shared secret header (X-Recorder-Secret) the ERP can verify. Uses only Node core http/https
// so the server keeps its tiny dependency footprint.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

function postJson(urlStr, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('Bad BACKEND_WEBHOOK_URL: ' + e.message)); }
    const payload = Buffer.from(JSON.stringify(body));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }, headers || {})
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 20000, () => { req.destroy(new Error('Backend webhook timeout')); });
    req.write(payload);
    req.end();
  });
}

function createBackendNotifier(config) {
  const enabled = !!config.backendWebhookUrl;
  if (!enabled) logger.warn('Backend notifier disabled — set BACKEND_WEBHOOK_URL to push sessions to the ERP');

  return {
    enabled,

    // session: finalized in-memory session; occ: matched registry occurrence (may be null);
    // recordingObject: GCS object path; signedUrl: short-lived download URL; roster/transcript arrays.
    async notifySessionComplete({ session, occ, recordingObject, bucket, signedUrl, roster, transcript }) {
      if (!enabled) return { sent: false, reason: 'disabled' };

      // Shape mirrors what the ERP webhook + MeetingSessionDataService now understand. We PUSH the
      // data so the ERP does not need to call back. `bot_object_id` = sessionId keeps each recording
      // a distinct row; `meetingId` drives the schedule lookup.
      const durationSeconds = Math.max(0, Math.round(
        ((session.endedAt ? Date.parse(session.endedAt) : Date.now()) - session.startTimeMs) / 1000));

      const body = {
        source: 'gmeet-recorder',
        meetingId: session.meetingId,
        sessionId: session.id,
        bot_object_id: session.id,
        state: session.recordingError ? 'error' : 'completed',
        recordingObject,              // GCS object path -> ERP signs fresh on read
        recordingBucket: bucket,
        recordingUrl: signedUrl,      // convenience signed URL (expires)
        durationSeconds,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        scheduleId: occ ? occ.scheduleId : null,
        splitScheduleId: occ ? occ.splitScheduleId : null,
        meetingLink: occ ? occ.meetingLink : null,
        participants: roster || [],           // derived roster [{name, joinedAt, leftAt, ...}]
        participantEvents: (session.participants || []), // raw join/leave events for exact aggregation
        transcript: transcript || [],         // [{speaker, text, timestamp}]
        data: { event_metadata: { bot_duration_seconds: durationSeconds } }
      };

      const headers = {};
      if (config.backendWebhookSecret) headers['X-Recorder-Secret'] = config.backendWebhookSecret;

      try {
        const res = await postJson(config.backendWebhookUrl, body, headers, 20000);
        if (res.status >= 200 && res.status < 300) {
          logger.info({ sessionId: session.id, meetingId: session.meetingId, status: res.status },
            'Pushed session to ERP webhook');
          return { sent: true, status: res.status };
        }
        logger.warn({ sessionId: session.id, status: res.status, body: res.body.slice(0, 300) },
          'ERP webhook returned non-2xx');
        return { sent: false, status: res.status };
      } catch (err) {
        logger.error({ err: err.message, sessionId: session.id }, 'Failed to push session to ERP webhook');
        return { sent: false, reason: err.message };
      }
    }
  };
}

module.exports = { createBackendNotifier };
