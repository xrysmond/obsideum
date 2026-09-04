/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — fx.js
   Visual engine: crystal shader + particle system.

   Ported from fdash-v6.html. Two changes only:
     1. Crystal shard edge color: #00BC73 emerald → #9C3DBB violet
     2. Crystal edge glow: rgba(0,188,115,x) → rgba(156,61,187,x)

   Particles: unchanged. Stay white (rgba(222,228,244,x)).

   Export: window.FX = { init(crystalCanvas), start(), stop() }

   Usage:
     FX.init(document.getElementById('crystal-canvas'));
     FX.start();

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */

window.FX = (function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────
     DEVICE DETECTION
  ───────────────────────────────────────────────────────── */
  var isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  var FRAME_CAP = isMobile ? 33 : 0; // mobile: ~30fps cap

  /* ─────────────────────────────────────────────────────────
     CRYSTAL STATE
  ───────────────────────────────────────────────────────── */
  var crystalCanvas = null;
  var ctx = null;
  var CW = 0, CH = 0;

  // Off-screen canvases for multi-pass glow
  var offCanvas = null, offCtx = null;
  var faceCanvas = null, faceCtx = null;
  var wideCache = null, wideCacheCtx = null;
  var wideFrame = 0;

  // Pre-computed geometry
  var facePaths = null;
  var edges = null;

  // Two orbital lights
  var L1 = { x: 0, y: 0, intensity: 1.00, radius: 0 };
  var L2 = { x: 0, y: 0, intensity: 0.58, radius: 0 };
  var LIGHTS = [L1, L2];

  /* ─────────────────────────────────────────────────────────
     PARTICLE STATE
  ───────────────────────────────────────────────────────── */
  var pCanvas = null, pCtx = null;
  var PW = 0, PH = 0;
  var particles = [];
  var N_UP = 40, N_DOWN = 40;
  var lastPts = 0;

  /* ─────────────────────────────────────────────────────────
     CURSOR STATE (desktop only)
  ───────────────────────────────────────────────────────── */
  var curEl = null;
  var mx = 0, my = 0;
  var curX = 0, curY = 0;
  var prevCurX = -999, prevCurY = -999;

  /* ─────────────────────────────────────────────────────────
     LOOP STATE
  ───────────────────────────────────────────────────────── */
  var rafId = null;
  var running = false;
  var pageHidden = false;
  var lastTs = 0;

  document.addEventListener('visibilitychange', function () {
    pageHidden = document.hidden;
  });

  /* ─────────────────────────────────────────────────────────
     MATH UTILITIES
     Seeded RNG and polygon operations — exact from fdash-v6.html
  ───────────────────────────────────────────────────────── */

  function mkRng(seed) {
    var s = seed;
    return function () {
      s |= 0;
      s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function cross(p1, p2, pt) {
    return (p2.x - p1.x) * (pt.y - p1.y) - (p2.y - p1.y) * (pt.x - p1.x);
  }

  function splitPoly(poly, p1, p2) {
    var A = [], B = [];
    for (var i = 0; i < poly.length; i++) {
      var cur = poly[i], nxt = poly[(i + 1) % poly.length];
      var cc = cross(p1, p2, cur), nc = cross(p1, p2, nxt);
      if (cc >= 0) A.push({ x: cur.x, y: cur.y });
      else         B.push({ x: cur.x, y: cur.y });
      if ((cc > 0 && nc < 0) || (cc < 0 && nc > 0)) {
        var t2 = cc / (cc - nc);
        A.push({ x: cur.x + t2 * (nxt.x - cur.x), y: cur.y + t2 * (nxt.y - cur.y) });
        B.push({ x: cur.x + t2 * (nxt.x - cur.x), y: cur.y + t2 * (nxt.y - cur.y) });
      }
    }
    return [A, B];
  }

  function polyArea(poly) {
    var a = 0;
    for (var i = 0; i < poly.length; i++) {
      var j = (i + 1) % poly.length;
      a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
    }
    return Math.abs(a) * 0.5;
  }

  function centroid(poly) {
    return {
      x: poly.reduce(function (s, v) { return s + v.x; }, 0) / poly.length,
      y: poly.reduce(function (s, v) { return s + v.y; }, 0) / poly.length
    };
  }

  /* ─────────────────────────────────────────────────────────
     SHARD GENERATION
     BSP-style recursive splits — seeded, deterministic
  ───────────────────────────────────────────────────────── */

  function generateShards(W, H) {
    var rng = mkRng(0xC2E9A3F7);
    var polys = [[{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]];

    for (var pass = 0; pass < 15; pass++) {
      // Split the largest polygon each pass
      var maxA = -1, maxIdx = 0;
      for (var i = 0; i < polys.length; i++) {
        var a = polyArea(polys[i]);
        if (a > maxA) { maxA = a; maxIdx = i; }
      }

      var poly = polys[maxIdx];
      var c = centroid(poly);
      var xs = poly.map(function (v) { return v.x; });
      var ys = poly.map(function (v) { return v.y; });
      var angle = rng() * Math.PI;
      var offX  = (rng() - 0.5) * (Math.max.apply(null, xs) - Math.min.apply(null, xs)) * 0.38;
      var offY  = (rng() - 0.5) * (Math.max.apply(null, ys) - Math.min.apply(null, ys)) * 0.38;
      var reach = Math.hypot(W, H) * 2.5;
      var cx2 = c.x + offX, cy2 = c.y + offY;
      var p1 = { x: cx2 - Math.cos(angle) * reach, y: cy2 - Math.sin(angle) * reach };
      var p2 = { x: cx2 + Math.cos(angle) * reach, y: cy2 + Math.sin(angle) * reach };
      var sp = splitPoly(poly, p1, p2);
      if (sp[0].length >= 3 && sp[1].length >= 3) {
        polys.splice(maxIdx, 1, sp[0], sp[1]);
      }
    }
    return polys;
  }

  function extractEdges(polys, W, H) {
    var map = new Map();
    var tol = 3;

    for (var pi = 0; pi < polys.length; pi++) {
      var poly = polys[pi];
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], b = poly[(i + 1) % poly.length];

        // Skip viewport boundary edges — they don't glow
        if ((a.x < tol && b.x < tol) ||
            (a.x > W - tol && b.x > W - tol) ||
            (a.y < tol && b.y < tol) ||
            (a.y > H - tol && b.y > H - tol)) continue;

        var ax = Math.round(a.x * 2) / 2, ay = Math.round(a.y * 2) / 2;
        var bx = Math.round(b.x * 2) / 2, by = Math.round(b.y * 2) / 2;

        // Canonical key — deduplicates shared edges
        var key = (ax < bx || (ax === bx && ay < by))
          ? ax + '|' + ay + '|' + bx + '|' + by
          : bx + '|' + by + '|' + ax + '|' + ay;

        if (!map.has(key)) {
          map.set(key, {
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            mx: (a.x + b.x) * 0.5, my: (a.y + b.y) * 0.5,
            len: Math.hypot(b.x - a.x, b.y - a.y) || 1,
            _I: 0
          });
        }
      }
    }

    return Array.from(map.values()).filter(function (e) { return e.len > 6; });
  }

  /* ─────────────────────────────────────────────────────────
     CRYSTAL BUILD
     Runs once per resize — pre-computes geometry and face cache
  ───────────────────────────────────────────────────────── */

  function buildCrystal(W, H) {
    CW = W; CH = H;

    var shards = generateShards(W, H);
    edges = extractEdges(shards, W, H);

    // Allocate off-screen canvases on first build
    if (!offCanvas)  { offCanvas  = document.createElement('canvas'); offCtx  = offCanvas.getContext('2d');  }
    if (!faceCanvas) { faceCanvas = document.createElement('canvas'); faceCtx = faceCanvas.getContext('2d'); }
    if (!wideCache)  { wideCache  = document.createElement('canvas'); wideCacheCtx = wideCache.getContext('2d'); }

    offCanvas.width  = faceCanvas.width  = wideCache.width  = CW;
    offCanvas.height = faceCanvas.height = wideCache.height = CH;

    // Pre-compute shard face gradients — static light angle (no per-frame cost)
    var ALX = Math.cos(Math.PI * 0.28);
    var ALY = Math.sin(Math.PI * 0.28);

    facePaths = shards.map(function (poly) {
      if (poly.length < 3) return null;
      var c = centroid(poly);
      var xs   = poly.map(function (v) { return v.x; });
      var ys   = poly.map(function (v) { return v.y; });
      var span = Math.max(
        Math.max.apply(null, xs) - Math.min.apply(null, xs),
        Math.max.apply(null, ys) - Math.min.apply(null, ys)
      ) * 0.55;

      var toX = c.x - CW * 0.5, toY = c.y - CH * 0.5;
      var dist = Math.sqrt(toX * toX + toY * toY) || 1;
      var facing = Math.max(0, (toX / dist) * ALX + (toY / dist) * ALY) * 0.68 + 0.14;
      var bright = Math.round(10 + facing * 22);

      // Gradient created from main ctx — coordinates are in logical pixels
      var grad = ctx.createLinearGradient(
        c.x + ALX * span, c.y + ALY * span,
        c.x - ALX * span, c.y - ALY * span
      );
      grad.addColorStop(0, 'rgb(' + bright + ',' + bright + ',' + (bright + 2) + ')');
      grad.addColorStop(1, '#070709');

      return { verts: poly, grad: grad };
    }).filter(Boolean);

    // Bake face cache — static for life of this build
    faceCtx.clearRect(0, 0, CW, CH);
    for (var i = 0; i < facePaths.length; i++) {
      var f = facePaths[i];
      faceCtx.beginPath();
      faceCtx.moveTo(f.verts[0].x, f.verts[0].y);
      for (var v = 1; v < f.verts.length; v++) faceCtx.lineTo(f.verts[v].x, f.verts[v].y);
      faceCtx.closePath();
      faceCtx.fillStyle = f.grad;
      faceCtx.fill();
    }
  }

  /* ─────────────────────────────────────────────────────────
     CRYSTAL LIGHTS
     Two orbital light sources on Lissajous-ish paths
  ───────────────────────────────────────────────────────── */

  function updateLights(t) {
    var D  = Math.min(CW, CH);
    var a1 = t * 0.0000552, a2 = t * 0.0000769 + 2.14;

    L1.x      = CW * 0.5 + Math.cos(a1) * CW * 0.28 + Math.cos(a1 * 1.68) * CW * 0.07;
    L1.y      = CH * 0.5 + Math.sin(a1) * CH * 0.22 + Math.sin(a1 * 1.38) * CH * 0.06;
    L1.radius = D * 0.52;

    L2.x      = CW * 0.5 + Math.cos(a2) * CW * 0.20 + Math.cos(a2 * 2.25) * CW * 0.05;
    L2.y      = CH * 0.5 + Math.sin(a2) * CH * 0.16 + Math.sin(a2 * 1.91) * CH * 0.04;
    L2.radius = D * 0.36;
  }

  /* ─────────────────────────────────────────────────────────
     CRYSTAL RENDER
     Three glow passes + sharp edges each frame.
     VIOLET: rgb(156,61,187) — was rgb(0,188,115) emerald in source
  ───────────────────────────────────────────────────────── */

  function renderCrystal(t) {
    if (!faceCanvas || !edges || !offCanvas) return;

    // Draw pre-baked face cache
    ctx.drawImage(faceCanvas, 0, 0);

    updateLights(t);
    var breathe = 0.72 + 0.28 * Math.sin(t * 0.00076);

    // ── Compute edge intensities ──────────────────────────
    for (var ei = 0; ei < edges.length; ei++) {
      var e = edges[ei], I = 0;
      for (var li = 0; li < LIGHTS.length; li++) {
        var L = LIGHTS[li];
        var dx = e.mx - L.x, dy = e.my - L.y;
        var prox = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / L.radius);
        I += prox * prox * L.intensity;
      }
      e._I = Math.min(1, I * breathe);
    }

    // ── Pass 1: wide glow — every other frame (expensive blur) ──
    wideFrame++;
    if (wideFrame % 2 === 0) {
      offCtx.clearRect(0, 0, CW, CH);
      offCtx.lineCap = 'round';
      offCtx.lineJoin = 'round';

      for (var ei2 = 0; ei2 < edges.length; ei2++) {
        var e2 = edges[ei2], I2 = e2._I;
        if (I2 < 0.04) continue;
        offCtx.globalAlpha = I2 * I2 * 0.92;
        offCtx.strokeStyle = 'rgb(156,61,187)'; // VIOLET ← was rgb(0,188,115)
        offCtx.lineWidth   = 2 + I2 * 7;
        offCtx.beginPath();
        offCtx.moveTo(e2.x1, e2.y1);
        offCtx.lineTo(e2.x2, e2.y2);
        offCtx.stroke();
      }
      offCtx.globalAlpha = 1;

      // Blur into wide cache
      wideCacheCtx.clearRect(0, 0, CW, CH);
      wideCacheCtx.filter = 'blur(38px)';
      wideCacheCtx.drawImage(offCanvas, 0, 0);
      wideCacheCtx.filter = 'none';
    }

    // Composite wide glow
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(wideCache, 0, 0);
    ctx.restore();

    // ── Pass 2: medium glow (7px blur) ───────────────────
    offCtx.clearRect(0, 0, CW, CH);
    for (var ei3 = 0; ei3 < edges.length; ei3++) {
      var e3 = edges[ei3], I3 = e3._I;
      if (I3 < 0.04) continue;
      offCtx.globalAlpha = I3 * 0.88;
      offCtx.strokeStyle = 'rgb(156,61,187)'; // VIOLET
      offCtx.lineWidth   = 1;
      offCtx.beginPath();
      offCtx.moveTo(e3.x1, e3.y1);
      offCtx.lineTo(e3.x2, e3.y2);
      offCtx.stroke();
    }
    offCtx.globalAlpha = 1;

    ctx.save();
    ctx.filter = 'blur(7px)';
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(offCanvas, 0, 0);
    ctx.filter = 'none';
    ctx.restore();

    // ── Pass 3: sharp edges ───────────────────────────────
    ctx.globalAlpha = 1;
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    for (var ei4 = 0; ei4 < edges.length; ei4++) {
      var e4 = edges[ei4], I4 = e4._I;
      if (I4 < 0.04) continue;
      ctx.strokeStyle = 'rgba(156,61,187,' + Math.min(0.95, I4 * 1.1) + ')'; // VIOLET
      ctx.lineWidth   = Math.max(0.8, 0.5 + I4 * 0.9);
      ctx.beginPath();
      ctx.moveTo(e4.x1, e4.y1);
      ctx.lineTo(e4.x2, e4.y2);
      ctx.stroke();
    }
  }

  /* ─────────────────────────────────────────────────────────
     PARTICLE SYSTEM
     Unchanged from fdash-v6.html. Particles stay white.
     rgba(222,228,244,x) — platinum white matching --br
  ───────────────────────────────────────────────────────── */

  function mkParticle(dir) {
    // dir:  1 = rises from bottom, -1 = falls from top
    var speed = 0.12 + Math.random() * 0.28;
    return {
      x:       Math.random() * PW,
      y:       dir === 1 ? PH + Math.random() * PH : -(Math.random() * PH),
      vy:      dir === 1 ? -speed : speed,
      vx:      (Math.random() - 0.5) * 0.08,
      r:       0.8 + Math.random() * 1.4,
      alpha:   0.04 + Math.random() * 0.18,
      life:    0,
      maxLife: 260 + Math.random() * 280,
      dir:     dir
    };
  }

  function initParticles() {
    particles = [];
    // Rising particles — start below viewport, drift in naturally
    for (var i = 0; i < N_UP; i++) {
      particles.push(mkParticle(1));
    }
    // Falling particles — start above viewport, drift in naturally
    for (var j = 0; j < N_DOWN; j++) {
      particles.push(mkParticle(-1));
    }
  }

  function renderParticles(ts) {
    if (!pCtx) return;

    // Mobile: cap particle updates to ~30fps
    if (isMobile && ts - lastPts < 33) return;
    lastPts = ts;

    pCtx.clearRect(0, 0, PW, PH);

    for (var i = 0; i < particles.length; i++) {
      var p  = particles[i];
      p.x   += p.vx;
      p.y   += p.vy;
      p.life++;

      var fi = Math.min(1, p.life / 40);
      var fo = Math.min(1, (p.maxLife - p.life) / 40);
      var a  = p.alpha * fi * fo;

      // Core particle — platinum white
      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      pCtx.fillStyle = 'rgba(222,228,244,' + a + ')';
      pCtx.fill();

      // Soft glow halo — desktop only (below perceptible threshold on mobile)
      if (!isMobile) {
        pCtx.beginPath();
        pCtx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
        pCtx.fillStyle = 'rgba(0,188,115,' + (a * 0.06) + ')'; // unchanged
        pCtx.fill();
      }

      var dead = p.life >= p.maxLife
               || (p.dir ===  1 && p.y < -20)
               || (p.dir === -1 && p.y > PH + 20);
      if (dead) particles[i] = mkParticle(p.dir);
    }
  }

  /* ─────────────────────────────────────────────────────────
     CURSOR
     Smooth magnetic follow with hover state — desktop only.
     Event delegation handles dynamic content.
  ───────────────────────────────────────────────────────── */

  function initCursor() {
    if (isMobile) return;

    curEl = document.getElementById('cur');
    if (!curEl) return;

    mx = window.innerWidth  / 2;
    my = window.innerHeight / 2;
    curX = mx; curY = my;

    document.addEventListener('mousemove', function (e) {
      mx = e.clientX;
      my = e.clientY;
    }, { passive: true });

    // Delegation — works for all current and future interactive elements
    document.addEventListener('mouseover', function (e) {
      if (!curEl) return;
      var interactive = !!e.target.closest(
        'button, [role="button"], a, input, select, textarea, ' +
        'label, .token-row, .nav-item, .seg-btn, .toggle, .tab-btn'
      );
      var disabled = !!e.target.closest('[disabled], [aria-disabled="true"]');
      curEl.classList.toggle('hl', interactive && !disabled);
    });
  }

  function updateCursor() {
    if (!curEl || isMobile) return;

    // Lag: cursor trails mouse with 16% catch-up per frame
    curX += (mx - curX) * 0.16;
    curY += (my - curY) * 0.16;

    // Only write style when position actually changed (avoids forced reflows)
    if (Math.abs(curX - prevCurX) > 0.3 || Math.abs(curY - prevCurY) > 0.3) {
      curEl.style.left = curX + 'px';
      curEl.style.top  = curY + 'px';
      prevCurX = curX;
      prevCurY = curY;
    }
  }

  /* ─────────────────────────────────────────────────────────
     RESIZE
  ───────────────────────────────────────────────────────── */

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: eye can't resolve 2× vs 3×
    var W   = window.innerWidth;
    var H   = window.innerHeight;

    // Crystal canvas — DPR-scaled, logical px transform
    if (crystalCanvas) {
      crystalCanvas.width  = Math.round(W * dpr);
      crystalCanvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Particle canvas — no DPR scaling needed (sub-pixel particles invisible)
    if (pCanvas) {
      PW = pCanvas.width  = W;
      PH = pCanvas.height = H;
    }

    buildCrystal(W, H);

    if (pCtx) initParticles();
  }

  /* ─────────────────────────────────────────────────────────
     ANIMATION LOOP
  ───────────────────────────────────────────────────────── */

  function loop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);

    if (pageHidden) return;
    if (FRAME_CAP && ts - lastTs < FRAME_CAP) return;
    lastTs = ts;

    // Clear and render crystal
    if (ctx) {
      ctx.clearRect(0, 0, CW, CH);
      renderCrystal(ts);
    }

    // Particles on their own canvas
    renderParticles(ts);

    // Cursor follow
    updateCursor();
  }

  /* ─────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────── */

  /**
   * init(canvas)
   * Accepts the crystal canvas element.
   * Finds #particle-canvas automatically.
   * Sets up cursor, resize handler, and builds initial geometry.
   */
  function init(canvas) {
    crystalCanvas = canvas;
    ctx = crystalCanvas.getContext('2d');

    // Particle canvas — auto-discovered
    pCanvas = document.getElementById('particle-canvas');
    if (pCanvas) pCtx = pCanvas.getContext('2d');

    initCursor();

    var _resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(resize, 200); // BSP rebuild runs once, after drag stops
    }, { passive: true });
    resize(); // initial — immediate
  }

  /**
   * start()
   * Begins the animation loop. Safe to call multiple times.
   */
  function start() {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(loop);
  }

  /**
   * stop()
   * Cancels the animation loop. Preserves canvas state.
   */
  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  return { init: init, start: start, stop: stop };

})();
