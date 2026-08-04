// Service worker. Sole job: expose the handful of chrome.* APIs the page-world
// scripts cannot reach themselves. Phase 0 only ever calls popupSettingGet.

const HOST_PATTERN = 'https://bacchus.rmm.datto.com/*';
const PRIMARY_URL = 'https://bacchus.rmm.datto.com/';

function popupSettingGet() {
  return new Promise((resolve) => {
    if (!chrome.contentSettings || !chrome.contentSettings.popups) {
      resolve({ ok: false, error: 'chrome.contentSettings.popups unavailable' });
      return;
    }
    chrome.contentSettings.popups.get({ primaryUrl: PRIMARY_URL }, (details) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, setting: details && details.setting });
    });
  });
}

// Phase 2 uses these. Present now so the wiring is proven, but Phase 0 never calls them.
function popupSettingSet(setting) {
  return new Promise((resolve) => {
    if (!chrome.contentSettings || !chrome.contentSettings.popups) {
      resolve({ ok: false, error: 'chrome.contentSettings.popups unavailable' });
      return;
    }
    chrome.contentSettings.popups.set(
      { primaryPattern: HOST_PATTERN, setting },
      () => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true, setting });
      }
    );
  });
}

function popupSettingClear() {
  return new Promise((resolve) => {
    if (!chrome.contentSettings || !chrome.contentSettings.popups) {
      resolve({ ok: false, error: 'chrome.contentSettings.popups unavailable' });
      return;
    }
    chrome.contentSettings.popups.clear({}, () => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, cleared: true });
    });
  });
}

// Log relay. The page world cannot reach chrome.*, and an https page posting to
// http://localhost is awkward, so log batches are forwarded from here instead -
// extension fetch with host_permissions is not subject to page CORS/mixed content.
const SINK = 'http://localhost:4200/';
let sinkAlive = null; // null = unknown, true/false = last known

async function logPost(args) {
  if (sinkAlive === false) return { ok: false, error: 'sink offline' };
  try {
    const r = await fetch(SINK + 'log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: (args && args.entries) || [] })
    });
    sinkAlive = r.ok;
    return { ok: r.ok };
  } catch (e) {
    // Sink not running is the normal case - fail quietly and stop retrying hard.
    sinkAlive = false;
    setTimeout(() => { sinkAlive = null; }, 20000); // allow a later retry
    return { ok: false, error: String(e) };
  }
}

const OPS = {
  popupSettingGet: () => popupSettingGet(),
  popupSettingAllow: () => popupSettingSet('allow'),
  popupSettingBlock: () => popupSettingSet('block'),
  popupSettingClear: () => popupSettingClear(),
  log: (args) => logPost(args),
  logClear: async () => {
    try {
      const r = await fetch(SINK + 'clear', { method: 'POST', body: '{}' });
      return { ok: r.ok };
    } catch (e) { return { ok: false, error: String(e) }; }
  },
  ping: async () => ({ ok: true, version: chrome.runtime.getManifest().version })
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = msg && OPS[msg.op];
  if (!fn) {
    sendResponse({ ok: false, error: 'unknown op: ' + (msg && msg.op) });
    return false;
  }
  fn(msg.args)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async
});
