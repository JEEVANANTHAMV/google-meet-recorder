// storage.js - Pluggable storage backend for recordings + meeting metadata.
//
// Two backends:
//   - "gcs"   (default, production): streams recordings to Google Cloud Storage via resumable
//             uploads, stores JSON artifacts as objects, and mints V4 signed download URLs.
//   - "local" (dev/testing): mirrors the exact same layout on local disk and serves files over HTTP.
//
// Object / file layout (identical for both backends):
//   meetings/{meetingId}/{sessionId}/recording.webm
//   meetings/{meetingId}/{sessionId}/participants.json
//   meetings/{meetingId}/{sessionId}/transcript.json
//   meetings/{meetingId}/{sessionId}/meta.json
//
// NOTE: the provided service account only has OBJECT-level access to the bucket, so this module
// never calls bucket.exists()/get()/create() — those require bucket-level IAM and would 403.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT_PREFIX = 'meetings';

// Only allow safe path components (defends the HTTP API against traversal via :meetingId etc.)
function safeSegment(seg) {
  return String(seg || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function objectPath(meetingId, sessionId, name) {
  return `${ROOT_PREFIX}/${safeSegment(meetingId)}/${safeSegment(sessionId)}/${name}`;
}

// ----------------------------------------------------------------------------
// GCS backend
// ----------------------------------------------------------------------------
function createGcsBackend(config) {
  const { Storage } = require('@google-cloud/storage');
  const storageOpts = { projectId: config.projectId };
  if (config.keyFilename && fs.existsSync(config.keyFilename)) {
    storageOpts.keyFilename = config.keyFilename;
  }
  const storage = new Storage(storageOpts);
  const bucket = storage.bucket(config.bucketName);

  return {
    backend: 'gcs',
    bucketName: config.bucketName,

    // Validate credentials by writing + deleting a tiny object (does NOT need bucket-level IAM).
    async init() {
      const probe = bucket.file(`${ROOT_PREFIX}/_healthcheck/probe-${Date.now()}.txt`);
      await probe.save(Buffer.from('ok'), { contentType: 'text/plain', resumable: false });
      await probe.delete({ ignoreNotFound: true });
      logger.info({ bucket: config.bucketName }, 'GCS storage backend ready (object write verified)');
    },

    createRecordingWriteStream(meetingId, sessionId) {
      const file = bucket.file(objectPath(meetingId, sessionId, 'recording.webm'));
      return file.createWriteStream({
        resumable: true,
        contentType: 'video/webm',
        metadata: { contentType: 'video/webm', metadata: { meetingId, sessionId } }
      });
    },

    async writeJSON(meetingId, sessionId, name, obj) {
      const file = bucket.file(objectPath(meetingId, sessionId, name));
      await file.save(Buffer.from(JSON.stringify(obj, null, 2)), {
        contentType: 'application/json',
        resumable: false,
        metadata: { contentType: 'application/json', cacheControl: 'no-cache' }
      });
    },

    async readJSON(meetingId, sessionId, name) {
      const file = bucket.file(objectPath(meetingId, sessionId, name));
      try {
        const [buf] = await file.download();
        return JSON.parse(buf.toString('utf8'));
      } catch (err) {
        if (err.code === 404) return null;
        throw err;
      }
    },

    async recordingExists(meetingId, sessionId) {
      const file = bucket.file(objectPath(meetingId, sessionId, 'recording.webm'));
      try {
        const [meta] = await file.getMetadata();
        return { exists: true, size: Number(meta.size || 0), updated: meta.updated };
      } catch (err) {
        if (err.code === 404) return { exists: false };
        throw err;
      }
    },

    async getRecordingSignedUrl(meetingId, sessionId, expiresDays) {
      const file = bucket.file(objectPath(meetingId, sessionId, 'recording.webm'));
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresDays * 24 * 3600 * 1000
      });
      return url;
    },

    // Discover all {meetingId, sessionId} sessions present in the bucket.
    async listSessions() {
      const [files] = await bucket.getFiles({ prefix: `${ROOT_PREFIX}/` });
      return groupSessions(files.map(f => ({
        name: f.name,
        size: Number(f.metadata && f.metadata.size) || 0,
        updated: f.metadata && f.metadata.updated
      })));
    }
  };
}

// ----------------------------------------------------------------------------
// Local backend
// ----------------------------------------------------------------------------
function createLocalBackend(config) {
  const root = path.resolve(config.localRoot);
  fs.mkdirSync(root, { recursive: true });

  const fullPath = (meetingId, sessionId, name) => {
    const p = path.join(root, objectPath(meetingId, sessionId, name));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  };

  return {
    backend: 'local',
    bucketName: root,
    localRoot: root,

    async init() {
      logger.info({ root }, 'Local storage backend ready');
    },

    createRecordingWriteStream(meetingId, sessionId) {
      return fs.createWriteStream(fullPath(meetingId, sessionId, 'recording.webm'));
    },

    async writeJSON(meetingId, sessionId, name, obj) {
      await fs.promises.writeFile(fullPath(meetingId, sessionId, name), JSON.stringify(obj, null, 2));
    },

    async readJSON(meetingId, sessionId, name) {
      try {
        const buf = await fs.promises.readFile(fullPath(meetingId, sessionId, name), 'utf8');
        return JSON.parse(buf);
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    async recordingExists(meetingId, sessionId) {
      try {
        const st = await fs.promises.stat(fullPath(meetingId, sessionId, 'recording.webm'));
        return { exists: true, size: st.size, updated: st.mtime.toISOString() };
      } catch (err) {
        if (err.code === 'ENOENT') return { exists: false };
        throw err;
      }
    },

    async getRecordingSignedUrl(meetingId, sessionId) {
      // No signing for local files — return a direct HTTP URL served by the API server.
      const rel = objectPath(meetingId, sessionId, 'recording.webm');
      return `${config.publicBaseUrl}/files/${rel}`;
    },

    // Resolve a request path under the local root, guarding against traversal.
    resolveServePath(relPath) {
      const resolved = path.resolve(root, relPath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
      return resolved;
    },

    async listSessions() {
      const out = [];
      const base = path.join(root, ROOT_PREFIX);
      if (!fs.existsSync(base)) return out;
      const files = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(fp);
          else {
            const st = fs.statSync(fp);
            files.push({
              name: path.relative(root, fp).split(path.sep).join('/'),
              size: st.size,
              updated: st.mtime.toISOString()
            });
          }
        }
      };
      walk(base);
      return groupSessions(files);
    }
  };
}

// Group a flat list of objects/files into per-session descriptors.
function groupSessions(files) {
  const sessions = new Map(); // key meetingId/sessionId
  for (const f of files) {
    const parts = f.name.split('/');
    // meetings / {meetingId} / {sessionId} / {artifact}
    if (parts.length < 4 || parts[0] !== ROOT_PREFIX) continue;
    const meetingId = parts[1];
    const sessionId = parts[2];
    const artifact = parts.slice(3).join('/');
    if (meetingId === '_healthcheck') continue;
    const key = `${meetingId}/${sessionId}`;
    if (!sessions.has(key)) sessions.set(key, { meetingId, sessionId, files: {} });
    sessions.get(key).files[artifact] = { size: f.size, updated: f.updated };
  }
  return Array.from(sessions.values());
}

// ----------------------------------------------------------------------------
function createStorage(config) {
  if (config.backend === 'local') return createLocalBackend(config);
  return createGcsBackend(config);
}

module.exports = { createStorage, objectPath, safeSegment, ROOT_PREFIX };
