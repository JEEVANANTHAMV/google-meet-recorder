# Tech Spec — Google Meet Recorder Extension

## Dependencies

- **No npm packages** — Pure vanilla JavaScript + CSS, Chrome Extension APIs only
- **Fonts**: Archivo + JetBrains Mono (loaded via Google Fonts in popup HTML)

## Chrome Extension Architecture

| File | Type | Purpose |
|------|------|---------|
| `manifest.json` | Manifest | Extension config, permissions, host matches |
| `popup.html` | HTML | Dashboard UI (400×600) |
| `popup.css` | CSS | All popup styles, liquid glass, animations |
| `popup.js` | JS | Popup logic, chrome.runtime messaging |
| `content.js` | Content Script | Runs on meet.google.com — participant tracking, transcript capture, DOM warning injection |
| `background.js` | Service Worker | State management, message routing, offscreen lifecycle |
| `offscreen.html` | Offscreen Doc | Host for offscreen recording |
| `offscreen.js` | Offscreen JS | getDisplayMedia() recording, MediaRecorder, chunk streaming |
| `websocket-client.js` | Shared JS | WebSocket connection manager (imported by popup + offscreen) |

## State Management

All persistent state stored in `chrome.storage.local`. No external state library.

| Key | Value | Access |
|-----|-------|--------|
| `wsUrl` | `"ws://localhost:8080"` | popup (rw), offscreen (r) |
| `isRecording` | `boolean` | popup (rw), background (rw), offscreen (r) |
| `meetingId` | `"abc-defg-hij"` | content (rw), offscreen (r) |
| `recordingStartTime` | `timestamp` | popup (r), offscreen (w) |
| `totalParticipants` | `number` | popup (r), content (w) |
| `activeParticipants` | `number` | popup (r), content (w) |

## Component Inventory

### Custom Components (all hand-built, no framework)

| Component | Location | Description |
|-----------|----------|-------------|
| LiquidGlassCard | CSS class `.glass-card` | Reusable glassmorphism panel with blur, border, shadow |
| RecordingStatusCard | popup.js | State machine (idle/recording/paused/error) with timer |
| WebSocketStatusCard | popup.js | Connection state indicator with latency + uptime |
| TranscriptPanel | popup.js | Scrollable live transcript feed with auto-scroll |
| ActivityLog | popup.js | Scrollable participant join/leave feed |
| FloatingControls | content.js | Injected floating pill on Meet page |
| AudioWarningBanner | content.js | Injected top banner for audio missing warning |
| SettingsOverlay | popup.js | Slide-in settings panel |

### Chrome APIs Used

| API | Purpose |
|-----|---------|
| `chrome.runtime.sendMessage` | Cross-component communication |
| `chrome.storage.local.get/set` | Persistent state |
| `chrome.tabCapture.capture` | Offscreen tab capture (alternative to getDisplayMedia) |
| `chrome.offscreen.createDocument` | Offscreen document lifecycle |
| `chrome.tabs.query` | Get active Meet tab |

## WebSocket Binary Protocol

**Message type byte:**
- `0x01` = Recording chunk
- `0x02` = Participant event
- `0x03` = Transcript line
- `0x04` = Recording end
- `0x05` = Auth
- `0xFF` = Heartbeat ping/pong

## CSS Architecture

- Single `popup.css` file — no CSS-in-JS, no preprocessors
- CSS variables for all design tokens
- `@keyframes` for pulse, slide-in, fade animations
- `::-webkit-scrollbar` for custom thin scrollbars
- All z-index values: popup (1), settings overlay (10), content script injections (999999)

## Data Flow

```
content.js (Meet page)
  ├─→ participant mutations → chrome.runtime.sendMessage
  ├─→ transcript lines → chrome.runtime.sendMessage
  └─→ audio warning DOM injection

background.js (service worker)
  ├─← messages from content → store state
  ├─← messages from popup → route commands
  └─→ manage offscreen document lifecycle

offscreen.js (offscreen doc)
  ├─← start/stop commands from background
  ├─→ MediaRecorder chunks → WebSocket (binary)
  └─→ status updates → background → popup

popup.js (dashboard)
  ├─← state updates from background
  ├─→ user commands → background
  └─→ render UI updates

WebSocket Server
  ├─← binary chunks (WebM)
  ├─← JSON events (participants, transcripts)
  └─→ control commands (optional)
```
