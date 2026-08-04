// ============================================================================
// WR Multi-Monitor Popout PoC - app.js
// MAIN world, run_at: document_idle.
//
// One button under the minimap. One click pops every remote monitor into its own
// cascaded window, blanks the in-tab view, and forwards input back to the session.
//
// Frame source is surface-agnostic. The live page paints the remote screen into a
// <canvas> (one peer connection, zero incoming media tracks), so captureStream()
// on that canvas yields a real MediaStream without touching the session. The same
// crop-and-bind path also works if a client ever switches to a <video>.
//
// Confirmed on the live page: cross-document MediaStream binding renders, and the
// origin sends no COOP header, so about:blank popups can share the stream.
// ============================================================================

(function () {
  'use strict';

  if (window.__WRMM_APP__) return;
  window.__WRMM_APP__ = true;

  var HOOK = window.__WRMM_HOOK__ || null;
  var BTN_ID = 'wrmm-popout-btn';
  var STATUS_ID = 'wrmm-popout-status';
  var BLANK_ID = 'wrmm-blanket';

  var state = {
    source: null,
    monitors: null,
    popouts: [],
    lastTrackId: null,
    inputEnabled: true,
    detection: null
  };

  // ---- logging ------------------------------------------------------------
  // Batched to tools/logsink.ps1 (see README). If the sink is not running these
  // calls are cheap no-ops - nothing depends on logging being available.
  var logBuf = [];
  var logSrc = (window === window.top ? 'top' : 'frame');

  function wlog(level, msg, data) {
    try {
      logBuf.push({
        t: new Date().toISOString().slice(11, 23),
        level: level, src: logSrc, msg: String(msg),
        data: data === undefined ? null : data
      });
      if (logBuf.length > 400) logBuf.shift();
    } catch (e) {}
  }

  setInterval(function () {
    if (!logBuf.length) return;
    var batch = logBuf.splice(0, 60);
    rpc('log', { entries: batch });
  }, 1500);

  function say(msg, cls) {
    var el = document.getElementById(STATUS_ID);
    if (el) {
      el.textContent = msg;
      el.className = 'wrmm-status' + (cls ? ' wrmm-' + cls : '');
    }
    wlog(cls === 'bad' ? 'error' : (cls === 'warn' ? 'warn' : 'info'), msg);
    try { console.info('[WRMM] ' + msg); } catch (e) {}
  }

  // ---- bridge RPC ---------------------------------------------------------
  var rpcSeq = 0, rpcPending = {};
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (d && d.__wrmm === 'res' && rpcPending[d.id]) { rpcPending[d.id](d.res); delete rpcPending[d.id]; }
  });
  function rpc(op, args) {
    return new Promise(function (resolve) {
      var id = ++rpcSeq, done = false;
      rpcPending[id] = function (r) { if (!done) { done = true; resolve(r); } };
      window.postMessage({ __wrmm: 'req', id: id, op: op, args: args }, location.origin);
      setTimeout(function () { if (!done) { done = true; delete rpcPending[id]; resolve({ ok: false, error: 'bridge timeout' }); } }, 3000);
    });
  }

  // ========================================================================
  // Frame source
  // ========================================================================
  var captureCache = null;

  function getSource(force) {
    if (state.source && !force) {
      var t = state.source.track;
      if (t && t.readyState === 'live' && state.source.el.isConnected) return state.source;
    }

    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i], so = null;
      try { so = v.srcObject; } catch (e) {}
      if (so && so.getVideoTracks && so.getVideoTracks().length && v.videoWidth) {
        state.source = { kind: 'video', el: v, width: v.videoWidth, height: v.videoHeight, stream: so, track: so.getVideoTracks()[0] };
        return state.source;
      }
    }

    // Largest canvas by INTRINSIC size. Rendered size is unreliable (a narrow
    // viewport wrongly rejects the composite); intrinsic size also excludes the
    // minimap, which is small in its own right.
    var best = null, bestArea = 0;
    var cans = document.querySelectorAll('canvas');
    for (var k = 0; k < cans.length; k++) {
      var c = cans[k];
      if (c.width < 640 || c.height < 360) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (c.width * c.height > bestArea) { bestArea = c.width * c.height; best = c; }
    }
    if (best) {
      try {
        if (!captureCache || captureCache.canvas !== best || !captureCache.stream.active) {
          captureCache = { canvas: best, stream: best.captureStream(30) };
        }
        state.source = {
          kind: 'canvas', el: best, width: best.width, height: best.height,
          stream: captureCache.stream, track: captureCache.stream.getVideoTracks()[0]
        };
        return state.source;
      } catch (e) { say('canvas captureStream failed: ' + e, 'bad'); }
    }

    state.source = null;
    return null;
  }

  // ========================================================================
  // Monitor geometry
  // ========================================================================

  // Read frames from a <video> fed by the captured stream rather than reading the
  // app's canvas directly. A WebGL canvas without preserveDrawingBuffer reads back
  // blank via drawImage, and this also guarantees we analyse exactly the pixels the
  // popouts will show.
  var analysisVideo = null;
  function getAnalysisElement(source) {
    if (source.kind === 'video') return Promise.resolve({ el: source.el, width: source.width, height: source.height });
    return new Promise(function (resolve) {
      var fallback = { el: source.el, width: source.width, height: source.height };
      try {
        if (!analysisVideo) {
          analysisVideo = document.createElement('video');
          analysisVideo.muted = true;
          analysisVideo.autoplay = true;
          analysisVideo.playsInline = true;
          analysisVideo.setAttribute('aria-hidden', 'true');
          analysisVideo.style.cssText = 'position:fixed;left:-20px;top:-20px;width:2px;height:2px;opacity:0.01;pointer-events:none;';
          document.body.appendChild(analysisVideo);
        }
        if (analysisVideo.srcObject !== source.stream) {
          analysisVideo.srcObject = source.stream;
          var p = analysisVideo.play();
          if (p && p.catch) p.catch(function () {});
        }
        var tries = 0;
        var t = setInterval(function () {
          if (analysisVideo.videoWidth || ++tries > 40) {
            clearInterval(t);
            resolve(analysisVideo.videoWidth
              ? { el: analysisVideo, width: analysisVideo.videoWidth, height: analysisVideo.videoHeight }
              : fallback);
          }
        }, 100);
      } catch (e) { resolve(fallback); }
    });
  }

  // Union occupancy across several frames, so a briefly-black window or a moving
  // cursor cannot shrink a monitor's detected bounds.
  //
  // Grid resolution matters more than anything else here. The live endpoint packs
  // monitors nearly edge to edge - the seam measured about 12 composite pixels -
  // so a coarse grid cannot see the gap at all. Hence a fine cell and a tolerant
  // blank test rather than requiring a strictly empty line.
  function sampleOccupancy(src, samples, intervalMs) {
    var w = src.width, h = src.height;
    var cell = Math.min(8, Math.max(2, Math.floor(Math.min(w, h) / 600)));
    var gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    var grid = new Uint8Array(gw * gh);
    var THRESH = 14;
    var stride = Math.max(1, Math.floor(cell / 2));

    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    var litTotal = 0;
    // Per-cell colour from the most recent frame, kept so boundaries can be found
    // when monitors are packed with no gap. Colour, not luminance: two wallpapers
    // often differ in hue at near-identical brightness, and luminance-only edges
    // are dominated by white text inside a monitor rather than the seam between two.
    var rgb = new Uint8Array(gw * gh * 3);

    function pass() {
      try { ctx.drawImage(src.el, 0, 0, w, h); } catch (e) { return; }
      var data;
      try { data = ctx.getImageData(0, 0, w, h).data; } catch (e) { return; }
      for (var y = 0; y < h; y += stride) {
        var ri = Math.floor(y / cell) * gw;
        for (var x = 0; x < w; x += stride) {
          var i = (y * w + x) * 4;
          var l = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
          var gi = ri + Math.floor(x / cell);
          if (l > THRESH) grid[gi] = 1;
          rgb[gi * 3] = data[i];
          rgb[gi * 3 + 1] = data[i + 1];
          rgb[gi * 3 + 2] = data[i + 2];
        }
      }
    }

    return new Promise(function (resolve) {
      var n = 0;
      pass();
      var t = setInterval(function () {
        pass();
        if (++n >= (samples || 4)) {
          clearInterval(t);
          for (var i = 0; i < grid.length; i++) if (grid[i]) litTotal++;
          resolve({
            grid: grid, rgb: rgb, gw: gw, gh: gh, cell: cell, width: w, height: h,
            litFraction: +(litTotal / grid.length).toFixed(4)
          });
        }
      }, intervalMs || 110);
    });
  }

  // Recursive gutter splitting (guillotine cuts).
  //
  // Connected-component labelling was the first attempt and it merged monitors:
  // the real composite is a 2D arrangement, and any diagonal touch or shared
  // bright edge fuses two monitors into one blob. Instead: trim to lit content,
  // find the widest fully-black row or column run spanning the whole region,
  // split there, recurse. That is exactly the structure a tiled composite has.
  function splitRegions(occ) {
    var gw = occ.gw, gh = occ.gh, grid = occ.grid;
    var widestSeen = { size: 0, vertical: null }; // diagnostics when no cut is found

    function colCount(x, y0, y1) {
      var n = 0;
      for (var y = y0; y <= y1; y++) if (grid[y * gw + x]) n++;
      return n;
    }
    function rowCount(y, x0, x1) {
      var n = 0, base = y * gw;
      for (var x = x0; x <= x1; x++) if (grid[base + x]) n++;
      return n;
    }
    // Tolerant blankness. A strictly-empty test is too brittle: one stray bright
    // pixel bridging the seam (a cursor, an antialiased window edge) would hide an
    // otherwise obvious gap.
    function blankTol(len) { return Math.max(1, Math.floor(len * 0.004)); }
    function colLit(x, y0, y1) { return colCount(x, y0, y1) > blankTol(y1 - y0 + 1); }
    function rowLit(y, x0, x1) { return rowCount(y, x0, x1) > blankTol(x1 - x0 + 1); }

    function trim(r) {
      while (r.x0 <= r.x1 && !colLit(r.x0, r.y0, r.y1)) r.x0++;
      while (r.x1 >= r.x0 && !colLit(r.x1, r.y0, r.y1)) r.x1--;
      while (r.y0 <= r.y1 && !rowLit(r.y0, r.x0, r.x1)) r.y0++;
      while (r.y1 >= r.y0 && !rowLit(r.y1, r.x0, r.x1)) r.y1--;
      return (r.x1 >= r.x0 && r.y1 >= r.y0) ? r : null;
    }

    // Widest interior run of fully-blank lines. After trimming, both edges are
    // lit, so any blank run found is necessarily interior.
    function widestRun(r, vertical) {
      var lo = vertical ? r.x0 : r.y0;
      var hi = vertical ? r.x1 : r.y1;
      var a0 = vertical ? r.y0 : r.x0;
      var a1 = vertical ? r.y1 : r.x1;
      var best = null, runStart = -1;
      for (var i = lo; i <= hi; i++) {
        var isLit = vertical ? colLit(i, a0, a1) : rowLit(i, a0, a1);
        if (!isLit) {
          if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
          var size = i - runStart;
          if (!best || size > best.size) best = { start: runStart, end: i - 1, size: size };
          runStart = -1;
        }
      }
      return best;
    }

    var regions = [];
    // Two cells at this grid resolution is roughly 8px - enough to reject a dark
    // band inside one monitor's content, small enough to see a real seam.
    var MIN_GUTTER_CELLS = 2;

    function split(r, depth) {
      r = trim(r);
      if (!r) return;
      if (depth > 5 || regions.length >= 8) { regions.push(r); return; }

      var v = widestRun(r, true);
      var h = widestRun(r, false);
      var pick = null, vertical = false;
      if (v && (!h || v.size >= h.size)) { pick = v; vertical = true; }
      else if (h) { pick = h; vertical = false; }

      if (pick && pick.size > widestSeen.size) {
        widestSeen = { size: pick.size, vertical: vertical };
      }
      if (!pick || pick.size < MIN_GUTTER_CELLS) { regions.push(r); return; }

      if (vertical) {
        split({ x0: r.x0, x1: pick.start - 1, y0: r.y0, y1: r.y1 }, depth + 1);
        split({ x0: pick.end + 1, x1: r.x1, y0: r.y0, y1: r.y1 }, depth + 1);
      } else {
        split({ x0: r.x0, x1: r.x1, y0: r.y0, y1: pick.start - 1 }, depth + 1);
        split({ x0: r.x0, x1: r.x1, y0: pick.end + 1, y1: r.y1 }, depth + 1);
      }
    }

    split({ x0: 0, x1: gw - 1, y0: 0, y1: gh - 1 }, 0);

    var cell = occ.cell;
    var boxes = regions.map(function (r) {
      var x = r.x0 * cell, y = r.y0 * cell;
      return {
        x: x, y: y,
        width: Math.min(occ.width - x, (r.x1 - r.x0 + 1) * cell),
        height: Math.min(occ.height - y, (r.y1 - r.y0 + 1) * cell)
      };
    }).filter(function (m) { return m.width > 80 && m.height > 60; });
    boxes.widestGapPx = widestSeen.size * cell;
    boxes.widestGapAxis = widestSeen.vertical === null ? null : (widestSeen.vertical ? 'vertical' : 'horizontal');
    boxes.minGapPx = MIN_GUTTER_CELLS * cell;
    return boxes;
  }

  // Any monitor list the page exposes, purely as a count cross-check.
  function metadataMonitorCount() {
    var found = [];
    function scan(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth <= 0) return;
      if (Array.isArray(obj)) {
        if (obj.length >= 2 && obj.length <= 16 && obj.every(function (o) {
          return o && typeof o === 'object' &&
            typeof (o.width !== undefined ? o.width : o.Width) === 'number' &&
            typeof (o.height !== undefined ? o.height : o.Height) === 'number';
        })) found.push(obj.length);
        for (var i = 0; i < obj.length && i < 20; i++) scan(obj[i], depth - 1);
        return;
      }
      var keys;
      try { keys = Object.keys(obj); } catch (e) { return; }
      for (var k = 0; k < keys.length && k < 40; k++) {
        if (/^(parent|__react|stateNode|return|memoizedState|ownerDocument)/.test(keys[k])) continue;
        try { scan(obj[keys[k]], depth - 1); } catch (e) {}
      }
    }
    try {
      if (HOOK) {
        var m = HOOK.collectMessages();
        Object.keys(m.firstByType).forEach(function (t) {
          var rec = m.firstByType[t];
          if (rec && rec.parsed) scan(rec.parsed, 6);
        });
      }
    } catch (e) {}
    if (!found.length) return null;
    found.sort(function (a, b) { return b - a; });
    return found[0];
  }

  function detectMonitors(source) {
    return getAnalysisElement(source).then(function (src) {
      // The stream's own dimensions win: captureStream can differ from the
      // canvas's intrinsic size, and the popouts crop against the stream.
      source.width = src.width;
      source.height = src.height;
      return sampleOccupancy(src, 4, 110);
    }).then(function (occ) {
      var boxes = splitRegions(occ);
      var meta = metadataMonitorCount();
      var diag = {
        litFraction: occ.litFraction,
        cell: occ.cell,
        widestGapPx: boxes.widestGapPx,
        widestGapAxis: boxes.widestGapAxis,
        minGapPx: boxes.minGapPx
      };

      // Drop slivers relative to the biggest region.
      if (boxes.length) {
        var biggest = Math.max.apply(null, boxes.map(function (b) { return b.width * b.height; }));
        boxes = boxes.filter(function (b) { return b.width * b.height >= biggest * 0.05; });
      }

      // Boundary detection is the primary method now, not a fallback: the live
      // endpoint packs monitors with almost no seam, so gutter cutting alone finds a
      // single region. Run both every time and take whichever separates more
      // monitors. The count is often unavailable (the protocol looks binary), so an
      // upper bound of 6 means "cut as far as the image justifies", not a target.
      var via = 'gutter-split';
      var content = litBBox(occ);
      var target = (meta && meta > 1) ? meta : 6;
      var byEdge = [];
      try { byEdge = edgeSplit(occ, content, target); } catch (e) { wlog('error', 'edgeSplit threw', String(e)); }

      wlog('info', 'split candidates', {
        gutterCount: boxes.length, edgeCount: byEdge.length, meta: meta,
        gutter: boxes.map(function (b) { return [b.x, b.y, b.width, b.height]; }),
        edge: byEdge.map(function (b) { return [b.x, b.y, b.width, b.height]; })
      });

      if (byEdge.length > boxes.length) {
        boxes = byEdge;
        via = 'edge-split (' + byEdge.length + ' boundaries' +
          (meta ? ' vs reported ' + meta : ', no reported count') + ')';
      } else if (byEdge.length === boxes.length && byEdge.length > 1) {
        // Same count: prefer boundary detection, which trims to real content rather
        // than to whatever padding happened to be black.
        boxes = byEdge;
        via = 'edge-split (agrees with gutter-split on ' + byEdge.length + ')';
      }

      // Reading order: top-to-bottom by row band, then left-to-right.
      boxes.sort(function (a, b) {
        var rowA = Math.round(a.y / 200), rowB = Math.round(b.y / 200);
        return (rowA - rowB) || (a.x - b.x);
      });
      boxes.forEach(function (b, i) { b.index = i; });

      // Validate every proposed region against the occupancy grid. A real monitor
      // is almost entirely lit; a region containing a big black area means the
      // split was wrong. This is what catches an even-split guess being applied to
      // a layout that is not a simple row - without it, three equal strips over an
      // L-shaped arrangement get reported as success.
      var fullBox = litBBox(occ);
      boxes.forEach(function (b) { b.litFraction = litFractionOfBox(occ, b); });
      var weakest = boxes.length ? Math.min.apply(null, boxes.map(function (b) { return b.litFraction; })) : 0;
      var confident = boxes.length >= 2 && weakest >= 0.85;
      diag.weakestRegionLit = +weakest.toFixed(3);
      diag.confident = confident;

      state.lastOcc = occ; // retained so a manual grid split can trim to lit content
      state.contentBox = fullBox;
      state.detection = { via: via, meta: meta, count: boxes.length, diag: diag, confident: confident };
      return { boxes: boxes, via: via, meta: meta, diag: diag, confident: confident, contentBox: fullBox };
    });
  }

  // Boundary finding for monitors packed with no gap.
  //
  // Two monitors butted together still leave a hard discontinuity - different
  // wallpapers, a taskbar ending, a window edge - so the boundary shows up as a
  // column (or row) of unusually high edge energy running the full height (or
  // width) of the region. Cut at the strongest such line, recurse until the
  // target monitor count is reached.
  function edgeSplit(occ, box, targetCount) {
    var cell = occ.cell, gw = occ.gw, rgb = occ.rgb;
    var MARGIN = Math.max(4, Math.floor(200 / cell)); // don't cut near an edge
    var COLOUR_DELTA = 24;   // per-position colour distance counted as a discontinuity
    var SPAN_REQUIRED = 0.9; // fraction of the edge that must show it

    function dist(a, b) {
      return Math.abs(rgb[a * 3] - rgb[b * 3]) +
        Math.abs(rgb[a * 3 + 1] - rgb[b * 3 + 1]) +
        Math.abs(rgb[a * 3 + 2] - rgb[b * 3 + 2]);
    }

    // Score a candidate line by HOW MUCH OF IT is discontinuous, not by average
    // magnitude. A monitor seam runs the full height or width; text or a window
    // edge inside a monitor covers only part of it, however bright it is.
    function scoreLine(r, vertical, pos) {
      var hits = 0, total = 0, sum = 0;
      if (vertical) {
        for (var y = r.y0; y <= r.y1; y++) {
          var d = dist(y * gw + pos, y * gw + pos - 1);
          total++; sum += d;
          if (d > COLOUR_DELTA) hits++;
        }
      } else {
        for (var x = r.x0; x <= r.x1; x++) {
          var dd = dist(pos * gw + x, (pos - 1) * gw + x);
          total++; sum += dd;
          if (dd > COLOUR_DELTA) hits++;
        }
      }
      return total ? { span: hits / total, mean: sum / total } : { span: 0, mean: 0 };
    }

    // A cut must leave two pieces that could plausibly BE monitors. Without this,
    // the top edge of a full-width taskbar is a perfect full-span discontinuity and
    // gets cut, slicing a 40px strip off a monitor.
    var MIN_SIDE_PX = 200, MIN_ASPECT = 0.35, MAX_ASPECT = 4.5;
    function plausible(wPx, hPx) {
      if (wPx < MIN_SIDE_PX || hPx < MIN_SIDE_PX) return false;
      var a = wPx / hPx;
      return a >= MIN_ASPECT && a <= MAX_ASPECT;
    }

    function bestCut(r, vertical) {
      var lo = (vertical ? r.x0 : r.y0) + MARGIN;
      var hi = (vertical ? r.x1 : r.y1) - MARGIN;
      if (hi - lo < 2) return null;
      var spanW = (r.x1 - r.x0 + 1) * cell, spanH = (r.y1 - r.y0 + 1) * cell;
      var best = null;
      for (var pos = lo; pos <= hi; pos++) {
        var s = scoreLine(r, vertical, pos);
        if (s.span < SPAN_REQUIRED) continue;
        // reject cuts that would produce an implausible monitor shape
        if (vertical) {
          var wA = (pos - r.x0) * cell, wB = (r.x1 - pos + 1) * cell;
          if (!plausible(wA, spanH) || !plausible(wB, spanH)) continue;
        } else {
          var hA = (pos - r.y0) * cell, hB = (r.y1 - pos + 1) * cell;
          if (!plausible(spanW, hA) || !plausible(spanW, hB)) continue;
        }
        if (!best || s.span > best.span || (s.span === best.span && s.mean > best.mean)) {
          best = { pos: pos, span: s.span, mean: s.mean };
        }
      }
      return best;
    }

    var regions = [{
      x0: Math.floor(box.x / cell), x1: Math.ceil((box.x + box.width) / cell) - 1,
      y0: Math.floor(box.y / cell), y1: Math.ceil((box.y + box.height) / cell) - 1
    }];

    // Cutting the composite also carves out the black padding around an
    // irregular layout. Those empty regions are not monitors: they must not be
    // counted toward the target, and must not be split further.
    var grid = occ.grid;
    function isLit(r) {
      var lit = 0, total = 0;
      for (var y = r.y0; y <= r.y1; y++) {
        var base = y * gw;
        for (var x = r.x0; x <= r.x1; x++) { total++; if (grid[base + x]) lit++; }
      }
      return total ? (lit / total) > 0.2 : false;
    }
    function litCount() {
      var n = 0;
      for (var i = 0; i < regions.length; i++) if (isLit(regions[i])) n++;
      return n;
    }

    var guard = 0;
    while (litCount() < targetCount && guard++ < 14) {
      // Split whichever LIT region offers the most convincing boundary.
      var pick = null;
      regions.forEach(function (r, i) {
        if (!isLit(r)) return;
        [true, false].forEach(function (vertical) {
          var cut = bestCut(r, vertical);
          if (!cut) return;
          if (!pick || cut.span > pick.cut.span ||
            (cut.span === pick.cut.span && cut.mean > pick.cut.mean)) {
            pick = { i: i, vertical: vertical, cut: cut };
          }
        });
      });
      if (!pick) break; // no full-span discontinuity anywhere
      var r0 = regions[pick.i];
      var a, b;
      if (pick.vertical) {
        a = { x0: r0.x0, x1: pick.cut.pos - 1, y0: r0.y0, y1: r0.y1 };
        b = { x0: pick.cut.pos, x1: r0.x1, y0: r0.y0, y1: r0.y1 };
      } else {
        a = { x0: r0.x0, x1: r0.x1, y0: r0.y0, y1: pick.cut.pos - 1 };
        b = { x0: r0.x0, x1: r0.x1, y0: pick.cut.pos, y1: r0.y1 };
      }
      regions.splice(pick.i, 1, a, b);
    }

    // Drop the padding regions, then trim each survivor to its lit content so a
    // cut that landed slightly wide does not leave a black border.
    return regions.filter(isLit).map(function (r) {
      var minx = r.x1, maxx = r.x0, miny = r.y1, maxy = r.y0;
      for (var y = r.y0; y <= r.y1; y++) {
        var base = y * gw;
        for (var x = r.x0; x <= r.x1; x++) {
          if (grid[base + x]) {
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
            if (y < miny) miny = y;
            if (y > maxy) maxy = y;
          }
        }
      }
      if (maxx < minx || maxy < miny) { minx = r.x0; maxx = r.x1; miny = r.y0; maxy = r.y1; }
      var px = minx * cell, py = miny * cell;
      return {
        x: px, y: py,
        width: Math.min(occ.width - px, (maxx - minx + 1) * cell),
        height: Math.min(occ.height - py, (maxy - miny + 1) * cell)
      };
    });
  }

  // Bounding box of all lit content, in composite pixels. This is what a manual
  // grid split gets carved up, so it must exclude the outer black padding.
  function litBBox(occ) {
    var gw = occ.gw, gh = occ.gh, grid = occ.grid;
    var minx = gw, maxx = -1, miny = gh, maxy = -1;
    for (var y = 0; y < gh; y++) {
      var base = y * gw;
      for (var x = 0; x < gw; x++) {
        if (grid[base + x]) {
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    if (maxx < 0) return { x: 0, y: 0, width: occ.width, height: occ.height };
    return {
      x: minx * occ.cell, y: miny * occ.cell,
      width: Math.min(occ.width - minx * occ.cell, (maxx - minx + 1) * occ.cell),
      height: Math.min(occ.height - miny * occ.cell, (maxy - miny + 1) * occ.cell)
    };
  }

  function litFractionOfBox(occ, box) {
    var cell = occ.cell, gw = occ.gw, gh = occ.gh, grid = occ.grid;
    var gx0 = Math.max(0, Math.floor(box.x / cell));
    var gy0 = Math.max(0, Math.floor(box.y / cell));
    var gx1 = Math.min(gw - 1, Math.ceil((box.x + box.width) / cell) - 1);
    var gy1 = Math.min(gh - 1, Math.ceil((box.y + box.height) / cell) - 1);
    var lit = 0, total = 0;
    for (var y = gy0; y <= gy1; y++) {
      var base = y * gw;
      for (var x = gx0; x <= gx1; x++) { total++; if (grid[base + x]) lit++; }
    }
    return total ? lit / total : 0;
  }

  // Manual fallback for monitors packed with no seam at all. Cutting the content
  // box into a cols x rows grid, trimming each cell to its lit content and dropping
  // empty cells handles asymmetric layouts too - a 2x2 with one empty quadrant is
  // exactly three monitors arranged in an L.
  function gridSplit(box, cols, rows) {
    var occ = state.lastOcc;
    if (!occ) return [];
    var cell = occ.cell, gw = occ.gw, grid = occ.grid;
    var out = [];

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var gx0 = Math.floor((box.x + box.width / cols * c) / cell);
        var gx1 = Math.ceil((box.x + box.width / cols * (c + 1)) / cell) - 1;
        var gy0 = Math.floor((box.y + box.height / rows * r) / cell);
        var gy1 = Math.ceil((box.y + box.height / rows * (r + 1)) / cell) - 1;
        gx1 = Math.min(gx1, gw - 1);
        gy1 = Math.min(gy1, occ.gh - 1);

        // trim to lit content within the cell
        var minx = gx1 + 1, maxx = gx0 - 1, miny = gy1 + 1, maxy = gy0 - 1, lit = 0, total = 0;
        for (var y = gy0; y <= gy1; y++) {
          for (var x = gx0; x <= gx1; x++) {
            total++;
            if (grid[y * gw + x]) {
              lit++;
              if (x < minx) minx = x;
              if (x > maxx) maxx = x;
              if (y < miny) miny = y;
              if (y > maxy) maxy = y;
            }
          }
        }
        if (!total || lit / total < 0.05 || maxx < minx || maxy < miny) continue; // empty quadrant
        out.push({
          x: minx * cell, y: miny * cell,
          width: (maxx - minx + 1) * cell,
          height: (maxy - miny + 1) * cell
        });
      }
    }
    out.sort(function (a, b) {
      var ra = Math.round(a.y / 200), rb = Math.round(b.y / 200);
      return (ra - rb) || (a.x - b.x);
    });
    out.forEach(function (b, i) { b.index = i; });
    return out;
  }

  function showManualSplit(box, source) {
    var host = document.getElementById('wrmm-host');
    if (!host || document.getElementById('wrmm-manual')) return;

    var wrap = document.createElement('div');
    wrap.id = 'wrmm-manual';
    wrap.innerHTML =
      '<label>Monitors</label>' +
      '<input id="wrmm-count" type="number" min="2" max="6" value="' + (state.detection && state.detection.meta || 3) + '">' +
      '<button id="wrmm-apply" type="button">Find boundaries</button>' +
      '<button id="wrmm-applygrid" type="button" title="Equal-sized monitors only">Even grid</button>';
    host.appendChild(wrap);

    function countInput() {
      return Math.max(2, Math.min(6, parseInt(document.getElementById('wrmm-count').value, 10) || 3));
    }

    // Preferred: tell it how many monitors and let boundary detection place the cuts.
    document.getElementById('wrmm-apply').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var n = countInput();
      if (!state.lastOcc) { say('no sampled frame — click the main button first', 'bad'); return; }
      var mons = edgeSplit(state.lastOcc, box, n);
      if (mons.length < 2) {
        say('no convincing boundaries found for ' + n + ' monitors — try "Even grid"', 'bad');
        return;
      }
      mons.sort(function (a, b) {
        var ra = Math.round(a.y / 200), rb = Math.round(b.y / 200);
        return (ra - rb) || (a.x - b.x);
      });
      mons.forEach(function (m, i) { m.index = i; });
      openPopouts(mons, source, 'edge-split, ' + mons.length + ' of ' + n + ' requested');
    });

    // Last resort, and only correct for equal-sized monitors in a regular grid.
    document.getElementById('wrmm-applygrid').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var n = countInput();
      var cols = n, rows = 1;
      if (n === 4) { cols = 2; rows = 2; }
      else if (n > 4) { cols = Math.ceil(n / 2); rows = 2; }
      var mons = gridSplit(box, cols, rows);
      if (mons.length < 2) {
        say('even ' + cols + '×' + rows + ' grid produced ' + mons.length + ' region(s)', 'bad');
        return;
      }
      openPopouts(mons, source, 'even ' + cols + '×' + rows + ' grid (assumes equal monitors)');
    });
  }

  // ========================================================================
  // Input - parent owns ONE state machine
  //
  // The reason popouts started out view-only: with per-window handlers, pressing
  // Ctrl in one window and releasing it over another leaves the endpoint holding
  // the modifier down forever. So children never talk to the session. They hand
  // raw events to the parent with their monitor offset applied; the parent tracks
  // exactly what is held and releases it when focus moves.
  // ========================================================================
  var input = {
    keysDown: {},
    buttonsDown: 0,
    owner: null   // which popout currently holds input
  };

  // Where to dispatch synthesised input. The render surface is only a guess; the
  // app may listen on a wrapper element instead, in which case events aimed at the
  // canvas do nothing. hook.js records every element that registered a mouse or
  // pointer listener, so prefer one of those and fall back to the surface.
  var resolvedTarget = null;
  function appTarget() {
    var s = state.source;
    var surface = s ? s.el : null;
    if (resolvedTarget && resolvedTarget.isConnected) return resolvedTarget;

    var live = window.__WRMM_LIVE__;
    var cands = (live && live.inputTargets) || [];
    // Prefer the surface itself if it registered listeners, else the smallest
    // connected element that did - most specific wins.
    if (surface && cands.indexOf(surface) >= 0) { resolvedTarget = surface; }
    else {
      var best = null, bestArea = Infinity;
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (!el || !el.isConnected) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue;
        var area = r.width * r.height;
        if (area < bestArea) { bestArea = area; best = el; }
      }
      resolvedTarget = best || surface;
    }

    if (resolvedTarget) {
      wlog('info', 'input dispatch target resolved', {
        tag: resolvedTarget.nodeName,
        id: resolvedTarget.id || null,
        cls: typeof resolvedTarget.className === 'string' ? resolvedTarget.className.slice(0, 80) : null,
        isSurface: resolvedTarget === surface,
        candidates: cands.length,
        listeners: (window.__WRMM_HOOK__ && window.__WRMM_HOOK__.inputListeners || [])
          .map(function (l) { return l.type + '@' + l.target; }).slice(0, 24)
      });
    }
    return resolvedTarget;
  }

  // The endpoint does not composite its cursor into the video, so a popout shows
  // hover effects but no pointer. Track the last known remote position - from our
  // own forwarded events, and from real events in the parent tab - and draw it.
  state.remoteCursor = null;

  function setRemoteCursor(cx, cy) {
    state.remoteCursor = { x: cx, y: cy, at: Date.now() };
    for (var i = 0; i < state.popouts.length; i++) {
      var p = state.popouts[i];
      if (p.drawCursor) { try { p.drawCursor(); } catch (e) {} }
    }
  }

  // Mirror real pointer movement in the parent tab, so driving from either place
  // keeps the popout cursor correct.
  window.addEventListener('mousemove', function (ev) {
    if (!ev.isTrusted || !state.popouts.length || !state.source) return;
    var el = state.source.el;
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    setRemoteCursor(
      (ev.clientX - r.left) / r.width * state.source.width,
      (ev.clientY - r.top) / r.height * state.source.height
    );
  }, true);

  // composite coords -> client coords over the app's own surface
  function compositeToClient(cx, cy) {
    var el = appTarget();
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var iw = state.source.width, ih = state.source.height;
    return {
      clientX: r.left + (cx / iw) * r.width,
      clientY: r.top + (cy / ih) * r.height
    };
  }

  function dispatchMouse(type, cx, cy, ev) {
    var el = appTarget();
    var pt = compositeToClient(cx, cy);
    if (!el || !pt) return;
    var init = {
      bubbles: true, cancelable: true, view: window, composed: true,
      clientX: pt.clientX, clientY: pt.clientY,
      screenX: pt.clientX, screenY: pt.clientY,
      button: ev.button || 0, buttons: typeof ev.buttons === 'number' ? ev.buttons : input.buttonsDown,
      ctrlKey: !!ev.ctrlKey, shiftKey: !!ev.shiftKey, altKey: !!ev.altKey, metaKey: !!ev.metaKey,
      detail: ev.detail || (type === 'dblclick' ? 2 : 1)
    };
    try {
      if (type === 'wheel') {
        el.dispatchEvent(new WheelEvent('wheel', Object.assign({}, init, {
          deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0, deltaZ: 0, deltaMode: ev.deltaMode || 0
        })));
        return;
      }
      // Many canvas apps listen for pointer events rather than mouse events, so
      // send both. Duplicates are harmless; a missing family is not.
      if (window.PointerEvent) {
        var pmap = { mousedown: 'pointerdown', mouseup: 'pointerup', mousemove: 'pointermove' };
        if (pmap[type]) {
          el.dispatchEvent(new PointerEvent(pmap[type], Object.assign({}, init, {
            pointerId: 1, pointerType: 'mouse', isPrimary: true
          })));
        }
      }
      el.dispatchEvent(new MouseEvent(type, init));
    } catch (e) {}
  }

  function dispatchKey(type, ev) {
    var el = appTarget() || document.body;
    var init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      key: ev.key, code: ev.code, location: ev.location || 0,
      ctrlKey: !!ev.ctrlKey, shiftKey: !!ev.shiftKey, altKey: !!ev.altKey, metaKey: !!ev.metaKey,
      repeat: !!ev.repeat, keyCode: ev.keyCode || 0, which: ev.keyCode || 0
    };
    try {
      var k = new KeyboardEvent(type, init);
      // keyCode/which are read-only on the constructed event; some apps still
      // read them, so redefine before dispatch.
      try {
        Object.defineProperty(k, 'keyCode', { get: function () { return init.keyCode; } });
        Object.defineProperty(k, 'which', { get: function () { return init.which; } });
      } catch (e) {}
      el.dispatchEvent(k);
      if (el !== document.body) document.dispatchEvent(new KeyboardEvent(type, init));
    } catch (e) {}
  }

  // The stuck-modifier fix: whenever a window gives up input, everything it was
  // holding is explicitly released.
  function releaseAll(reason) {
    var released = 0;
    Object.keys(input.keysDown).forEach(function (code) {
      var ev = input.keysDown[code];
      dispatchKey('keyup', ev);
      released++;
      delete input.keysDown[code];
    });
    if (input.buttonsDown) {
      var last = input.lastPos || { cx: 0, cy: 0 };
      dispatchMouse('mouseup', last.cx, last.cy, { button: 0, buttons: 0 });
      input.buttonsDown = 0;
      released++;
    }
    if (released) console.info('[WRMM] released ' + released + ' held input(s) — ' + reason);
  }

  function attachInput(w, mon, getTransform) {
    var d = w.document;
    var wrap = d.getElementById('wrap');

    function toComposite(ev) {
      var t = getTransform();
      return {
        cx: (ev.clientX - t.tx) / t.scale,
        cy: (ev.clientY - t.ty) / t.scale
      };
    }

    function inBounds(p) {
      return p.cx >= mon.x && p.cx <= mon.x + mon.width &&
        p.cy >= mon.y && p.cy <= mon.y + mon.height;
    }

    ['mousemove', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'wheel'].forEach(function (type) {
      wrap.addEventListener(type, function (ev) {
        if (!state.inputEnabled) return;
        var p = toComposite(ev);
        if (!inBounds(p)) return;
        input.lastPos = p;
        if (input.owner !== w) { releaseAll('input moved to another window'); input.owner = w; }
        if (type === 'mousedown') input.buttonsDown = ev.buttons || 1;
        if (type === 'mouseup') input.buttonsDown = 0;
        setRemoteCursor(p.cx, p.cy);
        if (type === 'contextmenu') { ev.preventDefault(); dispatchMouse('contextmenu', p.cx, p.cy, ev); return; }
        ev.preventDefault();
        dispatchMouse(type, p.cx, p.cy, ev);
        if (type !== 'mousemove') {
          wlog('debug', 'forwarded ' + type, { composite: [Math.round(p.cx), Math.round(p.cy)], monitor: mon.index });
        }
      }, { passive: false });
    });

    ['keydown', 'keyup'].forEach(function (type) {
      w.addEventListener(type, function (ev) {
        if (!state.inputEnabled) return;
        // let the operator keep F11/F12 and window management
        if (ev.key === 'F11' || ev.key === 'F12') return;
        if (input.owner !== w) { releaseAll('keyboard moved to another window'); input.owner = w; }
        var rec = { key: ev.key, code: ev.code, keyCode: ev.keyCode, location: ev.location,
          ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey, repeat: ev.repeat };
        if (type === 'keydown') input.keysDown[ev.code] = rec;
        else delete input.keysDown[ev.code];
        ev.preventDefault();
        dispatchKey(type, rec);
      }, { passive: false });
    });

    // Losing focus or closing must not leave anything held down.
    w.addEventListener('blur', function () { if (input.owner === w) releaseAll('window lost focus'); });
    w.addEventListener('pagehide', function () { if (input.owner === w) { releaseAll('window closed'); input.owner = null; } });
  }

  // ========================================================================
  // Blanking the in-tab view
  // ========================================================================
  // Blanking had to be made stubborn. The first version measured the render surface
  // once and positioned an overlay over it; on a second run the surface's rect could
  // be degenerate (the app relayouts when the tab loses focus to the popouts), which
  // produced a 0x0 overlay and no visible blanking at all. Now: re-measure on a
  // timer, fall back to the full viewport when the rect is unusable, and re-attach
  // if the app's own re-render removes it.
  var blankTimer = null;

  function placeBlanket(b) {
    var el = state.source && state.source.el;
    var r = el ? el.getBoundingClientRect() : null;
    if (r && r.width > 40 && r.height > 40) {
      b.style.setProperty('top', Math.max(0, r.top) + 'px', 'important');
      b.style.setProperty('left', Math.max(0, r.left) + 'px', 'important');
      b.style.setProperty('width', r.width + 'px', 'important');
      b.style.setProperty('height', r.height + 'px', 'important');
      b.setAttribute('data-mode', 'surface');
    } else {
      // Unusable rect - cover everything rather than silently blank nothing.
      b.style.setProperty('top', '0px', 'important');
      b.style.setProperty('left', '0px', 'important');
      b.style.setProperty('width', '100vw', 'important');
      b.style.setProperty('height', '100vh', 'important');
      b.setAttribute('data-mode', 'viewport');
    }
  }

  function setBlanked(on) {
    if (!on) {
      state.blanked = false;
      if (blankTimer) { clearInterval(blankTimer); blankTimer = null; }
      var ex = document.getElementById(BLANK_ID);
      if (ex) ex.remove();
      wlog('info', 'blanket removed');
      return;
    }

    state.blanked = true;

    function ensure() {
      if (!state.blanked) return;
      var b = document.getElementById(BLANK_ID);
      if (!b) {
        b = document.createElement('div');
        b.id = BLANK_ID;
        b.innerHTML = '<div class="wrmm-blanket-msg">' +
          '<strong>Popped out</strong>' +
          '<span>This view is paused while the monitor windows are open.<br>' +
          'Close the popouts to restore it here.</span></div>';
        document.body.appendChild(b);
        wlog('info', 'blanket attached', { mode: b.getAttribute('data-mode') });
      }
      placeBlanket(b);
    }

    ensure();
    if (blankTimer) clearInterval(blankTimer);
    blankTimer = setInterval(ensure, 700);
  }

  // ========================================================================
  // Popouts
  // ========================================================================
  function cropTransform(mon, comp, vw, vh) {
    var s = Math.min(vw / mon.width, vh / mon.height);
    return {
      scale: s,
      tx: (vw - mon.width * s) / 2 - mon.x * s,
      ty: (vh - mon.height * s) / 2 - mon.y * s,
      naturalWidth: comp.width,
      naturalHeight: comp.height
    };
  }

  function buildPopoutDoc(w, mon, idx, source) {
    var d = w.document;
    d.title = 'Monitor ' + (idx + 1) + ' — ' + mon.width + '×' + mon.height;
    d.documentElement.innerHTML =
      '<head><meta charset="utf-8"><style>' +
      'html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden;}' +
      '#wrap{position:fixed;inset:0;overflow:hidden;background:#000;cursor:default;}' +
      'video{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;pointer-events:none;}' +
      '#bar{position:fixed;top:0;left:0;right:0;height:26px;z-index:10;display:flex;align-items:center;gap:8px;' +
      'padding:0 8px;font:600 11px/1 system-ui,sans-serif;color:#cfe0ee;background:rgba(8,12,17,.86);' +
      'border-bottom:1px solid #22303d;opacity:.25;transition:opacity .15s;}' +
      '#bar:hover{opacity:1;}' +
      '#mode{padding:3px 7px;border-radius:3px;letter-spacing:.05em;}' +
      '#mode.live{color:#062;background:#6ee7a0;}' +
      '#mode.view{color:#ffd98a;background:rgba(60,42,0,.9);border:1px solid #6b5416;}' +
      '#bar button{font:600 10px system-ui,sans-serif;color:#fff;background:#1f2c38;border:1px solid #35485c;' +
      'border-radius:3px;padding:3px 8px;cursor:pointer;}' +
      '#meta{margin-left:auto;font-weight:400;color:#8ba3b8;}' +
      // The endpoint does not draw its cursor into the stream, so we draw one.
      '#cur{position:absolute;left:0;top:0;width:22px;height:22px;z-index:9;pointer-events:none;' +
      'display:none;margin-left:-2px;margin-top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.9));}' +
      '</style></head><body>' +
      '<div id="wrap"><video autoplay muted playsinline></video>' +
      '<svg id="cur" viewBox="0 0 22 22"><path d="M3 1 L3 17 L7.5 13 L10.5 20 L13.5 18.5 L10.5 12 L16.5 12 Z" ' +
      'fill="#fff" stroke="#000" stroke-width="1.4"/></svg>' +
      '</div>' +
      '<div id="bar">' +
      '<span id="mode" class="live">INPUT LIVE</span>' +
      '<button id="toggle">View only</button>' +
      '<button id="fs">Fullscreen</button>' +
      '<span id="meta"></span>' +
      '</div>' +
      '</body>';

    var video = d.querySelector('video');
    var meta = d.getElementById('meta');
    var mode = d.getElementById('mode');

    // Construct the stream in the POPUP's realm with its own cloned track, so
    // the stream's lifetime belongs to this document.
    var track = source.track;
    var clone = null;
    try { clone = track.clone(); } catch (e) { clone = track; }
    try {
      video.srcObject = new w.MediaStream([clone]);
    } catch (e) {
      try { video.srcObject = source.stream; } catch (e2) { say('could not bind stream in popup: ' + e2, 'bad'); }
    }
    try { video.play(); } catch (e) {}

    var current = null;
    function layout() {
      current = cropTransform(mon, { width: source.width, height: source.height }, w.innerWidth, w.innerHeight);
      video.style.width = current.naturalWidth + 'px';
      video.style.height = current.naturalHeight + 'px';
      video.style.transform = 'translate(' + current.tx.toFixed(2) + 'px,' + current.ty.toFixed(2) +
        'px) scale(' + current.scale.toFixed(5) + ')';
      meta.textContent = 'Monitor ' + (idx + 1) + ' · ' + mon.width + '×' + mon.height +
        ' of ' + source.width + '×' + source.height + ' · ' + Math.round(current.scale * 100) + '%';
    }
    // Draw the tracked remote cursor, mapped through this window's crop transform.
    var curEl = d.getElementById('cur');
    function drawCursor() {
      var rc = state.remoteCursor;
      if (!rc || !current) { curEl.style.display = 'none'; return; }
      var inThisMonitor = rc.x >= mon.x && rc.x <= mon.x + mon.width &&
        rc.y >= mon.y && rc.y <= mon.y + mon.height;
      if (!inThisMonitor) { curEl.style.display = 'none'; return; }
      curEl.style.display = 'block';
      curEl.style.transform = 'translate(' +
        (current.tx + rc.x * current.scale).toFixed(1) + 'px,' +
        (current.ty + rc.y * current.scale).toFixed(1) + 'px)';
    }

    layout();
    drawCursor();
    w.addEventListener('resize', function () { layout(); drawCursor(); });

    d.getElementById('fs').addEventListener('click', function () {
      try { d.documentElement.requestFullscreen(); } catch (e) {}
    });
    d.getElementById('toggle').addEventListener('click', function () {
      state.inputEnabled = !state.inputEnabled;
      if (!state.inputEnabled) releaseAll('input disabled');
      syncModeBadges();
    });

    attachInput(w, mon, function () { return current; });

    w.addEventListener('pagehide', function () {
      try { video.srcObject = null; } catch (e) {}
      try { if (clone !== track) clone.stop(); } catch (e) {}
      state.popouts = state.popouts.filter(function (p) { return p.win !== w; });
      // Last one out restores the in-tab view.
      if (!state.popouts.length) { setBlanked(false); say('all popouts closed — view restored'); }
      update();
    });

    return {
      video: video, clone: clone, layout: layout, mode: mode,
      drawCursor: drawCursor, getTransform: function () { return current; }
    };
  }

  function syncModeBadges() {
    state.popouts.forEach(function (p) {
      if (!p.mode) return;
      try {
        p.mode.textContent = state.inputEnabled ? 'INPUT LIVE' : 'VIEW ONLY';
        p.mode.className = state.inputEnabled ? 'live' : 'view';
        var t = p.win.document.getElementById('toggle');
        if (t) t.textContent = state.inputEnabled ? 'View only' : 'Enable input';
      } catch (e) {}
    });
  }

  function popOutAll() {
    if (state.popouts.length) {
      state.popouts.forEach(function (p) { try { p.win.focus(); } catch (e) {} });
      say(state.popouts.length + ' window(s) already open — focused them', 'ok');
      return;
    }

    var source = getSource(true);
    if (!source) { say('no render surface found — is the session connected?', 'bad'); return; }
    if (!source.track) { say('render surface found but no video track could be derived', 'bad'); return; }

    say('detecting monitor layout…');

    detectMonitors(source).then(function (det) {
      var mons = det.boxes;
      var d = det.diag || {};
      wlog('info', 'detection result', {
        via: det.via, confident: det.confident, count: mons.length, meta: det.meta, diag: d,
        boxes: mons.map(function (b) { return [b.x, b.y, b.width, b.height]; })
      });

      if (!mons.length) {
        say('no lit regions found (lit ' + d.litFraction + ') — is the session painting?', 'bad');
        return;
      }

      // A single region is a legitimate result, not a failure: in SINGLE MONITOR
      // mode there genuinely is one screen to pop out, and having it work there too
      // is useful. Open the one window and still offer the manual control in case
      // more monitors were expected.
      if (mons.length === 1) {
        say('1 region ' + mons[0].width + '×' + mons[0].height + ' · ' + det.via +
            ' · popping out as a single window', 'warn');
        openPopouts(mons, source, det.via + ' (single region)');
        showManualSplit(det.contentBox || mons[0], source);
        return;
      }

      // Refuse to open windows on a split we cannot trust. A region containing a
      // large black area means the boundaries are wrong, and several plausible-looking
      // windows showing the wrong thing is worse than saying so.
      if (!det.confident) {
        say(mons.length + ' regions from ' + det.via + ' but one is only ' +
          Math.round(d.weakestRegionLit * 100) + '% filled — that split is not trustworthy. ' +
          'Set the count with "Monitors" below.', 'bad');
        showManualSplit(det.contentBox || mons[0], source);
        return;
      }

      openPopouts(mons, source, det.via +
        (det.meta && det.meta !== mons.length ? ' · WARNING: page reports ' + det.meta + ' monitors' : ''));
    }, function (e) { say('detection failed: ' + e, 'bad'); });
  }

  function openPopouts(mons, source, via) {
    state.monitors = mons;
    state.lastTrackId = source.track.id;

    // Cascade in front of the operator so the windows can be dragged wherever they
    // want them. No display permission needed, so nothing to wait on.
    var availW = window.screen.availWidth, availH = window.screen.availHeight;
    var blocked = 0;

    mons.forEach(function (mon, i) {
      // Match each window's aspect to its monitor, so the video fills it with no
      // letterboxing.
      var aspect = mon.width / mon.height;
      var hh = Math.round(availH * 0.62);
      var ww = Math.round(hh * aspect);
      if (ww > availW * 0.8) { ww = Math.round(availW * 0.8); hh = Math.round(ww / aspect); }
      var left = Math.round(availW * 0.06 + i * 42);
      var top = Math.round(availH * 0.08 + i * 42);

      var w = window.open('about:blank', 'wrmm-mon-' + i,
        'popup,width=' + ww + ',height=' + hh + ',left=' + left + ',top=' + top);
      if (!w) { blocked++; return; }

      var built = buildPopoutDoc(w, mon, i, source);
      state.popouts.push({
        win: w, monitor: mon, video: built.video, clone: built.clone,
        layout: built.layout, mode: built.mode, drawCursor: built.drawCursor
      });
      try { w.focus(); } catch (e) {}
    });

    if (blocked) {
      say(blocked + ' of ' + mons.length + ' window(s) blocked — click the blocked-popup icon in the address bar, allow this site, then click again', 'bad');
    } else {
      setBlanked(true);
      var m = document.getElementById('wrmm-manual');
      if (m) m.remove();
      say(mons.length + ' monitors popped out · ' + via + ' · input live', 'ok');
    }
    syncModeBadges();
    update();
  }

  function closeAll() {
    releaseAll('closing all windows');
    state.popouts.slice().forEach(function (p) { try { p.win.close(); } catch (e) {} });
    state.popouts = [];
    setBlanked(false);
    say('closed all popouts — view restored');
    update();
  }

  window.addEventListener('pagehide', function () {
    state.popouts.forEach(function (p) { try { p.win.close(); } catch (e) {} });
  });

  // Reconnect: if the track is replaced, re-bind every open child.
  setInterval(function () {
    if (!state.popouts.length) return;
    var src = getSource(true);
    if (!src || !src.track || src.track.id === state.lastTrackId) return;
    state.lastTrackId = src.track.id;
    say('track replaced (reconnect) — re-binding ' + state.popouts.length + ' window(s)', 'warn');
    state.popouts.forEach(function (p) {
      try {
        var clone = src.track.clone ? src.track.clone() : src.track;
        p.video.srcObject = new p.win.MediaStream([clone]);
        p.video.play();
        p.clone = clone;
        p.layout();
      } catch (e) {}
    });
  }, 2500);

  // Guard against a popout being closed by the OS without firing pagehide.
  setInterval(function () {
    var before = state.popouts.length;
    state.popouts = state.popouts.filter(function (p) {
      try { return !p.win.closed; } catch (e) { return false; }
    });
    if (before && !state.popouts.length) { setBlanked(false); say('all popouts closed — view restored'); }
    if (before !== state.popouts.length) update();
  }, 1200);

  // ========================================================================
  // Native button injection
  // ========================================================================
  function findLabelled(re) {
    var els = document.querySelectorAll('button, div, span, a, label, [role="button"], [role="tab"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var txt = (el.textContent || '').trim();
      if (txt.length > 22 || !re.test(txt)) continue;
      if (el.querySelector('button, [role="button"]')) continue;
      return el;
    }
    return null;
  }

  var COPY_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform',
    'color', 'backgroundColor', 'backgroundImage', 'borderTopWidth', 'borderTopStyle',
    'borderTopColor', 'borderRadius', 'paddingTop', 'paddingBottom', 'boxShadow', 'lineHeight'];

  function styleLikeNative(btn, model) {
    if (!model) return;
    var cs = getComputedStyle(model);
    COPY_PROPS.forEach(function (p) { try { btn.style[p] = cs[p]; } catch (e) {} });
    btn.style.setProperty('border-width', cs.borderTopWidth, '');
    btn.style.setProperty('border-style', cs.borderTopStyle || 'solid', '');
    btn.style.setProperty('border-color', cs.borderTopColor, '');
  }

  // Web Remote 2.0 has no monitor controls at all, so there is no ALL MONITORS
  // button to anchor to or copy styling from. Fall back through progressively
  // weaker anchors, and finally to a floating pill, so the button still appears.
  function findAnchor() {
    var allMon = findLabelled(/^all monitors$/i) ||
      findLabelled(/^single monitor$/i) ||
      findLabelled(/^fit screen$/i) ||
      findLabelled(/^original size$/i);
    if (!allMon) return null;
    var row = allMon;
    for (var i = 0; i < 5 && row.parentElement; i++) {
      row = row.parentElement;
      if (row.getBoundingClientRect().width > 150) break;
    }
    var minimap = null, sib = row.nextElementSibling;
    for (var n = 0; n < 4 && sib; n++) {
      var r = sib.getBoundingClientRect();
      var bg = '';
      try { bg = getComputedStyle(sib).backgroundImage; } catch (e) {}
      if (r.height > 50 && (sib.querySelector('canvas, img, video, svg') || (bg && bg !== 'none'))) { minimap = sib; break; }
      sib = sib.nextElementSibling;
    }
    return { model: allMon, row: row, after: minimap || row };
  }

  function inject() {
    if (document.getElementById(BTN_ID)) return true;

    // Only inject where there is actually a session to pop out. Without this the
    // broadened host match would put a button on every RMM page.
    if (!getSource(true)) return false;

    var a = findAnchor();
    var floating = false;
    if (!a) {
      // No native control rail to attach to (Web Remote 2.0). Use a floating pill.
      floating = true;
      a = { model: null, after: null };
    }

    var host = document.createElement('div');
    host.id = 'wrmm-host';
    if (floating) host.className = 'wrmm-floating';

    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'POP OUT ALL MONITORS';
    styleLikeNative(btn, a.model);
    ['display:block', 'width:100%', 'margin:8px 0 0', 'padding-left:8px', 'padding-right:8px', 'cursor:pointer']
      .forEach(function (r) { var p = r.split(':'); btn.style.setProperty(p[0], p[1], 'important'); });
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); popOutAll(); });

    var close = document.createElement('button');
    close.id = 'wrmm-close-btn';
    close.type = 'button';
    close.textContent = 'Close popouts & restore view';
    styleLikeNative(close, a.model);
    ['display:none', 'width:100%', 'margin:5px 0 0', 'opacity:0.75', 'cursor:pointer']
      .forEach(function (r) { var p = r.split(':'); close.style.setProperty(p[0], p[1], 'important'); });
    close.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeAll(); });

    var status = document.createElement('div');
    status.id = STATUS_ID;
    status.className = 'wrmm-status';

    host.appendChild(btn);
    host.appendChild(close);
    host.appendChild(status);

    if (floating || !a.after || !a.after.parentElement) {
      document.body.appendChild(host);
    } else {
      a.after.parentElement.insertBefore(host, a.after.nextSibling);
    }
    wlog('info', 'button injected', {
      floating: floating,
      anchoredTo: a.after ? (a.after.nodeName + (a.after.id ? '#' + a.after.id : '')) : null,
      styledFrom: a.model ? (a.model.textContent || '').trim().slice(0, 24) : null
    });
    update();
    return true;
  }

  function update() {
    var btn = document.getElementById(BTN_ID);
    var close = document.getElementById('wrmm-close-btn');
    if (!btn) return;
    var n = state.popouts.length;
    btn.textContent = n ? 'FOCUS ' + n + ' POPOUT' + (n > 1 ? 'S' : '') : 'POP OUT ALL MONITORS';
    if (close) close.style.setProperty('display', n ? 'block' : 'none', 'important');
  }

  function guard() {
    new MutationObserver(function () {
      if (!document.getElementById(BTN_ID)) inject();
    }).observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    rpc('popupSettingAllow').then(function (r) {
      if (!r || !r.ok) console.warn('[WRMM] popup content-setting not applied:', r && r.error);
    });

    if (!inject()) {
      var tries = 0;
      var t = setInterval(function () { if (inject() || ++tries > 60) clearInterval(t); }, 500);
    }
    guard();
    setInterval(update, 2000);

    window.__WRMM_DIAG__ = function () {
      var s = getSource(true);
      return {
        surface: s ? { kind: s.kind, size: s.width + 'x' + s.height, track: s.track && s.track.id } : null,
        monitors: state.monitors,
        detection: state.detection,
        popouts: state.popouts.length,
        inputEnabled: state.inputEnabled,
        held: { keys: Object.keys(input.keysDown), buttons: input.buttonsDown },
        hook: HOOK ? { pcs: HOOK.peerConnections.length, trackEvents: HOOK.trackEvents.length, msgs: HOOK.collectMessages().total } : null
      };
    };
    // Exposed so the dev harness can verify the input path actually dispatches
    // events the app can observe, without needing a real popout window.
    window.__WRMM_TEST__ = {
      dispatchMouse: dispatchMouse,
      dispatchKey: dispatchKey,
      compositeToClient: compositeToClient,
      releaseAll: releaseAll,
      held: function () { return { keys: Object.keys(input.keysDown), buttons: input.buttonsDown }; },
      markHeld: function (rec) { input.keysDown[rec.code] = rec; },
      detect: function () { var s = getSource(true); return s ? detectMonitors(s) : Promise.resolve(null); },
      gridSplit: gridSplit,
      edgeSplit: function (box, n) { return edgeSplit(state.lastOcc, box, n); },
      contentBox: function () { return state.contentBox; },
      setBlanked: setBlanked
    };
    console.info('[WRMM] ready. window.__WRMM_DIAG__() for a compact status dump.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
