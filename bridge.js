// ISOLATED world. Relays control messages between the MAIN-world panel and the
// service worker, because MAIN world has no chrome.* APIs.
//
// Control messages ONLY. A MediaStream is not structured-cloneable and must
// never be sent across this bridge - the stream work all stays in MAIN world.

(function () {
  'use strict';

  var ORIGIN = location.origin;

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__wrmm !== 'req' || typeof d.id !== 'number') return;

    try {
      chrome.runtime.sendMessage({ op: d.op, args: d.args }, function (res) {
        var lastErr = chrome.runtime.lastError;
        window.postMessage({
          __wrmm: 'res',
          id: d.id,
          res: lastErr ? { ok: false, error: lastErr.message } : res
        }, ORIGIN);
      });
    } catch (e) {
      window.postMessage({
        __wrmm: 'res',
        id: d.id,
        res: { ok: false, error: String(e) }
      }, ORIGIN);
    }
  });

  // Let the panel know the bridge exists at all.
  window.postMessage({ __wrmm: 'bridge-ready' }, ORIGIN);
})();
