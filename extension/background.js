// background.js - Service Worker
// Coordinates all extension components: popup, content script, offscreen document

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreen = false;

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    wsUrl: 'ws://164.52.198.68:8001',
    isRecording: false,
    meetingId: null,
    recordingStartTime: null,
    totalParticipants: 0,
    activeParticipants: 0,
    transcriptLines: [],
    activityLog: []
  });
  console.log('[GMR] Extension installed, defaults set');
});

// Check if offscreen document exists
async function hasOffscreenDocument() {
  const matchedClients = await clients.matchAll();
  return matchedClients.some(c => c.url.includes(OFFSCREEN_DOCUMENT_PATH));
}

// Create offscreen document for recording
async function setupOffscreenDocument(path) {
  if (creatingOffscreen) {
    await waitForCreating();
  }
  
  if (await hasOffscreenDocument()) {
    return;
  }
  
  creatingOffscreen = true;
  try {
    await chrome.offscreen.createDocument({
      url: path,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Recording Google Meet sessions with audio and video capture'
    });
    console.log('[GMR] Offscreen document created');
  } catch (err) {
    console.error('[GMR] Failed to create offscreen document:', err);
  } finally {
    creatingOffscreen = false;
  }
}

// Close offscreen document
async function closeOffscreenDocument() {
  if (!await hasOffscreenDocument()) {
    return;
  }
  await chrome.offscreen.closeDocument();
  console.log('[GMR] Offscreen document closed');
}

let resolveCreating;
function waitForCreating() {
  return new Promise(resolve => {
    resolveCreating = resolve;
    const check = setInterval(() => {
      if (!creatingOffscreen) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 5000);
  });
}

// Message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[GMR] Background received:', message.type, 'from:', sender.tab ? 'content' : 'popup');
  
  (async () => {
    try {
      switch (message.type) {
        // Popup commands
        case 'START_RECORDING':
          await handleStartRecording(message, sendResponse);
          break;
        case 'STOP_RECORDING':
          await handleStopRecording(sendResponse);
          break;
        case 'PAUSE_RECORDING':
          await sendToOffscreen({ type: 'PAUSE_RECORDING' }, sendResponse);
          break;
        case 'RESUME_RECORDING':
          await sendToOffscreen({ type: 'RESUME_RECORDING' }, sendResponse);
          break;
        case 'GET_STATE':
          await handleGetState(sendResponse);
          break;
        case 'UPDATE_SETTINGS':
          await handleUpdateSettings(message, sendResponse);
          break;
        
        // Content script events
        case 'PARTICIPANT_EVENT':
          await handleParticipantEvent(message, sendResponse);
          break;
        case 'PARTICIPANT_STATE':
          await handleParticipantState(message, sendResponse);
          break;
        case 'TRANSCRIPT_LINE':
          await handleTranscriptLine(message, sendResponse);
          break;
        case 'RECORDING_SAVED':
          await handleRecordingSaved(message, sendResponse);
          break;
        case 'MEETING_DETECTED':
          await handleMeetingDetected(message, sender, sendResponse);
          break;
        case 'AUDIO_WARNING_DISMISSED':
          await chrome.storage.local.set({ audioWarningDismissed: true });
          sendResponse({ success: true });
          break;
        
        // Offscreen events
        case 'RECORDING_STATUS':
          await handleRecordingStatus(message, sendResponse);
          break;
        case 'RECORDING_ERROR':
          await handleRecordingError(message, sendResponse);
          break;
        case 'CHUNK_RECORDED':
          await handleChunkRecorded(message, sendResponse);
          break;
        
        // WebSocket events (forwarded from offscreen or popup)
        case 'WS_STATUS':
          await handleWebSocketStatus(message, sendResponse);
          break;
        case 'WS_MESSAGE':
          await broadcastToPopups(message);
          sendResponse({ success: true });
          break;
        
        default:
          console.warn('[GMR] Unknown message type:', message.type);
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[GMR] Message handler error:', err);
      sendResponse({ error: err.message });
    }
  })();
  
  return true; // Keep channel open for async
});

// Start recording handler
async function handleStartRecording(message, sendResponse) {
  console.log('[GMR] Starting recording...');

  // Get meeting info from storage
  const data = await chrome.storage.local.get(['meetingId', 'wsUrl', 'wsAuthToken', 'recordedTabId', 'inMeeting', 'micEnabled']);

  // #1: Only record once the user is actually INSIDE the call (not the lobby/green room).
  // Bail out before creating any session / offscreen doc / WebSocket.
  if (!data.meetingId || !data.inMeeting) {
    sendResponse({ error: 'NOT_IN_MEETING', message: 'You are not inside the meeting yet. Please join the meeting and then click Record.' });
    return;
  }

  // #3: Acquire a tab-capture stream id so the offscreen doc can grab tab AUDIO + video reliably
  // (no screen-share picker, and audio of all participants is included). Falls back to display capture.
  let streamId = null;
  if (data.recordedTabId != null) {
    try {
      streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: data.recordedTabId }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
      console.log('[GMR] tabCapture stream id acquired');
    } catch (err) {
      console.warn('[GMR] getMediaStreamId failed, falling back to display capture:', err.message);
    }
  }

  // Setup offscreen document for recording
  await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);

  // Send start command to offscreen
  const result = await sendToOffscreen({
    type: 'START_RECORDING',
    wsUrl: data.wsUrl || 'ws://164.52.198.68:8001',
    meetingId: data.meetingId,
    authToken: data.wsAuthToken || null,
    streamId,
    captureMic: data.micEnabled === true
  });

  if (result.success) {
    await chrome.storage.local.set({
      isRecording: true,
      recordingStartTime: Date.now(),
      transcriptLines: [],
      activityLog: [],
      lastDownloadUrl: null,
      lastFilename: null
    });

    // Ask the content script to re-emit the current roster so the server-side session
    // records everyone who was already in the call before the socket opened.
    const tabData = await chrome.storage.local.get(['recordedTabId']);
    if (tabData.recordedTabId) {
      try {
        chrome.tabs.sendMessage(tabData.recordedTabId, { type: 'FLUSH_PARTICIPANTS' });
      } catch (err) {
        console.warn('[GMR] Failed to request participant flush:', err);
      }
    }
  }

  sendResponse(result);
}

// Stop recording handler
async function handleStopRecording(sendResponse) {
  console.log('[GMR] Stopping recording...');
  
  const result = await sendToOffscreen({ type: 'STOP_RECORDING' });
  
  await chrome.storage.local.set({
    isRecording: false,
    recordingStartTime: null
  });
  
  // Close offscreen after a delay to ensure final chunk is sent
  setTimeout(() => closeOffscreenDocument(), 3000);
  
  sendResponse(result);
}

// Get current state
async function handleGetState(sendResponse) {
  const data = await chrome.storage.local.get([
    'wsUrl', 'isRecording', 'meetingId', 'recordingStartTime',
    'totalParticipants', 'activeParticipants', 'transcriptLines',
    'activityLog', 'wsConnected', 'wsLatency', 'micEnabled'
  ]);
  sendResponse({ success: true, state: data });
}

// Update settings
async function handleUpdateSettings(message, sendResponse) {
  const updates = {};
  if (message.wsUrl) updates.wsUrl = message.wsUrl;
  if (typeof message.micEnabled === 'boolean') updates.micEnabled = message.micEnabled;
  await chrome.storage.local.set(updates);
  sendResponse({ success: true });
}

// Handle a count-only sync from the content script's snapshot-diff engine.
// The content script is the single source of truth for counts, so we just persist them.
async function handleParticipantState(message, sendResponse) {
  const activeParticipants = message.activeCount || 0;
  const totalParticipants = message.totalCount || 0;
  await chrome.storage.local.set({ activeParticipants, totalParticipants });
  await broadcastToPopups({
    type: 'PARTICIPANT_COUNT_UPDATE_POPUP',
    activeParticipants,
    totalParticipants
  });
  sendResponse({ success: true });
}

// Handle a participant join/left delta from the content script.
// Counts come straight from the content script (no local increment/decrement — that drifts).
async function handleParticipantEvent(message, sendResponse) {
  const { event, name, participantId, timestamp } = message;
  const activeParticipants = message.activeCount || 0;
  const totalParticipants = message.totalCount || 0;

  const data = await chrome.storage.local.get(['activityLog', 'isRecording']);

  const activityLog = data.activityLog || [];
  activityLog.unshift({ event, name, timestamp });
  if (activityLog.length > 100) activityLog.length = 100;

  await chrome.storage.local.set({ activeParticipants, totalParticipants, activityLog });

  // Forward to popup
  await broadcastToPopups({
    type: 'PARTICIPANT_UPDATE',
    event, name, timestamp, activeParticipants, totalParticipants
  });

  // Stream to the server over the WebSocket (offscreen owns the socket) while recording.
  if (data.isRecording) {
    await sendToOffscreen({
      type: 'SEND_PARTICIPANT',
      event, name, participantId, timestamp,
      activeCount: activeParticipants,
      totalCount: totalParticipants
    });
  }

  sendResponse({ success: true });
}

// Handle transcript line from content script
async function handleTranscriptLine(message, sendResponse) {
  const { speaker, text, timestamp } = message;
  
  const data = await chrome.storage.local.get(['transcriptLines', 'isRecording']);
  const transcriptLines = data.transcriptLines || [];
  transcriptLines.push({ speaker, text, timestamp });
  // Keep last 500 lines
  if (transcriptLines.length > 500) transcriptLines.shift();
  
  await chrome.storage.local.set({ transcriptLines });
  
  // Forward to popup
  await broadcastToPopups({
    type: 'TRANSCRIPT_UPDATE',
    speaker, text, timestamp
  });
  
  // Forward to offscreen to send over WebSocket if recording
  if (data.isRecording) {
    await sendToOffscreen({
      type: 'SEND_TRANSCRIPT',
      speaker, text, timestamp
    });
  }
  
  sendResponse({ success: true });
}

// Handle meeting detected from content script
async function handleMeetingDetected(message, sender, sendResponse) {
  const { meetingId } = message;
  console.log('[GMR] Meeting detected:', meetingId);
  
  const recordedTabId = sender.tab ? sender.tab.id : null;
  await chrome.storage.local.set({ meetingId, recordedTabId });
  
  // Notify popup
  await broadcastToPopups({ type: 'MEETING_UPDATE', meetingId });
  
  sendResponse({ success: true });
}

// Handle recording status from offscreen
async function handleRecordingStatus(message, sendResponse) {
  const { status, duration, error, audioMissing } = message;
  console.log('[GMR] Recording status:', status, 'audioMissing:', !!audioMissing);

  // #2: A 'paused' status must NOT clear isRecording — otherwise pause looks like a full stop
  // (UI resets, participant/transcript streaming halts). Only 'stopped' ends the recording.
  const updates = { recordingError: error || null };
  if (status === 'recording') {
    updates.isRecording = true;
    updates.isPaused = false;
  } else if (status === 'paused') {
    updates.isRecording = true;
    updates.isPaused = true;
  } else if (status === 'stopped') {
    updates.isRecording = false;
    updates.isPaused = false;
  }
  await chrome.storage.local.set(updates);

  await broadcastToPopups({ type: 'RECORDING_UPDATE', status, duration, error });
  
  if (audioMissing) {
    const data = await chrome.storage.local.get(['recordedTabId']);
    if (data.recordedTabId) {
      try {
        chrome.tabs.sendMessage(data.recordedTabId, { type: 'SHOW_AUDIO_WARNING' });
      } catch (err) {
        console.warn('[GMR] Failed to send audio warning to tab:', err);
      }
    }
  }
  
  sendResponse({ success: true });
}

// Handle recording saved from offscreen
async function handleRecordingSaved(message, sendResponse) {
  const { downloadUrl, filename } = message;
  await chrome.storage.local.set({ lastDownloadUrl: downloadUrl, lastFilename: filename });
  await broadcastToPopups({ type: 'RECORDING_SAVED_POPUP', downloadUrl, filename });
  sendResponse({ success: true });
}

// Handle recording error from offscreen
async function handleRecordingError(message, sendResponse) {
  const { error } = message;
  console.error('[GMR] Recording error:', error);
  
  await chrome.storage.local.set({
    isRecording: false,
    recordingError: error
  });
  
  await broadcastToPopups({ type: 'RECORDING_ERROR', error });
  sendResponse({ success: true });
}

// Handle chunk recorded from offscreen
async function handleChunkRecorded(message, sendResponse) {
  // Update chunk counter
  const data = await chrome.storage.local.get(['totalChunks']);
  const totalChunks = (data.totalChunks || 0) + 1;
  await chrome.storage.local.set({ totalChunks });
  
  await broadcastToPopups({ type: 'CHUNK_UPDATE', totalChunks });
  sendResponse({ success: true });
}

// Handle WebSocket status
async function handleWebSocketStatus(message, sendResponse) {
  const { connected, latency } = message;
  await chrome.storage.local.set({ wsConnected: connected, wsLatency: latency });
  await broadcastToPopups({ type: 'WS_STATUS_UPDATE', connected, latency });
  sendResponse({ success: true });
}

// Broadcast message to all popup views
async function broadcastToPopups(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (e) {
    // Popup may not be open - this is fine
  }
}

// Send message to offscreen document
async function sendToOffscreen(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { error: 'No response from offscreen' });
    });
  });
}

// Handle tab close while recording
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const data = await chrome.storage.local.get(['isRecording', 'recordedTabId']);
  if (data.isRecording && tabId === data.recordedTabId) {
    console.log('[GMR] Recorded Meet tab closed, stopping recording...');
    await handleStopRecording(() => {});
  }
});

console.log('[GMR] Background service worker started');
