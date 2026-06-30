// permission.js - Requests microphone permission from a full extension page (reliable prompt).
// Granting here persists for the whole extension origin, so the offscreen recorder can then
// capture and mix in the local microphone.

const statusEl = document.getElementById('status');
const retryBtn = document.getElementById('retry');

async function requestMic() {
  statusEl.textContent = 'Requesting microphone permission…';
  statusEl.className = '';
  retryBtn.style.display = 'none';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // we only needed the permission grant
    await chrome.storage.local.set({ micEnabled: true });
    statusEl.textContent = '✅ Microphone enabled! Your voice will be included in recordings. Closing this tab...';
    statusEl.className = 'ok';
    setTimeout(() => {
      window.close();
    }, 1500);
  } catch (err) {
    await chrome.storage.local.set({ micEnabled: false });
    statusEl.textContent = '❌ Microphone permission was not granted (' + err.name + '). Allow it (address-bar icon or chrome settings), then click “Request again”.';
    statusEl.className = 'err';
    retryBtn.style.display = 'inline-block';
  }
}

retryBtn.addEventListener('click', requestMic);
requestMic();
