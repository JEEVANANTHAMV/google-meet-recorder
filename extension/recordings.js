// recordings.js - Client-side script for My Recordings dashboard page

document.addEventListener('DOMContentLoaded', () => {
  const recordingsList = document.getElementById('recordingsList');
  const emptyState = document.getElementById('emptyState');
  const recordingsTable = document.getElementById('recordingsTable');
  const btnClearAll = document.getElementById('btnClearAll');

  // Load recordings history and server URL from storage
  async function loadRecordings() {
    chrome.storage.local.get(['recordingHistory', 'wsUrl'], (data) => {
      const history = data.recordingHistory || [];
      const wsUrl = data.wsUrl || 'ws://18.204.127.179:8001';
      const httpBaseUrl = wsUrl.replace(/^ws(s?):/, 'http$1:');

      renderList(history, httpBaseUrl);
    });
  }

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
      } else if (key === 'target') {
        element.setAttribute('target', value);
      } else if (key === 'href') {
        element.setAttribute('href', value);
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
      } else if (child instanceof HTMLElement || child instanceof SVGElement) {
        element.appendChild(child);
      }
    }

    return element;
  }

  // Helper to parse SVG safely using DOMParser (complying with XSS prevention guidelines)
  function parseSVG(svgString) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgString, 'image/svg+xml');
      return doc.documentElement;
    } catch (err) {
      console.error('Failed to parse SVG:', err);
      return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    }
  }

  function renderList(history, httpBaseUrl) {
    // Clear list safely
    recordingsList.replaceChildren();

    if (history.length === 0) {
      recordingsTable.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }

    recordingsTable.classList.remove('hidden');
    emptyState.classList.add('hidden');

    // Sort history by date descending
    const sortedHistory = [...history].sort((a, b) => b.timestamp - a.timestamp);

    for (const item of sortedHistory) {
      const formattedDate = new Date(item.timestamp).toLocaleString();
      // Ids come from meeting URLs / server session ids, so encode them before interpolating.
      const q = `sessionId=${encodeURIComponent(item.sessionId)}&download=1`;
      const base = `${httpBaseUrl}/api/meetings/${encodeURIComponent(item.meetingId)}`;
      const downloadUrl = `${base}/recording?${q}`;
      const transcriptUrl = `${base}/transcript?${q}`;
      const participantsUrl = `${base}/participants?${q}`;

      const downloadIcon = parseSVG(`
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      `);

      // Transcript: lines of text. Participants: people. Distinct shapes so the three download
      // buttons are tellable apart at a glance rather than three identical arrows.
      const transcriptIcon = parseSVG(`
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="16" y2="13"/>
          <line x1="8" y1="17" x2="13" y2="17"/>
        </svg>
      `);

      const participantsIcon = parseSVG(`
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      `);

      const deleteIcon = parseSVG(`
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      `);

      const tr = createDOMElement('tr', {}, [
        // Meeting ID
        createDOMElement('td', { className: 'col-meeting' }, [item.meetingId]),
        // Session ID
        createDOMElement('td', { className: 'col-session' }, [item.sessionId]),
        // Date
        createDOMElement('td', { className: 'col-date' }, [formattedDate]),
        // Status badge
        createDOMElement('td', {}, [
          createDOMElement('span', { className: 'badge-status' }, ['Saved'])
        ]),
        // Actions
        createDOMElement('td', { style: 'text-align: right;' }, [
          createDOMElement('div', { className: 'btn-actions' }, [
            // Download the recorded video
            createDOMElement('a', {
              className: 'btn-icon download',
              href: downloadUrl,
              target: '_blank',
              title: 'Download the recorded video (.webm)'
            }, [
              downloadIcon,
              'Video'
            ]),
            // Download transcript.json. `download` on the anchor is a hint only — these are
            // cross-origin URLs, so the server's Content-Disposition (?download=1) is what actually
            // makes the browser save the file instead of rendering the JSON in a tab.
            createDOMElement('a', {
              className: 'btn-icon data',
              href: transcriptUrl,
              target: '_blank',
              download: '',
              title: 'Download the transcript as JSON'
            }, [
              transcriptIcon,
              'Transcript'
            ]),
            // Download participants.json (join/leave events + roster)
            createDOMElement('a', {
              className: 'btn-icon data',
              href: participantsUrl,
              target: '_blank',
              download: '',
              title: 'Download the participants list as JSON'
            }, [
              participantsIcon,
              'Participants'
            ]),
            // Delete button
            createDOMElement('button', {
              className: 'btn-icon delete',
              onClick: () => deleteRecording(item.sessionId)
            }, [
              deleteIcon,
              'Delete'
            ])
          ])
        ])
      ]);

      recordingsList.appendChild(tr);
    }
  }

  // Delete individual recording
  function deleteRecording(sessionId) {
    if (!confirm('Are you sure you want to remove this recording from history? This does not delete it from the server.')) {
      return;
    }

    chrome.storage.local.get(['recordingHistory'], (data) => {
      const history = data.recordingHistory || [];
      const updated = history.filter(item => item.sessionId !== sessionId);
      chrome.storage.local.set({ recordingHistory: updated }, () => {
        loadRecordings();
      });
    });
  }

  // Clear all history
  btnClearAll.addEventListener('click', () => {
    if (!confirm('Are you sure you want to clear your local recording history? This action is irreversible.')) {
      return;
    }

    chrome.storage.local.set({ recordingHistory: [] }, () => {
      loadRecordings();
    });
  });

  // Initial load
  loadRecordings();
});
