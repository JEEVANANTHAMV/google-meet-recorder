// offscreen.js - Runs in offscreen document
// Handles getDisplayMedia(), MediaRecorder, and WebSocket streaming

let mediaRecorder = null;
let recordedChunks = [];
let ws = null;
let meetingId = null;
let wsUrl = null;
let recordingStartTime = null;
let chunkSequence = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let pingTime = 0;
let isPaused = false;
let stream = null;

// Message handler from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[GMR Offscreen] Received:', message.type);
  
  (async () => {
    try {
      switch (message.type) {
        case 'START_RECORDING':
          await startRecording(message.wsUrl, message.meetingId);
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

// Start recording with display media
async function startRecording(serverUrl, mId) {
  wsUrl = serverUrl;
  meetingId = mId;
  
  console.log('[GMR Offscreen] Starting recording for meeting:', meetingId);
  console.log('[GMR Offscreen] WebSocket URL:', wsUrl);
  
  // Connect to WebSocket first
  await connectWebSocket();
  
  try {
    // Request display media with audio
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'browser',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2
      }
    });
    
    console.log('[GMR Offscreen] Display media acquired');
    console.log('[GMR Offscreen] Tracks:', stream.getTracks().map(t => ({ kind: t.kind, label: t.label, enabled: t.enabled })));
    
    // Check if audio track exists and is active
    const audioTracks = stream.getAudioTracks();
    const hasAudio = audioTracks.length > 0 && audioTracks[0].enabled;
    
    if (!hasAudio) {
      console.warn('[GMR Offscreen] No audio track detected!');
      // Notify background about missing audio
      chrome.runtime.sendMessage({
        type: 'RECORDING_STATUS',
        status: 'recording',
        audioMissing: true
      });
    } else {
      // Monitor audio volume to detect if it's actually capturing
      monitorAudioVolume(audioTracks[0]);
    }
    
    // Handle stream end (user clicks "Stop sharing")
    stream.getVideoTracks()[0].onended = () => {
      console.log('[GMR Offscreen] Stream ended by user');
      stopRecording();
    };
    
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

// Stop recording
async function stopRecording() {
  console.log('[GMR Offscreen] Stopping recording...');
  
  stopDurationReporting();
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  
  // Stop all tracks
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
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

// Monitor audio volume to detect silent/missing audio
function monitorAudioVolume(audioTrack) {
  try {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const checkVolume = () => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        audioContext.close();
        return;
      }
      
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      
      // If average volume is near zero for a while, audio might not be shared
      if (average < 1) {
        chrome.runtime.sendMessage({
          type: 'RECORDING_STATUS',
          status: 'recording',
          audioMissing: true
        });
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
          clientType: 'recorder'
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
