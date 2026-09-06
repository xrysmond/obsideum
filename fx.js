/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — fx.js  ·  WebGL engine  ·  v2
   ─────────────────────────────────────────────────────────────────
   The effect: something alive and violet glows beneath the crystal.
   You see it through the cracks. The whole scene breathes as one.

   Architecture
   ────────────
   Face layer   — BSP shard polygons, per-vertex ambient gradient,
                  baked once per resize into fbFace (W×H). Static.

   Glow system  — The heart of the effect. Three pipeline stages:

     Stage 1 · Seed (fbGlowIn, half-res)
       Edge quads drawn additively. Width = 2+I*8 logical px.
       Color = premultiplied violet (156,61,187). Intensity ∝ I².
       Convergence points (multiple edge contributions) accumulate
       into very bright seeds — they drive the bright core look.

     Stage 2 · 3-pass wide cascade (stride=8, σ≈32 texels/pass)
       Three sequential H+V Gaussian passes, each blurring the
       previous result. By the third pass, the violet spreads
       ~110 display px from each hot edge — deep into the shard
       face interiors. This is the "something underneath" effect.
       Cached every 2 frames → fbWide.

     Stage 3 · Medium halo (stride=2, 1 pass)
       Tight 16px halo around each edge for crisp local glow.
       Runs every frame → fbMed.

   Sharp layer  — SDF capsule quads at full physical resolution.
                  Additive blend. Adds the bright crystalline core
                  line on top of the bloom. Violet, premultiplied.

   All three glow stages use additive blend on screen.
   The face layer absorbs the violet lift — the darker the face,
   the more dramatically the glow reads through it.

   Breathing    — Single breathe scalar multiplies ALL intensities.
                  The entire scene pulses together.
   Color        — violet #9C3DBB = rgb(156,61,187) throughout.
   Particles    — unchanged 2D canvas on #particle-canvas.
   Cursor       — unchanged DOM system.

   Export: window.FX = { init(crystalCanvas), start(), stop() }
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */

window.FX = (function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     DEVICE
  ───────────────────────────────────────────────────────────── */
  var isMobile = window.matchMedia('(hover:none) and (pointer:coarse)').matches;

  /* ─────────────────────────────────────────────────────────────
     GL STATE
  ───────────────────────────────────────────────────────────── */
  var _canvas = null;
  var gl      = null;

  /* W, H  — logical CSS pixels (vertex coordinate space)
     CW,CH — physical canvas pixels (main framebuffer, DPR-scaled)
     GW,GH — glow FBO dimensions  (≈ W/2, H/2)                    */
  var W = 0, H = 0, CW = 0, CH = 0, GW = 0, GH = 0;

  /* ─────────────────────────────────────────────────────────────
     SHADER PROGRAMS
  ───────────────────────────────────────────────────────────── */
  var progFace  = null;   // shard face geometry → fbFace
  var progGlow  = null;   // violet edge quads   → fbGlowIn
  var progSharp = null;   // SDF capsule edges   → screen (additive)
  var progBlur  = null;   // separable Gaussian, stride uniform
  var progBlit  = null;   // fullscreen texture quad

  /* ─────────────────────────────────────────────────────────────
     FRAMEBUFFERS  —  each: { fb, tex, w, h }
  ───────────────────────────────────────────────────────────── */
  var fbFace  = null;   // static shard faces          (W × H)
  var fbGlowIn= null;   // violet edge seeds           (GW × GH)
  var fbPing  = null;   // blur horizontal scratch     (GW × GH)
  var fbWide1 = null;   // 1st wide blur pass result   (GW × GH)
  var fbWide2 = null;   // 2nd wide blur pass result   (GW × GH)
  var fbWide  = null;   // 3rd wide blur — deep glow   (GW × GH, cached)
  var fbMed   = null;   // medium halo blur            (GW × GH)

  /* ─────────────────────────────────────────────────────────────
     GPU BUFFERS
  ───────────────────────────────────────────────────────────── */
  var bufFace  = null;  // STATIC_DRAW
  var bufGlow  = null;  // DYNAMIC_DRAW — rebuilt each frame
  var bufSharp = null;  // DYNAMIC_DRAW — rebuilt each frame
  var bufQuad  = null;  // fullscreen quad, STATIC_DRAW

  /* Vertex layouts (floats per vertex):
     Face  [x, y, r, g, b]                       = 5
     Glow  [x, y, intensity]                     = 3
     Sharp [x, y, lu, lv, hlen, hw, intensity]   = 7  */
  var FACE_F  = 5;
  var GLOW_F  = 3;
  var SHARP_F = 7;

  var faceVerts = 0;
  var NEDGES    = 0;

  var glowData  = null;   // Float32Array, rebuilt per frame
  var sharpData = null;   // Float32Array, rebuilt per frame

  /* ─────────────────────────────────────────────────────────────
     EDGE STATE
  ───────────────────────────────────────────────────────────── */
  var edges = [];

  /* ─────────────────────────────────────────────────────────────
     LIGHTS  —  two orbital sources, same as always
  ───────────────────────────────────────────────────────────── */
  var L1 = { x:0, y:0, I:1.00, r:0 };
  var L2 = { x:0, y:0, I:0.58, r:0 };

  /* ─────────────────────────────────────────────────────────────
     PARTICLES  —  unchanged 2D canvas system
  ───────────────────────────────────────────────────────────── */
  var pCanvas = null, pCtx = null;
  var PW = 0, PH = 0;
  var particles = [];
  var lastPts   = 0;
  var N_UP = 40, N_DOWN = 40;

  /* ─────────────────────────────────────────────────────────────
     CURSOR  —  unchanged DOM system
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
  var wideFrame  = 0;

  document.addEventListener('visibilitychange', function () {
    pageHidden = document.hidden;
  });


  /* ═══════════════════════════════════════════════════════════
     MATH  ·  Seeded RNG + BSP — byte-identical to original.
     Same seed → same shard layout, always.
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
      var poly = polys[maxIdx], c = centroid(poly);
      var xs = poly.map(function(v){return v.x;}),
          ys = poly.map(function(v){return v.y;});
      var angle = rng() * Math.PI;
      var offX = (rng()-0.5)*(Math.max.apply(null,xs)-Math.min.apply(null,xs))*0.38;
      var offY = (rng()-0.5)*(Math.max.apply(null,ys)-Math.min.apply(null,ys))*0.38;
      var reach = Math.hypot(pw,ph)*2.5;
      var cx2=c.x+offX, cy2=c.y+offY;
      var p1={x:cx2-Math.cos(angle)*reach, y:cy2-Math.sin(angle)*reach};
      var p2={x:cx2+Math.cos(angle)*reach, y:cy2+Math.sin(angle)*reach};
      var sp = splitPoly(poly,p1,p2);
      if (sp[0].length>=3 && sp[1].length>=3)
        polys.splice(maxIdx,1,sp[0],sp[1]);
    }
    return polys;
  }

  function extractEdges(polys, pw, ph) {
    var map = new Map(), tol = 3;
    for (var pi = 0; pi < polys.length; pi++) {
      var poly = polys[pi];
      for (var i = 0; i < poly.length; i++) {
        var a=poly[i], b=poly[(i+1)%poly.length];
        if ((a.x<tol&&b.x<tol)||(a.x>pw-tol&&b.x>pw-tol)||
            (a.y<tol&&b.y<tol)||(a.y>ph-tol&&b.y>ph-tol)) continue;
        var ax=Math.round(a.x*2)/2, ay=Math.round(a.y*2)/2;
        var bx=Math.round(b.x*2)/2, by=Math.round(b.y*2)/2;
        var key=(ax<bx||(ax===bx&&ay<by))
          ? ax+'|'+ay+'|'+bx+'|'+by
          : bx+'|'+by+'|'+ax+'|'+ay;
        if (!map.has(key)) map.set(key,{
          x1:a.x,y1:a.y,x2:b.x,y2:b.y,
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

  /* ── Fullscreen quad vertex (blur + blit) ────────────────── */
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
    '  vec2 clip = (a_pos/u_res)*2.0 - 1.0;',
    '  gl_Position = vec4(clip.x,-clip.y,0.0,1.0);',
    '  v_col = a_col;',
    '}'
  ].join('\n');

  var FS_FACE = [
    'precision mediump float;',
    'varying vec3 v_col;',
    'void main(){ gl_FragColor = vec4(v_col,1.0); }'
  ].join('\n');

  /* ── Violet glow edge quads (premultiplied, additive) ─────
     rgb(156,61,187)/255 = (0.612, 0.239, 0.733)
     Outputs premultiplied so blur averages cleanly.
     Seeds are wide and bright — wide blur spreads them deep
     into shard face interiors for the "beneath" illusion.   */
  var VS_GLOW = [
    'attribute vec2  a_pos;',
    'attribute float a_int;',
    'uniform vec2    u_res;',
    'varying float   v_int;',
    'void main(){',
    '  vec2 clip = (a_pos/u_res)*2.0 - 1.0;',
    '  gl_Position = vec4(clip.x,-clip.y,0.0,1.0);',
    '  v_int = a_int;',
    '}'
  ].join('\n');

  var FS_GLOW = [
    'precision mediump float;',
    'varying float v_int;',
    'void main(){',
    '  float a = min(1.0, v_int * v_int * 1.15);',
    '  // violet premult: rgb(156,61,187)/255',
    '  gl_FragColor = vec4(0.612*a, 0.239*a, 0.733*a, a);',
    '}'
  ].join('\n');

  /* ── Sharp SDF-capsule edge shaders (additive) ───────────── */
  var VS_SHARP = [
    'attribute vec2  a_pos;',
    'attribute vec2  a_uv;',
    'attribute float a_hlen;',
    'attribute float a_hw;',
    'attribute float a_int;',
    'uniform vec2    u_res;',
    'varying vec2    v_uv;',
    'varying float   v_hlen, v_hw, v_int;',
    'void main(){',
    '  vec2 clip = (a_pos/u_res)*2.0 - 1.0;',
    '  gl_Position = vec4(clip.x,-clip.y,0.0,1.0);',
    '  v_uv=a_uv; v_hlen=a_hlen; v_hw=a_hw; v_int=a_int;',
    '}'
  ].join('\n');

  /* SDF capsule. Additive blend means output is premultiplied.
     At the edge core (d→0) the contribution is pure bright violet.
     Convergence points (many overlapping edges) accumulate into
     near-white — matching the reference image core brightness.  */
  var FS_SHARP = [
    'precision mediump float;',
    'varying vec2  v_uv;',
    'varying float v_hlen, v_hw, v_int;',
    'void main(){',
    '  float cx = clamp(v_uv.x,-v_hlen,v_hlen);',
    '  float d  = length(vec2(v_uv.x-cx, v_uv.y));',
    '  float a  = smoothstep(v_hw+0.5, v_hw-0.5, d);',
    '  a *= min(0.95, v_int * 1.1);',
    '  gl_FragColor = vec4(0.612*a, 0.239*a, 0.733*a, a);',
    '}'
  ].join('\n');

  /* ── Single Gaussian blur shader — stride-configurable ──────
     9-tap symmetric kernel, σ=4 in stride units.
     Weights normalised: sum = 1.00002 (float precision).

     stride=8 → covers ±32 glow texels = ±64 display px per pass.
               3 cascaded passes → σ_eff ≈ 32√3 ≈ 55 texels
               = ~110 display px spread. Deep face illumination.

     stride=2 → covers ±8 glow texels = ±16 display px. One pass.
               Tight halo for crisp local edge aura.            */
  var FS_BLUR = [
    'precision mediump float;',
    'uniform sampler2D u_tex;',
    'uniform vec2      u_texel;',
    'uniform vec2      u_dir;',
    'uniform float     u_stride;',
    'varying vec2      v_uv;',
    'const float W0 = 0.13466;',
    'const float W1 = 0.13052;',
    'const float W2 = 0.11884;',
    'const float W3 = 0.10165;',
    'const float W4 = 0.08167;',
    'void main(){',
    '  vec2 t = u_dir * u_texel * u_stride;',
    '  gl_FragColor =',
    '    texture2D(u_tex,v_uv-4.0*t)*W4 +',
    '    texture2D(u_tex,v_uv-3.0*t)*W3 +',
    '    texture2D(u_tex,v_uv-2.0*t)*W2 +',
    '    texture2D(u_tex,v_uv-1.0*t)*W1 +',
    '    texture2D(u_tex,v_uv      )*W0 +',
    '    texture2D(u_tex,v_uv+1.0*t)*W1 +',
    '    texture2D(u_tex,v_uv+2.0*t)*W2 +',
    '    texture2D(u_tex,v_uv+3.0*t)*W3 +',
    '    texture2D(u_tex,v_uv+4.0*t)*W4;',
    '}'
  ].join('\n');

  /* ── Simple texture blit ─────────────────────────────────── */
  var FS_BLIT = [
    'precision mediump float;',
    'uniform sampler2D u_tex;',
    'varying vec2 v_uv;',
    'void main(){ gl_FragColor = texture2D(u_tex,v_uv); }'
  ].join('\n');


  /* ═══════════════════════════════════════════════════════════
     GL UTILITIES
  ═══════════════════════════════════════════════════════════ */

  function compileShader(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('[FX] shader compile:\n' + gl.getShaderInfoLog(sh));
    return sh;
  }

  function makeProgram(vsSrc, fsSrc) {
    var prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER,   vsSrc));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('[FX] link:\n' + gl.getProgramInfoLog(prog));
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

  /* CLAMP_TO_EDGE is mandatory — wrapping creates bright border
     flares that destroy the glow at screen edges.             */
  function makeFBO(w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fb:fb, tex:tex, w:w, h:h };
  }

  function resizeFBO(old, w, h) {
    if (old) { gl.deleteFramebuffer(old.fb); gl.deleteTexture(old.tex); }
    return makeFBO(w, h);
  }

  /* Blit srcTex to the currently-bound framebuffer.
     blendMode: 'none' = opaque  |  'add' = additive (ONE,ONE) */
  function blit(srcTex, blendMode) {
    gl.useProgram(progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(progBlit._u['u_tex'], 0);
    if (blendMode === 'add') { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE); }
    else                     { gl.disable(gl.BLEND); }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    var ap = progBlit._a['a_pos'];
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(ap);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /* One H+V Gaussian pass: srcTex → fbPing (H) → dst (V).
     stride controls physical spread (see FS_BLUR comments).
     fbPing is shared scratch — never call re-entrantly.      */
  function blurPass(srcTex, dst, stride) {
    var tw = 1.0/GW, th = 1.0/GH;
    gl.disable(gl.BLEND);
    gl.useProgram(progBlur);
    gl.uniform1f(progBlur._u['u_stride'], stride);
    gl.uniform2f(progBlur._u['u_texel'],  tw, th);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    var ap = progBlur._a['a_pos'];
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);

    /* Horizontal */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbPing.fb);
    gl.viewport(0,0,GW,GH);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(progBlur._u['u_tex'], 0);
    gl.uniform2f(progBlur._u['u_dir'], 1.0, 0.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* Vertical */
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0,0,GW,GH);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, fbPing.tex);
    gl.uniform2f(progBlur._u['u_dir'], 0.0, 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(ap);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }


  /* ═══════════════════════════════════════════════════════════
     GEOMETRY
  ═══════════════════════════════════════════════════════════ */

  /* Build face VBO from shard polygons.
     Fan-triangulates each polygon from vertex 0.
     Per-vertex brightness replicates the original ambient gradient:
       bright end  = rgb(b, b, b+2)   along +ALdir
       dark  end   = rgb(7, 7, 9)     along -ALdir    */
  function buildFaceVBO(shards) {
    var ALX = Math.cos(Math.PI*0.28), ALY = Math.sin(Math.PI*0.28);
    var midX = W*0.5, midY = H*0.5;
    var data = [];

    function lerp(a,b,t){ return a+t*(b-a); }
    function vRGB(cx,cy,span,bright,vx,vy){
      var proj = (vx-cx)*ALX + (vy-cy)*ALY;
      var t    = Math.max(0,Math.min(1, 0.5+proj/(2*span)));
      return [ lerp(7/255,bright,t), lerp(7/255,bright,t), lerp(9/255,bright+2/255,t) ];
    }

    for (var si = 0; si < shards.length; si++) {
      var poly = shards[si];
      if (poly.length < 3) continue;
      var c  = centroid(poly);
      var xs = poly.map(function(v){return v.x;}),
          ys = poly.map(function(v){return v.y;});
      var span = Math.max(
        Math.max.apply(null,xs)-Math.min.apply(null,xs),
        Math.max.apply(null,ys)-Math.min.apply(null,ys)
      ) * 0.55;
      var toX=c.x-midX, toY=c.y-midY, dist=Math.sqrt(toX*toX+toY*toY)||1;
      var facing = Math.max(0,(toX/dist)*ALX+(toY/dist)*ALY)*0.68+0.14;
      var bright = (10+facing*22)/255;

      for (var i = 1; i < poly.length-1; i++) {
        var v0=poly[0],v1=poly[i],v2=poly[i+1];
        var c0=vRGB(c.x,c.y,span,bright,v0.x,v0.y);
        var c1=vRGB(c.x,c.y,span,bright,v1.x,v1.y);
        var c2=vRGB(c.x,c.y,span,bright,v2.x,v2.y);
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

  /* Bake face geometry → fbFace.  One-time per resize. */
  function bakeFaces() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbFace.fb);
    gl.viewport(0,0,fbFace.w,fbFace.h);
    gl.clearColor(0.027,0.027,0.035,1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(progFace);
    gl.uniform2f(progFace._u['u_res'], W, H);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufFace);
    var stride = FACE_F*4;
    var aP=progFace._a['a_pos'], aC=progFace._a['a_col'];
    gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aC);
    gl.vertexAttribPointer(aP,2,gl.FLOAT,false,stride,0);
    gl.vertexAttribPointer(aC,3,gl.FLOAT,false,stride,2*4);
    gl.drawArrays(gl.TRIANGLES, 0, faceVerts);
    gl.disableVertexAttribArray(aP); gl.disableVertexAttribArray(aC);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* Rebuild glow VBO each frame.
     Quad half-width: hw = 2 + I*8 logical px.
     Wider seed = stronger bloom spreading into face interiors.
     Premultiplied violet in FS_GLOW so blur averages correctly. */
  function rebuildGlowVBO() {
    var d=glowData, i=0;
    for (var ei=0; ei<NEDGES; ei++) {
      var e=edges[ei], I=e._I;
      if (I < 0.04) { for(var z=0;z<6*GLOW_F;z++) d[i++]=0; continue; }
      var hw=2.0+I*8.0;
      var dx=e.x2-e.x1, dy=e.y2-e.y1;
      var len=Math.sqrt(dx*dx+dy*dy);
      var nx=dx/len, ny=dy/len;
      var px=-ny*hw, py=nx*hw;
      var ex=nx*hw,  ey=ny*hw;
      var ax=e.x1-ex-px, ay=e.y1-ey-py;
      var bx=e.x1-ex+px, by=e.y1-ey+py;
      var cx=e.x2+ex-px, cy=e.y2+ey-py;
      var qx=e.x2+ex+px, qy=e.y2+ey+py;
      d[i++]=ax;d[i++]=ay;d[i++]=I;
      d[i++]=bx;d[i++]=by;d[i++]=I;
      d[i++]=cx;d[i++]=cy;d[i++]=I;
      d[i++]=bx;d[i++]=by;d[i++]=I;
      d[i++]=qx;d[i++]=qy;d[i++]=I;
      d[i++]=cx;d[i++]=cy;d[i++]=I;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowData);
  }

  /* Rebuild sharp VBO each frame.
     SDF capsule with round caps — the bright crystalline core.
     Premultiplied output, additive blend → accumulates at junctions. */
  function rebuildSharpVBO() {
    var d=sharpData, i=0;
    for (var ei=0; ei<NEDGES; ei++) {
      var e=edges[ei], I=e._I;
      if (I < 0.04) { for(var z=0;z<6*SHARP_F;z++) d[i++]=0; continue; }
      var hw  = Math.max(0.50, 0.35+I*0.55);
      var hwG = hw+0.5;
      var dx=e.x2-e.x1, dy=e.y2-e.y1;
      var len=Math.sqrt(dx*dx+dy*dy);
      var nx=dx/len, ny=dy/len;
      var px=-ny*hwG, py=nx*hwG;
      var ex=nx*hwG,  ey=ny*hwG;
      var hl=len*0.5;
      var ax=e.x1-ex-px, ay=e.y1-ey-py;
      var bx=e.x1-ex+px, by=e.y1-ey+py;
      var cx=e.x2+ex-px, cy=e.y2+ey-py;
      var qx=e.x2+ex+px, qy=e.y2+ey+py;
      var u0=-(hl+hwG), u1=+(hl+hwG);
      /* [x, y, lu, lv, hlen, hw, intensity] */
      d[i++]=ax; d[i++]=ay; d[i++]=u0; d[i++]=-hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=bx; d[i++]=by; d[i++]=u0; d[i++]=+hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=cx; d[i++]=cy; d[i++]=u1; d[i++]=-hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=bx; d[i++]=by; d[i++]=u0; d[i++]=+hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=qx; d[i++]=qy; d[i++]=u1; d[i++]=+hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
      d[i++]=cx; d[i++]=cy; d[i++]=u1; d[i++]=-hwG; d[i++]=hl; d[i++]=hw; d[i++]=I;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufSharp);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sharpData);
  }


  /* ═══════════════════════════════════════════════════════════
     LIGHTS + EDGE INTENSITY
  ═══════════════════════════════════════════════════════════ */

  function updateLights(t) {
    var D=Math.min(W,H);
    var a1=t*0.0000552, a2=t*0.0000769+2.14;
    L1.x=W*0.5+Math.cos(a1)*W*0.28+Math.cos(a1*1.68)*W*0.07;
    L1.y=H*0.5+Math.sin(a1)*H*0.22+Math.sin(a1*1.38)*H*0.06;
    L1.r=D*0.52;
    L2.x=W*0.5+Math.cos(a2)*W*0.20+Math.cos(a2*2.25)*W*0.05;
    L2.y=H*0.5+Math.sin(a2)*H*0.16+Math.sin(a2*1.91)*H*0.04;
    L2.r=D*0.36;
  }

  /* Single breathe scalar multiplies ALL edge intensities.
     The entire crystal pulses as one — not edge by edge.  */
  function updateEdgeIntensities(breathe) {
    for (var ei=0; ei<NEDGES; ei++) {
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

  /* Render violet edge quads into fbGlowIn at half resolution.
     Additive blend — overlapping edges at convergence points
     accumulate into very bright seeds, driving the white core. */
  function renderGlowEdges() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbGlowIn.fb);
    gl.viewport(0,0,GW,GH);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE);
    gl.useProgram(progGlow);
    gl.uniform2f(progGlow._u['u_res'], W, H);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    var stride=GLOW_F*4;
    var aP=progGlow._a['a_pos'], aI=progGlow._a['a_int'];
    gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aI);
    gl.vertexAttribPointer(aP,2,gl.FLOAT,false,stride,0);
    gl.vertexAttribPointer(aI,1,gl.FLOAT,false,stride,2*4);
    gl.drawArrays(gl.TRIANGLES,0,NEDGES*6);
    gl.disableVertexAttribArray(aP); gl.disableVertexAttribArray(aI);
  }

  /* Draw sharp SDF capsules directly to current framebuffer.
     Additive blend: adds crystalline bright-core contribution
     on top of the already-glowing faces.                     */
  function renderSharpEdges() {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE);
    gl.useProgram(progSharp);
    gl.uniform2f(progSharp._u['u_res'], W, H);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufSharp);
    var stride=SHARP_F*4;
    var aP=progSharp._a['a_pos'],  aU=progSharp._a['a_uv'];
    var aL=progSharp._a['a_hlen'], aW=progSharp._a['a_hw'];
    var aI=progSharp._a['a_int'];
    gl.enableVertexAttribArray(aP); gl.enableVertexAttribArray(aU);
    gl.enableVertexAttribArray(aL); gl.enableVertexAttribArray(aW);
    gl.enableVertexAttribArray(aI);
    gl.vertexAttribPointer(aP,2,gl.FLOAT,false,stride,0);
    gl.vertexAttribPointer(aU,2,gl.FLOAT,false,stride,2*4);
    gl.vertexAttribPointer(aL,1,gl.FLOAT,false,stride,4*4);
    gl.vertexAttribPointer(aW,1,gl.FLOAT,false,stride,5*4);
    gl.vertexAttribPointer(aI,1,gl.FLOAT,false,stride,6*4);
    gl.drawArrays(gl.TRIANGLES,0,NEDGES*6);
    gl.disableVertexAttribArray(aP); gl.disableVertexAttribArray(aU);
    gl.disableVertexAttribArray(aL); gl.disableVertexAttribArray(aW);
    gl.disableVertexAttribArray(aI);
  }


  /* ═══════════════════════════════════════════════════════════
     CRYSTAL BUILD  —  once per resize
  ═══════════════════════════════════════════════════════════ */

  function buildCrystal() {
    var shards = generateShards(W,H);
    edges  = extractEdges(shards,W,H);
    NEDGES = edges.length;
    glowData  = new Float32Array(NEDGES*6*GLOW_F);
    sharpData = new Float32Array(NEDGES*6*SHARP_F);
    buildFaceVBO(shards);
    if (!bufGlow)  bufGlow  = gl.createBuffer();
    if (!bufSharp) bufSharp = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    gl.bufferData(gl.ARRAY_BUFFER, glowData.byteLength,  gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufSharp);
    gl.bufferData(gl.ARRAY_BUFFER, sharpData.byteLength, gl.DYNAMIC_DRAW);
    bakeFaces();
    wideFrame = 0;
  }


  /* ═══════════════════════════════════════════════════════════
     RENDER CRYSTAL  —  every frame
  ═══════════════════════════════════════════════════════════ */

  function renderCrystal(ts) {
    /* Single unified breathe — the whole crystal inhales together */
    var breathe = 0.62 + 0.38*Math.sin(ts*0.00076);

    updateLights(ts);
    updateEdgeIntensities(breathe);
    rebuildGlowVBO();
    rebuildSharpVBO();

    /* ── Glow seed: edge quads → fbGlowIn ─────────────────── */
    renderGlowEdges();

    /* ── 3-pass wide cascade (stride=8) — every 2 frames ────
       Pass 1: fbGlowIn → fbWide1   (~64px spread)
       Pass 2: fbWide1  → fbWide2   (~110px spread)
       Pass 3: fbWide2  → fbWide    (~155px spread)
       By pass 3, violet has bled deep into shard face interiors.
       Cached for performance — at 60fps the 1-frame lag is zero. */
    wideFrame++;
    if (wideFrame % 2 === 0) {
      blurPass(fbGlowIn.tex, fbWide1, 8.0);
      blurPass(fbWide1.tex,  fbWide2, 8.0);
      blurPass(fbWide2.tex,  fbWide,  8.0);
    }

    /* ── Medium halo (stride=2) — every frame ─────────────── */
    blurPass(fbGlowIn.tex, fbMed, 2.0);

    /* ── Composite to screen ─────────────────────────────── */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0,0,CW,CH);
    gl.clearColor(0.027,0.027,0.035,1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    blit(fbFace.tex, 'none');   // opaque dark shard faces
    blit(fbWide.tex, 'add');    // deep violet ambient — this is the "beneath" glow
    blit(fbMed.tex,  'add');    // tight edge halo

    renderSharpEdges();          // crystalline bright core lines
  }


  /* ═══════════════════════════════════════════════════════════
     PARTICLE SYSTEM  —  unchanged
  ═══════════════════════════════════════════════════════════ */

  function mkParticle(dir) {
    var speed = 0.12+Math.random()*0.28;
    return {
      x:Math.random()*PW,
      y:dir===1 ? PH+Math.random()*PH : -(Math.random()*PH),
      vy:dir===1 ? -speed : speed,
      vx:(Math.random()-0.5)*0.08,
      r:0.8+Math.random()*1.4,
      alpha:0.04+Math.random()*0.18,
      life:0, maxLife:260+Math.random()*280, dir:dir
    };
  }

  function initParticles() {
    particles = [];
    for (var i=0;i<N_UP;i++)   particles.push(mkParticle(1));
    for (var j=0;j<N_DOWN;j++) particles.push(mkParticle(-1));
  }

  function renderParticles(ts) {
    if (!pCtx) return;
    lastPts = ts;
    pCtx.clearRect(0,0,PW,PH);
    for (var i=0;i<particles.length;i++) {
      var p=particles[i];
      p.x+=p.vx; p.y+=p.vy; p.life++;
      var fi=Math.min(1,p.life/40), fo=Math.min(1,(p.maxLife-p.life)/40);
      var a=p.alpha*fi*fo;
      pCtx.beginPath();
      pCtx.arc(p.x,p.y,p.r,0,Math.PI*2);
      pCtx.fillStyle='rgba(200,160,255,'+a+')';
      pCtx.fill();
      if (!isMobile) {
        pCtx.beginPath();
        pCtx.arc(p.x,p.y,p.r*3.2,0,Math.PI*2);
        pCtx.fillStyle='rgba(180,80,220,'+(a*0.06)+')';
        pCtx.fill();
      }
      var dead=p.life>=p.maxLife
             ||(p.dir===1&&p.y<-20)
             ||(p.dir===-1&&p.y>PH+20);
      if (dead) particles[i]=mkParticle(p.dir);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     CURSOR  —  unchanged
  ═══════════════════════════════════════════════════════════ */

  function initCursor() {
    if (isMobile) return;
    curEl = document.getElementById('cur');
    if (!curEl) return;
    mx=window.innerWidth/2; my=window.innerHeight/2;
    curX=mx; curY=my;
    document.addEventListener('mousemove',function(e){
      mx=e.clientX; my=e.clientY;
    },{passive:true});
    document.addEventListener('mouseover',function(e){
      if (!curEl) return;
      var interactive=!!e.target.closest(
        'button,[role="button"],a,input,select,textarea,' +
        'label,.token-row,.nav-item,.seg-btn,.toggle,.tab-btn'
      );
      var disabled=!!e.target.closest('[disabled],[aria-disabled="true"]');
      curEl.classList.toggle('hl',interactive&&!disabled);
    });
  }

  function updateCursor() {
    if (!curEl||isMobile) return;
    curX+=(mx-curX)*0.16; curY+=(my-curY)*0.16;
    if (Math.abs(curX-prevCurX)>0.3||Math.abs(curY-prevCurY)>0.3) {
      curEl.style.left=curX+'px';
      curEl.style.top=curY+'px';
      prevCurX=curX; prevCurY=curY;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     RESIZE
  ═══════════════════════════════════════════════════════════ */

  function resize() {
    var dpr=Math.min(window.devicePixelRatio||1, 2);
    W=window.innerWidth; H=window.innerHeight;
    CW=Math.round(W*dpr); CH=Math.round(H*dpr);
    GW=Math.ceil(W/2);    GH=Math.ceil(H/2);

    if (_canvas) { _canvas.width=CW; _canvas.height=CH; }

    fbFace  = resizeFBO(fbFace,  W,  H);
    fbGlowIn= resizeFBO(fbGlowIn,GW, GH);
    fbPing  = resizeFBO(fbPing,  GW, GH);
    fbWide1 = resizeFBO(fbWide1, GW, GH);
    fbWide2 = resizeFBO(fbWide2, GW, GH);
    fbWide  = resizeFBO(fbWide,  GW, GH);
    fbMed   = resizeFBO(fbMed,   GW, GH);

    if (pCanvas) {
      PW=pCanvas.width=W;
      PH=pCanvas.height=H;
      initParticles();
    }

    buildCrystal();
  }


  /* ═══════════════════════════════════════════════════════════
     LOOP
  ═══════════════════════════════════════════════════════════ */

  function loop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (pageHidden) return;
    if (gl) renderCrystal(ts);
    renderParticles(ts);
    updateCursor();
  }


  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════ */

  function init(canvas) {
    _canvas = canvas;
    gl = canvas.getContext('webgl',{alpha:false,antialias:false})
      || canvas.getContext('experimental-webgl',{alpha:false,antialias:false});
    if (!gl) {
      console.error('[FX] WebGL unavailable.');
      return;
    }

    progFace  = makeProgram(VS_FACE,  FS_FACE);
    progGlow  = makeProgram(VS_GLOW,  FS_GLOW);
    progSharp = makeProgram(VS_SHARP, FS_SHARP);
    progBlur  = makeProgram(VS_QUAD,  FS_BLUR);
    progBlit  = makeProgram(VS_QUAD,  FS_BLIT);

    bufQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufQuad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),
      gl.STATIC_DRAW);

    gl.disable(gl.DEPTH_TEST);

    pCanvas = document.getElementById('particle-canvas');
    if (pCanvas) pCtx = pCanvas.getContext('2d');

    initCursor();

    var _rt = null;
    window.addEventListener('resize',function(){
      clearTimeout(_rt); _rt=setTimeout(resize,200);
    },{passive:true});

    resize();
  }

  function start() {
    if (running) return;
    running=true;
    rafId=requestAnimationFrame(loop);
  }

  function stop() {
    running=false;
    if (rafId){ cancelAnimationFrame(rafId); rafId=null; }
  }

  return { init:init, start:start, stop:stop };

})();