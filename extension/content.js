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
  let lastReportedMicMuted = null;   // last Meet mic-mute state pushed to the recorder
  let micMuteObserver = null;        // watches the mic button for instant mute/unmute reaction
  let micMuteDebounce = null;
  let captionsArmed = false;          // true once we've successfully enabled captions at least once
  let captionWarnCooldownUntil = 0;   // suppress duplicate "captions required" warnings
  let lastPanelOpenAttempt = 0;       // rate-limit auto-opening the People panel

  // ===== Domain binding / scheduled-class awareness =====
  // Populated from the recorder server via the background worker: whether this meeting is scheduled
  // in the ERP (bound), whether the user is internal (@allowed-domain), and whether recording an
  // unbound meeting requires the external access key.
  let meetingBinding = null;          // { bound, internal, requiresKey, autoRecord, meeting:{...} }
  let hasAccessKey = false;           // set once the user has entered the external key this session
  let autoRecordAttempted = false;    // one-shot: don't spam auto-start attempts

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

    // Ask the recorder server whether this meeting is domain-bound / scheduled.
    doScheduleLookup();

    // Setup UI Panel
    createPanelUI();
    loadAndListenToStorage();
    startTimerLoop();

    // Setup participant tracking observers
    setupParticipantTracking();
    
    // Setup transcript capture observers
    setupTranscriptCapture();

    // Setup near-instant mic mute/unmute following (privacy).
    setupMicMuteObserver();

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
      maybeAutoRecord();
      updateReminders();
      syncMicMuteState();
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
          meetingBinding = null;
          autoRecordAttempted = false;
          chrome.runtime.sendMessage({
            type: 'MEETING_DETECTED',
            meetingId: meetingId
          });
          doScheduleLookup();
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

      // External user on an unbound meeting: require the access key before recording.
      if (meetingBinding && meetingBinding.requiresKey && !hasAccessKey) {
        showKeyPrompt('This meeting is not bound to your organization. Enter the access key to record.');
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

  // Ask the background worker (chrome-extension origin, not subject to the Meet page's
  // mixed-content policy) whether this meeting is domain-bound / scheduled.
  function doScheduleLookup() {
    try {
      chrome.runtime.sendMessage({ type: 'SCHEDULE_LOOKUP', meetingId }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.binding) {
          meetingBinding = resp.binding;
          console.log('[GMR Content] Meeting binding:', meetingBinding);
          updateReminders();
        }
      });
    } catch (e) { /* ignore */ }
  }

  // ==================== EXTERNAL ACCESS KEY PROMPT ====================
  // Shown when an external user (email not in the allowed domain) tries to record a meeting that
  // isn't registered in the ERP. On submit we persist the key and (re)start recording.
  function showKeyPrompt(message) {
    const existing = document.getElementById('gmr-key-overlay');
    if (existing) existing.remove();

    if (!document.getElementById('gmr-key-styles')) {
      const st = document.createElement('style');
      st.id = 'gmr-key-styles';
      st.textContent = `
        #gmr-key-overlay {
          position: fixed; inset: 0; z-index: 1000002; display: flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .gmr-key-card {
          width: 380px; max-width: 90vw; background: rgba(28,28,30,0.98); color: #fff;
          border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 22px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.6);
        }
        .gmr-key-title { font-size: 16px; font-weight: 700; margin: 0 0 8px; }
        .gmr-key-msg { font-size: 13px; color: #ccc; line-height: 1.45; margin: 0 0 14px; }
        .gmr-key-input {
          width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.06); color: #fff;
          font-size: 14px; margin-bottom: 14px;
        }
        .gmr-key-actions { display: flex; gap: 8px; }
        .gmr-key-btn { flex: 1; border: none; border-radius: 10px; padding: 10px; font-size: 13px; font-weight: 700; cursor: pointer; }
        .gmr-key-btn.primary { background: #0a84ff; color: #fff; }
        .gmr-key-btn.secondary { background: rgba(255,255,255,0.12); color: #fff; }
        .gmr-key-err { color: #ff6b6b; font-size: 12px; margin: -8px 0 10px; min-height: 14px; }
      `;
      document.head.appendChild(st);
    }

    const input = createDOMElement('input', {
      id: 'gmr-key-input', className: 'gmr-key-input', type: 'password',
      placeholder: 'Access key', autocomplete: 'off'
    });
    const err = createDOMElement('div', { id: 'gmr-key-err', className: 'gmr-key-err' }, ['']);

    const submit = () => {
      const val = (input.value || '').trim();
      if (!val) { err.textContent = 'Please enter the access key.'; return; }
      hasAccessKey = true;
      chrome.runtime.sendMessage({ type: 'SET_ACCESS_KEY', accessKey: val }, () => {
        const overlay = document.getElementById('gmr-key-overlay');
        if (overlay) overlay.remove();
        // Start recording now — this click is the user gesture the capture APIs require.
        autoEnableCaptions();
        chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (resp) => {
          if (resp && resp.error) showToast(resp.message || resp.error, 'error');
        });
      });
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    const card = createDOMElement('div', { className: 'gmr-key-card' }, [
      createDOMElement('h3', { className: 'gmr-key-title' }, ['Access key required']),
      createDOMElement('p', { className: 'gmr-key-msg' }, [message || 'Enter the access key to record this meeting.']),
      input,
      err,
      createDOMElement('div', { className: 'gmr-key-actions' }, [
        createDOMElement('button', { className: 'gmr-key-btn secondary', onClick: () => {
          const overlay = document.getElementById('gmr-key-overlay');
          if (overlay) overlay.remove();
        } }, ['Cancel']),
        createDOMElement('button', { className: 'gmr-key-btn primary', onClick: submit }, ['Unlock & Record'])
      ])
    ]);

    const overlay = createDOMElement('div', { id: 'gmr-key-overlay' }, [card]);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  }

  // Best-effort auto-record for a scheduled (bound) class: once the user is inside the call, attempt
  // to start recording. Capture APIs need a user gesture, so if the programmatic attempt is blocked
  // the persistent scheduled-class reminder banner remains for the faculty to click.
  function maybeAutoRecord() {
    if (autoRecordAttempted) return;
    if (!meetingBinding || !meetingBinding.bound || !meetingBinding.autoRecord) return;
    if (meetingBinding.requiresKey) return;      // external users must enter the key manually
    if (!isInCall() || gmrState.isRecording) return;
    autoRecordAttempted = true;
    autoEnableCaptions();
    showToast('Scheduled class detected — starting recording. If the share prompt doesn\'t appear, click “Start Recording”.', 'info');
    chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (resp) => {
      // If the browser blocked the automatic capture (no user gesture), the reminder banner nudges
      // the faculty to click Start. We don't surface an error toast for that expected case.
      if (resp && resp.error && resp.error !== 'NOT_IN_MEETING') {
        console.log('[GMR Content] Auto-record needs a click:', resp.message || resp.error);
      }
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

  // "Switch" — re-prompt for a tab/window/screen and swap it into the running recording.
  //
  // The picker itself must be opened from the offscreen document (it owns the MediaStream and the
  // MediaRecorder), so this only sends the request. Nothing about the current recording is torn down:
  // if the presenter cancels the picker, recording continues on the existing source untouched.
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
        // On a recording start/stop transition, force a fresh mic-mute push next tick so the mic
        // immediately reflects Meet's current state (e.g. faculty who start already muted).
        if ('isRecording' in changes) lastReportedMicMuted = null;
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
    // Don't grab focus with the toggle click while the user is typing (e.g. in the chat box) — it
    // would swallow their keystroke. Skip this tick; the periodic loop retries in ~2s once they're
    // done typing. Captions being off briefly only delays transcript re-capture, nothing more.
    if (isUserTyping()) return false;

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
        // When the HOST ends the call for everyone, Meet tears down instantly and nobody trips the
        // grace-based leave detection — so every participant would be stored as "still in meeting".
        // Emit a 'left' for everyone still present NOW so their leave time is captured.
        markAllParticipantsLeft();
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      }
    }
  }

  // ==================== MIC MUTE FOLLOWING ====================
  // Privacy: the faculty's own microphone (when "Enable my mic" is on) is captured by a browser
  // getUserMedia stream that is INDEPENDENT of Google Meet — so muting yourself in Meet would NOT
  // stop your voice from being recorded. To honour the expectation "muted in Meet => not recorded",
  // we read Meet's mic button state from the DOM and tell the recorder to gate the mic track: it is
  // silenced while Meet shows muted and resumes when unmuted. Only the local mic is affected; the
  // meeting (other-participant) audio is unchanged.
  //
  // Meet's toolbar mic toggle: aria-label reads "Turn off microphone" when you are LIVE (unmuted),
  // and "Turn on microphone" when you are MUTED. data-is-muted="true" is also present on newer DOM.
  function readMicMuted() {
    // Prefer the explicit muted-state attribute when present.
    const stateEl = document.querySelector('[data-is-muted]');
    if (stateEl) {
      const v = stateEl.getAttribute('data-is-muted');
      if (v === 'true') return true;
      if (v === 'false') return false;
    }
    // Fall back to the toolbar button's aria-label.
    const turnOn = document.querySelector(
      'button[aria-label*="turn on microphone" i], button[aria-label*="activar micrófono" i]'
    );
    if (turnOn) return true;   // "Turn ON microphone" is offered => currently muted
    const turnOff = document.querySelector(
      'button[aria-label*="turn off microphone" i], button[aria-label*="desactivar micrófono" i]'
    );
    if (turnOff) return false; // "Turn OFF microphone" is offered => currently live
    return null;               // unknown (button not found) — don't change state
  }

  function syncMicMuteState() {
    if (!gmrState.isRecording) return;   // nothing to gate unless we're recording
    const muted = readMicMuted();
    if (muted === null || muted === lastReportedMicMuted) return;
    lastReportedMicMuted = muted;
    console.log(`[GMR Content] Meet mic ${muted ? 'MUTED — pausing mic recording' : 'UNMUTED — resuming mic recording'}`);
    chrome.runtime.sendMessage({ type: 'MIC_MUTE_STATE', muted, meetingId });
  }

  // Near-instant mute following: watch the mic toolbar button for attribute flips (aria-label /
  // data-is-muted change the moment the user toggles) so we react immediately rather than waiting
  // for the next reconcile tick. The interval-based syncMicMuteState() remains as a safety backstop
  // (covers the button being re-rendered / not yet present at init).
  function setupMicMuteObserver() {
    if (micMuteObserver) micMuteObserver.disconnect();
    // Observe broadly but cheaply: only attribute changes to aria-label / data-is-muted anywhere in
    // the toolbar trigger our (debounced) check. Meet re-renders the button, so we watch document.
    micMuteObserver = new MutationObserver(() => {
      if (micMuteDebounce) return;
      micMuteDebounce = setTimeout(() => { micMuteDebounce = null; syncMicMuteState(); }, 60);
    });
    micMuteObserver.observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-is-muted']
    });
  }

  // Emit a 'left' event for every participant still in the call. Called on meeting-end (host ended
  // for all) and when recording stops, so leave times aren't lost to an abrupt page teardown.
  function markAllParticipantsLeft() {
    const now = Date.now();
    let changed = false;
    for (const p of participantCache.values()) {
      if (!p.leftAt) {
        p.leftAt = now;
        emitParticipantEvent('left', p.name, p.id);
        changed = true;
      }
    }
    if (changed) pushParticipantState(true);
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

    // Catch sudden tab / browser window closures or page teardowns instantly
    window.addEventListener('beforeunload', markAllParticipantsLeft, { capture: true });
    window.addEventListener('pagehide', markAllParticipantsLeft, { capture: true });
  }

  function scheduleReconcile() {
    if (reconcileDebounce) return;
    reconcileDebounce = setTimeout(() => {
      reconcileDebounce = null;
      reconcileParticipants();
    }, 400);
  }

  // Is the user actively typing into a Meet input (chat composer, search box, any editable field)?
  // Our periodic housekeeping clicks (auto-enabling captions, opening the People panel) move focus
  // to a button, which yanks focus out of the chat box and drops the keystroke the user was typing.
  // We suppress ONLY those focus-stealing clicks while typing — transcript capture (passive DOM
  // observation) and participant reconcile logic are unaffected, so nothing else is impacted.
  function isUserTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    if (el.isContentEditable) return true;                 // Meet's chat composer is contenteditable
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    return false;
  }

  // Are we actually inside the call (not the green room / lobby / "you left" screen)?
  function isInCall() {
    // The "Leave call" / hang-up control only exists once you've joined.
    const leaveBtn = document.querySelector(
      'button[aria-label*="leave call" i], button[aria-label*="leave the call" i], ' +
      'button[aria-label*="end call" i], button[aria-label*="salir de la llamada" i]'
    );
    if (leaveBtn) return true;

    // The green room ALSO renders mic/camera toggles, so the toggle fallback alone reported
    // "in call" before joining — which let pre-join UI (the effects panel) enter the roster with a
    // join timestamp earlier than the real participants'. Reject the lobby explicitly first.
    const joinBtn = document.querySelector(
      'button[aria-label*="join now" i], button[aria-label*="ask to join" i], ' +
      'button[aria-label*="switch here" i], button[aria-label*="return to home screen" i]'
    );
    if (joinBtn) return false;
    if (/\b(join now|ask to join|ready to join|getting ready)\b/i.test(document.body.innerText || '')) {
      return false;
    }

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

    // ALWAYS include the local user.
    //
    // This used to call getSelfName() (data-self-name only), which silently dropped the recorder
    // from their own roster whenever that attribute was absent — it is tied to the self VIDEO TILE,
    // so it disappears while screen-sharing, in speaker/audio-only layouts, and when the self tile is
    // scrolled out of a large grid. The People-panel row for yourself is no help either: it reads
    // "You", which isPlausibleName rejects as UI noise. Net effect: the host could be present for the
    // entire call and never appear in participants.json.
    //
    // resolveSelfName() tries data-self-name AND the panel's "(You)" row, and caches the first hit,
    // so once we have learned the local user's name they stay in every later snapshot.
    addName(resolveSelfName());

    return found;
  }

  function getSelfName() {
    const el = document.querySelector('[data-self-name]');
    return el ? cleanName(el.getAttribute('data-self-name')) : null;
  }

  // Resolve the local user's real display name, for attributing captions that Meet labels "You".
  //
  // data-self-name is authoritative but is not always in the DOM (it appears with the self tile, and
  // is absent while screen-sharing or in audio-only layouts). So we fall back to the People panel row
  // marked "(You)", and CACHE the first good answer: captions must not flip between "You" and the
  // real name mid-meeting depending on which tiles happen to be mounted.
  let resolvedSelfName = null;

  function resolveSelfName() {
    if (resolvedSelfName) return resolvedSelfName;

    // 1) data-self-name — authoritative.
    const direct = getSelfName();
    if (direct && isPlausibleName(direct)) {
      resolvedSelfName = direct;
      return resolvedSelfName;
    }

    // 2) People panel row whose raw aria-label/text carries the "(You)" marker. cleanName() strips
    //    that suffix, so we must test the RAW string before cleaning to know which row is ours.
    const container = findPeoplePanelContainer();
    if (container) {
      for (const item of container.querySelectorAll('[role="listitem"]')) {
        if (isPanelSectionHeader(item)) continue;
        const raw = `${item.getAttribute('aria-label') || ''} ${item.textContent || ''}`;
        if (!/\(\s*you\s*\)|\byou\b\s*$/i.test(raw)) continue;
        const nm = extractPanelName(item);
        if (nm && isPlausibleName(nm) && !/^you$/i.test(nm)) {
          resolvedSelfName = nm;
          console.log('[GMR Content] Self-name resolved from People panel:', resolvedSelfName);
          return resolvedSelfName;
        }
      }
    }

    // 3) The account switcher / profile chrome carries the signed-in user's name even when no self
    //    tile is mounted. Last resort before giving up.
    const acct = document.querySelector(
      '[aria-label*="Google Account" i], [aria-label*="Account:" i], a[aria-label*="Google Account" i]'
    );
    if (acct) {
      // Labels read like "Google Account: Devops Beta (devops@example.com)".
      const m = (acct.getAttribute('aria-label') || '').match(/(?:Google Account|Account):\s*([^(\n]+)/i);
      const nm = m && cleanName(m[1]);
      if (nm && isPlausibleName(nm) && !/^you$/i.test(nm)) {
        resolvedSelfName = nm;
        console.log('[GMR Content] Self-name resolved from account chrome:', resolvedSelfName);
        return resolvedSelfName;
      }
    }

    return null;
  }

  // Meet labels the local user's captions "You" (and some locales "You (You)"). Map that to the real
  // name when we can resolve it; otherwise leave it as-is rather than inventing an attribution.
  function isSelfSpeakerLabel(s) {
    return !!s && /^you$/i.test(String(s).trim());
  }

  function normalizeSpeaker(speaker) {
    if (!isSelfSpeakerLabel(speaker)) return speaker;
    return resolveSelfName() || speaker;
  }

  // Locate the People / participants side panel container (where names are listed cleanly).
  //
  // The label match must be POSITIVE and EXCLUSIVE: an unlabelled [role="list"] used to match the
  // empty-label test vacuously, so the "Backgrounds and effects" side panel was read as a roster.
  // Require a people-word in the label, and explicitly reject other side panels that also contain
  // listitems (effects, chat, activities, host controls).
  const NOT_PEOPLE_PANEL = /background|effect|chat|activit|host control|whiteboard|breakout|poll|q&a|caption|layout|setting/i;

  function findPeoplePanelContainer() {
    const nodes = document.querySelectorAll(
      '[role="region"], [role="dialog"], [role="complementary"], [role="list"]'
    );
    for (const n of nodes) {
      const label = (n.getAttribute('aria-label') || '').toLowerCase();
      if (!label) continue;                                  // unlabelled list: can't confirm it's People
      if (NOT_PEOPLE_PANEL.test(label)) continue;            // a different side panel
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
    // Opening the panel focuses its button, stealing focus from the chat box mid-keystroke. Skip
    // while the user is typing; the reconcile loop retries shortly and falls back to reading names
    // from video tiles in the meantime, so participant tracking is not affected.
    if (isUserTyping()) return;
    const now = Date.now();
    if (now - lastPanelOpenAttempt < 30000) return;
    lastPanelOpenAttempt = now;
    const btns = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (const b of btns) {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      if (/add people|add others|add to/.test(l)) continue;       // not the "add" button
      if (/people|show everyone|participant|contributor/.test(l)) {
        if (b.getAttribute('aria-pressed') === 'true') return; // Panel is ALREADY open — do not click to close!
        b.click();
        return;
      }
    }
  }

  // Read participant names from the People panel. Returns an array of display names, or null.
  //
  // Returning null (not []) when nothing usable was found matters: snapshotParticipants() treats a
  // non-empty array as authoritative and skips the video-tile fallback. A panel holding only section
  // headers must therefore read as "unreadable", not as "an empty meeting".
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

  // Is this [role="listitem"] a People-panel SECTION HEADER rather than a participant row?
  // Meet's panel is a flat list: headers ("1 joined", "0 also invited") sit as listitem siblings of
  // the real rows. Real rows always have an identity hook or interactive/avatar content.
  // Is this list row something OTHER than a participant (a section header, or a stray control that
  // Meet renders inside a list-like container)? Returning true means "not a person".
  function isPanelSectionHeader(item) {
    if (!item) return true;

    // Positive identity hook -> definitely a real participant row.
    if (item.hasAttribute('data-participant-id') || item.querySelector('[data-participant-id]')) {
      return false;
    }

    // A row that IS a button is a control, not a person. Presentation mode renders controls like
    // "Open in new window", "Show my screen anyway" and "Enter full screen" as list items, and they
    // used to pass the check below simply because they contain a button — so Meet's own toolbar
    // self-certified as participants. Reject the control itself before looking for an avatar.
    if (isControlRow(item)) return true;

    // Real rows carry an AVATAR (or the self marker). Note this deliberately no longer accepts a
    // bare <button>/[role=button] as proof of personhood — that was the loophole above.
    if (item.querySelector('img, [data-self-name]')) return false;

    // No hooks at all: if the whole row reads as "<count> <status>", it's a header.
    const text = cleanName(item.textContent) || '';
    if (/^\d+\s+\S/.test(text)) return true;
    // Otherwise treat a hook-less row as a header only when it has no name-like text left.
    return !isPlausibleName(text);
  }

  // True when the row is itself an interactive control (or is entirely made of one). A participant
  // row has text of its own outside its buttons — the person's name; a control does not.
  function isControlRow(item) {
    const tag = (item.tagName || '').toLowerCase();
    const role = (item.getAttribute && item.getAttribute('role')) || '';
    if (tag === 'button' || role === 'button' || role === 'menuitem' || role === 'tab') return true;

    // Row text that comes ENTIRELY from inside buttons means there is no name in the row.
    const rowText = (item.textContent || '').replace(/\s+/g, ' ').trim();
    if (!rowText) return true;
    const controls = item.querySelectorAll('button, [role="button"], [role="menuitem"]');
    if (!controls.length) return false;
    let controlText = '';
    controls.forEach(c => { controlText += ' ' + (c.textContent || ''); });
    controlText = controlText.replace(/\s+/g, ' ').trim();
    // If stripping the buttons' text leaves nothing, the row was only a control.
    return rowText.replace(controlText, '').replace(/\s+/g, ' ').trim().length === 0;
  }

  // Extract one participant's name from a People-panel row.
  function extractPanelName(item) {
    // A real participant row carries an identity hook (data-participant-id) or an avatar/button
    // subtree. Section headers ("1 joined") have neither — skip them structurally, before any
    // text heuristics get a chance to mistake the header text for a name.
    if (isPanelSectionHeader(item)) return null;

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

    // Tile container or descendants might hold participant name in aria-label or title
    if (el.getAttribute) {
      pushCandidate(el.getAttribute('aria-label'));
      pushCandidate(el.getAttribute('title'));
    }

    if (el.querySelectorAll) {
      el.querySelectorAll('[aria-label], [title]').forEach(node => {
        pushCandidate(node.getAttribute('aria-label'));
        pushCandidate(node.getAttribute('title'));
      });
      el.querySelectorAll('*').forEach(node => {
        if (node.children.length !== 0) return;
        // Skip text that lives inside a control. Presentation-mode buttons ("Show my screen anyway",
        // "Enter full screen") are long phrases, and the longest-wins rule below would pick them over
        // the actual name. A person's name is never rendered inside a button's own subtree.
        if (node.closest && node.closest('button, [role="button"], [role="menuitem"], [role="tab"]')) return;
        pushCandidate(node.textContent);
      });
    }
    if (candidates.length === 0) return null;
    // Prefer the longest plausible string — a real display name ("Poonthamil V") beats stray
    // short words. (The old "shortest" rule wrongly picked junk like "devices".)
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  // Normalize a raw name string ("John Doe (You)", "  Jane  ") into a stable display name.
  //
  // Meet often exposes a name only INSIDE a control's tooltip/aria-label — e.g. a tile's pin button
  // reads "Pin Adil Babakarkhel to your main screen", the more-actions button "More actions for
  // Jane Doe". Grabbing that raw text stored junk names like "Pin X to your main screen" that never
  // matched the roster, so the UI showed nobody. Unwrap those known patterns to the bare name before
  // using it; genuinely non-name UI phrases are rejected by isPlausibleName.
  function cleanName(str) {
    if (!str) return null;
    let s = String(str).trim().replace(/\s+/g, ' ');

    // Unwrap "<verb> <NAME> to/from/for..." or "<verb> <NAME>" control tooltips -> "<NAME>".
    let m = s.match(/^(?:pin|unpin|mute|remove|spotlight|highlight)\s+(.+?)(?:\s+(?:to|from|for)\b|$)/i);
    if (m) s = m[1].trim();
    // "More actions for Jane Doe", "More options for Jane Doe" -> "Jane Doe".
    m = s.match(/^more (?:actions|options) for\s+(.+)$/i);
    if (m) s = m[1].trim();
    // "Jane Doe is presenting" / "Jane Doe presentation" / "Jane Doe raised hand" -> "Jane Doe".
    s = s.replace(/\s+(is presenting|raised hand|hand raised)$/i, '').trim();
    s = s.replace(/['']s presentation$/i, '').trim();
    // Trailing role/self/status markers (e.g. "(You)", "(Host, Muted)", "(Your presentation)", "(Hand raised)").
    s = s.replace(/\s*\(([^)]+)\)\s*$/i, (match, inner) => {
      if (/\b(you|host|co-host|meeting host|presenting|your presentation|presentation|your screen|screen|muted|unmuted|raised hand|hand raised)\b/i.test(inner)) {
        return '';
      }
      return match;
    }).trim();

    return s || null;
  }

  // Phrases Meet renders that survive cleanName but are NOT participant names (warnings, buttons,
  // summary strings, the recorder's own bot). Rejected wholesale so they never enter the roster.
  const UI_PHRASE_NOISE = [
    /\bto your main screen\b/i,          // leftover "... to your main screen" (unwrap missed it)
    /\bmight still see\b/i,              // "Others might still see your full video."
    /\bopen the (people|chat)\b/i,       // "Open the People panel"
    /\band \d+ more$/i,                  // "Abhishek, Adil, amr and 5 more"
    /^others\b/i,                        // "Others might..."
    /notetaker|note taker|note-taker/i,  // the recorder bot itself
    /\bpanel\b/i,                        // "...panel"
    /\bfull video\b/i,
    // People-panel SECTION HEADERS. Meet renders these as [role="listitem"] siblings of the real
    // participant rows, so they were being stored as participants ("1 joined", "0 also invited").
    // A leading count + status word is never a person's name.
    /^\d+\s+(joined|also invited|invited|in call|in the call|waiting|contributors?)\b/i,
    /^(joined|also invited|invited|waiting to join|in this call|contributors?)$/i,
    // Effects / background side panel leaking in as a "participant". Meet exposes BOTH the human
    // label ("Backgrounds and effects") and internal snake_case identifiers ("visual_effects") —
    // treat [_-] and whitespace as interchangeable so one pattern covers every casing Meet uses.
    /backgrounds?[\s_-]*and[\s_-]*effects|visual[\s_-]*effects|apply[\s_-]*(a[\s_-]*)?(background|effect)/i,
    // Any snake_case / kebab-case token is a Meet internal identifier, never a display name.
    // Real names contain spaces or are single words; they never contain underscores.
    /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/i,
    // PRESENTING-MODE UI. Screen sharing adds a batch of tooltips/promos that are structured like
    // rows and were being stored as participants ("Try annotating (visible to everyone)",
    // "You can't unmute someone else"). These are instructional SENTENCES, so match on sentence-like
    // features rather than blanket-rejecting parentheses — real display names such as
    // "Ravi Kumar (Finance)" legitimately contain them, and dropping a real person is worse than
    // keeping a stray label.
    /\b(can'?t|cannot|can not)\b/i,        // "You can't unmute someone else"
    /^try\b/i,                             // "Try annotating ..."
    /\bvisible to\b/i,                     // "... (visible to everyone)"
    /\bannotat(e|ing|ion|ions)\b/i,        // annotation toolbar promos
    /\byour (presentation|screen)\b/i,     // leftover presentation labels
    /\b(is|are) sharing\b/i,               // "Someone is sharing their screen"
    /\bstop sharing\b/i,
    /\bpresent(ing)? to\b/i,                // "Presenting to everyone"
    // Presentation-mode BUTTON labels. isPanelSectionHeader/isControlRow reject these structurally
    // (they are controls, not people); these patterns are a text-level backstop for DOM shapes where
    // the structural check cannot see the button — e.g. a label lifted from an aria-label.
    // Verb-led imperative: "Open in new window", "Show my screen anyway", "Present now". Anchored to
    // a leading verb so surnames that merely CONTAIN these words survive — "Addison Fullscreen" and
    // "Sharon Windows" are plausible people, "Enter full screen" is not.
    /^(open|show|enter|exit|close|start|stop|share|present|pin|unpin|mute|unmute|remove|add|invite|join|leave|turn|switch|view|hide)\b.*\b(window|screen|tab|anyway|everyone|call|people|now|here|mode|layout|others)\b/i,
    /^(enter|exit) full ?screen\b/i,       // the fullscreen toggles specifically
    /^open in\b/i                          // "Open in new window" / "Open in new tab"
  ];

  function isUiPhraseNoise(s) {
    return UI_PHRASE_NOISE.some(re => re.test(s));
  }

  function isPlausibleName(str) {
    if (!str) return false;
    const s = String(str).trim();
    if (s.length < 2 || s.length > 60) return false;
    if (/^\d+$/.test(s)) return false;                 // pure numbers (counts, timers)
    if (/https?:|google|meet\.google/i.test(s)) return false;
    if (!/[a-zÀ-ɏЀ-ӿ一-鿿]/i.test(s)) return false; // must contain a letter
    if (UI_NOISE.has(s.toLowerCase())) return false;
    if (isUiPhraseNoise(s)) return false;              // multi-word Meet UI phrases / bot name
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

  // ==================== RESUME-RECORDING PROMPT ====================
  // Shown when the user stops screen sharing mid-recording (Chrome's native "Stop sharing").
  // The recording is broken until they resume; this in-page banner (plus a Chrome notification
  // raised by the background worker) lets them click to continue. This click is the user gesture
  // the capture APIs need to re-acquire a stream.
  function showResumePrompt() {
    const existing = document.getElementById('gmr-resume-overlay');
    if (existing) existing.remove();

    if (!document.getElementById('gmr-resume-styles')) {
      const st = document.createElement('style');
      st.id = 'gmr-resume-styles';
      st.textContent = `
        #gmr-resume-overlay {
          position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
          z-index: 1000003; display: flex; align-items: center; gap: 12px;
          max-width: 600px; padding: 12px 14px 12px 18px;
          background: rgba(40, 8, 8, 0.97); color: #fff;
          border: 1px solid rgba(255, 59, 48, 0.6); border-radius: 12px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.6);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px;
          animation: gmr-resume-in 0.25s ease;
        }
        @keyframes gmr-resume-in { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }
        .gmr-resume-icon { color: #ff453a; font-size: 16px; flex-shrink: 0; }
        .gmr-resume-msg { flex: 1; line-height: 1.4; }
        .gmr-resume-action {
          background: #ff3b30; color: #fff; border: none; border-radius: 8px;
          padding: 8px 14px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap;
        }
        .gmr-resume-action:hover { background: #ff453a; }
        .gmr-resume-dismiss {
          background: rgba(255,255,255,0.1); border: none; color: #fff; width: 26px; height: 26px;
          border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1; flex-shrink: 0;
        }
        .gmr-resume-dismiss:hover { background: rgba(255,255,255,0.2); }
      `;
      document.head.appendChild(st);
    }

    const resume = () => {
      const overlay = document.getElementById('gmr-resume-overlay');
      if (overlay) overlay.remove();
      // This click is the user gesture the capture APIs require. Force the display picker so the
      // user re-selects a surface to share.
      chrome.storage.local.set({ forceDisplayCapture: true }, () => {
        autoEnableCaptions();
        chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (resp) => {
          if (resp && resp.error) showToast(resp.message || resp.error, 'error');
        });
      });
    };

    const banner = createDOMElement('div', { id: 'gmr-resume-overlay' }, [
      createDOMElement('span', { className: 'gmr-resume-icon' }, ['⛔']),
      createDOMElement('span', { className: 'gmr-resume-msg' }, [
        'Screen sharing was stopped, so your recording is broken. Click to continue recording.'
      ]),
      createDOMElement('button', { className: 'gmr-resume-action', onClick: resume }, ['Continue recording']),
      createDOMElement('button', {
        className: 'gmr-resume-dismiss',
        title: 'Dismiss',
        onClick: () => {
          const b = document.getElementById('gmr-resume-overlay');
          if (b) b.remove();
        }
      }, ['×'])
    ]);

    document.body.appendChild(banner);
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

    // Is this a scheduled (bound) class? If so, nag harder to start recording.
    const scheduled = !!(meetingBinding && meetingBinding.bound);
    const batchName = scheduled && meetingBinding.meeting ? meetingBinding.meeting.batchName : null;

    // Highest priority first.
    const candidates = [
      {
        id: 'start-recording',
        active: inCall && !rec,
        message: scheduled
          ? `This is a scheduled class${batchName ? ` (${batchName})` : ''}. Recording hasn\'t started — please start it so the session is captured.`
          : 'You\'re in the meeting but recording hasn\'t started.',
        actionLabel: 'Start Recording',
        action: handleRecordButtonClick,
        snoozeMs: scheduled ? 15000 : 30000
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

  // A caption that has not changed for this long is treated as a finished utterance: the next text
  // under the same speaker starts a fresh line rather than continuing it.
  //
  // This is only a SAFETY NET, not the primary test — unrelated speech is already rejected by
  // isSameUtterance(), so this window exists purely to stop a recycled caption block from merging two
  // genuinely separate statements that happen to look similar. It was 15s, which split real sentences:
  // on a poor connection one observed utterance kept growing after an 18.7s gap. Being generous here
  // costs almost nothing (similarity still has to pass) while being stingy corrupts real transcripts.
  const UTTERANCE_RESET_MS = 60000;

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
      const rawSpeaker = cleanName(header.textContent) || 'Unknown';
      let text = (block.textContent || '').trim();
      // Strip the speaker label off the front of the block text using the RAW label, since that is
      // what actually appears in the DOM ("You"), not the resolved display name.
      if (rawSpeaker && rawSpeaker !== 'Unknown' && text.startsWith(rawSpeaker)) {
        text = text.slice(rawSpeaker.length);
      }
      text = text.replace(/^[\s:–-]+/, '').trim();
      // Attribute the local user's captions to their real name instead of Meet's literal "You".
      // Normalizing HERE (not at emit time) keeps captionState keyed by one stable identity, so a
      // name that resolves mid-utterance can't split one speaker into two growth chains.
      const speaker = normalizeSpeaker(rawSpeaker);
      if (text) blocks.push({ speaker, text });
    });

    // Fallback: no avatars (caption-only layout) — split the visible text into "Name\n text" rows.
    if (blocks.length === 0) {
      const raw = (container.innerText || container.textContent || '').trim();
      if (raw) blocks.push({ speaker: 'Unknown', text: raw });
    }

    for (const b of blocks) {
      // If this speaker was previously tracked under the literal "You" (self-name resolved only
      // after captions started), carry that growth state over to the real name. Without this the
      // in-flight utterance would restart under a new key and get appended as a duplicate line
      // instead of superseding — the exact bloat the replace mechanism exists to prevent.
      if (b.speaker !== 'You' && !captionState.has(b.speaker) && captionState.has('You')) {
        const carried = captionState.get('You');
        // Remember the old label only if a line was already emitted under it, so the server can
        // supersede that stored line rather than stranding it.
        if (carried.emittedText) carried.renamedFrom = 'You';
        captionState.set(b.speaker, carried);
        captionState.delete('You');
      }
      const st = captionState.get(b.speaker) || { text: '', lastChange: 0, emittedText: '' };
      if (b.text !== st.text) { st.text = b.text; st.lastChange = now; }
      captionState.set(b.speaker, st);
    }
  }

  // Emit caption lines that have been stable for >= 1.2s (utterance finished).
  //
  // Google Meet live captions GROW in place: one utterance renders as "Hi" -> "Hi there" ->
  // "Hi there, welcome". Naively emitting each stable state produced a new line per growth step, and
  // since each was a longer string, exact-match dedup never caught them — a 3h class ballooned to
  // multi-MB of overlapping text and broke summarisation. Fix: only emit the FINAL form of a growing
  // utterance. While the caption for a speaker keeps extending the previously-emitted text (prefix
  // match), we REPLACE that speaker's last line instead of appending; a genuinely new utterance
  // (caption resets to text that is not a continuation) starts a fresh line.
  // Would `next` be a refinement of the already-emitted `prev` (same utterance), rather than new speech?
  //
  // Two accepted shapes:
  //   1. Pure growth      — "Hi there" -> "Hi there, welcome"           (prefix extension)
  //   2. Revised tail     — "...it is a terminal language only."
  //                      -> "...it is a Tamil language, oh good, broad. During the..."
  //      Google rewrote the last few words of its own guess while keeping everything before them.
  //
  // Shape 2 is detected by requiring a long common PREFIX: the revision only ever rewrites the tail,
  // so if the two strings agree for most of the shorter one's length they are the same sentence. The
  // threshold is deliberately high (85%) and also requires the new text to be at least as long, so two
  // different sentences that merely start alike ("Okay, so..." / "Okay, and...") are NOT merged.
  const UTTERANCE_MATCH_RATIO = 0.65;   // shared leading characters, as a fraction of prev
  const UTTERANCE_WORD_RATIO = 0.75;    // shared words (in order), as a fraction of prev's words
  const UTTERANCE_SHRINK_MIN = 0.8;     // a revision may shorten to this fraction of prev

  function isSameUtterance(prev, next) {
    if (!prev || !next) return false;
    if (next.startsWith(prev)) return true;          // shape 1: pure growth
    if (prev.length < 25) return false;              // too short for overlap to mean anything

    // A revision can SHORTEN the text — "…close the call. I think." became "…close the call. Okay."
    // An earlier version required next to be at least as long, which rejected exactly that. Allow a
    // modest shrink, but still reject a genuinely new short line following a long one.
    if (next.length < prev.length * UTTERANCE_SHRINK_MIN) return false;

    // Shared leading characters — catches revisions confined to the tail.
    let i = 0;
    const max = Math.min(prev.length, next.length);
    while (i < max && prev[i] === next[i]) i++;
    if ((i / prev.length) >= UTTERANCE_MATCH_RATIO) return true;

    // Google also rewrites words near the START of its guess ("Great images. Create images crossbody"
    // -> "create images, create images"), which destroys the character prefix while keeping most words
    // in order. Fall back to an order-preserving word overlap so those revisions are still recognised.
    return wordOverlapRatio(prev, next) >= UTTERANCE_WORD_RATIO;
  }

  // Fraction of `prev`'s words that appear, in order, near the start of `next` (longest common
  // subsequence over normalised words). Bounded so this stays cheap on long captions.
  function wordOverlapRatio(prev, next) {
    const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const A = words(prev).slice(0, 60);
    if (!A.length) return 0;
    // Only look at next's opening region: a revision rewrites what was already said, it does not
    // reorder the whole sentence.
    const B = words(next).slice(0, Math.min(A.length + 8, 68));
    if (!B.length) return 0;

    let prevRow = new Array(B.length + 1).fill(0);
    for (let x = 1; x <= A.length; x++) {
      const row = new Array(B.length + 1).fill(0);
      for (let y = 1; y <= B.length; y++) {
        row[y] = A[x - 1] === B[y - 1] ? prevRow[y - 1] + 1 : Math.max(prevRow[y], row[y - 1]);
      }
      prevRow = row;
    }
    return prevRow[B.length] / A.length;
  }

  function flushStableCaptions() {
    const now = Date.now();
    for (const [speaker, st] of captionState) {
      if (st.text && st.text !== st.emittedText && (now - st.lastChange) >= 1200) {
        const prev = st.emittedText || '';
        // Is this the SAME utterance still being refined, or genuinely new speech?
        //
        // A strict prefix test (text.startsWith(prev)) is not enough. Google's recogniser
        // RETROACTIVELY REWRITES earlier words as more audio arrives — especially for non-English
        // speech, where "terminal language only" became "Tamil language, oh good, broad". The revised
        // text is not a prefix extension, so a prefix-only test called it a new utterance and appended
        // a near-duplicate of the same sentence. isSameUtterance() also accepts revisions.
        //
        // The staleness reset is measured from when the utterance was last EMITTED, not from
        // lastChange: on a poor connection a caption can sit unchanged for a long time and then keep
        // growing (one real line here arrived 42s after its start), and keying off lastChange wrongly
        // declared that a new utterance mid-sentence.
        const idleSinceEmit = st.lastEmitAt ? (now - st.lastEmitAt) : 0;
        const stale = st.lastEmitAt ? idleSinceEmit >= UTTERANCE_RESET_MS : false;
        const isContinuation = !!prev && !stale && isSameUtterance(prev, st.text);
        st.lastEmitAt = now;
        st.emittedText = st.text;
        // One-shot: tell the server the prior line was stored under the pre-resolution label.
        const renamedFrom = st.renamedFrom || null;
        delete st.renamedFrom;
        emitTranscriptLine(speaker, st.text, isContinuation, renamedFrom);
      }
    }
    // Bound memory.
    if (captionState.size > 50) {
      const entries = Array.from(captionState.entries()).slice(-25);
      captionState.clear();
      entries.forEach(([k, v]) => captionState.set(k, v));
    }
  }

  // replace=true means this text supersedes the last line we emitted for this speaker (the caption
  // grew in place) — the recorder replaces that speaker's previous line rather than storing both.
  function emitTranscriptLine(speaker, text, replace, prevSpeaker) {
    if (!text || text.length < 2) return;

    // Exact-dedup applies to REPLACEMENTS TOO. This guard used to be skipped when replace was true,
    // on the reasoning that a replacement always differs from the prior text — but a re-scan of a
    // still-mounted caption block re-emits byte-identical text with replace:true. That slipped past
    // this check, and then past the server's supersede (another speaker's line had landed in the
    // meantime), producing a verbatim duplicate. Identical text for the same speaker is never new
    // speech, so drop it regardless of the flag.
    const key = `${speaker}::${text}`;
    if (seenTranscriptKeys.has(key)) return;
    seenTranscriptKeys.add(key);
    if (seenTranscriptKeys.size > 1000) {
      seenTranscriptKeys = new Set(Array.from(seenTranscriptKeys).slice(-500));
    }

    console.log(`[GMR Content] Transcript${replace ? ' (revise)' : ''}: [${speaker}] ${text}`);
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_LINE',
      speaker: speaker || 'Unknown',
      text,
      replace: !!replace,
      prevSpeaker: prevSpeaker || null,
      timestamp: new Date().toISOString(),
      meetingId
    });
  }

  // ==================== AUDIO WARNING BANNER ====================
  function showAudioWarning() {
    if (warningBanner) return;
    
    console.log('[GMR Content] Showing audio warning banner');
    
    const recordAgainBtn = createDOMElement('button', {
      className: 'gmr-warning-btn primary',
      onClick: () => {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
        chrome.storage.local.set({ forceDisplayCapture: true });
        dismissAudioWarning();
        showToast('Recording stopped. Please click "Start Recording" again and select "Share system audio" or "Also share tab audio".', 'info');
      }
    }, ['Record Again']);

    const continueBtn = createDOMElement('button', {
      className: 'gmr-warning-btn secondary',
      onClick: dismissAudioWarning
    }, ['Continue']);

    const actionsDiv = createDOMElement('div', {
      className: 'gmr-warning-actions'
    }, [recordAgainBtn, continueBtn]);

    warningBanner = createDOMElement('div', {
      id: 'gmr-audio-warning'
    }, [
      createDOMElement('div', { className: 'gmr-warning-inner' }, [
        createDOMElement('span', { className: 'gmr-warning-icon' }, ['⚠️']),
        createDOMElement('span', { className: 'gmr-warning-text' }, [
          'This will not capture participant audio. Click "Record Again" or "Continue" to proceed.'
        ]),
        actionsDiv
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
        background: rgba(255, 107, 138, 0.25);
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
        flex-wrap: wrap;
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

      .gmr-warning-actions {
        display: flex;
        gap: 8px;
        margin-left: 12px;
      }

      .gmr-warning-btn {
        font-family: 'Archivo', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px;
        font-weight: 600;
        border: none;
        border-radius: 6px;
        padding: 6px 12px;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .gmr-warning-btn.primary {
        background: #ff3b30;
        color: #fff;
      }

      .gmr-warning-btn.primary:hover {
        background: #ff453a;
      }

      .gmr-warning-btn.secondary {
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.25);
        color: #fff;
      }

      .gmr-warning-btn.secondary:hover {
        background: rgba(255, 255, 255, 0.25);
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(warningBanner);
    
    setTimeout(() => dismissAudioWarning(), 60000);
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
      case 'SHOW_KEY_PROMPT':
        // The server refused recording (external user / unbound meeting). Ask for the access key.
        hasAccessKey = false;
        showKeyPrompt(message.message || 'Enter the access key to record this meeting.');
        sendResponse({ success: true });
        break;
      case 'SHOW_RESUME_PROMPT':
        // Screen sharing was stopped mid-recording — surface an in-page prompt to resume.
        showResumePrompt();
        sendResponse({ success: true });
        break;
      case 'CAPTURE_DEGRADED_NOTICE': {
        // Screen sharing stopped but the recording is STILL RUNNING. Deliberately a mild info toast,
        // not the resume prompt: there is nothing for the user to fix and the session is intact.
        const kinds = Array.isArray(message.liveKinds) ? message.liveKinds : [];
        showToast(
          kinds.includes('audio')
            ? 'Screen sharing stopped. Still recording audio, transcript and participants — the recording was not interrupted.'
            : 'Screen sharing stopped. Still capturing transcript and participants — the recording was not interrupted.',
          'info'
        );
        sendResponse({ success: true });
        break;
      }
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
