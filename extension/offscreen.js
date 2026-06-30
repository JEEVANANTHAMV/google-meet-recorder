// offscreen.js - Runs in offscreen document
// Handles getDisplayMedia(), MediaRecorder, and WebSocket streaming

let mediaRecorder = null;
let recordedChunks = [];
let ws = null;
let meetingId = null;
let wsUrl = null;
let authToken = null;
let recordingStartTime = null;
let chunkSequence = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let pingTime = 0;
let isPaused = false;
let stream = null;          // the stream handed to MediaRecorder (tab video + mixed audio)
let captureStream = null;   // raw tab/display capture stream
let micStream = null;       // local microphone (best-effort, for the local speaker's voice)
let playbackContext = null; // AudioContext that mixes audio + replays meeting audio to the user

// Message handler from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[GMR Offscreen] Received:', message.type);
  
  (async () => {
    try {
      switch (message.type) {
        case 'START_RECORDING':
          await startRecording(message.wsUrl, message.meetingId, message.authToken, message.streamId, message.captureMic);
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
async function startRecording(serverUrl, mId, token, streamId, captureMic) {
  wsUrl = serverUrl;
  if (!wsUrl || typeof wsUrl !== 'string' || (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://'))) {
    wsUrl = 'ws://18.204.127.179:8001';
  }
  meetingId = mId;
  authToken = token || null;

  console.log('[GMR Offscreen] Starting recording for meeting:', meetingId, '| tabCapture:', !!streamId, '| mic:', !!captureMic);

  // Connect to WebSocket first
  await connectWebSocket();

  try {
    // 1) Acquire the capture stream (tab capture preferred).
    if (streamId) {
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
      });
      console.log('[GMR Offscreen] Tab capture acquired');
    } else {
      // Fallback: screen/window/tab share. systemAudio:'include' asks Chrome to capture the
      // speaker/system audio for screen & window shares (supported on Windows/ChromeOS), and tab
      // shares include tab audio by default — so "entire screen" sharing still records the audio.
      captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 2 },
        systemAudio: 'include'
      });
      console.log('[GMR Offscreen] Display media acquired (fallback). Audio tracks:', captureStream.getAudioTracks().length);
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
      }
    }

    // 3) Build the recording stream: tab video + audio (tab audio = all participants, mixed with
    //    mic if available), and replay meeting audio so tab capture doesn't mute the user's speakers.
    stream = await buildRecordingStream(captureStream, micStream);

    const tabAudioTracks = captureStream ? captureStream.getAudioTracks() : [];
    const isTabAudioMissing = tabAudioTracks.length === 0;

    if (isTabAudioMissing) {
      console.warn('[GMR Offscreen] No tab/system audio track in capture stream!');
      chrome.runtime.sendMessage({ type: 'RECORDING_STATUS', status: 'recording', audioMissing: true });
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      monitorAudioVolume(audioTracks[0]);
    }

    // Handle capture end (tab closed / "Stop sharing")
    const vTrack = captureStream.getVideoTracks()[0];
    if (vTrack) vTrack.onended = () => { console.log('[GMR Offscreen] Capture ended'); stopRecording(); };

    // Create MediaRecorder
    const mimeType = getSupportedMimeType();
    console.log('[GMR Offscreen] Using MIME type:', mimeType);
    
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      videoBitsPerSecond: 2500000,
      audioBitsPerSecond: 128000
    });
    
    // Handle data chunks
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        handleChunk(event.data);
      }
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('[GMR Offscreen] MediaRecorder error:', event);
      chrome.runtime.sendMessage({
        type: 'RECORDING_ERROR',
        error: 'MediaRecorder error: ' + event.message
      });
    };
    
    mediaRecorder.onstop = () => {
      console.log('[GMR Offscreen] MediaRecorder stopped');
      sendRecordingEnd();
    };
    
    // Start recording - collect chunks every 1 second
    mediaRecorder.start(1000);
    recordingStartTime = Date.now();
    chunkSequence = 0;
    isPaused = false;
    
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
    chrome.runtime.sendMessage({
      type: 'RECORDING_ERROR',
      error: 'Failed to start recording: ' + err.message
    });
    throw err;
  }
}

// Mix capture audio (all remote participants) + microphone (local voice) into a single track,
// and replay the meeting audio to the user so tab capture doesn't silence their speakers.
async function buildRecordingStream(capture, mic) {
  const videoTracks = capture.getVideoTracks();
  const tabAudio = capture.getAudioTracks();
  const micAudio = mic ? mic.getAudioTracks() : [];

  console.log('[GMR Offscreen] Audio sources -> tab:', tabAudio.length, 'mic:', micAudio.length);

  // No audio at all.
  if (tabAudio.length === 0 && micAudio.length === 0) {
    chrome.runtime.sendMessage({ type: 'RECORDING_STATUS', status: 'recording', audioMissing: true });
    return new MediaStream(videoTracks);
  }

  // tabCapture mutes the live tab, so we must replay tab audio back to the user. The AudioContext
  // can start SUSPENDED in an offscreen doc -> resume() is essential or the graph outputs silence.
  // CASE A — no mic: record the RAW tab audio track (bulletproof: never affected by context state)
  // and use a context only to replay audio to the user.
  if (micAudio.length === 0) {
    try {
      playbackContext = new AudioContext();
      await playbackContext.resume();
      const tabSrc = playbackContext.createMediaStreamSource(new MediaStream(tabAudio));
      tabSrc.connect(playbackContext.destination); // user keeps hearing the meeting
    } catch (err) {
      console.warn('[GMR Offscreen] Playback passthrough failed (recording still has audio):', err.message);
    }
    return new MediaStream([...videoTracks, ...tabAudio]);
  }

  // CASE B — mic present: mix tab + mic into one recorded track (and replay tab audio to the user).
  try {
    playbackContext = new AudioContext();
    await playbackContext.resume();
    const dest = playbackContext.createMediaStreamDestination();

    if (tabAudio.length > 0) {
      const tabSrc = playbackContext.createMediaStreamSource(new MediaStream(tabAudio));
      tabSrc.connect(dest);                       // -> recorded
      tabSrc.connect(playbackContext.destination); // -> user hears the meeting
    }
    const micSrc = playbackContext.createMediaStreamSource(new MediaStream(micAudio));
    micSrc.connect(dest);                          // -> recorded only (no echo)

    return new MediaStream([...videoTracks, ...dest.stream.getAudioTracks()]);
  } catch (err) {
    console.warn('[GMR Offscreen] Audio mixing failed, recording raw tab+mic:', err.message);
    return new MediaStream([...videoTracks, ...tabAudio, ...micAudio]);
  }
}

// Stop recording
async function stopRecording() {
  console.log('[GMR Offscreen] Stopping recording...');

  stopDurationReporting();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
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

  // Close WebSocket
  closeWebSocket();

  recordingStartTime = null;

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

// Handle recording chunk
function handleChunk(blob) {
  chunkSequence++;
  
  // Send via WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendChunkOverWebSocket(blob, chunkSequence);
  }
  
  // Also notify background about chunk
  chrome.runtime.sendMessage({
    type: 'CHUNK_RECORDED',
    sequence: chunkSequence,
    size: blob.size
  });
}

// Send chunk over WebSocket with binary protocol
function sendChunkOverWebSocket(blob, sequence) {
  // Protocol: [1 byte: type=0x01][4 bytes: sequence (uint32be)][8 bytes: timestamp (uint64be)][N bytes: data]
  const timestamp = BigInt(Date.now());
  
  blob.arrayBuffer().then(buffer => {
    const headerSize = 13; // 1 + 4 + 8
    const totalSize = headerSize + buffer.byteLength;
    const message = new ArrayBuffer(totalSize);
    const view = new DataView(message);
    
    // Write header
    view.setUint8(0, 0x01); // Message type: RECORDING_CHUNK
    view.setUint32(1, sequence, false); // Sequence number (big-endian)
    view.setBigUint64(5, timestamp, false); // Timestamp (big-endian)
    
    // Copy blob data
    new Uint8Array(message, headerSize).set(new Uint8Array(buffer));
    
    ws.send(message);
  });
}

// Send recording end message
function sendRecordingEnd() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const message = new ArrayBuffer(13);
    const view = new DataView(message);
    view.setUint8(0, 0x04); // Message type: RECORDING_END
    view.setUint32(1, chunkSequence, false);
    view.setBigUint64(5, BigInt(Date.now()), false);
    ws.send(message);
  }
  
  // Also send JSON summary
  const duration = recordingStartTime ? Date.now() - recordingStartTime : 0;
  sendJSONMessage({
    type: 'recording_end',
    meetingId: meetingId,
    duration: duration,
    totalChunks: chunkSequence,
    timestamp: new Date().toISOString()
  });
}

// Monitor audio level for diagnostics only. With tab capture an audio track is always present,
// and a quiet moment is NOT "missing audio", so we only log here (no misleading user warning).
function monitorAudioVolume(audioTrack) {
  try {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let silentTicks = 0;

    const checkVolume = () => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        audioContext.close();
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      silentTicks = average < 1 ? silentTicks + 1 : 0;
      if (silentTicks === 15) {
        console.warn('[GMR Offscreen] Audio has been silent for ~30s (no one speaking, or audio not captured)');
      }

      setTimeout(checkVolume, 2000);
    };

    checkVolume();
  } catch (err) {
    console.warn('[GMR Offscreen] Audio monitoring failed:', err);
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

// WebSocket connection
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    if (ws) {
      closeWebSocket();
    }
    
    try {
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        console.log('[GMR Offscreen] WebSocket connected');
        
        // Send auth message
        sendJSONMessage({
          type: 'auth',
          meetingId: meetingId,
          clientType: 'recorder',
          token: authToken || undefined
        });
        
        // Start heartbeat
        startHeartbeat();
        
        chrome.runtime.sendMessage({
          type: 'WS_STATUS',
          connected: true,
          latency: 0
        });
        
        resolve();
      };
      
      ws.onclose = () => {
        console.log('[GMR Offscreen] WebSocket closed');
        stopHeartbeat();
        chrome.runtime.sendMessage({
          type: 'WS_STATUS',
          connected: false
        });
        // Attempt reconnection
        scheduleReconnect();
      };
      
      ws.onerror = (err) => {
        console.error('[GMR Offscreen] WebSocket error:', err);
        chrome.runtime.sendMessage({
          type: 'WS_STATUS',
          connected: false,
          error: 'WebSocket connection failed'
        });
        reject(err);
      };
      
      ws.onmessage = (event) => {
        handleWebSocketMessage(event.data);
      };
      
    } catch (err) {
      reject(err);
    }
  });
}

function closeWebSocket() {
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (recordingStartTime) {
      console.log('[GMR Offscreen] Attempting WebSocket reconnection...');
      connectWebSocket().catch(err => {
        console.error('[GMR Offscreen] Reconnection failed:', err);
      });
    }
  }, 5000);
}

// Heartbeat
function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      pingTime = Date.now();
      sendJSONMessage({ type: 'ping' });
    }
  }, 10000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function handleWebSocketMessage(data) {
  try {
    const message = JSON.parse(data);
    
    switch (message.type) {
      case 'pong':
        const latency = Date.now() - pingTime;
        chrome.runtime.sendMessage({
          type: 'WS_STATUS',
          connected: true,
          latency: latency
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
          filename: message.filename
        });
        break;
      case 'status':
        console.log('[GMR Offscreen] Server status:', message);
        break;
      default:
        // Forward to popup
        chrome.runtime.sendMessage({
          type: 'WS_MESSAGE',
          data: message
        });
    }
  } catch (err) {
    // Binary or non-JSON message, ignore
  }
}

// Send JSON message over WebSocket
function sendJSONMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Get supported MIME type
function getSupportedMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
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
