# Google Meet Recorder — Design Document

## Overview

A Chrome extension for recording Google Meet sessions, tracking participants, capturing live transcripts, and streaming all data via WebSocket to a backend server. The extension features a popup dashboard UI styled with a "liquid glass" aesthetic, floating controls overlay during meetings, and real-time status indicators.

**Design Philosophy**: Ethereal data aesthetics meet clinical precision — a control interface that transforms meeting capture into a cinematic experience. The design balances deep atmospheric backgrounds with high-contrast neon data accents, creating an immersive tool that feels both powerful and intuitive.

**Mood**: Precise, atmospheric, authoritative, ethereal.

---

## Design Tokens

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| Black | `#000000` | Page background |
| White | `#FFFFFF` | Primary text |
| Surface | `#0A0A0A` | Card backgrounds |
| Surface Light | `#1A1A1A` | Elevated panels |
| Rose | `#FF6B8A` | Primary accent — recording active, primary buttons |
| Rose Glow | `rgba(255, 107, 138, 0.4)` | Recording glow effects |
| Fuchsia | `#E056C4` | Status badges, secondary accent |
| Purple | `#A855F7` | WebSocket connected state, indicators |
| Gold | `#FBBF24` | Participant tracking highlight |
| Emerald | `#10B981` | Transcript active, success states |
| Blue | `#3B82F6` | Connection status |
| Border | `rgba(255, 255, 255, 0.08)` | Default borders |
| Border Hover | `rgba(255, 255, 255, 0.15)` | Hover borders |
| Border Active | `rgba(255, 107, 138, 0.5)` | Recording active borders |
| Glass BG | `rgba(10, 10, 10, 0.7)` | Glass panel fill |
| Glass Border | `rgba(255, 255, 255, 0.15)` | Glass panel stroke |

### Typography

| Token | Font | Size | Weight | Tracking | Usage |
|-------|------|------|--------|----------|-------|
| H1 | Archivo | 32px | 900 | -2px | Popup title |
| H2 | Archivo | 20px | 700 | -0.5px | Section headers |
| H3 | Archivo | 16px | 700 | 0 | Card titles |
| Label | Archivo | 12px | 600 | 0.5px | Labels (uppercase) |
| Body | Archivo | 14px | 400 | 0 | Descriptions |
| Mono | JetBrains Mono | 13px | 400 | 0 | Data readouts, timestamps |
| Mono Small | JetBrains Mono | 11px | 400 | 0.5px | Status codes, metrics |

### Spacing

| Token | Value |
|-------|-------|
| section-gap | 32px |
| card-gap | 16px |
| card-padding | 20px |
| element-gap | 12px |

### Liquid Glass (Material Effect)

The signature visual material — physical thickness with light transmission:

| Property | Value |
|----------|-------|
| Background | `rgba(255, 255, 255, 0.03)` |
| Background Hover | `rgba(255, 255, 255, 0.06)` |
| Border Top | `1px solid rgba(255, 255, 255, 0.25)` |
| Border Bottom | `1px solid rgba(255, 255, 255, 0.05)` |
| Box Shadow | `0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.15)` |
| Backdrop Filter | `blur(40px) saturate(150%)` |
| Border Radius | 12px |

### Transitions

| Property | Value |
|----------|-------|
| Default | `all 0.2s cubic-bezier(0.4, 0, 0.2, 1)` |
| Transform | `transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)` |

### Border Radius

| Token | Value |
|-------|-------|
| sm | 8px |
| md | 12px |
| lg | 16px |
| full | 9999px |

---

## Dependencies

- `archivo` (Google Fonts) — Display font
- `jetbrains-mono` (Google Fonts) — Monospace data font
- No external UI framework — pure vanilla JavaScript + CSS

---

## Core Architecture

### Chrome Extension Structure

```
google-meet-recorder/
  manifest.json          # Extension manifest v3
  popup.html             # Popup dashboard UI
  popup.css              # Popup styles
  popup.js               # Popup logic
  content.js             # Content script (injected into meet.google.com)
  background.js          # Service worker
  offscreen.html         # Offscreen document (for recording)
  offscreen.js           # Offscreen recording logic
  websocket-client.js    # WebSocket connection manager
  icons/
    icon16.png
    icon32.png
    icon48.png
    icon128.png
```

### Data Flow

1. **Content Script** (`content.js`) — Runs on `meet.google.com`:
   - Extracts meeting ID from URL
   - Monitors participant DOM changes (join/leave events)
   - Captures live transcript from CC panel
   - Injects DOM warning if audio unavailable

2. **Background Script** (`background.js`) — Service worker:
   - Coordinates between popup, content script, and offscreen document
   - Maintains extension state (recording, ws connection)
   - Handles message routing

3. **Offscreen Document** (`offscreen.html` + `offscreen.js`):
   - Handles screen/audio recording via `getDisplayMedia()` + `getUserMedia()`
   - Chunks and streams recording data via WebSocket
   - Runs independently of popup lifecycle

4. **Popup** (`popup.html` + `popup.css` + `popup.js`):
   - Dashboard UI for controlling the extension
   - Displays real-time status (recording, participants, transcript, WS)
   - Settings for WebSocket server URL

5. **WebSocket Client** — Streams:
   - Recording chunks (binary)
   - Participant events (JSON)
   - Transcript lines (JSON)
   - Heartbeat ping/pong

---

## Global Interactions

### Recording States

| State | Visual |
|-------|--------|
| Idle | Default border, gray indicator |
| Recording Active | Rose border glow, pulsing red dot, timer running |
| Paused | Yellow border, paused icon |
| Error | Red border, error message |

### WebSocket Connection States

| State | Visual |
|-------|--------|
| Disconnected | Gray dot, "Disconnected" text |
| Connecting | Pulsing blue dot, "Connecting..." |
| Connected | Solid green dot, "Connected" with latency |
| Error | Red dot, error message |

### Popup Open/Close

- Click extension icon → popup opens as dashboard panel
- Popup maintains state via background script messaging
- All data displayed is live-updated via chrome.runtime messaging

---

## Section: Popup Dashboard

### Layout

Fixed-size popup window (400×600px), scrollable content area.

```
┌─────────────────────────────────────────────┐
│  [Icon] Google Meet Recorder        [⚙️]   │  ← Header (liquid glass)
├─────────────────────────────────────────────┤
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  ● Recording   00:14:32    [Stop]    │  │  ← Status Card
│  └───────────────────────────────────────┘  │
│                                             │
│  Connection Status                          │
│  ┌───────────────────────────────────────┐  │
│  │  🟢 Connected  ws://server:8080      │  │  ← WS Status
│  │  Latency: 23ms  Uptime: 00:32:10     │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Meeting Info                               │
│  ┌───────────────────────────────────────┐  │
│  │  Meeting: abc-defg-hij               │  │  ← Meeting Card
│  │  Participants: 12 active              │  │
│  │  Joined: 23 total                     │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Live Transcript                            │
│  ┌───────────────────────────────────────┐  │
│  │  [12:34:56] Alice: Welcome everyone  │  │  ← Transcript feed
│  │  [12:35:01] Bob: Thanks for joining   │  │     (scrollable)
│  │  [12:35:08] Alice: Let's begin...     │  │
│  │  ...                                  │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Recent Activity                            │
│  ┌───────────────────────────────────────┐  │
│  │  12:34:50  ⬆️  Carol joined           │  │  ← Activity log
│  │  12:34:45  ⬇️  Dave left              │  │     (scrollable)
│  │  12:34:30  ⬆️  Eve joined             │  │
│  │  ...                                  │  │
│  └───────────────────────────────────────┘  │
│                                             │
└─────────────────────────────────────────────┘
```

### Header

- **Height**: 56px, liquid glass material, pinned at top
- **Background**: Liquid glass + Backdrop blur(40px)
- **Border**: Bottom 1px `rgba(255,255,255,0.08)`
- **Left**: Extension icon (16px) + "Google Meet Recorder" (Label style, uppercase)
- **Right**: Settings gear icon button (20px, hover rotates 90deg)

### Recording Status Card

Full-width liquid glass card with active recording indicator.

**Idle State**:
- Border: 1px `rgba(255,255,255,0.08)`
- Content: Gray dot + "Not Recording" + [Start Recording] button
- Button: Rose background, white text, 36px height, Border-radius full

**Recording State**:
- Border: 1px Rose Glow + `box-shadow: 0 0 20px rgba(255,107,138,0.3)`
- Recording dot: 12px, Rose, pulsing animation (`@keyframes pulse`: scale 1→1.4, opacity 1→0.4, 1.5s infinite)
- Timer: JetBrains Mono, 24px, weight 700, tracking -0.5px — `00:14:32` format
- [Pause] and [Stop] buttons side by side

**Paused State**:
- Border: 1px Gold
- Timer paused, yellow text
- [Resume] and [Stop] buttons

**Button hover**: All buttons use `transition: all 0.2s ease` with slight scale(1.02) on hover.

### WebSocket Status Card

- Background: Surface (`#0A0A0A`)
- Border: 1px `rgba(255,255,255,0.08)`, Border-radius: md (12px)
- Padding: card-padding (20px)
- **Row 1**: Status dot + state text
  - Connected: Green dot (#10B981), "Connected"
  - Disconnected: Gray dot, "Disconnected"
  - Connecting: Pulsing Blue dot (#3B82F6), "Connecting..."
  - Error: Red dot (#EF4444), "Error: [message]"
- **Row 2**: Server URL (Mono Small, color #888) — `ws://localhost:8080`
- **Row 3**: Metrics row (flex, space-between)
  - Latency: "23ms" (Green if <50ms, Yellow if <200ms, Red if >200ms)
  - Uptime: "00:32:10"

### Meeting Info Card

- Background: Surface, Border: 1px Border, Border-radius: md
- Padding: card-padding
- **Meeting ID**: "abc-defg-hij" (Mono style) — extracted from URL
- **Active Participants**: Count with live update
- **Total Joined**: Cumulative count
- **Recording Format**: "WebM (VP9 + Opus)" (technical detail)

### Live Transcript Panel

- Background: Surface, Border: 1px Border, Border-radius: md
- **Header**: "Live Transcript" (H3) + pill badge showing line count
- **Content**: Scrollable div, max-height 200px, overflow-y: auto
- **Scrollbars**: Custom thin scrollbar
  - Track: `rgba(255,255,255,0.05)`
  - Thumb: `rgba(255,255,255,0.15)`, Border-radius: 4px
- **Transcript Line**:
  - Timestamp: Mono Small, color #888 — `[12:34:56]`
  - Speaker name: color Fuchsia (#E056C4), weight 600 — "Alice:"
  - Text: Body style, color White — "Welcome everyone to the meeting."
- **New line animation**: Fade in + slide up, 0.3s ease

### Recent Activity Log

- Background: Surface, Border: 1px Border, Border-radius: md
- **Header**: "Recent Activity" (H3) + participant count pill
- **Content**: Scrollable div, max-height 150px
- **Activity Entry**:
  - Icon: ⬆️ (join) Green or ⬇️ (leave) Red
  - Timestamp: Mono Small — "12:34:56"
  - Name: Body style, weight 600 — "Carol"
  - Action: Body style, color #888 — "joined" / "left"
- **Entry animation**: Slide in from left, 0.2s ease

### Settings Panel (Overlay)

Triggered by gear icon in header. Slides in from right over dashboard.

- **Overlay**: Full popup area, Background: rgba(0,0,0,0.9), Backdrop-filter: blur(20px)
- **Panel**: Width 360px, right-aligned, liquid glass material
- **Content**:
  - "Settings" (H2)
  - WebSocket URL input: Full-width text input, liquid glass style
    - Label: "Server URL" (Label style)
    - Value: "ws://localhost:8080"
    - Placeholder: "ws://your-server:port"
    - Border: 1px Border, focus: Border Active
  - [Save & Connect] button: Full-width, Rose bg, white text
  - [Back] button: Text only, hover underline

### Footer

- Height: 36px
- Text: "v1.0.0 • Google Meet Recorder" (Mono Small, color #555)
- Centered

---

## Section: Floating Controls Overlay (In-Meeting)

When recording is active, a minimal floating panel appears on the Google Meet page.

### Position

Bottom-right corner, 20px from edges, z-index: 999999.

### Design

- Compact liquid glass pill shape
- Height: 40px, Border-radius: full
- Background: Liquid glass with stronger blur (blur(60px))
- Border: 1px `rgba(255,255,255,0.15)`
- Box Shadow: `0 4px 20px rgba(0,0,0,0.5)`

### Content

- Recording dot: 8px, Rose, pulsing
- Timer: Mono Small, "00:14:32"
- Participant count: "👥 12"
- [⏹] Stop button: 28px circle, hover: Rose background

### Visibility

- Auto-fades after 3 seconds of inactivity
- Reappears on mouse movement near bottom-right
- Opacity transition: 0.3s ease

---

## Section: DOM Audio Warning (In-Meeting)

When the user starts recording but system audio is not being captured:

### Design

Injected banner at the top of the Google Meet page:

- Full-width, liquid glass material
- Height: 48px
- Background: `rgba(255, 107, 138, 0.15)` with backdrop blur
- Border: Bottom 1px Rose Glow
- z-index: 999999

### Content

- Warning icon: ⚠️ (16px, Rose color)
- Text: "Your meeting audio will not be recorded. Turn on 'Share audio' in the screen share tab." (Body style, White)
- [Dismiss] button: Text only, "×" icon, 24px

### Behavior

- Appears with slide-down animation, 0.3s cubic-bezier(0.4, 0, 0.2, 1)
- Dismiss button removes banner with slide-up animation
- Auto-dismisses when audio is detected

---

## Section: Content Script (content.js)

### Meeting ID Detection

Extract from URL: `meet.google.com/abc-defg-hij` → meeting ID = `abc-defg-hij`.

### Participant Tracking

**Strategy**: Use MutationObserver on Google Meet's participant list DOM.

- Target: `[data-participant-id]` or `[jsname="..."]` containing participant data
- Watch for: Child node additions and removals in the participants panel
- Extract: Participant name from DOM text content
- Timestamp: `new Date().toISOString()` for each event

**Data Format**:
```json
{
  "type": "participant",
  "event": "joined" | "left",
  "name": "Alice Smith",
  "timestamp": "2024-01-15T12:34:56.789Z",
  "meetingId": "abc-defg-hij"
}
```

### Transcript Capture

**Strategy**: Google Meet's live captions appear in a specific DOM container.

- Target: The live captions container (class names may vary)
- Alternative: Use `webkitSpeechRecognition` API as fallback
- Capture: Each caption line with speaker name, text, and timestamp

**Data Format**:
```json
{
  "type": "transcript",
  "speaker": "Alice Smith",
  "text": "Welcome everyone to the meeting.",
  "timestamp": "2024-01-15T12:34:56.789Z",
  "meetingId": "abc-defg-hij"
}
```

### Audio Warning Detection

- Monitor the MediaStream tracks from the recorder
- If audio track is silent or missing, inject the DOM warning banner
- Check every 2 seconds during recording

---

## Section: Offscreen Document (offscreen.js)

### Screen Recording

Uses Chrome's `chrome.tabCapture` or `getDisplayMedia()` API:

```javascript
// Request display media with audio
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: { displaySurface: 'browser' },
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
});
```

### MediaRecorder Configuration

```javascript
const recorder = new MediaRecorder(stream, {
  mimeType: 'video/webm;codecs=vp9,opus',
  videoBitsPerSecond: 2500000,
  audioBitsPerSecond: 128000
});
```

### Chunk Streaming

- `ondataavailable` fires every 1000ms with a Blob chunk
- Each chunk is sent via WebSocket as binary message
- Sequence number added for server-side reassembly

**Binary Protocol**:
```
[1 byte: message type = 0x01]
[4 bytes: chunk sequence number (uint32be)]
[8 bytes: timestamp (uint64be ms since epoch)]
[N bytes: webm chunk data]
```

---

## Section: WebSocket Protocol

### Connection

- URL: Configurable via popup settings (default: `ws://localhost:8080`)
- Reconnection: Exponential backoff, max 30s delay
- Heartbeat: Ping every 10s, expect pong within 5s

### Message Types

| Type | Direction | Format |
|------|-----------|--------|
| AUTH | Client→Server | `{ "type": "auth", "meetingId": "abc...", "clientType": "recorder" }` |
| HEARTBEAT | Both | `{ "type": "ping" }` / `{ "type": "pong" }` |
| RECORDING_CHUNK | Client→Server | Binary (see above) |
| PARTICIPANT | Client→Server | JSON object |
| TRANSCRIPT | Client→Server | JSON object |
| CONTROL | Server→Client | `{ "type": "control", "action": "stop" }` |
| STATUS | Server→Client | `{ "type": "status", "recording": true, ... }` |

### Connection Flow

1. Client connects to WebSocket server
2. Client sends AUTH message with meetingId
3. Server confirms with STATUS message
4. Client begins streaming data
5. Heartbeat ping/pong every 10 seconds

---

## Global Interactions & Animations

### Recording Start Sequence

1. User clicks [Start Recording] in popup
2. Popup sends message to background script
3. Background creates offscreen document
4. Offscreen requests display media permissions
5. MediaRecorder starts, chunks begin flowing
6. Recording status card transitions to active state (Rose glow, pulsing dot)
7. Floating controls overlay appears on Meet page
8. Timer begins incrementing every second

### Recording Stop Sequence

1. User clicks [Stop] button
2. MediaRecorder stops, final chunk sent
3. Recording stream closed
4. Status card transitions to idle state
5. Floating controls removed from Meet page
6. Final summary sent via WebSocket:
   ```json
   { "type": "recording_end", "duration": 865000, "totalChunks": 432 }
   ```

### Participant Join Animation (Popup)

New activity entry slides in from left:
- Initial: `opacity: 0, transform: translateX(-20px)`
- Final: `opacity: 1, transform: translateX(0)`
- Duration: 0.2s, ease

### Transcript New Line Animation

New transcript line fades in:
- Initial: `opacity: 0, transform: translateY(8px)`
- Final: `opacity: 1, transform: translateY(0)`
- Duration: 0.3s, ease

### WebSocket Reconnection

1. Connection drops → status shows "Disconnected" (gray)
2. Auto-reconnect begins → "Connecting..." (pulsing blue)
3. On success → "Connected" (green) + latency display
4. On failure → retry with exponential backoff

### Liquid Glass Hover

All liquid glass cards on hover:
- Background shifts to `rgba(255, 255, 255, 0.06)`
- Border brightens to `rgba(255, 255, 255, 0.2)`
- Transition: 0.2s ease

### Scrollbar Styling

All scrollable panels use custom thin scrollbar:
- Width: 4px
- Track: transparent
- Thumb: `rgba(255, 255, 255, 0.15)`
- Hover thumb: `rgba(255, 255, 255, 0.25)`

---

## Assets

### Icons

| Asset | Description |
|-------|-------------|
| icon16.png | 16×16 extension icon |
| icon32.png | 32×32 extension icon |
| icon48.png | 48×48 extension icon |
| icon128.png | 128×128 extension icon |

Icon design: Minimalist microphone silhouette with recording dot, white on transparent.

### SVG Icons (Inline)

**Recording Dot**: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#FF6B8A"/></svg>`

**Stop Button**: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>`

**Settings Gear**: `<svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1.323l.954-.583a1 1 0 011.36.386l.5 1a1 1 0 01-.386 1.36L13 7.477v1.046l1.018.623a1 1 0 01.386 1.36l-.5 1a1 1 0 01-1.36.386L11 11.677V13a1 1 0 01-2 0v-1.323l-.954.583a1 1 0 01-1.36-.386l-.5-1a1 1 0 01.386-1.36L7 8.523V7.477l-1.018-.623a1 1 0 01-.386-1.36l.5-1a1 1 0 011.36-.386L9 4.323V3a1 1 0 011-1z" clip-rule="evenodd"/></svg>`

---

## Notes

### Chrome Extension Permissions

Required permissions in `manifest.json`:
- `activeTab` — For accessing current tab
- `tabCapture` — For capturing tab audio/video
- `offscreen` — For offscreen document (Chrome 110+)
- `storage` — For saving settings
- `host_permissions`: `https://meet.google.com/*`

### Google Meet DOM Selectors

Participant tracking relies on these selectors (may need updating as Meet changes):
- Participant list container: `[jscontroller="..."] [role="list"]`
- Participant names: `[data-self-name]` or `[jsname="..."] .ZjFb7d`
- Live captions container: `.a4cQT` or `.V6Yesc` or `[jsname="tgaKEf"]`

### Audio Capture Behavior

- `getDisplayMedia()` with `audio: true` captures system audio when user checks "Share audio" in the dialog
- If user unchecks "Share audio", the audio track will be empty/silent
- Content script monitors audio track volume to detect this and show warning

### WebSocket Server Expectations

The server should:
- Accept WebSocket connections on configurable port
- Handle AUTH message and respond with STATUS
- Process binary RECORDING_CHUNK messages
- Process JSON PARTICIPANT and TRANSCRIPT messages
- Send ping/pong heartbeat responses
- Reassemble WebM chunks into complete recording file
