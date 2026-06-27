// test-meet-dom.js
// Automated test: navigates to a Google Meet link, inspects DOM, and reports
// whether the extension's participant/transcript selectors would find anything.
//
// Usage:
//   npx playwright install chromium
//   node test-meet-dom.js --meet <meet-link>
//   node test-meet-dom.js --meet <meet-link> --wait 30
//
// The --meet link can be any active Meet URL like https://meet.google.com/abc-defg-hij
// The --wait flag sets seconds to wait in the room before scanning (default 15).

const { chromium } = require('playwright');

// ---------- CLI args ----------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { meet: null, wait: 15, reportFile: null, debug: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--meet' && args[i + 1]) opts.meet = args[++i];
    if (args[i] === '--wait' && args[i + 1]) opts.wait = parseInt(args[++i], 10);
    if (args[i] === '--report' && args[i + 1]) opts.reportFile = args[++i];
    if (args[i] === '--debug') opts.debug = true;
  }
  return opts;
}

const opts = parseArgs();

if (!opts.meet) {
  console.error('Usage: node test-meet-dom.js --meet <meet-url> [--wait seconds] [--report file.json] [--debug]');
  console.error('Example: node test-meet-dom.js --meet https://meet.google.com/abc-defg-hij --wait 30');
  process.exit(1);
}

// ---------- Selector groups from the extension ----------
const PARTICIPANT_SELECTORS = {
  // From content.js setupParticipantTracking / scanForParticipants
  participantList: [
    '[data-participant-id]',
    '[jscontroller] [role="listitem"] .zWfAib',
    '.KV1GEc',
    '.dwSJ2e',
    '[role="listitem"]',
  ],
  participantName: [
    '.zWfAib',
    '.KV1GEc .zWfAib',
    '.dwSJ2e .zWfAib',
    '[data-self-name]',
    '.GvcuGe',
    '.N0PJ8e',
  ],
  participantNameAlt: [
    '.GvcuGe',
    '.N0PJ8e',
    '.c7CKJ',
    '.cG2ZCf',
    '.YTbUzc',
    '.jV5ceb',
    '[data-self-name]',
    '.zWfAib',
  ],
  avatarTitle: '[data-self-name], [title]',
};

const TRANSSCRIPT_SELECTORS = {
  transcriptContainer: [
    '.V6Yesc',
    '.a4cQT',
    '.Mz6pEf',
    '[jsname="tgaKEf"]',
    '.bY93Qe',
    '.TBMuR',
  ],
  transcriptLine: [
    '.TBMuR',
    '.bY93Qe',
    '.Mz6pEf',
    '.V6Yesc > div',
  ],
  transcriptSpeaker: [
    '.PABS8e',
    '.Mz6pEf .PABS8e',
    '.TBMuR .PABS8e',
    '[class*="name"]',
    '.zWfAib',
  ],
  transcriptText: [
    '.bY97s',
    '.V6Yesc span:last-child',
    '.TBMuR span:last-child',
    'span:last-child',
  ],
};

const MEETING_SELECTORS = {
  meetingTitle: [
    '[data-meeting-title]',
    '.N6dS8c',
    '.Jyj1Td',
    '.CkXZgc',
  ],
  selfName: '[data-self-name], .GvcuGe',
  participantCount: [
    '[aria-label*="show everyone" i]',
    '[aria-label*="people" i]',
    '[aria-label*="participant" i]',
    '.AwUel',
    '.Lulu7c',
    '[jsname="muIDxc"]',
    '[jsname="U26qK"]',
  ],
};

const ACCESSIBILITY_SELECTORS = {
  roleListitem: '[role="listitem"]',
  ariaLabelParticipant: '[aria-label*="participant" i]',
  ariaLabelPeople: '[aria-label*="people" i]',
  ariaLabelShowEveryone: '[aria-label*="show everyone" i]',
  ariaHidden: '[aria-hidden]',
  ariaPressed: '[aria-pressed]',
  dataAttributes: '[data-participant-id], [data-self-name], [data-meeting-title]',
  buttons: 'button[aria-label]',
};

// ---------- Test harness ----------
const results = {
  meetUrl: opts.meet,
  timestamp: new Date().toISOString(),
  meetingId: null,
  tests: [],
  summary: { total: 0, passed: 0, failed: 0, warnings: 0 },
  debugInfo: {
    pageUrl: null,
    pageTitle: null,
    bodySnapshot: null,
  },
};

function record(label, status, detail = '') {
  const s = results.summary;
  s.total++;
  if (status === 'pass') s.passed++;
  else if (status === 'fail') s.failed++;
  else s.warnings++;

  results.tests.push({ label, status, detail });
  const icon = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN';
  console.log(`  [${icon}] ${label}` + (detail ? ` — ${detail}` : ''));
}

async function testSelectorGroup(page, groupLabel, selectors) {
  console.log(`\n  ── ${groupLabel} ──`);
  let anyMatch = false;
  for (const sel of selectors) {
    const count = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
    if (count > 0) {
      record(`${groupLabel}: "${sel}"`, 'pass', `${count} elements found`);
      anyMatch = true;
    } else {
      record(`${groupLabel}: "${sel}"`, 'fail', `0 elements found`);
    }
  }
  return anyMatch;
}

async function extractParticipantData(page) {
  console.log('\n  ── Participant Data Extraction ──');
  const participants = await page.evaluate(() => {
    const found = [];

    // Strategy 1: data-participant-id
    document.querySelectorAll('[data-participant-id]').forEach(el => {
      const name = el.textContent?.trim()?.substring(0, 50);
      if (name && name.length > 1) found.push({ strategy: 'data-participant-id', name, selector: '[data-participant-id]' });
    });

    // Strategy 2: data-self-name
    document.querySelectorAll('[data-self-name]').forEach(el => {
      const name = el.getAttribute('data-self-name');
      if (name) found.push({ strategy: 'data-self-name', name, selector: '[data-self-name]' });
    });

    // Strategy 3: role=listitem children
    document.querySelectorAll('[role="listitem"]').forEach(el => {
      const nameEl = el.querySelector('.zWfAib, .GvcuGe, .N0PJ8e');
      const name = nameEl?.textContent?.trim()?.substring(0, 50);
      if (name && name.length > 1 && name.includes(' ')) {
        found.push({ strategy: 'role=listitem + class', name, selector: '[role="listitem"] > .zWfAib etc.' });
      }
    });

    // Strategy 4: aria-label on buttons that reference people
    document.querySelectorAll('button[aria-label*="person" i], button[aria-label*="participant" i]').forEach(el => {
      const label = el.getAttribute('aria-label');
      found.push({ strategy: 'aria-label', name: label?.substring(0, 80), selector: 'button[aria-label]' });
    });

    // Deduplicate by name
    const seen = new Set();
    return found.filter(p => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  });

  if (participants.length > 0) {
    record('Participant data extracted', 'pass', `${participants.length} unique participants found`);
    participants.forEach(p => {
      console.log(`        → "${p.name}" (via ${p.strategy})`);
    });
  } else {
    record('Participant data extracted', 'fail', 'No participants found — may need to open participant panel');
  }
  return participants;
}

async function extractAccessibilityInfo(page) {
  console.log('\n  ── Accessibility Attributes ──');
  const info = await page.evaluate(() => {
    const ariaLabels = [];
    const roles = {};
    const dataAttrs = [];

    // Collect all aria-labels
    document.querySelectorAll('[aria-label]').forEach(el => {
      const label = el.getAttribute('aria-label');
      if (label && label.length < 200) {
        ariaLabels.push({ tag: el.tagName, label, role: el.getAttribute('role') || 'none' });
      }
    });

    // Count roles
    ['listitem', 'button', 'listbox', 'treeitem', 'dialog', 'heading', 'img', 'navigation', 'region', 'tab', 'tablist', 'toolbar'].forEach(r => {
      const count = document.querySelectorAll(`[role="${r}"]`).length;
      if (count > 0) roles[r] = count;
    });

    // Collect data-* attributes used by Meet
    document.querySelectorAll('[class*="zWf"], [class*="KV1"], [class*="dwS"], [class*="cG2"], [class*="YTb"]').forEach(el => {
      const classes = el.className?.toString()?.substring(0, 80);
      const attrs = Array.from(el.attributes).map(a => `${a.name}="${a.value?.substring(0, 50)}"`).join(', ');
      dataAttrs.push({ tag: el.tagName, classes, attrs: attrs?.substring(0, 120) });
    });

    return {
      ariaLabels: ariaLabels.slice(0, 50),
      roles,
      dataAttrs: dataAttrs.slice(0, 30),
    };
  });

  record('Accessibility attributes found', 'pass', `${info.ariaLabels.length} aria-labels, ${Object.keys(info.roles).length} role types`);
  if (opts.debug) {
    console.log('\n  Top aria-labels:');
    info.ariaLabels.slice(0, 15).forEach(a => {
      console.log(`        <${a.tag}> aria-label="${a.label}" role="${a.role}"`);
    });
    console.log('\n  Role counts:');
    Object.entries(info.roles).forEach(([r, c]) => {
      console.log(`        [role="${r}"] = ${c} elements`);
    });
  }
  return info;
}

async function checkMeetState(page) {
  console.log('\n  ── Meet Room State ──');
  const state = await page.evaluate(() => {
    // Check if we're actually in a meeting room (not lobby)
    const hasLeaveBtn = document.querySelector('[aria-label*="leave" i], [aria-label*="salir" i]');
    const hasReturnHome = Array.from(document.querySelectorAll('button, a')).some(
      el => /return to home|volver a la pantalla/i.test(el.textContent || '')
    );
    const hasMuteBtn = document.querySelector('[aria-label*="mute" i], [aria-label*="deactivate" i]');
    const hasCameraBtn = document.querySelector('[aria-label*="camera" i], [aria-label*="videocam" i]');
    const hasPresentBtn = document.querySelector('[aria-label*="present" i], [aria-label*="presente" i]');
    const urlPath = window.location.pathname;

    return {
      hasLeaveBtn: !!hasLeaveBtn,
      hasReturnHome,
      hasMuteBtn: !!hasMuteBtn,
      hasCameraBtn: !!hasCameraBtn,
      hasPresentBtn: !!hasPresentBtn,
      urlPath,
      pageTitle: document.title?.substring(0, 80),
    };
  });

  const inMeeting = state.hasLeaveBtn || state.hasMuteBtn;
  const inLobby = !state.hasMuteBtn && !state.hasLeaveBtn;
  const ended = state.hasReturnHome;

  if (inMeeting) {
    record('Meet room state', 'pass', 'In active meeting (leave/mute buttons found)');
  } else if (ended) {
    record('Meet room state', 'warn', 'Meeting has ended (return home button found)');
  } else if (inLobby) {
    record('Meet room state', 'warn', 'In meeting lobby — have not joined yet');
  } else {
    record('Meet room state', 'fail', 'Could not determine meeting state');
  }

  record('URL path', 'pass', state.urlPath);
  record('Page title', 'pass', state.pageTitle);
  return state;
}

// ---------- Main ----------
(async () => {
  console.log(`\n=== Google Meet DOM Capture Test ===`);
  console.log(`URL: ${opts.meet}`);
  console.log(`Wait: ${opts.wait}s | Debug: ${opts.debug}`);
  console.log(`Started: ${new Date().toLocaleString()}`);

  // Extract meeting ID
  const match = opts.meet.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  results.meetingId = match ? match[1] : opts.meet;
  console.log(`Meeting ID: ${results.meetingId}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Collect console logs
  const consoleLogs = [];
  page.on('console', msg => {
    consoleLogs.push({ type: msg.type(), text: msg.text().substring(0, 200) });
  });

  try {
    // Navigate
    console.log(`\nNavigating to ${opts.meet}...`);
    await page.goto(opts.meet, { waitUntil: 'domcontentloaded', timeout: 30000 });
    record('Page navigation', 'pass', `Loaded in ${Date.now()}ms`);
    results.debugInfo.pageUrl = page.url();
    results.debugInfo.pageTitle = await page.title();

    // Wait for DOM to stabilize
    console.log(`Waiting ${opts.wait}s for Meet to fully load...`);
    await page.waitForTimeout(opts.wait * 1000);

    // ---- Tests ----

    // 1. Meeting state
    await checkMeetState(page);

    // 2. Meeting ID from URL
    const urlMeetingId = await page.evaluate(() => {
      const m = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
      return m ? m[1] : null;
    });
    record('Meeting ID from URL', urlMeetingId ? 'pass' : 'fail', urlMeetingId || 'No meeting ID pattern found');

    // 3. CSS selectors — Participants
    const pMatch = await testSelectorGroup(page, 'Participant Selectors', [
      ...PARTICIPANT_SELECTORS.participantList,
      ...PARTICIPANT_SELECTORS.participantName,
      PARTICIPANT_SELECTORS.participantNameAlt.join(', '),
      '[data-participant-id]',
      '[data-self-name]',
      '.c7CKJ',
      '.cG2ZCf',
      '.YTbUzc',
    ]);

    // 4. CSS selectors — Transcript
    const tMatch = await testSelectorGroup(page, 'Transcript Selectors', [
      ...TRANSSCRIPT_SELECTORS.transcriptContainer,
      ...TRANSSCRIPT_SELECTORS.transcriptLine,
      '.PABS8e',
      '.bY97s',
    ]);

    // 5. CSS selectors — Meeting info
    await testSelectorGroup(page, 'Meeting Info Selectors', [
      ...MEETING_SELECTORS.meetingTitle,
      MEETING_SELECTORS.selfName,
    ]);

    // 6. Accessibility selectors
    const accMatch = await testSelectorGroup(page, 'Accessibility Selectors', [
      ACCESSIBILITY_SELECTORS.roleListitem,
      ACCESSIBILITY_SELECTORS.ariaLabelParticipant,
      ACCESSIBILITY_SELECTORS.dataAttributes,
      ACCESSIBILITY_SELECTORS.buttons,
    ]);

    // 7. Participant data extraction
    const participants = await extractParticipantData(page);

    // 8. Accessibility info extraction
    const accInfo = await extractAccessibilityInfo(page);

    // 9. Screenshot for visual debugging
    const screenshotPath = `tests/screenshots/meet-dom-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    record('Screenshot saved', 'pass', screenshotPath);

    // 10. Accessibility tree snapshot
    const snapshotPath = `tests/screenshots/meet-dom-${Date.now()}-snapshot.txt`;
    const snapshot = await page.accessibility.snapshot();
    require('fs').writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    record('Accessibility snapshot saved', 'pass', snapshotPath);

    // -- Summary --
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  Total tests:  ${results.summary.total}`);
    console.log(`  Passed:       ${results.summary.passed}`);
    console.log(`  Failed:       ${results.summary.failed}`);
    console.log(`  Warnings:     ${results.summary.warnings}`);
    console.log(`  Participants: ${participants.length} found`);
    console.log(`  CSS selectors working:      ${pMatch ? 'YES' : 'NO'}`);
    console.log(`  Caption selectors working:  ${tMatch ? 'YES' : 'NO'}`);
    console.log(`  Accessibility selectors:    ${accMatch ? 'YES' : 'NO'}`);

    // Verdict
    if (results.summary.failed === 0) {
      console.log(`\n  VERDICT: All selectors are working.`);
    } else {
      const failRate = results.summary.failed / results.summary.total;
      if (failRate > 0.7) {
        console.log(`\n  VERDICT: CRITICAL — Most selectors are broken. Extension will NOT work.`);
      } else if (failRate > 0.3) {
        console.log(`\n  VERDICT: WARNING — Many selectors are broken. Participant/caption tracking will be unreliable.`);
      } else {
        console.log(`\n  VERDICT: MOSTLY OK — Some CSS class names may have changed, but fallback selectors may still work.`);
      }
    }

    // Recommendations
    if (!pMatch && accMatch) {
      console.log(`\n  RECOMMENDATION: Replace CSS class selectors with accessibility-based selectors.`,
        `role/listitem and aria-label selectors ARE working.`);
    }
    if (!pMatch && !accMatch) {
      console.log(`\n  RECOMMENDATION: None of the selectors work. The Meet DOM likely changed.`,
        `Check the accessibility snapshot for new selectors.`);
    }

    console.log(`\n  Artifacts:`);
    console.log(`    Screenshot:         ${screenshotPath}`);
    console.log(`    Accessibility tree: ${snapshotPath}`);

  } catch (err) {
    console.error(`\nTEST ERROR: ${err.message}`);
    record('Overall', 'fail', err.message);
  } finally {
    await browser.close();
  }

  // Write report
  const reportPath = opts.reportFile || 'tests/report.json';
  require('fs').mkdirSync('tests/screenshots', { recursive: true });
  require('fs').writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n  Full report: ${reportPath}`);
})();
