// offscreen.js - Runs in offscreen document
// Handles getDisplayMedia(), MediaRecorder, and WebSocket streaming

let mediaRecorder = null;
let ws = null;
let meetingId = null;
let authToken = null;
let userEmail = null;
let accessKey = null;
let recordingStartTime = null;
let chunkSequence = 0;
let stoppingIntentionally = false; // true when stop is user/meeting-initiated (not "Stop sharing")
let reconnectTimer = null;
let heartbeatTimer = null;
let pingTime = 0;
let isPaused = false;
let lastRecordingDuration = 0; // captured at Stop; recordingStartTime is cleared before onstop fires
let stream = null;          // the stream handed to MediaRecorder (tab video + mixed audio)
let captureStream = null;   // raw tab/display capture stream
let micStream = null;       // local microphone (best-effort, for the local speaker's voice)
let playbackContext = null; // AudioContext that mixes audio + replays meeting audio to the user
let currentSessionId = null; // Backend active session ID for reconnection

// Message handler from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[GMR Offscreen] Received:', message.type);
  
  (async () => {
    try {
      switch (message.type) {
        case 'START_RECORDING':
          await startRecording(message.wsUrl, message.meetingId, message.authToken, message.streamId, message.captureMic, message.email, message.accessKey);
          sendResponse({ success: true });
          break;
        case 'STOP_RECORDING':
          await stopRecording();
          sendResponse({ success: true });
          break;
        case 'PAUSE_RECORDING':
          pauseRecording();
          sendResponse({ success: true });
          break;
        case 'RESUME_RECORDING':
          resumeRecording();
          sendResponse({ success: true });
          break;
        case 'MIC_MUTE_STATE':
          setMicMuted(message.muted);
          sendResponse({ success: true });
          break;
        case 'SEND_PARTICIPANT':
          sendJSONMessage({
            type: 'participant',
            event: message.event,
            name: message.name,
            participantId: message.participantId || null,
            activeCount: message.activeCount,
            totalCount: message.totalCount,
            timestamp: message.timestamp,
            meetingId: meetingId
          });
          sendResponse({ success: true });
          break;
        case 'SEND_TRANSCRIPT':
          sendJSONMessage({
            type: 'transcript',
            speaker: message.speaker,
            text: message.text,
            timestamp: message.timestamp,
            // Carries the caption-growth supersede flag through to the server, which replaces the
            // speaker's previous line instead of appending a longer duplicate. Dropping it here
            // silently disabled server-side dedup even though the server implements it.
            replace: !!message.replace,
            // Set when the local user's caption label resolved from "You" to their real name
            // mid-utterance; lets the server supersede the line stored under the old label.
            prevSpeaker: message.prevSpeaker || null,
            meetingId: meetingId
          });
          sendResponse({ success: true });
          break;
        default:
          sendResponse({ error: 'Unknown command' });
      }
    } catch (err) {
      console.error('[GMR Offscreen] Error:', err);
      sendResponse({ error: err.message });
    }
  })();
  
  return true;
});

// Start recording. Prefers chrome.tabCapture (reliable tab audio = all participants); falls
// back to getDisplayMedia if no stream id was provided.
async function startRecording(serverUrl, mId, token, streamId, captureMic, email, key) {
  wsUrls = buildWsUrls(serverUrl);
  wsUrlIndex = 0;
  meetingId = mId;
  authToken = token || null;
  userEmail = email || null;
  accessKey = key || null;
  stoppingIntentionally = false; // fresh recording: any capture-end is now an interruption

  // Fresh recording: forget any previous session's connection state (this document can be reused).
  if (savedWaitTimer) { clearTimeout(savedWaitTimer); savedWaitTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  currentSessionId = null;
  pendingEnd = null;
  endQueued = false;
  reconnectAttempts = 0;
  chunkPrep = Promise.resolve();
  clearOutbox();

  console.log('[GMR Offscreen] Starting recording for meeting:', meetingId, '| tabCapture:', !!streamId, '| mic:', !!captureMic);

  try {
    // 1) Acquire the capture stream (tab capture preferred). This happens BEFORE connecting: a
    //    tabCapture stream id expires a few seconds after it is issued, and connecting can take
    //    longer (e.g. the primary URL times out and we fall back).
    if (streamId) {
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080,
            minFrameRate: 15,
            maxFrameRate: 30
          }
        }
      });
      console.log('[GMR Offscreen] Tab capture acquired. Video tracks:', captureStream.getVideoTracks().length);
    } else {
      // Fallback: screen/window/tab share via getDisplayMedia.
      // NOTE: systemAudio:'include' is only supported on Windows and ChromeOS. On macOS,
      // Chrome does NOT capture system/tab audio automatically — the user must tick the
      // "Share tab audio" checkbox inside Chrome's own share picker dialog.
      // We always include the audio constraint so the checkbox appears; the user must check it.
      captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 2 },
        systemAudio: 'include'
      });
      const audioTracks = captureStream.getAudioTracks();
      console.log('[GMR Offscreen] Display media acquired (fallback). Audio tracks:', audioTracks.length);
      if (audioTracks.length === 0) {
        // On macOS, Chrome does not capture tab/system audio unless the user explicitly
        // ticks "Share tab audio" in the share picker. Notify the background so the content
        // script can show the audio warning banner with clear instructions.
        console.warn('[GMR Offscreen] No audio in display capture — user did not enable "Share tab audio" in the picker, or this is macOS without system audio support.');
        chrome.runtime.sendMessage({ type: 'RECORDING_STATUS', status: 'recording', audioMissing: true });
      }
    }

    console.log('[GMR Offscreen] Capture tracks:', captureStream.getTracks().map(t => ({ kind: t.kind, label: t.label })));

    // 2) Optionally also capture the local microphone so the LOCAL speaker's voice is recorded
    //    (tab audio only contains the *remote* participants — Meet never echoes your own mic).
    //    Requires extension mic permission, granted via the popup's "Enable my mic" button; the
    //    prompt cannot appear in an offscreen document.
    micStream = null;
    if (captureMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        console.log('[GMR Offscreen] Microphone acquired (local voice will be mixed in)');
      } catch (micErr) {
        console.warn('[GMR Offscreen] Mic enabled but unavailable, recording tab audio only:', micErr.message);
        if (micErr.name === 'NotAllowedError' || micErr.name === 'PermissionDeniedError' || micErr.message.includes('Permission')) {
          chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_TAB' });
        }
      }
    }

    // 3) Build the recording stream: tab video + audio (tab audio = all participants, mixed with
    //    mic if available), and replay meeting audio so tab capture doesn't silence their speakers.
    stream = await buildRecordingStream(captureStream, micStream, !!streamId);

    const tabAudioTracks = captureStream ? captureStream.getAudioTracks() : [];
    const isTabAudioMissing = tabAudioTracks.length === 0;

    if (isTabAudioMissing) {
      console.warn('[GMR Offscreen] No tab/system audio track in capture stream!');
      chrome.runtime.sendMessage({ type: 'RECORDING_STATUS', status: 'recording', audioMissing: true });
    }

    const audioTracks = stream.getAudioTracks();
    console.log('[GMR Offscreen] Stream audio tracks count:', audioTracks.length);

    // Handle capture end. If the user clicks Chrome's native "Stop sharing" button (screen/tab
    // share) or the shared surface goes away, the video track ends while we are still recording.
    // handleCaptureInterrupted() keeps the recording alive on whatever tracks remain rather than
    // tearing the session down. A deliberate stop (meeting end / Stop button) sets
    // `stoppingIntentionally` first, so that path stops cleanly instead.
    attachCaptureEndHandler();

    // 4) Connect (falling back to the legacy URL if the primary is unreachable) and wait for the
    //    server to ACCEPT the session before recording. Starting in parallel meant a refusal (e.g.
    //    access key required) arrived mid-start and left a "recording" with nowhere to go.
    try {
      const sessionReady = waitForSession(SESSION_CONFIRM_TIMEOUT_MS);
      try {
        await connectWebSocket();
      } catch (err) {
        if (wsUrls.length < 2) throw err;
        console.warn('[GMR Offscreen] Primary server URL failed (' + err.message + ') — trying fallback');
        wsUrlIndex = 1;
        await connectWebSocket();
      }
      await sessionReady;
    } catch (err) {
      if (startWaiter) startWaiter.reject(err);
      err.sessionFailed = true;
      throw err;
    }

    chunkSequence = 0;
    isPaused = false;
    startMediaRecorder();
    recordingStartTime = Date.now();
    // If the socket dropped in the meantime, chunks are queued; resume the session now.
    if (!ws) scheduleReconnect();
    
    console.log('[GMR Offscreen] MediaRecorder started, state:', mediaRecorder.state);
    
    // Notify background
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATUS',
      status: 'recording',
      duration: 0
    });
    
    // Start duration reporting
    startDurationReporting();
    
  } catch (err) {
    console.error('[GMR Offscreen] Failed to start recording:', err);
    releaseCapture();
    abandonSession((err.sessionFailed ? 'server session failed: ' : 'capture failed: ') + err.message);
    // A refusal was already reported as AUTH_FAILED (key prompt); don't add an error toast on top.
    if (!err.sessionFailed || !startRefused) {
      chrome.runtime.sendMessage({
        type: 'RECORDING_ERROR',
        error: 'Failed to start recording: ' + err.message
      });
    }
    startRefused = false;
    throw err;
  }
}

// Create and start a MediaRecorder on the current stream. Also used to restart recording into a new
// server session. Callbacks of a replaced recorder are ignored via recorderGeneration.
function startMediaRecorder() {
  const gen = ++recorderGeneration;
  const mimeType = getSupportedMimeType();
  console.log('[GMR Offscreen] Using MIME type:', mimeType);

  const recorder = new MediaRecorder(stream, {
    mimeType: mimeType,
    videoBitsPerSecond: 2500000,
    audioBitsPerSecond: 128000
  });

  recorder.ondataavailable = (event) => {
    if (gen !== recorderGeneration) return;
    if (event.data && event.data.size > 0) {
      handleChunk(event.data, gen);
    }
  };

  recorder.onerror = (event) => {
    if (gen !== recorderGeneration) return;
    console.error('[GMR Offscreen] MediaRecorder error:', event);
    chrome.runtime.sendMessage({
      type: 'RECORDING_ERROR',
      error: 'MediaRecorder error: ' + event.message
    });
  };

  recorder.onstop = () => {
    if (gen !== recorderGeneration) return;
    console.log('[GMR Offscreen] MediaRecorder stopped');
    queueRecordingEnd(lastRecordingDuration);
  };

  mediaRecorder = recorder;
  // Collect chunks every 1 second
  recorder.start(1000);
  if (isPaused) recorder.pause();
}

// Release everything a failed start acquired (capture, mic, audio graph) without the capture-end
// handler treating it as an interruption.
function releaseCapture() {
  const vTrack = captureStream && captureStream.getVideoTracks()[0];
  if (vTrack) vTrack.onended = null;
  [stream, captureStream, micStream].forEach(s => { if (s) s.getTracks().forEach(t => t.stop()); });
  stream = null;
  captureStream = null;
  micStream = null;
  if (playbackContext) {
    try { playbackContext.close(); } catch (e) { /* ignore */ }
    playbackContext = null;
  }
}

// Mix capture audio (all remote participants) + microphone (local voice) into a single track,
// and replay the meeting audio to the user so tab capture doesn't silence their speakers.
async function buildRecordingStream(capture, mic, isTabCapture) {
  const videoTracks = capture.getVideoTracks();
  const tabAudio = capture.getAudioTracks();
  const micAudio = mic ? mic.getAudioTracks() : [];

  console.log('[GMR Offscreen] Audio sources -> tab:', tabAudio.length, 'mic:', micAudio.length, 'isTabCapture:', isTabCapture);

  // No audio at all.
  if (tabAudio.length === 0 && micAudio.length === 0) {
    chrome.runtime.sendMessage({ type: 'RECORDING_STATUS', status: 'recording', audioMissing: true });
    return new MediaStream(videoTracks);
  }

  // Unified WebAudio processing graph:
  // Route tabAudio (and optional micAudio) into a MediaStreamDestination node.
  // The destination stream track is passed to MediaRecorder (guarantees non-silent audio capture).
  // If isTabCapture is true, tabAudio is ALSO routed to playbackContext.destination (so user keeps hearing meeting).
  try {
    playbackContext = new AudioContext();
    await playbackContext.resume();

    const dest = playbackContext.createMediaStreamDestination();

    // Audio booster (+12dB GainNode) + DynamicsCompressor to make recorded audio loud & clear
    const gainNode = playbackContext.createGain();
    gainNode.gain.value = 4.0; // +12dB boost

    const compressor = playbackContext.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-24, playbackContext.currentTime);
    compressor.knee.setValueAtTime(30, playbackContext.currentTime);
    compressor.ratio.setValueAtTime(12, playbackContext.currentTime);
    compressor.attack.setValueAtTime(0.003, playbackContext.currentTime);
    compressor.release.setValueAtTime(0.25, playbackContext.currentTime);

    // Pipeline: sources -> gainNode -> compressor -> dest (MediaRecorder)
    gainNode.connect(compressor);
    compressor.connect(dest);

    // Volume analyzer integrated into graph
    const analyser = playbackContext.createAnalyser();
    analyser.fftSize = 256;
    compressor.connect(analyser);

    if (tabAudio.length > 0) {
      const tabSrc = playbackContext.createMediaStreamSource(new MediaStream(tabAudio));
      tabSrc.connect(gainNode);                      // -> boosted into MediaRecorder
      if (isTabCapture) {
        tabSrc.connect(playbackContext.destination); // -> user keeps hearing meeting
      }
    }

    if (micAudio.length > 0) {
      const micSrc = playbackContext.createMediaStreamSource(new MediaStream(micAudio));
      micSrc.connect(gainNode);                      // -> boosted into MediaRecorder
    }

    const recordedAudioTracks = dest.stream.getAudioTracks();
    console.log('[GMR Offscreen] WebAudio graph initialized. Recorded audio tracks:', recordedAudioTracks.length);

    return new MediaStream([...videoTracks, ...recordedAudioTracks]);
  } catch (err) {
    console.warn('[GMR Offscreen] WebAudio graph creation failed, falling back to raw tracks:', err.message);
    return new MediaStream([...videoTracks, ...tabAudio, ...micAudio]);
  }
}

// The shared surface went away — "Stop sharing", window closed, tab gone.
//
// This must NOT tear down the recording. It used to call stopRecording(), which finalised the session
// so anything recorded afterwards became a separate file; the meeting itself was never affected, but
// the recording was needlessly lost. Transcript and participant capture are DOM-based (content script)
// and keep working regardless, and any still-live track can still be recorded — notably the mixed mic
// audio, which comes from an AudioContext and does NOT end with the screen capture.
//
// Note we deliberately leave the dead video track IN the stream. Removing it would mutate the recorded
// MediaStream's track set, which fires InvalidModificationError and kills MediaRecorder outright.
function handleCaptureInterrupted() {
  const live = stream ? stream.getTracks().filter(t => t.readyState === 'live') : [];

  if (live.length > 0) {
    const kinds = live.map(t => t.kind);
    console.warn('[GMR Offscreen] Capture ended — recording CONTINUES on:', kinds.join(' + '));
    chrome.runtime.sendMessage({ type: 'CAPTURE_DEGRADED', meetingId, liveKinds: kinds });
    return;
  }

  // Nothing recordable is left (no mic, so the tab audio track ended with the capture). MediaRecorder
  // will go inactive on its own; finalise cleanly rather than leaving a dangling session.
  console.warn('[GMR Offscreen] Capture ended with no live tracks — finalizing recording');
  chrome.runtime.sendMessage({ type: 'CAPTURE_INTERRUPTED', meetingId });
  stopRecording();
}

// (Re)bind the end-of-capture handler to the current video track. Chrome ends this track when the
// shared surface goes away or the user clicks "Stop sharing".
function attachCaptureEndHandler() {
  const vTrack = captureStream && captureStream.getVideoTracks()[0];
  if (!vTrack) return;
  vTrack.onended = () => {
    console.log('[GMR Offscreen] Capture ended (track onended)');
    if (stoppingIntentionally) {
      stopRecording();
    } else {
      handleCaptureInterrupted();
    }
  };
}

// Stop recording
async function stopRecording() {
  console.log('[GMR Offscreen] Stopping recording...');

  stoppingIntentionally = true; // any track-end from here on is part of an intentional stop
  stopDurationReporting();
  lastRecordingDuration = recordingStartTime ? Date.now() - recordingStartTime : 0;

  const recorderWasActive = !!mediaRecorder && mediaRecorder.state !== 'inactive';
  if (recorderWasActive) {
    mediaRecorder.stop(); // onstop -> queueRecordingEnd(): queued chunks + end marker are still delivered
  }

  // Stop all tracks across every stream we opened.
  [stream, captureStream, micStream].forEach(s => {
    if (s) s.getTracks().forEach(track => track.stop());
  });
  stream = null;
  captureStream = null;
  micStream = null;

  // Tear down the audio mixing/playback graph.
  if (playbackContext) {
    try { playbackContext.close(); } catch (e) { /* ignore */ }
    playbackContext = null;
  }

  // Do NOT close the WebSocket or clear the outbox here: queued chunks and the end marker are still
  // delivered (reconnecting with currentSessionId if needed); the socket closes on recording_saved.

  recordingStartTime = null;
  if (!recorderWasActive) {
    // The recorder had already stopped by itself (every captured track ended), so no onstop is coming.
    if (currentSessionId) queueRecordingEnd(lastRecordingDuration);
    else goIdle('stopped with nothing to deliver');
  }

  chrome.runtime.sendMessage({
    type: 'RECORDING_STATUS',
    status: 'stopped',
    duration: 0
  });
}

// Pause recording
function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    isPaused = true;
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATUS',
      status: 'paused'
    });
  }
}

// Resume recording
function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    isPaused = false;
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATUS',
      status: 'recording'
    });
  }
}

// Follow Google Meet's mic mute state for the LOCAL microphone only (privacy). Toggling the mic
// track's `enabled` makes it emit silence into the recorded mix while muted, without tearing down
// the stream — so unmuting resumes cleanly. The meeting (tab) audio is never touched, so other
// participants are always recorded. No-op when mic capture wasn't enabled (no micStream).
function setMicMuted(muted) {
  if (!micStream) return;
  const tracks = micStream.getAudioTracks();
  if (!tracks.length) return;
  const enabled = !muted;
  let changed = false;
  for (const t of tracks) {
    if (t.enabled !== enabled) { t.enabled = enabled; changed = true; }
  }
  if (changed) {
    console.log(`[GMR Offscreen] Local mic ${muted ? 'MUTED (not recorded)' : 'UNMUTED (recording)'} — following Meet`);
    chrome.runtime.sendMessage({ type: 'RECORDING_STATUS', status: 'recording', micMuted: !!muted });
  }
}

// Duration reporting interval
let durationInterval = null;
function startDurationReporting() {
  durationInterval = setInterval(() => {
    if (recordingStartTime && !isPaused) {
      const duration = Date.now() - recordingStartTime;
      chrome.runtime.sendMessage({
        type: 'RECORDING_UPDATE',
        status: 'recording',
        duration: duration
      });
    }
  }, 1000);
}

function stopDurationReporting() {
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
}

// ==================== SERVER CONNECTION ====================
//
// Everything bound for the server — video chunks and JSON events alike — goes through one ordered
// outbox that is only drained while the socket is open AND the server has confirmed our session.
// That gives four guarantees the old code lacked:
//   - A socket is identified by object, and handlers of any socket that is no longer `ws` do nothing.
//     Previously a replaced socket's onclose still scheduled a reconnect, which closed the NEW healthy
//     socket, whose onclose scheduled another… an endless close/reopen loop every 5s ("reconnecting…"
//     flicker on a perfectly good network).
//   - A connection that stops answering is detected within PONG_TIMEOUT_MS instead of whenever the OS
//     gives up on the TCP socket (minutes after a Wi-Fi blip or sleep).
//   - Nothing is silently dropped: chunks queue while disconnected (bounded by bytes, enough to outlast
//     the server's resume window), and after a resume the server reports the last chunk it received so
//     anything lost in flight is resent.
//   - If the server could not resume our session, the recorder restarts so the new file begins with a
//     WebM header (a file that starts mid-stream is unplayable).

// Fallback when the configured server URL is unreachable (e.g. the TLS endpoint isn't live yet).
const LEGACY_WS_URL = 'ws://18.204.127.179:8001';
// ~16 min of video at 2.5 Mbps — longer than the server's 10-minute resume window.
const MAX_OUTBOX_BYTES = 300 * 1024 * 1024;
const MAX_OUTBOX_JSON = 5000;
// A single chunk this large is never sent: the server would reject it (payload limit) and, since
// unacknowledged chunks are resent after reconnecting, it would be rejected again forever.
const MAX_CHUNK_BYTES = 100 * 1024 * 1024;
// startRecording waits this long for the server to accept the session before capturing anything.
const SESSION_CONFIRM_TIMEOUT_MS = 25000;
// Chunks kept after sending so they can be resent if the socket dies before the server stores them.
// Must outlast dead-link detection (PONG_TIMEOUT_MS + HEARTBEAT_MS + OS buffering): ~90 s of video.
const RESEND_HISTORY = 90;
// Flow control: hand the socket at most this much unsent data at a time. Dumping a whole backlog
// (up to MAX_OUTBOX_BYTES) at once would queue heartbeat pings behind it for minutes on a slow uplink.
const MAX_WS_BUFFERED = 2 * 1024 * 1024;
const PUMP_RETRY_MS = 200;
const HEARTBEAT_MS = 10000;
const PONG_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000;
const MAX_RECONNECT_DELAY_MS = 15000;
// After Stop, keep trying to deliver queued chunks + the end marker for this long.
const END_DELIVERY_DEADLINE_MS = 15 * 60 * 1000;
// After delivering the end marker, wait this long for recording_saved before going idle.
const SAVED_WAIT_MS = 5 * 60 * 1000;
// Close codes after which reconnecting is pointless: 4000 replaced by a newer connection of ours,
// 4001 bad token, 4003 access key required.
const NO_RECONNECT_CODES = new Set([4000, 4001, 4003]);

let wsUrls = [];
let wsUrlIndex = 0;
let wsAuthed = false;          // server confirmed our session on the current socket
let lastServerMsgAt = 0;
let reconnectAttempts = 0;
let lastAttemptOpened = true;
let outbox = [];               // { kind: 'chunk', seq, buf } | { kind: 'json', text }
let outboxBytes = 0;
let outboxJson = 0;
let droppedChunks = 0;
let sentHistory = [];          // last RESEND_HISTORY chunk items sent on the wire
let chunkPrep = Promise.resolve(); // keeps blob -> ArrayBuffer conversion in recording order
let recorderGeneration = 0;    // bumps when the MediaRecorder is replaced; stale callbacks ignore themselves
let pendingEnd = null;         // { totalChunks, duration, deadline } after Stop, until delivered
let endQueued = false;         // the end marker for the current recording has been queued
let savedWaitTimer = null;
let startWaiter = null;        // { resolve, reject } while startRecording awaits the server's verdict
let startRefused = false;       // the pending start was refused by the server (already reported as AUTH_FAILED)
let pumpTimer = null;
let sockBytesQueued = 0;       // bytes handed to the current socket
let lastDrained = 0;           // bytes the current socket had actually pushed out at the last heartbeat
let pingMark = 0;              // sockBytesQueued right after our last ping: it has left once drained >= pingMark

function buildWsUrls(configured) {
  const primary = (typeof configured === 'string' && /^wss?:\/\//.test(configured)) ? configured : LEGACY_WS_URL;
  return primary === LEGACY_WS_URL ? [primary] : [primary, LEGACY_WS_URL];
}

function reportWsStatus(connected, extra = {}) {
  chrome.runtime.sendMessage({ type: 'WS_STATUS', connected, latency: 0, ...extra });
}

// Keep the socket (re)connecting while recording, or while a stopped recording still has data to deliver.
function shouldStayConnected() {
  if (pendingEnd) return Date.now() < pendingEnd.deadline;
  return !!recordingStartTime && !stoppingIntentionally;
}

// Forget the current socket: detach its handlers first so its late events can't touch our state.
function dropSocket() {
  const old = ws;
  ws = null;
  wsAuthed = false;
  stopHeartbeat();
  if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  if (!old) return;
  old.onopen = old.onmessage = old.onerror = old.onclose = null;
  try { old.close(); } catch (_) { /* ignore */ }
}

// Resolves when the server confirms our session, rejects if it refuses or doesn't answer in time.
function waitForSession(timeoutMs) {
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      startWaiter = null;
      reject(new Error('The recording server did not respond'));
    }, timeoutMs);
    startWaiter = {
      resolve: () => { clearTimeout(timer); startWaiter = null; resolve(); },
      reject: (err) => { clearTimeout(timer); startWaiter = null; reject(err); }
    };
  });
  p.catch(() => { /* handled by the awaiting caller; avoid unhandled-rejection noise */ });
  return p;
}

// Capture failed after the server had already opened a session: close it now rather than leaving it
// open (and suppressing the missed-recording alert) until the server's resume window expires.
function abandonSession(reason) {
  if (canSend()) {
    wsSend(JSON.stringify({ type: 'recording_end', meetingId: meetingId, duration: 0, totalChunks: 0, timestamp: new Date().toISOString() }));
  }
  goIdle(reason);
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    dropSocket();
    const url = wsUrls[wsUrlIndex] || LEGACY_WS_URL;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      lastAttemptOpened = false;
      reject(err);
      scheduleReconnect();
      return;
    }
    ws = sock;
    let opened = false;
    lastAttemptOpened = false;
    console.log('[GMR Offscreen] Connecting to', url);

    const connectTimer = setTimeout(() => {
      if (opened || sock !== ws) return;
      console.warn('[GMR Offscreen] WebSocket connect timed out:', url);
      dropSocket();
      reject(new Error('WebSocket connect timeout'));
      handleSocketLost(null);
    }, CONNECT_TIMEOUT_MS);

    sock.onopen = () => {
      if (sock !== ws) return;
      opened = true;
      lastAttemptOpened = true;
      clearTimeout(connectTimer);
      lastServerMsgAt = Date.now();
      sockBytesQueued = 0;
      lastDrained = 0;
      pingMark = 0;
      console.log('[GMR Offscreen] WebSocket connected — authenticating', currentSessionId ? `(resume ${currentSessionId})` : '');
      // Sent directly (not via the outbox): nothing else may go out before the server knows our session.
      wsSend(JSON.stringify({
        type: 'auth',
        meetingId: meetingId,
        sessionId: currentSessionId || undefined,
        clientType: 'recorder',
        token: authToken || undefined,
        email: userEmail || undefined,
        accessKey: accessKey || undefined
      }));
      startHeartbeat();
      resolve();
    };

    sock.onmessage = (event) => {
      if (sock !== ws) return;
      lastServerMsgAt = Date.now();
      handleWebSocketMessage(event.data);
    };

    sock.onerror = () => {
      if (sock !== ws) return;
      console.warn('[GMR Offscreen] WebSocket error on', url);
      if (!opened) {
        clearTimeout(connectTimer);
        reject(new Error('WebSocket connection failed'));
      }
    };

    sock.onclose = (event) => {
      if (sock !== ws) return; // a socket we already replaced — ignore
      clearTimeout(connectTimer);
      console.log('[GMR Offscreen] WebSocket closed, code:', event.code, event.reason || '');
      if (!opened) reject(new Error('WebSocket closed before opening'));
      ws = null;
      handleSocketLost(event.code);
    };
  });
}

function handleSocketLost(code) {
  ws = null;
  wsAuthed = false;
  stopHeartbeat();
  reportWsStatus(false);
  if (code != null && NO_RECONNECT_CODES.has(code)) {
    console.warn('[GMR Offscreen] Server closed the connection with code', code, '— not reconnecting');
    return;
  }
  scheduleReconnect();
}

// Intentional close (recording saved, auth refused, going idle).
function closeWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const hadSocket = !!ws;
  dropSocket();
  if (hadSocket) reportWsStatus(false);
}

function scheduleReconnect() {
  if (reconnectTimer || !shouldStayConnected()) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS) + Math.floor(Math.random() * 1000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!shouldStayConnected()) return;
    // The last attempt never even opened: try the other server URL (TLS endpoint <-> legacy).
    if (!lastAttemptOpened && wsUrls.length > 1) wsUrlIndex = (wsUrlIndex + 1) % wsUrls.length;
    console.log('[GMR Offscreen] Reconnecting (attempt', reconnectAttempts + ')...');
    connectWebSocket().catch(err => console.warn('[GMR Offscreen] Reconnect attempt failed:', err.message));
  }, delay);
}

// Our own liveness check. The server's protocol-level pings are answered by the browser invisibly,
// so without this a dead connection could go unnoticed until the OS times out the TCP socket.
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // While a backlog is uploading, our ping can sit in the browser's send buffer behind it, so its
    // pong is late through no fault of the link. Excuse that only while the ping is still queued
    // locally AND bytes are still leaving; once it has left, a missing pong means the link is dead.
    const drained = sockBytesQueued - ws.bufferedAmount;
    if (drained < pingMark && drained > lastDrained) {
      lastServerMsgAt = Math.max(lastServerMsgAt, Date.now() - HEARTBEAT_MS);
    }
    lastDrained = drained;
    if (Date.now() - lastServerMsgAt > PONG_TIMEOUT_MS) {
      console.warn('[GMR Offscreen] No reply from server for', Math.round((Date.now() - lastServerMsgAt) / 1000), 's — treating the connection as dead');
      dropSocket();
      handleSocketLost(null);
      return;
    }
    pingTime = Date.now();
    wsSend(JSON.stringify({ type: 'ping' }));
    pingMark = sockBytesQueued;
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function canSend() {
  return !!ws && ws.readyState === WebSocket.OPEN && wsAuthed;
}

function wsSend(data) {
  ws.send(data);
  sockBytesQueued += typeof data === 'string' ? data.length : data.byteLength;
}

function enqueue(item) {
  if (item.kind === 'chunk') {
    if (outboxBytes + item.buf.byteLength > MAX_OUTBOX_BYTES) {
      if (droppedChunks++ === 0) console.error('[GMR Offscreen] Outbox full — dropping video until the server is reachable again');
      return;
    }
    outboxBytes += item.buf.byteLength;
  } else {
    if (outboxJson >= MAX_OUTBOX_JSON) return;
    outboxJson++;
  }
  outbox.push(item);
  pumpOutbox();
}

function pumpOutbox() {
  if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  if (!canSend()) return;
  while (outbox.length && ws.bufferedAmount < MAX_WS_BUFFERED) {
    const item = outbox.shift();
    if (item.kind === 'chunk') {
      outboxBytes -= item.buf.byteLength;
      wsSend(item.buf);
      sentHistory.push(item);
      if (sentHistory.length > RESEND_HISTORY) sentHistory.shift();
    } else {
      outboxJson--;
      wsSend(item.text);
    }
  }
  if (outbox.length) {
    // Socket buffer is full: continue once it drains.
    pumpTimer = setTimeout(pumpOutbox, PUMP_RETRY_MS);
    return;
  }
  if (droppedChunks) {
    console.warn('[GMR Offscreen] Reconnected after dropping', droppedChunks, 'chunk(s) while the outbox was full');
    droppedChunks = 0;
  }
  if (pendingEnd) deliverEnd();
}

// After a resume, put back anything we sent that the server never stored (lost in flight when the
// old socket died). These chunks are all older than whatever is still queued, so order is preserved.
function requeueUnacked(lastSequence) {
  const missing = sentHistory.filter(h => h.seq > lastSequence);
  sentHistory = sentHistory.filter(h => h.seq <= lastSequence);
  if (!missing.length) return;
  console.log('[GMR Offscreen] Resending', missing.length, 'chunk(s) the server did not receive');
  for (const h of missing) outboxBytes += h.buf.byteLength;
  outbox.unshift(...missing);
}

function clearOutbox({ keepJson = false } = {}) {
  outbox = keepJson ? outbox.filter(i => i.kind === 'json') : [];
  outboxBytes = 0;
  outboxJson = outbox.length;
  sentHistory = [];
  droppedChunks = 0;
}

// Handle recording chunk
function handleChunk(blob, gen) {
  chunkSequence++;
  const seq = chunkSequence;
  if (blob.size > MAX_CHUNK_BYTES) {
    console.error('[GMR Offscreen] Skipping oversized chunk', seq, '(' + Math.round(blob.size / 1048576) + ' MB)');
    return;
  }
  chunkPrep = chunkPrep
    .then(() => blob.arrayBuffer())
    .then(buffer => {
      if (gen !== recorderGeneration) return; // from a recorder we have since replaced
      enqueue({ kind: 'chunk', seq, buf: buildChunkMessage(seq, buffer) });
    })
    .catch(err => console.error('[GMR Offscreen] Failed to read recording chunk:', err));

  chrome.runtime.sendMessage({
    type: 'CHUNK_RECORDED',
    sequence: seq,
    size: blob.size
  });
}

// Binary protocol: [1 byte: type=0x01][4 bytes: sequence (uint32be)][8 bytes: timestamp (uint64be)][N bytes: data]
function buildChunkMessage(sequence, buffer) {
  const headerSize = 13;
  const message = new ArrayBuffer(headerSize + buffer.byteLength);
  const view = new DataView(message);
  view.setUint8(0, 0x01);
  view.setUint32(1, sequence, false);
  view.setBigUint64(5, BigInt(Date.now()), false);
  new Uint8Array(message, headerSize).set(new Uint8Array(buffer));
  return message;
}

// Called when the MediaRecorder has stopped: the end marker goes out only after every queued chunk
// (including the final one the recorder emits on stop), reconnecting first if necessary.
function queueRecordingEnd(duration) {
  if (endQueued) return;
  endQueued = true;
  chunkPrep.then(() => {
    pendingEnd = { totalChunks: chunkSequence, duration, deadline: Date.now() + END_DELIVERY_DEADLINE_MS };
    if (canSend()) pumpOutbox();
    else if (!ws) scheduleReconnect();
  });
}

function deliverEnd() {
  const end = pendingEnd;
  pendingEnd = null;
  const bin = new ArrayBuffer(13);
  const view = new DataView(bin);
  view.setUint8(0, 0x04); // Message type: RECORDING_END
  view.setUint32(1, end.totalChunks, false);
  view.setBigUint64(5, BigInt(Date.now()), false);
  wsSend(bin);
  wsSend(JSON.stringify({
    type: 'recording_end',
    meetingId: meetingId,
    duration: end.duration,
    totalChunks: end.totalChunks,
    timestamp: new Date().toISOString()
  }));
  console.log('[GMR Offscreen] Recording end delivered (', end.totalChunks, 'chunks) — waiting for recording_saved');
  // The server uploads before confirming, which can take a while for long classes.
  if (savedWaitTimer) clearTimeout(savedWaitTimer);
  savedWaitTimer = setTimeout(() => goIdle('recording_saved not received in time'), SAVED_WAIT_MS);
}

// Recording fully handed off (or abandoned): close the socket and let the background close this document.
function goIdle(reason) {
  if (savedWaitTimer) { clearTimeout(savedWaitTimer); savedWaitTimer = null; }
  recorderGeneration++; // a recorder still stopping must not queue a new end marker
  pendingEnd = null;
  currentSessionId = null;
  clearOutbox();
  closeWebSocket();
  console.log('[GMR Offscreen] Idle:', reason);
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_IDLE', reason });
}

function handleWebSocketMessage(data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch (err) {
    return; // binary or non-JSON message, ignore
  }

  switch (message.type) {
    case 'pong':
      chrome.runtime.sendMessage({
        type: 'WS_STATUS',
        connected: true,
        latency: Date.now() - pingTime
      });
      break;
    case 'control':
      if (message.action === 'stop') {
        stopRecording();
      }
      break;
    case 'recording_saved':
      chrome.runtime.sendMessage({
        type: 'RECORDING_SAVED',
        downloadUrl: message.downloadUrl,
        filename: message.filename,
        meetingId: message.meetingId,
        sessionId: message.sessionId
      });
      goIdle('recording saved');
      break;
    case 'status':
      console.log('[GMR Offscreen] Server status:', message);
      if (message.ok === false) {
        // Server refused the recording (e.g. external user without a valid access key). Surface a
        // key prompt via the background worker and abort.
        chrome.runtime.sendMessage({
          type: 'AUTH_FAILED',
          code: message.code || null,
          message: message.message || 'Recording not authorized'
        });
        if (startWaiter) {
          // Still starting: the recorder hasn't started; startRecording() fails and cleans up.
          startRefused = true;
          startWaiter.reject(new Error(message.message || 'Recording not authorized'));
          return;
        }
        stopRecording();
        goIdle('server refused the recording');
      } else if (message.ok && message.sessionId) {
        handleSessionConfirmed(message);
      }
      break;
    default:
      // Forward to popup
      chrome.runtime.sendMessage({
        type: 'WS_MESSAGE',
        data: message
      });
  }
}

function handleSessionConfirmed(message) {
  const resumed = message.reconnected === true && !!currentSessionId && message.sessionId === currentSessionId;
  const lostSession = !!currentSessionId && !resumed;
  currentSessionId = message.sessionId;
  wsAuthed = true;
  reconnectAttempts = 0;
  reportWsStatus(true);

  if (lostSession) {
    console.warn('[GMR Offscreen] Server could not resume our session — continuing in new session', message.sessionId);
    if (pendingEnd) {
      // Stopped already: what we hold is the tail of a stream the new file can't use. Close the empty
      // session straight away instead of leaving it open on the server.
      clearOutbox({ keepJson: true });
      pumpOutbox(); // sends queued events, then the end marker
      return;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      restartRecorderForNewSession();
    }
  } else if (resumed && typeof message.lastSequence === 'number') {
    requeueUnacked(message.lastSequence);
  }
  pumpOutbox();
  if (startWaiter) startWaiter.resolve();
}

// A new server session needs a stream that starts with a WebM header, which only a fresh
// MediaRecorder produces. The queued chunks belong to the finished session and are discarded.
function restartRecorderForNewSession() {
  const old = mediaRecorder;
  clearOutbox({ keepJson: true });
  chunkSequence = 0;
  startMediaRecorder(); // bumps recorderGeneration, so the old recorder's callbacks are ignored
  try { if (old && old.state !== 'inactive') old.stop(); } catch (_) { /* ignore */ }
  console.log('[GMR Offscreen] Recorder restarted for the new session');
}

// JSON events (participants, transcript). Queued like chunks so nothing is lost while reconnecting.
function sendJSONMessage(data) {
  if (!canSend() && !shouldStayConnected()) return; // no recording in progress
  enqueue({ kind: 'json', text: JSON.stringify(data) });
}

// Get supported MIME type
function getSupportedMimeType() {
  const types = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
    'video/mp4'
  ];
  
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  
  return 'video/webm';
}

console.log('[GMR Offscreen] Offscreen script loaded');
