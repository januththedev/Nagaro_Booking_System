/**
 * TRACE public experience layer.
 *
 * Everything in this file is optional enhancement: the underlying photograph,
 * links and booking forms remain the complete experience when WebGL or motion
 * is unavailable.
 */

var root = document.querySelector('[data-experience-root]');

function shouldReduceEffects() {
  var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return !root
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || Boolean(connection && connection.saveData)
    || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4)
    || (navigator.deviceMemory && navigator.deviceMemory < 4);
}

function compile(gl, type, source) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl) {
  var vertex = compile(gl, gl.VERTEX_SHADER, [
    'attribute vec2 a_position;',
    'varying vec2 v_uv;',
    'void main(){',
    '  v_uv = (a_position + 1.0) * 0.5;',
    '  gl_Position = vec4(a_position, 0.0, 1.0);',
    '}',
  ].join('\n'));
  var fragment = compile(gl, gl.FRAGMENT_SHADER, [
    'precision mediump float;',
    'uniform sampler2D u_image;',
    'uniform vec2 u_pointer;',
    'uniform float u_time;',
    'uniform float u_aspect;',
    'varying vec2 v_uv;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }',
    'void main(){',
    '  vec2 uv = v_uv;',
    '  vec2 centred = uv - 0.5;',
    '  centred.x *= u_aspect;',
    '  float falloff = 1.0 - smoothstep(0.05, 0.72, length(centred));',
    '  vec2 drift = (u_pointer - 0.5) * 0.018 * falloff;',
    '  drift += vec2(sin(u_time * 0.32 + uv.y * 5.0), cos(u_time * 0.27 + uv.x * 4.0)) * 0.0017;',
    '  vec4 colour = texture2D(u_image, clamp(uv + drift, 0.003, 0.997));',
    '  float vignette = smoothstep(0.96, 0.22, length(centred));',
    '  float grain = (hash(gl_FragCoord.xy + floor(u_time * 12.0)) - 0.5) * 0.035;',
    '  colour.rgb = colour.rgb * (0.78 + vignette * 0.25) + grain;',
    '  gl_FragColor = vec4(colour.rgb, 1.0);',
    '}',
  ].join('\n'));
  if (!vertex || !fragment) return null;
  var program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  return program;
}

function initWebglStage(stage) {
  var canvas = stage.querySelector('[data-webgl-ambient]');
  var image = stage.querySelector('[data-webgl-source]');
  if (!canvas || !image || shouldReduceEffects()) return;

  var gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: 'low-power',
  });
  if (!gl) return;
  var program = createProgram(gl);
  if (!program) return;

  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.useProgram(program);
  var position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  var texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  var pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  var visible = true;
  var frame = 0;
  var started = performance.now();
  var timeLocation = gl.getUniformLocation(program, 'u_time');
  var pointerLocation = gl.getUniformLocation(program, 'u_pointer');
  var aspectLocation = gl.getUniformLocation(program, 'u_aspect');

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var width = Math.max(1, Math.round(rect.width * dpr));
    var height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function draw(now) {
    frame = 0;
    if (!visible || document.hidden) return;
    resize();
    pointer.x += (pointer.tx - pointer.x) * 0.055;
    pointer.y += (pointer.ty - pointer.y) * 0.055;
    gl.uniform1f(timeLocation, (now - started) / 1000);
    gl.uniform2f(pointerLocation, pointer.x, pointer.y);
    gl.uniform1f(aspectLocation, canvas.width / Math.max(1, canvas.height));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    frame = window.requestAnimationFrame(draw);
  }

  function start() {
    if (!frame && visible && !document.hidden) frame = window.requestAnimationFrame(draw);
  }

  function upload() {
    try {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      canvas.classList.add('is-ready');
      start();
    } catch (_) {
      canvas.classList.remove('is-ready');
    }
  }

  stage.addEventListener('pointermove', function (event) {
    var rect = stage.getBoundingClientRect();
    pointer.tx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    pointer.ty = Math.max(0, Math.min(1, 1 - ((event.clientY - rect.top) / rect.height)));
    stage.style.setProperty('--pointer-x', ((pointer.tx - 0.5) * 2).toFixed(3));
    stage.style.setProperty('--pointer-y', (((1 - pointer.ty) - 0.5) * 2).toFixed(3));
  }, { passive: true });
  stage.addEventListener('pointerleave', function () {
    pointer.tx = 0.5;
    pointer.ty = 0.5;
    stage.style.setProperty('--pointer-x', '0');
    stage.style.setProperty('--pointer-y', '0');
  }, { passive: true });

  var observer = new IntersectionObserver(function (entries) {
    visible = entries[0] && entries[0].isIntersecting;
    if (visible) start();
    else if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
  }, { rootMargin: '120px' });
  observer.observe(stage);

  document.addEventListener('visibilitychange', start);
  canvas.addEventListener('webglcontextlost', function (event) {
    event.preventDefault();
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    canvas.classList.remove('is-ready');
  });

  if (image.complete && image.naturalWidth) upload();
  else image.addEventListener('load', upload, { once: true });
}

function initExperience() {
  if (!root) return;
  var stage = root.querySelector('[data-tilt-stage]');
  if (stage) initWebglStage(stage);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initExperience);
else initExperience();

