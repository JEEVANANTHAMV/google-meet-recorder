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
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://164.52.198.68:${process.env.PORT || '8001'}`,
  signedUrlExpiresDays: parseInt(process.env.SIGNED_URL_EXPIRES_DAYS || '7', 10),
  selfCheck: process.env.STORAGE_SELFCHECK !== 'false',
  // WS hardening
  maxPayloadBytes: parseInt(process.env.WS_MAX_PAYLOAD_MB || '16', 10) * 1024 * 1024,
  allowedOrigins: (process.env.WS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  authToken: process.env.AUTH_TOKEN || '',
  heartbeatIntervalMs: parseInt(process.env.WS_HEARTBEAT_MS || '15000', 10),
  flushIntervalMs: parseInt(process.env.EVENT_FLUSH_MS || '5000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*'
};

const SERVER_VERSION = '2.0.0';

const storage = createStorage(CONFIG);

// Active sessions, keyed by sessionId, plus lookups by socket and by meeting.
const sessions = new Map();        // sessionId -> session
const sessionByWs = new Map();     // ws -> session
const recordingByMeeting = new Map(); // meetingId -> sessionId (currently-open recorder)

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
function buildRoster(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.participantId || e.name;
    if (!key) continue;
    if (e.event === 'joined') {
      if (!map.has(key) || map.get(key).leftAt) {
        map.set(key, { id: e.participantId || null, name: e.name, joinedAt: e.timestamp, leftAt: null });
      }
    } else if (e.event === 'left' && map.has(key)) {
      map.get(key).leftAt = e.timestamp;
    }
  }
  return Array.from(map.values());
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

async function flushSession(session, { force = false } = {}) {
  try {
    if (force || session.dirty.participants) {
      session.dirty.participants = false;
      await storage.writeJSON(session.meetingId, session.id, 'participants.json', {
        meetingId: session.meetingId,
        sessionId: session.id,
        events: session.participants,
        roster: buildRoster(session.participants)
      });
    }
    if (force || session.dirty.transcript) {
      session.dirty.transcript = false;
      await storage.writeJSON(session.meetingId, session.id, 'transcript.json', {
        meetingId: session.meetingId,
        sessionId: session.id,
        lines: session.transcript
      });
    }
    if (force || session.dirty.meta) {
      session.dirty.meta = false;
      await storage.writeJSON(session.meetingId, session.id, 'meta.json', metaFromSession(session));
    }
  } catch (err) {
    logger.error({ err: err.message, sessionId: session.id }, 'Failed to flush session artifacts');
  }
}

function scheduleFlush(session) {
  if (session.flushTimer) return;
  session.flushTimer = setTimeout(async () => {
    session.flushTimer = null;
    await flushSession(session);
  }, CONFIG.flushIntervalMs);
}

// End the recording stream and wait for the upload to finalize.
function endRecordingStream(session) {
  return new Promise((resolve) => {
    if (!session.recordingStream) return resolve();
    const stream = session.recordingStream;
    session.recordingStream = null;
    stream.end();
    stream.once('finish', resolve);
    stream.once('error', (err) => {
      logger.error({ err: err.message, sessionId: session.id }, 'Recording stream error on finalize');
      resolve();
    });
  });
}

async function finalizeSession(session, reason) {
  if (session.finalized) return;
  session.finalized = true;
  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null; }

  await endRecordingStream(session);

  session.endedAt = session.endedAt || new Date().toISOString();
  session.state = session.recordingError ? 'error' : 'ended';
  session.dirty.meta = true;
  await flushSession(session, { force: true });

  if (recordingByMeeting.get(session.meetingId) === session.id) {
    recordingByMeeting.delete(session.meetingId);
  }
  sessions.delete(session.id);
  if (session.ws) sessionByWs.delete(session.ws);

  logger.info({
    sessionId: session.id, meetingId: session.meetingId, reason,
    chunks: session.chunkCount, bytes: session.bytes,
    participants: distinctParticipantCount(session.participants),
    transcriptLines: session.transcript.length,
    durationSec: ((Date.now() - session.startTimeMs) / 1000).toFixed(1)
  }, 'Session finalized');
}

// ---------------------------------------------------------------------------
// WebSocket message handling
// ---------------------------------------------------------------------------
function handleAuth(message, ws, remoteAddress) {
  if (CONFIG.authToken && message.token !== CONFIG.authToken) {
    logger.warn({ remoteAddress, meetingId: message.meetingId }, 'Auth rejected: bad token');
    ws.send(JSON.stringify({ type: 'status', ok: false, message: 'Unauthorized' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  const meetingId = safeSegment(message.meetingId || 'unknown');
  const clientType = message.clientType || 'recorder';

  // Connection limit: refuse a second concurrent recorder for the same meeting (prevents
  // duplicate uploads). A reconnect after the old socket closed is fine — that session is gone.
  if (clientType === 'recorder' && recordingByMeeting.has(meetingId)) {
    const existing = sessions.get(recordingByMeeting.get(meetingId));
    if (existing && existing.ws && existing.ws.readyState === WebSocket.OPEN && existing.ws !== ws) {
      logger.warn({ meetingId }, 'Auth rejected: meeting already being recorded');
      ws.send(JSON.stringify({ type: 'status', ok: false, message: 'Meeting already being recorded' }));
      ws.close(4002, 'Duplicate recorder');
      return;
    }
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
    bytes: 0,
    participants: [],
    transcript: [],
    recordingStream: null,
    recordingError: null,
    finalized: false,
    flushTimer: null,
    dirty: { participants: false, transcript: false, meta: true },
    ws,
    remoteAddress
  };

  sessions.set(session.id, session);
  sessionByWs.set(ws, session);
  if (clientType === 'recorder') recordingByMeeting.set(meetingId, session.id);

  // Persist initial meta so the meeting shows up immediately and survives a crash.
  flushSession(session, { force: true });

  logger.info({ sessionId: session.id, meetingId, clientType, remoteAddress }, 'Session authenticated');

  ws.send(JSON.stringify({
    type: 'status', ok: true, message: 'Authenticated', sessionId: session.id, meetingId
  }));
}

function handleRecordingChunk(session, sequence, timestamp, data) {
  if (!session) return;
  if (!session.recordingStream) {
    session.recordingStream = storage.createRecordingWriteStream(session.meetingId, session.id);
    session.recordingStream.on('error', (err) => {
      session.recordingError = err.message;
      logger.error({ err: err.message, sessionId: session.id }, 'Recording upload stream error');
    });
    logger.info({ sessionId: session.id, object: objectPath(session.meetingId, session.id, 'recording.webm') },
      'Recording upload started');
  }
  session.recordingStream.write(data);
  session.chunkCount = sequence;
  session.bytes += data.length;
  if (sequence % 30 === 0) {
    session.dirty.meta = true;
    scheduleFlush(session);
    logger.debug({ sessionId: session.id, chunks: sequence, mb: (session.bytes / 1048576).toFixed(2) },
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
  if (session.chunkCount > 0 && session.ws && session.ws.readyState === WebSocket.OPEN) {
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
    case 'participant':
      if (!session) return;
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
    case 'transcript':
      if (!session) return;
      session.transcript.push({
        speaker: message.speaker,
        text: message.text,
        timestamp: message.timestamp,
        receivedAt: new Date().toISOString()
      });
      session.dirty.transcript = true;
      session.dirty.meta = true;
      scheduleFlush(session);
      break;
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
function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CONFIG.corsOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-cache'
  });
  res.end(payload);
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

async function handleApi(req, res, parsed) {
  const parts = parsed.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

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
        size: session.recordingSize,
        expiresAt: new Date(Date.now() + CONFIG.signedUrlExpiresDays * 86400000).toISOString()
      });
    }

    if (sub === 'transcript') {
      const data = await readArtifact(meetingId, session.sessionId, 'transcript');
      const lines = (data && data.lines) || [];
      return sendJson(res, 200, { meetingId, sessionId: session.sessionId, count: lines.length, lines });
    }

    if (sub === 'participants') {
      const data = await readArtifact(meetingId, session.sessionId, 'participants');
      const events = (data && data.events) || [];
      const roster = (data && data.roster) || buildRoster(events);
      return sendJson(res, 200, {
        meetingId, sessionId: session.sessionId,
        eventCount: events.length,
        activeCount: roster.filter(r => !r.leftAt).length,
        totalCount: roster.length,
        events, roster
      });
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
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
        'GET /api/meetings/:meetingId/participants[?sessionId=]'
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

wss.on('connection', (ws, req) => {
  const remoteAddress = req.socket.remoteAddress;
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

  ws.on('close', () => {
    const session = sessionByWs.get(ws);
    logger.info({ remoteAddress, sessionId: session && session.id }, 'WS client disconnected');
    if (session) finalizeSession(session, 'socket_close');
  });

  ws.on('error', (err) => logger.error({ err: err.message }, 'WS error'));
});

// Heartbeat: terminate sockets that miss a pong (no more zombie connections).
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      logger.warn('Terminating unresponsive WS client (missed pong)');
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, CONFIG.heartbeatIntervalMs);
wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------
async function start() {
  logger.info({ backend: CONFIG.backend, bucket: CONFIG.bucketName }, 'Starting GMeet Recorder server');
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
  httpServer.listen(CONFIG.port, CONFIG.host, () => {
    logger.info({ host: CONFIG.host, port: CONFIG.port, publicBaseUrl: CONFIG.publicBaseUrl },
      'Server listening (WebSocket + HTTP API)');
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, activeSessions: sessions.size }, 'Graceful shutdown: draining sessions');
  clearInterval(heartbeat);

  // Stop accepting new connections, then finalize in-flight sessions (flush GCS uploads).
  wss.close();
  await Promise.all(Array.from(sessions.values()).map(s => finalizeSession(s, 'shutdown')));

  httpServer.close(() => {
    logger.info('Server closed cleanly');
    process.exit(0);
  });
  // Hard exit if something hangs.
  setTimeout(() => { logger.warn('Forced exit after shutdown timeout'); process.exit(0); }, 15000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception'));
process.on('unhandledRejection', (err) => logger.error({ err: err && err.message }, 'Unhandled rejection'));

start();
