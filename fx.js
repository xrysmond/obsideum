/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — fx.js  ·  WebGL engine
   ─────────────────────────────────────────────────────────────────
   Full rewrite of the 2D-canvas crystal shader in WebGL 1.0.

   Architecture
   ────────────
   BSP shard geometry is identical to the original (same seed, same
   15-pass split). What changes is how it is rendered:

   Face layer  — triangle-fanned shard polygons with per-vertex
                 ambient gradient, baked once per resize into a
                 W×H texture (fbFace). Static after build.

   Glow layer  — edge quads drawn each frame to a half-resolution
                 FBO (GW×GH ≈ W/2 × H/2), then ping-ponged through
                 a separable Gaussian in GLSL.
                   • Wide pass  (σ≈4, stride 4) — cached every 2 frames
                   • Medium pass (σ≈2, stride 1) — every frame desktop,
                     skipped on mobile

   Sharp layer — SDF capsule quads drawn at full physical resolution
                 (CW×CH) directly into the default framebuffer.

   Glow colour — platinum white #DEE4F4, replacing violet #9C3DBB.
   Particles   — unchanged 2D canvas system on #particle-canvas.
   Cursor      — unchanged DOM system.

   Performance vs 2D canvas
   ─────────────────────────
   • CSS filter:blur() replaced by two 7-9 tap GPU Gaussians
   • Glow FBOs run at W/2×H/2 → ¼ the pixel cost of original
   • Face geometry baked to texture once — zero per-frame cost
   • Dynamic data = one Float32Array upload per frame per VBO
   • No per-frame path-building, ctx state switches, or 2D blits
   • Wide glow cached every 2 frames (matches original throttling)
   • Page-hidden, mobile 30fps cap, visibility change — all retained

   Export: window.FX = { init(crystalCanvas), start(), stop() }
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */

window.FX = (function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     DEVICE
  ───────────────────────────────────────────────────────────── */
  var isMobile  = window.matchMedia('(hover:none) and (pointer:coarse)').matches;
  var FRAME_CAP = isMobile ? 33 : 0;   // mobile: ~30 fps cap

  /* ─────────────────────────────────────────────────────────────
     GL STATE
  ───────────────────────────────────────────────────────────── */
  var _canvas = null;
  var gl      = null;

  /* W, H  — logical CSS pixels (vertex coordinate space)
     CW,CH — physical canvas pixels (main framebuffer)
     GW,GH — glow FBO pixels (≈ W/2, H/2)               */
  var W = 0, H = 0, CW = 0, CH = 0, GW = 0, GH = 0;

  /* ─────────────────────────────────────────────────────────────
     SHADER PROGRAMS
  ───────────────────────────────────────────────────────── ─── */
  var progFace     = null;  // shard face geometry  → fbFace
  var progGlow     = null;  // edge flat quads       → fbGlowIn
  var progSharp    = null;  // SDF capsule edges     → screen
  var progBlurWide = null;  // 9-tap Gaussian stride 4
  var progBlurMed  = null;  // 7-tap Gaussian stride 1
  var progBlit     = null;  // fullscreen texture quad

  /* ─────────────────────────────────────────────────────────────
     FRAMEBUFFERS — each { fb, tex, w, h }
  ───────────────────────────────────────────────────────────── */
  var fbFace   = null;   // static shard faces  (W × H)
  var fbGlowIn = null;   // glow edge raster    (GW × GH)
  var fbPing   = null;   // blur intermediate   (GW × GH)
  var fbWide   = null;   // cached wide glow    (GW × GH)
  var fbMed    = null;   // medium glow         (GW × GH)

  /* ─────────────────────────────────────────────────────────────
     GPU BUFFERS
  ───────────────────────────────────────────────────────────── */
  var bufFace  = null;   // face VBO     — STATIC_DRAW
  var bufGlow  = null;   // glow VBO     — DYNAMIC_DRAW
  var bufSharp = null;   // sharp VBO    — DYNAMIC_DRAW
  var bufQuad  = null;   // fullscreen quad — STATIC_DRAW

  /* Vertex layouts (floats per vertex):
       Face  [x, y, r, g, b]                      → 5
       Glow  [x, y, intensity]                    → 3
       Sharp [x, y, lu, lv, hlen, hw, intensity]  → 7  */
  var FACE_F  = 5;
  var GLOW_F  = 3;
  var SHARP_F = 7;

  var faceVerts  = 0;   // total face vertex count
  var NEDGES     = 0;   // edge count (6 verts per edge in dynamic VBOs)

  /* CPU-side typed arrays rebuilt each frame */
  var glowData  = null;
  var sharpData = null;

  /* ─────────────────────────────────────────────────────────────
     EDGE STATE
  ───────────────────────────────────────────────────────────── */
  var edges = [];

  /* ─────────────────────────────────────────────────────────────
     LIGHTS — two orbital sources (identical to original)
  ───────────────────────────────────────────────────────────── */
  var L1 = { x: 0, y: 0, I: 1.00, r: 0 };
  var L2 = { x: 0, y: 0, I: 0.58, r: 0 };

  /* ─────────────────────────────────────────────────────────────
     PARTICLES — unchanged 2D canvas system
  ───────────────────────────────────────────────────────────── */
  var pCanvas = null, pCtx = null;
  var PW = 0, PH = 0;
  var particles = [];
  var lastPts   = 0;
  var N_UP = 40, N_DOWN = 40;

  /* ─────────────────────────────────────────────────────────────
     CURSOR — unchanged DOM system
  ───────────────────────────────────────────────────────────── */
  var curEl = null;
  var mx = 0, my = 0;
  var curX = 0, curY = 0;
  var prevCurX = -999, prevCurY = -999;

  /* ─────────────────────────────────────────────────────────────
     LOOP STATE
  ───────────────────────────────────────────────────────────── */
  var rafId      = null;
  var running    = false;
  var pageHidden = false;
  var lastTs     = 0;
  var wideFrame  = 0;

  document.addEventListener('visibilitychange', function () {
    pageHidden = document.hidden;
  });


  /* ═══════════════════════════════════════════════════════════
     MATH  ·  Seeded RNG + BSP — byte-for-byte identical to
     the original so the shard layout is exactly the same.
  ═══════════════════════════════════════════════════════════ */

  function mkRng(seed) {
    var s = seed;
    return function () {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function cross(p1, p2, pt) {
    return (p2.x-p1.x)*(pt.y-p1.y) - (p2.y-p1.y)*(pt.x-p1.x);
  }

  function splitPoly(poly, p1, p2) {
    var A = [], B = [];
    for (var i = 0; i < poly.length; i++) {
      var cur = poly[i], nxt = poly[(i+1) % poly.length];
      var cc = cross(p1,p2,cur), nc = cross(p1,p2,nxt);
      if (cc >= 0) A.push({x:cur.x, y:cur.y}); else B.push({x:cur.x, y:cur.y});
      if ((cc>0&&nc<0)||(cc<0&&nc>0)) {
        var t = cc/(cc-nc);
        var ix = cur.x + t*(nxt.x-cur.x), iy = cur.y + t*(nxt.y-cur.y);
        A.push({x:ix, y:iy}); B.push({x:ix, y:iy});
      }
    }
    return [A, B];
  }

  function polyArea(poly) {
    var a = 0;
    for (var i = 0; i < poly.length; i++) {
      var j = (i+1) % poly.length;
      a += poly[i].x*poly[j].y - poly[j].x*poly[i].y;
    }
    return Math.abs(a) * 0.5;
  }

  function centroid(poly) {
    return {
      x: poly.reduce(function(s,v){return s+v.x;},0) / poly.length,
      y: poly.reduce(function(s,v){return s+v.y;},0) / poly.length
    };
  }

  function generateShards(pw, ph) {
    var rng = mkRng(0xC2E9A3F7);
    var polys = [[{x:0,y:0},{x:pw,y:0},{x:pw,y:ph},{x:0,y:ph}]];

    for (var pass = 0; pass < 15; pass++) {
      var maxA = -1, maxIdx = 0;
      for (var i = 0; i < polys.length; i++) {
        var a = polyArea(polys[i]);
        if (a > maxA) { maxA = a; maxIdx = i; }
      }
      var poly = polys[maxIdx];
      var c    = centroid(poly);
      var xs   = poly.map(function(v){return v.x;});
      var ys   = poly.map(function(v){return v.y;});
      var angle = rng() * Math.PI;
      var offX  = (rng()-0.5)*(Math.max.apply(null,xs)-Math.min.apply(null,xs))*0.38;
      var offY  = (rng()-0.5)*(Math.max.apply(null,ys)-Math.min.apply(null,ys))*0.38;
      var reach = Math.hypot(pw, ph) * 2.5;
      var cx2 = c.x+offX, cy2 = c.y+offY;
      var p1 = {x:cx2-Math.cos(angle)*reach, y:cy2-Math.sin(angle)*reach};
      var p2 = {x:cx2+Math.cos(angle)*reach, y:cy2+Math.sin(angle)*reach};
      var sp = splitPoly(poly, p1, p2);
      if (sp[0].length >= 3 && sp[1].length >= 3)
        polys.splice(maxIdx, 1, sp[0], sp[1]);
    }
    return polys;
  }

  function extractEdges(polys, pw, ph) {
    var map = new Map();
    var tol = 3;
    for (var pi = 0; pi < polys.length; pi++) {
      var poly = polys[pi];
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], b = poly[(i+1) % poly.length];
        if ((a.x<tol&&b.x<tol)||(a.x>pw-tol&&b.x>pw-tol)||
            (a.y<tol&&b.y<tol)||(a.y>ph-tol&&b.y>ph-tol)) continue;
        var ax = Math.round(a.x*2)/2, ay = Math.round(a.y*2)/2;
        var bx = Math.round(b.x*2)/2, by = Math.round(b.y*2)/2;
        var key = (ax<bx||(ax===bx&&ay<by))
          ? ax+'|'+ay+'|'+bx+'|'+by
          : bx+'|'+by+'|'+ax+'|'+ay;
        if (!map.has(key)) map.set(key, {
          x1:a.x, y1:a.y, x2:b.x, y2:b.y,
          mx:(a.x+b.x)*0.5, my:(a.y+b.y)*0.5,
          len:Math.hypot(b.x-a.x,b.y-a.y)||1, _I:0
        });
      }
    }
    return Array.from(map.values()).filter(function(e){return e.len>6;});
  }


  /* ═══════════════════════════════════════════════════════════
     GLSL SOURCES
  ═══════════════════════════════════════════════════════════ */

  /* ── Shared fullscreen-quad vertex shader (blur + blit) ── */
  var VS_QUAD = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main(){',
    '  v_uv = (a_pos + 1.0) * 0.5;',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* ── Shard face shaders ─────────────────────────────────── */
  var VS_FACE = [
    'attribute vec2 a_pos;',
    'attribute vec3 a_col;',
    'uniform vec2  u_res;',
    'varying vec3  v_col;',
    'void main(){',
    '  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '  v_col = a_col;',
    '}'
  ].join('\n');

  var FS_FACE = [
    'precision mediump float;',
    'varying vec3 v_col;',
    'void main(){ gl_FragColor = vec4(v_col, 1.0); }'
  ].join('\n');

  /* ── Glow edge shaders (flat quads → blur input) ─────── */
  var VS_GLOW = [
    'attribute vec2  a_pos;',
    'attribute float a_int;',
    'uniform vec2    u_res;',
    'varying float   v_int;',
    'void main(){',
    '  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '  v_int = a_int;',
    '}'
  ].join('\n');

  /* Platinum white: #DEE4F4 = rgb(222,228,244)/255 */
  var FS_GLOW = [
    'precision mediump float;',
    'varying float v_int;',
    'void main(){',
    '  float a = v_int * v_int * 0.92;',
    '  gl_FragColor = vec4(0.871, 0.894, 0.957, a);',
    '}'
  ].join('\n');

  /* ── Sharp SDF-capsule edge shaders ─────────────────────── */
  var VS_SHARP = [
    'attribute vec2  a_pos;',   // world position (expanded)
    'attribute vec2  a_uv;',    // local: (u along edge, v perp), in logical px
    'attribute float a_hlen;',  // half-length of edge, logical px
    'attribute float a_hw;',    // visual half-width, logical px
    'attribute float a_int;',   // edge intensity 0-1
    'uniform vec2    u_res;',
    'varying vec2    v_uv;',
    'varying float   v_hlen;',
    'varying float   v_hw;',
    'varying float   v_int;',
    'void main(){',
    '  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '  v_uv = a_uv; v_hlen = a_hlen; v_hw = a_hw; v_int = a_int;',
    '}'
  ].join('\n');

  /* SDF capsule: project onto centerline segment, compute distance.
     smoothstep gives 1 logical-pixel anti-aliased edge at any DPR. */
  var FS_SHARP = [
    'precision mediump float;',
    'varying vec2  v_uv;',
    'varying float v_hlen;',
    'varying float v_hw;',
    'varying float v_int;',
    'void main(){',
    '  float cx = clamp(v_uv.x, -v_hlen, v_hlen);',
    '  float d  = length(vec2(v_uv.x - cx, v_uv.y));',
    '  float a  = smoothstep(v_hw + 0.5, v_hw - 0.5, d);',
    '  a *= min(0.95, v_int * 1.1);',
    '  gl_FragColor = vec4(0.871, 0.894, 0.957, a);',
    '}'
  ].join('\n');

  /* ── Wide blur — 9-tap Gaussian, stride 4 ───────────────
     Kernel: σ=4 in stride units.  Weights pre-normalised.
     Effective spread at GW=W/2: ±16 logical px per axis.
     When blitted 2× to screen: ±32 logical px ≈ original 38 px blur. */
  var FS_BLUR_WIDE = [
    'precision mediump float;',
    'uniform sampler2D u_tex;',
    'uniform vec2      u_texel;',
    'uniform vec2      u_dir;',
    'varying vec2      v_uv;',
    'const float W0 = 0.13466;',
    'const float W1 = 0.13052;',
    'const float W2 = 0.11884;',
    'const float W3 = 0.10165;',
    'const float W4 = 0.08167;',
    'void main(){',
    '  vec2 t = u_dir * u_texel * 4.0;',   // stride = 4 texels
    '  gl_FragColor =',
    '    texture2D(u_tex, v_uv - 4.0*t)*W4 +',
    '    texture2D(u_tex, v_uv - 3.0*t)*W3 +',
    '    texture2D(u_tex, v_uv - 2.0*t)*W2 +',
    '    texture2D(u_tex, v_uv - 1.0*t)*W1 +',
    '    texture2D(u_tex, v_uv        )*W0 +',
    '    texture2D(u_tex, v_uv + 1.0*t)*W1 +',
    '    texture2D(u_tex, v_uv + 2.0*t)*W2 +',
    '    texture2D(u_tex, v_uv + 3.0*t)*W3 +',
    '    texture2D(u_tex, v_uv + 4.0*t)*W4;',
    '}'
  ].join('\n');

  /* ── Medium blur — 7-tap Gaussian, stride 1 ─────────────
     σ=2 in texel units.
     Effective spread at GW=W/2: ±6 logical px ≈ original 7 px blur. */
  var FS_BLUR_MED = [
    'precision mediump float;',
    'uniform sampler2D u_tex;',
    'uniform vec2      u_texel;',
    'uniform vec2      u_dir;',
    'varying vec2      v_uv;',
    'const float M0 = 0.27067;',
    'const float M1 = 0.21675;',
    'const float M2 = 0.11128;',
    'const float M3 = 0.03664;',
    'void main(){',
    '  vec2 t = u_dir * u_texel;',
    '  gl_FragColor =',
    '    texture2D(u_tex, v_uv - 3.0*t)*M3 +',
    '    texture2D(u_tex, v_uv - 2.0*t)*M2 +',
    '    texture2D(u_tex, v_uv - 1.0*t)*M1 +',
    '    texture2D(u_tex, v_uv        )*M0 +',
    '    texture2D(u_tex, v_uv + 1.0*t)*M1 +',
    '    texture2D(u_tex, v_uv + 2.0*t)*M2 +',
    '    texture2D(u_tex, v_uv + 3.0*t)*M3;',
    '}'
  ].join('\n');

  /* ── Blit — fullscreen texture copy ──────────────────────
     Used opaque (face), additive (glow), alpha (unused but kept). */
  var FS_BLIT = [
    'precision mediump float;',
    'uniform sampler2D u_tex;',
    'varying vec2 v_uv;',
    'void main(){ gl_FragColor = texture2D(u_tex, v_uv); }'
  ].join('\n');


  /* ═══════════════════════════════════════════════════════════
     GL UTILITIES
  ═══════════════════════════════════════════════════════════ */

  function compileShader(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('[FX] shader compile: ' + gl.getShaderInfoLog(sh));
    return sh;
  }

  /* Link a program, then cache uniform and attribute locations
     on prog._u / prog._a so callers never call getUniformLocation
     inside the render loop. */
  function makeProgram(vsSrc, fsSrc) {
    var prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER,   vsSrc));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('[FX] program link: ' + gl.getProgramInfoLog(prog));

    prog._u = {};
    prog._a = {};
    var nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < nu; i++) {
      var u = gl.getActiveUniform(prog, i);
      prog._u[u.name] = gl.getUniformLocation(prog, u.name);
    }
    var na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
    for (var j = 0; j < na; j++) {
      var a = gl.getActiveAttrib(prog, j);
      prog._a[a.name] = gl.getAttribLocation(prog, a.name);
    }
    return prog;
  }

  /* Create an RGBA FBO + texture.  CLAMP_TO_EDGE is mandatory
     for the blur kernel — wrapping produces bright border flares. */
  function makeFBO(w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fb:fb, tex:tex, w:w, h:h };
  }

  /* Release and recreate an FBO at a new size.
     Called every resize — old GPU objects are deleted immediately. */
  function resizeFBO(old, w, h) {
    if (old) { gl.deleteFramebuffer(old.fb); gl.deleteTexture(old.tex); }
    return makeFBO(w, h);
  }

  /* Blit srcTex onto the currently-bound framebuffer.
     blendMode: 'none' = opaque overwrite  |  'add' = additive */
  function blit(srcTex, blendMode) {
    gl.useProgram(progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(progBlit._u['u_tex'], 0);

    if (blendMode === 'add') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    var aPos = progBlit._a['a_pos'];
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(aPos);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /* Two-pass separable Gaussian: srcTex → fbPing → dst.
     fbPing is shared scratch; never call this re-entrantly. */
  function blurPass(prog, srcTex, dst) {
    var tw = 1.0/GW, th = 1.0/GH;
    gl.disable(gl.BLEND);

    /* Horizontal */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbPing.fb);
    gl.viewport(0, 0, GW, GH);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(prog._u['u_tex'], 0);
    gl.uniform2f(prog._u['u_texel'], tw, th);
    gl.uniform2f(prog._u['u_dir'], 1.0, 0.0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    var aPos = prog._a['a_pos'];
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* Vertical */
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, GW, GH);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, fbPing.tex);
    gl.uniform2f(prog._u['u_dir'], 0.0, 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(aPos);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }


  /* ═══════════════════════════════════════════════════════════
     GEOMETRY BUILD
  ═══════════════════════════════════════════════════════════ */

  /* Build face VBO from shard polygons.
     Each polygon is fan-triangulated from vertex 0.

     The ambient gradient replicates the original ctx.createLinearGradient:
       bright end  → rgb(b, b, b+2)
       dark  end   → #070709  = rgb(7, 7, 9)
     Computed per vertex by projecting onto the light direction (ALX,ALY)
     and interpolating. Uploaded once, baked to fbFace. */
  function buildFaceVBO(shards) {
    var ALX = Math.cos(Math.PI * 0.28);  // ≈ 0.7431
    var ALY = Math.sin(Math.PI * 0.28);  // ≈ 0.6691
    var midX = W * 0.5, midY = H * 0.5;

    var data = [];

    function lerpF(a, b, t) { return a + t*(b-a); }

    function vertRGB(poly, cx, cy, span, bright, vx, vy) {
      var proj = (vx-cx)*ALX + (vy-cy)*ALY;
      var t    = Math.max(0, Math.min(1, 0.5 + proj/(2*span)));
      return [
        lerpF(7/255, bright,       t),  // R
        lerpF(7/255, bright,       t),  // G
        lerpF(9/255, bright+2/255, t)   // B — matches original rgb(b,b,b+2)/#070709
      ];
    }

    for (var si = 0; si < shards.length; si++) {
      var poly = shards[si];
      if (poly.length < 3) continue;

      var c    = centroid(poly);
      var xs   = poly.map(function(v){return v.x;});
      var ys   = poly.map(function(v){return v.y;});
      var span = Math.max(
        Math.max.apply(null,xs)-Math.min.apply(null,xs),
        Math.max.apply(null,ys)-Math.min.apply(null,ys)
      ) * 0.55;

      var toX   = c.x-midX, toY = c.y-midY;
      var dist  = Math.sqrt(toX*toX+toY*toY) || 1;
      var facing = Math.max(0,(toX/dist)*ALX+(toY/dist)*ALY)*0.68+0.14;
      var bright = (10 + facing*22) / 255;

      /* Fan triangulation from vertex 0 */
      for (var i = 1; i < poly.length-1; i++) {
        var v0=poly[0], v1=poly[i], v2=poly[i+1];
        var c0=vertRGB(poly,c.x,c.y,span,bright,v0.x,v0.y);
        var c1=vertRGB(poly,c.x,c.y,span,bright,v1.x,v1.y);
        var c2=vertRGB(poly,c.x,c.y,span,bright,v2.x,v2.y);
        data.push(v0.x,v0.y,c0[0],c0[1],c0[2]);
        data.push(v1.x,v1.y,c1[0],c1[1],c1[2]);
        data.push(v2.x,v2.y,c2[0],c2[1],c2[2]);
      }
    }

    faceVerts = data.length / FACE_F;
    if (!bufFace) bufFace = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufFace);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  }

  /* Bake face VBO into fbFace.  Called once per resize.
     Sets up its own attribute pointers. */
  function bakeFaces() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbFace.fb);
    gl.viewport(0, 0, fbFace.w, fbFace.h);
    gl.clearColor(0.027, 0.027, 0.035, 1.0);  // #070709 void
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    gl.useProgram(progFace);
    gl.uniform2f(progFace._u['u_res'], W, H);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufFace);
    var stride = FACE_F * 4;
    var aPos = progFace._a['a_pos'], aCol = progFace._a['a_col'];
    gl.enableVertexAttribArray(aPos); gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, stride, 2*4);
    gl.drawArrays(gl.TRIANGLES, 0, faceVerts);
    gl.disableVertexAttribArray(aPos); gl.disableVertexAttribArray(aCol);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* Rebuild glow VBO each frame.
     Each edge → 6 vertices [x, y, intensity] in logical coordinates.
     Quad half-width scales with intensity to match original lineWidth. */
  function rebuildGlowVBO() {
    var d = glowData, i = 0;

    for (var ei = 0; ei < NEDGES; ei++) {
      var e  = edges[ei];
      var I  = e._I;

      if (I < 0.04) {
        /* Zero out 6 vertices — GPU draws nothing at origin degenerate quad */
        for (var z = 0; z < 6*GLOW_F; z++) d[i++] = 0;
        continue;
      }

      var hw = 1.0 + I * 4.5;   // logical px half-width (matches original 2+I*7 at half-res)
      var dx = e.x2-e.x1, dy = e.y2-e.y1;
      var len = Math.sqrt(dx*dx+dy*dy);
      var nx = dx/len, ny = dy/len;
      var px = -ny*hw, py = nx*hw;
      var ex = nx*hw,  ey = ny*hw;

      var ax=e.x1-ex-px, ay=e.y1-ey-py;
      var bx=e.x1-ex+px, by=e.y1-ey+py;
      var cx=e.x2+ex-px, cy=e.y2+ey-py;
      var dx2=e.x2+ex+px, dy2=e.y2+ey+py;

      d[i++]=ax; d[i++]=ay; d[i++]=I;
      d[i++]=bx; d[i++]=by; d[i++]=I;
      d[i++]=cx; d[i++]=cy; d[i++]=I;
      d[i++]=bx; d[i++]=by; d[i++]=I;
      d[i++]=dx2;d[i++]=dy2;d[i++]=I;
      d[i++]=cx; d[i++]=cy; d[i++]=I;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowData);
  }

  /* Rebuild sharp VBO each frame.
     Each edge → 6 vertices [x, y, lu, lv, hlen, hw, intensity].
     Geometric half-width = visual hw + 0.5 AA buffer;
     SDF uses the visual hw via v_hw in the fragment shader. */
  function rebuildSharpVBO() {
    var d = sharpData, i = 0;

    for (var ei = 0; ei < NEDGES; ei++) {
      var e  = edges[ei];
      var I  = e._I;

      if (I < 0.04) {
        for (var z = 0; z < 6*SHARP_F; z++) d[i++] = 0;
        continue;
      }

      var hw  = Math.max(0.40, 0.25 + I*0.45);   // visual half-width, logical px
      var hwG = hw + 0.5;                          // geometric + AA margin

      var dx = e.x2-e.x1, dy = e.y2-e.y1;
      var len = Math.sqrt(dx*dx+dy*dy);
      var nx = dx/len, ny = dy/len;
      var px = -ny*hwG, py = nx*hwG;
      var ex = nx*hwG,  ey = ny*hwG;
      var hl = len * 0.5;   // half-length of edge

      var ax=e.x1-ex-px, ay=e.y1-ey-py;
      var bx=e.x1-ex+px, by=e.y1-ey+py;
      var cx=e.x2+ex-px, cy=e.y2+ey-py;
      var dx2=e.x2+ex+px,dy2=e.y2+ey+py;

      /* Local UV: u ∈ [-(hl+hwG), +(hl+hwG)],  v ∈ [-hwG, +hwG] */
      var u0=-(hl+hwG), u1=+(hl+hwG);

      /* Triangle 0: a, b, c */
      d[i++]=ax;  d[i++]=ay;  d[i++]=u0; d[i++]=-hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=bx;  d[i++]=by;  d[i++]=u0; d[i++]=+hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=cx;  d[i++]=cy;  d[i++]=u1; d[i++]=-hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      /* Triangle 1: b, d, c */
      d[i++]=bx;  d[i++]=by;  d[i++]=u0; d[i++]=+hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=dx2; d[i++]=dy2; d[i++]=u1; d[i++]=+hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=cx;  d[i++]=cy;  d[i++]=u1; d[i++]=-hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, bufSharp);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sharpData);
  }


  /* ═══════════════════════════════════════════════════════════
     LIGHTS + EDGE INTENSITY  (identical logic to original)
  ═══════════════════════════════════════════════════════════ */

  function updateLights(t) {
    var D = Math.min(W, H);
    var a1=t*0.0000552, a2=t*0.0000769+2.14;
    L1.x=W*0.5+Math.cos(a1)*W*0.28+Math.cos(a1*1.68)*W*0.07;
    L1.y=H*0.5+Math.sin(a1)*H*0.22+Math.sin(a1*1.38)*H*0.06;
    L1.r=D*0.52;
    L2.x=W*0.5+Math.cos(a2)*W*0.20+Math.cos(a2*2.25)*W*0.05;
    L2.y=H*0.5+Math.sin(a2)*H*0.16+Math.sin(a2*1.91)*H*0.04;
    L2.r=D*0.36;
  }

  function updateEdgeIntensities(breathe) {
    for (var ei = 0; ei < NEDGES; ei++) {
      var e=edges[ei], I=0, dx, dy, prox;

      dx=e.mx-L1.x; dy=e.my-L1.y;
      prox=Math.max(0, 1-Math.sqrt(dx*dx+dy*dy)/L1.r);
      I += prox*prox*L1.I;

      dx=e.mx-L2.x; dy=e.my-L2.y;
      prox=Math.max(0, 1-Math.sqrt(dx*dx+dy*dy)/L2.r);
      I += prox*prox*L2.I;

      e._I = Math.min(1, I*breathe);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     DRAW CALLS
  ═══════════════════════════════════════════════════════════ */

  /* Render glow edge quads into fbGlowIn (half-res).
     Additive blend: overlapping edges add their glow contributions. */
  function renderGlowEdges() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbGlowIn.fb);
    gl.viewport(0, 0, GW, GH);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(progGlow);
    gl.uniform2f(progGlow._u['u_res'], W, H);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    var stride = GLOW_F * 4;
    var aPos=progGlow._a['a_pos'], aInt=progGlow._a['a_int'];
    gl.enableVertexAttribArray(aPos); gl.enableVertexAttribArray(aInt);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(aInt, 1, gl.FLOAT, false, stride, 2*4);
    gl.drawArrays(gl.TRIANGLES, 0, NEDGES*6);
    gl.disableVertexAttribArray(aPos); gl.disableVertexAttribArray(aInt);
  }

  /* Draw sharp SDF-capsule edges directly to the currently-bound
     framebuffer (always the default).  Normal alpha blend over faces. */
  function renderSharpEdges() {
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(progSharp);
    gl.uniform2f(progSharp._u['u_res'], W, H);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufSharp);
    var stride = SHARP_F * 4;
    var aPos  = progSharp._a['a_pos'];
    var aUV   = progSharp._a['a_uv'];
    var aHLen = progSharp._a['a_hlen'];
    var aHW   = progSharp._a['a_hw'];
    var aInt  = progSharp._a['a_int'];

    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUV);
    gl.enableVertexAttribArray(aHLen);
    gl.enableVertexAttribArray(aHW);
    gl.enableVertexAttribArray(aInt);

    gl.vertexAttribPointer(aPos,  2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(aUV,   2, gl.FLOAT, false, stride, 2*4);
    gl.vertexAttribPointer(aHLen, 1, gl.FLOAT, false, stride, 4*4);
    gl.vertexAttribPointer(aHW,   1, gl.FLOAT, false, stride, 5*4);
    gl.vertexAttribPointer(aInt,  1, gl.FLOAT, false, stride, 6*4);

    gl.drawArrays(gl.TRIANGLES, 0, NEDGES*6);

    gl.disableVertexAttribArray(aPos);
    gl.disableVertexAttribArray(aUV);
    gl.disableVertexAttribArray(aHLen);
    gl.disableVertexAttribArray(aHW);
    gl.disableVertexAttribArray(aInt);
  }


  /* ═══════════════════════════════════════════════════════════
     CRYSTAL BUILD — runs once per resize
  ═══════════════════════════════════════════════════════════ */

  function buildCrystal() {
    var shards = generateShards(W, H);
    edges  = extractEdges(shards, W, H);
    NEDGES = edges.length;

    /* Pre-allocate dynamic CPU arrays */
    glowData  = new Float32Array(NEDGES * 6 * GLOW_F);
    sharpData = new Float32Array(NEDGES * 6 * SHARP_F);

    /* Upload static face geometry */
    buildFaceVBO(shards);

    /* Allocate dynamic VBOs (size never shrinks between calls) */
    if (!bufGlow)  bufGlow  = gl.createBuffer();
    if (!bufSharp) bufSharp = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    gl.bufferData(gl.ARRAY_BUFFER, glowData.byteLength,  gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufSharp);
    gl.bufferData(gl.ARRAY_BUFFER, sharpData.byteLength, gl.DYNAMIC_DRAW);

    /* Bake static face texture */
    bakeFaces();

    wideFrame = 0;  // force wide glow to rebuild immediately
  }


  /* ═══════════════════════════════════════════════════════════
     RENDER CRYSTAL — called every frame
  ═══════════════════════════════════════════════════════════ */

  function renderCrystal(ts) {
    var breathe = 0.72 + 0.28*Math.sin(ts*0.00076);

    /* ── 1. CPU: update lights + per-edge intensities ────── */
    updateLights(ts);
    updateEdgeIntensities(breathe);

    /* ── 2. GPU: rebuild + upload dynamic VBOs ─────────────
       glowData and sharpData are Float32Arrays written on CPU,
       then pushed to the GPU with bufferSubData.
       ~480–960 bytes for 80 edges — negligible. */
    rebuildGlowVBO();
    rebuildSharpVBO();

    /* ── 3. Glow input: rasterise edges to fbGlowIn ──────── */
    renderGlowEdges();

    /* ── 4. Wide glow — H+V Gaussian, cached every 2 frames  */
    wideFrame++;
    if (wideFrame % 2 === 0) {
      blurPass(progBlurWide, fbGlowIn.tex, fbWide);
    }

    /* ── 5. Medium glow — tighter blur, desktop only ──────
       Mobile skips this entirely: wide glow + sharp = sufficient
       at 30 fps, and the 7-tap blur is still measurable cost. */
    if (!isMobile) {
      blurPass(progBlurMed, fbGlowIn.tex, fbMed);
    }

    /* ── 6. Composite to screen (default framebuffer) ─────── */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, CW, CH);
    gl.clearColor(0.027, 0.027, 0.035, 1.0);  // #070709 void fallback
    gl.clear(gl.COLOR_BUFFER_BIT);

    blit(fbFace.tex,  'none');  // opaque shard faces (full-res texture)
    blit(fbWide.tex,  'add');   // additive wide glow
    if (!isMobile) blit(fbMed.tex, 'add');  // additive medium glow

    renderSharpEdges();          // SDF capsule edges at full physical res
  }


  /* ═══════════════════════════════════════════════════════════
     PARTICLE SYSTEM — unchanged from original
     Platinum particles (rgba(222,228,244,x)) on #particle-canvas.
  ═══════════════════════════════════════════════════════════ */

  function mkParticle(dir) {
    var speed = 0.12 + Math.random()*0.28;
    return {
      x: Math.random()*PW,
      y: dir===1 ? PH+Math.random()*PH : -(Math.random()*PH),
      vy: dir===1 ? -speed : speed,
      vx: (Math.random()-0.5)*0.08,
      r:  0.8 + Math.random()*1.4,
      alpha:   0.04 + Math.random()*0.18,
      life:    0,
      maxLife: 260 + Math.random()*280,
      dir:     dir
    };
  }

  function initParticles() {
    particles = [];
    for (var i=0; i<N_UP;   i++) particles.push(mkParticle(1));
    for (var j=0; j<N_DOWN; j++) particles.push(mkParticle(-1));
  }

  function renderParticles(ts) {
    if (!pCtx) return;
    if (isMobile && ts-lastPts < 33) return;
    lastPts = ts;

    pCtx.clearRect(0, 0, PW, PH);

    for (var i=0; i<particles.length; i++) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy; p.life++;

      var fi = Math.min(1, p.life/40);
      var fo = Math.min(1, (p.maxLife-p.life)/40);
      var a  = p.alpha*fi*fo;

      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      pCtx.fillStyle = 'rgba(222,228,244,'+a+')';
      pCtx.fill();

      /* Soft glow halo — desktop only */
      if (!isMobile) {
        pCtx.beginPath();
        pCtx.arc(p.x, p.y, p.r*3.2, 0, Math.PI*2);
        pCtx.fillStyle = 'rgba(222,228,244,'+(a*0.06)+')';
        pCtx.fill();
      }

      var dead = p.life>=p.maxLife
               ||(p.dir===1&&p.y<-20)
               ||(p.dir===-1&&p.y>PH+20);
      if (dead) particles[i] = mkParticle(p.dir);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     CURSOR — unchanged from original
  ═══════════════════════════════════════════════════════════ */

  function initCursor() {
    if (isMobile) return;
    curEl = document.getElementById('cur');
    if (!curEl) return;
    mx = window.innerWidth/2; my = window.innerHeight/2;
    curX = mx; curY = my;

    document.addEventListener('mousemove', function(e) {
      mx = e.clientX; my = e.clientY;
    }, { passive:true });

    document.addEventListener('mouseover', function(e) {
      if (!curEl) return;
      var interactive = !!e.target.closest(
        'button,[role="button"],a,input,select,textarea,' +
        'label,.token-row,.nav-item,.seg-btn,.toggle,.tab-btn'
      );
      var disabled = !!e.target.closest('[disabled],[aria-disabled="true"]');
      curEl.classList.toggle('hl', interactive && !disabled);
    });
  }

  function updateCursor() {
    if (!curEl || isMobile) return;
    curX += (mx-curX)*0.16;
    curY += (my-curY)*0.16;
    if (Math.abs(curX-prevCurX)>0.3 || Math.abs(curY-prevCurY)>0.3) {
      curEl.style.left = curX+'px';
      curEl.style.top  = curY+'px';
      prevCurX = curX; prevCurY = curY;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     RESIZE
  ═══════════════════════════════════════════════════════════ */

  function resize() {
    var dpr = Math.min(window.devicePixelRatio||1, 2);
    W  = window.innerWidth;
    H  = window.innerHeight;
    CW = Math.round(W*dpr);
    CH = Math.round(H*dpr);
    /* Glow FBOs at half logical resolution:
       - 1 glow texel ≈ 2 logical px
       - Blur stride of 4 texels → ±32 logical px wide spread
       - Bilinear upscale to CW×CH: free, adds implicit softness */
    GW = Math.ceil(W/2);
    GH = Math.ceil(H/2);

    if (_canvas) {
      _canvas.width  = CW;
      _canvas.height = CH;
    }

    /* Resize FBOs — old GPU objects freed immediately */
    fbFace   = resizeFBO(fbFace,   W,  H );   // logical (face is static, smooth)
    fbGlowIn = resizeFBO(fbGlowIn, GW, GH);
    fbPing   = resizeFBO(fbPing,   GW, GH);
    fbWide   = resizeFBO(fbWide,   GW, GH);
    fbMed    = resizeFBO(fbMed,    GW, GH);

    /* Particle canvas */
    if (pCanvas) {
      PW = pCanvas.width  = W;
      PH = pCanvas.height = H;
      initParticles();
    }

    /* Rebuild BSP geometry and bake face texture */
    buildCrystal();
  }


  /* ═══════════════════════════════════════════════════════════
     ANIMATION LOOP
  ═══════════════════════════════════════════════════════════ */

  function loop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);

    if (pageHidden) return;
    if (FRAME_CAP && ts-lastTs < FRAME_CAP) return;
    lastTs = ts;

    if (gl) renderCrystal(ts);
    renderParticles(ts);
    updateCursor();
  }


  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════ */

  /**
   * init(canvas)
   * Initialises the WebGL context on the crystal canvas.
   * Discovers #particle-canvas automatically.
   * Falls back to a console error if WebGL is unavailable —
   * the page continues to render without the crystal effect.
   */
  function init(canvas) {
    _canvas = canvas;

    /* Request a WebGL 1.0 context.  alpha:false = opaque canvas
       (faster browser compositing; BSP covers full viewport anyway).
       antialias:false = we handle AA in the SDF shader ourselves.   */
    gl = canvas.getContext('webgl', { alpha:false, antialias:false })
      || canvas.getContext('experimental-webgl', { alpha:false, antialias:false });

    if (!gl) {
      console.error('[FX] WebGL unavailable — crystal effect disabled.');
      return;
    }

    /* Compile all programs */
    progFace     = makeProgram(VS_FACE,  FS_FACE);
    progGlow     = makeProgram(VS_GLOW,  FS_GLOW);
    progSharp    = makeProgram(VS_SHARP, FS_SHARP);
    progBlurWide = makeProgram(VS_QUAD,  FS_BLUR_WIDE);
    progBlurMed  = makeProgram(VS_QUAD,  FS_BLUR_MED);
    progBlit     = makeProgram(VS_QUAD,  FS_BLIT);

    /* Fullscreen quad [-1,1]² as TRIANGLE_STRIP — shared by all passes */
    bufQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),
      gl.STATIC_DRAW);

    /* Depth test not needed — 2D compositing only */
    gl.disable(gl.DEPTH_TEST);

    /* Particle canvas */
    pCanvas = document.getElementById('particle-canvas');
    if (pCanvas) pCtx = pCanvas.getContext('2d');

    initCursor();

    /* Debounced resize — BSP rebuild fires once after drag stops */
    var _resizeTimer = null;
    window.addEventListener('resize', function() {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(resize, 200);
    }, { passive:true });

    resize();  // initial — runs immediately
  }

  /**
   * start()
   * Begins the animation loop.  Safe to call multiple times.
   */
  function start() {
    if (running) return;
    running = true;
    rafId   = requestAnimationFrame(loop);
  }

  /**
   * stop()
   * Cancels the animation loop.  Canvas state is preserved.
   */
  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  return { init:init, start:start, stop:stop };

})();
