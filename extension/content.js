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
  let knownParticipants = new Set();
  let transcriptContainer = null;
  let lastParticipantCount = null;
  let periodicIntervalId = null;
  let timerIntervalId = null;

  let gmrState = {
    wsUrl: 'ws://164.52.198.68:8001',
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

  // DOM Selectors for Google Meet (these may need updating as Meet evolves)
  const SELECTORS = {
    // Participant list
    participantList: '[data-participant-id], [jscontroller] [role="listitem"] .zWfAib, .KV1GEc, .dwSJ2e',
    participantName: '.zWfAib, .KV1GEc .zWfAib, .dwSJ2e .zWfAib, [data-self-name], .GvcuGe, .N0PJ8e',
    
    // Alternative participant selectors
    participantItem: '[role="listitem"]',
    participantNameAlt: '.zWfAib',
    
    // Live captions / transcript
    transcriptContainer: '.V6Yesc, .a4cQT, .Mz6pEf, [jsname="tgaKEf"], .bY93Qe, .TBMuR',
    transcriptLine: '.TBMuR, .bY93Qe, .Mz6pEf, .V6Yesc > div',
    transcriptSpeaker: '.Mz6pEf .PABS8e, .TBMuR .PABS8e, .bY93Qe .PABS8e',
    transcriptText: '.Mz6pEf .bY97s, .TBMuR .bY97s, .bY93Qe .bY97s, .V6Yesc span:last-child',
    
    // Meeting title/info
    meetingTitle: '[data-meeting-title], .N6dS8c, .Jyj1Td, .CkXZgc',
    
    // Self name
    selfName: '[data-self-name], .GvcuGe'
  };

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
    
    // Try to get self name
    detectSelfName();

    // Start periodic tasks loop (auto-captions, grid participants scan, count scrape, check end)
    if (periodicIntervalId) clearInterval(periodicIntervalId);
    periodicIntervalId = setInterval(() => {
      autoEnableCaptions();
      scanGridParticipants();
      checkMeetingEnded();
      
      const count = getParticipantCountFromUI();
      if (count !== null && count !== lastParticipantCount) {
        lastParticipantCount = count;
        chrome.runtime.sendMessage({
          type: 'PARTICIPANT_COUNT_UPDATE',
          count: count
        });
      }
    }, 3000);
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
      if (data.isRecording) {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      } else {
        autoEnableCaptions();
        chrome.runtime.sendMessage({ type: 'START_RECORDING' });
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
    
    // Recording controls
    const recordBtn = document.getElementById('gmr-btn-record');
    const pauseBtn = document.getElementById('gmr-btn-pause');
    
    if (recordBtn) {
      if (state.isRecording) {
        recordBtn.textContent = 'Stop';
        recordBtn.className = 'gmr-btn gmr-btn-danger';
        if (pauseBtn) {
          pauseBtn.style.display = 'block';
          pauseBtn.textContent = state.isPaused ? 'Resume' : 'Pause';
          pauseBtn.className = state.isPaused ? 'gmr-btn gmr-btn-primary' : 'gmr-btn gmr-btn-warning';
        }
      } else {
        recordBtn.textContent = 'Start Recording';
        recordBtn.className = 'gmr-btn gmr-btn-primary';
        if (pauseBtn) {
          pauseBtn.style.display = 'none';
        }
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

  function autoEnableCaptions() {
    const ccButtons = document.querySelectorAll('button[aria-label*="caption" i], button[data-tooltip*="caption" i], button[aria-label*="cc" i], button[data-tooltip*="cc" i]');
    let ccButton = null;
    for (const btn of ccButtons) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
      
      // Exclude settings modal tabs or menu triggers that just say "Captions" or include "settings"
      if (label === 'captions' || tooltip === 'captions' || label.includes('settings') || tooltip.includes('settings') || btn.getAttribute('role') === 'tab') {
        continue;
      }
      
      ccButton = btn;
      break;
    }
    
    if (ccButton) {
      const isPressed = ccButton.getAttribute('aria-pressed') === 'true';
      const ariaLabel = (ccButton.getAttribute('aria-label') || '').toLowerCase();
      
      if (isPressed || ariaLabel.includes('turn off') || ariaLabel.includes('desactivar') || ariaLabel.includes('stop')) {
        return true;
      }
      
      console.log('[GMR Content] Captions toggle button found. Enabling closed captions...');
      ccButton.click();
      return true;
    }
    return false;
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

  // ==================== PARTICIPANT TRACKING ====================
  function setupParticipantTracking() {
    console.log('[GMR Content] Setting up participant tracking observer...');
    
    participantObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              scanForParticipants(node);
            }
          });
          
          mutation.removedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              scanForDepartures(node);
            }
          });
        }
      }
    });
    
    participantObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    scanForParticipants(document.body);
    scanGridParticipants();
  }

  function getParticipantCountFromUI() {
    const selectors = [
      '[aria-label*="show everyone" i]',
      '[aria-label*="people" i]',
      '[aria-label*="participant" i]',
      '.AwUel',
      '.Lulu7c',
      '[jsname="muIDxc"]',
      '[jsname="U26qK"]'
    ];
    
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        // Try to look for text content
        const text = el.textContent || '';
        const match = text.match(/\d+/);
        if (match) {
          const val = parseInt(match[0], 10);
          if (val > 0) return val;
        }
        
        // Try checking title or aria-label for numbers
        const ariaLabel = el.getAttribute('aria-label') || '';
        const ariaMatch = ariaLabel.match(/\d+/);
        if (ariaMatch) {
          const val = parseInt(ariaMatch[0], 10);
          if (val > 0) return val;
        }
        
        // Try checking child elements
        const badge = el.querySelector('[class*="count" i], span, div');
        if (badge) {
          const badgeText = badge.textContent || '';
          const badgeMatch = badgeText.match(/\d+/);
          if (badgeMatch) {
            const val = parseInt(badgeMatch[0], 10);
            if (val > 0) return val;
          }
        }
      }
    }
    
    // Fallback: count unique names in the video grid
    const gridItems = document.querySelectorAll('[data-participant-id], [data-self-name], .cG2ZCf, .YTbUzc, .GvcuGe, .N0PJ8e');
    const uniqueNames = new Set();
    gridItems.forEach(el => {
      const name = el.getAttribute('data-self-name') || el.textContent.trim();
      if (name && isValidName(name)) {
        uniqueNames.add(name);
      }
    });
    if (uniqueNames.size > 0) {
      return uniqueNames.size;
    }
    
    return null;
  }

  function scanGridParticipants() {
    const selectors = [
      '.GvcuGe', // Self/others in tiles
      '.N0PJ8e', // Others in tiles
      '.c7CKJ',  // Side panel list or tiles
      '.zWfAib', // Side panel list
      '.cG2ZCf', // Main active speaker tile
      '.YTbUzc', // Video tile names
      '.jV5ceb', // General text overlay
      '[data-self-name]'
    ];
    
    selectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        const name = el.getAttribute('data-self-name') || el.textContent.trim();
        if (name && isValidName(name) && !knownParticipants.has(name)) {
          knownParticipants.add(name);
          reportParticipantEvent('joined', name);
        }
      });
    });
  }

  function scanForParticipants(container) {
    const selectors = [
      '[data-participant-id]',
      '.zWfAib',
      '.KV1GEc',
      '.dwSJ2e',
      '[role="listitem"] .GvcuGe',
      '[role="listitem"] .N0PJ8e',
      '.c7CKJ'
    ];
    
    for (const selector of selectors) {
      const elements = container.querySelectorAll ? container.querySelectorAll(selector) : [];
      elements.forEach(el => {
        const name = extractParticipantName(el);
        if (name && !knownParticipants.has(name)) {
          knownParticipants.add(name);
          reportParticipantEvent('joined', name);
        }
      });
    }
    
    if (container.querySelectorAll) {
      const avatarElements = container.querySelectorAll('[data-self-name], [title]');
      avatarElements.forEach(el => {
        const name = el.getAttribute('data-self-name') || el.getAttribute('title');
        if (name && name.length > 1 && name.includes(' ') && !knownParticipants.has(name)) {
          if (isValidName(name)) {
            knownParticipants.add(name);
            reportParticipantEvent('joined', name);
          }
        }
      });
    }
  }

  function scanForDepartures(node) {
    if (!node.querySelectorAll) return;
    
    const selectors = ['.zWfAib', '.KV1GEc', '[data-participant-id]'];
    
    for (const selector of selectors) {
      const elements = node.querySelectorAll(selector);
      elements.forEach(el => {
        const name = extractParticipantName(el);
        if (name && knownParticipants.has(name)) {
          setTimeout(() => {
            const stillPresent = document.querySelectorAll(selector);
            let found = false;
            stillPresent.forEach(p => {
              if (extractParticipantName(p) === name) found = true;
            });
            
            if (!found) {
              knownParticipants.delete(name);
              reportParticipantEvent('left', name);
            }
          }, 1000);
        }
      });
    }
  }

  function extractParticipantName(element) {
    const nameSelectors = [
      '.zWfAib',
      '.GvcuGe',
      '.N0PJ8e',
      '[data-self-name]',
      '.c8mVDd',
      '.YTbUzc'
    ];
    
    for (const selector of nameSelectors) {
      const el = element.querySelector ? element.querySelector(selector) : null;
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    
    if (element.textContent && element.textContent.trim().length > 0 && element.textContent.trim().length < 50) {
      const text = element.textContent.trim();
      if (isValidName(text)) return text;
    }
    
    if (element.getAttribute) {
      const title = element.getAttribute('title');
      if (title && isValidName(title)) return title;
    }
    
    return null;
  }

  function isValidName(str) {
    if (!str || str.length < 2 || str.length > 50) return false;
    if (str.includes('http') || str.includes('google') || str.includes('meet')) return false;
    const uiLabels = ['mic', 'camera', 'present', 'chat', 'people', 'raise hand', 'more', 'cc', 'you', 'me'];
    if (uiLabels.includes(str.toLowerCase())) return false;
    return true;
  }

  function reportParticipantEvent(event, name) {
    const timestamp = new Date().toISOString();
    console.log(`[GMR Content] Participant ${event}: ${name}`);
    
    chrome.runtime.sendMessage({
      type: 'PARTICIPANT_EVENT',
      event: event,
      name: name,
      timestamp: timestamp,
      meetingId: meetingId
    });
  }

  function detectSelfName() {
    const selfEl = document.querySelector('[data-self-name]');
    if (selfEl) {
      const name = selfEl.getAttribute('data-self-name');
      if (name && !knownParticipants.has(name)) {
        knownParticipants.add(name);
        reportParticipantEvent('joined', name);
      }
    }
  }

  // ==================== TRANSCRIPT CAPTURE ====================
  function setupTranscriptCapture() {
    console.log('[GMR Content] Setting up transcript capture...');
    
    const findTranscriptContainer = () => {
      const selectors = [
        '.V6Yesc',
        '.a4cQT',
        '.Mz6pEf',
        '[jsname="tgaKEf"]',
        '.bY93Qe',
        '.TBMuR'
      ];
      
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          transcriptContainer = el;
          console.log('[GMR Content] Transcript container found:', selector);
          observeTranscript(el);
          return true;
        }
      }
      return false;
    };
    
    if (!findTranscriptContainer()) {
      const retryInterval = setInterval(() => {
        if (findTranscriptContainer()) {
          clearInterval(retryInterval);
        }
      }, 2000);
      
      setTimeout(() => clearInterval(retryInterval), 60000);
    }
  }

  function observeTranscript(container) {
    extractExistingTranscript(container);
    
    transcriptObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              extractTranscriptLine(node);
            }
          });
        }
      }
    });
    
    transcriptObserver.observe(container, {
      childList: true,
      subtree: true
    });
  }

  function extractExistingTranscript(container) {
    const lineSelectors = ['.TBMuR', '.bY93Qe', '.Mz6pEf', '> div'];
    
    for (const selector of lineSelectors) {
      const lines = container.querySelectorAll(selector);
      lines.forEach(line => extractTranscriptLine(line));
    }
  }

  let seenTranscriptKeys = new Set();

  function extractTranscriptLine(element) {
    let speaker = null;
    let text = null;
    
    const speakerSelectors = [
      '.PABS8e',
      '.Mz6pEf .PABS8e',
      '.TBMuR .PABS8e',
      '[class*="name"]',
      '.zWfAib'
    ];
    
    for (const selector of speakerSelectors) {
      const el = element.querySelector ? element.querySelector(selector) : null;
      if (el && el.textContent.trim()) {
        speaker = el.textContent.trim();
        break;
      }
    }
    
    const textSelectors = [
      '.bY97s',
      '.V6Yesc span:last-child',
      '.TBMuR span:last-child',
      'span:last-child'
    ];
    
    for (const selector of textSelectors) {
      const el = element.querySelector ? element.querySelector(selector) : null;
      if (el && el.textContent.trim()) {
        const fullText = el.textContent.trim();
        if (speaker && fullText.startsWith(speaker)) {
          text = fullText.substring(speaker.length).replace(/^:\s*/, '');
        } else {
          text = fullText;
        }
        break;
      }
    }
    
    if (!text && element.textContent) {
      const fullText = element.textContent.trim();
      if (fullText) {
        const parts = fullText.split(/:\s*/);
        if (parts.length >= 2 && parts[0].length < 50) {
          speaker = speaker || parts[0];
          text = parts.slice(1).join(': ');
        } else {
          text = fullText;
        }
      }
    }
    
    if (!text || text.length < 2) return;
    
    const key = `${speaker}-${text}`;
    if (seenTranscriptKeys.has(key)) return;
    seenTranscriptKeys.add(key);
    
    if (seenTranscriptKeys.size > 1000) {
      seenTranscriptKeys = new Set(Array.from(seenTranscriptKeys).slice(-500));
    }
    
    const timestamp = new Date().toISOString();
    
    if (!speaker) {
      speaker = 'Unknown';
    }
    
    console.log(`[GMR Content] Transcript: [${speaker}] ${text}`);
    
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_LINE',
      speaker: speaker,
      text: text,
      timestamp: timestamp,
      meetingId: meetingId
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
      case 'PARTICIPANT_COUNT_UPDATE':
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
