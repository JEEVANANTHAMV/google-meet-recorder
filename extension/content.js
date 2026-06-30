// content.js - Content Script
// Runs on meet.google.com — handles participant tracking, transcript capture, audio warning, and page-injected controls

(function() {
  'use strict';

  console.log('[GMR Content] Google Meet Recorder content script loaded');

  // State
  let meetingId = null;
  let isInitialized = false;
  let participantObserver = null;
  let transcriptObserver = null;
  let warningBanner = null;
  let transcriptContainer = null;
  let periodicIntervalId = null;
  let timerIntervalId = null;
  let reconcileDebounce = null;
  let lastSentActiveCount = null;
  let lastSentTotalCount = null;
  let wasInCall = false;
  let lastReportedInMeeting = null;
  let captionsArmed = false;          // true once we've successfully enabled captions at least once
  let captionWarnCooldownUntil = 0;   // suppress duplicate "captions required" warnings
  let lastPanelOpenAttempt = 0;       // rate-limit auto-opening the People panel

  // ===== Participant tracking: stable-identity cache + snapshot-diff engine =====
  // id -> { id, name, joinedAt, lastSeen, leftAt, missingSince }
  const participantCache = new Map();
  const LEAVE_GRACE_MS = 4000;       // confirm a LEFT only after this long missing (avoids SPA re-render false positives)
  const RECONCILE_INTERVAL_MS = 2000; // how often we diff the DOM against the cache

  let gmrState = {
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
    lastDownloadUrl: null,
    lastFilename: null
  };

  // DOM Selectors for Google Meet.
  // Participant tracking deliberately AVOIDS obfuscated CSS classes (.zWfAib etc.) because
  // Google rotates them every few weeks. We rely on stable attribute / accessibility hooks
  // (data-participant-id, role=listitem, aria-label, data-self-name) — see snapshotParticipants().
  const SELECTORS = {
    // Stable hooks that identify a unique participant in the call (tiles AND people panel)
    participantId: '[data-participant-id]',
    peopleListItem: '[role="listitem"][data-participant-id], [role="list"] [role="listitem"]',

    // Live captions / transcript (still class-based; updated best-effort)
    transcriptContainer: '.V6Yesc, .a4cQT, .Mz6pEf, [jsname="tgaKEf"], .bY93Qe, .TBMuR',
    transcriptLine: '.TBMuR, .bY93Qe, .Mz6pEf, .V6Yesc > div',
    transcriptSpeaker: '.Mz6pEf .PABS8e, .TBMuR .PABS8e, .bY93Qe .PABS8e',
    transcriptText: '.Mz6pEf .bY97s, .TBMuR .bY97s, .bY93Qe .bY97s, .V6Yesc span:last-child',

    // Self name
    selfName: '[data-self-name]'
  };

  // Strings that look like names but are actually Meet UI chrome / id-path words — never treat
  // these as participant names.
  const UI_NOISE = new Set([
    'you', 'me', 'mic', 'camera', 'present', 'presenting', 'chat', 'people', 'raise hand',
    'more options', 'more', 'cc', 'captions', 'pin', 'pinned', 'unpin', 'remove', 'mute',
    'muted', 'unmute', 'host', 'co-host', 'meeting host', 'screen share', 'is presenting',
    'turn off', 'turn on', 'add people', 'search for people', 'contributors', 'in this call',
    // words that come from data-participant-id paths ("spaces/<id>/devices/<n>") or panel status
    'devices', 'spaces', 'device', 'space', 'guest', 'anonymous', 'calling', 'ringing',
    'invited', 'waiting', 'joining', 'presentation', 'your presentation', 'meeting details'
  ]);

  // ==================== DOM CREATION HELPER ====================
  // Safe helper to build DOM elements without innerHTML (complying with secure coding guidelines)
  function createDOMElement(tag, attrs = {}, children = []) {
    const element = document.createElement(tag);
    
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') {
        element.className = value;
      } else if (key === 'id') {
        element.id = value;
      } else if (key === 'style') {
        element.setAttribute('style', value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        const eventName = key.substring(2).toLowerCase();
        element.addEventListener(eventName, value);
      } else {
        element.setAttribute(key, value);
      }
    }
    
    for (const child of children) {
      if (typeof child === 'string') {
        element.appendChild(document.createTextNode(child));
      } else if (child instanceof HTMLElement || child instanceof Text) {
        element.appendChild(child);
      }
    }
    
    return element;
  }

  // Initialize
  function initialize() {
    if (isInitialized) return;
    
    meetingId = extractMeetingId();
    if (!meetingId) {
      console.log('[GMR Content] No meeting ID found in URL');
      return;
    }
    
    console.log('[GMR Content] Meeting detected:', meetingId);
    isInitialized = true;
    
    // Notify background
    chrome.runtime.sendMessage({
      type: 'MEETING_DETECTED',
      meetingId: meetingId
    });
    
    // Setup UI Panel
    createPanelUI();
    loadAndListenToStorage();
    startTimerLoop();

    // Setup participant tracking observers
    setupParticipantTracking();
    
    // Setup transcript capture observers
    setupTranscriptCapture();
    
    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener(handleMessage);
    
    // Monitor URL changes (for SPA navigation)
    setupUrlMonitoring();

    // Start periodic tasks loop: reconcile participants, auto-captions, detect meeting end.
    if (periodicIntervalId) clearInterval(periodicIntervalId);
    periodicIntervalId = setInterval(() => {
      autoEnableCaptions();
      reconcileParticipants();
      checkMeetingEnded();
      updateReminders();
    }, RECONCILE_INTERVAL_MS);

    // Run one reconcile pass immediately so we don't wait for the first interval tick.
    reconcileParticipants();
  }

  // Extract meeting ID from URL
  function extractMeetingId() {
    const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : null;
  }

  // Setup URL change monitoring
  function setupUrlMonitoring() {
    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        const newMeetingId = extractMeetingId();
        if (newMeetingId && newMeetingId !== meetingId) {
          meetingId = newMeetingId;
          chrome.runtime.sendMessage({
            type: 'MEETING_DETECTED',
            meetingId: meetingId
          });
        }
      }
    }).observe(document, { subtree: true, childList: true });
  }

  // ==================== INJECTED UI PANEL ====================
  function injectStyles() {
    const styleId = 'gmr-styles';
    if (document.getElementById(styleId)) return;
    
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #gmr-meet-panel {
        position: fixed;
        top: 75px;
        right: 20px;
        width: 280px;
        background: rgba(28, 28, 30, 0.85);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 14px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        padding: 14px;
        gap: 12px;
        user-select: none;
      }
      .gmr-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 8px;
      }
      .gmr-title {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.5px;
        color: #fff;
        margin: 0;
      }
      .gmr-minimize-btn {
        background: transparent;
        border: none;
        color: #aaa;
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .gmr-minimize-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }
      .gmr-status-container {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
      }
      .gmr-status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #ff3b30;
      }
      .gmr-status-dot.connected {
        background: #34c759;
        box-shadow: 0 0 8px #34c759;
      }
      .gmr-status-dot.disconnected {
        background: #ff3b30;
        box-shadow: 0 0 8px #ff3b30;
      }
      .gmr-timer-display {
        font-size: 26px;
        font-family: monospace;
        text-align: center;
        font-weight: bold;
        letter-spacing: 1px;
        margin: 4px 0;
        color: #0a84ff;
      }
      .gmr-controls-row {
        display: flex;
        gap: 8px;
      }
      .gmr-btn {
        flex: 1;
        border: none;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s ease;
        text-align: center;
      }
      .gmr-btn:hover {
        opacity: 0.9;
      }
      .gmr-btn-primary {
        background: #007aff;
        color: #fff;
      }
      .gmr-btn-danger {
        background: #ff3b30;
        color: #fff;
      }
      .gmr-btn-warning {
        background: #ff9500;
        color: #fff;
      }
      .gmr-stats-grid {
        display: flex;
        justify-content: space-between;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        padding: 8px;
        gap: 8px;
      }
      .gmr-stat-item {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        font-size: 10px;
        color: #aaa;
      }
      .gmr-stat-value {
        font-size: 14px;
        font-weight: bold;
        color: #fff;
        margin-top: 2px;
      }
      .gmr-preview-container {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .gmr-preview-title {
        font-size: 11px;
        font-weight: 600;
        color: #888;
      }
      .gmr-preview-list {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 8px;
        padding: 8px;
        min-height: 50px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .gmr-transcript-item {
        font-size: 11px;
        line-height: 1.3;
      }
      .gmr-transcript-speaker {
        font-weight: bold;
        color: #0a84ff;
      }
      .gmr-transcript-text {
        color: #ddd;
      }
      .gmr-transcript-empty {
        font-size: 10px;
        color: #666;
        text-align: center;
        padding: 12px 0;
      }
      #gmr-expand-trigger {
        position: fixed;
        top: 75px;
        right: 20px;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        background: rgba(28, 28, 30, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
        color: #fff;
        cursor: pointer;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        transition: transform 0.2s ease;
      }
      #gmr-expand-trigger:hover {
        transform: scale(1.05);
      }
    `;
    document.head.appendChild(style);
  }

  function createPanelUI() {
    if (document.getElementById('gmr-meet-panel')) return;
    
    injectStyles();
    
    // Create floating trigger button
    const trigger = createDOMElement('button', {
      id: 'gmr-expand-trigger',
      style: 'display: none;',
      onClick: () => {
        const panel = document.getElementById('gmr-meet-panel');
        if (panel) panel.style.display = 'flex';
        trigger.style.display = 'none';
        chrome.storage.local.set({ panelMinimized: false });
      }
    }, ['⏺']);
    
    // Create main panel
    const panel = createDOMElement('div', {
      id: 'gmr-meet-panel'
    }, [
      // Header row
      createDOMElement('div', { className: 'gmr-header-row' }, [
        createDOMElement('h3', { className: 'gmr-title' }, ['GMeet Recorder']),
        createDOMElement('div', { className: 'gmr-status-container' }, [
          createDOMElement('div', { id: 'gmr-status-dot', className: 'gmr-status-dot disconnected' }),
          createDOMElement('span', { id: 'gmr-status-text' }, ['Disconnected'])
        ]),
        createDOMElement('button', {
          className: 'gmr-minimize-btn',
          onClick: () => {
            panel.style.display = 'none';
            trigger.style.display = 'flex';
            chrome.storage.local.set({ panelMinimized: true });
          }
        }, ['_'])
      ]),
      
      // Timer display
      createDOMElement('div', { id: 'gmr-timer', className: 'gmr-timer-display' }, ['00:00:00']),
      
      // Controls row
      createDOMElement('div', { className: 'gmr-controls-row' }, [
        createDOMElement('button', {
          id: 'gmr-btn-record',
          className: 'gmr-btn gmr-btn-primary',
          onClick: handleRecordButtonClick
        }, ['Start Recording']),
        createDOMElement('button', {
          id: 'gmr-btn-pause',
          className: 'gmr-btn gmr-btn-warning',
          style: 'display: none;',
          onClick: handlePauseButtonClick
        }, ['Pause'])
      ]),
      
      // Download row
      createDOMElement('div', { id: 'gmr-download-row', style: 'display: none;' }, [
        createDOMElement('a', {
          id: 'gmr-btn-download',
          className: 'gmr-btn gmr-btn-primary',
          style: 'display: block; text-decoration: none; background: #34c759; color: #fff; box-shadow: 0 0 8px rgba(52, 199, 89, 0.4);',
          target: '_blank'
        }, ['📥 Download Recording'])
      ]),
      
      // Stats grid
      createDOMElement('div', { className: 'gmr-stats-grid' }, [
        createDOMElement('div', { className: 'gmr-stat-item' }, [
          'ACTIVE',
          createDOMElement('span', { id: 'gmr-stat-participants', className: 'gmr-stat-value' }, ['0'])
        ]),
        createDOMElement('div', { className: 'gmr-stat-item' }, [
          'TRANSCRIPTS',
          createDOMElement('span', { id: 'gmr-stat-transcripts', className: 'gmr-stat-value' }, ['0'])
        ])
      ]),
      
      // Live Transcript
      createDOMElement('div', { className: 'gmr-preview-container' }, [
        createDOMElement('span', { className: 'gmr-preview-title' }, ['Live Transcript']),
        createDOMElement('div', { id: 'gmr-transcript-preview', className: 'gmr-preview-list' }, [
          createDOMElement('div', { className: 'gmr-transcript-empty' }, ['No transcripts captured yet.'])
        ])
      ])
    ]);
    
    document.body.appendChild(trigger);
    document.body.appendChild(panel);
    
    // Load initial minimized state
    chrome.storage.local.get(['panelMinimized'], (data) => {
      if (data.panelMinimized) {
        panel.style.display = 'none';
        trigger.style.display = 'flex';
      } else {
        panel.style.display = 'flex';
        trigger.style.display = 'none';
      }
    });
  }

  function handleRecordButtonClick() {
    chrome.storage.local.get(['isRecording'], (data) => {
      if (data.isRecording) return; // recording is stopped automatically when the meeting ends

      // #1: refuse to start (and never create a server session) until actually inside the call.
      if (!isInCall()) {
        showToast('You are not inside the meeting yet. Please join the meeting and then click Record.', 'warn');
        return;
      }
      autoEnableCaptions();
      chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (resp) => {
        if (resp && resp.error === 'NOT_IN_MEETING') {
          showToast(resp.message, 'warn');
        } else if (resp && resp.error) {
          showToast(resp.message || resp.error, 'error');
        }
      });
    });
  }

  function handlePauseButtonClick() {
    chrome.storage.local.get(['isRecording', 'isPaused'], (data) => {
      if (!data.isRecording) return;
      
      if (data.isPaused) {
        chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
      } else {
        chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
      }
    });
  }

  function loadAndListenToStorage() {
    chrome.storage.local.get(null, (data) => {
      gmrState = { ...gmrState, ...data };
      updatePanelUI(gmrState);
    });
    
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local') {
        const updated = {};
        for (const [key, value] of Object.entries(changes)) {
          updated[key] = value.newValue;
        }
        gmrState = { ...gmrState, ...updated };
        updatePanelUI(gmrState);
      }
    });
  }

  function updatePanelUI(state) {
    const panel = document.getElementById('gmr-meet-panel');
    if (!panel) return;
    
    // Connection status
    const dot = document.getElementById('gmr-status-dot');
    const text = document.getElementById('gmr-status-text');
    if (dot && text) {
      if (state.wsConnected) {
        dot.className = 'gmr-status-dot connected';
        text.textContent = 'Connected';
      } else {
        dot.className = 'gmr-status-dot disconnected';
        text.textContent = 'Disconnected';
      }
    }
    
    // Recording controls.
    // #2: No Stop button — recording stops automatically when the meeting ends. While recording,
    // we only show Pause/Resume; the Start button is hidden.
    const recordBtn = document.getElementById('gmr-btn-record');
    const pauseBtn = document.getElementById('gmr-btn-pause');

    if (recordBtn && pauseBtn) {
      if (state.isRecording) {
        recordBtn.style.display = 'none';
        pauseBtn.style.display = 'block';
        pauseBtn.textContent = state.isPaused ? 'Resume' : 'Pause';
        pauseBtn.className = state.isPaused ? 'gmr-btn gmr-btn-primary' : 'gmr-btn gmr-btn-warning';
      } else {
        recordBtn.style.display = 'block';
        recordBtn.textContent = 'Start Recording';
        recordBtn.className = 'gmr-btn gmr-btn-primary';
        pauseBtn.style.display = 'none';
      }
    }
    
    // Download controls
    const downloadRow = document.getElementById('gmr-download-row');
    const downloadBtn = document.getElementById('gmr-btn-download');
    if (downloadRow && downloadBtn) {
      if (!state.isRecording && state.lastDownloadUrl) {
        downloadRow.style.display = 'block';
        downloadBtn.setAttribute('href', state.lastDownloadUrl);
        downloadBtn.setAttribute('download', state.lastFilename || 'recording.webm');
      } else {
        downloadRow.style.display = 'none';
      }
    }
    
    // Stats
    const pCount = document.getElementById('gmr-stat-participants');
    if (pCount) {
      pCount.textContent = state.activeParticipants || 0;
    }
    
    const tCount = document.getElementById('gmr-stat-transcripts');
    if (tCount) {
      tCount.textContent = state.transcriptLines ? state.transcriptLines.length : 0;
    }
    
    // Transcript preview
    const preview = document.getElementById('gmr-transcript-preview');
    if (preview && state.transcriptLines) {
      preview.replaceChildren();
      
      const lastLines = state.transcriptLines.slice(-3);
      if (lastLines.length === 0) {
        const empty = createDOMElement('div', { className: 'gmr-transcript-empty' }, ['No transcripts captured yet.']);
        preview.appendChild(empty);
      } else {
        lastLines.forEach(line => {
          const item = createDOMElement('div', { className: 'gmr-transcript-item' }, [
            createDOMElement('span', { className: 'gmr-transcript-speaker' }, [`${line.speaker}: `]),
            createDOMElement('span', { className: 'gmr-transcript-text' }, [line.text])
          ]);
          preview.appendChild(item);
        });
      }
    }
  }

  // Locate the closed-captions TOGGLE button (not the settings tab / menu item).
  function findCaptionButton() {
    const ccButtons = document.querySelectorAll('button[aria-label*="caption" i], button[data-tooltip*="caption" i], button[aria-label*="cc" i], button[data-tooltip*="cc" i]');
    for (const btn of ccButtons) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
      if (label === 'captions' || tooltip === 'captions' || label.includes('settings') || tooltip.includes('settings') || btn.getAttribute('role') === 'tab') {
        continue;
      }
      return btn;
    }
    return null;
  }

  function isCaptionOn(btn) {
    if (!btn) return false;
    if (btn.getAttribute('aria-pressed') === 'true') return true;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    return label.includes('turn off') || label.includes('desactivar') || label.includes('stop captions');
  }

  // Ensure captions stay ON. If the user turns them OFF after we've enabled them, re-enable and
  // warn that transcription needs captions. Only runs while inside the call.
  function autoEnableCaptions() {
    if (!isInCall()) return false;

    const btn = findCaptionButton();
    if (!btn) return false;

    if (isCaptionOn(btn)) {
      captionsArmed = true;
      return true;
    }

    // Captions are OFF.
    const now = Date.now();
    if (captionsArmed && now > captionWarnCooldownUntil) {
      // We had captions on and they're off now -> the user turned them off.
      showToast('Live captions are required for transcription. We\'ve turned them back on — the transcript won\'t be captured if you turn captions off again.', 'warn');
    }
    console.log('[GMR Content] Enabling closed captions...');
    btn.click();
    captionsArmed = true;
    captionWarnCooldownUntil = now + 4000; // suppress duplicate warnings while the UI settles
    return true;
  }

  // ==================== MEETING-END DETECTION ====================
  function checkMeetingEnded() {
    if (gmrState.isRecording) {
      const leaveBtn = document.querySelector('[aria-label*="leave" i], [aria-label*="salir" i], [jsname="b3F6wd"]');
      
      const hasReturnHome = Array.from(document.querySelectorAll('button, a')).some(el => {
        const text = (el.textContent || '').toLowerCase();
        return text.includes('return to home') || text.includes('volver a la pantalla');
      });
      
      if (hasReturnHome || !leaveBtn) {
        console.log('[GMR Content] Meeting end detected. Stopping recording...');
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      }
    }
  }

  // ==================== PARTICIPANT TRACKING (snapshot-diff engine) ====================
  //
  // How it works:
  //  1. snapshotParticipants() reads the CURRENT set of participants straight from the DOM,
  //     keyed by a stable identity (data-participant-id, falling back to a normalized name).
  //  2. reconcileParticipants() diffs that snapshot against participantCache:
  //       - id present in snapshot but not cache  -> JOINED
  //       - id in cache but missing from snapshot for >= LEAVE_GRACE_MS -> LEFT
  //  3. Active count is ALWAYS derived from the cache (entries with leftAt === null), so it can
  //     never drift the way an increment/decrement counter does.
  //  4. Everything is gated on isInCall() so nothing is reported from the lobby / home screen.
  function setupParticipantTracking() {
    console.log('[GMR Content] Setting up participant tracking (snapshot-diff engine)...');

    // A mutation anywhere in the call surface triggers a (debounced) reconcile so joins/leaves
    // are caught quickly, in addition to the steady RECONCILE_INTERVAL_MS heartbeat.
    participantObserver = new MutationObserver(() => scheduleReconcile());
    participantObserver.observe(document.body, { childList: true, subtree: true });
  }

  function scheduleReconcile() {
    if (reconcileDebounce) return;
    reconcileDebounce = setTimeout(() => {
      reconcileDebounce = null;
      reconcileParticipants();
    }, 400);
  }

  // Are we actually inside the call (not the green room / lobby / "you left" screen)?
  function isInCall() {
    // The "Leave call" / hang-up control only exists once you've joined.
    const leaveBtn = document.querySelector(
      'button[aria-label*="leave call" i], button[aria-label*="leave the call" i], ' +
      'button[aria-label*="end call" i], button[aria-label*="salir de la llamada" i]'
    );
    if (leaveBtn) return true;
    // Fallback: the in-call toolbar exposes mic/camera toggles.
    const micBtn = document.querySelector(
      'button[aria-label*="turn off microphone" i], button[aria-label*="turn on microphone" i], ' +
      'button[aria-label*="turn off camera" i], button[aria-label*="turn on camera" i]'
    );
    return !!micBtn;
  }

  // Build a Map<normalizedName, displayName> of everyone currently in the call.
  //
  // Identity is the PERSON'S NAME, not Meet's data-participant-id. Meet's ids look like
  // "spaces/<id>/devices/<n>" and the <n> churns on every rejoin / transient tile, which is what
  // inflated the count (4 instead of 2) and produced junk names like "devices". Keying on the name
  // collapses rejoins and duplicate tiles to one person and gives a correct unique total.
  function snapshotParticipants() {
    const found = new Map(); // normName -> displayName
    const addName = (raw) => {
      const disp = cleanName(raw);
      if (!disp || !isPlausibleName(disp)) return;
      const norm = disp.toLowerCase();
      if (!found.has(norm)) found.set(norm, disp);
    };

    // PRIMARY: the People panel lists each participant exactly once, with their real name.
    const panelNames = readPeoplePanel();
    if (panelNames && panelNames.length) {
      panelNames.forEach(addName);
    } else {
      // FALLBACK (panel not open/readable): derive names from video tiles. Less reliable, so we
      // try hard to extract a real name and skip tiles we can't name confidently.
      document.querySelectorAll('[data-participant-id]').forEach(el => addName(extractNameFromContainer(el)));
    }

    // ALWAYS include the local user — data-self-name is authoritative.
    addName(getSelfName());

    return found;
  }

  function getSelfName() {
    const el = document.querySelector('[data-self-name]');
    return el ? cleanName(el.getAttribute('data-self-name')) : null;
  }

  // Locate the People / participants side panel container (where names are listed cleanly).
  function findPeoplePanelContainer() {
    const nodes = document.querySelectorAll(
      '[role="region"], [role="dialog"], [role="complementary"], [role="list"]'
    );
    for (const n of nodes) {
      const label = (n.getAttribute('aria-label') || '').toLowerCase();
      if (/people|participant|contributor/.test(label) && n.querySelector('[role="listitem"]')) {
        return n;
      }
    }
    return null;
  }

  // Open the People panel if it isn't already, so we can read authoritative names. Rate-limited so
  // we don't fight a user who deliberately closes it.
  function ensurePeoplePanelOpen() {
    if (findPeoplePanelContainer()) return;
    const now = Date.now();
    if (now - lastPanelOpenAttempt < 30000) return;
    lastPanelOpenAttempt = now;
    const btns = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (const b of btns) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (/add people|add others|add to/.test(l)) continue;       // not the "add" button
      if (/people|show everyone|participant|contributor/.test(l)) { b.click(); return; }
    }
  }

  // Read participant names from the People panel. Returns an array of display names, or null.
  function readPeoplePanel() {
    const container = findPeoplePanelContainer();
    if (!container) return null;
    const items = container.querySelectorAll('[role="listitem"]');
    if (!items.length) return null;
    const names = [];
    items.forEach(item => {
      const nm = extractPanelName(item);
      if (nm) names.push(nm);
    });
    return names.length ? names : null;
  }

  // Extract one participant's name from a People-panel row.
  function extractPanelName(item) {
    // The row's aria-label is usually the participant's name (e.g. "Jane Doe", "Jane Doe (You)").
    const label = cleanName(item.getAttribute('aria-label'));
    if (label && isPlausibleName(label)) return label;
    // Otherwise the most prominent text. In a panel row the name is the longest plain string;
    // status words ("Host", "Muted") are short and filtered out by isPlausibleName / UI_NOISE.
    const candidates = [];
    item.querySelectorAll('*').forEach(node => {
      if (node.children.length === 0) {
        const c = cleanName(node.textContent);
        if (c && isPlausibleName(c)) candidates.push(c);
      }
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.length - a.length); // prefer the full name
    return candidates[0];
  }

  // Fallback name extraction from a video tile (only used when the People panel is unavailable).
  function extractNameFromContainer(el) {
    if (!el) return null;

    // data-self-name is authoritative for the local user (may be on the tile or a descendant).
    let selfHost = (el.getAttribute && el.getAttribute('data-self-name')) ? el : null;
    if (!selfHost && el.querySelector) selfHost = el.querySelector('[data-self-name]');
    if (selfHost) {
      const selfName = cleanName(selfHost.getAttribute('data-self-name'));
      if (selfName && isPlausibleName(selfName)) return selfName;
    }

    const candidates = [];
    const pushCandidate = (t) => { const c = cleanName(t); if (c && isPlausibleName(c)) candidates.push(c); };
    if (el.querySelectorAll) {
      el.querySelectorAll('*').forEach(node => {
        if (node.children.length === 0) pushCandidate(node.textContent);
      });
    }
    if (candidates.length === 0) return null;
    // Prefer the longest plausible string — a real display name ("Poonthamil V") beats stray
    // short words. (The old "shortest" rule wrongly picked junk like "devices".)
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  // Normalize a raw name string ("John Doe (You)", "  Jane  ") into a stable display name.
  function cleanName(str) {
    if (!str) return null;
    let s = String(str).trim().replace(/\s+/g, ' ');
    s = s.replace(/\s*\((you|host|co-host|meeting host|presenting)\)\s*$/i, '').trim();
    s = s.replace(/['']s presentation$/i, '').trim();
    return s || null;
  }

  function isPlausibleName(str) {
    if (!str) return false;
    const s = String(str).trim();
    if (s.length < 2 || s.length > 60) return false;
    if (/^\d+$/.test(s)) return false;                 // pure numbers (counts, timers)
    if (/https?:|google|meet\.google/i.test(s)) return false;
    if (!/[a-zÀ-ɏЀ-ӿ一-鿿]/i.test(s)) return false; // must contain a letter
    if (UI_NOISE.has(s.toLowerCase())) return false;
    return true;
  }

  // Diff the live DOM against the cache and emit JOINED / LEFT deltas.
  function reconcileParticipants() {
    const inCall = isInCall();
    reportInMeeting(inCall);

    // Outside the call: clear the roster so the UI never shows phantom "Active 3" counts.
    if (!inCall) {
      if (participantCache.size > 0) {
        participantCache.clear();
        pushParticipantState(true);
      } else if (wasInCall) {
        pushParticipantState(true);
      }
      wasInCall = false;
      return;
    }
    wasInCall = true;

    // Make sure the People panel is available so we can read real names (rate-limited).
    ensurePeoplePanelOpen();

    const snapshot = snapshotParticipants();
    const now = Date.now();
    let changed = false;

    // Joins + refresh lastSeen for everyone currently present.
    for (const [id, name] of snapshot) {
      const existing = participantCache.get(id);
      if (!existing || existing.leftAt) {
        participantCache.set(id, {
          id, name: name || 'Guest', joinedAt: now, lastSeen: now, leftAt: null, missingSince: null
        });
        emitParticipantEvent('joined', name || 'Guest', id);
        changed = true;
      } else {
        existing.lastSeen = now;
        existing.missingSince = null;
        if ((!existing.name || existing.name === 'Guest') && name && name !== 'Guest') {
          existing.name = name;
        }
      }
    }

    // Leaves: in the cache, not left yet, but missing from the snapshot beyond the grace window.
    for (const p of participantCache.values()) {
      if (p.leftAt) continue;
      if (!snapshot.has(p.id)) {
        if (!p.missingSince) {
          p.missingSince = now;
        } else if (now - p.missingSince >= LEAVE_GRACE_MS) {
          p.leftAt = now;
          emitParticipantEvent('left', p.name, p.id);
          changed = true;
        }
      }
    }

    pushParticipantState(changed);
  }

  function getActiveCount() {
    let n = 0;
    for (const p of participantCache.values()) if (!p.leftAt) n++;
    return n;
  }

  function getTotalCount() {
    return participantCache.size; // distinct identities seen this session
  }

  // Send a single join/left delta to the background (which persists it and streams it to the server).
  function emitParticipantEvent(event, name, id) {
    const timestamp = new Date().toISOString();
    console.log(`[GMR Content] Participant ${event}: ${name} (${id}) | active=${getActiveCount()}`);

    chrome.runtime.sendMessage({
      type: 'PARTICIPANT_EVENT',
      event,
      name: name || 'Guest',
      participantId: id,
      timestamp,
      meetingId,
      activeCount: getActiveCount(),
      totalCount: getTotalCount()
    });
  }

  // Keep the background/UI counts in sync even when no individual delta fired (e.g. on leave-call reset).
  function pushParticipantState(force) {
    const active = getActiveCount();
    const total = getTotalCount();
    if (!force && active === lastSentActiveCount && total === lastSentTotalCount) return;
    lastSentActiveCount = active;
    lastSentTotalCount = total;
    chrome.runtime.sendMessage({
      type: 'PARTICIPANT_STATE',
      activeCount: active,
      totalCount: total,
      meetingId
    });
  }

  // Re-emit the full current roster as 'joined' events. Called when a recording starts so the
  // server-side session captures everyone who was already in the call.
  function flushParticipantRoster() {
    for (const p of participantCache.values()) {
      if (!p.leftAt) emitParticipantEvent('joined', p.name, p.id);
    }
    pushParticipantState(true);
  }

  // Persist whether the user is actually inside the call. Background reads this to refuse
  // recording (and creating a server session) until the user has truly joined.
  function reportInMeeting(inCall) {
    if (inCall === lastReportedInMeeting) return;
    lastReportedInMeeting = inCall;
    chrome.storage.local.set({ inMeeting: inCall });
  }

  // ==================== TOAST ====================
  function showToast(message, variant) {
    const existing = document.getElementById('gmr-toast');
    if (existing) existing.remove();

    if (!document.getElementById('gmr-toast-styles')) {
      const st = document.createElement('style');
      st.id = 'gmr-toast-styles';
      st.textContent = `
        #gmr-toast {
          position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
          z-index: 1000000; max-width: 420px;
          background: rgba(28,28,30,0.95); color: #fff;
          border: 1px solid rgba(255,255,255,0.12); border-left: 4px solid #0a84ff;
          border-radius: 12px; padding: 12px 16px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px; line-height: 1.4; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
          animation: gmr-toast-in 0.25s ease;
        }
        #gmr-toast.warn { border-left-color: #ff9500; }
        #gmr-toast.error { border-left-color: #ff3b30; }
        @keyframes gmr-toast-in { from { opacity: 0; transform: translate(-50%, 12px); } to { opacity: 1; transform: translate(-50%, 0); } }
      `;
      document.head.appendChild(st);
    }

    const toast = createDOMElement('div', { id: 'gmr-toast', className: variant || '' }, [message]);
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 6000);
  }

  // ==================== PERSISTENT REMINDERS ====================
  // Unlike the transient toast, a reminder stays on screen the WHOLE time an actionable condition
  // is true (e.g. you're in the meeting but haven't started recording, or your mic isn't enabled).
  // Dismissing it just snoozes it — it re-appears after a cooldown so a forgotten step keeps nagging.
  const reminderSnoozedUntil = {}; // id -> timestamp until which it stays hidden
  let currentReminderId = null;

  function getActiveReminder() {
    const now = Date.now();
    const inCall = isInCall();
    const rec = !!gmrState.isRecording;

    // Highest priority first.
    const candidates = [
      {
        id: 'start-recording',
        active: inCall && !rec,
        message: 'You\'re in the meeting but recording hasn\'t started.',
        actionLabel: 'Start Recording',
        action: handleRecordButtonClick,
        snoozeMs: 30000
      },
      {
        id: 'ws-disconnected',
        active: rec && !gmrState.wsConnected,
        message: 'Lost connection to the recording server — reconnecting…',
        snoozeMs: 15000
      },
      {
        id: 'enable-mic',
        active: rec && !gmrState.micEnabled,
        message: 'Your own voice isn\'t being recorded. Click the extension icon in the toolbar, then "Enable my mic".',
        snoozeMs: 60000
      }
    ];

    for (const c of candidates) {
      if (!c.active) continue;
      if (now < (reminderSnoozedUntil[c.id] || 0)) continue; // snoozed
      return c;
    }
    return null;
  }

  function updateReminders() {
    const reminder = getActiveReminder();
    const banner = document.getElementById('gmr-reminder');

    if (!reminder) {
      if (banner) banner.remove();
      currentReminderId = null;
      return;
    }
    if (banner && currentReminderId === reminder.id) return; // already showing it

    if (banner) banner.remove();
    currentReminderId = reminder.id;
    renderReminderBanner(reminder);
  }

  function injectReminderStyles() {
    if (document.getElementById('gmr-reminder-styles')) return;
    const st = document.createElement('style');
    st.id = 'gmr-reminder-styles';
    st.textContent = `
      #gmr-reminder {
        position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
        z-index: 1000001; display: flex; align-items: center; gap: 12px;
        max-width: 560px; padding: 10px 12px 10px 16px;
        background: rgba(40, 28, 8, 0.96); color: #fff;
        border: 1px solid rgba(255, 159, 10, 0.5); border-radius: 12px;
        box-shadow: 0 10px 34px rgba(0,0,0,0.55);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px;
        animation: gmr-reminder-in 0.25s ease;
      }
      @keyframes gmr-reminder-in { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }
      .gmr-reminder-icon { color: #ff9f0a; font-size: 14px; flex-shrink: 0; }
      .gmr-reminder-msg { flex: 1; line-height: 1.4; }
      .gmr-reminder-action {
        background: #ff9f0a; color: #1c1c1e; border: none; border-radius: 8px;
        padding: 7px 12px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap;
      }
      .gmr-reminder-action:hover { opacity: 0.9; }
      .gmr-reminder-dismiss {
        background: rgba(255,255,255,0.1); border: none; color: #fff; width: 26px; height: 26px;
        border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; flex-shrink: 0;
      }
      .gmr-reminder-dismiss:hover { background: rgba(255,255,255,0.2); }
    `;
    document.head.appendChild(st);
  }

  function renderReminderBanner(reminder) {
    injectReminderStyles();
    const children = [
      createDOMElement('span', { className: 'gmr-reminder-icon' }, ['⚠️']),
      createDOMElement('span', { className: 'gmr-reminder-msg' }, [reminder.message])
    ];
    if (reminder.actionLabel && reminder.action) {
      children.push(createDOMElement('button', {
        className: 'gmr-reminder-action',
        onClick: () => { reminder.action(); updateReminders(); }
      }, [reminder.actionLabel]));
    }
    children.push(createDOMElement('button', {
      className: 'gmr-reminder-dismiss',
      title: 'Dismiss (will remind again later)',
      onClick: () => {
        reminderSnoozedUntil[reminder.id] = Date.now() + reminder.snoozeMs;
        const b = document.getElementById('gmr-reminder');
        if (b) b.remove();
        currentReminderId = null;
      }
    }, ['×']));

    document.body.appendChild(createDOMElement('div', { id: 'gmr-reminder' }, children));
  }

  // ==================== TRANSCRIPT CAPTURE ====================
  //
  // Meet renders live captions as blocks of [avatar <img>][speaker name][spoken text]. We anchor
  // on the avatar <img> (a stable structural element) instead of rotating CSS classes to pull out
  // the speaker + text. Captions grow in-place as a person talks, so we key the latest text per
  // speaker and only emit a line once it has STABILIZED (no change for ~1.2s) — that yields one
  // clean line per utterance in near real time, instead of flooding the server with partials.

  // speaker -> { text, lastChange, emittedText }
  const captionState = new Map();
  let captionStabilizeTimer = null;
  let seenTranscriptKeys = new Set();

  function setupTranscriptCapture() {
    console.log('[GMR Content] Setting up transcript capture...');

    const tryAttach = () => {
      const container = findCaptionContainer();
      if (container && container !== transcriptContainer) {
        transcriptContainer = container;
        console.log('[GMR Content] Caption container attached');
        observeTranscript(container);
      }
      return !!container;
    };

    // Keep (re)attaching: the caption container is created/destroyed as captions toggle.
    if (!tryAttach()) {
      const retry = setInterval(() => tryAttach(), 2000);
      setTimeout(() => clearInterval(retry), 120000);
    }

    // Stabilization loop: finalize + emit caption lines that have stopped changing.
    if (captionStabilizeTimer) clearInterval(captionStabilizeTimer);
    captionStabilizeTimer = setInterval(flushStableCaptions, 700);
  }

  function findCaptionContainer() {
    // 1) Accessibility / attribute hooks (most stable).
    const byAria = document.querySelector('[aria-label*="caption" i][role="region"], [role="region"][aria-label*="caption" i]');
    if (byAria) return byAria;

    // 2) Known (rotating) class/jsname fallbacks.
    const known = document.querySelector('.a4cQT, .iOzk7, [jsname="dsyhDe"], .V6Yesc');
    if (known) return known;

    // 3) Structural heuristic: the region that holds caption blocks (avatar <img> next to text).
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      const block = img.closest('div');
      if (block && (block.textContent || '').trim().length > 0) {
        const region = block.parentElement && block.parentElement.parentElement;
        if (region && region.querySelectorAll('img').length >= 1 &&
            (region.textContent || '').trim().length > 2) {
          // Heuristic gate: avoid matching the participant grid (which also has avatars).
          if (/caption|cc/i.test(region.getAttribute('aria-label') || '')) return region;
        }
      }
    }
    return null;
  }

  function observeTranscript(container) {
    if (transcriptObserver) transcriptObserver.disconnect();
    scanCaptions(container);

    let debounce = null;
    transcriptObserver = new MutationObserver(() => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; scanCaptions(container); }, 150);
    });
    transcriptObserver.observe(container, { childList: true, subtree: true, characterData: true });
  }

  // Read every caption block currently in the container and update the per-speaker latest text.
  function scanCaptions(container) {
    if (!container) return;
    const now = Date.now();
    const blocks = [];

    // Primary: anchor on avatar <img>; the speaker name sits in the avatar's wrapper and the
    // spoken text is the rest of the block.
    const imgs = container.querySelectorAll('img');
    imgs.forEach(img => {
      const header = img.parentElement;
      if (!header) return;
      const block = header.parentElement || header;
      const speaker = cleanName(header.textContent) || 'Unknown';
      let text = (block.textContent || '').trim();
      if (speaker && speaker !== 'Unknown' && text.startsWith(speaker)) {
        text = text.slice(speaker.length);
      }
      text = text.replace(/^[\s:–-]+/, '').trim();
      if (text) blocks.push({ speaker, text });
    });

    // Fallback: no avatars (caption-only layout) — split the visible text into "Name\n text" rows.
    if (blocks.length === 0) {
      const raw = (container.innerText || container.textContent || '').trim();
      if (raw) blocks.push({ speaker: 'Unknown', text: raw });
    }

    for (const b of blocks) {
      const st = captionState.get(b.speaker) || { text: '', lastChange: 0, emittedText: '' };
      if (b.text !== st.text) { st.text = b.text; st.lastChange = now; }
      captionState.set(b.speaker, st);
    }
  }

  // Emit caption lines that have been stable for >= 1.2s (utterance finished).
  function flushStableCaptions() {
    const now = Date.now();
    for (const [speaker, st] of captionState) {
      if (st.text && st.text !== st.emittedText && (now - st.lastChange) >= 1200) {
        st.emittedText = st.text;
        emitTranscriptLine(speaker, st.text);
      }
    }
    // Bound memory.
    if (captionState.size > 50) {
      const entries = Array.from(captionState.entries()).slice(-25);
      captionState.clear();
      entries.forEach(([k, v]) => captionState.set(k, v));
    }
  }

  function emitTranscriptLine(speaker, text) {
    if (!text || text.length < 2) return;
    const key = `${speaker}::${text}`;
    if (seenTranscriptKeys.has(key)) return;
    seenTranscriptKeys.add(key);
    if (seenTranscriptKeys.size > 1000) {
      seenTranscriptKeys = new Set(Array.from(seenTranscriptKeys).slice(-500));
    }

    console.log(`[GMR Content] Transcript: [${speaker}] ${text}`);
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_LINE',
      speaker: speaker || 'Unknown',
      text,
      timestamp: new Date().toISOString(),
      meetingId
    });
  }

  // ==================== AUDIO WARNING BANNER ====================
  function showAudioWarning() {
    if (warningBanner) return;
    
    console.log('[GMR Content] Showing audio warning banner');
    
    const dismissBtn = createDOMElement('button', {
      className: 'gmr-warning-dismiss',
      title: 'Dismiss',
      onClick: dismissAudioWarning
    }, ['×']);

    warningBanner = createDOMElement('div', {
      id: 'gmr-audio-warning'
    }, [
      createDOMElement('div', { className: 'gmr-warning-inner' }, [
        createDOMElement('span', { className: 'gmr-warning-icon' }, ['⚠️']),
        createDOMElement('span', { className: 'gmr-warning-text' }, [
          'Your meeting audio will not be recorded unless you turn on the screen share tab audio button.'
        ]),
        dismissBtn
      ])
    ]);
    
    const style = document.createElement('style');
    style.textContent = `
      #gmr-audio-warning {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 999999;
        background: rgba(255, 107, 138, 0.15);
        backdrop-filter: blur(40px) saturate(150%);
        -webkit-backdrop-filter: blur(40px) saturate(150%);
        border-bottom: 1px solid rgba(255, 107, 138, 0.4);
        padding: 12px 20px;
        animation: gmr-warning-slide-down 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      
      @keyframes gmr-warning-slide-down {
        from { transform: translateY(-100%); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      
      @keyframes gmr-warning-slide-up {
        from { transform: translateY(0); opacity: 1; }
        to { transform: translateY(-100%); opacity: 0; }
      }
      
      .gmr-warning-inner {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        max-width: 1200px;
        margin: 0 auto;
      }
      
      .gmr-warning-icon { font-size: 16px; flex-shrink: 0; }
      
      .gmr-warning-text {
        color: #fff;
        font-family: 'Archivo', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
        font-weight: 500;
        text-align: center;
        text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      }
      
      .gmr-warning-dismiss {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #fff;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: all 0.2s ease;
      }
      
      .gmr-warning-dismiss:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.3);
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(warningBanner);
    
    setTimeout(() => dismissAudioWarning(), 30000);
  }

  function dismissAudioWarning() {
    if (!warningBanner) return;
    
    warningBanner.style.animation = 'gmr-warning-slide-up 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards';
    
    setTimeout(() => {
      if (warningBanner && warningBanner.parentNode) {
        warningBanner.parentNode.removeChild(warningBanner);
      }
      warningBanner = null;
    }, 300);
    
    chrome.runtime.sendMessage({ type: 'AUDIO_WARNING_DISMISSED' });
  }

  // ==================== TIMER LOOP ====================
  function startTimerLoop() {
    if (timerIntervalId) clearInterval(timerIntervalId);
    
    timerIntervalId = setInterval(() => {
      const timerEl = document.getElementById('gmr-timer');
      if (!timerEl) return;
      
      if (gmrState.isRecording && gmrState.recordingStartTime) {
        if (gmrState.isPaused) {
          return;
        }
        const elapsed = Date.now() - gmrState.recordingStartTime;
        timerEl.textContent = formatDuration(elapsed);
      } else {
        timerEl.textContent = '00:00:00';
      }
    }, 1000);
  }

  function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // ==================== MESSAGE HANDLER ====================
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'SHOW_AUDIO_WARNING':
        showAudioWarning();
        sendResponse({ success: true });
        break;
      case 'DISMISS_AUDIO_WARNING':
        dismissAudioWarning();
        sendResponse({ success: true });
        break;
      case 'SHOW_FLOATING_CONTROLS':
        sendResponse({ success: true });
        break;
      case 'HIDE_FLOATING_CONTROLS':
        sendResponse({ success: true });
        break;
      case 'FLUSH_PARTICIPANTS':
        // Recording just started — re-emit the current roster so the server captures
        // everyone who was already in the call before the WebSocket existed.
        flushParticipantRoster();
        sendResponse({ success: true });
        break;
      default:
        break;
    }
  }

  // ==================== INITIALIZATION ====================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  setTimeout(initialize, 3000);

})();
