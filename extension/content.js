// content.js - Content Script
// Runs on meet.google.com — handles participant tracking, transcript capture, audio warning

(function() {
  'use strict';

  console.log('[GMR Content] Google Meet Recorder content script loaded');

  // State
  let meetingId = null;
  let isInitialized = false;
  let participantObserver = null;
  let transcriptObserver = null;
  let warningBanner = null;
  let floatingControls = null;
  let knownParticipants = new Set();
  let transcriptContainer = null;
  let isRecording = false;

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
    
    // Setup participant tracking
    setupParticipantTracking();
    
    // Setup transcript capture
    setupTranscriptCapture();
    
    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener(handleMessage);
    
    // Monitor URL changes (for SPA navigation)
    setupUrlMonitoring();
    
    // Try to get self name
    detectSelfName();
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

  // ==================== PARTICIPANT TRACKING ====================

  function setupParticipantTracking() {
    console.log('[GMR Content] Setting up participant tracking...');
    
    // Try multiple approaches to find participant list
    
    // Approach 1: Look for people button and click to open panel
    const peopleButton = document.querySelector('[aria-label*="people" i], [aria-label*="participant" i], [jsname="muIDxc"]');
    if (peopleButton && peopleButton.getAttribute('aria-pressed') !== 'true') {
      // Don't auto-click, just observe what we can see
    }
    
    // Approach 2: Monitor the entire page for participant-related DOM changes
    participantObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Check added nodes
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              scanForParticipants(node);
            }
          });
          
          // Check removed nodes for departures
          mutation.removedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              scanForDepartures(node);
            }
          });
        }
      }
    });
    
    // Observe the entire document for participant changes
    participantObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    // Initial scan
    scanForParticipants(document.body);
    
    // Also try to find participant avatars in the main video grid
    scanVideoGrid();
  }

  // Scan element for participant names
  function scanForParticipants(container) {
    // Look for participant elements
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
    
    // Also check for names in title attributes (hover tooltips)
    if (container.querySelectorAll) {
      const avatarElements = container.querySelectorAll('[data-self-name], [title]');
      avatarElements.forEach(el => {
        const name = el.getAttribute('data-self-name') || el.getAttribute('title');
        if (name && name.length > 1 && !name.includes(' ') === false && !knownParticipants.has(name)) {
          // Filter out non-name titles
          if (isValidName(name)) {
            knownParticipants.add(name);
            reportParticipantEvent('joined', name);
          }
        }
      });
    }
  }

  // Scan for departures
  function scanForDepartures(node) {
    if (!node.querySelectorAll) return;
    
    const selectors = ['.zWfAib', '.KV1GEc', '[data-participant-id]'];
    
    for (const selector of selectors) {
      const elements = node.querySelectorAll(selector);
      elements.forEach(el => {
        const name = extractParticipantName(el);
        if (name && knownParticipants.has(name)) {
          // Check if this participant still exists elsewhere in the document
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

  // Extract participant name from element
  function extractParticipantName(element) {
    // Try various approaches
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
    
    // Check if element itself contains a name
    if (element.textContent && element.textContent.trim().length > 0 && element.textContent.trim().length < 50) {
      const text = element.textContent.trim();
      if (isValidName(text)) return text;
    }
    
    // Check title attribute
    if (element.getAttribute) {
      const title = element.getAttribute('title');
      if (title && isValidName(title)) return title;
    }
    
    return null;
  }

  // Validate if string looks like a person name
  function isValidName(str) {
    if (!str || str.length < 2 || str.length > 50) return false;
    // Filter out URLs, long text, etc.
    if (str.includes('http') || str.includes('google') || str.includes('meet')) return false;
    // Filter out UI labels
    const uiLabels = ['mic', 'camera', 'present', 'chat', 'people', 'raise hand', 'more', 'cc', 'you', 'me'];
    if (uiLabels.includes(str.toLowerCase())) return false;
    return true;
  }

  // Scan video grid for participant avatars
  function scanVideoGrid() {
    const avatarSelectors = [
      '[data-self-name]',
      '.GvcuGe',
      '.N0PJ8e',
      '.c7CKJ',
      '.zWfAib'
    ];
    
    avatarSelectors.forEach(selector => {
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

  // Report participant event
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

  // Detect self name
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
    
    // Wait for transcript container to appear
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
    
    // Try immediately
    if (!findTranscriptContainer()) {
      // Retry periodically
      const retryInterval = setInterval(() => {
        if (findTranscriptContainer()) {
          clearInterval(retryInterval);
        }
      }, 2000);
      
      // Stop trying after 60 seconds
      setTimeout(() => clearInterval(retryInterval), 60000);
    }
  }

  function observeTranscript(container) {
    // First, extract existing transcript lines
    extractExistingTranscript(container);
    
    // Then observe for new lines
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

  // Track seen transcript lines to avoid duplicates
  let seenTranscriptKeys = new Set();

  function extractTranscriptLine(element) {
    // Try to extract speaker and text
    let speaker = null;
    let text = null;
    
    // Look for speaker name
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
    
    // Look for text content
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
        // If speaker is included in text, extract just the text part
        if (speaker && fullText.startsWith(speaker)) {
          text = fullText.substring(speaker.length).replace(/^:\s*/, '');
        } else {
          text = fullText;
        }
        break;
      }
    }
    
    // Fallback: just get all text from element
    if (!text && element.textContent) {
      const fullText = element.textContent.trim();
      if (fullText) {
        // Try to split speaker and text
        const parts = fullText.split(/:\s*/);
        if (parts.length >= 2 && parts[0].length < 50) {
          speaker = speaker || parts[0];
          text = parts.slice(1).join(': ');
        } else {
          text = fullText;
        }
      }
    }
    
    // Filter out empty or invalid entries
    if (!text || text.length < 2) return;
    
    // Check for duplicate
    const key = `${speaker}-${text}`;
    if (seenTranscriptKeys.has(key)) return;
    seenTranscriptKeys.add(key);
    
    // Limit seen keys size
    if (seenTranscriptKeys.size > 1000) {
      seenTranscriptKeys = new Set(Array.from(seenTranscriptKeys).slice(-500));
    }
    
    const timestamp = new Date().toISOString();
    
    // If no speaker found, try to infer from context
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
    if (warningBanner) return; // Already showing
    
    console.log('[GMR Content] Showing audio warning banner');
    
    warningBanner = document.createElement('div');
    warningBanner.id = 'gmr-audio-warning';
    warningBanner.innerHTML = `
      <div class="gmr-warning-inner">
        <span class="gmr-warning-icon">⚠️</span>
        <span class="gmr-warning-text">
          Your meeting audio will not be recorded unless you turn on the screen share tab audio button.
        </span>
        <button class="gmr-warning-dismiss" title="Dismiss">×</button>
      </div>
    `;
    
    // Add styles
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
        from {
          transform: translateY(-100%);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
      
      @keyframes gmr-warning-slide-up {
        from {
          transform: translateY(0);
          opacity: 1;
        }
        to {
          transform: translateY(-100%);
          opacity: 0;
        }
      }
      
      .gmr-warning-inner {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        max-width: 1200px;
        margin: 0 auto;
      }
      
      .gmr-warning-icon {
        font-size: 16px;
        flex-shrink: 0;
      }
      
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
    
    // Handle dismiss
    const dismissBtn = warningBanner.querySelector('.gmr-warning-dismiss');
    dismissBtn.addEventListener('click', () => {
      dismissAudioWarning();
    });
    
    // Auto-dismiss after 30 seconds
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
    
    // Notify background
    chrome.runtime.sendMessage({ type: 'AUDIO_WARNING_DISMISSED' });
  }

  // ==================== FLOATING CONTROLS ====================

  function showFloatingControls() {
    if (floatingControls) return;
    
    floatingControls = document.createElement('div');
    floatingControls.id = 'gmr-floating-controls';
    floatingControls.innerHTML = `
      <div class="gmr-float-inner">
        <div class="gmr-float-dot"></div>
        <span class="gmr-float-timer">00:00:00</span>
        <span class="gmr-float-participants">👥 <span class="gmr-float-p-count">0</span></span>
        <button class="gmr-float-stop" title="Stop Recording">
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>
        </button>
      </div>
    `;
    
    const style = document.createElement('style');
    style.textContent = `
      #gmr-floating-controls {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        animation: gmr-float-in 0.3s ease;
        transition: opacity 0.3s ease;
      }
      
      @keyframes gmr-float-in {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      
      .gmr-float-inner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        background: rgba(10, 10, 10, 0.7);
        backdrop-filter: blur(60px) saturate(150%);
        -webkit-backdrop-filter: blur(60px) saturate(150%);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 9999px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      }
      
      .gmr-float-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #FF6B8A;
        animation: gmr-pulse 1.5s ease-in-out infinite;
      }
      
      @keyframes gmr-pulse {
        0%, 100% {
          transform: scale(1);
          opacity: 1;
        }
        50% {
          transform: scale(1.4);
          opacity: 0.4;
        }
      }
      
      .gmr-float-timer {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        font-weight: 500;
        color: #fff;
        letter-spacing: -0.5px;
      }
      
      .gmr-float-participants {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #aaa;
      }
      
      .gmr-float-stop {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }
      
      .gmr-float-stop:hover {
        background: #FF6B8A;
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(floatingControls);
    
    // Handle stop button
    const stopBtn = floatingControls.querySelector('.gmr-float-stop');
    stopBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      removeFloatingControls();
    });
    
    // Start timer update
    updateFloatingTimer();
  }

  function removeFloatingControls() {
    if (floatingControls && floatingControls.parentNode) {
      floatingControls.parentNode.removeChild(floatingControls);
    }
    floatingControls = null;
  }

  function updateFloatingTimer() {
    if (!floatingControls) return;
    
    chrome.storage.local.get(['recordingStartTime'], (data) => {
      if (data.recordingStartTime && floatingControls) {
        const elapsed = Date.now() - data.recordingStartTime;
        const timer = floatingControls.querySelector('.gmr-float-timer');
        if (timer) {
          timer.textContent = formatDuration(elapsed);
        }
        requestAnimationFrame(() => updateFloatingTimer());
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

  // Update participant count in floating controls
  function updateParticipantCount(count) {
    if (floatingControls) {
      const countEl = floatingControls.querySelector('.gmr-float-p-count');
      if (countEl) countEl.textContent = count;
    }
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
        isRecording = true;
        showFloatingControls();
        sendResponse({ success: true });
        break;
      case 'HIDE_FLOATING_CONTROLS':
        isRecording = false;
        removeFloatingControls();
        sendResponse({ success: true });
        break;
      case 'PARTICIPANT_COUNT_UPDATE':
        updateParticipantCount(message.count);
        sendResponse({ success: true });
        break;
      default:
        // Ignore unknown messages
        break;
    }
  }

  // ==================== INITIALIZATION ====================

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  // Also try after a delay (for SPA loading)
  setTimeout(initialize, 3000);

})();
