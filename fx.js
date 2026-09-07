/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — fx.js  ·  WebGL engine  ·  v4
   ─────────────────────────────────────────────────────────────────
   The structural fix.

   Previous versions composited the glow ON TOP of the face layer
   additively.  Face dark + glow line on top = glowing line.  That
   is never going to look like light through cracks regardless of
   how much you tune the blur parameters.

   This version makes the face surfaces RECEIVE the light from the
   cracks.  The pipeline:

     1.  Render crack seeds (edge quads) → fbGlowIn
     2.  3-pass wide Gaussian cascade → fbWide  (the "light pool")
         This spreads the crack light deep into the face areas.
         Cached every 2 frames.
     3.  Render shard faces, sampling fbWide at each fragment's
         world position → fbLitFaces
         Face fragment = base_dark_color + light_pool_sample * k
         A face pixel near a hot crack: illuminated violet
         A face pixel at the center of a large shard: black
     4.  Tight blur → fbMed  (bright seam at crack edge)
     5.  Composite:
           fbLitFaces  (faces lit from below — opaque)
         + fbMed       (tight crack seam, additive)
         + sharp SDF   (crystalline crack outline, additive)

   The breathe scalar multiplies ALL edge intensities uniformly —
   the whole scene inhales and exhales as one crystal.

   Per-endpoint intensities (_Ia, _Ib) make the glow vary along
   each crack — brighter where the light source is nearest, dim
   at the far end.  As lights orbit, the bright zone travels.

   Color: violet rgb(156,61,187) throughout.
   BSP seed: 0xC2E9A3F7 — same shard layout, always.
═══════════════════════════════════════════════════════════════════ */

window.FX = (function () {
  'use strict';

  var isMobile = window.matchMedia('(hover:none) and (pointer:coarse)').matches;

  /* ── GL ──────────────────────────────────────────────────── */
  var _canvas=null, gl=null;
  var W=0,H=0,CW=0,CH=0,GW=0,GH=0;

  /* ── Programs ────────────────────────────────────────────── */
  var progFace =null;  // shard face geometry, samples light pool
  var progGlow =null;  // edge quads → glow seed (Gaussian profile)
  var progSharp=null;  // SDF crack lines → screen
  var progBlur =null;  // separable Gaussian, stride uniform
  var progBlit =null;  // texture → fullscreen quad

  /* ── FBOs  { fb, tex, w, h } ─────────────────────────────── */
  var fbGlowIn =null;  // crack seed texture           (GW×GH)
  var fbPing   =null;  // blur scratch                 (GW×GH)
  var fbWide1  =null;  // 1st wide pass result         (GW×GH)
  var fbWide2  =null;  // 2nd wide pass result         (GW×GH)
  var fbWide   =null;  // 3rd wide pass = light pool   (GW×GH, cached)
  var fbMed    =null;  // tight crack seam             (GW×GH)
  var fbLitFaces=null; // shard faces lit from below   (W×H, dynamic)

  /* ── Buffers ─────────────────────────────────────────────── */
  var bufFace=null,bufGlow=null,bufSharp=null,bufQuad=null;

  /* Vertex layouts:
     Face  [x, y, r, g, b]                     = 5 floats
     Edge  [x, y, lu, lv, hlen, hw, ia, ib]   = 8 floats (glow+sharp) */
  var FACE_F=5, EDGE_F=8;
  var faceVerts=0, NEDGES=0;
  var glowData=null, sharpData=null;

  /* ── Geometry state ──────────────────────────────────────── */
  var edges=[];

  /* ── Lights ──────────────────────────────────────────────── */
  var L1={x:0,y:0,I:1.00,r:0};
  var L2={x:0,y:0,I:0.58,r:0};

  /* ── Particles ───────────────────────────────────────────── */
  var pCanvas=null,pCtx=null,PW=0,PH=0,particles=[],lastPts=0;
  var N_UP=40,N_DOWN=40;

  /* ── Cursor ──────────────────────────────────────────────── */
  var curEl=null,mx=0,my=0,curX=0,curY=0,prevCurX=-999,prevCurY=-999;

  /* ── Loop ────────────────────────────────────────────────── */
  var rafId=null,running=false,pageHidden=false,wideFrame=0;

  document.addEventListener('visibilitychange',function(){pageHidden=document.hidden;});


  /* ═══════════════════════════════════════════════════════════
     MATH
  ═══════════════════════════════════════════════════════════ */
  function mkRng(s){
    return function(){
      s|=0;s=s+0x6D2B79F5|0;
      var t=Math.imul(s^s>>>15,1|s);
      t=t+Math.imul(t^t>>>7,61|t)^t;
      return((t^t>>>14)>>>0)/4294967296;
    };
  }
  function cross(p1,p2,pt){return(p2.x-p1.x)*(pt.y-p1.y)-(p2.y-p1.y)*(pt.x-p1.x);}
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
  function polyArea(p){var a=0;for(var i=0;i<p.length;i++){var j=(i+1)%p.length;a+=p[i].x*p[j].y-p[j].x*p[i].y;}return Math.abs(a)*0.5;}
  function centroid(p){return{x:p.reduce(function(s,v){return s+v.x;},0)/p.length,y:p.reduce(function(s,v){return s+v.y;},0)/p.length};}

  function generateShards(pw,ph){
    var rng=mkRng(0xC2E9A3F7);
    var polys=[[{x:0,y:0},{x:pw,y:0},{x:pw,y:ph},{x:0,y:ph}]];
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
     SHADERS
  ═══════════════════════════════════════════════════════════ */

  /* Fullscreen quad */
  var VS_QUAD=[
    'attribute vec2 a_pos;varying vec2 v_uv;',
    'void main(){v_uv=(a_pos+1.0)*0.5;gl_Position=vec4(a_pos,0.0,1.0);}'
  ].join('\n');

  /* ── Face vertex: passes world position for light pool sample ── */
  var VS_FACE=[
    'attribute vec2 a_pos;','attribute vec3 a_col;','uniform vec2 u_res;',
    'varying vec3 v_col;','varying vec2 v_wpos;',
    'void main(){',
    '  vec2 clip=(a_pos/u_res)*2.0-1.0;',
    '  gl_Position=vec4(clip.x,-clip.y,0.0,1.0);',
    '  v_col=a_col;',
    '  v_wpos=a_pos;',  // world position in logical px — needed for pool UV
    '}'
  ].join('\n');

  /* ── Face fragment: the key shader ──────────────────────────────
     The light pool (fbWide) holds the violet glow that has spread
     from every active crack across the face areas.  We sample it
     here and add the light contribution to the face's base color.

     A face pixel near a hot crack:  base_dark + bright_violet_pool
     A face pixel at shard interior: base_dark + ~0               

     Pool UV derivation:
       The pool was rendered with clip.y = -(pos.y/H)*2+1.
       Texture (0,0) = framebuffer row 0 = clip(-1,-1) = pos(0,H).
       So for world pos (px,py):
         poolUV.x = px/W          (same direction)
         poolUV.y = 1 - py/H      (Y inverted: CSS y↓, GL tex y↑)     */
  var FS_FACE=[
    'precision mediump float;',
    'uniform sampler2D u_lightPool;','uniform vec2 u_res;',
    'varying vec3 v_col;','varying vec2 v_wpos;',
    'void main(){',
    '  vec2 poolUV = vec2(v_wpos.x/u_res.x, 1.0-v_wpos.y/u_res.y);',
    '  vec3 pool   = texture2D(u_lightPool, poolUV).rgb;',
    '  // Face absorbs the light from below — brighter near cracks',
    '  vec3 lit = v_col + pool * 3.2;',
    '  gl_FragColor = vec4(min(vec3(1.0), lit), 1.0);',
    '}'
  ].join('\n');

  /* ── Shared edge vertex (glow + sharp) ──────────────────────── */
  var VS_EDGE=[
    'attribute vec2  a_pos;',
    'attribute vec2  a_uv;',    // local: u along edge, v perp (logical px)
    'attribute float a_hlen;',  // half-length
    'attribute float a_hw;',    // glow: Gaussian radius  |  sharp: SDF width
    'attribute float a_ia;',    // intensity at p0
    'attribute float a_ib;',    // intensity at p1
    'uniform vec2 u_res;',
    'varying vec2  v_uv;','varying float v_hlen,v_hw,v_ia,v_ib;',
    'void main(){',
    '  vec2 c=(a_pos/u_res)*2.0-1.0;',
    '  gl_Position=vec4(c.x,-c.y,0.0,1.0);',
    '  v_uv=a_uv;v_hlen=a_hlen;v_hw=a_hw;v_ia=a_ia;v_ib=a_ib;',
    '}'
  ].join('\n');

  /* ── Glow fragment: Gaussian oval from capsule centerline ────────
     exp(-3d²/hw²) — smooth oval, no edges, no box artifact.
     mix(ia,ib,u) — intensity varies end to end: the pulse.        */
  var FS_GLOW=[
    'precision mediump float;',
    'varying vec2  v_uv;','varying float v_hlen,v_hw,v_ia,v_ib;',
    'void main(){',
    '  float cx  = clamp(v_uv.x,-v_hlen,v_hlen);',
    '  float d   = length(vec2(v_uv.x-cx,v_uv.y));',
    '  float glow= exp(-3.0*d*d/(v_hw*v_hw+0.1));',
    '  float u   = clamp((v_uv.x+v_hlen)/(2.0*v_hlen+0.001),0.0,1.0);',
    '  float I   = mix(v_ia,v_ib,u);',
    '  float a   = min(1.0, I*I*1.8*glow);',
    '  gl_FragColor=vec4(0.612*a,0.239*a,0.733*a,a);',  // violet premult
    '}'
  ].join('\n');

  /* ── Sharp fragment: SDF capsule, same per-endpoint intensity ─── */
  var FS_SHARP=[
    'precision mediump float;',
    'varying vec2  v_uv;','varying float v_hlen,v_hw,v_ia,v_ib;',
    'void main(){',
    '  float cx = clamp(v_uv.x,-v_hlen,v_hlen);',
    '  float d  = length(vec2(v_uv.x-cx,v_uv.y));',
    '  float a  = smoothstep(v_hw+0.5,v_hw-0.5,d);',
    '  float u  = clamp((v_uv.x+v_hlen)/(2.0*v_hlen+0.001),0.0,1.0);',
    '  float I  = mix(v_ia,v_ib,u);',
    '  a *= min(0.95,I*1.1);',
    '  gl_FragColor=vec4(0.612*a,0.239*a,0.733*a,a);',
    '}'
  ].join('\n');

  /* ── Gaussian blur, stride uniform ─────────────────────────────
     9-tap, σ=4 in stride units.
     stride=8 → ±32 glow texels per pass, ~64 display px.
     3 cascaded passes → ~155 display px spread into face areas.
     stride=2 → ±8 glow texels, tight 16 px seam halo.           */
  var FS_BLUR=[
    'precision mediump float;',
    'uniform sampler2D u_tex;','uniform vec2 u_texel,u_dir;','uniform float u_stride;',
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
    var sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);
    if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))
      throw new Error('[FX] shader:\n'+gl.getShaderInfoLog(sh));
    return sh;
  }
  function makeProgram(vs,fs){
    var p=gl.createProgram();
    gl.attachShader(p,compileShader(gl.VERTEX_SHADER,vs));
    gl.attachShader(p,compileShader(gl.FRAGMENT_SHADER,fs));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error('[FX] link:\n'+gl.getProgramInfoLog(p));
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
    var tw=1/GW,th=1/GH;
    gl.disable(gl.BLEND);gl.useProgram(progBlur);
    gl.uniform1f(progBlur._u['u_stride'],stride);
    gl.uniform2f(progBlur._u['u_texel'],tw,th);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufQuad);
    var ap=progBlur._a['a_pos'];
    gl.enableVertexAttribArray(ap);gl.vertexAttribPointer(ap,2,gl.FLOAT,false,0,0);
    /* H */ gl.bindFramebuffer(gl.FRAMEBUFFER,fbPing.fb);gl.viewport(0,0,GW,GH);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,srcTex);
    gl.uniform1i(progBlur._u['u_tex'],0);gl.uniform2f(progBlur._u['u_dir'],1,0);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    /* V */ gl.bindFramebuffer(gl.FRAMEBUFFER,dst.fb);gl.viewport(0,0,GW,GH);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D,fbPing.tex);gl.uniform2f(progBlur._u['u_dir'],0,1);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    gl.disableVertexAttribArray(ap);gl.bindTexture(gl.TEXTURE_2D,null);
  }


  /* ═══════════════════════════════════════════════════════════
     FACE GEOMETRY (static VBO, dynamic render)
  ═══════════════════════════════════════════════════════════ */

  function buildFaceVBO(shards){
    var ALX=Math.cos(Math.PI*0.28),ALY=Math.sin(Math.PI*0.28);
    var midX=W*0.5,midY=H*0.5,data=[];
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

  /* Render shard faces into fbLitFaces, sampling the light pool.
     Called every frame.  The face VBO is static; only the light
     pool texture changes (captured as uniform u_lightPool).      */
  function renderLitFaces(){
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbLitFaces.fb);
    gl.viewport(0,0,fbLitFaces.w,fbLitFaces.h);
    gl.clearColor(0.027,0.027,0.035,1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    gl.useProgram(progFace);
    gl.uniform2f(progFace._u['u_res'],W,H);

    /* Bind the light pool (fbWide) as texture unit 0 */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,fbWide.tex);
    gl.uniform1i(progFace._u['u_lightPool'],0);

    gl.bindBuffer(gl.ARRAY_BUFFER,bufFace);
    var s=FACE_F*4;
    var aP=progFace._a['a_pos'],aC=progFace._a['a_col'];
    gl.enableVertexAttribArray(aP);gl.enableVertexAttribArray(aC);
    gl.vertexAttribPointer(aP,2,gl.FLOAT,false,s,0);
    gl.vertexAttribPointer(aC,3,gl.FLOAT,false,s,2*4);
    gl.drawArrays(gl.TRIANGLES,0,faceVerts);
    gl.disableVertexAttribArray(aP);gl.disableVertexAttribArray(aC);
    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }


  /* ═══════════════════════════════════════════════════════════
     LIGHTS + EDGE INTENSITY
  ═══════════════════════════════════════════════════════════ */

  function updateLights(t){
    var D=Math.min(W,H),a1=t*0.0000552,a2=t*0.0000769+2.14;
    L1.x=W*0.5+Math.cos(a1)*W*0.28+Math.cos(a1*1.68)*W*0.07;
    L1.y=H*0.5+Math.sin(a1)*H*0.22+Math.sin(a1*1.38)*H*0.06;L1.r=D*0.52;
    L2.x=W*0.5+Math.cos(a2)*W*0.20+Math.cos(a2*2.25)*W*0.05;
    L2.y=H*0.5+Math.sin(a2)*H*0.16+Math.sin(a2*1.91)*H*0.04;L2.r=D*0.36;
  }

  /* Raw light intensity at any point from both light sources. */
  function ptI(x,y){
    var I=0,dx,dy,p;
    dx=x-L1.x;dy=y-L1.y;p=Math.max(0,1-Math.sqrt(dx*dx+dy*dy)/L1.r);I+=p*p*L1.I;
    dx=x-L2.x;dy=y-L2.y;p=Math.max(0,1-Math.sqrt(dx*dx+dy*dy)/L2.r);I+=p*p*L2.I;
    return I;
  }

  function updateEdgeIntensities(breathe){
    for(var ei=0;ei<NEDGES;ei++){
      var e=edges[ei];
      e._Ia=Math.min(1,ptI(e.x1,e.y1)*breathe);
      e._Ib=Math.min(1,ptI(e.x2,e.y2)*breathe);
      e._I =Math.max(e._Ia,e._Ib);
    }
  }


  /* ═══════════════════════════════════════════════════════════
     EDGE VBO REBUILD
     [x, y, lu, lv, hlen, hw, ia, ib]  =  8 floats per vertex
     6 vertices per edge  =  48 floats per edge
  ═══════════════════════════════════════════════════════════ */

  function pushEdgeQuad(arr,off, x1,y1,x2,y2, hw,ia,ib){
    var dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy);
    if(len<1)return off+48;
    var nx=dx/len,ny=dy/len,px=-ny,py=nx;
    var hl=len*0.5,hwG=hw+0.5;
    var wpx=px*hwG,wpy=py*hwG,ecx=nx*hwG,ecy=ny*hwG;
    var ax=x1-ecx-wpx,ay=y1-ecy-wpy;
    var bx=x1-ecx+wpx,by=y1-ecy+wpy;
    var cx=x2+ecx-wpx,cy=y2+ecy-wpy;
    var qx=x2+ecx+wpx,qy=y2+ecy+wpy;
    var u0=-(hl+hwG),u1=+(hl+hwG);
    /* tri0: a,b,c  tri1: b,q,c */
    arr[off++]=ax;arr[off++]=ay;arr[off++]=u0;arr[off++]=-hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=bx;arr[off++]=by;arr[off++]=u0;arr[off++]=+hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=cx;arr[off++]=cy;arr[off++]=u1;arr[off++]=-hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=bx;arr[off++]=by;arr[off++]=u0;arr[off++]=+hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=qx;arr[off++]=qy;arr[off++]=u1;arr[off++]=+hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    arr[off++]=cx;arr[off++]=cy;arr[off++]=u1;arr[off++]=-hwG;arr[off++]=hl;arr[off++]=hw;arr[off++]=ia;arr[off++]=ib;
    return off;
  }

  function rebuildGlowVBO(){
    var d=glowData,off=0;
    for(var ei=0;ei<NEDGES;ei++){
      var e=edges[ei];
      if(e._I<0.04){off+=48;continue;}
      var hw=3.0+Math.max(e._Ia,e._Ib)*10.0;  // wide Gaussian radius
      off=pushEdgeQuad(d,off,e.x1,e.y1,e.x2,e.y2,hw,e._Ia,e._Ib);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,bufGlow);gl.bufferSubData(gl.ARRAY_BUFFER,0,glowData);
  }

  function rebuildSharpVBO(){
    var d=sharpData,off=0;
    for(var ei=0;ei<NEDGES;ei++){
      var e=edges[ei];
      if(e._I<0.04){off+=48;continue;}
      var hw=Math.max(0.50,0.35+Math.max(e._Ia,e._Ib)*0.55);
      off=pushEdgeQuad(d,off,e.x1,e.y1,e.x2,e.y2,hw,e._Ia,e._Ib);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,bufSharp);gl.bufferSubData(gl.ARRAY_BUFFER,0,sharpData);
  }


  /* ═══════════════════════════════════════════════════════════
     EDGE DRAW CALLS (shared attribute binding)
  ═══════════════════════════════════════════════════════════ */

  function bindEdge(prog,buf){
    gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    var s=EDGE_F*4;
    function en(n,size,off){
      var loc=prog._a[n];if(loc==null||loc<0)return;
      gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,s,off);
    }
    en('a_pos', 2, 0);
    en('a_uv',  2, 2*4);
    en('a_hlen',1, 4*4);
    en('a_hw',  1, 5*4);
    en('a_ia',  1, 6*4);
    en('a_ib',  1, 7*4);
  }
  function unbindEdge(prog){
    ['a_pos','a_uv','a_hlen','a_hw','a_ia','a_ib'].forEach(function(n){
      var l=prog._a[n];if(l!=null&&l>=0)gl.disableVertexAttribArray(l);
    });
  }

  function renderGlowEdges(){
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbGlowIn.fb);
    gl.viewport(0,0,GW,GH);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
    gl.useProgram(progGlow);gl.uniform2f(progGlow._u['u_res'],W,H);
    bindEdge(progGlow,bufGlow);
    gl.drawArrays(gl.TRIANGLES,0,NEDGES*6);
    unbindEdge(progGlow);
  }

  function renderSharpEdges(){
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
    gl.useProgram(progSharp);gl.uniform2f(progSharp._u['u_res'],W,H);
    bindEdge(progSharp,bufSharp);
    gl.drawArrays(gl.TRIANGLES,0,NEDGES*6);
    unbindEdge(progSharp);
  }


  /* ═══════════════════════════════════════════════════════════
     CRYSTAL BUILD + RENDER
  ═══════════════════════════════════════════════════════════ */

  function buildCrystal(){
    var shards=generateShards(W,H);
    edges=extractEdges(shards,W,H);NEDGES=edges.length;
    glowData =new Float32Array(NEDGES*6*EDGE_F);
    sharpData=new Float32Array(NEDGES*6*EDGE_F);
    buildFaceVBO(shards);
    if(!bufGlow) bufGlow =gl.createBuffer();
    if(!bufSharp)bufSharp=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,bufGlow);
    gl.bufferData(gl.ARRAY_BUFFER,glowData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufSharp);
    gl.bufferData(gl.ARRAY_BUFFER,sharpData.byteLength,gl.DYNAMIC_DRAW);
    wideFrame=0;
  }

  function renderCrystal(ts){
    var breathe=0.62+0.38*Math.sin(ts*0.00076);
    updateLights(ts);
    updateEdgeIntensities(breathe);
    rebuildGlowVBO();
    rebuildSharpVBO();

    /* 1. Crack seeds → fbGlowIn */
    renderGlowEdges();

    /* 2. 3-pass wide cascade → fbWide (the light pool).
          Cached every 2 frames — the light moves slowly.
          After 3 passes at stride=8: ~155 display px spread.
          This is what the face shader samples to get illuminated. */
    wideFrame++;
    if(wideFrame%2===0){
      blurPass(fbGlowIn.tex,fbWide1,8.0);
      blurPass(fbWide1.tex, fbWide2,8.0);
      blurPass(fbWide2.tex, fbWide, 8.0);
    }

    /* 3. Tight seam halo → fbMed  (every frame) */
    blurPass(fbGlowIn.tex,fbMed,2.0);

    /* 4. Lit face render: shard triangles sample fbWide → fbLitFaces.
          This is where the "light beneath" effect happens.
          The face fragment adds pool.rgb * 3.2 to the base dark color.
          Pixels adjacent to hot cracks become violet.
          Pixels at shard centers stay black.                         */
    renderLitFaces();

    /* 5. Composite → screen */
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,CW,CH);
    gl.clearColor(0.027,0.027,0.035,1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    blit(fbLitFaces.tex,'none');  // illuminated faces — the crystal body
    blit(fbMed.tex,     'add');   // bright seam at each crack
    renderSharpEdges();            // crystalline crack outline
  }


  /* ═══════════════════════════════════════════════════════════
     PARTICLES
  ═══════════════════════════════════════════════════════════ */

  function mkParticle(dir){
    var s=0.12+Math.random()*0.28;
    return{x:Math.random()*PW,y:dir===1?PH+Math.random()*PH:-(Math.random()*PH),
           vy:dir===1?-s:s,vx:(Math.random()-0.5)*0.08,r:0.8+Math.random()*1.4,
           alpha:0.04+Math.random()*0.18,life:0,maxLife:260+Math.random()*280,dir:dir};
  }
  function initParticles(){
    particles=[];
    for(var i=0;i<N_UP;i++)  particles.push(mkParticle(1));
    for(var j=0;j<N_DOWN;j++)particles.push(mkParticle(-1));
  }
  function renderParticles(ts){
    if(!pCtx)return;lastPts=ts;pCtx.clearRect(0,0,PW,PH);
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
     CURSOR
  ═══════════════════════════════════════════════════════════ */

  function initCursor(){
    if(isMobile)return;curEl=document.getElementById('cur');if(!curEl)return;
    mx=window.innerWidth/2;my=window.innerHeight/2;curX=mx;curY=my;
    document.addEventListener('mousemove',function(e){mx=e.clientX;my=e.clientY;},{passive:true});
    document.addEventListener('mouseover',function(e){
      if(!curEl)return;
      var ok=!!e.target.closest('button,[role="button"],a,input,select,textarea,label,.token-row,.nav-item,.seg-btn,.toggle,.tab-btn');
      var dis=!!e.target.closest('[disabled],[aria-disabled="true"]');
      curEl.classList.toggle('hl',ok&&!dis);
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
    fbGlowIn =resizeFBO(fbGlowIn, GW,GH);
    fbPing   =resizeFBO(fbPing,   GW,GH);
    fbWide1  =resizeFBO(fbWide1,  GW,GH);
    fbWide2  =resizeFBO(fbWide2,  GW,GH);
    fbWide   =resizeFBO(fbWide,   GW,GH);
    fbMed    =resizeFBO(fbMed,    GW,GH);
    fbLitFaces=resizeFBO(fbLitFaces,W,H);  // logical res — faces are soft
    if(pCanvas){PW=pCanvas.width=W;PH=pCanvas.height=H;initParticles();}
    buildCrystal();
  }


  /* ═══════════════════════════════════════════════════════════
     LOOP + API
  ═══════════════════════════════════════════════════════════ */

  function loop(ts){
    if(!running)return;rafId=requestAnimationFrame(loop);
    if(pageHidden)return;
    if(gl)renderCrystal(ts);
    renderParticles(ts);updateCursor();
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
