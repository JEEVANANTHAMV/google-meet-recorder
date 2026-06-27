# GMeet Recorder — Server

WebSocket ingest + HTTP read API for the Google Meet Recorder extension.

- **WebSocket**: recorders connect, stream WebM video chunks (binary) and participant/transcript
  events (JSON). Video is streamed straight to **Google Cloud Storage** via resumable upload.
- **HTTP API**: list meetings and fetch each meeting's recording (signed URL), transcript, and
  participant history.

## Quick start

```bash
cd test-server
npm install
cp .env.example .env        # then edit values

# Verify GCS access (creates bucket if you have permission, else verifies object access):
npm run setup-gcs

npm start
```

Server listens on `PORT` (default **8001**) for both WebSocket and HTTP on the same port.

## Storage

Everything for a meeting is stored under one prefix, grouped by session
(`sessionId` is timestamp-based, so a meeting code recorded multiple times keeps every session):

```
meetings/{meetingId}/{sessionId}/recording.webm      # video/webm  (streamed, resumable)
meetings/{meetingId}/{sessionId}/participants.json    # join/leave event log + derived roster
meetings/{meetingId}/{sessionId}/transcript.json      # caption lines
meetings/{meetingId}/{sessionId}/meta.json            # status, timing, counts, recording size
```

Backends (set `STORAGE_BACKEND`):

- `gcs` (default, production) — bucket from `GCS_BUCKET_NAME` (default `meet-cloud`). Download URLs
  are **V4 signed URLs** expiring in `SIGNED_URL_EXPIRES_DAYS` (default 7).
- `local` (dev/testing) — mirrors the same layout under `recordings/` and serves files at `/files/...`.

### ⚠️ GCS bucket naming & IAM

- A bucket literally named **`Google-Meet-Extensions` is not valid**: GCS bucket names must be
  lowercase and **cannot contain the substring `google`**. The default used here is **`meet-cloud`**.
- The provided service account (`...-compute@developer.gserviceaccount.com`) currently has
  **object-level access only** on `meet-cloud` (upload / signed-url / list / read / delete all work).
  It **cannot create or list buckets**. To let the server auto-create buckets, grant it
  `roles/storage.admin`; otherwise pre-create the bucket and grant `roles/storage.objectAdmin` on it.

## HTTP API

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/health` | Server status, backend, active session count |
| GET | `/api/meetings` | All meetings, each with its sessions + summary |
| GET | `/api/meetings/:meetingId` | Sessions for one meeting |
| GET | `/api/meetings/:meetingId/recording` | `{ url, size, expiresAt }` signed download URL (latest session). `?sessionId=` to pick a session, `?download=1` to 302-redirect to the file |
| GET | `/api/meetings/:meetingId/transcript` | `{ count, lines: [{ speaker, text, timestamp }] }` |
| GET | `/api/meetings/:meetingId/participants` | `{ activeCount, totalCount, events, roster }` |

All endpoints default to the **latest** session for a meeting; pass `?sessionId=` to target a
specific one. Live (in-progress) sessions are served from memory so data is fresh before flush.

```bash
curl http://localhost:8001/api/meetings
curl http://localhost:8001/api/meetings/abc-defg-hij/participants
curl -L http://localhost:8001/api/meetings/abc-defg-hij/recording?download=1 -o meeting.webm
```

## WebSocket protocol

- **Binary** `[1B type][4B seq BE][8B ts BE][payload]` — `0x01` recording chunk, `0x04` recording end.
- **JSON** — `auth` (`{meetingId, clientType, token?}`), `participant`, `transcript`, `ping`/`pong`,
  `recording_end`. Server replies with `status`, `pong`, and `recording_saved` (contains the
  signed download URL).

### Hardening (configurable via `.env`)

- `WS_MAX_PAYLOAD_MB` — max frame size (default 16 MB).
- `WS_ALLOWED_ORIGINS` — comma list, supports `chrome-extension://*`; empty = allow all.
- `AUTH_TOKEN` — optional shared secret required in the `auth` message.
- `WS_HEARTBEAT_MS` — protocol-level ping; unresponsive sockets (missed pong) are terminated.
- One concurrent recorder per `meetingId` (rejects duplicate uploads); reconnect after a drop is fine.
- Graceful shutdown (`SIGINT`/`SIGTERM`) drains in-flight sessions and finalizes uploads.

## Config reference

See `.env.example` for all variables.
