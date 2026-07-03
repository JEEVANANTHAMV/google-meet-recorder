# BETA ERP ↔ Google Meet Recorder — Integration

This document describes how the **Google Meet Recorder** extension + server replaces the old external
`meet.innosynth.org` meeting-bot. Recordings, participants and transcripts are now captured by the
faculty's **browser** (no per-meeting server-side bot / separate machine) and streamed to the
in-house recorder server, which pushes each finished session back to the ERP.

## Components

| Component | Location | Role |
|-----------|----------|------|
| Extension (client) | `google-meet-recorder/extension` | Records the Meet tab (video+audio), tracks participants, captures live-caption transcript, streams to the recorder over WebSocket. Enforces domain binding / external key. |
| Recorder server | `google-meet-recorder/test-server` | WS ingest → GCS; HTTP read API; **schedule registry**; **domain/key auth gate**; **push to ERP webhook** on finish; **10-min missed-recording email watchdog**. |
| ERP backend | `BETA-CRM-BASE-GCP` | Registers each scheduled class with the recorder; stores pushed sessions in `crm_036_meeting_session_data`; generates the AI summary; serves the frontend read endpoints (unchanged). |
| ERP frontend | `BETA-CRM-UI-GCP` | Unchanged — the `schedule/v1/meeting-*` endpoint contracts are preserved. |

## End-to-end flow

```
Schedule create/edit (ERP)
  └─ MeetingBotService.createBot(schedule)
       ├─ parse Google Meet code from meetingLink  ("abc-defg-hij")  → stored as meetingBotId
       └─ POST {recorder}/api/schedules  (X-Api-Key)  → registers the occurrence
                                                        (faculty email, batch, start/end, admins)

Faculty joins the Meet
  └─ extension content.js → background SCHEDULE_LOOKUP → GET {recorder}/api/schedules/lookup
       ├─ bound (scheduled) or internal @mybeta.ca → recording allowed (auto-prompt to start)
       └─ external + unbound → must enter access key  (InnoSynth@12)

Recording
  └─ offscreen.js WS auth {meetingId, email, accessKey} → server authorizes (domain OR bound OR key)
       └─ video chunks → GCS ; participant + transcript events → GCS JSON

Meeting ends (or tab closes)
  └─ server finalizes session → links to the scheduled occurrence (by date)
       └─ POST {ERP}/api/schedule/v1/meeting-data/webhook  (X-Recorder-Secret)
            payload: { meetingId, sessionId, recordingObject, participants, participantEvents,
                       transcript, durationSeconds, splitScheduleId, ... }
       └─ ERP MeetingSessionDataService.saveFromRecorderPush()
            → maps meetingId → class/split schedule (date-matched) → stores crm_036 row
            → MeetingSummaryService.generateSummary() → replicate to sibling batches

Watchdog (recorder, every 60s)
  └─ scheduled occurrence started > 10 min ago AND no recording data received
       └─ email faculty (cc admins) via SMTP, once per occurrence

Frontend
  └─ reads schedule/v1/meeting-data/by-split, meeting-summary/by-split, meeting-bot/{code}, ...
     (unchanged; recording URLs are GCS object paths signed fresh on read against the meet-cloud bucket)
```

## Domain binding & external access key

A recording is accepted by the server when **any** of these is true (checked in the WS `auth`):

1. **Internal user** — the Chrome account email domain equals `ALLOWED_EMAIL_DOMAIN` (`mybeta.ca`).
2. **Bound meeting** — the meeting code is registered in the schedule registry (scheduled in the ERP).
3. **External key** — the client sends `EXTERNAL_ACCESS_KEY` (`InnoSynth@12`).

Otherwise the server rejects with `ACCESS_KEY_REQUIRED` and the extension shows an in-page key prompt.
The extension reads the signed-in Chrome account email via `chrome.identity.getProfileUserInfo`
(the `identity` permission).

> Auto-start note: browsers require a user gesture + screen-share picker for `getDisplayMedia`, so a
> scheduled class shows a prominent "start recording" prompt / one-gesture start rather than a fully
> silent capture. The extension attempts a programmatic start and falls back to the prompt.

## Matched configuration (must agree on both sides)

| Setting | Recorder (`test-server/.env`) | ERP (`application*.yml`) |
|---------|-------------------------------|---------------------------|
| Recorder base URL | `PUBLIC_BASE_URL`, served on `PORT` | `meeting-bot.api.url` |
| Schedule API key | `SCHEDULE_API_KEY` | `meeting-bot.schedule-api-key` |
| Webhook target | `BACKEND_WEBHOOK_URL` | `meeting-bot.webhook.url` |
| Webhook secret | `BACKEND_WEBHOOK_SECRET` | `meeting-bot.webhook.secret` |
| GCS bucket | `GCS_BUCKET_NAME` (`meet-cloud`) | `meeting-bot.storage.bucket` (`meet-cloud`) |
| Allowed domain | `ALLOWED_EMAIL_DOMAIN` (`mybeta.ca`) | (enforced on recorder) |
| External key | `EXTERNAL_ACCESS_KEY` (`InnoSynth@12`) | (enforced on recorder) |

Replace the `change-me-*` placeholders with real shared secrets before going live. SMTP creds in
`test-server/.env` are copied from the ERP Base codebase (AWS SES, `no-reply@mybeta.ca`).

> The ERP's GCS service account must be able to sign objects in the `meet-cloud` bucket (both are in
> project `betacrmerp`) — that's how recording download URLs are minted for the frontend.

## Rehosting the recorder server

```bash
cd google-meet-recorder/test-server
npm install                    # now includes nodemailer
cp .env.example .env           # then fill secrets (or edit the committed .env)
# ensure Service-Account.json (GCS) is present, or STORAGE_BACKEND=local for a quick test
npm start                      # WebSocket + HTTP on PORT (default 8001)
```

Health check: `GET http://<host>:8001/api/health` → `{ ok: true, version: "3.0.0", ... }`.

The extension defaults to `ws://18.204.127.179:8001` (WS) and `http://18.204.127.179:8001` (API). If
you move the server, update `DEFAULT_WS_URL` / `DEFAULT_API_BASE` in `extension/background.js` (and the
matching host in `extension/manifest.json` `host_permissions`), then reload the extension. Because a
Meet page is HTTPS, the schedule lookup is performed from the extension **background worker**
(chrome-extension origin) to avoid mixed-content blocking; recording uses `ws://` from the offscreen
document. For a fully HTTPS deployment, front the server with TLS and switch to `wss://`/`https://`.

## New / changed server API

- `GET  /api/schedules/lookup?meetingId=&email=` — public; extension binding check.
- `POST /api/schedules` — `X-Api-Key`; register occurrence(s) `{scheduleId, splitScheduleId, meetingId, facultyEmail, facultyName, batchName, adminEmails[], startAt, endAt, meetingLink}`.
- `DELETE /api/schedules/{schedule|split|meeting}/:id` — `X-Api-Key`; deregister.
- (existing) `GET /api/meetings/:meetingId[/recording|/transcript|/participants]` — recording response now also returns `object` (GCS path) + `bucket`.
