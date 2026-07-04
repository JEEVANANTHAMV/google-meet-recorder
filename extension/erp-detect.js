// erp-detect.js — presence beacon for the BETA ERP web app.
//
// Runs at document_start on ERP pages and announces that the Google Meet Recorder extension is
// installed, so the ERP can show staff/admins an "install the recorder" prompt only when it's
// missing. Detection is extension-ID independent (works for unpacked/sideloaded installs):
//   1) a synchronous DOM marker on <html> (read immediately by the page), and
//   2) a window.postMessage GMR_PING/GMR_PONG handshake (for pages that load before us).

(function () {
  try {
    var VERSION = '1.0.0';
    try {
      if (chrome && chrome.runtime && chrome.runtime.getManifest) {
        VERSION = chrome.runtime.getManifest().version || VERSION;
      }
    } catch (e) { /* ignore */ }

    // 1) DOM marker — present before the page's scripts run.
    document.documentElement.setAttribute('data-gmr-extension', VERSION);

    // 2) Handshake — reply to the page's ping and also announce proactively.
    var announce = function () {
      window.postMessage({ type: 'GMR_PONG', installed: true, version: VERSION }, '*');
    };
    window.addEventListener('message', function (e) {
      if (e.source !== window || !e.data || e.data.type !== 'GMR_PING') return;
      announce();
    });
    if (document.readyState === 'interactive' || document.readyState === 'complete') announce();
    window.addEventListener('DOMContentLoaded', announce);
    window.addEventListener('load', announce);
  } catch (e) {
    /* never break the host page */
  }
})();
