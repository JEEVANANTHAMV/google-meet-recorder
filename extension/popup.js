// popup.js - Popup Dashboard Logic
// Handles UI rendering, user interactions, and real-time updates

// State
let state = {
  wsUrl: 'ws://18.204.127.179:8001',
  isRecording: false,
  isPaused: false,
  meetingId: null,
  recordingStartTime: null,
  activeParticipants: 0,
  totalParticipants: 0,
  wsConnected: false,
  wsLatency: 0,
  transcriptLines: [],
  activityLog: [],
  recordingError: null,
  micEnabled: false
};

// Timer interval
let timerInterval = null;
let wsUptimeStart = null;

// DOM Elements
const els = {};

// Initialize
async function init() {
  console.log('[GMR Popup] Initializing...');
  
  // Cache DOM elements
  cacheElements();
  
  // Load state from background
  await loadState();
  
  // Setup event listeners
  setupEventListeners();
  
  // Setup message listener for real-time updates
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  
  // Initial render
  renderAll();
  
  // Start timer if recording
  if (state.isRecording && state.recordingStartTime) {
    startTimer();
  }
}

function cacheElements() {
  els.recordingCard = document.getElementById('recordingCard');
  els.recordingDot = document.getElementById('recordingDot');
  els.recordingLabel = document.getElementById('recordingLabel');
  els.recordingTimer = document.getElementById('recordingTimer');
  els.recordingButtons = document.getElementById('recordingButtons');
  els.recordingError = document.getElementById('recordingError');
  
  els.wsDot = document.getElementById('wsDot');
  els.wsStatusText = document.getElementById('wsStatusText');
  els.wsUrl = document.getElementById('wsUrl');
  els.wsLatency = document.getElementById('wsLatency');
  els.wsUptime = document.getElementById('wsUptime');
  
  els.meetingId = document.getElementById('meetingId');
  els.activeCount = document.getElementById('activeCount');
  els.totalCount = document.getElementById('totalCount');
  
  els.transcriptPanel = document.getElementById('transcriptPanel');
  els.transcriptBadge = document.getElementById('transcriptBadge');
  els.activityLog = document.getElementById('activityLog');
  els.activityBadge = document.getElementById('activityBadge');
  
  els.btnStart = document.getElementById('btnStart');
  els.btnEnableMic = document.getElementById('btnEnableMic');
  els.micHint = document.getElementById('micHint');
  els.btnSettings = document.getElementById('btnSettings');
  els.settingsOverlay = document.getElementById('settingsOverlay');
  els.btnCloseSettings = document.getElementById('btnCloseSettings');
  els.wsUrlInput = document.getElementById('wsUrlInput');
  els.btnSaveSettings = document.getElementById('btnSaveSettings');
  els.settingsError = document.getElementById('settingsError');
  els.settingsSuccess = document.getElementById('settingsSuccess');
}

function setupEventListeners() {
  // Start recording
  els.btnStart.addEventListener('click', handleStartRecording);

  // Enable microphone capture (the permission prompt can only appear here, not in offscreen)
  if (els.btnEnableMic) els.btnEnableMic.addEventListener('click', handleEnableMic);
  
  // Settings
  els.btnSettings.addEventListener('click', () => {
    els.wsUrlInput.value = state.wsUrl;
    els.settingsOverlay.classList.add('visible');
  });
  
  els.btnCloseSettings.addEventListener('click', () => {
    els.settingsOverlay.classList.remove('visible');
  });
  
  els.btnSaveSettings.addEventListener('click', handleSaveSettings);
  
  // Enter key in settings
  els.wsUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSaveSettings();
  });
}

async function loadState() {
  try {
    const response = await sendMessage({ type: 'GET_STATE' });
    if (response && response.state) {
      state = { ...state, ...response.state };
    }
  } catch (err) {
    console.error('[GMR Popup] Failed to load state:', err);
  }
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || {});
    });
  });
}

// ==================== EVENT HANDLERS ====================

async function handleStartRecording() {
  console.log('[GMR Popup] Starting recording...');
  
  els.recordingError.classList.add('hidden');
  els.btnStart.disabled = true;
  els.btnStart.textContent = 'Starting...';

  try {
    // Acquire the tab-capture stream id HERE (the popup is a user-gesture context, which
    // chrome.tabCapture requires) so we get clean tab audio with no screen-share picker.
    let streamId = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && /meet\.google\.com/.test(tab.url || '')) {
        streamId = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          });
        });
      }
    } catch (e) {
      console.warn('[GMR Popup] tabCapture id failed, server will fall back:', e.message);
    }

    const response = await sendMessage({ type: 'START_RECORDING', streamId });

    if (response.error) {
      els.recordingError.textContent = response.message || response.error;
      els.recordingError.classList.remove('hidden');
      els.btnStart.disabled = false;
      els.btnStart.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
        Start Recording
      `;
      return;
    }
    
    state.isRecording = true;
    state.recordingStartTime = Date.now();
    state.recordingError = null;
    
    startTimer();
    renderRecordingCard();
    
    // Notify content script to show floating controls
    sendMessageToContent({ type: 'SHOW_FLOATING_CONTROLS' });
    
  } catch (err) {
    console.error('[GMR Popup] Start recording failed:', err);
    els.recordingError.textContent = 'Failed to start recording: ' + err.message;
    els.recordingError.classList.remove('hidden');
    els.btnStart.disabled = false;
    els.btnStart.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
      Start Recording
    `;
  }
}

async function handleStopRecording() {
  console.log('[GMR Popup] Stopping recording...');
  
  try {
    await sendMessage({ type: 'STOP_RECORDING' });
    
    state.isRecording = false;
    state.isPaused = false;
    state.recordingStartTime = null;
    
    stopTimer();
    renderRecordingCard();
    
    // Notify content script
    sendMessageToContent({ type: 'HIDE_FLOATING_CONTROLS' });
    
  } catch (err) {
    console.error('[GMR Popup] Stop recording failed:', err);
  }
}

async function handlePauseRecording() {
  try {
    await sendMessage({ type: 'PAUSE_RECORDING' });
    state.isPaused = true;
    renderRecordingCard();
  } catch (err) {
    console.error('[GMR Popup] Pause failed:', err);
  }
}

async function handleResumeRecording() {
  try {
    await sendMessage({ type: 'RESUME_RECORDING' });
    state.isPaused = false;
    renderRecordingCard();
  } catch (err) {
    console.error('[GMR Popup] Resume failed:', err);
  }
}

// Request microphone permission. The popup is too transient to reliably show Chrome's mic prompt,
// so we open a dedicated full-page tab (permission.html) which prompts reliably. Granting there
// persists for the whole extension origin, so the offscreen recorder can capture the local voice.
function handleEnableMic() {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  if (els.micHint) {
    els.micHint.textContent = 'Opened a tab to grant microphone access — click Allow there, then come back.';
    els.micHint.style.color = '';
  }
}

function renderMicState() {
  if (!els.btnEnableMic) return;
  if (state.micEnabled) {
    els.btnEnableMic.textContent = '🎤 My mic is enabled';
    els.btnEnableMic.disabled = true;
    els.btnEnableMic.classList.remove('btn-secondary');
    els.btnEnableMic.classList.add('btn-primary');
    if (els.micHint) els.micHint.textContent = 'Your voice + all participants will be recorded.';
  }
}

async function handleSaveSettings() {
  const url = els.wsUrlInput.value.trim();
  
  if (!url) {
    els.settingsError.textContent = 'Please enter a WebSocket URL';
    els.settingsError.classList.remove('hidden');
    return;
  }
  
  // Basic URL validation
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    els.settingsError.textContent = 'URL must start with ws:// or wss://';
    els.settingsError.classList.remove('hidden');
    return;
  }
  
  els.settingsError.classList.add('hidden');
  
  try {
    await sendMessage({ type: 'UPDATE_SETTINGS', wsUrl: url });
    state.wsUrl = url;
    els.wsUrl.textContent = url;
    
    els.settingsSuccess.textContent = 'Settings saved!';
    els.settingsSuccess.classList.remove('hidden');
    
    setTimeout(() => {
      els.settingsOverlay.classList.remove('visible');
      els.settingsSuccess.classList.add('hidden');
    }, 1500);
    
  } catch (err) {
    els.settingsError.textContent = 'Failed to save settings';
    els.settingsError.classList.remove('hidden');
  }
}

// ==================== RENDERING ====================

function renderAll() {
  renderRecordingCard();
  renderWebSocketStatus();
  renderMeetingInfo();
  renderTranscript();
  renderActivityLog();
  renderMicState();
}

function renderRecordingCard() {
  els.recordingCard.className = 'glass-card recording-card';
  els.recordingDot.className = 'recording-dot';
  els.recordingLabel.className = 'recording-label';
  els.recordingTimer.className = 'recording-timer';
  
  if (state.isRecording && !state.isPaused) {
    // Recording active
    els.recordingCard.classList.add('recording');
    els.recordingDot.classList.add('active');
    els.recordingLabel.classList.add('active');
    els.recordingLabel.textContent = 'Recording';
    els.recordingTimer.classList.add('active');
    
    els.recordingButtons.innerHTML = `
      <button class="btn btn-secondary" id="btnPause">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
        Pause
      </button>
    `;

    document.getElementById('btnPause').addEventListener('click', handlePauseRecording);

  } else if (state.isRecording && state.isPaused) {
    // Paused
    els.recordingCard.classList.add('paused');
    els.recordingLabel.textContent = 'Paused';
    els.recordingTimer.classList.add('paused');

    els.recordingButtons.innerHTML = `
      <button class="btn btn-primary" id="btnResume">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Resume
      </button>
    `;

    document.getElementById('btnResume').addEventListener('click', handleResumeRecording);

  } else {
    // Idle
    els.recordingLabel.textContent = 'Not Recording';
    els.recordingTimer.textContent = '00:00:00';
    
    els.recordingButtons.innerHTML = `
      <button class="btn btn-primary" id="btnStart">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
        Start Recording
      </button>
    `;
    
    document.getElementById('btnStart').addEventListener('click', handleStartRecording);
  }
  
  // Show error if any
  if (state.recordingError) {
    els.recordingError.textContent = state.recordingError;
    els.recordingError.classList.remove('hidden');
  } else {
    els.recordingError.classList.add('hidden');
  }
}

function renderWebSocketStatus() {
  els.wsDot.className = 'ws-dot';
  els.wsStatusText.className = 'ws-status-text';
  
  if (state.wsConnected) {
    els.wsDot.classList.add('connected');
    els.wsStatusText.classList.add('connected');
    els.wsStatusText.textContent = 'Connected';
    
    // Latency with color coding
    els.wsLatency.textContent = state.wsLatency + 'ms';
    els.wsLatency.className = 'ws-latency';
    if (state.wsLatency < 50) {
      els.wsLatency.classList.add('low');
    } else if (state.wsLatency < 200) {
      els.wsLatency.classList.add('medium');
    } else {
      els.wsLatency.classList.add('high');
    }
    
    // Uptime
    if (!wsUptimeStart && state.wsConnected) {
      wsUptimeStart = Date.now();
    }
    
  } else {
    els.wsDot.classList.add('error');
    els.wsStatusText.textContent = 'Disconnected';
    els.wsLatency.textContent = '--ms';
    els.wsUptime.textContent = '--:--:--';
    wsUptimeStart = null;
  }
  
  els.wsUrl.textContent = state.wsUrl;
}

function renderMeetingInfo() {
  els.meetingId.textContent = state.meetingId || '--';
  els.activeCount.textContent = state.activeParticipants || 0;
  els.totalCount.textContent = state.totalParticipants || 0;
}

function renderTranscript() {
  const lines = state.transcriptLines || [];
  els.transcriptBadge.textContent = lines.length;
  
  if (lines.length === 0) {
    els.transcriptPanel.innerHTML = '<div class="transcript-empty">Transcript will appear here when live captions are active</div>';
    return;
  }
  
  els.transcriptPanel.innerHTML = lines.slice(-50).map(line => {
    const time = formatTime(new Date(line.timestamp));
    return `
      <div class="transcript-line">
        <span class="transcript-time">[${time}]</span>
        <span class="transcript-speaker">${escapeHtml(line.speaker)}:</span>
        <span class="transcript-text">${escapeHtml(line.text)}</span>
      </div>
    `;
  }).join('');
  
  // Auto-scroll to bottom
  els.transcriptPanel.scrollTop = els.transcriptPanel.scrollHeight;
}

function renderActivityLog() {
  const log = state.activityLog || [];
  els.activityBadge.textContent = log.length;
  
  if (log.length === 0) {
    els.activityLog.innerHTML = '<div class="activity-empty">Participant activity will appear here</div>';
    return;
  }
  
  els.activityLog.innerHTML = log.slice(-30).map(entry => {
    const time = formatTime(new Date(entry.timestamp));
    const icon = entry.event === 'joined' ? '➕' : '➖';
    const iconClass = entry.event === 'joined' ? 'join' : 'leave';
    const action = entry.event === 'joined' ? 'joined' : 'left';
    
    return `
      <div class="activity-entry">
        <span class="activity-icon ${iconClass}">${icon}</span>
        <span class="activity-time">${time}</span>
        <span class="activity-name">${escapeHtml(entry.name)}</span>
        <span class="activity-action">${action}</span>
      </div>
    `;
  }).join('');
}

// ==================== TIMER ====================

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (state.recordingStartTime && !state.isPaused) {
      const elapsed = Date.now() - state.recordingStartTime;
      els.recordingTimer.textContent = formatDuration(elapsed);
      
      // Update WS uptime if connected
      if (state.wsConnected && wsUptimeStart) {
        const uptime = Date.now() - wsUptimeStart;
        els.wsUptime.textContent = formatDuration(uptime);
      }
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ==================== MESSAGE HANDLER ====================

function handleRuntimeMessage(message, sender, sendResponse) {
  console.log('[GMR Popup] Received:', message.type);
  
  switch (message.type) {
    case 'RECORDING_UPDATE':
      if (message.status === 'recording') {
        state.isRecording = true;
        state.isPaused = false;
      } else if (message.status === 'paused') {
        state.isPaused = true;
      } else if (message.status === 'stopped') {
        state.isRecording = false;
        state.isPaused = false;
        stopTimer();
      }
      renderRecordingCard();
      break;
    
    case 'RECORDING_ERROR':
      state.recordingError = message.error;
      state.isRecording = false;
      stopTimer();
      renderRecordingCard();
      break;
    
    case 'WS_STATUS_UPDATE':
      state.wsConnected = message.connected;
      state.wsLatency = message.latency || 0;
      renderWebSocketStatus();
      break;
    
    case 'PARTICIPANT_UPDATE':
      state.activeParticipants = message.activeParticipants;
      state.totalParticipants = message.totalParticipants;
      
      // Add to activity log
      if (!state.activityLog) state.activityLog = [];
      state.activityLog.unshift({
        event: message.event,
        name: message.name,
        timestamp: message.timestamp
      });
      if (state.activityLog.length > 100) state.activityLog.length = 100;
      
      renderMeetingInfo();
      renderActivityLog();
      break;
    
    case 'PARTICIPANT_COUNT_UPDATE_POPUP':
      state.activeParticipants = message.activeParticipants || 0;
      if (typeof message.totalParticipants === 'number') {
        state.totalParticipants = message.totalParticipants;
      }
      renderMeetingInfo();
      break;
    
    case 'TRANSCRIPT_UPDATE':
      if (!state.transcriptLines) state.transcriptLines = [];
      state.transcriptLines.push({
        speaker: message.speaker,
        text: message.text,
        timestamp: message.timestamp
      });
      if (state.transcriptLines.length > 500) state.transcriptLines.shift();
      renderTranscript();
      break;
    
    case 'MEETING_UPDATE':
      state.meetingId = message.meetingId;
      renderMeetingInfo();
      break;
    
    case 'CHUNK_UPDATE':
      // Could show chunk count if desired
      break;
    
    default:
      // Ignore unknown messages
      break;
  }
}

// ==================== HELPERS ====================

function sendMessageToContent(message) {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, message);
    }
  });
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatTime(date) {
  if (isNaN(date.getTime())) return '--:--:--';
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Start
init();
