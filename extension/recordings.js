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
      const downloadUrl = `${httpBaseUrl}/api/meetings/${item.meetingId}/recording?sessionId=${item.sessionId}&download=1`;

      const downloadIcon = parseSVG(`
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
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
            // Download button
            createDOMElement('a', {
              className: 'btn-icon download',
              href: downloadUrl,
              target: '_blank'
            }, [
              downloadIcon,
              'Download'
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
