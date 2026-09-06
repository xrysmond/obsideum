/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — fx.js  ·  WebGL engine  ·  v3
   ─────────────────────────────────────────────────────────────────
   Root fixes in this version
   ──────────────────────────
   v2 had two structural problems:

   1. Box glow — glow quads were flat rectangles.  A rectangle
      blurred is still a rectangle with soft edges.  Fix: Gaussian
      cross-section in the glow fragment shader.  exp(-3d²/hw²)
      from the capsule centerline makes every edge seed an oval
      bloom, so the subsequent GPU blur spreads a smooth halo.

   2. Uniform edge — single _I (midpoint intensity) meant the entire
      edge lit at the same brightness end to end.  Fix: compute
      _Ia at (x1,y1) and _Ib at (x2,y2) independently.  mix(Ia,Ib)
      in the fragment shader varies intensity along the edge — one
      end near the light is bright, the far end dim.  As the lights
      orbit, this creates the travelling pulse Waeven described.

   The sharp SDF layer uses the same per-endpoint data so the
   crystalline line core also dims at the edge tips, matching the
   glow perfectly.

   Everything else (BSP, 3-pass cascade, FBOs, cursor, particles)
   unchanged from v2.
═══════════════════════════════════════════════════════════════════ */

window.FX = (function () {
  'use strict';

  var isMobile = window.matchMedia('(hover:none) and (pointer:coarse)').matches;

  /* ── GL state ─────────────────────────────────────────────── */
  var _canvas = null, gl = null;
  var W=0,H=0,CW=0,CH=0,GW=0,GH=0;

  /* ── Programs ─────────────────────────────────────────────── */
  var progFace  = null;
  var progGlow  = null;
  var progSharp = null;
  var progBlur  = null;
  var progBlit  = null;

  /* ── Framebuffers ─────────────────────────────────────────── */
  var fbFace=null, fbGlowIn=null, fbPing=null;
  var fbWide1=null, fbWide2=null, fbWide=null, fbMed=null;

  /* ── Buffers ──────────────────────────────────────────────── */
  var bufFace=null, bufGlow=null, bufSharp=null, bufQuad=null;

  /* Vertex layouts (floats per vertex):
     Face  [x, y, r, g, b]                          = 5
     Glow  [x, y, lu, lv, hlen, hw, ia, ib]         = 8
     Sharp [x, y, lu, lv, hlen, hw, ia, ib]         = 8   */
  var FACE_F=5, GLOW_F=8, SHARP_F=8;
  var faceVerts=0, NEDGES=0;
  var glowData=null, sharpData=null;

  /* ── Edge state ───────────────────────────────────────────── */
  var edges=[];

  /* ── Lights ───────────────────────────────────────────────── */
  var L1={x:0,y:0,I:1.00,r:0};
  var L2={x:0,y:0,I:0.58,r:0};

  /* ── Particles ────────────────────────────────────────────── */
  var pCanvas=null,pCtx=null,PW=0,PH=0;
  var particles=[],lastPts=0;
  var N_UP=40,N_DOWN=40;

  /* ── Cursor ───────────────────────────────────────────────── */
  var curEl=null,mx=0,my=0,curX=0,curY=0,prevCurX=-999,prevCurY=-999;

  /* ── Loop ─────────────────────────────────────────────────── */
  var rafId=null,running=false,pageHidden=false,wideFrame=0;

  document.addEventListener('visibilitychange',function(){
    pageHidden=document.hidden;
  });


  /* ═══════════════════════════════════════════════════════════
     MATH — seeded RNG + BSP, byte-identical to original
  ═══════════════════════════════════════════════════════════ */

  function mkRng(seed){
    var s=seed;
    return function(){
      s|=0;s=s+0x6D2B79F5|0;
      var t=Math.imul(s^s>>>15,1|s);
      t=t+Math.imul(t^t>>>7,61|t)^t;
      return((t^t>>>14)>>>0)/4294967296;
    };
  }
  function cross(p1,p2,pt){
    return(p2.x-p1.x)*(pt.y-p1.y)-(p2.y-p1.y)*(pt.x-p1.x);
  }
  function splitPoly(poly,p1,p2){
    var A=[],B=[];
    for(var i=0;i<poly.length;i++){
      var cur=poly[i],nxt=poly[(i+1)%poly.length];
      var cc=cross(p1,p2,cur),nc=cross(p1,p2,nxt);
      if(cc>=0)A.push({x:cur.x,y:cur.y});else B.push({x:cur.x,y:cur.y});
      if((cc>0&&nc<0)||(cc<0&&nc>0)){
        var t=cc/(cc-nc);
        A.push({x:cur.x+t*(nxt.x-cur.x),y:cur.y+t*(nxt.y-cur.y)});
        B.push({x:cur.x+t*(nxt.x-cur.x),y:cur.y+t*(nxt.y-cur.y)});
      }
    }
    return[A,B];
  }
  function polyArea(poly){
    var a=0;
    for(var i=0;i<poly.length;i++){var j=(i+1)%poly.length;a+=poly[i].x*poly[j].y-poly[j].x*poly[i].y;}
    return Math.abs(a)*0.5;
  }
  function centroid(poly){
    return{x:poly.reduce(function(s,v){return s+v.x;},0)/poly.length,
           y:poly.reduce(function(s,v){return s+v.y;},0)/poly.length};
  }
  function generateShards(pw,ph){
    var rng=mkRng(0xC2E9A3F7);
    var polys=[{x:0,y:0},{x:pw,y:0},{x:pw,y:ph},{x:0,y:ph}];
    polys=[polys];
    for(var pass=0;pass<15;pass++){
      var maxA=-1,maxIdx=0;
      for(var i=0;i<polys.length;i++){var a=polyArea(polys[i]);if(a>maxA){maxA=a;maxIdx=i;}}
      var poly=polys[maxIdx],c=centroid(poly);
      var xs=poly.map(function(v){return v.x;}),ys=poly.map(function(v){return v.y;});
      var angle=rng()*Math.PI;
      var offX=(rng()-0.5)*(Math.max.apply(null,xs)-Math.min.apply(null,xs))*0.38;
      var offY=(rng()-0.5)*(Math.max.apply(null,ys)-Math.min.apply(null,ys))*0.38;
      var reach=Math.hypot(pw,ph)*2.5;
      var cx2=c.x+offX,cy2=c.y+offY;
      var p1={x:cx2-Math.cos(angle)*reach,y:cy2-Math.sin(angle)*reach};
      var p2={x:cx2+Math.cos(angle)*reach,y:cy2+Math.sin(angle)*reach};
      var sp=splitPoly(poly,p1,p2);
      if(sp[0].length>=3&&sp[1].length>=3)polys.splice(maxIdx,1,sp[0],sp[1]);
    }
    return polys;
  }
  function extractEdges(polys,pw,ph){
    var map=new Map(),tol=3;
    for(var pi=0;pi<polys.length;pi++){
      var poly=polys[pi];
      for(var i=0;i<poly.length;i++){
        var a=poly[i],b=poly[(i+1)%poly.length];
        if((a.x<tol&&b.x<tol)||(a.x>pw-tol&&b.x>pw-tol)||
           (a.y<tol&&b.y<tol)||(a.y>ph-tol&&b.y>ph-tol))continue;
        var ax=Math.round(a.x*2)/2,ay=Math.round(a.y*2)/2;
        var bx=Math.round(b.x*2)/2,by=Math.round(b.y*2)/2;
        var key=(ax<bx||(ax===bx&&ay<by))?ax+'|'+ay+'|'+bx+'|'+by:bx+'|'+by+'|'+ax+'|'+ay;
        if(!map.has(key))map.set(key,{
          x1:a.x,y1:a.y,x2:b.x,y2:b.y,
          mx:(a.x+b.x)*0.5,my:(a.y+b.y)*0.5,
          len:Math.hypot(b.x-a.x,b.y-a.y)||1,
          _I:0,_Ia:0,_Ib:0
        });
      }
    }
    return Array.from(map.values()).filter(function(e){return e.len>6;});
  }


  /* ═══════════════════════════════════════════════════════════
     GLSL
  ═══════════════════════════════════════════════════════════ */

  var VS_QUAD=[
    'attribute vec2 a_pos;','varying vec2 v_uv;',
    'void main(){v_uv=(a_pos+1.0)*0.5;gl_Position=vec4(a_pos,0.0,1.0);}'
  ].join('\n');

  /* ── Face ─────────────────────────────────────────────────── */
  var VS_FACE=[
    'attribute vec2 a_pos;','attribute vec3 a_col;','uniform vec2 u_res;','varying vec3 v_col;',
    'void main(){vec2 c=(a_pos/u_res)*2.0-1.0;gl_Position=vec4(c.x,-c.y,0.0,1.0);v_col=a_col;}'
  ].join('\n');
  var FS_FACE=[
    'precision mediump float;','varying vec3 v_col;',
    'void main(){gl_FragColor=vec4(v_col,1.0);}'
  ].join('\n');

  /* ── Shared edge vertex shader (glow + sharp both use this) ─
     Per-vertex data: world pos, local UV (along, perp in logical px),
     half-length, half-width, and intensity at each endpoint.
     Intensity is interpolated per-fragment via mix(ia,ib,u_along). */
  var VS_EDGE=[
    'attribute vec2  a_pos;',
    'attribute vec2  a_uv;',    // (u along edge, v perp) — logical px
    'attribute float a_hlen;',  // half-length of edge, logical px
    'attribute float a_hw;',    // glow: gaussian radius  |  sharp: sdf half-width
    'attribute float a_ia;',    // intensity at p0 (x1,y1)
    'attribute float a_ib;',    // intensity at p1 (x2,y2)
    'uniform vec2 u_res;',
    'varying vec2  v_uv;',
    'varying float v_hlen,v_hw,v_ia,v_ib;',
    'void main(){',
    '  vec2 c=(a_pos/u_res)*2.0-1.0;',
    '  gl_Position=vec4(c.x,-c.y,0.0,1.0);',
    '  v_uv=a_uv;v_hlen=a_hlen;v_hw=a_hw;v_ia=a_ia;v_ib=a_ib;',
    '}'
  ].join('\n');

  /* ── Glow fragment: Gaussian oval from capsule centerline ────
     The key fix for the box-glow problem.

     exp(-3 * d² / hw²) gives a smooth circular/oval falloff from
     the edge centerline — the bloom is a soft oval, not a blurred
     rectangle.  The 3-pass GPU cascade then spreads this oval
     deep into the face interiors.

     mix(ia, ib, u_along) varies intensity end-to-end.  The part
     of the edge nearest a light is brighter; the far end is dim.
     As lights orbit this creates the travelling-pulse effect.     */
  var FS_GLOW=[
    'precision mediump float;',
    'varying vec2  v_uv;',
    'varying float v_hlen,v_hw,v_ia,v_ib;',
    'void main(){',
    '  // Capsule distance from centerline (logical px)',
    '  float cx  = clamp(v_uv.x,-v_hlen,v_hlen);',
    '  float d   = length(vec2(v_uv.x-cx, v_uv.y));',
    '  // Gaussian oval decay — no flat edges, no box',
    '  float hw2 = v_hw*v_hw + 0.1;',
    '  float glow = exp(-3.0*d*d/hw2);',
    '  // Parametric position along edge [0..1]',
    '  float denom = 2.0*v_hlen + 0.001;',
    '  float u_along = clamp((v_uv.x+v_hlen)/denom, 0.0, 1.0);',
    '  // Per-endpoint intensity — the pulse',
    '  float I = mix(v_ia,v_ib,u_along);',
    '  float a = min(1.0, I*I*1.6*glow);',
    '  // Violet premult: rgb(156,61,187)/255',
    '  gl_FragColor = vec4(0.612*a, 0.239*a, 0.733*a, a);',
    '}'
  ].join('\n');

  /* ── Sharp fragment: SDF capsule, intensity varies along edge ─
     Same per-endpoint mix so the crystalline core line dims at
     the dark end, matching the glow beneath it exactly.          */
  var FS_SHARP=[
    'precision mediump float;',
    'varying vec2  v_uv;',
    'varying float v_hlen,v_hw,v_ia,v_ib;',
    'void main(){',
    '  float cx  = clamp(v_uv.x,-v_hlen,v_hlen);',
    '  float d   = length(vec2(v_uv.x-cx, v_uv.y));',
    '  float a   = smoothstep(v_hw+0.5,v_hw-0.5,d);',
    '  float u_along = clamp((v_uv.x+v_hlen)/(2.0*v_hlen+0.001),0.0,1.0);',
    '  float I   = mix(v_ia,v_ib,u_along);',
    '  a *= min(0.95, I*1.1);',
    '  gl_FragColor = vec4(0.612*a, 0.239*a, 0.733*a, a);',
    '}'
  ].join('\n');

  /* ── Gaussian blur — stride configurable ─────────────────────
     9-tap, σ=4 in stride units.  Weights sum ≈ 1.0.
     stride=8: ±32 glow texels per pass → ~64 display px
     stride=2: ±8 glow texels per pass  → ~16 display px        */
  var FS_BLUR=[
    'precision mediump float;',
    'uniform sampler2D u_tex;','uniform vec2 u_texel;',
    'uniform vec2 u_dir;','uniform float u_stride;',
    'varying vec2 v_uv;',
    'const float W0=0.13466,W1=0.13052,W2=0.11884,W3=0.10165,W4=0.08167;',
    'void main(){',
    '  vec2 t=u_dir*u_texel*u_stride;',
    '  gl_FragColor=',
    '    texture2D(u_tex,v_uv-4.0*t)*W4+texture2D(u_tex,v_uv-3.0*t)*W3+',
    '    texture2D(u_tex,v_uv-2.0*t)*W2+texture2D(u_tex,v_uv-1.0*t)*W1+',
    '    texture2D(u_tex,v_uv      )*W0+',
    '    texture2D(u_tex,v_uv+1.0*t)*W1+texture2D(u_tex,v_uv+2.0*t)*W2+',
    '    texture2D(u_tex,v_uv+3.0*t)*W3+texture2D(u_tex,v_uv+4.0*t)*W4;',
    '}'
  ].join('\n');

  var FS_BLIT=[
    'precision mediump float;','uniform sampler2D u_tex;','varying vec2 v_uv;',
    'void main(){gl_FragColor=texture2D(u_tex,v_uv);}'
  ].join('\n');


  /* ═══════════════════════════════════════════════════════════
     GL UTILITIES
  ═══════════════════════════════════════════════════════════ */

  function compileShader(type,src){
    var sh=gl.createShader(type);
    gl.shaderSource(sh,src);gl.compileShader(sh);
    if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))
      throw new Error('[FX] shader:\n'+gl.getShaderInfoLog(sh)+'\n'+src);
    return sh;
  }
  function makeProgram(vs,fs){
    var p=gl.createProgram();
    gl.attachShader(p,compileShader(gl.VERTEX_SHADER,vs));
    gl.attachShader(p,compileShader(gl.FRAGMENT_SHADER,fs));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))
      throw new Error('[FX] link:\n'+gl.getProgramInfoLog(p));
    p._u={};p._a={};
    var nu=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);
    for(var i=0;i<nu;i++){var u=gl.getActiveUniform(p,i);p._u[u.name]=gl.getUniformLocation(p,u.name);}
    var na=gl.getProgramParameter(p,gl.ACTIVE_ATTRIBUTES);
    for(var j=0;j<na;j++){var a=gl.getActiveAttrib(p,j);p._a[a.name]=gl.getAttribLocation(p,a.name);}
    return p;
  }
  function makeFBO(w,h){
    var tex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    var fb=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindTexture(gl.TEXTURE_2D,null);
    return{fb:fb,tex:tex,w:w,h:h};
  }
  function resizeFBO(old,w,h){
    if(old){gl.deleteFramebuffer(old.fb);gl.deleteTexture(old.tex);}
    return makeFBO(w,h);
  }
  function blit(tex,blend){
    gl.useProgram(progBlit);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.uniform1i(progBlit._u['u_tex'],0);
    if(blend==='add'){gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);}
    else{gl.disable(gl.BLEND);}
    gl.bindBuffer(gl.ARRAY_BUFFER,bufQuad);
    var ap=progBlit._a['a_pos'];
    gl.enableVertexAttribArray(ap);gl.vertexAttribPointer(ap,2,gl.FLOAT,false,0,0);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.disableVertexAttribArray(ap);gl.bindTexture(gl.TEXTURE_2D,null);
  }
  function blurPass(srcTex,dst,stride){
    var tw=1.0/GW,th=1.0/GH;
    gl.disable(gl.BLEND);
    gl.useProgram(progBlur);
    gl.uniform1f(progBlur._u['u_stride'],stride);
    gl.uniform2f(progBlur._u['u_texel'],tw,th);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufQuad);
    var ap=progBlur._a['a_pos'];
    gl.enableVertexAttribArray(ap);gl.vertexAttribPointer(ap,2,gl.FLOAT,false,0,0);
    /* H-pass */
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbPing.fb);
    gl.viewport(0,0,GW,GH);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,srcTex);
    gl.uniform1i(progBlur._u['u_tex'],0);gl.uniform2f(progBlur._u['u_dir'],1.0,0.0);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    /* V-pass */
    gl.bindFramebuffer(gl.FRAMEBUFFER,dst.fb);
    gl.viewport(0,0,GW,GH);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D,fbPing.tex);
    gl.uniform2f(progBlur._u['u_dir'],0.0,1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.disableVertexAttribArray(ap);gl.bindTexture(gl.TEXTURE_2D,null);
  }


  /* ═══════════════════════════════════════════════════════════
     GEOMETRY — face VBO (static)
  ═══════════════════════════════════════════════════════════ */

  function buildFaceVBO(shards){
    var ALX=Math.cos(Math.PI*0.28),ALY=Math.sin(Math.PI*0.28);
    var midX=W*0.5,midY=H*0.5;
    var data=[];
    function lerp(a,b,t){return a+t*(b-a);}
    function vRGB(c,span,bright,vx,vy){
      var proj=(vx-c.x)*ALX+(vy-c.y)*ALY;
      var t=Math.max(0,Math.min(1,0.5+proj/(2*span)));
      return[lerp(7/255,bright,t),lerp(7/255,bright,t),lerp(9/255,bright+2/255,t)];
    }
    for(var si=0;si<shards.length;si++){
      var poly=shards[si];if(poly.length<3)continue;
      var c=centroid(poly);
      var xs=poly.map(function(v){return v.x;}),ys=poly.map(function(v){return v.y;});
      var span=Math.max(Math.max.apply(null,xs)-Math.min.apply(null,xs),
                        Math.max.apply(null,ys)-Math.min.apply(null,ys))*0.55;
      var toX=c.x-midX,toY=c.y-midY,dist=Math.sqrt(toX*toX+toY*toY)||1;
      var facing=Math.max(0,(toX/dist)*ALX+(toY/dist)*ALY)*0.68+0.14;
      var bright=(10+facing*22)/255;
      for(var i=1;i<poly.length-1;i++){
        var v0=poly[0],v1=poly[i],v2=poly[i+1];
        var c0=vRGB(c,span,bright,v0.x,v0.y);
        var c1=vRGB(c,span,bright,v1.x,v1.y);
        var c2=vRGB(c,span,bright,v2.x,v2.y);
        data.push(v0.x,v0.y,c0[0],c0[1],c0[2]);
        data.push(v1.x,v1.y,c1[0],c1[1],c1[2]);
        data.push(v2.x,v2.y,c2[0],c2[1],c2[2]);
      }
    }
    faceVerts=data.length/FACE_F;
    if(!bufFace)bufFace=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,bufFace);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
  }

  function bakeFaces(){
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbFace.fb);
    gl.viewport(0,0,fbFace.w,fbFace.h);
    gl.clearColor(0.027,0.027,0.035,1.0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(progFace);gl.uniform2f(progFace._u['u_res'],W,H);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufFace);
    var s=FACE_F*4,ap=progFace._a['a_pos'],ac=progFace._a['a_col'];
    gl.enableVertexAttribArray(ap);gl.enableVertexAttribArray(ac);
    gl.vertexAttribPointer(ap,2,gl.FLOAT,false,s,0);
    gl.vertexAttribPointer(ac,3,gl.FLOAT,false,s,2*4);
    gl.drawArrays(gl.TRIANGLES,0,faceVerts);
    gl.disableVertexAttribArray(ap);gl.disableVertexAttribArray(ac);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }


  /* ═══════════════════════════════════════════════════════════
     LIGHTS + EDGE INTENSITY
  ═══════════════════════════════════════════════════════════ */

  function updateLights(t){
    var D=Math.min(W,H);
    var a1=t*0.0000552,a2=t*0.0000769+2.14;
    L1.x=W*0.5+Math.cos(a1)*W*0.28+Math.cos(a1*1.68)*W*0.07;
    L1.y=H*0.5+Math.sin(a1)*H*0.22+Math.sin(a1*1.38)*H*0.06;
    L1.r=D*0.52;
    L2.x=W*0.5+Math.cos(a2)*W*0.20+Math.cos(a2*2.25)*W*0.05;
    L2.y=H*0.5+Math.sin(a2)*H*0.16+Math.sin(a2*1.91)*H*0.04;
    L2.r=D*0.36;
  }

  /* Compute raw intensity at any point from both lights. */
  function ptI(x,y){
    var I=0,dx,dy,prox;
    dx=x-L1.x;dy=y-L1.y;prox=Math.max(0,1-Math.sqrt(dx*dx+dy*dy)/L1.r);I+=prox*prox*L1.I;
    dx=x-L2.x;dy=y-L2.y;prox=Math.max(0,1-Math.sqrt(dx*dx+dy*dy)/L2.r);I+=prox*prox*L2.I;
    return I;
  }

  /* Per-endpoint intensities — the fix for uniform edges.
     _Ia = intensity AT (x1,y1).  _Ib = intensity AT (x2,y2).
     mix(Ia,Ib) in the shader interpolates along the edge,
     creating the travelling pulse as the lights orbit.
     _I = max for culling threshold only.                    */
  function updateEdgeIntensities(breathe){
    for(var ei=0;ei<NEDGES;ei++){
      var e=edges[ei];
      e._Ia=Math.min(1,ptI(e.x1,e.y1)*breathe);
      e._Ib=Math.min(1,ptI(e.x2,e.y2)*breathe);
      e._I =Math.max(e._Ia,e._Ib);  // max of both endpoints for culling
    }
  }


  /* ═══════════════════════════════════════════════════════════
     DYNAMIC VBO REBUILD
     Both glow and sharp use the same 8-float layout:
     [x, y, lu, lv, hlen, hw, ia, ib]
     — lu,lv: local coords in logical px (u along edge, v perp)
     — hlen:  half-length of edge in logical px
     — hw:    glow: gaussian radius  |  sharp: visual half-width
     — ia,ib: intensity at each endpoint (the pulse data)
  ═══════════════════════════════════════════════════════════ */

  /* Push one capsule quad (6 vertices) into a Float32Array.
     offset: current float index into 'arr'.
     Returns new offset after writing 6*8=48 floats.         */
  function pushCapsuleQuad(arr,off, x1,y1,x2,y2, hw,ia,ib){
    var dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy);
    if(len<1)return off+48;
    var nx=dx/len,ny=dy/len;       // unit along edge
    var px=-ny,py=nx;              // unit perpendicular
    var hl=len*0.5;
    /* Geometric half-width: hw + 0.5 buffer for AA / Gaussian tails */
    var hwG=hw+0.5;
    /* Perpendicular offsets */
    var wpx=px*hwG,wpy=py*hwG;
    /* Cap extensions along edge */
    var ecx=nx*hwG,ecy=ny*hwG;

    /* 4 corners of the capsule bounding rect:
       a = p0 end, side A    b = p0 end, side B
       c = p1 end, side A    d = p1 end, side B */
    var ax=x1-ecx-wpx,ay=y1-ecy-wpy;
    var bx=x1-ecx+wpx,by=y1-ecy+wpy;
    var cx=x2+ecx-wpx,cy=y2+ecy-wpy;
    var dx2=x2+ecx+wpx,dy2=y2+ecy+wpy;

    /* Local UV (logical px):
       u = along edge:  -(hl+hwG) at a/b corner, +(hl+hwG) at c/d corner
       v = perp:        -hwG at a/c, +hwG at b/d                          */
    var u0=-(hl+hwG),u1=+(hl+hwG);

    /* Triangle 0: a, b, c  —  Triangle 1: b, d, c */
    /* vertex: [x, y, lu, lv, hlen, hw, ia, ib]     */
    arr[off++]=ax;arr[off++]=ay;arr[off++]=u0;arr[off++]=-hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=bx;arr[off++]=by;arr[off++]=u0;arr[off++]=+hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=cx;arr[off++]=cy;arr[off++]=u1;arr[off++]=-hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=bx;arr[off++]=by;arr[off++]=u0;arr[off++]=+hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=dx2;arr[off++]=dy2;arr[off++]=u1;arr[off++]=+hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=cx;arr[off++]=cy;arr[off++]=u1;arr[off++]=-hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    return off;
  }

  function rebuildGlowVBO(){
    var d=glowData,off=0;
    for(var ei=0;ei<NEDGES;ei++){
      var e=edges[ei];
      if(e._I<0.04){off+=48;continue;}  // leave zeros (degenerate at origin)
      /* Glow gaussian radius: wider = more face illumination */
      var hw=3.0+Math.max(e._Ia,e._Ib)*10.0;
      off=pushCapsuleQuad(d,off,e.x1,e.y1,e.x2,e.y2,hw,e._Ia,e._Ib);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,bufGlow);
    gl.bufferSubData(gl.ARRAY_BUFFER,0,glowData);
  }

  function rebuildSharpVBO(){
    var d=sharpData,off=0;
    for(var ei=0;ei<NEDGES;ei++){
      var e=edges[ei];
      if(e._I<0.04){off+=48;continue;}
      /* Sharp visual half-width: thin SDF line, scales with peak intensity */
      var hw=Math.max(0.50,0.35+Math.max(e._Ia,e._Ib)*0.55);
      off=pushCapsuleQuad(d,off,e.x1,e.y1,e.x2,e.y2,hw,e._Ia,e._Ib);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,bufSharp);
    gl.bufferSubData(gl.ARRAY_BUFFER,0,sharpData);
  }


  /* ═══════════════════════════════════════════════════════════
     DRAW CALLS — edge binding helper (shared layout)
  ═══════════════════════════════════════════════════════════ */

  function bindEdgeAttribs(prog){
    var s=GLOW_F*4;  /* = SHARP_F*4 = 32 bytes */
    var aP=prog._a['a_pos'],aU=prog._a['a_uv'];
    var aL=prog._a['a_hlen'],aW=prog._a['a_hw'];
    var aA=prog._a['a_ia'],aB=prog._a['a_ib'];
    gl.enableVertexAttribArray(aP);gl.enableVertexAttribArray(aU);
    gl.enableVertexAttribArray(aL);gl.enableVertexAttribArray(aW);
    gl.enableVertexAttribArray(aA);gl.enableVertexAttribArray(aB);
    gl.vertexAttribPointer(aP,2,gl.FLOAT,false,s,0   );  // x, y
    gl.vertexAttribPointer(aU,2,gl.FLOAT,false,s,2*4 );  // lu, lv
    gl.vertexAttribPointer(aL,1,gl.FLOAT,false,s,4*4 );  // hlen
    gl.vertexAttribPointer(aW,1,gl.FLOAT,false,s,5*4 );  // hw
    gl.vertexAttribPointer(aA,1,gl.FLOAT,false,s,6*4 );  // ia
    gl.vertexAttribPointer(aB,1,gl.FLOAT,false,s,7*4 );  // ib
  }
  function unbindEdgeAttribs(prog){
    ['a_pos','a_uv','a_hlen','a_hw','a_ia','a_ib'].forEach(function(n){
      var loc=prog._a[n];if(loc!=null&&loc>=0)gl.disableVertexAttribArray(loc);
    });
  }

  function renderGlowEdges(){
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbGlowIn.fb);
    gl.viewport(0,0,GW,GH);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
    gl.useProgram(progGlow);gl.uniform2f(progGlow._u['u_res'],W,H);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufGlow);
    bindEdgeAttribs(progGlow);
    gl.drawArrays(gl.TRIANGLES,0,NEDGES*6);
    unbindEdgeAttribs(progGlow);
  }

  function renderSharpEdges(){
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
    gl.useProgram(progSharp);gl.uniform2f(progSharp._u['u_res'],W,H);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufSharp);
    bindEdgeAttribs(progSharp);
    gl.drawArrays(gl.TRIANGLES,0,NEDGES*6);
    unbindEdgeAttribs(progSharp);
  }


  /* ═══════════════════════════════════════════════════════════
     CRYSTAL BUILD + RENDER
  ═══════════════════════════════════════════════════════════ */

  function buildCrystal(){
    var shards=generateShards(W,H);
    edges=extractEdges(shards,W,H);
    NEDGES=edges.length;
    glowData =new Float32Array(NEDGES*6*GLOW_F);
    sharpData=new Float32Array(NEDGES*6*SHARP_F);
    buildFaceVBO(shards);
    if(!bufGlow) bufGlow =gl.createBuffer();
    if(!bufSharp)bufSharp=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,bufGlow);
    gl.bufferData(gl.ARRAY_BUFFER,glowData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufSharp);
    gl.bufferData(gl.ARRAY_BUFFER,sharpData.byteLength,gl.DYNAMIC_DRAW);
    bakeFaces();
    wideFrame=0;
  }

  function renderCrystal(ts){
    /* Single breathe — the whole crystal pulses as one */
    var breathe=0.62+0.38*Math.sin(ts*0.00076);
    updateLights(ts);
    updateEdgeIntensities(breathe);
    rebuildGlowVBO();
    rebuildSharpVBO();

    /* Glow seed → fbGlowIn */
    renderGlowEdges();

    /* 3-pass wide cascade every 2 frames (stride=8):
       pass 1: fbGlowIn → fbWide1  (~64 display px spread)
       pass 2: fbWide1  → fbWide2  (~110 display px)
       pass 3: fbWide2  → fbWide   (~155 display px — deep ambient fill) */
    wideFrame++;
    if(wideFrame%2===0){
      blurPass(fbGlowIn.tex,fbWide1,8.0);
      blurPass(fbWide1.tex, fbWide2,8.0);
      blurPass(fbWide2.tex, fbWide, 8.0);
    }

    /* Medium halo every frame (stride=2): tight 16 px aura */
    blurPass(fbGlowIn.tex,fbMed,2.0);

    /* Composite → screen */
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,CW,CH);
    gl.clearColor(0.027,0.027,0.035,1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    blit(fbFace.tex,'none');   // opaque dark shard faces
    blit(fbWide.tex,'add');    // wide deep violet ambient
    blit(fbMed.tex, 'add');    // tight edge halo
    renderSharpEdges();         // crisp core lines
  }


  /* ═══════════════════════════════════════════════════════════
     PARTICLES — unchanged
  ═══════════════════════════════════════════════════════════ */

  function mkParticle(dir){
    var speed=0.12+Math.random()*0.28;
    return{x:Math.random()*PW,
           y:dir===1?PH+Math.random()*PH:-(Math.random()*PH),
           vy:dir===1?-speed:speed,vx:(Math.random()-0.5)*0.08,
           r:0.8+Math.random()*1.4,alpha:0.04+Math.random()*0.18,
           life:0,maxLife:260+Math.random()*280,dir:dir};
  }
  function initParticles(){
    particles=[];
    for(var i=0;i<N_UP;i++)  particles.push(mkParticle(1));
    for(var j=0;j<N_DOWN;j++)particles.push(mkParticle(-1));
  }
  function renderParticles(ts){
    if(!pCtx)return;lastPts=ts;
    pCtx.clearRect(0,0,PW,PH);
    for(var i=0;i<particles.length;i++){
      var p=particles[i];p.x+=p.vx;p.y+=p.vy;p.life++;
      var fi=Math.min(1,p.life/40),fo=Math.min(1,(p.maxLife-p.life)/40),a=p.alpha*fi*fo;
      pCtx.beginPath();pCtx.arc(p.x,p.y,p.r,0,Math.PI*2);
      pCtx.fillStyle='rgba(200,160,255,'+a+')';pCtx.fill();
      if(!isMobile){
        pCtx.beginPath();pCtx.arc(p.x,p.y,p.r*3.2,0,Math.PI*2);
        pCtx.fillStyle='rgba(180,80,220,'+(a*0.06)+')';pCtx.fill();
      }
      var dead=p.life>=p.maxLife||(p.dir===1&&p.y<-20)||(p.dir===-1&&p.y>PH+20);
      if(dead)particles[i]=mkParticle(p.dir);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     CURSOR — unchanged
  ═══════════════════════════════════════════════════════════ */

  function initCursor(){
    if(isMobile)return;
    curEl=document.getElementById('cur');if(!curEl)return;
    mx=window.innerWidth/2;my=window.innerHeight/2;curX=mx;curY=my;
    document.addEventListener('mousemove',function(e){mx=e.clientX;my=e.clientY;},{passive:true});
    document.addEventListener('mouseover',function(e){
      if(!curEl)return;
      var interactive=!!e.target.closest(
        'button,[role="button"],a,input,select,textarea,label,.token-row,.nav-item,.seg-btn,.toggle,.tab-btn');
      var disabled=!!e.target.closest('[disabled],[aria-disabled="true"]');
      curEl.classList.toggle('hl',interactive&&!disabled);
    });
  }
  function updateCursor(){
    if(!curEl||isMobile)return;
    curX+=(mx-curX)*0.16;curY+=(my-curY)*0.16;
    if(Math.abs(curX-prevCurX)>0.3||Math.abs(curY-prevCurY)>0.3){
      curEl.style.left=curX+'px';curEl.style.top=curY+'px';
      prevCurX=curX;prevCurY=curY;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     RESIZE
  ═══════════════════════════════════════════════════════════ */

  function resize(){
    var dpr=Math.min(window.devicePixelRatio||1,2);
    W=window.innerWidth;H=window.innerHeight;
    CW=Math.round(W*dpr);CH=Math.round(H*dpr);
    GW=Math.ceil(W/2);GH=Math.ceil(H/2);
    if(_canvas){_canvas.width=CW;_canvas.height=CH;}
    fbFace  =resizeFBO(fbFace,  W,  H);
    fbGlowIn=resizeFBO(fbGlowIn,GW,GH);
    fbPing  =resizeFBO(fbPing,  GW,GH);
    fbWide1 =resizeFBO(fbWide1, GW,GH);
    fbWide2 =resizeFBO(fbWide2, GW,GH);
    fbWide  =resizeFBO(fbWide,  GW,GH);
    fbMed   =resizeFBO(fbMed,   GW,GH);
    if(pCanvas){PW=pCanvas.width=W;PH=pCanvas.height=H;initParticles();}
    buildCrystal();
  }


  /* ═══════════════════════════════════════════════════════════
     LOOP + PUBLIC API
  ═══════════════════════════════════════════════════════════ */

  function loop(ts){
    if(!running)return;
    rafId=requestAnimationFrame(loop);
    if(pageHidden)return;
    if(gl)renderCrystal(ts);
    renderParticles(ts);
    updateCursor();
  }

  function init(canvas){
    _canvas=canvas;
    gl=canvas.getContext('webgl',{alpha:false,antialias:false})
      ||canvas.getContext('experimental-webgl',{alpha:false,antialias:false});
    if(!gl){console.error('[FX] WebGL unavailable.');return;}
    progFace =makeProgram(VS_FACE, FS_FACE);
    progGlow =makeProgram(VS_EDGE, FS_GLOW);
    progSharp=makeProgram(VS_EDGE, FS_SHARP);
    progBlur =makeProgram(VS_QUAD, FS_BLUR);
    progBlit =makeProgram(VS_QUAD, FS_BLIT);
    bufQuad=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,bufQuad);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    pCanvas=document.getElementById('particle-canvas');
    if(pCanvas)pCtx=pCanvas.getContext('2d');
    initCursor();
    var rt=null;
    window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(resize,200);},{passive:true});
    resize();
  }
  function start(){if(running)return;running=true;rafId=requestAnimationFrame(loop);}
  function stop(){running=false;if(rafId){cancelAnimationFrame(rafId);rafId=null;}}

  return{init:init,start:start,stop:stop};
})();