import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

// ---------- renderer / scene / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.lookAt(0, 0, 0);

// Pull the camera in so the unit sphere fills ~75% of the smaller viewport
// dimension. Trades a bit of stretch headroom for a larger idle ball.
const FIT_MARGIN = 1 / 0.75;
function fitCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  camera.aspect = aspect;
  const halfVFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const limitFactor = Math.tan(halfVFov) * Math.min(1, aspect);
  camera.position.set(0, 0, FIT_MARGIN / limitFactor);
  camera.updateProjectionMatrix();
}
fitCamera();

// Bloom disabled — the HDR's bright windows were smearing everywhere. The
// composer machinery is removed; we render directly with ACES on the renderer.

// Load the Poly Haven studio HDRI as both scene background and env map —
// gives MeshPhysicalMaterial real reflections for its clearcoat/transmission.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
new RGBELoader().load('/poly_haven_studio_2k.hdr', (hdrTex) => {
  const envMap = pmrem.fromEquirectangular(hdrTex).texture;
  scene.environment = envMap;
  hdrTex.dispose();
  pmrem.dispose();
});

// ---------- textures ----------
function makeMatcap(stops) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const g = ctx.createRadialGradient(size * 0.35, size * 0.3, 4, size / 2, size / 2, size / 2);
  for (const [t, color] of stops) g.addColorStop(t, color);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const matcap1 = makeMatcap([
  [0.0, '#ffffff'],
  [0.4, '#dce4ee'],
  [1.0, '#0a0a12'],
]);
const matcap2 = makeMatcap([
  [0.0, '#fff4fb'],
  [0.5, '#b4a8c8'],
  [1.0, '#1a1824'],
]);

function proceduralHatching() {
  const size = 1280;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3;
  for (let i = -size; i < size * 2; i += 14) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const hatching = proceduralHatching();

function makeTextTexture(text) {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  ctx.font = `500 ${size * 0.28}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
const textTexture = makeTextTexture('AMLR');

// ---------- sphere ----------
const geometry = new THREE.SphereGeometry(1, 512, 512);

const baseMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xD3D3D3,
  roughness: 0.55,
  metalness: 0.0,
  clearcoat: 0.25,
  clearcoatRoughness: 0.35,
  transmission: 0.05,
  thickness: 0.4,
  ior: 1.4,
});

// Expose shader uniforms so we can swap the hatching texture after async load
// and drive the foam deformation from the animation loop.
const material = baseMaterial;
material.uniforms = {
  uMatcap1: { value: matcap1 },
  uMatcap2: { value: matcap2 },
  uHatching: { value: hatching },
  uHatchScale: { value: new THREE.Vector2(0.19, 0.34) },
  uText:       { value: textTexture },
  uTextScale:  { value: new THREE.Vector2(0.12, 0.24) },
  // Foam deformation: a single impact point (object-space) with a strength
  // driven by a damped spring. Strength > 0 dents inward, < 0 bulges outward.
  uImpactPoint:    { value: new THREE.Vector3(0, 0, 1) },
  uImpactStrength: { value: 0.0 },
  uImpactRadius:   { value: 0.8 },
  uImpactSeed:     { value: 0.0 },
  // Hand contact points: [0..3] fingers, [4] thumb, [5] palm.
  // Coeffs are scaled so that at peak squeeze (s=SQUEEZE_TARGET) the local
  // dents equal the requested percentages of the sphere radius.
  uContactPoints:  { value: Array.from({ length: 6 }, () => new THREE.Vector3()) },
  uContactCoeffs:  { value: new Float32Array([0, 0, 0, 0, 0, 0]) },
  uContactRadii:   { value: new Float32Array([0.35, 0.35, 0.35, 0.35, 0.40, 0.95]) },
};

material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, material.uniforms);
  material.uniforms = shader.uniforms;

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
       varying vec3 vObjectNormal;
       uniform vec3 uImpactPoint;
       uniform float uImpactStrength;
       uniform float uImpactRadius;
       uniform float uImpactSeed;
       uniform vec3 uContactPoints[6];
       uniform float uContactCoeffs[6];
       uniform float uContactRadii[6];

       // Cheap 3D value-noise-ish hash for per-vertex irregularity.
       float hash13(vec3 p) {
         p = fract(p * 0.1031);
         p += dot(p, p.yxz + 33.33);
         return fract((p.x + p.y) * p.z);
       }`
    )
    .replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
       vObjectNormal = normal;`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       // Global squeeze: compress along the axis through the click point,
       // bulge perpendicular to it (approximate volume preservation). Per-
       // vertex noise modulates the factors slightly for a foamy, non-
       // uniform surface — not a clean ellipsoid.
       vec3 axis = normalize(uImpactPoint);
       float s = uImpactStrength;
       float a = dot(transformed, axis);
       vec3 perp = transformed - a * axis;
       float n = hash13(transformed * 2.3 + uImpactSeed) * 2.0 - 1.0;
       float axialFactor = 1.0 - s * 1.0 + n * s * 0.02; // flatten along axis
       float perpFactor  = 1.0 + s * 0.65 + n * s * 0.02; // bulge perpendicular
       transformed = axis * (a * axialFactor) + perp * perpFactor;

       // Hand contacts: each contact carves a local inward dent that fades with
       // distance. Only applied during squeeze (s > 0); during expansion the
       // ball is being stretched, not grabbed, so the dents are suppressed.
       float contactDent = 0.0;
       for (int i = 0; i < 6; i++) {
         float d = distance(position, uContactPoints[i]);
         float f = 1.0 - smoothstep(0.0, uContactRadii[i], d);
         contactDent += f * uContactCoeffs[i];
       }
       transformed -= normal * contactDent * max(s, 0.0);`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
       uniform sampler2D uMatcap1;
       uniform sampler2D uMatcap2;
       uniform sampler2D uHatching;
       uniform vec2 uHatchScale;
       uniform sampler2D uText;
       uniform vec2 uTextScale;
       varying vec3 vObjectNormal;

       vec3 rgb2hsl(vec3 c) {
         float mx = max(max(c.r, c.g), c.b);
         float mn = min(min(c.r, c.g), c.b);
         float h = 0.0;
         float s = 0.0;
         float l = (mx + mn) * 0.5;
         float d = mx - mn;
         if (d > 1e-6) {
           s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
           if (mx == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
           else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
           else                h = (c.r - c.g) / d + 4.0;
           h /= 6.0;
         }
         return vec3(h, s, l);
       }
       float hue2rgb(float p, float q, float t) {
         if (t < 0.0) t += 1.0;
         if (t > 1.0) t -= 1.0;
         if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
         if (t < 0.5)       return q;
         if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
         return p;
       }
       vec3 hsl2rgb(vec3 hsl) {
         float h = hsl.x;
         float s = hsl.y;
         float l = hsl.z;
         if (s < 1e-6) return vec3(l);
         float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
         float p = 2.0 * l - q;
         return vec3(
           hue2rgb(p, q, h + 1.0 / 3.0),
           hue2rgb(p, q, h),
           hue2rgb(p, q, h - 1.0 / 3.0)
         );
       }`
    )
    .replace(
      '#include <colorspace_fragment>',
      `
       // --- matcap overlays at low opacity — real env lighting carries the
       //     rest, so these just add a subtle pearlescent tint.
       vec2 matcapUv = normalize(vNormal).xy * 0.5 + 0.5;
       gl_FragColor.rgb = mix(gl_FragColor.rgb, texture2D(uMatcap1, matcapUv).rgb, 0.25);
       gl_FragColor.rgb = mix(gl_FragColor.rgb, texture2D(uMatcap2, matcapUv).rgb, 0.25);

       // --- hatching: spherical projection, non-uniform scale, clamp ---
       vec3 on = normalize(vObjectNormal);
       vec2 sph = vec2(
         atan(on.z, on.x) * 0.15915494 + 0.5, // /(2*pi)
         asin(clamp(on.y, -1.0, 1.0)) * 0.31830989 + 0.5 // /pi
       );
       vec2 hUv = clamp((sph - 0.5) / uHatchScale + 0.5, 0.0, 1.0);
       vec3 hatch = texture2D(uHatching, hUv).rgb;

       // Multiply blend at 60% — black hatching darkens the sphere, white
       // background leaves it untouched. (HSL "Color" blend with a grayscale
       // image only desaturates uniformly, so the mask wouldn't be visible.)
       vec3 multiplied = gl_FragColor.rgb * hatch;
       gl_FragColor.rgb = mix(gl_FragColor.rgb, multiplied, 0.6);

       // --- "AMLR" text on the opposite hemisphere ---
       // Shift spherical UV by half a turn so center of text lands on -X,
       // opposite the hatching logo. Flip X on sample to un-mirror (textures
       // on the back hemisphere read mirrored otherwise).
       vec2 textSph = vec2(fract(sph.x + 0.5), sph.y);
       vec2 tUv = clamp((textSph - 0.5) / uTextScale + 0.5, 0.0, 1.0);
       tUv.x = 1.0 - tUv.x;
       vec3 textSample = texture2D(uText, tUv).rgb;
       vec3 textMultiplied = gl_FragColor.rgb * textSample;
       gl_FragColor.rgb = mix(gl_FragColor.rgb, textMultiplied, 0.7);

       // --- Fresnel rim at full opacity ---
       float fresnel = pow(1.0 - clamp(dot(normalize(vViewPosition), normalize(vNormal)), 0.0, 1.0), 3.0);
       gl_FragColor.rgb += vec3(fresnel);

       #include <colorspace_fragment>
      `
    );
};

const sphere = new THREE.Mesh(geometry, material);
sphere.rotation.y = -Math.PI / 2; // face the logo (+X pole) toward the camera on load
scene.add(sphere);

// Swap in the real hatching image if it exists at /hatching.png; otherwise
// keep the procedural fallback. Drop a 1280x1280 B&W file at public/hatching.png.
new THREE.TextureLoader().load(
  '/hatching.png',
  (loaded) => {
    loaded.colorSpace = THREE.SRGBColorSpace;
    loaded.wrapS = loaded.wrapT = THREE.ClampToEdgeWrapping;
    material.uniforms.uHatching.value = loaded;
  },
  undefined,
  () => {}
);

// ---------- lights ----------
// The HDRI env map already diffusely lights the ball; these three directional
// lights add shape: warm key upper-left, cool fill lower-right, cool rim
// behind-above. No single one is bright enough to produce a hot spot.
scene.add(new THREE.AmbientLight(0xffffff, 0.15));

const keyLight = new THREE.DirectionalLight(0xfff1e0, 0.8);
keyLight.position.set(-3, 4, 3);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xcfe0ff, 0.45);
fillLight.position.set(4, -1, 2);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xe8f0ff, 0.6);
rimLight.position.set(0, 3, -4);
scene.add(rimLight);

// ---------- foam deformation ----------
// Damped spring drives uImpactStrength. A click applies an impulse → the spring
// overshoots (squish), passes through zero (bulge), and settles. No tween needed.
const SPRING_STIFFNESS = 130; // faster response, still no jelly wobble
const SPRING_DAMPING = 23;    // critically damped-ish (ζ≈1.0)
// Non-linear resistance: the spring chases pow(target, RESISTANCE) instead of
// target directly. >1 = ball resists light squeezes but still compresses fully
// under heavy pressure. Feels like foam firmness.
const RESISTANCE = 1.3;
// Click-hold logistic ramp: target = HOLD_MAX / (1 + e^(-k*(t - midpoint)))
// Short taps barely squeeze; long holds asymptote to HOLD_MAX.
const HOLD_MAX = 0.7;
const HOLD_K = 6;           // steepness
const HOLD_MIDPOINT = 0.5;  // seconds to reach HOLD_MAX/2
let holdStartMs = 0;
let impactValue = 0;
let impactVelocity = 0;
let impactTarget = 0; // what the spring is moving toward (0 = rest, SQUEEZE_TARGET = held)

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const _viewDir = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _axisWorld = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();
const _basisRight = new THREE.Vector3();
const _basisUp = new THREE.Vector3();
const _tmpAxis = new THREE.Vector3();
const _tmpHelper = new THREE.Vector3();

// Peak local-dent depths (as fraction of sphere radius) at full squeeze.
const FINGER_PEAK = 0.25;
const THUMB_PEAK  = 0.20;
const PALM_PEAK   = 0.30;

function placeContacts(axisLocal) {
  // Build an orthonormal basis perpendicular to the squeeze axis.
  _tmpHelper.set(0, 1, 0);
  if (Math.abs(axisLocal.dot(_tmpHelper)) > 0.95) _tmpHelper.set(1, 0, 0);
  _basisRight.crossVectors(axisLocal, _tmpHelper).normalize();
  _basisUp.crossVectors(_basisRight, axisLocal).normalize();

  const pts = material.uniforms.uContactPoints.value;
  const coeffs = material.uniforms.uContactCoeffs.value;

  // Fingers clustered near +axis pole, spread across an arc.
  const fingerAngle = 0.55 + Math.random() * 0.15; // ~31-40 deg from axis
  const arcCenter = Math.random() * Math.PI * 2;
  const arcSpread = Math.PI * 0.85;
  for (let i = 0; i < 4; i++) {
    const t = (i - 1.5) / 3; // -0.5 .. 0.5
    const phi = arcCenter + t * arcSpread;
    pts[i]
      .copy(axisLocal).multiplyScalar(Math.cos(fingerAngle))
      .addScaledVector(_basisRight, Math.sin(fingerAngle) * Math.cos(phi))
      .addScaledVector(_basisUp,    Math.sin(fingerAngle) * Math.sin(phi));
  }
  // Thumb: opposite side of the arc, slightly wider angle.
  const thumbAngle = 0.7 + Math.random() * 0.1;
  const thumbPhi = arcCenter + Math.PI; // opposite the finger arc midpoint
  pts[4]
    .copy(axisLocal).multiplyScalar(Math.cos(thumbAngle))
    .addScaledVector(_basisRight, Math.sin(thumbAngle) * Math.cos(thumbPhi))
    .addScaledVector(_basisUp,    Math.sin(thumbAngle) * Math.sin(thumbPhi));

  // Palm: -axis pole, small random wobble.
  pts[5]
    .copy(axisLocal).multiplyScalar(-1)
    .addScaledVector(_basisRight, (Math.random() - 0.5) * 0.15)
    .addScaledVector(_basisUp,    (Math.random() - 0.5) * 0.15)
    .normalize();

  // Scale so that at peak click-hold (s = HOLD_MAX) dents equal the design
  // percentages. Pinch can drive s slightly higher (PINCH_TARGET_MAX = 0.8)
  // which makes dents proportionally deeper — fine, pinches are "harder".
  const k = 1 / HOLD_MAX;
  coeffs[0] = coeffs[1] = coeffs[2] = coeffs[3] = FINGER_PEAK * k;
  coeffs[4] = THUMB_PEAK * k;
  coeffs[5] = PALM_PEAK  * k;
}

function prepareSqueezeFromLocalPoint(localPoint) {
  // Build a squeeze axis perpendicular to the camera so the deformation is
  // always visible (never aligned with view direction). Start from the click
  // point's offset from sphere center, project onto the view plane, then add
  // a small in-plane random jitter so every squeeze varies.
  sphere.localToWorld(_axisWorld.copy(localPoint));
  _axisWorld.sub(sphere.position);
  camera.getWorldDirection(_viewDir);
  _axisWorld.addScaledVector(_viewDir, -_axisWorld.dot(_viewDir));

  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  _axisWorld
    .addScaledVector(_camRight, (Math.random() - 0.5) * 0.7)
    .addScaledVector(_camUp,    (Math.random() - 0.5) * 0.7);

  if (_axisWorld.lengthSq() < 1e-4) _axisWorld.copy(_camRight);
  _axisWorld.normalize();

  _invQuat.copy(sphere.quaternion).invert();
  _axisWorld.applyQuaternion(_invQuat);
  commitSqueezeAxis(_axisWorld);
}

function prepareSqueezeFromWorldAxis(worldAxis) {
  // Takes a world-space direction, projects out the view component, converts
  // to sphere-local, and engages the contacts.
  _axisWorld.copy(worldAxis);
  camera.getWorldDirection(_viewDir);
  _axisWorld.addScaledVector(_viewDir, -_axisWorld.dot(_viewDir));
  if (_axisWorld.lengthSq() < 1e-4) {
    _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _axisWorld.copy(_camRight);
  }
  _axisWorld.normalize();
  _invQuat.copy(sphere.quaternion).invert();
  _axisWorld.applyQuaternion(_invQuat);
  commitSqueezeAxis(_axisWorld);
}

function commitSqueezeAxis(localAxis) {
  material.uniforms.uImpactPoint.value.copy(localAxis);
  material.uniforms.uImpactSeed.value = Math.random() * 1000;
  placeContacts(localAxis);
}

function startSqueeze(localPoint) {
  prepareSqueezeFromLocalPoint(localPoint);
  holdStartMs = performance.now();
  // Seed target with the logistic value at t=0 (nearly 0).
  impactTarget = HOLD_MAX / (1 + Math.exp(HOLD_K * HOLD_MIDPOINT));
}

function releaseSqueeze() {
  impactTarget = 0;
}

// ---------- idle auto-spin + breathing + drag momentum ----------
const AUTO_SPIN_SPEED = 0.25;   // radians/sec when fully spun up
const AUTO_SPIN_DELAY_MS = 1500; // idle time before spin starts
const AUTO_SPIN_FADE = 2.0;     // factor change per second (fade in/out)
let lastInteractionMs = performance.now();
let autoSpinFactor = 0;
const markInteraction = () => { lastInteractionMs = performance.now(); };

// Idle breathing: subtle ±1% scale pulse at ~0.4Hz.
const BREATHE_RATE = 0.4 * 2 * Math.PI; // rad/s
const BREATHE_DEPTH = 0.01;
let breatheTime = 0;

// Drag momentum: tracked angular velocity that continues after pointerup.
const ROT_DAMPING = 2.5; // exponential decay per second
let rotVelX = 0, rotVelY = 0;
let lastMoveTimeMs = 0;

// ---------- input: click-hold + drag-rotate + multi-touch pinch + trackpad pinch ----------
const DRAG_THRESHOLD = 4;
const ROTATE_SPEED = 0.005;

// Interaction modes are exclusive. 'click-hold' = one pointer on sphere,
// squeezing; 'drag' = one pointer moving past threshold, rotating the sphere;
// 'pinch' = 2+ pointers, distance-driven squeeze.
let mode = 'idle';
const activePointers = new Map(); // pointerId -> { x, y }
let dragLastX = 0, dragLastY = 0, dragDownX = 0, dragDownY = 0;
let pendingHitLocal = null;
let clickHoldPointerId = null;

// Pinch gesture state (shared between touch and trackpad).
const PINCH_TARGET_MAX = 0.8;
let pinchInitialDist = 0; // touch only

function enterPinchMode() {
  if (activePointers.size < 2) return;
  const [a, b] = [...activePointers.values()];
  pinchInitialDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;

  // Axis in world: along the line between the two fingers, in camera's frame.
  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const dx = b.x - a.x;
  const dy = -(b.y - a.y); // screen-y flipped to world-up
  _axisWorld.set(0, 0, 0)
    .addScaledVector(_camRight, dx)
    .addScaledVector(_camUp, dy);
  prepareSqueezeFromWorldAxis(_axisWorld);
  mode = 'pinch';
  renderer.domElement.style.cursor = 'grabbing';
}

function updatePinchMode() {
  if (activePointers.size < 2) return;
  const [a, b] = [...activePointers.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const t = (pinchInitialDist - dist) / pinchInitialDist; // >0 = inward, <0 = outward
  impactTarget = Math.max(-PINCH_TARGET_MAX, Math.min(PINCH_TARGET_MAX, t));
}

function exitPinchMode() {
  mode = 'idle';
  releaseSqueeze();
  renderer.domElement.style.cursor = 'grab';
}

function endClickHold(pointerId) {
  try { renderer.domElement.releasePointerCapture(pointerId); } catch {}
  releaseSqueeze();
  clickHoldPointerId = null;
  pendingHitLocal = null;
  mode = 'idle';
  renderer.domElement.style.cursor = 'grab';
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  markInteraction();
  // A new interaction cancels any lingering rotation momentum.
  rotVelX = 0;
  rotVelY = 0;
  lastMoveTimeMs = performance.now();
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (activePointers.size >= 2) {
    if (mode === 'click-hold' || mode === 'drag') {
      endClickHold(clickHoldPointerId);
    }
    enterPinchMode();
    return;
  }

  // First pointer — try click-hold on sphere.
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(sphere);
  if (hits.length === 0) return;

  pendingHitLocal = sphere.worldToLocal(hits[0].point.clone());
  clickHoldPointerId = event.pointerId;
  dragDownX = dragLastX = event.clientX;
  dragDownY = dragLastY = event.clientY;
  renderer.domElement.setPointerCapture(event.pointerId);
  startSqueeze(pendingHitLocal);
  mode = 'click-hold';
  renderer.domElement.style.cursor = 'grabbing';
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (activePointers.has(event.pointerId)) {
    markInteraction();
    const p = activePointers.get(event.pointerId);
    p.x = event.clientX;
    p.y = event.clientY;
  }

  if (mode === 'pinch') {
    updatePinchMode();
    return;
  }

  if (mode === 'click-hold' || mode === 'drag') {
    if (event.pointerId !== clickHoldPointerId) return;
    const dx = event.clientX - dragLastX;
    const dy = event.clientY - dragLastY;
    dragLastX = event.clientX;
    dragLastY = event.clientY;
    if (mode === 'click-hold') {
      if (Math.hypot(event.clientX - dragDownX, event.clientY - dragDownY) > DRAG_THRESHOLD) {
        mode = 'drag';
        releaseSqueeze();
      } else return;
    }
    sphere.rotation.y += dx * ROTATE_SPEED;
    sphere.rotation.x += dy * ROTATE_SPEED;
    // Track angular velocity in rad/sec for release momentum.
    const now = performance.now();
    const mdt = Math.max(0.001, (now - lastMoveTimeMs) / 1000);
    rotVelY = (dx * ROTATE_SPEED) / mdt;
    rotVelX = (dy * ROTATE_SPEED) / mdt;
    lastMoveTimeMs = now;
    return;
  }

  // Hover — cursor feedback only.
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  renderer.domElement.style.cursor =
    raycaster.intersectObject(sphere).length > 0 ? 'grab' : 'default';
});

function onPointerEnd(event) {
  activePointers.delete(event.pointerId);

  if (mode === 'pinch') {
    if (activePointers.size < 2) exitPinchMode();
    return;
  }
  if ((mode === 'click-hold' || mode === 'drag') && event.pointerId === clickHoldPointerId) {
    endClickHold(event.pointerId);
  }
}
renderer.domElement.addEventListener('pointerup', onPointerEnd);
renderer.domElement.addEventListener('pointercancel', onPointerEnd);

// Trackpad pinch: browsers surface it as wheel events with ctrlKey === true
// (even on Windows precision trackpads). Accumulate into a target and release
// after a short idle gap so the gesture naturally ends.
const WHEEL_PINCH_IDLE_MS = 140;
const WHEEL_PINCH_SCALE = 0.008;
let wheelPinchLevel = 0;
let wheelPinchLastTime = 0;
let wheelPinchActive = false;

renderer.domElement.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  markInteraction();
  if (!wheelPinchActive) {
    // Start a new gesture — pick an axis from the current cursor.
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(sphere);
    if (hits.length > 0) {
      prepareSqueezeFromLocalPoint(sphere.worldToLocal(hits[0].point.clone()));
    } else {
      // Cursor off-sphere: synthesize a local point from the NDC direction.
      prepareSqueezeFromLocalPoint(new THREE.Vector3(pointer.x, pointer.y, 0));
    }
    wheelPinchActive = true;
    wheelPinchLevel = 0;
  }
  // deltaY > 0 when fingers come together (squeeze); <0 when they spread
  // apart (expand the ball along the axis).
  wheelPinchLevel = Math.max(-PINCH_TARGET_MAX, Math.min(PINCH_TARGET_MAX, wheelPinchLevel + event.deltaY * WHEEL_PINCH_SCALE));
  wheelPinchLastTime = performance.now();
  impactTarget = wheelPinchLevel;
}, { passive: false });

renderer.domElement.style.cursor = 'grab';

// ---------- resize & loop ----------
window.addEventListener('resize', () => {
  fitCamera();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  // End a trackpad pinch gesture after a short idle gap (no wheel events).
  if (wheelPinchActive && performance.now() - wheelPinchLastTime > WHEEL_PINCH_IDLE_MS) {
    wheelPinchActive = false;
    wheelPinchLevel = 0;
    if (mode === 'idle') impactTarget = 0;
  }

  // Click-hold: target grows along a logistic curve while the button is down.
  if (mode === 'click-hold') {
    const held = (performance.now() - holdStartMs) / 1000;
    impactTarget = HOLD_MAX / (1 + Math.exp(-HOLD_K * (held - HOLD_MIDPOINT)));
  }

  // Step the damped spring driving the foam impact strength. The effective
  // target is raised to RESISTANCE, so light targets get suppressed and the
  // ball feels firmer to begin squeezing.
  const dt = Math.min(clock.getDelta(), 1 / 30);
  const effectiveTarget = Math.sign(impactTarget) * Math.pow(Math.abs(impactTarget), RESISTANCE);
  const accel = -SPRING_STIFFNESS * (impactValue - effectiveTarget) - SPRING_DAMPING * impactVelocity;
  impactVelocity += accel * dt;
  impactValue += impactVelocity * dt;
  material.uniforms.uImpactStrength.value = impactValue;

  // Drag momentum: carries rotation after pointerup, then damps away.
  const momentumActive = Math.hypot(rotVelX, rotVelY) > 0.05;
  if (mode !== 'drag' && momentumActive) {
    sphere.rotation.y += rotVelY * dt;
    sphere.rotation.x += rotVelX * dt;
    const decay = Math.exp(-ROT_DAMPING * dt);
    rotVelX *= decay;
    rotVelY *= decay;
  }

  // Idle auto-spin: fade in after no interaction for AUTO_SPIN_DELAY_MS.
  // Suppressed while drag momentum is still lively so they don't overlap.
  const idleMs = performance.now() - lastInteractionMs;
  const canSpin = mode === 'idle' && !wheelPinchActive && !momentumActive && idleMs > AUTO_SPIN_DELAY_MS;
  const targetFactor = canSpin ? 1 : 0;
  autoSpinFactor += Math.max(-AUTO_SPIN_FADE * dt, Math.min(AUTO_SPIN_FADE * dt, targetFactor - autoSpinFactor));
  sphere.rotation.y += AUTO_SPIN_SPEED * autoSpinFactor * dt;

  // Idle breathing: subtle scale pulse (doesn't conflict with vertex-level squeeze).
  breatheTime += dt;
  const breath = 1 + Math.sin(breatheTime * BREATHE_RATE) * BREATHE_DEPTH;
  sphere.scale.setScalar(breath);

  renderer.render(scene, camera);
});
