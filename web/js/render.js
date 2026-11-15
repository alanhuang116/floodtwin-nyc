// Render pipeline.
//   1. planar reflection of the city in the river (mirror camera, clipped at the water level)
//   2. opaque scene into a half-float target with a depth texture (sun shadows refreshed here)
//   3. copies: scene colour at half resolution and linear view depth, read by the water shader
//   4. water, its cut face and flow tracers, depth-tested against the opaque scene
//   5. bloom, then a composite with tone mapping, FXAA, screen-space rain, grading and dither
// Layers: 0 reflected scenery, 1 water, 2 small scenery (trees, vehicles), 3 markers.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { Sky } from './scene/sky.js';

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COPY = /* glsl */`
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }`;

const DEPTH = /* glsl */`
#include <packing>
uniform sampler2D tDepth;
uniform float uNear, uFar;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).r;
  gl_FragColor = vec4(-perspectiveDepthToViewZ(d, uNear, uFar), 0.0, 0.0, 1.0);
}`;

// Ambient obscurance at half resolution from the linear depth copy (Alchemy-style): for a
// spiral of samples around each pixel, geometry above the surface's tangent plane darkens it.
// The world radius grows with distance, so streets read the same from 100 m and from 10 km.
const AO = /* glsl */`
uniform sampler2D tDepth;
uniform vec2 uTexel, uTan;
uniform float uProj, uFar, uStrength;
varying vec2 vUv;
vec3 viewPos(vec2 uv) { float z = texture2D(tDepth, uv).r; return vec3((uv * 2.0 - 1.0) * uTan * z, -z); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float z = texture2D(tDepth, vUv).r;
  if (z <= 0.0 || z > 30000.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 Pr = viewPos(vUv + vec2(uTexel.x, 0.0)), Pl = viewPos(vUv - vec2(uTexel.x, 0.0));
  vec3 Pu = viewPos(vUv + vec2(0.0, uTexel.y)), Pd = viewPos(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  float R = clamp(z * 0.03, 1.5, 60.0);
  float rPix = min(R * uProj / z, 110.0);
  float ang = ign(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0;
  for (int i = 0; i < 12; i++) {
    float t = (float(i) + 0.5) / 12.0;
    float a = ang + float(i) * 2.3999632;
    vec2 off = vec2(cos(a), sin(a)) * sqrt(t) * rPix * uTexel;
    vec3 v = viewPos(vUv + off) - P;
    float d2 = dot(v, v);
    float fall = 1.0 - smoothstep(0.64 * R * R, 1.44 * R * R, d2);
    occ += max(0.0, dot(v, N) - 0.012 * R) * R / (d2 + 0.02 * R * R) * fall;
  }
  float ao = clamp(1.0 - uStrength * occ / 12.0, 0.0, 1.0);
  gl_FragColor = vec4(vec3(ao * ao), 1.0);
}`;

// Depth-aware blur of the obscurance (one axis per pass)
const AO_BLUR = /* glsl */`
uniform sampler2D tSrc, tDepth;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  float z0 = texture2D(tDepth, vUv).r;
  float sum = 0.0, wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uDir * float(i);
    float z = texture2D(tDepth, uv).r;
    float w = exp(-float(i * i) / 8.0) * exp(-abs(z - z0) / max(0.02 * z0, 0.05));
    sum += texture2D(tSrc, uv).r * w; wsum += w;
  }
  gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
}`;

// Multiplies the obscurance into the opaque scene (blended as destination times source),
// fading it out with distance so far haze stays clean
const AO_APPLY = /* glsl */`
uniform sampler2D tAO, tDepth;
varying vec2 vUv;
void main() {
  float z = texture2D(tDepth, vUv).r;
  float ao = texture2D(tAO, vUv).r;
  float k = 1.0 - smoothstep(9000.0, 26000.0, z);
  gl_FragColor = vec4(vec3(mix(1.0, ao, k)), 1.0);
}`;

const BRIGHT = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = clamp(l - uThreshold, 0.0, 4.0 * uThreshold);
  k = k * k / (4.0 * uThreshold + 1e-4);
  gl_FragColor = vec4(min(c * max(k, l - uThreshold) / max(l, 1e-4), vec3(30.0)), 1.0);
}`;

const BLUR = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
  c += (texture2D(tSrc, vUv + uDir * 1.3846154).rgb + texture2D(tSrc, vUv - uDir * 1.3846154).rgb) * 0.3162162;
  c += (texture2D(tSrc, vUv + uDir * 3.2307692).rgb + texture2D(tSrc, vUv - uDir * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = /* glsl */`
uniform sampler2D tScene, tBloomA, tBloomB;
uniform vec2 uTexel, uAspect, uRainOffset;
uniform float uExposure, uBloom, uRain, uTime, uSat, uContrast, uVignette, uRainFacing, uDay, uFxaa;
varying vec2 vUv;
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  return clamp(outM * rrtOdt(inM * c), 0.0, 1.0);
}
vec3 hdr(vec2 uv) { return texture2D(tScene, uv).rgb + (texture2D(tBloomA, uv).rgb * 0.65 + texture2D(tBloomB, uv).rgb * 0.35) * uBloom; }
vec3 L(vec2 uv) { return aces(hdr(uv) * uExposure); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 fxaa(vec2 uv) {
  vec3 rgbNW = L(uv + vec2(-1.0, -1.0) * uTexel), rgbNE = L(uv + vec2(1.0, -1.0) * uTexel);
  vec3 rgbSW = L(uv + vec2(-1.0, 1.0) * uTexel), rgbSE = L(uv + vec2(1.0, 1.0) * uTexel);
  vec3 rgbM = L(uv);
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (L(uv + dir * (1.0 / 3.0 - 0.5)) + L(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (L(uv - dir * 0.5) + L(uv + dir * 0.5));
  float lb = luma(b);
  return (lb < lMin || lb > lMax) ? a : b;
}
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float rainLayer(vec2 uv, float scale, float speed, float density, float t) {
  vec2 p = uv * vec2(scale, scale * 0.09);
  p.x += p.y * 0.18;
  p.y += t * speed;
  float col = floor(p.x);
  float off = h11(col * 1.7);
  p.y += off * 37.0;
  float row = floor(p.y);
  float r = h11(col * 13.1 + row * 7.3);
  vec2 f = fract(p);
  float x = abs(f.x - (0.2 + 0.6 * h11(col + row * 3.1)));
  float s = smoothstep(0.06, 0.0, x) * smoothstep(0.0, 0.35, f.y) * smoothstep(1.0, 0.55, f.y);
  return s * step(1.0 - density, r);
}
void main() {
  vec3 c = uFxaa > 0.5 ? fxaa(vUv) : L(vUv);
  float l = luma(c);
  c = mix(vec3(l), c, uSat);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
  c *= mix(vec3(0.985, 0.995, 1.015), vec3(1.025, 1.0, 0.965), smoothstep(0.12, 0.85, luma(c)));
  if (uRain > 0.001) {
    vec2 ruv = vUv * uAspect + uRainOffset;
    float r = rainLayer(ruv, 90.0, 9.0, 0.30, uTime) * 0.55 + rainLayer(ruv + 0.37, 55.0, 6.5, 0.26, uTime) * 0.75
            + rainLayer(ruv + 0.71, 30.0, 4.2, 0.20, uTime) * 0.9;
    c += vec3(0.62, 0.66, 0.70) * r * uRain * uRainFacing * (0.10 + 0.16 * uDay);
    c = mix(c, vec3(luma(c)) * vec3(0.94, 0.97, 1.0), 0.12 * uRain);
  }
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 1.6;
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

// ratio: the highest device pixel ratio rendered; the frame-time governor scales below it
export const QUALITY = {
  high: { ratio: 1.5, shadow: 4096, refl: 0.5, bloom: true, fxaa: true, minScale: 0.7, ao: true },
  balanced: { ratio: 1.15, shadow: 2048, refl: 0.33, bloom: true, fxaa: true, minScale: 0.62, ao: true },
  performance: { ratio: 1.0, shadow: 1024, refl: 0, bloom: false, fxaa: true, minScale: 0.55, ao: false },
};

class FullScreen {
  constructor(renderer) {
    this.renderer = renderer;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(g); this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(material, target) {
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }
}

const pass = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });

export class Viewer {
  constructor(canvas, shared) {
    this.canvas = canvas;
    this.shared = shared;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false,
      powerPreference: 'high-performance', reversedDepthBuffer: true });
    r.autoClear = false;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; r.shadowMap.autoUpdate = false;
    this.reversed = !!r.capabilities.reversedDepthBuffer;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x8a949c, 0.00002);
    this.camera = new THREE.PerspectiveCamera(36, 1, 1, 400000);
    this.camera.layers.enableAll();
    this.reflCam = new THREE.PerspectiveCamera();
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.075, screenSpacePanning: false, zoomToCursor: true,
      minDistance: 30, maxDistance: 80000, maxPolarAngle: Math.PI * 0.49, rotateSpeed: 0.55, zoomSpeed: 1.15, panSpeed: 0.9 });

    this.sky = new Sky(r, this.scene);
    this.sky.mesh.layers.set(0);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    Object.assign(this.sun.shadow, { bias: -0.0004, normalBias: 0.8, radius: 2 });
    this.sun.shadow.camera.near = 10; this.sun.shadow.camera.far = 60000;
    this.hemi = new THREE.HemisphereLight(0xb8c4cc, 0x2a2622, 0.5);
    this.sun.layers.enableAll(); this.hemi.layers.enableAll();
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.fs = new FullScreen(r);
    this.mCopy = pass(COPY, { tSrc: { value: null } });
    this.mDepth = pass(DEPTH, { tDepth: { value: null }, uNear: { value: 1 }, uFar: { value: 400000 } });
    this.mAO = pass(AO, { tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uTan: { value: new THREE.Vector2() },
      uProj: { value: 1 }, uFar: { value: 400000 }, uStrength: { value: 1.7 } });
    this.mAOBlur = pass(AO_BLUR, { tSrc: { value: null }, tDepth: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.mAOApply = pass(AO_APPLY, { tAO: { value: null }, tDepth: { value: null } });
    Object.assign(this.mAOApply, { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor });
    this.mBright = pass(BRIGHT, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.6 } });
    this.mBlur = pass(BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
    this.mComposite = pass(COMPOSITE, {
      tScene: { value: null }, tBloomA: { value: black }, tBloomB: { value: black }, uTexel: { value: new THREE.Vector2() },
      uAspect: { value: new THREE.Vector2(1, 1) }, uRainOffset: { value: new THREE.Vector2() }, uExposure: { value: 1 },
      uBloom: { value: 0 }, uRain: { value: 0 }, uTime: { value: 0 }, uSat: { value: 1 }, uContrast: { value: 1.04 },
      uVignette: { value: 0.32 }, uRainFacing: { value: 1 }, uDay: shared.uDay, uFxaa: { value: 1 },
    });
    this.black = black;
    this.reflMatrix = new THREE.Matrix4();
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.waterLevel = 0;
    this.grade = { exposure: 1, sat: 1, bloom: 0.5 };
    this.rain = 0;
    this.scale = 1;
    this._ftAvg = 1 / 60;
    this._govT = 0;
    this.setQuality('high');
    this._fly = null;
    this._ray = new THREE.Raycaster();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setQuality(name) {
    this.qName = name;
    this.q = QUALITY[name] || QUALITY.high;
    const s = this.q.shadow;
    if (this.sun.shadow.mapSize.x !== s) {
      this.sun.shadow.mapSize.set(s, s);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
    }
    this.mComposite.uniforms.uFxaa.value = this.q.fxaa ? 1 : 0;
    this.resize();
  }

  resize() {
    const r = this.renderer, c = this.canvas;
    const w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
    const ratio = Math.max(0.5, Math.min(window.devicePixelRatio || 1, this.q.ratio) * this.scale);
    r.setPixelRatio(ratio);
    r.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const W = Math.round(w * ratio), H = Math.round(h * ratio);
    if (this.rtScene && this.rtScene.width === W && this.rtScene.height === H && this._reflScale === this.q.refl) { this.size = { w, h, W, H, ratio }; return; }
    this._reflScale = this.q.refl;
    [this.rtScene, this.rtHalf, this.rtDepth, this.rtRefl, this.rtB1, this.rtB2, this.rtB3, this.rtB4, this.rtAO1, this.rtAO2].forEach(t => t?.dispose());
    const half = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    const dt = new THREE.DepthTexture(W, H, THREE.FloatType);
    this.rtScene = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthTexture: dt });
    this.rtHalf = new THREE.WebGLRenderTarget(Math.ceil(W / 2), Math.ceil(H / 2), half);
    this.rtDepth = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    if (this.q.refl > 0) {
      this.rtRefl = new THREE.WebGLRenderTarget(Math.ceil(W * this.q.refl), Math.ceil(H * this.q.refl),
        { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    } else this.rtRefl = null;
    const q4 = { ...half }, bw = Math.ceil(W / 4), bh = Math.ceil(H / 4);
    this.rtB1 = new THREE.WebGLRenderTarget(bw, bh, q4); this.rtB2 = new THREE.WebGLRenderTarget(bw, bh, q4);
    this.rtB3 = new THREE.WebGLRenderTarget(Math.ceil(bw / 2), Math.ceil(bh / 2), q4); this.rtB4 = new THREE.WebGLRenderTarget(Math.ceil(bw / 2), Math.ceil(bh / 2), q4);
    const aoOpts = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.rtAO1 = new THREE.WebGLRenderTarget(Math.ceil(W / 2), Math.ceil(H / 2), aoOpts);
    this.rtAO2 = new THREE.WebGLRenderTarget(Math.ceil(W / 2), Math.ceil(H / 2), aoOpts);
    this.mComposite.uniforms.uTexel.value.set(1 / W, 1 / H);
    this.mComposite.uniforms.uAspect.value.set(w / h, 1);
    this.size = { w, h, W, H, ratio };
  }

  /** Attach the water so the pipeline can feed it the copies and reflection. */
  setWater(water) { this.water = water; }

  setLighting(hour, weather) {
    const L = this.sky.set(hour, weather);
    const s = this.shared;
    this.sun.color.copy(this.sky.uniforms.uSunColor.value);
    this.sun.intensity = L.sunIntensity;
    this.sun.castShadow = L.sunIntensity > 0.25;
    this.hemi.color.copy(this.sky.uniforms.uZenith.value).lerp(new THREE.Color(0.75, 0.78, 0.8), 0.5);
    this.hemi.groundColor.setRGB(0.16, 0.13, 0.10).lerp(new THREE.Color(0.32, 0.20, 0.10), L.night * 0.6);
    // at night the cloud deck, lit by the city, fills the streets with a dim warm light
    this.hemi.color.lerp(new THREE.Color(0.55, 0.47, 0.40), L.night * 0.35);
    this.hemi.intensity = 0.22 + 0.7 * L.ambient + 0.12 * L.night;
    this.scene.fog.color.copy(L.fog);
    this.fogBase = L.fogDensity;
    s.uFogColor.value.copy(L.fog);
    s.uApron?.value.copy(L.fog).multiplyScalar(0.42);
    s.uDay.value = L.day; s.uNight.value = L.night;
    this.scene.environment = this.sky.updateEnvironment();
    this.scene.environmentIntensity = 0.35 + 0.65 * L.day;
    this.grade.exposure = 1.12 + 0.75 * L.night + 0.45 * (WEATHER_DARK[weather] ?? 0);
    this.grade.bloom = 0.25 + 0.9 * L.night;
    this.grade.sat = weather === 'storm' ? 0.86 : weather === 'rain' ? 0.9 : weather === 'overcast' ? 0.94 : 1.0;
    this.light = L;
  }

  _updateShadow() {
    const t = this.controls.target, d = this.camera.position.distanceTo(t);
    const ext = THREE.MathUtils.clamp(d * 0.7, 300, 7000);
    const c = this.sun.shadow.camera;
    if (c.right !== ext) { c.left = -ext; c.right = ext; c.top = ext; c.bottom = -ext; c.updateProjectionMatrix(); }
    // snap to shadow texels to avoid shimmering while panning
    const texel = (2 * ext) / this.q.shadow;
    const tx = Math.round(t.x / texel) * texel, tz = Math.round(t.z / texel) * texel;
    this.sun.target.position.set(tx, t.y, tz);
    this.sun.position.set(tx, t.y, tz).addScaledVector(this.sky.sunDir, 25000);
    this.sun.target.updateMatrixWorld();
  }

  _updateNear() {
    const cam = this.camera;
    const h = Math.max(1, cam.position.y - this.groundY);
    const near = this.reversed ? THREE.MathUtils.clamp(h * 0.02, 0.5, 4) : THREE.MathUtils.clamp(h * 0.06, 1, 40);
    if (Math.abs(cam.near - near) / near > 0.15) { cam.near = near; cam.updateProjectionMatrix(); }
  }

  _updateReflection() {
    const cam = this.camera, rc = this.reflCam, L = this.waterLevel;
    rc.copy(cam);
    const p = cam.position.clone(); p.y = 2 * L - p.y;
    const dir = cam.getWorldDirection(new THREE.Vector3()); dir.y = -dir.y;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion); up.y = -up.y;
    rc.position.copy(p); rc.up.copy(up); rc.lookAt(p.clone().add(dir));
    rc.updateMatrixWorld(true);
    rc.layers.set(0);
    this.reflMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    this.clipPlane.set(new THREE.Vector3(0, 1, 0), -L + 0.15);
  }

  /** Draw one frame. t: wall-clock seconds. */
  render(t) {
    const r = this.renderer, cam = this.camera, scene = this.scene;
    this._tickFly(t);
    this.controls.update();
    this.groundY = this.groundAtTarget?.() ?? 0;
    this._updateNear();
    this._updateShadow();
    // haze thins as the camera pulls back, so the whole city stays legible from far away
    const camDist = cam.position.distanceTo(this.controls.target);
    const fd = (this.fogBase ?? 0.00002) * THREE.MathUtils.clamp(7000 / Math.max(camDist, 1), 0.12, 1);
    this.scene.fog.density = fd; this.shared.uFogDensity.value = fd;
    this.sky.tick(t);
    this.sky.mesh.position.copy(cam.position);
    const w = this.water?.uniforms;

    // 1. reflection
    if (this.rtRefl && w) {
      this._updateReflection();
      r.clippingPlanes = [this.clipPlane];
      if (this.sun.castShadow && !this.sun.shadow.map) r.shadowMap.needsUpdate = true;   // first frame: no shadow map yet
      r.setRenderTarget(this.rtRefl); r.clear(true, true, false);
      r.render(scene, this.reflCam);
      r.clippingPlanes = [];
      w.uRefl.value = this.rtRefl.texture; w.uReflMatrix.value.copy(this.reflMatrix); w.uReflOn.value = 1;
    } else if (w) { w.uReflOn.value = 0; }

    // 2. opaque
    cam.layers.set(0); cam.layers.enable(2); cam.layers.enable(3);
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.rtScene); r.clear(true, true, false);
    r.render(scene, cam);

    // 3. linear depth, ambient obscurance multiplied into the opaque scene, then the colour copy
    const md = this.mDepth.uniforms;
    md.tDepth.value = this.rtScene.depthTexture; md.uNear.value = cam.near; md.uFar.value = cam.far;
    this.fs.render(this.mDepth, this.rtDepth);
    if (this.q.ao && this.aoOn !== false) {
      const ua = this.mAO.uniforms, tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
      ua.tDepth.value = this.rtDepth.texture; ua.uTexel.value.set(1 / this.size.W, 1 / this.size.H);
      ua.uTan.value.set(tanY * cam.aspect, tanY); ua.uProj.value = this.size.H / (2 * tanY);
      this.fs.render(this.mAO, this.rtAO1);
      const ub = this.mAOBlur.uniforms;
      ub.tDepth.value = this.rtDepth.texture;
      ub.tSrc.value = this.rtAO1.texture; ub.uDir.value.set(1 / this.rtAO1.width, 0); this.fs.render(this.mAOBlur, this.rtAO2);
      ub.tSrc.value = this.rtAO2.texture; ub.uDir.value.set(0, 1 / this.rtAO1.height); this.fs.render(this.mAOBlur, this.rtAO1);
      const up = this.mAOApply.uniforms;
      up.tAO.value = this.rtAO1.texture; up.tDepth.value = this.rtDepth.texture;
      this.fs.render(this.mAOApply, this.rtScene);
    }
    this.mCopy.uniforms.tSrc.value = this.rtScene.texture;
    this.fs.render(this.mCopy, this.rtHalf);

    // 4. water
    if (w) {
      w.uSceneColor.value = this.rtHalf.texture; w.uSceneDepth.value = this.rtDepth.texture;
      w.uResolution.value.set(this.size.W, this.size.H);
    }
    cam.layers.set(1);
    r.setRenderTarget(this.rtScene);
    r.render(scene, cam);
    cam.layers.enableAll();

    // 5. bloom and composite
    const mc = this.mComposite.uniforms;
    if (this.q.bloom) {
      const b = this.mBright.uniforms;
      b.tSrc.value = this.rtScene.texture; b.uTexel.value.set(1 / this.size.W, 1 / this.size.H);
      this.fs.render(this.mBright, this.rtB1);
      this._blur(this.rtB1, this.rtB2);
      this.mCopy.uniforms.tSrc.value = this.rtB1.texture;
      this.fs.render(this.mCopy, this.rtB3);
      this._blur(this.rtB3, this.rtB4);
      mc.tBloomA.value = this.rtB1.texture; mc.tBloomB.value = this.rtB3.texture; mc.uBloom.value = this.grade.bloom;
    } else { mc.tBloomA.value = this.black; mc.tBloomB.value = this.black; mc.uBloom.value = 0; }
    mc.tScene.value = this.rtScene.texture;
    mc.uExposure.value = this.grade.exposure; mc.uSat.value = this.grade.sat;
    mc.uTime.value = t; mc.uRain.value = this.rain;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    mc.uRainFacing.value = 1 - Math.min(0.8, Math.abs(dir.y) * 0.9);
    const yaw = Math.atan2(dir.x, dir.z);
    mc.uRainOffset.value.set(-yaw * 1.3, dir.y * 1.5);
    this.fs.render(this.mComposite, null);
  }

  _blur(a, b) {
    const u = this.mBlur.uniforms;
    u.tSrc.value = a.texture; u.uDir.value.set(1 / a.width, 0); this.fs.render(this.mBlur, b);
    u.tSrc.value = b.texture; u.uDir.value.set(0, 1 / a.height); this.fs.render(this.mBlur, a);
  }

  // ---------- picking ----------
  initPicking(city, W, H, heightAt) {
    this.city = city; this.W = W; this.H = H; this.heightAt = heightAt;
    this.groundAtTarget = () => heightAt(this.controls.target.x + W / 2, H / 2 - this.controls.target.z);
  }

  /** Building under a canvas pixel (CSS px): { id, texel } or null. */
  pickBuilding(cx, cy) {
    if (!this.city) return null;
    return this.city.pick(this.camera, cx, cy, this.canvas.clientWidth, this.canvas.clientHeight);
  }

  /** Frame-time governor: lowers the render scale when frames are slow, raises it when there is headroom. */
  govern(dt, now) {
    this._ftAvg = this._ftAvg * 0.93 + Math.min(dt, 0.25) * 0.07;
    if (now - this._govT < 1.5) return;
    let s = this.scale;
    if (this._ftAvg > 1 / 38) s = Math.max(this.q.minScale, s - 0.08);
    else if (this._ftAvg < 1 / 57) s = Math.min(1, s + 0.05);
    if (Math.abs(s - this.scale) > 1e-3) { this.scale = s; this._govT = now; this.resize(); }
  }

  /** Ground point (local metres) under a canvas pixel, marching the ray over the terrain. */
  groundAt(cx, cy) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this._ray.setFromCamera(new THREE.Vector2((cx / w) * 2 - 1, -(cy / h) * 2 + 1), this.camera);
    const o = this._ray.ray.origin, d = this._ray.ray.direction, W = this.W, H = this.H;
    let t = 0, prev = 0;
    for (let k = 0; k < 8000; k++) {
      const x = o.x + d.x * t + W / 2, y = H / 2 - (o.z + d.z * t), z = o.y + d.y * t;
      const inside = x >= 0 && y >= 0 && x <= W && y <= H;
      const g = inside ? this.heightAt(x, y) : -40;
      if (z <= g) {
        let a = prev, b = t;
        for (let s = 0; s < 24; s++) {
          const m = (a + b) / 2, mx = o.x + d.x * m + W / 2, my = H / 2 - (o.z + d.z * m);
          if (o.y + d.y * m <= this.heightAt(mx, my)) b = m; else a = m;
        }
        const fx = o.x + d.x * b + W / 2, fy = H / 2 - (o.z + d.z * b);
        return inside ? { x: fx, y: fy, z: this.heightAt(fx, fy) } : null;
      }
      if (z < -60 || t > 250000) return null;
      prev = t;
      t += Math.max(0.6, (z - g) * 0.45);
    }
    return null;
  }

  /** Screen position (CSS px) of a world point, or null when behind the camera. */
  project(v) {
    const p = v.clone().project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return { x: (p.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-p.y * 0.5 + 0.5) * this.canvas.clientHeight, z: p.z };
  }

  // ---------- camera ----------
  /** view: { target: [lx, ly, z], dist, polar (deg from vertical), azim (deg, 0 = looking north) } */
  viewPose(v) {
    const tgt = new THREE.Vector3(v.target[0] - this.W / 2, v.target[2], this.H / 2 - v.target[1]);
    const pol = THREE.MathUtils.degToRad(v.polar), az = THREE.MathUtils.degToRad(v.azim);
    const pos = tgt.clone().add(new THREE.Vector3(-Math.sin(az) * Math.sin(pol), Math.cos(pol), Math.cos(az) * Math.sin(pol)).multiplyScalar(v.dist));
    return { tgt, pos };
  }

  setView(v) {
    const { tgt, pos } = this.viewPose(v);
    this.controls.target.copy(tgt); this.camera.position.copy(pos); this.controls.update();
  }

  flyTo(v, seconds = 2.2) {
    const { tgt, pos } = this.viewPose(v);
    this._fly = { t0: null, dur: seconds, p0: this.camera.position.clone(), t0v: this.controls.target.clone(), p1: pos, t1: tgt };
  }

  _tickFly(t) {
    const f = this._fly;
    if (!f) return;
    if (f.t0 === null) f.t0 = t;
    const k = Math.min(1, (t - f.t0) / f.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.controls.target.lerpVectors(f.t0v, f.t1, e);
    const p = new THREE.Vector3().lerpVectors(f.p0, f.p1, e);
    // rise a little mid-flight so long moves read as a camera move, not a zoom
    const lift = Math.sin(Math.PI * e) * Math.min(6000, f.p0.distanceTo(f.p1) * 0.18);
    p.y += lift;
    this.camera.position.copy(p);
    if (k >= 1) this._fly = null;
  }

  cancelFly() { this._fly = null; }

  /** Current camera as a view description (for bookmarks and links). */
  currentView() {
    const t = this.controls.target, p = this.camera.position;
    const d = p.distanceTo(t), off = p.clone().sub(t);
    const polar = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(off.y / d, -1, 1)));
    const azim = THREE.MathUtils.radToDeg(Math.atan2(-off.x, off.z));
    return { target: [t.x + this.W / 2, this.H / 2 - t.z, t.y], dist: d, polar, azim };
  }

  /** PNG of the next frame. */
  capture(t) {
    this.render(t);
    return this.canvas.toDataURL('image/png');
  }
}

const WEATHER_DARK = { clear: 0, partly: 0.05, overcast: 0.3, storm: 0.9, rain: 0.6 };
