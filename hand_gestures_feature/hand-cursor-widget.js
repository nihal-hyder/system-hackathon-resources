/*!
 * Hand Cursor Widget
 * -------------------
 * Drop this into ANY website / project and it works, unchanged:
 *
 *   <script src="hand-cursor-widget.js"></script>
 *
 * Put that one line anywhere in your HTML (before </body> is fine).
 * That's it — no other markup, no build step, no framework needed.
 *
 * What it does:
 *   - Shows a small "Enable Hand Control" button in the corner.
 *   - On click, asks for webcam access (required by every browser -
 *     it can never turn on silently, that's a security rule, not a
 *     limitation of this code).
 *   - Once enabled, tracks your index finger and moves an on-page
 *     cursor dot to follow it.
 *   - Move your finger up/down steadily -> the page scrolls up/down.
 *   - Pinch thumb + index finger together -> clicks whatever the
 *     cursor is currently over (links, buttons, anything).
 *
 * Why it works on "any" site: it never touches or assumes anything
 * about the host page's own HTML/CSS/JS. It only reads the screen
 * position of your finger and dispatches normal scroll/click actions,
 * the same way a mouse would. That's what makes it portable.
 *
 * Note on scope: a browser can never move the OS-level mouse cursor
 * (that's blocked for every website, for security). This draws its
 * own on-page cursor and drives scrolling/clicking directly, which is
 * what actually gives you a "hand controls the page" experience on
 * the web.
 */
(function () {
  "use strict";

  // ------------------------- CONFIG -------------------------------
  const CONFIG = {
    cameraWidth: 400,          // small = fast. Raise to 640 for more accuracy, more lag.
    cameraHeight: 300,
    minCutoff: 0.8,            // One-Euro filter: lower = smoother cursor, more lag
    beta: 0.4,                 // One-Euro filter: higher = snappier during fast moves
    scrollThreshold: 0.012,    // fraction of screen height finger must move to trigger scroll
    scrollAmount: 60,          // px scrolled per trigger
    scrollCooldownMs: 120,     // min time between scroll triggers
    pinchThreshold: 0.045,     // normalized distance between thumb+index tip to count as pinch
    pinchCooldownMs: 500,      // min time between clicks
    modelComplexity: 1,        // 0 = fastest/least reliable, 1 = more reliable on open-hand poses
    detectionGraceMs: 350,     // keep cursor alive this long through brief tracking drop-outs
  };
  // ------------------------------------------------------------------

  // One-Euro Filter: smooths jitter while staying responsive to fast moves.
  // (Same filtering approach used in most production hand/face tracking demos.)
  class OneEuroFilter {
    constructor(minCutoff, beta) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = 1.0;
      this.xPrev = null;
      this.dxPrev = 0;
      this.tPrev = null;
    }
    alpha(cutoff, dt) {
      const tau = 1.0 / (2 * Math.PI * cutoff);
      return 1.0 / (1.0 + tau / dt);
    }
    filter(x, tMs) {
      if (this.tPrev === null) {
        this.tPrev = tMs;
        this.xPrev = x;
        return x;
      }
      const dt = Math.max((tMs - this.tPrev) / 1000, 0.001);
      const dx = (x - this.xPrev) / dt;
      const aD = this.alpha(this.dCutoff, dt);
      const dxHat = aD * dx + (1 - aD) * this.dxPrev;
      const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
      const a = this.alpha(cutoff, dt);
      const xHat = a * x + (1 - a) * this.xPrev;
      this.tPrev = tMs;
      this.xPrev = xHat;
      this.dxPrev = dxHat;
      return xHat;
    }
    reset() {
      this.xPrev = null;
      this.dxPrev = 0;
      this.tPrev = null;
    }
  }

  let enabled = false;
  let videoEl, handsInstance, cameraLoopId;
  let cursorEl, toggleBtn, statusEl;
  let filterX, filterY;
  let smoothX = null, smoothY = null;
  let prevFingerY = null;
  let lastScrollTime = 0;
  let lastPinchTime = 0;
  let lastSeenTime = 0;      // last time a hand was actually detected
  let scriptsLoaded = false;

  // ---------- 1. Inject minimal CSS (scoped, won't clash with host site) ----------
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #hcw-toggle-btn {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
        padding: 10px 16px; border-radius: 999px; border: none;
        background: #111827; color: #fff; font: 600 14px/1 system-ui, sans-serif;
        cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25);
        transition: background .15s ease;
      }
      #hcw-toggle-btn:hover { background: #2d3748; }
      #hcw-toggle-btn.hcw-active { background: #16a34a; }
      #hcw-status {
        position: fixed; bottom: 62px; right: 20px; z-index: 2147483647;
        font: 500 12px/1.4 system-ui, sans-serif; color: #374151;
        background: rgba(255,255,255,.9); padding: 6px 10px; border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,.15); display: none; max-width: 220px;
      }
      #hcw-cursor {
        position: fixed; top: 0; left: 0; width: 22px; height: 22px;
        border: 3px solid #16a34a; border-radius: 50%;
        background: rgba(22,163,74,.15);
        transform: translate(-50%, -50%);
        pointer-events: none; z-index: 2147483646;
        display: none; transition: border-color .1s ease, background .1s ease;
      }
      #hcw-cursor.hcw-pinching {
        border-color: #dc2626; background: rgba(220,38,38,.25);
      }
      #hcw-video {
        position: fixed; top: 20px; right: 20px; width: 260px; height: 195px;
        border-radius: 10px; z-index: 2147483646; opacity: .9;
        box-shadow: 0 4px 16px rgba(0,0,0,.35); transform: scaleX(-1);
        display: none; object-fit: cover; border: 2px solid rgba(255,255,255,.5);
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- 2. Build the UI elements ----------
  function buildUI() {
    toggleBtn = document.createElement("button");
    toggleBtn.id = "hcw-toggle-btn";
    toggleBtn.textContent = "🖐️ Enable Hand Control";
    toggleBtn.addEventListener("click", onToggleClick);
    document.body.appendChild(toggleBtn);

    statusEl = document.createElement("div");
    statusEl.id = "hcw-status";
    document.body.appendChild(statusEl);

    cursorEl = document.createElement("div");
    cursorEl.id = "hcw-cursor";
    document.body.appendChild(cursorEl);

    videoEl = document.createElement("video");
    videoEl.id = "hcw-video";
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    document.body.appendChild(videoEl);
  }

  function setStatus(msg, show) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.display = show ? "block" : "none";
  }

  // ---------- 3. Lazy-load MediaPipe Hands (only when the user opts in) ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function ensureMediaPipeLoaded() {
    if (scriptsLoaded) return;
    setStatus("Loading hand-tracking model...", true);
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
    scriptsLoaded = true;
  }

  // ---------- 4. Toggle on/off ----------
  async function onToggleClick() {
    if (enabled) {
      stop();
      return;
    }
    try {
      toggleBtn.disabled = true;
      await ensureMediaPipeLoaded();
      await start();
    } catch (err) {
      console.error("[HandCursorWidget]", err);
      setStatus("Couldn't start camera/model. Check permissions.", true);
    } finally {
      toggleBtn.disabled = false;
    }
  }

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: CONFIG.cameraWidth, height: CONFIG.cameraHeight, facingMode: "user" },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();

    handsInstance = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    handsInstance.setOptions({
      maxNumHands: 1,
      modelComplexity: CONFIG.modelComplexity,
      minDetectionConfidence: 0.5,   // lower = keeps tracking through open-hand / edge poses
      minTrackingConfidence: 0.4,
    });
    handsInstance.onResults(onResults);

    filterX = new OneEuroFilter(CONFIG.minCutoff, CONFIG.beta);
    filterY = new OneEuroFilter(CONFIG.minCutoff, CONFIG.beta);

    enabled = true;
    toggleBtn.textContent = "🖐️ Disable Hand Control";
    toggleBtn.classList.add("hcw-active");
    cursorEl.style.display = "block";
    videoEl.style.display = "block";
    setStatus("Tracking hand — move your index finger.", true);

    runLoop();
  }

  function stop() {
    enabled = false;
    if (cameraLoopId) cancelAnimationFrame(cameraLoopId);
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach((t) => t.stop());
      videoEl.srcObject = null;
    }
    toggleBtn.textContent = "🖐️ Enable Hand Control";
    toggleBtn.classList.remove("hcw-active");
    cursorEl.style.display = "none";
    videoEl.style.display = "none";
    setStatus("", false);
    smoothX = smoothY = null;
    prevFingerY = null;
    if (filterX) filterX.reset();
    if (filterY) filterY.reset();
  }

  // ---------- 5. Main camera -> model loop ----------
  async function runLoop() {
    if (!enabled) return;
    if (videoEl.readyState >= 2) {
      await handsInstance.send({ image: videoEl });
    }
    cameraLoopId = requestAnimationFrame(runLoop);
  }

  // ---------- 6. Handle each frame's hand landmarks ----------
  function onResults(results) {
    const now = performance.now();

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      // Don't kill tracking on a single missed frame (this is what made open-hand
      // poses feel like they "stopped working" - detection briefly dips on some
      // hand shapes/angles). Only give up after a short grace window.
      if (now - lastSeenTime > CONFIG.detectionGraceMs) {
        prevFingerY = null;
      }
      return;
    }
    lastSeenTime = now;

    const lm = results.multiHandLandmarks[0];
    const indexTip = lm[8];   // INDEX_FINGER_TIP
    const thumbTip = lm[4];   // THUMB_TIP

    // Mirror horizontally so movement feels natural (like a real mirror/webcam)
    const normX = 1 - indexTip.x;
    const normY = indexTip.y;

    const targetX = normX * window.innerWidth;
    const targetY = normY * window.innerHeight;

    // One-Euro filter: smooths out jitter while staying responsive to fast moves
    smoothX = filterX.filter(targetX, now);
    smoothY = filterY.filter(targetY, now);

    cursorEl.style.transform = `translate(${smoothX - 11}px, ${smoothY - 11}px)`;

    // ---- Scroll detection ----
    if (prevFingerY !== null) {
      const deltaNorm = normY - prevFingerY; // normalized 0-1 movement
      const now = performance.now();
      if (Math.abs(deltaNorm) > CONFIG.scrollThreshold && now - lastScrollTime > CONFIG.scrollCooldownMs) {
        window.scrollBy({ top: deltaNorm > 0 ? CONFIG.scrollAmount : -CONFIG.scrollAmount, behavior: "auto" });
        lastScrollTime = now;
      }
    }
    prevFingerY = normY;

    // ---- Pinch-to-click detection ----
    const dx = indexTip.x - thumbTip.x;
    const dy = indexTip.y - thumbTip.y;
    const pinchDist = Math.sqrt(dx * dx + dy * dy);
    const isPinching = pinchDist < CONFIG.pinchThreshold;
    cursorEl.classList.toggle("hcw-pinching", isPinching);

    if (isPinching) {
      const now = performance.now();
      if (now - lastPinchTime > CONFIG.pinchCooldownMs) {
        lastPinchTime = now;
        clickAtCursor(smoothX, smoothY);
      }
    }
  }

  // ---------- 7. Simulate a real click on whatever is under the cursor ----------
  function clickAtCursor(x, y) {
    cursorEl.style.display = "none"; // don't click on ourselves
    const target = document.elementFromPoint(x, y);
    cursorEl.style.display = "block";
    if (!target) return;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.dispatchEvent(new MouseEvent("click", opts));
  }

  // ---------- Init ----------
  function init() {
    injectStyles();
    buildUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
