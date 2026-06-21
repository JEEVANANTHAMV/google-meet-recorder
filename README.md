# Google Meet Recorder

A Chrome extension that records Google Meet sessions, tracks participants, captures live transcripts, and streams everything in real-time to a WebSocket server.

---

## Quick Start

1. **Start the WebSocket server** (see [Server Setup](#1-server-setup))
2. **Load the extension in Chrome** (see [Extension Setup](#2-extension-setup-in-chrome))
3. **Set the server URL in the extension** (see [Connecting Extension to Server](#3-connecting-extension-to-server))
4. **Join a Meet and record** (see [Usage](#4-usage))

---

## 1. Server Setup

The included `test-server/` is a Node.js WebSocket server that receives recording chunks (WebM), participant events, and transcript lines, then saves everything to disk.

### Prerequisites

- **Node.js 18+** installed
- **npm** available

### Install and Run

```bash
# Navigate to the server directory
cd test-server

# Install dependencies (ws, dotenv)
npm install

# Start the server (default: ws://localhost:8080)
npm start
# or
npm run dev
```

The server prints its status on start:

```
[GMR Server] WebSocket server listening on 0.0.0.0:8080
[GMR Server] Recordings will be saved to: /path/to/test-server/recordings
[GMR Server] Ready! Waiting for connections...
```

### Configuration

You can configure the server via environment variables or a `.env` file in `test-server/`:

```env
# test-server/.env
PORT=8080
HOST=0.0.0.0
```

| Variable | Default     | Description                          |
|----------|-------------|--------------------------------------|
| `PORT`   | `8080`      | Port the WebSocket server listens on |
| `HOST`   | `0.0.0.0`   | Bind address (`0.0.0.0` = all interfaces) |

### Hosting on a Remote Server

To host the server on a VPS, cloud instance, or any reachable machine:

```bash
# On your server, install Node.js 18+
# Clone or copy the project, then:

cd test-server
npm install

# Create .env for production
echo 'PORT=8080' > .env
echo 'HOST=0.0.0.0' >> .env

# Run with pm2 for persistence
npm install -g pm2
pm2 start server.js --name "gmeet-recorder"
pm2 save
pm2 startup   # Auto-start on boot
```

Ensure port `8080` (or your chosen port) is open in your firewall:

```bash
# Ubuntu/Debian (ufw)
sudo ufw allow 8080

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

For HTTPS (wss://), front the server with a reverse proxy like nginx + Let's Encrypt, or use `wss` termination at your load balancer.

### Output Files

When a recording completes, the server saves files to `test-server/recordings/`:

```
recordings/
├── meeting_abc-defg-hij_1710000000000.webm        # Video/audio recording
├── meeting_abc-defg-hij_participants.json          # Participant join/leave events
├── meeting_abc-defg-hij_participants_final.json    # Final participant log
├── meeting_abc-defg-hij_transcript.json            # Transcript lines
└── meeting_abc-defg-hij_transcript_final.json      # Final transcript
```

---

## 2. Extension Setup in Chrome

### Prerequisites

- **Chrome 110+** (required for Offscreen Documents API)

### Load the Unpacked Extension

1. Open Chrome and navigate to **`chrome://extensions/`**
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the **`extension/`** folder from this project
5. The **Google Meet Recorder** icon appears in your Chrome toolbar

### Verify It Loaded

- Click the extension icon — you should see the popup dashboard showing "Not Recording"
- The default WebSocket URL displayed will be `ws://localhost:8080`

### Reload After Changes

If you modify any extension files while developing:

1. Go to `chrome://extensions/`
2. Find "Google Meet Recorder"
3. Click the **reload icon** on the extension card

---

## 3. Connecting Extension to Server

The extension connects to your WebSocket server via a configurable URL. This is set from the popup UI.

### Local Development (Server on Same Machine)

If both the server and extension are on the same machine, no changes needed — the default is `ws://localhost:8080`.

### Remote Server

1. Click the **Google Meet Recorder** icon in the toolbar
2. Click the **gear icon** (settings) in the popup header
3. Enter your server URL:
   - Local: `ws://localhost:8080`
   - Remote LAN: `ws://192.168.1.100:8080`
   - Public: `ws://your-domain.com:8080` or `wss://your-domain.com`
4. Click **Save & Connect**

The popup's **Connection Status** section shows:
- **Green dot** = Connected
- **Red dot** = Disconnected
- Latency in ms and connection uptime

### Hardcoding the Server URL (Optional)

If you want to skip the settings UI and hardcode the URL, edit `extension/background.js`:

```javascript
// Line ~9: Change the default wsUrl
chrome.storage.local.set({
  wsUrl: 'ws://your-server.com:8080',  // <-- change here
  // ...
});
```

Also update the default in `extension/popup.js` line ~6:

```javascript
wsUrl: 'ws://your-server.com:8080',  // <-- change here
```

---

## 4. Usage

### Starting a Recording

1. **Join a Google Meet** session in Chrome (`meet.google.com/xxx-xxxx-xxx`)
2. Click the **Google Meet Recorder** icon in the toolbar
3. The popup detects your meeting and shows the **Meeting ID**
4. Click **Start Recording**
5. Chrome shows a screen share dialog — **check "Share tab audio"** for audio capture
6. If you forget audio, a warning banner appears at the top of the Meet page

### During Recording

A **floating control pill** appears in the bottom-right of the Meet page with:
- Red recording indicator (pulsing)
- Recording timer
- Active participant count
- Stop button

The **popup dashboard** shows:
- Recording status and elapsed timer
- WebSocket connection health (latency + uptime)
- Live transcript feed (auto-scrolling)
- Participant activity log (join/leave events)

### Pausing and Resuming

- Click **Pause** in the popup to pause recording
- Click **Resume** to continue
- Paused time does not add to the recording

### Stopping a Recording

Any of these will stop the recording:
1. Click **Stop** in the popup dashboard
2. Click the **stop button** in the floating pill on the Meet page
3. Click **"Stop sharing"** in Chrome's native screen share bar

On stop, the extension sends a final metadata message to the server with duration and chunk count. All files are flushed and closed on the server side.

---

## Features

### Screen Recording with Audio

- Records the full Google Meet session via `getDisplayMedia()`
- Captures both video and audio streams
- VP9 video codec at 2.5 Mbps, Opus audio at 128 kbps in a WebM container
- Pause/Resume support

### Audio Warning System

If "Share tab audio" is not checked during screen share:
- A warning banner with glassmorphism styling appears at the top of the Meet page
- Auto-dismisses after 30 seconds or can be manually dismissed

### Participant Tracking

- Monitors the Meet DOM for participant join/leave events using `MutationObserver`
- Captures names with multiple CSS selector fallbacks (Google frequently changes class names)
- Tracks active count and cumulative total joined
- Events stream to the server as JSON in real-time

### Live Transcript Capture

- Reads Google Meet's built-in Live Captions (CC) from the DOM
- Records speaker name, text, and timestamp per line
- Deduplicates lines using a sliding window
- Streams to server and displays in the popup

### WebSocket Streaming

- Binary recording chunks stream every 1 second with a custom binary protocol
- Participant and transcript events stream as JSON
- Automatic reconnection with retry logic
- Heartbeat ping/pong every 10 seconds

---

## WebSocket Protocol

### Connection

After connecting, the extension sends an auth message:

```json
{
  "type": "auth",
  "meetingId": "abc-defg-hij",
  "clientType": "recorder"
}
```

### Binary Message Format (Recording Chunks)

```
[1 byte: type]
[4 bytes: sequence number (uint32 big-endian)]
[8 bytes: timestamp ms (uint64 big-endian)]
[N bytes: WebM chunk data]
```

Type bytes:
- `0x01` = Recording chunk
- `0x04` = Recording end

### JSON Messages

**Participant Event:**

```json
{
  "type": "participant",
  "event": "joined",
  "name": "Alice Smith",
  "timestamp": "2024-01-15T12:34:56.789Z",
  "meetingId": "abc-defg-hij"
}
```

**Transcript Line:**

```json
{
  "type": "transcript",
  "speaker": "Alice Smith",
  "text": "Welcome everyone to the meeting.",
  "timestamp": "2024-01-15T12:34:56.789Z",
  "meetingId": "abc-defg-hij"
}
```

**Recording End:**

```json
{
  "type": "recording_end",
  "meetingId": "abc-defg-hij",
  "duration": 180000,
  "totalChunks": 180,
  "timestamp": "2024-01-15T12:37:36.789Z"
}
```

### Heartbeat

- Extension sends: `{ "type": "ping" }` every 10 seconds
- Server responds: `{ "type": "pong" }`

### Server-to-Client Control

Send this from the server to remotely stop a recording:

```json
{
  "type": "control",
  "action": "stop"
}
```

---

## Project Structure

```
google-meet-recorder/
├── README.md
├── tech-spec.md
├── design-analysis/
│   └── design.md
├── extension/                     # Chrome extension (load this folder)
│   ├── manifest.json             # Manifest V3 config
│   ├── popup.html                # Dashboard UI
│   ├── popup.css                 # Liquid glass design (695 lines)
│   ├── popup.js                  # Popup logic + rendering (558 lines)
│   ├── content.js                # Meet page: participants, transcript, warnings (813 lines)
│   ├── background.js             # Service worker: message routing, state (392 lines)
│   ├── offscreen.html            # Offscreen document host
│   ├── offscreen.js              # Recording: MediaRecorder + WebSocket streaming (524 lines)
│   └── icons/
│       ├── icon16.png
│       ├── icon32.png
│       ├── icon48.png
│       └── icon128.png
└── test-server/                   # WebSocket receiver (optional, for local testing)
    ├── package.json
    └── server.js                  # Server with binary protocol parsing (272 lines)
```

### Architecture

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│  Popup UI   │◄─────►│ Background │◄─────►│ Content    │
│  (popup.js) │       │  Script   │       │  Script     │
└──────────────┘       │(background)│       │ (meet.com) │
                        └─────┬─────┘       └──────────────┘
                              │
                              ▼
                        ┌──────────────┐       ┌──────────────┐
                        │ Offscreen  │──────►│  WebSocket │
                        │ Document   │       │   Server   │
                        │(offscreen) │       └──────────────┘
                        └──────────────┘
```

---

## Extension Details

### Permissions

| Permission       | Purpose                                    |
|------------------|--------------------------------------------|
| `activeTab`      | Access current tab info                    |
| `tabCapture`     | Capture tab audio/video                    |
| `offscreen`      | Create offscreen document for recording    |
| `storage`        | Save extension settings                    |
| `scripting`      | Inject scripts into Meet pages             |

### Content Security Policy

The extension uses `manifest_version: 3` with a module-type service worker. No external CDNs are loaded in the extension code. Google Fonts are imported via `@import` in `popup.css` (requires internet connection for fonts).

### Chrome Version

- **Chrome 110+** required (Offscreen Documents API introduced in Chrome 110)

---

## Troubleshooting

### Extension not detecting meeting

- Ensure you are on `meet.google.com/xxx-xxxx-xxx`
- Refresh the page and try again
- Open the browser console (`F12`) and check for `[GMR Content]` log messages

### No audio in recording

- **Most common issue.** When the screen share dialog appears, check **"Share tab audio"**
- The extension displays a warning banner on the Meet page if no audio track is detected
- The offscreen script monitors audio volume and triggers the warning if audio is silent

### Extension loads but shows errors in console

- Go to `chrome://extensions/`, find the extension, and check the service worker logs
- Click "Service worker" link to open its console

### WebSocket connecting but no data received on server

- Verify the server is running and prints `Client connected`
- Check that you clicked **Start Recording** in the popup
- Ensure Chrome granted screen share permissions
- Check the offscreen document console: go to `chrome://extensions/`, find extension, look for offscreen document devtools

### WebSocket not connecting (red dot in popup)

- Verify server URL starts with `ws://` or `wss://`
- Ensure the server is running on the specified host:port
- For `wss://`, ensure your server has a valid TLS certificate
- Check Chrome's Network tab for connection errors

### Transcript not capturing

- **Live Captions (CC)** must be enabled in Google Meet
- Click the **CC** button in the Meet toolbar
- The extension reads caption elements from Google Meet's DOM

### Participant tracking not working

- Google frequently changes internal CSS class names
- The extension uses 8+ selector fallbacks per target
- If none match, the selectors in `content.js` (the `SELECTORS` object, lines 21-41) need updating to match the current Meet DOM

### `offscreen.html` referenced in manifest but not a web-accessible resource issue

- The `web_accessible_resources` entry in `manifest.json` includes `offscreen.html` and `offscreen.js` — this is required for the offscreen document to load its scripts

---

## Building for Distribution

To package the extension for the Chrome Web Store or sideloading:

1. Ensure all files are in the `extension/` folder
2. Go to `chrome://extensions/`
3. Click **Pack extension**
4. Select the `extension/` folder as the extension root
5. Leave private key empty (or select existing key for updates)
6. Chrome generates:
   - `Google Meet Recorder.crx` (installable package)
   - `Google Meet Recorder.pem` (private key, keep secure for updates)

### Notes for Chrome Web Store

- The `host_permissions` allows `https://meet.google.com/*` — this is required and should pass review
- The extension does not access any restricted APIs beyond standard media capture
- No external servers are contacted (the WebSocket URL is user-configured)

---

## License

MIT
