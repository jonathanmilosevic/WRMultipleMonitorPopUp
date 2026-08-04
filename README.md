# Web Remote multi-monitor popout — proof of concept

Throwaway unpacked Chrome extension. **Not product code. Will not be merged.** No backend, agent, or protocol changes.

One button, injected under the minimap in the Display section, styled to match the app's own controls. **One click pops every remote monitor into its own window on its own local display.**

---

## Turn on logging first

The extension can't write into this folder, so it POSTs batched logs to a small PowerShell receiver. **Start this before reproducing a problem** — without it the log lines are simply dropped and nothing breaks, but there's nothing to read afterwards.

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File tools/logsink.ps1
```

Logs land in `logs/wrmm.log`. Leave the window open while you use the session, then say so and the log can be read directly — detection results, chosen split, where input is being dispatched, blanking state, and every error.

---

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder: `WRMultipleMonitorPopUp`

Requires Chrome 111 or newer. Chromium only.

> **Reload the Web Remote page after loading the extension.** Part of this runs before the page's own JavaScript, so it cannot attach to a session that was already open.

## Use

Open a Web Remote session against a multi-monitor endpoint, set **ALL MONITORS**, and click **POP OUT ALL MONITORS** under the minimap.

Works in **SINGLE MONITOR** mode too — that pops out the one visible screen as a single window, which is a legitimate result rather than a failure.

**Web Remote 2.0** is matched as well (`*.rmm.datto.com`). 2.0 has no monitor controls to anchor to, so the button appears as a floating pill bottom-right instead of under a minimap. Everything else is unchanged: detection, cropping and input are all driven off the render surface, not off the app's UI. The button only appears on pages where a live render surface is actually found.

Windows **cascade in front of you**, each sized to its own monitor's aspect ratio so the video fills it with no letterboxing — drag them wherever you want them. No display permission is requested, so there is nothing to wait on.

While popouts are open the **in-tab view is blanked**, so the popouts read as the intended way to drive the machine. The surface underneath keeps painting — that is what feeds the windows. Closing the last popout restores the in-tab view automatically, as does **Close popouts & restore view**.

The button becomes **FOCUS n POPOUTS**; clicking again focuses the existing windows rather than opening duplicates.

---

## How it works

The endpoint composites every monitor into one frame. Rather than open a second session, each popout window binds a `<video>` to the **same** stream and applies a CSS transform so only one monitor's region is visible. One connection, one decode, N views.

Two findings from probing the live page shaped this:

- **The remote screen is painted into a `<canvas>`, not a `<video>`.** The page has one peer connection with zero incoming media tracks, so frames arrive as data. `captureStream()` on that canvas produces a real `MediaStream` without touching the session, which means the same crop-and-bind path works either way. If a future client switches to a `<video>` element, the code takes that path automatically.
- **No `Cross-Origin-Opener-Policy` header.** `about:blank` popups are same-origin with a writable DOM, so they can share the stream. Had that header been present, this approach would not have been possible at all.

Monitor rectangles are **auto-detected** from the composite. The measured composite on the test endpoint is `3008×2688` — a two-dimensional arrangement, not a horizontal strip.

Detection samples several frames from a `<video>` fed by the captured stream (never by reading the canvas directly — a WebGL canvas reads back blank), then runs **both** methods every time and takes whichever separates more monitors:

1. **Edge-split** — the primary method. Two monitors butted together still leave a hard discontinuity, so it scores candidate lines by *how much of the line* is discontinuous in **colour**, requiring 90% of the edge. Colour rather than luminance, because two wallpapers often differ in hue at near-identical brightness. Cuts that would leave an implausible shape are rejected, which stops it slicing along the top edge of a taskbar. Runs automatically — no button to press.
2. **Gutter cutting** — trim to lit content, find the widest blank row or column spanning the region, cut, recurse. Grid resolution is ~3px with a tolerant blankness test, because the endpoint packs monitors with a seam of roughly 12 pixels; a coarse grid cannot see a gap that small.

On a tie, edge-split wins: it trims to real content rather than to whatever padding happened to be black.

Every proposed region is then **validated** against the occupancy grid. A real monitor is almost entirely lit, so a region containing a large black area means the split is wrong — in that case it refuses to open windows and says so, rather than opening plausible-looking windows showing the wrong thing.

Verified on a 3-monitor L-shaped layout with a portrait monitor, requiring both a vertical and a horizontal cut: exact with a 12px seam, and exact with **no seam at all**, including when no monitor count is available at all (it stops at the right number rather than over-splitting).

Three earlier algorithms failed and are worth knowing about, since each failure looked like success:
- **Connected components** merged monitors on any diagonal touch — this produced two windows, one showing a blend of screens.
- **Even split** by reported count is only valid for one row of identical monitors; on an L-shaped layout it produced three equal strips and reported success. Removed.
- **Luminance edge energy** got out-competed by white text inside a monitor and cut in the wrong place.

### If detection still gets it wrong

A **Monitors [n]** control appears with two buttons:
- **Find boundaries** — you supply the count, edge detection places the cuts. Try this first.
- **Even grid** — equal-sized monitors only, a genuine last resort.

The status line always names the method used and warns when the detected count disagrees with the count the page reports.

---

## Input is live

Each window shows an `INPUT LIVE` badge in a hover-revealed top bar, with a **View only** toggle and **Fullscreen** button. Mouse, wheel, right-click and keyboard all forward to the session.

The original brief made popouts view-only for a real reason: with per-window input handlers, pressing Ctrl in one window and releasing it over another leaves the endpoint holding the modifier down indefinitely. Input is implemented the safe way instead:

- **Children never talk to the session.** They translate the event into composite coordinates using their own crop transform, then hand it to the parent tab.
- **The parent owns one input state machine** and tracks exactly which keys and buttons are held.
- **Anything held is explicitly released** when input moves to a different window, when a window loses focus, and when a window closes. That is the stuck-modifier fix.
- Events out of the monitor's own region are ignored, so the letterbox margins don't click anything.
- `F11` and `F12` stay local so window management and devtools still work.

Both `PointerEvent` and `MouseEvent` are dispatched, since canvas apps listen for one or the other.

**Dispatch target.** Aiming events at the render surface is only a guess — if the app listens on a wrapper element instead, events at the canvas do nothing at all. `hook.js` records every element that registers a mouse, pointer or key listener, and input is dispatched at the most specific one. The resolved target and the full listener map are written to the log.

**Cursor.** The endpoint does not composite its pointer into the video, which is why a popout shows hover highlights but no cursor. Each window therefore draws its own pointer at the last known remote position, tracked both from input forwarded out of a popout and from real pointer movement in the parent tab, so it stays correct whichever place you drive from.

**Precision caveat:** coordinates route through the session's own surface, and `MouseEvent` client coordinates are integers. At the measured 0.4 display scale that means up to ~2 composite pixels of error — the same precision the app has when you use it in-tab, but worth knowing since popouts magnify the view.

---

## Known limitations (expected, not bugs)

- **Each monitor is below native resolution.** The endpoint encodes the whole virtual desktop at one resolution, so a single monitor is a fraction of that, upscaled locally. Each window's footer shows its actual scale factor. Fine for triage, not for reading small text — this is the evidence for whether per-monitor encoding is worth building.
- **A minimised or fully covered popout freezes.** Chrome suspends video frame delivery for windows it treats as hidden. Not fixable from JavaScript. Windows on separate monitors don't cover each other, so the normal case is unaffected.
- **Scaled video gives up the hardware overlay path** on Windows. Still GPU-composited, just slightly more GPU bandwidth.
- **Popout windows are `about:blank`.** Reloading or navigating one destroys it with no recovery; close it and pop out again.

## Popup blocking

Chrome allows only one popup per click, so three monitors would mean three clicks. To keep it to one, the extension sets the popup content-setting to `allow` **for `bacchus.rmm.datto.com` only** (you approved this).

To revert: `chrome://settings/content/popups`, or remove the extension. If popups are blocked anyway, the status line says so explicitly and tells you what to click — it never fails silently.

---

## Files

| File | Runs in | Purpose |
|---|---|---|
| `manifest.json` | — | MV3 manifest, scoped to the one host |
| `hook.js` | page's JS world, at `document_start` | Observes `RTCPeerConnection`, `srcObject`, `WebSocket` and data channels to locate the stream and any monitor layout. Must stay fully synchronous — see the comment at the top |
| `app.js` | page's JS world, at `document_idle` | Button injection, geometry auto-detection, popout windows, lifecycle |
| `app.css` | — | Minimal; the button copies the app's own computed button styling at runtime |
| `bridge.js` | isolated world | Relays control messages to the service worker (the page world has no `chrome.*`) |
| `sw.js` | service worker | Popup content-setting |
| `tools/logsink.ps1` | PowerShell | Receives batched logs and appends them to `logs/wrmm.log` |
| `dev-check.html` | — | Dev-only. Parses every source and asserts the manifest invariants |
| `dev-harness.html` | — | Dev-only. Simulates a canvas-rendered 3-monitor session plus the control rail, so everything but the popup windows can be tested with no endpoint |

### Dev-only harnesses

Neither is referenced by the manifest, so both are inert at runtime. They exist because there is no Node on this machine. Serve this folder over HTTP (`fetch` does not work from `file://`):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File ../.claude/serve.ps1 -Port 4199 -Root .
```

> **Do not rename these with a leading underscore.** Chrome reserves the `_` prefix and refuses to load an extension containing any such file, failing with `Could not load manifest`.

`dev-check.html` also fails the build if `hook.js` ever gains an `await`, an `import`, or a `chrome.*` reference, any of which would silently break the `document_start` ordering everything depends on.

For a compact status dump in the console on any page: `window.__WRMM_DIAG__()`.
