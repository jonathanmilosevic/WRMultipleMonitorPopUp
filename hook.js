// ============================================================================
// WR Multi-Monitor Popout PoC - hook.js
// MAIN world, run_at: document_start.
//
// CRITICAL: this file must stay FULLY SYNCHRONOUS and SELF-CONTAINED.
// No import, no await, no chrome.* call, no dynamic script load before the
// hooks are installed. Any of those yield to the event loop and the page's own
// bundle wins the race, at which point we observe nothing.
//
// Phase 0 is observe-only. Nothing here changes page behaviour: every wrapper
// delegates to the original and swallows its own errors so a bug in the probe
// can never break a live remote session.
// ============================================================================

(function () {
  'use strict';

  if (window.__WRMM_HOOK__) return; // idempotent (all_frames + re-injection)

  // ---- tunables -----------------------------------------------------------
  var RAW_MAX = 2000;    // max chars of a raw text message retained
  var PARSE_MAX = 200000; // don't attempt JSON.parse above this size
  var FIRST_N = 200;     // first N messages, kept forever (geometry lands early)
  var RECENT_N = 150;    // rolling window of most recent messages
  var CLONE_NODES = 4000; // node budget for the bounded serialiser

  // ---- findings (must stay JSON-serialisable) -----------------------------
  var F = {
    schema: 'wrmm-phase0/1',
    hook: {
      installedAt: Date.now(),
      url: location.href,
      origin: location.origin,
      isTopFrame: (function () { try { return window === window.top; } catch (e) { return null; } })(),
      // The ordering evidence: at document_start the parser has not built <body>
      // yet. If body already exists we lost the race and every "not observed"
      // finding below is unreliable.
      readyStateAtInstall: document.readyState,
      bodyExistedAtInstall: !!document.body,
      headChildCountAtInstall: document.head ? document.head.childElementCount : null,
      scriptCountAtInstall: document.getElementsByTagName('script').length,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      screen: {
        width: screen.width, height: screen.height,
        availWidth: screen.availWidth, availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        isExtended: ('isExtended' in screen) ? screen.isExtended : null
      }
    },
    installed: {},        // which hooks actually went in
    peerConnections: [],
    trackEvents: [],
    srcObjectSets: [],
    dataChannels: [],
    sockets: [],
    messages: null,       // filled from MSG at report time
    visibilityListeners: [],
    errors: []
  };

  // Live object refs. Deliberately NOT on F - these are not serialisable and
  // must never reach the report or the postMessage bridge.
  var LIVE = {
    pcs: [],
    tracks: [],   // {id, kind, label, track, streams, firstSeenAt, pcId}
    streams: [],
    sockets: [],
    channels: []
  };

  window.__WRMM_HOOK__ = F;
  window.__WRMM_LIVE__ = LIVE;

  function oops(where, e) {
    if (F.errors.length < 60) F.errors.push({ where: where, error: String(e && e.message || e) });
  }

  // ---- bounded serialiser -------------------------------------------------
  // Strips functions, breaks cycles, truncates. Keeps the report finite even if
  // the app sends something enormous.
  function safe(v, maxDepth) {
    var budget = { n: 0 };
    var seen = new WeakSet();
    function walk(x, depth) {
      if (budget.n++ > CLONE_NODES) return '[budget exceeded]';
      if (x === null || x === undefined) return x === undefined ? '[undefined]' : null;
      var t = typeof x;
      if (t === 'number') return Number.isFinite(x) ? x : String(x);
      if (t === 'boolean') return x;
      if (t === 'bigint') return String(x) + 'n';
      if (t === 'string') return x.length > RAW_MAX ? x.slice(0, RAW_MAX) + '…[+' + (x.length - RAW_MAX) + ']' : x;
      if (t === 'function') return '[function ' + (x.name || 'anonymous') + ']';
      if (t === 'symbol') return String(x);
      if (depth <= 0) return '[depth limit]';
      if (typeof Node !== 'undefined' && x instanceof Node) return '[Node ' + x.nodeName + ']';
      if (typeof Window !== 'undefined' && x instanceof Window) return '[Window]';
      if (x instanceof Error) return '[Error ' + x.message + ']';
      if (seen.has(x)) return '[cycle]';
      seen.add(x);
      try {
        if (Array.isArray(x)) {
          var outA = [];
          for (var i = 0; i < x.length && i < 200; i++) outA.push(walk(x[i], depth - 1));
          if (x.length > 200) outA.push('[+' + (x.length - 200) + ' more]');
          return outA;
        }
        if (x instanceof ArrayBuffer) return '[ArrayBuffer ' + x.byteLength + 'B]';
        if (ArrayBuffer.isView(x)) return '[' + (x.constructor && x.constructor.name) + ' ' + x.byteLength + 'B]';
        if (x instanceof Map) return { __map: walk(Array.from(x.entries()).slice(0, 60), depth - 1) };
        if (x instanceof Set) return { __set: walk(Array.from(x.values()).slice(0, 60), depth - 1) };
        var outO = {};
        var keys;
        try { keys = Object.keys(x); } catch (e) { return '[unenumerable]'; }
        for (var k = 0; k < keys.length && k < 120; k++) {
          try { outO[keys[k]] = walk(x[keys[k]], depth - 1); } catch (e) { outO[keys[k]] = '[getter threw]'; }
        }
        if (keys.length > 120) outO.__truncatedKeys = keys.length - 120;
        return outO;
      } catch (e) {
        return '[unserialisable]';
      }
    }
    return walk(v, typeof maxDepth === 'number' ? maxDepth : 6);
  }

  // Which bundle file registered this? Turns findings into citable evidence.
  function shortStack(skip) {
    try {
      var lines = (new Error().stack || '').split('\n');
      var out = [];
      for (var i = 1 + (skip || 0); i < lines.length && out.length < 4; i++) {
        var l = lines[i].trim().replace(/^at\s+/, '');
        if (l && l.indexOf('hook.js') === -1) out.push(l);
      }
      return out;
    } catch (e) { return []; }
  }

  function trackInfo(track) {
    if (!track) return null;
    var info = { id: track.id, kind: track.kind, label: track.label, readyState: track.readyState, muted: track.muted, enabled: track.enabled };
    try { info.settings = safe(track.getSettings ? track.getSettings() : null, 3); } catch (e) { info.settings = '[getSettings threw]'; }
    try { info.constraints = safe(track.getConstraints ? track.getConstraints() : null, 3); } catch (e) {}
    return info;
  }

  // ---- message store ------------------------------------------------------
  // Ring buffers alone would lose the session-setup messages, which is exactly
  // where a monitor layout is most likely to arrive. So: keep the FIRST N
  // verbatim, a rolling RECENT N, and the first sample of every distinct
  // message type forever.
  var MSG = {
    total: 0,
    byType: {},
    firstByType: {},
    first: [],
    recent: []
  };

  function lenBucket(n) {
    if (n == null) return '?';
    if (n < 16) return '<16';
    if (n < 64) return '<64';
    if (n < 256) return '<256';
    if (n < 1024) return '<1K';
    if (n < 16384) return '<16K';
    return '>=16K';
  }

  function hexHead(u8, n) {
    var out = [];
    for (var i = 0; i < u8.length && i < (n || 16); i++) {
      out.push(('0' + u8[i].toString(16)).slice(-2));
    }
    return out.join(' ');
  }

  var TYPE_KEYS = ['type', 'event', 'action', 'cmd', 'command', 'msgType', 'messageType',
    'method', 'name', 'op', 'kind', 'evt', 't', 'm', 'e'];

  function typeOf(parsed, raw) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (var i = 0; i < TYPE_KEYS.length; i++) {
        var v = parsed[TYPE_KEYS[i]];
        if (typeof v === 'string' || typeof v === 'number') return TYPE_KEYS[i] + '=' + v;
      }
      try {
        return 'keys:' + Object.keys(parsed).slice(0, 5).sort().join(',');
      } catch (e) { return 'object'; }
    }
    if (Array.isArray(parsed)) return 'array[' + parsed.length + ']';
    if (typeof raw === 'string') return 'text:' + raw.slice(0, 24).replace(/\s+/g, ' ');
    return 'other';
  }

  function record(source, dir, data) {
    try {
      MSG.total++;
      var rec = { n: MSG.total, at: Date.now(), source: source, dir: dir };
      var parsed = null, raw = null, type;

      if (typeof data === 'string') {
        rec.kind = 'text';
        rec.len = data.length;
        if (data.length <= PARSE_MAX) {
          var c = data.charAt(0);
          if (c === '{' || c === '[' || c === '"') {
            try { parsed = JSON.parse(data); } catch (e) { /* not JSON */ }
          }
        }
        if (parsed === null) {
          raw = data.length > RAW_MAX ? data.slice(0, RAW_MAX) + '…[+' + (data.length - RAW_MAX) + ']' : data;
        }
        type = typeOf(parsed, raw !== null ? raw : data);
      } else if (data instanceof ArrayBuffer) {
        rec.kind = 'binary';
        rec.len = data.byteLength;
        rec.head = hexHead(new Uint8Array(data, 0, Math.min(16, data.byteLength)));
        type = 'binary:' + lenBucket(rec.len);
      } else if (data && ArrayBuffer.isView(data)) {
        rec.kind = 'binary';
        rec.len = data.byteLength;
        try { rec.head = hexHead(new Uint8Array(data.buffer, data.byteOffset, Math.min(16, data.byteLength))); } catch (e) {}
        type = 'binary:' + lenBucket(rec.len);
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        rec.kind = 'blob';
        rec.len = data.size;
        type = 'blob:' + lenBucket(rec.len);
      } else {
        rec.kind = typeof data;
        type = 'other:' + rec.kind;
      }

      if (parsed !== null) rec.parsed = safe(parsed, 7);
      else if (raw !== null) rec.raw = raw;
      rec.type = type;

      var b = MSG.byType[type];
      if (!b) b = MSG.byType[type] = { count: 0, firstAt: rec.at, lastAt: rec.at, in: 0, out: 0, sources: {} };
      b.count++;
      b.lastAt = rec.at;
      b[dir] = (b[dir] || 0) + 1;
      b.sources[source] = (b.sources[source] || 0) + 1;

      if (!MSG.firstByType[type]) MSG.firstByType[type] = rec;
      if (MSG.first.length < FIRST_N) MSG.first.push(rec);
      MSG.recent.push(rec);
      if (MSG.recent.length > RECENT_N) MSG.recent.shift();
    } catch (e) { oops('record', e); }
  }

  F.collectMessages = function () {
    return {
      total: MSG.total,
      distinctTypes: Object.keys(MSG.byType).length,
      byType: MSG.byType,
      firstByType: MSG.firstByType,
      first: MSG.first,
      recent: MSG.recent,
      retention: { firstN: FIRST_N, recentN: RECENT_N, rawMax: RAW_MAX }
    };
  };

  // ---- 1. RTCPeerConnection ----------------------------------------------
  // Wrapper constructor that returns the real pc (an object return from [[Construct]]
  // replaces `this`) and shares the native prototype, so page-side instanceof
  // checks and prototype patching both still work.
  try {
    var NativePC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (NativePC) {
      var pcSeq = 0;

      var recordTrackEvent = function (pcId, ev) {
        try {
          var te = {
            at: Date.now(),
            pcId: pcId,
            track: trackInfo(ev.track),
            streamIds: (ev.streams || []).map(function (s) { return s.id; }),
            streamTrackCounts: (ev.streams || []).map(function (s) { return s.getTracks().length; }),
            transceiverMid: ev.transceiver ? ev.transceiver.mid : null,
            transceiverDirection: ev.transceiver ? ev.transceiver.currentDirection : null
          };
          F.trackEvents.push(te);
          if (ev.track) {
            LIVE.tracks.push({
              trackId: ev.track.id, kind: ev.track.kind, pcId: pcId,
              firstSeenAt: te.at, track: ev.track,
              streams: (ev.streams || []).slice()
            });
            // Track lifecycle evidence for Q7.
            ev.track.addEventListener('ended', function () {
              F.trackEvents.push({ at: Date.now(), pcId: pcId, event: 'track-ended', trackId: ev.track.id });
            });
            ev.track.addEventListener('mute', function () {
              F.trackEvents.push({ at: Date.now(), pcId: pcId, event: 'track-mute', trackId: ev.track.id });
            });
            ev.track.addEventListener('unmute', function () {
              F.trackEvents.push({ at: Date.now(), pcId: pcId, event: 'track-unmute', trackId: ev.track.id });
            });
          }
          (ev.streams || []).forEach(function (s) {
            if (LIVE.streams.indexOf(s) === -1) LIVE.streams.push(s);
          });
        } catch (e) { oops('recordTrackEvent', e); }
      };

      var instrumentChannel = function (dc, origin, pcId) {
        try {
          var rec = {
            at: Date.now(), pcId: pcId, origin: origin,
            label: dc.label, id: dc.id, ordered: dc.ordered,
            protocol: dc.protocol, binaryType: dc.binaryType,
            states: [{ at: Date.now(), v: dc.readyState }]
          };
          F.dataChannels.push(rec);
          LIVE.channels.push(dc);
          var key = 'dc:' + (dc.label || '?');
          dc.addEventListener('message', function (ev) { record(key, 'in', ev.data); });
          dc.addEventListener('open', function () { rec.states.push({ at: Date.now(), v: 'open' }); });
          dc.addEventListener('close', function () { rec.states.push({ at: Date.now(), v: 'closed' }); });
        } catch (e) { oops('instrumentChannel', e); }
      };
      F.__instrumentChannel = instrumentChannel;

      var WrappedPC = function (config, constraints) {
        var pc = arguments.length > 1 ? new NativePC(config, constraints) : new NativePC(config);
        try {
          var id = ++pcSeq;
          var rec = {
            id: id, createdAt: Date.now(),
            config: safe(config, 4),
            createdBy: shortStack(1),
            iceStates: [], connStates: [], signalingStates: []
          };
          F.peerConnections.push(rec);
          LIVE.pcs.push({ id: id, pc: pc });

          pc.addEventListener('track', function (ev) { recordTrackEvent(id, ev); });
          pc.addEventListener('datachannel', function (ev) { instrumentChannel(ev.channel, 'remote', id); });
          pc.addEventListener('iceconnectionstatechange', function () {
            rec.iceStates.push({ at: Date.now(), v: pc.iceConnectionState });
          });
          pc.addEventListener('connectionstatechange', function () {
            rec.connStates.push({ at: Date.now(), v: pc.connectionState });
          });
          pc.addEventListener('signalingstatechange', function () {
            rec.signalingStates.push({ at: Date.now(), v: pc.signalingState });
          });
        } catch (e) { oops('WrappedPC', e); }
        return pc;
      };

      WrappedPC.prototype = NativePC.prototype;
      Object.getOwnPropertyNames(NativePC).forEach(function (k) {
        if (k === 'prototype' || k === 'name' || k === 'length') return;
        try { WrappedPC[k] = NativePC[k]; } catch (e) {}
      });

      // Locally-created data channels (the remote-desktop protocol very likely
      // lives on one of these, given Connection: WebRTC (P2P)).
      var origCreateDC = NativePC.prototype.createDataChannel;
      if (origCreateDC) {
        NativePC.prototype.createDataChannel = function () {
          var dc = origCreateDC.apply(this, arguments);
          try {
            var pcId = null;
            for (var i = 0; i < LIVE.pcs.length; i++) if (LIVE.pcs[i].pc === this) pcId = LIVE.pcs[i].id;
            instrumentChannel(dc, 'local', pcId);
          } catch (e) { oops('createDataChannel', e); }
          return dc;
        };
      }

      // Outbound data-channel traffic (how the monitor selector talks, for Q5).
      if (window.RTCDataChannel && RTCDataChannel.prototype && RTCDataChannel.prototype.send) {
        var origDcSend = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (data) {
          try { record('dc:' + (this.label || '?'), 'out', data); } catch (e) {}
          return origDcSend.apply(this, arguments);
        };
        F.installed.dataChannelSend = true;
      }

      window.RTCPeerConnection = WrappedPC;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = WrappedPC;
      F.installed.rtcPeerConnection = true;
    } else {
      F.installed.rtcPeerConnection = false;
      F.errors.push({ where: 'RTCPeerConnection', error: 'not present on window at document_start' });
    }
  } catch (e) { oops('install:RTCPeerConnection', e); }

  // ---- 2. HTMLMediaElement.prototype.srcObject ---------------------------
  // srcObject is a Web IDL accessor on HTMLMediaElement.prototype (NOT
  // HTMLVideoElement.prototype). The native setter brand-checks `this`, so it
  // must be called with the element as receiver or it throws Illegal invocation.
  try {
    var mediaProto = window.HTMLMediaElement && HTMLMediaElement.prototype;
    var desc = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, 'srcObject');
    if (desc && typeof desc.set === 'function' && desc.configurable) {
      var nativeGet = desc.get, nativeSet = desc.set;
      Object.defineProperty(mediaProto, 'srcObject', {
        configurable: desc.configurable,
        enumerable: desc.enumerable,
        get: function () { return nativeGet.call(this); },
        set: function (value) {
          try {
            var entry = {
              at: Date.now(),
              element: {
                tag: this.tagName,
                id: this.id || null,
                className: (typeof this.className === 'string' ? this.className : null),
                inDocument: this.isConnected,
                autoplay: this.autoplay, muted: this.muted, controls: this.controls
              },
              value: value === null ? null : (function (v) {
                try {
                  return {
                    ctor: v && v.constructor && v.constructor.name,
                    streamId: v && v.id,
                    active: v && v.active,
                    tracks: (v && v.getTracks) ? v.getTracks().map(trackInfo) : null
                  };
                } catch (e) { return '[introspect threw]'; }
              })(value),
              setBy: shortStack(1)
            };
            if (F.srcObjectSets.length < 80) F.srcObjectSets.push(entry);
            if (value && value.getTracks && LIVE.streams.indexOf(value) === -1) LIVE.streams.push(value);
          } catch (e) { oops('srcObject setter', e); }
          return nativeSet.call(this, value);
        }
      });
      F.installed.srcObject = true;
    } else {
      F.installed.srcObject = false;
      F.errors.push({
        where: 'srcObject',
        error: desc ? ('descriptor not patchable, configurable=' + desc.configurable) : 'no descriptor on HTMLMediaElement.prototype'
      });
    }
  } catch (e) { oops('install:srcObject', e); }

  // ---- 3. WebSocket ------------------------------------------------------
  try {
    var NativeWS = window.WebSocket;
    if (NativeWS) {
      var wsSeq = 0;
      var wsIds = new WeakMap();

      var WrappedWS = function (url, protocols) {
        var ws = arguments.length > 1 ? new NativeWS(url, protocols) : new NativeWS(url);
        try {
          var id = ++wsSeq;
          wsIds.set(ws, id);
          var rec = {
            id: id, at: Date.now(), url: String(url),
            protocols: protocols ? safe(protocols, 2) : null,
            openedBy: shortStack(1),
            states: []
          };
          F.sockets.push(rec);
          LIVE.sockets.push(ws);
          var key = 'ws:' + id;
          ws.addEventListener('message', function (ev) { record(key, 'in', ev.data); });
          ws.addEventListener('open', function () { rec.states.push({ at: Date.now(), v: 'open', protocol: ws.protocol }); });
          ws.addEventListener('close', function (ev) { rec.states.push({ at: Date.now(), v: 'closed', code: ev.code, reason: ev.reason, wasClean: ev.wasClean }); });
          ws.addEventListener('error', function () { rec.states.push({ at: Date.now(), v: 'error' }); });
        } catch (e) { oops('WrappedWS', e); }
        return ws;
      };

      WrappedWS.prototype = NativeWS.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
        try { WrappedWS[k] = NativeWS[k]; } catch (e) {}
      });

      var origWsSend = NativeWS.prototype.send;
      NativeWS.prototype.send = function (data) {
        try { record('ws:' + (wsIds.get(this) || '?'), 'out', data); } catch (e) {}
        return origWsSend.apply(this, arguments);
      };

      window.WebSocket = WrappedWS;
      F.installed.webSocket = true;
    }
  } catch (e) { oops('install:WebSocket', e); }

  // ---- 4. visibility / lifecycle listeners -------------------------------
  // RECORD ONLY in Phase 0. We need to know whether the app tears the track
  // down when the tab is backgrounded before deciding whether to neuter it.
  try {
    var WATCHED = { visibilitychange: 1, pagehide: 1, pageshow: 1, freeze: 1, resume: 1, blur: 1, focus: 1, beforeunload: 1, unload: 1 };
    // Where the app listens for input. Synthesised events have to be dispatched at
    // the element the app actually listens on - guessing the canvas is not enough,
    // and this is the difference between forwarded input working and silently doing
    // nothing.
    var INPUT_TYPES = {
      mousemove: 1, mousedown: 1, mouseup: 1, click: 1, dblclick: 1, contextmenu: 1, wheel: 1,
      pointermove: 1, pointerdown: 1, pointerup: 1,
      keydown: 1, keyup: 1, keypress: 1
    };
    F.inputListeners = [];
    var seenInput = {};

    var origAEL = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      try {
        if (WATCHED[type] && (this === document || this === window)) {
          if (F.visibilityListeners.length < 80) {
            F.visibilityListeners.push({
              at: Date.now(), type: type,
              target: this === document ? 'document' : 'window',
              registeredBy: shortStack(1)
            });
          }
        }
        if (INPUT_TYPES[type]) {
          var what;
          if (this === document) what = 'document';
          else if (this === window) what = 'window';
          else if (this && this.nodeType === 1) {
            what = this.nodeName.toLowerCase() +
              (this.id ? '#' + this.id : '') +
              (typeof this.className === 'string' && this.className.trim()
                ? '.' + this.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
          } else what = String(this && this.constructor && this.constructor.name);

          var key = type + '|' + what;
          if (!seenInput[key] && F.inputListeners.length < 120) {
            seenInput[key] = 1;
            F.inputListeners.push({
              at: Date.now(), type: type, target: what,
              isElement: !!(this && this.nodeType === 1),
              tag: (this && this.nodeType === 1) ? this.nodeName.toLowerCase() : null,
              registeredBy: shortStack(1)
            });
            // Keep the live node so app.js can dispatch straight at it.
            if (this && this.nodeType === 1) {
              LIVE.inputTargets = LIVE.inputTargets || [];
              if (LIVE.inputTargets.indexOf(this) === -1) LIVE.inputTargets.push(this);
            }
          }
        }
      } catch (e) {}
      return origAEL.apply(this, arguments);
    };
    F.installed.addEventListener = true;
  } catch (e) { oops('install:addEventListener', e); }

  // ---- 5. cold-path fallback poll ---------------------------------------
  // If the hook landed late, or the app binds a stream some way we did not
  // anticipate, this still finds it. Phases 1-2 rely on exactly this path, so
  // it is worth knowing independently whether it works.
  F.coldScan = function () {
    var out = { at: Date.now(), videos: [], canvases: [], reachableTracks: 0 };
    try {
      var vids = document.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        var r = v.getBoundingClientRect();
        var so = null;
        try { so = v.srcObject; } catch (e) { so = '[threw]'; }
        var entry = {
          index: i,
          id: v.id || null,
          className: typeof v.className === 'string' ? v.className : null,
          videoWidth: v.videoWidth, videoHeight: v.videoHeight,
          clientWidth: v.clientWidth, clientHeight: v.clientHeight,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          readyState: v.readyState, paused: v.paused, currentSrc: v.currentSrc || null,
          hasSrcObject: !!(so && so !== '[threw]'),
          objectFit: getComputedStyle(v).objectFit,
          transform: getComputedStyle(v).transform,
          selector: cssPath(v)
        };
        if (so && so !== '[threw]' && so.getTracks) {
          entry.stream = { id: so.id, active: so.active, tracks: so.getTracks().map(trackInfo) };
          out.reachableTracks += so.getTracks().length;
        }
        out.videos.push(entry);
      }
      var cans = document.querySelectorAll('canvas');
      for (var j = 0; j < cans.length && j < 20; j++) {
        var c = cans[j];
        var cr = c.getBoundingClientRect();
        out.canvases.push({
          index: j, id: c.id || null,
          className: typeof c.className === 'string' ? c.className : null,
          width: c.width, height: c.height,
          rect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
          selector: cssPath(c)
        });
      }
    } catch (e) { oops('coldScan', e); }
    return out;
  };

  function cssPath(el) {
    try {
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && parts.length < 6) {
        var seg = node.nodeName.toLowerCase();
        if (node.id) { parts.unshift(seg + '#' + node.id); break; }
        var cls = (typeof node.className === 'string' && node.className.trim())
          ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
        var parent = node.parentElement;
        if (parent) {
          var sibs = Array.prototype.filter.call(parent.children, function (s) { return s.nodeName === node.nodeName; });
          if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
        }
        parts.unshift(seg + cls);
        node = node.parentElement;
      }
      return parts.join(' > ');
    } catch (e) { return null; }
  }
  F.cssPath = cssPath;

  // Best current video track, preferring what the hook observed over what we
  // can scrape. Phases 1-2 will call this.
  F.bestVideoTrack = function () {
    for (var i = LIVE.tracks.length - 1; i >= 0; i--) {
      var t = LIVE.tracks[i];
      if (t.kind === 'video' && t.track && t.track.readyState === 'live') {
        return { track: t.track, via: 'hook:ontrack', pcId: t.pcId };
      }
    }
    try {
      var vids = document.querySelectorAll('video');
      for (var j = 0; j < vids.length; j++) {
        var so = vids[j].srcObject;
        if (so && so.getVideoTracks) {
          var vt = so.getVideoTracks();
          for (var k = 0; k < vt.length; k++) {
            if (vt[k].readyState === 'live') return { track: vt[k], via: 'cold:video.srcObject', element: vids[j] };
          }
        }
      }
    } catch (e) { oops('bestVideoTrack', e); }
    return null;
  };

  // The <video> the app is actually painting into: largest by rendered area.
  F.primaryVideo = function () {
    var best = null, bestArea = -1;
    try {
      var vids = document.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        if (!v.videoWidth || !v.videoHeight) continue;
        var r = v.getBoundingClientRect();
        var area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = v; }
      }
    } catch (e) { oops('primaryVideo', e); }
    return best;
  };

  F.installed.completedAt = Date.now();
  try {
    console.info('[WRMM] hook installed at document_start', {
      readyState: F.hook.readyStateAtInstall,
      bodyExisted: F.hook.bodyExistedAtInstall,
      installed: F.installed
    });
  } catch (e) {}
})();
