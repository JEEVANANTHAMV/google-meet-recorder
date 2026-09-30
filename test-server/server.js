// test-server/server.js
// Production-grade WebSocket + HTTP server for the Google Meet Recorder.
//
// Responsibilities:
//   - Accept recorder WebSocket connections, stream video chunks straight to GCS (resumable upload).
//   - Persist participant + transcript event streams per meeting session.
//   - Expose a read HTTP API: list meetings, get recording (signed URL), transcript, participants.
//   - Harden the socket: payload limits, origin validation, heartbeats, optional auth token.

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const logger = require('./logger');
const { createStorage, objectPath, safeSegment } = require('./storage');
const { createScheduleRegistry } = require('./schedules');
const { createMailer, missedRecordingEmail } = require('./mailer');
const { createBackendNotifier } = require('./backendNotifier');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  port: parseInt(process.env.PORT || '8001', 10),
  host: process.env.HOST || '0.0.0.0',
  backend: (process.env.STORAGE_BACKEND || 'gcs').toLowerCase(),
  bucketName: process.env.GCS_BUCKET_NAME || 'meet-cloud',
  projectId: process.env.GCS_PROJECT_ID || undefined,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'Service-Account.json'),
  localRoot: process.env.LOCAL_STORAGE_DIR || path.join(__dirname, 'recordings'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://18.204.127.179:${process.env.PORT || '8001'}`,
  signedUrlExpiresDays: parseInt(process.env.SIGNED_URL_EXPIRES_DAYS || '7', 10),
  selfCheck: process.env.STORAGE_SELFCHECK !== 'false',
  // WS hardening
  // Chrome occasionally emits one oversized recording chunk (e.g. after the machine stalls); a limit
  // below that drops the recorder mid-class. The extension never sends a single chunk over 100 MB.
  maxPayloadBytes: parseInt(process.env.WS_MAX_PAYLOAD_MB || '128', 10) * 1024 * 1024,
  allowedOrigins: (process.env.WS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  authToken: process.env.AUTH_TOKEN || '',
  heartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_MS || '15000', 10),
  flushIntervalMs: parseInt(process.env.EVENT_FLUSH_MS || '5000', 10),
  // How long a recording stays open after its socket drops, waiting for the same recorder to reconnect
  // and continue the SAME file. This was 15s, but the client only notices a dead socket after tens of
  // seconds (and retries every 5s), so any real network blip outlived it and every reconnect started a
  // new recording. A recorder that truly ends sends recording_end, so this only delays crashed clients.
  disconnectGraceMs: parseInt(process.env.DISCONNECT_GRACE_MS || '600000', 10),
  // Recordings are spooled to local disk while live and uploaded to storage once the session ends.
  spoolDir: path.resolve(process.env.SPOOL_DIR || path.join(__dirname, 'spool')),
  uploadAttempts: parseInt(process.env.UPLOAD_ATTEMPTS || '5', 10),
  uploadRetryIntervalMs: parseInt(process.env.UPLOAD_RETRY_INTERVAL_MS || '600000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // ---- Domain binding / access control ----
  // Internal users (email in this domain) may record any meeting. Anyone else must supply the key.
  allowedEmailDomain: (process.env.ALLOWED_EMAIL_DOMAIN || 'mybeta.ca').toLowerCase().replace(/^@/, ''),
  externalAccessKey: process.env.EXTERNAL_ACCESS_KEY || 'InnoSynth@12',
  // API key the ERP presents when registering/removing schedules.
  scheduleApiKey: process.env.SCHEDULE_API_KEY || '',

  // ---- Backend push (ERP webhook) ----
  backendWebhookUrl: process.env.BACKEND_WEBHOOK_URL || '',
  backendWebhookSecret: process.env.BACKEND_WEBHOOK_SECRET || '',

  // ---- Missed-recording watchdog ----
  // Master switch for the missed-recording alert email. Set MISSED_RECORDING_EMAILS_ENABLED=false
  // to stop sending (the watchdog still marks occurrences so it doesn't reprocess them each tick).
  missedEmailsEnabled: process.env.MISSED_RECORDING_EMAILS_ENABLED !== 'false',
  missedGraceMinutes: parseInt(process.env.MISSED_RECORDING_GRACE_MIN || '10', 10),
  // Only alert within this many minutes AFTER a class start. Prevents next-day false alarms for
  // classes whose end + 24h window used to keep them "due" long after they were over. Default 120min.
  missedWindowMinutes: parseInt(process.env.MISSED_RECORDING_WINDOW_MIN || '120', 10),
  // Cutover floor: never alert for occurrences that started before this ISO timestamp. Pre-cutover
  // classes were recorded by the old notetaker (not the extension), so the recorder's registry never
  // marked them recorded — without this they generate false "you didn't record" emails. Empty = no floor.
  missedCutoverIso: process.env.MISSED_RECORDING_CUTOVER_ISO || '',
  watchdogIntervalMs: parseInt(process.env.WATCHDOG_INTERVAL_MS || '60000', 10),
  adminAlertEmails: (process.env.ADMIN_ALERT_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean),

  // ---- SMTP (copied from ERP / Base codebase Constants) ----
  smtpEnabled: process.env.SMTP_ENABLED !== 'false',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USERNAME || '',
  smtpPass: process.env.SMTP_PASSWORD || '',
  senderEmail: process.env.SENDER_EMAIL || 'BETA HIVE <no-reply@mybeta.ca>'
};

const SERVER_VERSION = '3.0.0';

const storage = createStorage(CONFIG);
const registry = createScheduleRegistry(storage, CONFIG, logger);
const mailer = createMailer(CONFIG);
const backendNotifier = createBackendNotifier(CONFIG);

// Active sessions, keyed by sessionId, plus a lookup by socket. A session stays here from auth until
// its recording has been uploaded (or handed to the upload retry sweep).
const sessions = new Map();        // sessionId -> session
const sessionByWs = new Map();     // ws -> session
const completingSessions = new Set(); // sessionIds whose upload/finalize pipeline is running

const startedAtServer = Date.now();

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function newSessionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

function distinctParticipantCount(events) {
  const ids = new Set();
  for (const e of events) {
    if (e.event === 'joined') ids.add(e.participantId || e.name);
  }
  return ids.size;
}

// Replay the participant event log into a current roster (who is in / who left).
//
// One roster ROW per distinct attendance window. If a participant leaves and rejoins,
// each join/leave cycle becomes its own row (session index appended to the key when > 1)
// so every attendance window is visible, not just the first join → last left span.
//
// Example — Poonthamil joined twice:
//   { id: "poonthamil jeeva",   joinedAt: "04:26:01Z", leftAt: "04:26:31Z" }
//   { id: "poonthamil jeeva#2", joinedAt: "04:26:53Z", leftAt: "04:27:01Z" }
function buildRoster(events) {
  // sessionCount tracks how many times each participant has joined so far.
  const sessionCount = new Map();
  // active holds the CURRENT open session for a participant (leftAt still null).
  const active = new Map();
  const rows = [];

  for (const e of events) {
    const baseKey = e.participantId || e.name;
    if (!baseKey) continue;

    if (e.event === 'joined') {
      if (active.has(baseKey)) {
        // Already tracked as in-call (duplicate joined) — skip.
        continue;
      }
      const count = (sessionCount.get(baseKey) || 0) + 1;
      sessionCount.set(baseKey, count);
      // First session uses the bare id; subsequent ones get "#2", "#3", … so each is a distinct row.
      const rowKey = count === 1 ? baseKey : `${baseKey}#${count}`;
      const row = { id: e.participantId || null, name: e.name, joinedAt: e.timestamp, leftAt: null };
      active.set(baseKey, row);
      rows.push(row);

    } else if (e.event === 'left') {
      const row = active.get(baseKey);
      if (row) {
        row.leftAt = e.timestamp;
        active.delete(baseKey);
      }
    }
  }

  return rows;
}

function metaFromSession(session) {
  const now = Date.now();
  return {
    meetingId: session.meetingId,
    sessionId: session.id,
    clientType: session.clientType,
    status: session.state,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: (session.endedAt ? new Date(session.endedAt).getTime() : now) - session.startTimeMs,
    participantCount: distinctParticipantCount(session.participants),
    participantEventCount: session.participants.length,
    transcriptLineCount: session.transcript.length,
    chunkCount: session.chunkCount,
    bytes: session.bytes,
    recording: {
      object: objectPath(session.meetingId, session.id, 'recording.webm'),
      size: session.bytes,
      contentType: 'video/webm'
    },
    recordingError: session.recordingError || null,
    server: { version: SERVER_VERSION },
    updatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Local spool
//
// While a session is live its recording is appended to a local file and its state (transcript,
// participants, counters) is mirrored to state.json next to it:
//   {spoolDir}/{meetingId}/{sessionId}/recording.webm
//   {spoolDir}/{meetingId}/{sessionId}/state.json
//
// This replaces streaming chunks straight into a GCS resumable upload, which caused the "connection
// lost — reconnecting" drops: when the upload fell behind, the socket was paused, a paused socket
// stops reading the client's heartbeat pongs, and the heartbeat then terminated the recorder. Local
// disk keeps up with any number of meetings, survives a server restart, and the upload at the end
// can be retried without losing anything.
// ---------------------------------------------------------------------------
function spoolDirFor(meetingId, sessionId) {
  return path.join(CONFIG.spoolDir, safeSegment(meetingId), safeSegment(sessionId));
}
function spoolRecordingPath(session) { return path.join(spoolDirFor(session.meetingId, session.id), 'recording.webm'); }
function spoolStatePath(session) { return path.join(spoolDirFor(session.meetingId, session.id), 'state.json'); }

function stateFromSession(session) {
  return {
    version: 1,
    id: session.id,
    meetingId: session.meetingId,
    clientType: session.clientType,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    startTimeMs: session.startTimeMs,
    chunkCount: session.chunkCount,
    lastSequence: session.lastSequence,
    participants: session.participants,
    transcript: session.transcript,
    recordingError: session.recordingError,
    email: session.email,
    authReason: session.authReason,
    finalized: session.finalized,
    uploaded: !!session.uploaded,
    notified: !!session.notified
  };
}

// Serialised per session (writes chain) and atomic (tmp + rename) so a crash never leaves a torn file.
function persistState(session) {
  if (session.spoolRemoved) return Promise.resolve();
  const statePath = spoolStatePath(session);
  const body = JSON.stringify(stateFromSession(session));
  session.persistChain = (session.persistChain || Promise.resolve()).then(async () => {
    if (session.spoolRemoved) return;
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, statePath);
  }).catch(err => {
    logger.error({ err: err.message, sessionId: session.id }, 'Failed to persist session state to spool');
  });
  return session.persistChain;
}

function openSpoolStream(session) {
  fs.mkdirSync(spoolDirFor(session.meetingId, session.id), { recursive: true });
  const stream = fs.createWriteStream(spoolRecordingPath(session), { flags: 'a' });
  stream.on('error', (err) => {
    session.recordingError = err.message;
    if (session.recordingStream === stream) session.recordingStream = null; // next chunk reopens (append)
    logger.error({ err: err.message, sessionId: session.id }, 'Spool write error — will reopen on next chunk');
  });
  session.recordingStream = stream;
  logger.info({ sessionId: session.id, file: spoolRecordingPath(session), resumed: session.bytes > 0 },
    'Recording spool opened');
}

async function flushSession(session, { force = false } = {}) {
  // Local spool state first: it is fast and is what restores the session after a restart, so it must
  // not wait behind (or be lost to) a slow storage write.
  if (force || session.dirty.participants || session.dirty.transcript || session.dirty.meta) {
    await persistState(session);
  }
  // Each artifact is written independently; one that fails is marked dirty again so it is retried
  // (previously a failed write was simply dropped until the next change).
  const writes = [
    ['participants', 'participants.json', () => ({
      meetingId: session.meetingId, sessionId: session.id,
      events: session.participants, roster: buildRoster(session.participants)
    })],
    ['transcript', 'transcript.json', () => ({
      meetingId: session.meetingId, sessionId: session.id, lines: session.transcript
    })],
    ['meta', 'meta.json', () => metaFromSession(session)]
  ];
  let ok = true;
  for (const [key, file, body] of writes) {
    if (!force && !session.dirty[key]) continue;
    session.dirty[key] = false;
    try {
      await storage.writeJSON(session.meetingId, session.id, file, body());
    } catch (err) {
      ok = false;
      session.dirty[key] = true;
      logger.error({ err: err.message, sessionId: session.id, file }, 'Failed to flush session artifact — will retry');
    }
  }
  if (!ok && !session.finalized) scheduleFlush(session);
  return ok;
}

// Final artifact write for an ending session, with a few quick retries.
async function flushSessionReliably(session) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (await flushSession(session, { force: true })) return true;
    if (attempt < 4) await sleep(2000 * 3 ** (attempt - 1));
  }
  return false;
}

function scheduleFlush(session) {
  if (session.flushTimer) return;
  session.flushTimer = setTimeout(async () => {
    session.flushTimer = null;
    await flushSession(session);
  }, CONFIG.flushIntervalMs);
}

// Close the spool file and wait until every buffered chunk is on disk.
function endRecordingStream(session) {
  return new Promise((resolve) => {
    if (!session.recordingStream) return resolve();
    const stream = session.recordingStream;
    session.recordingStream = null;
    stream.once('finish', resolve);
    stream.once('error', (err) => {
      logger.error({ err: err.message, sessionId: session.id }, 'Spool stream error on finalize');
      resolve();
    });
    stream.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Upload the spooled recording to storage, retrying with backoff. Returns true when there is nothing
// (more) to upload, false when every attempt failed (the spool is kept for the retry sweep).
async function uploadSpooledRecording(session) {
  if (session.chunkCount === 0) return true;
  const file = spoolRecordingPath(session);
  if (!fs.existsSync(file)) {
    logger.error({ sessionId: session.id }, 'Spooled recording missing — nothing to upload');
    session.recordingError = session.recordingError || 'Spooled recording file missing';
    return true;
  }
  for (let attempt = 1; attempt <= CONFIG.uploadAttempts; attempt++) {
    try {
      const started = Date.now();
      await storage.uploadRecordingFile(session.meetingId, session.id, file);
      logger.info({ sessionId: session.id, attempt, mb: (session.bytes / 1048576).toFixed(2),
        sec: ((Date.now() - started) / 1000).toFixed(1) }, 'Recording uploaded');
      return true;
    } catch (err) {
      logger.error({ err: err.message, sessionId: session.id, attempt }, 'Recording upload failed');
      if (attempt < CONFIG.uploadAttempts) await sleep(Math.min(5000 * 3 ** (attempt - 1), 120000));
    }
  }
  return false;
}

function detachSession(session) {
  sessions.delete(session.id);
  if (session.ws) sessionByWs.delete(session.ws);
}

async function finalizeSession(session, reason) {
  if (session.finalized) return;
  session.finalized = true;
  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null; }
  if (session.disconnectTimer) { clearTimeout(session.disconnectTimer); session.disconnectTimer = null; }

  await endRecordingStream(session);

  session.endedAt = session.endedAt || new Date().toISOString();

  // Safety net for leave times: if the host ends the call for everyone, Meet tears the page down
  // before the extension can emit per-person 'left' events, so participants would be stored as
  // "still in meeting" forever. Synthesize a 'left' at session end for anyone still open in the
  // event log. Idempotent — only fills gaps the extension didn't already report.
  const stillIn = buildRoster(session.participants).filter(p => !p.leftAt);
  for (const p of stillIn) {
    session.participants.push({
      event: 'left',
      name: p.name,
      participantId: p.id,
      timestamp: session.endedAt,
      receivedAt: session.endedAt,
      synthetic: true,
    });
  }
  if (stillIn.length) {
    session.dirty.participants = true;
    logger.info({ sessionId: session.id, count: stillIn.length },
      'Synthesized leave events at session end (call ended for all)');
  }

  session.state = 'uploading';
  session.dirty.meta = true;
  await flushSession(session, { force: true }); // also records finalized:true in the spool state

  await completeSession(session, reason);
}

// Upload + publish a finalized session, then clean up its spool. Also used by the retry sweep and
// startup recovery for sessions whose upload failed or was interrupted by a restart.
async function completeSession(session, reason) {
  if (completingSessions.has(session.id)) return;
  completingSessions.add(session.id);
  try {
    if (!session.uploaded) {
      const uploaded = await uploadSpooledRecording(session);
      if (!uploaded) {
        session.state = 'upload_pending';
        session.dirty.meta = true;
        await flushSession(session, { force: true });
        detachSession(session);
        logger.error({ sessionId: session.id, spool: spoolDirFor(session.meetingId, session.id) },
          'Recording upload still failing — kept in spool, retry sweep will try again');
        return;
      }
      session.uploaded = true;
      await persistState(session); // a retry after this point must not upload again
    }

    session.state = session.recordingError && session.chunkCount === 0 ? 'error' : 'ended';
    session.dirty.meta = true;
    const saved = await flushSessionReliably(session);
    detachSession(session);

    logger.info({
      sessionId: session.id, meetingId: session.meetingId, reason,
      chunks: session.chunkCount, bytes: session.bytes,
      participants: distinctParticipantCount(session.participants),
      transcriptLines: session.transcript.length,
      durationSec: ((new Date(session.endedAt).getTime() - session.startTimeMs) / 1000).toFixed(1)
    }, 'Session finalized');

    // Link + push to the ERP whenever the session captured anything meaningful.
    let pushed = false;
    try {
      pushed = await pushSessionToBackend(session);
    } catch (err) {
      logger.error({ err: err.message, sessionId: session.id }, 'Backend push failed');
    }

    if (!saved || !pushed) {
      // Keep the spool (state.json carries the transcript/participants) so the retry sweep can finish
      // the job — previously a failed ERP push was never retried and the class never reached the ERP.
      await persistState(session);
      logger.error({ sessionId: session.id, artifactsSaved: saved, pushedToErp: pushed },
        'Session not fully published — kept in spool, retry sweep will try again');
      return;
    }

    session.spoolRemoved = true;
    await (session.persistChain || Promise.resolve());
    await fs.promises.rm(spoolDirFor(session.meetingId, session.id), { recursive: true, force: true })
      .catch(err => logger.warn({ err: err.message, sessionId: session.id }, 'Could not remove spool dir'));
    // Drop the meeting folder too once its last session is gone (rmdir refuses non-empty dirs).
    await fs.promises.rmdir(path.dirname(spoolDirFor(session.meetingId, session.id))).catch(() => {});
  } finally {
    completingSessions.delete(session.id);
  }
}

// Match the session to its scheduled occurrence and push the full result to the ERP webhook.
async function pushSessionToBackend(session) {
  if (session.notified) return true;
  const hasData = session.chunkCount > 0 || session.participants.length > 0 || session.transcript.length > 0;
  if (!hasData || !backendNotifier.enabled) return true;

  const occ = registry.markRecorded(session.meetingId, session.id, session.startedAt);

  let signedUrl = null;
  if (session.chunkCount > 0) {
    try {
      signedUrl = await storage.getRecordingSignedUrl(session.meetingId, session.id, CONFIG.signedUrlExpiresDays);
    } catch (err) {
      logger.warn({ err: err.message, sessionId: session.id }, 'Could not mint signed URL for backend push');
    }
  }

  const PUSH_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const res = await backendNotifier.notifySessionComplete({
      session,
      occ,
      recordingObject: session.chunkCount > 0 ? objectPath(session.meetingId, session.id, 'recording.webm') : null,
      bucket: storage.bucketName,
      signedUrl,
      roster: buildRoster(session.participants),
      transcript: session.transcript
    });
    if (res.sent) {
      session.notified = true;
      return true;
    }
    // A 4xx (other than timeout / rate limit) means the ERP rejects this payload; retrying won't help.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      logger.error({ sessionId: session.id, status: res.status }, 'ERP rejected the session push — not retrying');
      session.notified = true;
      return true;
    }
    if (attempt < PUSH_ATTEMPTS) await sleep(10000 * 3 ** (attempt - 1));
  }
  return false;
}

// Rebuild an in-memory session from its spooled state.json (after a restart / for the retry sweep).
function sessionFromState(st, bytes) {
  return {
    id: st.id,
    meetingId: st.meetingId,
    clientType: st.clientType || 'recorder',
    state: st.finalized ? 'uploading' : 'disconnected',
    startedAt: st.startedAt,
    endedAt: st.endedAt || null,
    startTimeMs: st.startTimeMs || new Date(st.startedAt).getTime(),
    chunkCount: st.chunkCount || 0,
    lastSequence: st.lastSequence || 0,
    bytes,
    participants: st.participants || [],
    transcript: st.transcript || [],
    recordingStream: null,
    recordingError: st.recordingError || null,
    finalized: !!st.finalized,
    notified: !!st.notified,
    uploaded: !!st.uploaded,
    flushTimer: null,
    disconnectTimer: null,
    dirty: { participants: false, transcript: false, meta: true },
    ws: null,
    remoteAddress: null,
    email: st.email || null,
    authReason: st.authReason || null
  };
}

async function readSpooledStates() {
  const out = [];
  let meetings = [];
  try { meetings = await fs.promises.readdir(CONFIG.spoolDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const m of meetings) {
    if (!m.isDirectory()) continue;
    let sessionDirs = [];
    try { sessionDirs = await fs.promises.readdir(path.join(CONFIG.spoolDir, m.name), { withFileTypes: true }); } catch (_) { continue; }
    for (const d of sessionDirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(CONFIG.spoolDir, m.name, d.name);
      try {
        const st = JSON.parse(await fs.promises.readFile(path.join(dir, 'state.json'), 'utf8'));
        let bytes = 0;
        try { bytes = (await fs.promises.stat(path.join(dir, 'recording.webm'))).size; } catch (_) { /* no video */ }
        out.push({ st, bytes, dir });
      } catch (err) {
        logger.error({ err: err.message, dir }, 'Unreadable spool entry — left in place for manual recovery');
      }
    }
  }
  return out;
}

// On startup: sessions that were live when the server stopped come back as "disconnected" so their
// recorders can reconnect and keep writing the same file; sessions that had already ended resume
// their upload.
async function recoverSpooledSessions() {
  const entries = await readSpooledStates();
  for (const { st, bytes } of entries) {
    const session = sessionFromState(st, bytes);
    if (session.finalized) {
      logger.info({ sessionId: session.id, meetingId: session.meetingId }, 'Resuming upload of ended session from spool');
      completeSession(session, 'recovered').catch(err =>
        logger.error({ err: err.message, sessionId: session.id }, 'Recovered upload failed'));
      continue;
    }
    sessions.set(session.id, session);
    armDisconnectTimer(session);
    logger.info({ sessionId: session.id, meetingId: session.meetingId, mb: (bytes / 1048576).toFixed(2) },
      'Restored live session from spool — waiting for recorder to reconnect');
  }
}

// Periodically retry uploads that exhausted their attempts (e.g. a long storage outage).
async function retryPendingUploads() {
  const entries = await readSpooledStates();
  for (const { st, bytes } of entries) {
    if (!st.finalized || completingSessions.has(st.id) || sessions.has(st.id)) continue;
    logger.info({ sessionId: st.id }, 'Retrying pending recording upload');
    await completeSession(sessionFromState(st, bytes), 'upload_retry').catch(err =>
      logger.error({ err: err.message, sessionId: st.id }, 'Upload retry failed'));
  }
}

// Start (or restart) the countdown after which a disconnected session is finalized.
function armDisconnectTimer(session) {
  if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
  session.disconnectTimer = setTimeout(() => {
    session.disconnectTimer = null;
    logger.info({ sessionId: session.id }, 'Disconnect grace period expired, finalizing session');
    finalizeSession(session, 'socket_close');
  }, CONFIG.disconnectGraceMs);
}

// ---------------------------------------------------------------------------
// WebSocket message handling
// ---------------------------------------------------------------------------
// Decide whether a recorder is allowed to stream this meeting.
//   - Internal user  : email domain === ALLOWED_EMAIL_DOMAIN  -> allowed
//   - Bound meeting   : the meeting code is registered by the ERP -> allowed (any user)
//   - External user   : must supply the correct EXTERNAL_ACCESS_KEY
// Returns { allowed, reason } (reason is machine-friendly for logging + client display).
function authorizeRecorder(message, meetingId) {
  const email = (message.email || '').trim().toLowerCase();
  const domain = email.includes('@') ? email.split('@').pop() : '';
  if (domain && domain === CONFIG.allowedEmailDomain) {
    return { allowed: true, reason: 'internal-domain' };
  }
  if (registry.isBound(meetingId)) {
    return { allowed: true, reason: 'bound-meeting' };
  }
  if (message.accessKey && message.accessKey === CONFIG.externalAccessKey) {
    return { allowed: true, reason: 'external-key' };
  }
  return { allowed: false, reason: 'external-key-required' };
}

function handleAuth(message, ws, remoteAddress) {
  if (CONFIG.authToken && message.token !== CONFIG.authToken) {
    logger.warn({ remoteAddress, meetingId: message.meetingId }, 'Auth rejected: bad token');
    ws.send(JSON.stringify({ type: 'status', ok: false, message: 'Unauthorized' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  const meetingId = safeSegment(message.meetingId || 'unknown');
  const clientType = message.clientType || 'recorder';

  // Domain-binding / session resume (recorders only).
  if (clientType === 'recorder') {
    // Seamless reconnection: a recorder that already has a session sends its sessionId back on every
    // reconnect, so re-attach it and keep appending to the SAME recording file.
    //
    // Only an explicit sessionId match re-attaches. Previously ANY recorder for the same meeting
    // took over the open session and closed the other socket, so two people recording one class
    // knocked each other off every 5s (each reconnect kicked the other) and both video streams were
    // interleaved into one corrupt file. A second recorder now gets its own session instead.
    const requested = message.sessionId ? sessions.get(safeSegment(message.sessionId)) : null;
    if (requested && !requested.finalized && requested.meetingId === meetingId && requested.clientType === 'recorder') {
      if (requested.disconnectTimer) {
        clearTimeout(requested.disconnectTimer);
        requested.disconnectTimer = null;
      }
      if (requested.ws && requested.ws !== ws) {
        // Same recorder's previous (stale / half-open) socket.
        const oldWs = requested.ws;
        sessionByWs.delete(oldWs);
        try { oldWs.close(4000, 'Replaced by new connection'); } catch (e) { /* ignore */ }
      }
      requested.ws = ws;
      requested.remoteAddress = remoteAddress;
      requested.state = 'recording';
      requested.dirty.meta = true;
      scheduleFlush(requested);
      sessionByWs.set(ws, requested);

      logger.info({ sessionId: requested.id, meetingId, clientType, remoteAddress, lastSequence: requested.lastSequence },
        'Session re-attached / resumed for single-file meeting recording');

      ws.send(JSON.stringify({
        type: 'status', ok: true, message: 'Authenticated', sessionId: requested.id, meetingId, reconnected: true,
        // Last chunk stored: the recorder resends anything after it that was lost in flight.
        lastSequence: requested.lastSequence
      }));
      return;
    }
    if (message.sessionId) {
      logger.warn({ meetingId, requestedSessionId: message.sessionId, remoteAddress },
        'Recorder asked to resume a session that is no longer open — starting a new session');
    }
    const parallel = Array.from(sessions.values()).filter(s =>
      s.meetingId === meetingId && s.clientType === 'recorder' && !s.finalized);
    if (parallel.length) {
      logger.info({ meetingId, email: message.email, otherSessions: parallel.map(s => s.id) },
        'Another recorder is already recording this meeting — starting a parallel session');
    }

    // New session: enforce domain-binding / external-key gate.
    const auth = authorizeRecorder(message, meetingId);
    if (!auth.allowed) {
      logger.warn({ remoteAddress, meetingId, email: message.email }, 'Auth rejected: external key required');
      ws.send(JSON.stringify({
        type: 'status', ok: false, code: 'ACCESS_KEY_REQUIRED',
        message: 'This meeting is not bound to your organization. Enter the access key to record.'
      }));
      ws.close(4003, 'Access key required');
      return;
    }
    message._authReason = auth.reason;
  }

  const session = {
    id: newSessionId(),
    meetingId,
    clientType,
    state: 'recording',
    startedAt: new Date().toISOString(),
    endedAt: null,
    startTimeMs: Date.now(),
    chunkCount: 0,
    lastSequence: 0,
    bytes: 0,
    participants: [],
    transcript: [],
    recordingStream: null,
    recordingError: null,
    finalized: false,
    flushTimer: null,
    disconnectTimer: null,
    dirty: { participants: false, transcript: false, meta: true },
    ws,
    remoteAddress,
    email: (message.email || '').trim() || null,
    authReason: message._authReason || null
  };

  sessions.set(session.id, session);
  sessionByWs.set(ws, session);

  // Persist initial meta so the meeting shows up immediately and survives a crash.
  flushSession(session, { force: true });

  logger.info({ sessionId: session.id, meetingId, clientType, remoteAddress }, 'Session authenticated');

  ws.send(JSON.stringify({
    type: 'status', ok: true, message: 'Authenticated', sessionId: session.id, meetingId
  }));
}

function handleRecordingChunk(session, sequence, timestamp, data) {
  if (!session || session.finalized) return;
  // The client numbers chunks 1..N for the life of its MediaRecorder, so a sequence we've already
  // written is a duplicate (e.g. resent after a reconnect) — appending it would corrupt the WebM.
  if (sequence <= session.lastSequence) {
    logger.debug({ sessionId: session.id, sequence, lastSequence: session.lastSequence }, 'Dropped out-of-order/duplicate chunk');
    return;
  }
  if (session.lastSequence && sequence > session.lastSequence + 1) {
    logger.warn({ sessionId: session.id, missing: sequence - session.lastSequence - 1, from: session.lastSequence + 1 },
      'Gap in recording chunks (client dropped chunks while disconnected)');
  }
  if (!session.recordingStream) openSpoolStream(session);
  // Local disk write — deliberately NO socket backpressure. Pausing the socket also stops it reading
  // heartbeat pongs, which is what got recorders terminated mid-meeting.
  session.recordingStream.write(data);
  session.chunkCount++;
  session.lastSequence = sequence;
  session.bytes += data.length;
  if (session.chunkCount % 30 === 0) {
    session.dirty.meta = true;
    scheduleFlush(session);
    logger.debug({ sessionId: session.id, chunks: session.chunkCount, mb: (session.bytes / 1048576).toFixed(2) },
      'Recording progress');
  }
}

function handleBinaryMessage(buffer, session) {
  if (buffer.length < 13) return;
  const messageType = buffer.readUInt8(0);
  const sequence = buffer.readUInt32BE(1);
  const timestamp = Number(buffer.readBigUInt64BE(5));
  const chunkData = buffer.subarray(13);

  switch (messageType) {
    case 0x01: // recording chunk
      handleRecordingChunk(session, sequence, timestamp, chunkData);
      break;
    case 0x04: // recording end
      if (session) {
        logger.info({ sessionId: session.id, chunks: sequence }, 'Recording end (binary)');
        finalizeAndNotify(session);
      }
      break;
    default:
      logger.warn({ messageType }, 'Unknown binary message type');
  }
}

async function finalizeAndNotify(session) {
  if (session.finalized) return;
  await finalizeSession(session, 'recording_end');
  // Tell the client where to download (only meaningful if a recording was actually written).
  if (session.state === 'ended' && session.chunkCount > 0 && session.ws && session.ws.readyState === WebSocket.OPEN) {
    try {
      const url = await storage.getRecordingSignedUrl(session.meetingId, session.id, CONFIG.signedUrlExpiresDays);
      session.ws.send(JSON.stringify({
        type: 'recording_saved',
        downloadUrl: url,
        filename: `${session.meetingId}_${session.id}.webm`,
        meetingId: session.meetingId,
        sessionId: session.id
      }));
    } catch (err) {
      logger.error({ err: err.message, sessionId: session.id }, 'Failed to mint download URL');
    }
  }
}

function handleJSONMessage(message, ws, session, remoteAddress) {
  switch (message.type) {
    case 'auth':
      handleAuth(message, ws, remoteAddress);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    case 'pong':
      break;
    case 'participant': {
      if (!session) return;
      // ── Server-side noise guard (defence-in-depth for stale/un-reloaded extensions) ──
      // The extension filters these at source but if content.js hasn't been reloaded yet
      // (Chrome caches the script) the same UI labels can still arrive here. Reject them.
      const SERVER_NOISE = [
        /^you are\b/i,               // "You are presenting", "You are the host"
        /\b(is|are) (sharing|presenting)\b/i,
        /disappearing ink/i,
        /lines and shapes/i,               // Meet annotation shape tool
        /\b(and shapes|ink tool|annotation tool)\b/i,
        /^(pen|eraser|laser pointer|pointer|selector|text tool|highlighter|stamp|spotlight)$/i,
        /^(undo|redo|clear all)$/i,
        /^(thin|medium|thick|small|large)$/i,
        /\b(colou?r)\s+(green|red|blue|yellow|black|white|orange|purple|pink|gray|grey|brown)\b/i,
        /^(stickers?|emojis?|reactions?|stamps?)$/i,
        /^just\s+you$/i,
        /^colou?rs?$/i,
        /^breakout room\b/i,
        /^(mute|unmute|turn on|turn off)\b.+\b(microphone|camera|video|audio|mic)\b/i,
        /\b(microphone|your camera|your video|your mic)\b/i,
        /\brecording (started|stopped)\b/i,
        /^(admit|deny|block)\b/i,
        /^(raise|lower) (your |everyone'?s? )?hand\b/i,
        /^(getting ready|join now|return to home)\b/i,
        /^\d+\s+(joined|invited|waiting|in call)\b/i,
        /notetaker|note taker|note-taker/i,
        /\bwhiteboard\b/i,
      ];
      const incomingName = (message.name || '').trim();
      if (SERVER_NOISE.some(re => re.test(incomingName))) {
        logger.warn({ sessionId: session.id, name: incomingName, event: message.event },
          'Participant event rejected by server-side noise guard');
        return;
      }
      // Deduplicate consecutive identical events for the same participant
      const key = message.participantId || message.name;
      const lastEv = [...session.participants].reverse().find(p => (p.participantId || p.name) === key);
      if (lastEv && lastEv.event === message.event) {
        logger.debug({ sessionId: session.id, name: message.name, event: message.event }, 'Ignored duplicate participant event');
        return;
      }
      session.participants.push({
        event: message.event,
        name: message.name,
        participantId: message.participantId || null,
        timestamp: message.timestamp,
        receivedAt: new Date().toISOString()
      });
      session.dirty.participants = true;
      session.dirty.meta = true;
      scheduleFlush(session);
      logger.info({ sessionId: session.id, name: message.name, event: message.event }, 'Participant event');
      break;
    }

    case 'transcript': {
      if (!session) return;
      const line = {
        speaker: message.speaker,
        text: message.text,
        timestamp: message.timestamp,
        receivedAt: new Date().toISOString()
      };
      // Google Meet captions grow in place; the extension flags a continuation with replace:true so
      // we supersede this speaker's previous line instead of appending every growth step (which used
      // to bloat long transcripts to multiple MB and break summarisation). Guard: only replace when
      // the last stored line is the same speaker AND the new text extends it (defensive prefix check).
      // Meet labels the local user's captions "You"; the extension resolves that to the real display
      // name, which can happen mid-utterance. It then sends prevSpeaker so we recognise the stored
      // line as the same person and supersede it, instead of leaving an orphaned "You" duplicate.
      // Only the specific prior label is accepted — we never match on text alone, which could let one
      // speaker's line overwrite another's.
      //
      // We search for THIS SPEAKER'S most recent line rather than only inspecting the tail. Meet keeps
      // a finished caption block mounted while someone else starts talking, so a re-scan can re-emit
      // it after another speaker's line has landed. Checking only the tail then saw a speaker
      // mismatch, skipped the supersede and appended a verbatim duplicate — which is exactly the
      // "duplicates whenever the next speaker speaks" symptom.
      //
      // The search is bounded to the last few lines: a supersede is only ever meant to revise a
      // still-recent utterance, and scanning the whole transcript could resurrect an old line.
      const SUPERSEDE_LOOKBACK = 4;
      let target = -1;
      if (message.replace) {
        const from = Math.max(0, session.transcript.length - SUPERSEDE_LOOKBACK);
        for (let i = session.transcript.length - 1; i >= from; i--) {
          const cand = session.transcript[i];
          // prevSpeaker exists solely for the local user's label resolving from Meet's literal "You"
          // to their real display name. Accepting an arbitrary prevSpeaker would let any speaker claim
          // another's line, so only that specific self-relabel is honoured.
          const sameSpeaker = cand.speaker === line.speaker ||
            (message.prevSpeaker && /^you$/i.test(message.prevSpeaker) &&
             cand.speaker === message.prevSpeaker);
          if (!sameSpeaker) continue;
          // The new text must be a refinement of what we stored — either a pure extension, or a
          // retroactive revision of the tail (see isSameUtterance).
          if (isSameUtterance(cand.text, line.text)) { target = i; }
          break; // only consider this speaker's MOST RECENT line
        }
      }

      // Belt-and-braces: an exact repeat of this speaker's recent text is always a re-scan artefact,
      // never new speech. Drop it outright even if the prefix/lookback logic above didn't match.
      const isExactRepeat = session.transcript.slice(-SUPERSEDE_LOOKBACK).some(
        l => l.speaker === line.speaker && l.text === line.text
      );

      if (target >= 0) {
        // Preserve the original start time — the utterance began when we first saw it.
        line.timestamp = session.transcript[target].timestamp || line.timestamp;
        session.transcript[target] = line;
      } else if (isExactRepeat) {
        logger.debug({ sessionId: session.id, speaker: line.speaker }, 'Dropped duplicate caption re-emit');
      } else {
        session.transcript.push(line);
      }
      session.dirty.transcript = true;
      session.dirty.meta = true;
      scheduleFlush(session);
      break;
    }
    case 'recording_end':
      if (session) finalizeAndNotify(session);
      break;
    default:
      logger.warn({ type: message.type }, 'Unknown JSON message type');
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
// Would `next` be a refinement of `prev` (the same utterance), rather than new speech?
//
// Mirrors isSameUtterance() in extension/content.js — keep the two in sync. Google's recogniser
// retroactively rewrites the tail of its own guess as more audio arrives (pronounced for non-English
// speech: "terminal language only" -> "Tamil language, oh good, broad"), so a strict prefix test
// wrongly treats the correction as a new line and stores the same sentence twice. Accepting a long
// common prefix catches revisions while a high threshold keeps distinct sentences apart.
const UTTERANCE_MATCH_RATIO = 0.65;   // shared leading characters, as a fraction of prev
const UTTERANCE_WORD_RATIO = 0.75;    // shared words (in order), as a fraction of prev's words
const UTTERANCE_SHRINK_MIN = 0.8;     // a revision may shorten to this fraction of prev

function isSameUtterance(prev, next) {
  if (typeof prev !== 'string' || typeof next !== 'string' || !prev || !next) return false;
  if (next.startsWith(prev)) return true;      // pure growth (or exact repeat)
  if (prev.length < 25) return false;          // too short for overlap to mean anything
  // A revision can SHORTEN the tail ("… I think." -> "… Okay."), so allow a modest shrink while still
  // rejecting a genuinely new short line after a long one.
  if (next.length < prev.length * UTTERANCE_SHRINK_MIN) return false;

  let i = 0;
  const max = Math.min(prev.length, next.length);
  while (i < max && prev[i] === next[i]) i++;
  if ((i / prev.length) >= UTTERANCE_MATCH_RATIO) return true;

  // Google also rewrites words near the START of its guess, which destroys the character prefix while
  // keeping most words in order.
  return wordOverlapRatio(prev, next) >= UTTERANCE_WORD_RATIO;
}

// Fraction of `prev`'s words appearing, in order, near the start of `next` (word-level LCS). Bounded
// so it stays cheap. Mirrors wordOverlapRatio() in extension/content.js — keep the two in sync.
function wordOverlapRatio(prev, next) {
  const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const A = words(prev).slice(0, 60);
  if (!A.length) return 0;
  const B = words(next).slice(0, Math.min(A.length + 8, 68));
  if (!B.length) return 0;

  let prevRow = new Array(B.length + 1).fill(0);
  for (let x = 1; x <= A.length; x++) {
    const row = new Array(B.length + 1).fill(0);
    for (let y = 1; y <= B.length; y++) {
      row[y] = A[x - 1] === B[y - 1] ? prevRow[y - 1] + 1 : Math.max(prevRow[y], row[y - 1]);
    }
    prevRow = row;
  }
  return prevRow[B.length] / A.length;
}

function sendJson(res, status, body, filename) {
  const payload = JSON.stringify(body, null, 2);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CONFIG.corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Cache-Control': 'no-cache'
  };
  // When a filename is supplied the caller asked for ?download=1: force a file save instead of
  // letting the browser render the JSON inline. Quoted to survive spaces; the name is built from
  // sanitised ids by jsonFilename().
  if (filename) {
    headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

// Build a safe download filename like "transcript_qsg-difo-yhf_2026-07-31T13-30-48.json".
// Strips anything outside [A-Za-z0-9._-] so a crafted id cannot inject header characters or path
// separators into Content-Disposition.
function jsonFilename(kind, meetingId, sessionId) {
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `${kind}_${safe(meetingId)}_${safe(sessionId)}.json`;
}

// Merge stored sessions with live in-memory sessions to build per-session descriptors.
async function collectSessions(meetingIdFilter) {
  const stored = await storage.listSessions();
  const byId = new Map();

  for (const s of stored) {
    if (meetingIdFilter && s.meetingId !== safeSegment(meetingIdFilter)) continue;
    let meta = await storage.readJSON(s.meetingId, s.sessionId, 'meta.json');
    if (!meta) {
      meta = {
        meetingId: s.meetingId, sessionId: s.sessionId, status: 'unknown',
        startedAt: s.files['recording.webm'] && s.files['recording.webm'].updated || null,
        endedAt: null, durationMs: null, participantCount: null, transcriptLineCount: null
      };
    }
    meta.hasRecording = !!s.files['recording.webm'];
    meta.recordingSize = s.files['recording.webm'] ? s.files['recording.webm'].size : 0;
    byId.set(`${s.meetingId}/${s.sessionId}`, meta);
  }

  // Overlay currently-active sessions (fresher than the last flush).
  for (const session of sessions.values()) {
    if (meetingIdFilter && session.meetingId !== safeSegment(meetingIdFilter)) continue;
    const m = metaFromSession(session);
    m.hasRecording = session.chunkCount > 0;
    m.recordingSize = session.bytes;
    m.live = true;
    byId.set(`${session.meetingId}/${session.id}`, m);
  }

  return Array.from(byId.values());
}

function latestSession(list) {
  return list.slice().sort((a, b) =>
    String(b.startedAt || b.sessionId).localeCompare(String(a.startedAt || a.sessionId)))[0];
}

async function resolveSession(meetingId, sessionId) {
  const list = await collectSessions(meetingId);
  if (!list.length) return null;
  if (sessionId) return list.find(s => s.sessionId === safeSegment(sessionId)) || null;
  return latestSession(list);
}

// Read transcript/participants, preferring live in-memory data for active sessions.
async function readArtifact(meetingId, sessionId, kind) {
  for (const session of sessions.values()) {
    if (session.meetingId === safeSegment(meetingId) && session.id === sessionId) {
      if (kind === 'transcript') return { lines: session.transcript };
      return { events: session.participants, roster: buildRoster(session.participants) };
    }
  }
  return storage.readJSON(meetingId, sessionId, kind === 'transcript' ? 'transcript.json' : 'participants.json');
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Schedule registry API: the ERP registers/removes occurrences (API-key protected); the extension
// does an unauthenticated lookup to learn whether a meeting is domain-bound.
async function handleSchedulesApi(req, res, parsed, parts) {
  const sub = parts[1];

  // --- Public: extension lookup ---
  if (sub === 'lookup' && req.method === 'GET') {
    const meetingId = parsed.searchParams.get('meetingId');
    const email = (parsed.searchParams.get('email') || '').trim().toLowerCase();
    if (!meetingId) return sendJson(res, 400, { error: 'meetingId required' });
    const occ = registry.lookup(meetingId);
    const bound = !!occ;
    const domain = email.includes('@') ? email.split('@').pop() : '';
    const internal = !!domain && domain === CONFIG.allowedEmailDomain;
    return sendJson(res, 200, {
      meetingId,
      bound,
      internal,
      requiresKey: !bound && !internal,     // external user on an unregistered meeting -> needs key
      autoRecord: occ ? occ.autoRecord : false,
      allowedDomain: CONFIG.allowedEmailDomain,
      // Never leak faculty email to the browser.
      meeting: occ ? {
        batchName: occ.batchName, facultyName: occ.facultyName,
        startAt: occ.startAt, endAt: occ.endAt,
        scheduleId: occ.scheduleId, splitScheduleId: occ.splitScheduleId
      } : null
    });
  }

  // --- Everything else requires the ERP API key (when configured) ---
  if (CONFIG.scheduleApiKey && req.headers['x-api-key'] !== CONFIG.scheduleApiKey) {
    return sendJson(res, 401, { error: 'Invalid or missing X-Api-Key' });
  }

  if (!sub && req.method === 'GET') {
    const all = registry.all();
    return sendJson(res, 200, { count: all.length, occurrences: all });
  }

  if (!sub && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
    const list = Array.isArray(body) ? body : (Array.isArray(body.occurrences) ? body.occurrences : [body]);
    const saved = registry.upsertMany(list);
    return sendJson(res, 200, { ok: true, upserted: saved.length });
  }

  if (req.method === 'DELETE') {
    const target = parts[2] && decodeURIComponent(parts[2]);
    if (sub === 'schedule' && target) return sendJson(res, 200, { ok: true, removed: registry.removeBySchedule(target) });
    if (sub === 'split' && target) return sendJson(res, 200, { ok: true, removed: registry.removeBySplit(target) });
    if (sub === 'meeting' && target) return sendJson(res, 200, { ok: true, removed: registry.removeByMeeting(target) });
    return sendJson(res, 400, { error: 'DELETE /api/schedules/{schedule|split|meeting}/:id' });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function handleApi(req, res, parsed) {
  const parts = parsed.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  // /api/schedules[...] — ERP registration + extension lookup
  if (parts[0] === 'schedules') {
    return handleSchedulesApi(req, res, parsed, parts);
  }

  // GET /api/health
  if (parts[0] === 'health' && parts.length === 1) {
    return sendJson(res, 200, {
      ok: true, version: SERVER_VERSION, backend: storage.backend, bucket: storage.bucketName,
      activeSessions: sessions.size, uptimeSec: Math.round((Date.now() - startedAtServer) / 1000)
    });
  }

  // GET /api/meetings
  if (parts[0] === 'meetings' && parts.length === 1) {
    const all = await collectSessions(null);
    const meetings = new Map();
    for (const s of all) {
      if (!meetings.has(s.meetingId)) meetings.set(s.meetingId, []);
      meetings.get(s.meetingId).push(s);
    }
    const out = Array.from(meetings.entries()).map(([meetingId, list]) => ({
      meetingId,
      sessionCount: list.length,
      lastActivityAt: latestSession(list) ? (latestSession(list).updatedAt || latestSession(list).startedAt) : null,
      sessions: list.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
    }));
    out.sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));
    return sendJson(res, 200, { count: out.length, meetings: out });
  }

  // /api/meetings/:meetingId[/recording|/transcript|/participants]
  if (parts[0] === 'meetings' && parts.length >= 2) {
    const meetingId = parts[1];
    const sub = parts[2];
    const sessionId = parsed.searchParams.get('sessionId');

    if (!sub) {
      const list = await collectSessions(meetingId);
      if (!list.length) return sendJson(res, 404, { error: 'Meeting not found', meetingId });
      return sendJson(res, 200, { meetingId, sessionCount: list.length, sessions: list });
    }

    const session = await resolveSession(meetingId, sessionId);
    if (!session) return sendJson(res, 404, { error: 'Meeting/session not found', meetingId, sessionId });

    if (sub === 'recording') {
      if (!session.hasRecording) {
        return sendJson(res, 404, { error: 'No recording for this session', meetingId, sessionId: session.sessionId });
      }
      const url = await storage.getRecordingSignedUrl(meetingId, session.sessionId, CONFIG.signedUrlExpiresDays);
      if (parsed.searchParams.get('download') === '1') {
        res.writeHead(302, { Location: url, 'Access-Control-Allow-Origin': CONFIG.corsOrigin });
        return res.end();
      }
      return sendJson(res, 200, {
        meetingId, sessionId: session.sessionId, url,
        object: objectPath(meetingId, session.sessionId, 'recording.webm'),
        bucket: storage.bucketName,
        size: session.recordingSize,
        expiresAt: new Date(Date.now() + CONFIG.signedUrlExpiresDays * 86400000).toISOString()
      });
    }

    if (sub === 'transcript') {
      const data = await readArtifact(meetingId, session.sessionId, 'transcript');
      const lines = (data && data.lines) || [];
      const asFile = parsed.searchParams.get('download') === '1';
      return sendJson(res, 200,
        { meetingId, sessionId: session.sessionId, count: lines.length, lines },
        asFile ? jsonFilename('transcript', meetingId, session.sessionId) : null);
    }

    if (sub === 'participants') {
      const data = await readArtifact(meetingId, session.sessionId, 'participants');
      const events = (data && data.events) || [];
      const roster = (data && data.roster) || buildRoster(events);
      const asFile = parsed.searchParams.get('download') === '1';
      return sendJson(res, 200, {
        meetingId, sessionId: session.sessionId,
        eventCount: events.length,
        activeCount: roster.filter(r => !r.leftAt).length,
        totalCount: roster.length,
        events, roster
      }, asFile ? jsonFilename('participants', meetingId, session.sessionId) : null);
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// Serve local recording files (local backend only).
function handleLocalFile(req, res, parsed) {
  if (storage.backend !== 'local') {
    res.writeHead(404); return res.end('Not found');
  }
  const rel = decodeURIComponent(parsed.pathname.replace(/^\/files\//, ''));
  const resolved = storage.resolveServePath(rel);
  if (!resolved) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404); return res.end('File not found'); }
    const ct = resolved.endsWith('.webm') ? 'video/webm' : resolved.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}

const httpServer = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CONFIG.corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key'
    });
    return res.end();
  }

  if (parsed.pathname === '/' || parsed.pathname === '/api' || parsed.pathname === '/api/') {
    return sendJson(res, 200, {
      service: 'gmeet-recorder', version: SERVER_VERSION,
      endpoints: [
        'GET /api/health',
        'GET /api/meetings',
        'GET /api/meetings/:meetingId',
        'GET /api/meetings/:meetingId/recording[?sessionId=&download=1]',
        'GET /api/meetings/:meetingId/transcript[?sessionId=]',
        'GET /api/meetings/:meetingId/participants[?sessionId=]',
        'GET /api/schedules/lookup?meetingId=&email=   (public — extension binding check)',
        'GET /api/schedules                            (X-Api-Key)',
        'POST /api/schedules                           (X-Api-Key — register occurrences)',
        'DELETE /api/schedules/{schedule|split|meeting}/:id (X-Api-Key)'
      ]
    });
  }

  if (parsed.pathname.startsWith('/api/')) {
    Promise.resolve(handleApi(req, res, parsed)).catch(err => {
      logger.error({ err: err.message, url: req.url }, 'API handler error');
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error', detail: err.message });
    });
    return;
  }

  if (parsed.pathname.startsWith('/files/')) return handleLocalFile(req, res, parsed);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------------------------------------------------------------------
// WebSocket server (hardened)
// ---------------------------------------------------------------------------
function originAllowed(origin) {
  if (!CONFIG.allowedOrigins.length) return true; // allow-all when unset
  if (!origin) return false;
  return CONFIG.allowedOrigins.some(rule => {
    if (rule === '*') return true;
    if (rule.endsWith('*')) return origin.startsWith(rule.slice(0, -1));
    return origin === rule;
  });
}

const wss = new WebSocket.Server({
  server: httpServer,
  maxPayload: CONFIG.maxPayloadBytes,
  verifyClient: (info, done) => {
    const origin = info.origin || info.req.headers.origin;
    if (!originAllowed(origin)) {
      logger.warn({ origin }, 'WS connection rejected: origin not allowed');
      return done(false, 403, 'Forbidden origin');
    }
    done(true);
  }
});

// Behind the ERP's nginx (/gmr/ -> :8001) every socket comes from loopback; use the forwarded client
// address then. Only trusted from loopback so a direct client can't spoof it.
function clientAddress(req) {
  const peer = req.socket.remoteAddress || '';
  const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const fwd = req.headers['x-forwarded-for'];
  if (isLoopback && fwd) return String(fwd).split(',')[0].trim();
  return peer;
}

wss.on('connection', (ws, req) => {
  const remoteAddress = clientAddress(req);
  logger.info({ remoteAddress, origin: req.headers.origin }, 'WS client connected');

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    try {
      const session = sessionByWs.get(ws);
      if (isBinary) {
        handleBinaryMessage(data, session);
      } else {
        handleJSONMessage(JSON.parse(data.toString()), ws, session, remoteAddress);
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Error handling WS message');
    }
  });

  ws.on('close', (code) => {
    const session = sessionByWs.get(ws);
    logger.info({ remoteAddress, code, sessionId: session && session.id }, 'WS client disconnected');
    if (session) {
      sessionByWs.delete(ws);
      if (session.ws === ws) session.ws = null;
      // During shutdown the session is persisted to the spool instead and restored on restart.
      if (shuttingDown || session.finalized) return;
      session.state = 'disconnected';
      session.dirty.meta = true;
      scheduleFlush(session);
      // Wait for a disconnect grace period before finalizing so the recorder can reconnect and keep
      // writing the same file.
      armDisconnectTimer(session);
    }
  });

  ws.on('error', (err) => logger.error({ err: err.message }, 'WS error'));
});

// Heartbeat: terminate sockets that miss 2 consecutive pongs (tolerant to transient network/event-loop spikes).
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.missedPings === undefined) ws.missedPings = 0;
    if (ws.isAlive === false) {
      ws.missedPings++;
      if (ws.missedPings >= 2) {
        logger.warn('Terminating unresponsive WS client (missed 2 consecutive pongs)');
        return ws.terminate();
      }
    } else {
      ws.missedPings = 0;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, CONFIG.heartbeatIntervalMs);
wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Missed-recording watchdog: email the faculty (cc admins) when a scheduled class starts and no
// recording data arrives within the grace window. Runs on an interval; each occurrence is emailed
// at most once.
// ---------------------------------------------------------------------------
let watchdogTimer = null;
let uploadRetryTimer = null;

async function runMissedRecordingWatchdog() {
  try {
    // Meetings with a recording open right now — the finished session only pushes at class end, so
    // treat an in-progress recording as "not missed" (avoids alerting during a long class).
    const activeMeetingIds = new Set(Array.from(sessions.values())
      .filter(s => s.clientType === 'recorder').map(s => s.meetingId));
    const due = registry.dueForMissedEmail(CONFIG.missedGraceMinutes, CONFIG.missedWindowMinutes, CONFIG.missedCutoverIso, activeMeetingIds);
    for (const occ of due) {
      if (CONFIG.missedEmailsEnabled) {
        const { subject, html } = missedRecordingEmail(occ, CONFIG.missedGraceMinutes);
        const cc = Array.from(new Set([...(occ.adminEmails || []), ...CONFIG.adminAlertEmails]))
          .filter(a => a && a !== occ.facultyEmail);
        const result = await mailer.send({ to: occ.facultyEmail, cc, subject, html });
        logger.info({ meetingId: occ.meetingId, faculty: occ.facultyEmail, cc, sent: result.sent, reason: result.reason },
          result.sent ? 'Missed-recording alert emailed' : 'Missed-recording alert not sent');
      } else {
        logger.info({ meetingId: occ.meetingId, faculty: occ.facultyEmail },
          'Missed-recording alert skipped (MISSED_RECORDING_EMAILS_ENABLED=false)');
      }

      // Mark emailed regardless of send outcome/toggle so we don't reprocess this occurrence every tick.
      registry.markMissedEmailed(occ);
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Missed-recording watchdog error');
  }
}

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------
async function start() {
  logger.info({ backend: CONFIG.backend, bucket: CONFIG.bucketName, allowedDomain: CONFIG.allowedEmailDomain,
    spoolDir: CONFIG.spoolDir, disconnectGraceMs: CONFIG.disconnectGraceMs },
    'Starting GMeet Recorder server');
  if (CONFIG.selfCheck) {
    try {
      await storage.init();
    } catch (err) {
      logger.error({ err: err.message },
        'Storage self-check FAILED. Check GCS_BUCKET_NAME / service account object permissions, ' +
        'or set STORAGE_BACKEND=local for local testing.');
      process.exit(1);
    }
  }
  await registry.init();
  await fs.promises.mkdir(CONFIG.spoolDir, { recursive: true });
  await recoverSpooledSessions();
  uploadRetryTimer = setInterval(() => {
    retryPendingUploads().catch(err => logger.error({ err: err.message }, 'Upload retry sweep error'));
  }, CONFIG.uploadRetryIntervalMs);
  watchdogTimer = setInterval(runMissedRecordingWatchdog, CONFIG.watchdogIntervalMs);
  logger.info({ graceMin: CONFIG.missedGraceMinutes, intervalMs: CONFIG.watchdogIntervalMs },
    'Missed-recording watchdog started');
  httpServer.listen(CONFIG.port, CONFIG.host, () => {
    logger.info({ host: CONFIG.host, port: CONFIG.port, publicBaseUrl: CONFIG.publicBaseUrl,
      backendPush: backendNotifier.enabled, mailer: mailer.enabled },
      'Server listening (WebSocket + HTTP API)');
  });
}

let shuttingDown = false;
// A restart/deploy must not split live recordings. Instead of finalizing, close each live session's
// spool and persist its state; on startup recoverSpooledSessions() restores them and the recorders
// (which retry every few seconds) re-attach to the same session and keep writing the same file.
// Sessions already uploading are picked up again by recovery.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, activeSessions: sessions.size }, 'Graceful shutdown: persisting live sessions to spool');
  clearInterval(heartbeat);
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (uploadRetryTimer) clearInterval(uploadRetryTimer);
  // Hard exit if something hangs.
  setTimeout(() => { logger.warn('Forced exit after shutdown timeout'); process.exit(0); }, 15000).unref();

  await registry.flush();

  // Stop accepting connections and drop the live ones so no chunk arrives mid-persist.
  wss.close();
  for (const client of wss.clients) { try { client.terminate(); } catch (_) { /* ignore */ } }

  await Promise.all(Array.from(sessions.values()).map(async (s) => {
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    if (s.disconnectTimer) { clearTimeout(s.disconnectTimer); s.disconnectTimer = null; }
    if (s.finalized) return; // upload in flight; state.json already says finalized -> resumed on start
    await endRecordingStream(s);
    s.state = 'disconnected';
    s.dirty.meta = true;
    await flushSession(s, { force: true });
  }));

  httpServer.close(() => {
    logger.info('Server closed cleanly');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception'));
process.on('unhandledRejection', (err) => logger.error({ err: err && err.message }, 'Unhandled rejection'));

start();
