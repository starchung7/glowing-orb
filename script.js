import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import GUI from 'lil-gui';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import treeUrl from './assets/models/tree1.glb?url';
import terrainUrl from './assets/models/terrain.glb?url';
import featureMapUrl from './assets/terrain.png?url';
import pathMapUrl from './assets/path.png?url';

await RAPIER.init();

// ----------------------------------------------------------------------------
// Terrain — the rolling ground from terrain.glb. Loaded up-front so the rest of
// the scene (orb hover, physics, grass, trees) can conform to its surface.
// A heightmap is baked once by rasterising the terrain triangles onto a regular
// grid, giving a fast topology-agnostic `terrainHeightAt(x, z)` lookup, a
// height texture for the grass/water shaders, and a physics trimesh.
// ----------------------------------------------------------------------------
const _terrainGltf = await new GLTFLoader().loadAsync(terrainUrl);
_terrainGltf.scene.updateMatrixWorld(true);

// The file also contains a stray default "Cube"; the ground itself is "Grid".
let terrainMesh = null;
_terrainGltf.scene.traverse((o) => {
    if (o.isMesh && o.name === 'Grid') terrainMesh = o;
});
if (!terrainMesh) {
    // Fall back to the largest mesh if the export naming ever changes.
    let maxCount = -1;
    _terrainGltf.scene.traverse((o) => {
        const c = o.isMesh ? o.geometry.attributes.position.count : -1;
        if (c > maxCount) { maxCount = c; terrainMesh = o; }
    });
}
// Shrink the terrain uniformly. Applied before bounds, heightmap, and trimesh
// are derived below so every consumer (orb hover, grass, physics) conforms to
// the scaled surface automatically. Local scale survives the later reparent to
// the scene root, so the rendered mesh matches the baked data.
const TERRAIN_SCALE = 0.5; // 1/2 of the authored size
terrainMesh.scale.multiplyScalar(TERRAIN_SCALE);
terrainMesh.updateMatrixWorld(true);
terrainMesh.castShadow = true;
terrainMesh.receiveShadow = true;
terrainMesh.frustumCulled = false;

// World-space bounds of the terrain, used to map XZ → heightmap UV.
const _terrainBox = new THREE.Box3().setFromObject(terrainMesh);
const TERRAIN_MIN_X = _terrainBox.min.x;
const TERRAIN_MIN_Z = _terrainBox.min.z;
const TERRAIN_SIZE_X = Math.max(1e-4, _terrainBox.max.x - _terrainBox.min.x);
const TERRAIN_SIZE_Z = Math.max(1e-4, _terrainBox.max.z - _terrainBox.min.z);
// Bake the heightmap by rasterising the terrain triangles onto a regular grid:
// each triangle is projected to XZ and every grid cell it covers gets its
// barycentrically-interpolated height (max-combined, i.e. the topmost surface —
// identical to a downward raycast but orders of magnitude faster, which is what
// lets the grid be this dense without hurting startup).
const HMAP_RES = 256;                // samples per axis
const _heights = new Float32Array(HMAP_RES * HMAP_RES);
{
    // Cells no triangle covers (outside the mesh footprint) read as the
    // terrain's lowest point, same as a missed raycast did before.
    _heights.fill(_terrainBox.min.y);

    const geo = terrainMesh.geometry;
    const posAttr = geo.attributes.position;
    const idxAttr = geo.index;
    const mw = terrainMesh.matrixWorld;
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const triCount = (idxAttr ? idxAttr.count : posAttr.count) / 3;
    // World XZ → continuous grid coordinates (grid points sit at integers).
    const toGX = (x) => ((x - TERRAIN_MIN_X) / TERRAIN_SIZE_X) * (HMAP_RES - 1);
    const toGZ = (z) => ((z - TERRAIN_MIN_Z) / TERRAIN_SIZE_Z) * (HMAP_RES - 1);

    for (let t = 0; t < triCount; t++) {
        const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
        const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;
        vA.fromBufferAttribute(posAttr, i0).applyMatrix4(mw);
        vB.fromBufferAttribute(posAttr, i1).applyMatrix4(mw);
        vC.fromBufferAttribute(posAttr, i2).applyMatrix4(mw);

        const ax = toGX(vA.x), az = toGZ(vA.z);
        const bx = toGX(vB.x), bz = toGZ(vB.z);
        const cx = toGX(vC.x), cz = toGZ(vC.z);
        // Skip triangles that are edge-on in XZ (no downward-facing area).
        const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(denom) < 1e-10) continue;

        const gx0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
        const gx1 = Math.min(HMAP_RES - 1, Math.floor(Math.max(ax, bx, cx)));
        const gz0 = Math.max(0, Math.ceil(Math.min(az, bz, cz)));
        const gz1 = Math.min(HMAP_RES - 1, Math.floor(Math.max(az, bz, cz)));

        for (let gz = gz0; gz <= gz1; gz++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const w0 = ((bz - cz) * (gx - cx) + (cx - bx) * (gz - cz)) / denom;
                const w1 = ((cz - az) * (gx - cx) + (ax - cx) * (gz - cz)) / denom;
                const w2 = 1 - w0 - w1;
                // Tiny negative tolerance keeps grid points that land exactly
                // on shared triangle edges from slipping through both tests.
                if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                const y = w0 * vA.y + w1 * vB.y + w2 * vC.y;
                const i = gz * HMAP_RES + gx;
                if (y > _heights[i]) _heights[i] = y;
            }
        }
    }
}

// Bilinearly sample the baked heightmap. Clamps to the terrain edge outside its
// bounds so distant (foggy) regions stay flat rather than reading garbage.
function terrainHeightAt(x, z) {
    const fx = ((x - TERRAIN_MIN_X) / TERRAIN_SIZE_X) * (HMAP_RES - 1);
    const fz = ((z - TERRAIN_MIN_Z) / TERRAIN_SIZE_Z) * (HMAP_RES - 1);
    const cx = Math.min(HMAP_RES - 1, Math.max(0, fx));
    const cz = Math.min(HMAP_RES - 1, Math.max(0, fz));
    const x0 = Math.floor(cx), z0 = Math.floor(cz);
    const x1 = Math.min(HMAP_RES - 1, x0 + 1), z1 = Math.min(HMAP_RES - 1, z0 + 1);
    const tx = cx - x0, tz = cz - z0;
    const h00 = _heights[z0 * HMAP_RES + x0], h10 = _heights[z0 * HMAP_RES + x1];
    const h01 = _heights[z1 * HMAP_RES + x0], h11 = _heights[z1 * HMAP_RES + x1];
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
}

// Height texture for the grass vertex shader. Stored as 8-bit normalized R
// (decoded with uHeightMin/uHeightRange in the shader) so linear filtering is
// supported everywhere — float-texture linear filtering isn't guaranteed on
// mobile GPUs. 8 bits over the shallow terrain range is plenty for grass.
let TERRAIN_HEIGHT_MIN = Infinity, TERRAIN_HEIGHT_MAX = -Infinity;
for (let i = 0; i < _heights.length; i++) {
    if (_heights[i] < TERRAIN_HEIGHT_MIN) TERRAIN_HEIGHT_MIN = _heights[i];
    if (_heights[i] > TERRAIN_HEIGHT_MAX) TERRAIN_HEIGHT_MAX = _heights[i];
}
const TERRAIN_HEIGHT_RANGE = Math.max(1e-4, TERRAIN_HEIGHT_MAX - TERRAIN_HEIGHT_MIN);
const _heightBytes = new Uint8Array(_heights.length);
for (let i = 0; i < _heights.length; i++) {
    _heightBytes[i] = Math.round(
        ((_heights[i] - TERRAIN_HEIGHT_MIN) / TERRAIN_HEIGHT_RANGE) * 255,
    );
}
const terrainHeightTexture = new THREE.DataTexture(
    _heightBytes, HMAP_RES, HMAP_RES, THREE.RedFormat, THREE.UnsignedByteType,
);
terrainHeightTexture.minFilter = THREE.LinearFilter;
terrainHeightTexture.magFilter = THREE.LinearFilter;
terrainHeightTexture.wrapS = THREE.ClampToEdgeWrapping;
terrainHeightTexture.wrapT = THREE.ClampToEdgeWrapping;
terrainHeightTexture.needsUpdate = true;

// Trimesh data for the physics ground collider (exact match to the visuals).
function buildTerrainTrimesh(mesh) {
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const m = mesh.matrixWorld;
    const v = new THREE.Vector3();
    const vertices = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(m);
        vertices[i * 3] = v.x; vertices[i * 3 + 1] = v.y; vertices[i * 3 + 2] = v.z;
    }
    let indices;
    if (geo.index) {
        indices = new Uint32Array(geo.index.array);
    } else {
        indices = new Uint32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) indices[i] = i;
    }
    return { vertices, indices };
}
const terrainTrimesh = buildTerrainTrimesh(terrainMesh);

// Touch devices (phones/tablets) tend to have far less GPU memory and fill rate,
// so we lighten the heaviest work (grass vertex count + pixel ratio) for them.
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

// Live-tunable parameters, exposed through the lil-gui panel below.
const params = {
    orbRadius: 0.008,
    orbLightIntensity: 1.5,
    orbLightColor: '#ccccff',
    sceneShadowsEnabled: true, // terrain / boxes / trees cast + receive shadows
    grassShadowsEnabled: false, // grass casts + receives shadows
    moveSpeed: 2.5,
    accelRate: 4,
    jumpThrustAccel: 30,
    jumpThrustTime: 0.18,
    gravityUp: 9,
    gravityDown: 4,
    trailRadius: 0.008,
    trailLifetime: 1.4,
    trailSpacing: 0.01,
    trailColor: '#b0bcff',
    bobXZ: 0.015,
    bobY: 0.025,
    bobIdleBoost: 5, // extra bob amplitude multiplier when idle vs moving
    bobResponse: 6,    // how fast bob amplitude eases in/out (lower = gentler)
    particleLightColor: '#ccccff',
    boxColor: '#ffffff',
    fogColor: '#8a8aff',      // soft blue-white haze
    fogDensity: 0.086,
    dofBlur: 2.5,             // max edge blur radius (texels)
    dofStart: 0.45,           // where the blur begins (0 = center, 1 = corner)
    // Density is the dominant cost: 940² ≈ 880K blades (~3.5M verts, ~42 MB buffer);
    // low-memory mobile GPUs may fail to allocate larger fields, dropping the mesh.
    grassDensity: isTouchDevice ? 700 : 940, // patch subdivisions per axis
    grassHeight: 0.26,        // blade height (scene is small-scale)
    grassHeightVariation: 0.6,   // how strongly coherent noise drives blade height (0 = uniform)
    grassHeightNoiseScale: 0.06, // spatial frequency of the height-clump noise
    grassHeightRand: 0.3,        // extra per-blade height jitter on top of the noise
    grassWidth: 0.04,         // blade base half-width
    terrainColor: '#26242e',  // default terrain tint, applied to the model's material after load
    pathEnabled: true,        // paint path.png onto the feature map's red areas
    pathTiling: 28,           // how many times the path texture repeats across the terrain
    pathTint: '#ffffff',      // multiplier tint applied to the path texture
    pathOpacity: 0.2,         // how strongly the path texture overrides the terrain
    // Patchiness: FBM noise erodes the path so it reads as old / unkempt, with
    // bare ground showing through irregular gaps in the cobbles.
    pathPatchiness: 1.0,      // 0 = solid path, 1 = fully noise-eroded
    pathNoiseScale: 1.8,      // world-space frequency of the patch noise
    pathSparseness: 0.5,      // higher = sparser path (more ground shows through)
    pathSparseStrength: 0.0,  // path opacity inside the eroded gaps (0 = bare ground)
    pathEdgeFade: 3.0,        // soften the path→terrain boundary over this many feature-map texels
    // 4-octave fBm ("Perlin") mottling painted onto the bare terrain wherever the
    // tiled path isn't covering it, for ground colour variation.
    terrainNoiseEnabled: true,
    terrainNoiseScale: 1.8,     // world-space frequency of the terrain noise
    terrainNoiseContrast: 1.5,  // hardness of the light/dark mottling (1 = linear)
    terrainNoiseStrength: 0.25, // brightness variation amount around the base tint
    grassColorBase: '#342b4a',// shaded blade base
    grassColorTip: '#615c7a', // lit blade tip
    grassFeatureMaskEnabled: true, // restrict grass to the feature map's green areas
    grassEdgeSoftness: 3.0,   // rim ramp width in feature-map texels: rows over which height climbs to full
    grassEdgeShrink: 0.5,     // height multiplier applied to the outermost rim row (1 = no change)
    grassEdgeJitter: 0.35,    // per-blade height scatter on the rim so it blends in instead of a clean band
    grassEdgeLighten: 0.05,   // how much lighter (toward white) the outermost edge grass is
    grassWindStrength: 0.9,   // sway amplitude
    grassLightRange: 4.0,     // how far the orb glow reaches the grass
    // Light repulsor: the orb's light shoves nearby blade apexes away from it,
    // logarithmic falloff out to grassRepulsorRadius, diminished as the light
    // floats higher above the grass.
    grassRepulsorStrength: 0.08, // max horizontal apex push (world units)
    grassRepulsorRadius: 5.0,    // horizontal reach of the repulsor (world units)
    grassRepulsorAltFalloff: 4.0,// how strongly the light's altitude weakens it
    // Scattered trees — one InstancedMesh per source sub-mesh (lightweight).
    treeCount: 60,            // number of scattered trees
    treeHeight: 1.25,         // target world height the model is normalised to
    treeAreaRadius: 21,       // trees scatter within this radius of spawn
    treeClearing: 4,          // keep a clear circle around spawn (no trees)
    // World boundary: roam too far from spawn and a thick fog rolls in and
    // whisks you back. Radial (distance from spawn), not tied to the plane edges.
    boundaryEnabled: true,
    boundaryRadius: 22,        // distance from spawn that triggers the respawn
    boundaryWarnRadius: 16,    // distance where the warning haze starts creeping in
    boundaryWarnOpacity: 0.35, // peak haze opacity in the warning zone
    respawnFadeOut: 0.8,       // seconds to fade to a full white-out
    respawnFadeIn: 1.2,        // seconds to fade back in after respawning
    // Water (layer 1: ripples) — white depth-contour bands drifting across a
    // transparent plane. Shore foam / colouring / refraction come in later
    // layers. Depth scale is the world-unit distance below the surface that
    // maps to "deepest" (fixed, so band density stays put when the elevation
    // slider moves).
    waterElevation: -0.17,
    waterDepthScale: 0.75,
    waterColor: '#000000',       // ripple band colour
    waterFlowSpeed: 0.085,       // localTime advance per second
    waterRipplesRatio: 0.41,     // 0..1 master fade (future weather hook)
    waterSlopeFrequency: 10,     // number of bands across the depth range
    waterNoiseFrequency: 0.785,  // wobble texture scale (world XZ multiplier)
    waterNoiseOffset: 0.345,     // per-band noise offset divisor
};

const scene = new THREE.Scene();
// Foggy atmosphere: the sky/background and exponential fog share a colour so
// the scene dissolves into the haze toward the horizon.
const skyColor = new THREE.Color(params.fogColor);
scene.background = skyColor;
scene.fog = new THREE.FogExp2(skyColor.clone(), params.fogDensity);

const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    200
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
// Desktop: floor the pixel ratio at 2 to supersample low-DPI displays for crisp
// edges. Touch devices already ship high-DPI screens, so cap (not floor) their
// ratio at 2 — forcing a 3× phone through the HDR composer is a fill-rate killer
// that can starve heavy draws like the grass.
renderer.setPixelRatio(
    isTouchDevice
        ? Math.min(window.devicePixelRatio, 2)
        : Math.max(window.devicePixelRatio, 2)
);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
// Omnidirectional shadows: the orb's point light casts into a cube depth map.
// PCF soft filtering softens the cube-map edges a little.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// --- Post-processing: fake depth-of-field via a radial edge blur ---
// A separable Gaussian blur whose strength ramps from zero at the screen centre
// to uMaxBlur at the corners. The centre stays crisp (sample offsets collapse to
// zero, weights sum to 1 → no-op) so it reads as a shallow depth of field
// without the cost of a true depth-based bokeh pass. Run as two passes
// (horizontal then vertical) which together form a 2D blur cheaply.
const RadialBlurShader = {
    uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uMaxBlur: { value: params.dofBlur },
        uStart: { value: params.dofStart },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        uniform vec2 uDirection;
        uniform float uMaxBlur;
        uniform float uStart;
        varying vec2 vUv;

        void main() {
            // Normalised distance from centre: 0 at centre, 1 at a corner.
            vec2 c = vUv - 0.5;
            float dist = length(c) / 0.7071068;
            float edge = smoothstep(uStart, 1.0, dist);
            float radius = edge * uMaxBlur;

            vec2 texel = uDirection / uResolution;
            // Early-out: in the sharp central region the blur radius is ~0, so the
            // 8 offset taps would all resample the centre texel for no effect.
            // Skip them — the whole crisp area takes this branch uniformly (no
            // warp divergence), avoiding wasted texture fetches over most of the
            // screen. Threshold is sub-texel so it never clips a visible blur.
            if (radius * 4.0 < 0.5) {
                gl_FragColor = texture2D(tDiffuse, vUv);
                return;
            }

            // 9-tap Gaussian (weights sum to 1).
            vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
            vec2 o1 = texel * radius;
            vec2 o2 = texel * radius * 2.0;
            vec2 o3 = texel * radius * 3.0;
            vec2 o4 = texel * radius * 4.0;
            sum += texture2D(tDiffuse, vUv + o1) * 0.1945946;
            sum += texture2D(tDiffuse, vUv - o1) * 0.1945946;
            sum += texture2D(tDiffuse, vUv + o2) * 0.1216216;
            sum += texture2D(tDiffuse, vUv - o2) * 0.1216216;
            sum += texture2D(tDiffuse, vUv + o3) * 0.054054;
            sum += texture2D(tDiffuse, vUv - o3) * 0.054054;
            sum += texture2D(tDiffuse, vUv + o4) * 0.016216;
            sum += texture2D(tDiffuse, vUv - o4) * 0.016216;
            gl_FragColor = sum;
        }
    `,
};

// Offscreen HDR buffer for the post chain (composer's default target is already
// HalfFloat). No MSAA here: pixel-ratio supersampling smooths geometry edges,
// and the final SMAA pass cleans up remaining luminance edges far more cheaply.
const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
composer.addPass(new RenderPass(scene, camera));

const blurH = new ShaderPass(RadialBlurShader);
blurH.uniforms.uDirection.value.set(1, 0);
composer.addPass(blurH);

const blurV = new ShaderPass(RadialBlurShader);
blurV.uniforms.uDirection.value.set(0, 1);
composer.addPass(blurV);

// Applies tone mapping + sRGB conversion at the end of the chain, since the
// composer's render targets bypass the renderer's automatic output conversion.
composer.addPass(new OutputPass());

// Post-process antialiasing on the final sRGB image. SMAA smooths luminance
// edges (incl. the thin, very high-contrast glow trail) that MSAA's limited
// coverage samples still leave stepped — far cheaper than supersampling. Sized
// in device pixels; EffectComposer.setSize keeps it in sync on resize.
const smaaPass = new SMAAPass(
    window.innerWidth * renderer.getPixelRatio(),
    window.innerHeight * renderer.getPixelRatio(),
);
composer.addPass(smaaPass);

const dofPasses = [blurH, blurV];
function syncComposerSize() {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
    const pr = renderer.getPixelRatio();
    const w = window.innerWidth * pr;
    const h = window.innerHeight * pr;
    for (const p of dofPasses) p.uniforms.uResolution.value.set(w, h);
}
syncComposerSize();

// Rolling terrain ground (from terrain.glb), replacing the old flat plane.
// Swap the GLB's Blender-authored material for a stock THREE.MeshLambertMaterial
// (cheap non-PBR diffuse shading). Dithering is enabled to avoid colour banding
// in the dark terrain-to-fog gradient, and the colour is tinted below from
// params.terrainColor.
// Path texturing: where the feature map's red channel dominates, the terrain is
// painted with the tiling path.png cobblestone texture instead of the flat tint.
// Both the feature map and the path texture are sampled in the terrain material's
// fragment shader (injected via onBeforeCompile), using the same XZ→feature UV
// mapping the grass shader uses so paths line up exactly with the grass cutouts.
const terrainFeatureMap = new THREE.TextureLoader().load(featureMapUrl);
terrainFeatureMap.colorSpace = THREE.NoColorSpace;
terrainFeatureMap.wrapS = THREE.ClampToEdgeWrapping;
terrainFeatureMap.wrapT = THREE.ClampToEdgeWrapping;
terrainFeatureMap.minFilter = THREE.LinearFilter;
terrainFeatureMap.magFilter = THREE.LinearFilter;
terrainFeatureMap.flipY = false;

const pathTexture = new THREE.TextureLoader().load(pathMapUrl);
pathTexture.colorSpace = THREE.SRGBColorSpace;
pathTexture.wrapS = THREE.RepeatWrapping;
pathTexture.wrapT = THREE.RepeatWrapping;

// Shared uniform objects so the GUI can tweak the path live across every
// terrain sub-material (they all reference the same value objects).
const pathUniforms = {
    uPathMap: { value: pathTexture },
    uPathFeatureMap: { value: terrainFeatureMap },
    uPathTerrainMin: { value: new THREE.Vector2(TERRAIN_MIN_X, TERRAIN_MIN_Z) },
    uPathTerrainSize: { value: new THREE.Vector2(TERRAIN_SIZE_X, TERRAIN_SIZE_Z) },
    uPathTiling: { value: params.pathTiling },
    uPathEnabled: { value: params.pathEnabled ? 1 : 0 },
    uPathTint: { value: new THREE.Color(params.pathTint) },
    uPathOpacity: { value: params.pathOpacity },
    uPathPatchiness: { value: params.pathPatchiness },
    uPathNoiseScale: { value: params.pathNoiseScale },
    uPathSparseness: { value: params.pathSparseness },
    uPathSparseStrength: { value: params.pathSparseStrength },
    uPathEdgeFade: { value: params.pathEdgeFade },
    uTerrainNoiseEnabled: { value: params.terrainNoiseEnabled ? 1 : 0 },
    uTerrainNoiseScale: { value: params.terrainNoiseScale },
    uTerrainNoiseContrast: { value: params.terrainNoiseContrast },
    uTerrainNoiseStrength: { value: params.terrainNoiseStrength },
};

function applyPathShader(mat) {
    mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, pathUniforms);

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                '#include <common>\nvarying vec3 vPathWorld;',
            )
            .replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\nvPathWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
                varying vec3 vPathWorld;
                uniform sampler2D uPathMap;
                uniform sampler2D uPathFeatureMap;
                uniform vec2 uPathTerrainMin;
                uniform vec2 uPathTerrainSize;
                uniform float uPathTiling;
                uniform float uPathEnabled;
                uniform vec3 uPathTint;
                uniform float uPathOpacity;
                uniform float uPathPatchiness;
                uniform float uPathNoiseScale;
                uniform float uPathSparseness;
                uniform float uPathSparseStrength;
                uniform float uPathEdgeFade;
                uniform float uTerrainNoiseEnabled;
                uniform float uTerrainNoiseScale;
                uniform float uTerrainNoiseContrast;
                uniform float uTerrainNoiseStrength;

                // Red-channel path coverage at a feature-map UV, in [0,1].
                float pathRed(vec2 uv) {
                    vec3 fc = texture2D(uPathFeatureMap, uv).rgb;
                    return smoothstep(0.02, 0.25, fc.r - max(fc.g, fc.b));
                }

                float pathHash21(vec2 p) {
                    p = fract(p * vec2(123.34, 345.45));
                    p += dot(p, p + 34.345);
                    return fract(p.x * p.y);
                }
                float pathVNoise(vec2 p) {
                    vec2 i = floor(p);
                    vec2 f = fract(p);
                    f = f * f * (3.0 - 2.0 * f);
                    float a = pathHash21(i);
                    float b = pathHash21(i + vec2(1.0, 0.0));
                    float c = pathHash21(i + vec2(0.0, 1.0));
                    float d = pathHash21(i + vec2(1.0, 1.0));
                    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
                }
                float pathFbm(vec2 p) {
                    float v = 0.0;
                    float amp = 0.5;
                    for (int i = 0; i < 4; i++) {
                        v += amp * pathVNoise(p);
                        p *= 2.0;
                        amp *= 0.5;
                    }
                    return v;
                }
                // Ground-noise fBm: each octave steps up 4x in frequency.
                float terrainFbm(vec2 p) {
                    float v = 0.0;
                    float amp = 0.5;
                    for (int i = 0; i < 4; i++) {
                        v += amp * pathVNoise(p);
                        p *= 4.0;
                        amp *= 0.5;
                    }
                    return v;
                }`,
            )
            .replace(
                'vec4 diffuseColor = vec4( diffuse, opacity );',
                `vec4 diffuseColor = vec4( diffuse, opacity );
                float tileAmount = 0.0; // how much tiled path covers this fragment
                if (uPathEnabled > 0.5) {
                    vec2 featUV = (vPathWorld.xz - uPathTerrainMin) / uPathTerrainSize;
                    float inside = step(0.0, featUV.x) * step(featUV.x, 1.0) *
                                   step(0.0, featUV.y) * step(featUV.y, 1.0);
                    // Soft edge: average the red coverage over a small cross so the
                    // path→terrain boundary fades over uPathEdgeFade feature-map
                    // texels instead of snapping across one (fade 0 = hard edge).
                    vec2 fade = uPathEdgeFade / vec2(textureSize(uPathFeatureMap, 0));
                    float cov = pathRed(featUV);
                    cov += pathRed(featUV + vec2( fade.x, 0.0));
                    cov += pathRed(featUV + vec2(-fade.x, 0.0));
                    cov += pathRed(featUV + vec2(0.0,  fade.y));
                    cov += pathRed(featUV + vec2(0.0, -fade.y));
                    float pathMask = (cov / 5.0) * inside;
                    // Erode the path with FBM noise so it looks old / patchy.
                    float n = pathFbm(vPathWorld.xz * uPathNoiseScale);
                    float patchMask = smoothstep(uPathSparseness - 0.18, uPathSparseness + 0.18, n);
                    // floorVal = path opacity in fully eroded gaps. uPathPatchiness
                    // scales how far the gaps erode toward uPathSparseStrength
                    // (patchiness 0 = solid path everywhere).
                    float floorVal = mix(1.0, uPathSparseStrength, uPathPatchiness);
                    pathMask *= mix(floorVal, 1.0, patchMask);
                    vec3 pathCol = texture2D(uPathMap, featUV * uPathTiling).rgb * uPathTint;
                    tileAmount = pathMask * uPathOpacity;
                    diffuseColor.rgb = mix(diffuseColor.rgb, pathCol, tileAmount);
                }
                // Perlin/fBm mottling on the bare ground (where no tiles cover it).
                if (uTerrainNoiseEnabled > 0.5) {
                    float tn = terrainFbm(vPathWorld.xz * uTerrainNoiseScale);
                    // Recentre to [-0.5,0.5], push contrast, clamp back to [0,1].
                    tn = clamp((tn - 0.5) * uTerrainNoiseContrast + 0.5, 0.0, 1.0);
                    float m = 1.0 + (tn - 0.5) * 2.0 * uTerrainNoiseStrength;
                    diffuseColor.rgb *= mix(1.0, m, 1.0 - tileAmount);
                }`,
            );
    };
    mat.needsUpdate = true;
}

const terrainMaterials = []; // collected so the GUI can recolour the terrain
terrainMesh.traverse((o) => {
    if (o.isMesh && o.material) {
        o.castShadow = true;    // hills shadow the grass / each other
        o.receiveShadow = true; // the ground catches the orb's cast shadows
        // Dispose the authored material(s) we're replacing to free GPU resources.
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            m.dispose();
        }
        const mat = new THREE.MeshLambertMaterial();
        mat.dithering = true;
        applyPathShader(mat);
        o.material = mat;
        terrainMaterials.push(mat);
    }
});
scene.add(terrainMesh);

// Apply the default terrain colour to the authored material(s) so the scene
// opens on it. The GUI picker (seeded from the same param) tweaks it live.
for (const mat of terrainMaterials) if (mat.color) mat.color.set(params.terrainColor);

// Tiny glowing orb — same radius as the trail tube so they sit flush
const orb = new THREE.Mesh(
    new THREE.SphereGeometry(params.orbRadius, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
);
scene.add(orb);

// A point light at the orb to faintly illuminate the floor around it
const orbLight = new THREE.PointLight(params.orbLightColor, params.orbLightIntensity, 5.0, 2);
// Omnidirectional depth-mapped shadow. A PointLight shadow renders the scene
// into the six faces of a cube depth map; mapSize is the per-face resolution, so
// 1024² gives 1024×1024 on each face. Dropping from 2048² to 1024² cuts the
// per-frame shadow rasterisation 4×. The shadow camera spans from just outside
// the orb to the edge of its light reach.
orbLight.castShadow = true;
orbLight.shadow.mapSize.set(1024, 1024);
orbLight.shadow.camera.near = 0.02;
orbLight.shadow.camera.far = 6;
orbLight.shadow.bias = -0.002;
orbLight.shadow.normalBias = 0.02;
orb.add(orbLight);

// Hover + bobbing — the orb floats a fixed gap above the terrain surface and
// drifts with sine noise. Spawn at the origin, lifted to the local ground.
const HOVER_HEIGHT = 0.3;
const targetPos = new THREE.Vector3(0, terrainHeightAt(0, 0) + HOVER_HEIGHT, 0);
orb.position.copy(targetPos);
const SPAWN = targetPos.clone(); // original spawn point for the boundary respawn

// Physics — kinematic orb pushes dynamic boxes via Rapier
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// Ground: a static trimesh matching the terrain surface exactly, so boxes rest
// on the real hills and valleys rather than a flat plane.
const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(
    RAPIER.ColliderDesc.trimesh(terrainTrimesh.vertices, terrainTrimesh.indices),
    groundBody,
);

// Orb collider is larger than the visible dot so it feels like the glow
// is what shoves boxes around. Kinematic so the existing motion code owns it.
const ORB_PHYS_RADIUS = 0.08;
const orbBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        targetPos.x,
        targetPos.y,
        targetPos.z,
    ),
);
world.createCollider(RAPIER.ColliderDesc.ball(ORB_PHYS_RADIUS), orbBody);

// Dynamic boxes scattered nearby. Slight color variation so the orb's
// blue/purple point light reads on each face.
const BOX_SIZE = 0.3;
const boxGeo = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
const boxMat = new THREE.MeshPhysicalMaterial({
    color: params.boxColor,
    roughness: 0.35,
    metalness: 0.05,
    clearcoat: 0.7,
    clearcoatRoughness: 0.15,
    dithering: true,
});
const boxes = [];
const BOX_LAYOUT = [
    [ 1.2, 0.8],
    [-1.0, -1.3],
    [ 0.6, -1.8],
    [-1.6, 1.0],
    [ 1.9, -0.4],
    [-0.3, 1.7],
    [ 2.4, 1.4],
];
for (const [x, z] of BOX_LAYOUT) {
    const mesh = new THREE.Mesh(boxGeo, boxMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            // Spawn just above the local terrain surface so boxes settle onto it.
            .setTranslation(x, terrainHeightAt(x, z) + BOX_SIZE / 2 + 0.05, z)
            .setLinearDamping(0.4)
            .setAngularDamping(0.6),
    );
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(BOX_SIZE / 2, BOX_SIZE / 2, BOX_SIZE / 2)
            .setRestitution(0.1)
            .setFriction(0.8),
        body,
    );
    boxes.push({ mesh, body });
}

// Continuous emissive trail — a camera-facing 2D ribbon ("card") instead of a
// 3D tube. Each trail point emits just two vertices, offset perpendicular to
// both the path direction and the view direction, so the strip always faces the
// camera. This is far lighter than a TubeGeometry (2 verts/point vs a full ring,
// and no Frenet-frame math or curve resampling), and the buffers are allocated
// once and updated in place to avoid per-frame geometry allocation/GC.
const TRAIL_COLOR = new THREE.Color(params.trailColor);

const trailPoints = []; // [{ pos: Vector3, age: number }]
const lastTrailPos = orb.position.clone();

let trailCapacity = 256; // max trail points the buffers can hold; grows on demand
const trailGeometry = new THREE.BufferGeometry();
let trailPositions = new Float32Array(trailCapacity * 2 * 3);
let trailColors = new Float32Array(trailCapacity * 2 * 3);
trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
trailGeometry.setAttribute('color', new THREE.BufferAttribute(trailColors, 3));

// The vertex layout is regular (2 verts per point), so the index buffer only
// depends on capacity, not on the live point count — build it once per capacity.
function buildTrailIndices(capacity) {
    const idx = new Uint32Array(Math.max(0, capacity - 1) * 6);
    for (let i = 0; i < capacity - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        const o = i * 6;
        idx[o] = a; idx[o + 1] = b; idx[o + 2] = c;
        idx[o + 3] = b; idx[o + 4] = d; idx[o + 5] = c;
    }
    return idx;
}
trailGeometry.setIndex(new THREE.BufferAttribute(buildTrailIndices(trailCapacity), 1));

const trailMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
});
const trailMesh = new THREE.Mesh(trailGeometry, trailMaterial);
trailMesh.frustumCulled = false;
trailMesh.visible = false;
// The emissive trail is a glow ribbon, not an occluder — keep it out of the
// shadow pass so it never casts a shadow from the orb light.
trailMesh.castShadow = false;
trailMesh.receiveShadow = false;
scene.add(trailMesh);

// Reused scratch vectors so the per-frame update allocates nothing.
const _tan = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _side = new THREE.Vector3();

function growTrailCapacity(needed) {
    while (trailCapacity < needed) trailCapacity *= 2;
    trailPositions = new Float32Array(trailCapacity * 2 * 3);
    trailColors = new Float32Array(trailCapacity * 2 * 3);
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(trailColors, 3));
    trailGeometry.setIndex(new THREE.BufferAttribute(buildTrailIndices(trailCapacity), 1));
}

function updateTrail(dt) {
    if (orb.position.distanceTo(lastTrailPos) > params.trailSpacing) {
        trailPoints.push({ pos: orb.position.clone(), age: 0 });
        lastTrailPos.copy(orb.position);
    }

    for (const p of trailPoints) p.age += dt;
    while (trailPoints.length > 0 && trailPoints[0].age >= params.trailLifetime) {
        trailPoints.shift();
    }

    // Anchor the tip at the orb's current position so the ribbon stays attached
    // even between spawns / when stopped. The tip is treated as a virtual extra
    // point rather than allocating a new array each frame.
    const n = trailPoints.length;
    const needTip =
        n === 0 || orb.position.distanceToSquared(trailPoints[n - 1].pos) > 1e-8;
    const count = n + (needTip ? 1 : 0);

    if (count < 2) {
        trailMesh.visible = false;
        return;
    }
    if (count > trailCapacity) growTrailCapacity(count);

    const halfWidth = params.trailRadius;
    const lifetime = params.trailLifetime;
    const posAt = (j) => (j < n ? trailPoints[j].pos : orb.position);
    const ageAt = (j) => (j < n ? trailPoints[j].age : 0);

    for (let j = 0; j < count; j++) {
        const cur = posAt(j);
        // Path tangent from neighbouring points.
        _tan.subVectors(posAt(Math.min(count - 1, j + 1)), posAt(Math.max(0, j - 1)));
        if (_tan.lengthSq() < 1e-12) _tan.set(1, 0, 0);
        _tan.normalize();

        // Offset perpendicular to both the path and the view direction so the
        // ribbon presents its flat face to the camera.
        _camDir.subVectors(camera.position, cur);
        _side.crossVectors(_tan, _camDir);
        if (_side.lengthSq() < 1e-12) {
            _side.set(-_tan.z, 0, _tan.x); // fallback when path points at camera
            if (_side.lengthSq() < 1e-12) _side.set(1, 0, 0);
        }
        _side.normalize().multiplyScalar(halfWidth);

        const k = Math.max(0, 1 - ageAt(j) / lifetime);
        const r = TRAIL_COLOR.r * k, g = TRAIL_COLOR.g * k, b = TRAIL_COLOR.b * k;

        const vi = j * 6;
        trailPositions[vi]     = cur.x + _side.x;
        trailPositions[vi + 1] = cur.y + _side.y;
        trailPositions[vi + 2] = cur.z + _side.z;
        trailPositions[vi + 3] = cur.x - _side.x;
        trailPositions[vi + 4] = cur.y - _side.y;
        trailPositions[vi + 5] = cur.z - _side.z;

        trailColors[vi] = r; trailColors[vi + 1] = g; trailColors[vi + 2] = b;
        trailColors[vi + 3] = r; trailColors[vi + 4] = g; trailColors[vi + 5] = b;
    }

    trailGeometry.setDrawRange(0, (count - 1) * 6);
    trailGeometry.attributes.position.needsUpdate = true;
    trailGeometry.attributes.color.needsUpdate = true;
    trailMesh.visible = true;
}

// Subtle ambient + hemisphere fill so the floor isn't pitch black everywhere.
// Kept as references so the GUI can tune their intensities live.
const ambientLight = new THREE.AmbientLight(0xffffff, 0.08);
scene.add(ambientLight);
const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x101010, 0.15);
scene.add(hemisphereLight);

// Floating dust particles — a single GPU point cloud (one draw call) whose
// brightness reacts to the orb's light. Lighting and drift are computed in the
// shader from the orb position, so the only per-frame CPU cost is two uniforms.
const PARTICLE_COUNT = 600;
const PARTICLE_AREA = 6;        // half-extent of the spawn volume in X/Z
const PARTICLE_Y_MIN = 0.15;
const PARTICLE_Y_MAX = 4.0;
const PARTICLE_LIGHT_RANGE = 5.0; // how far the orb's glow reaches a particle

const particleGeo = new THREE.BufferGeometry();
const pPositions = new Float32Array(PARTICLE_COUNT * 3);
const pSizes = new Float32Array(PARTICLE_COUNT);
const pDrift = new Float32Array(PARTICLE_COUNT * 3);
const pPhase = new Float32Array(PARTICLE_COUNT);
for (let i = 0; i < PARTICLE_COUNT; i++) {
    pPositions[i * 3 + 0] = (Math.random() * 2 - 1) * PARTICLE_AREA;
    pPositions[i * 3 + 1] = PARTICLE_Y_MIN + Math.random() * (PARTICLE_Y_MAX - PARTICLE_Y_MIN);
    pPositions[i * 3 + 2] = (Math.random() * 2 - 1) * PARTICLE_AREA;
    pSizes[i] = 0.8 + Math.random() * 1.8;
    pDrift[i * 3 + 0] = 0.1 + Math.random() * 0.3;
    pDrift[i * 3 + 1] = 0.08 + Math.random() * 0.22;
    pDrift[i * 3 + 2] = 0.1 + Math.random() * 0.3;
    pPhase[i] = Math.random() * Math.PI * 2;
}
particleGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
particleGeo.setAttribute('aSize', new THREE.BufferAttribute(pSizes, 1));
particleGeo.setAttribute('aDrift', new THREE.BufferAttribute(pDrift, 3));
particleGeo.setAttribute('aPhase', new THREE.BufferAttribute(pPhase, 1));

const particleMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
        uTime: { value: 0 },
        uOrbPos: { value: new THREE.Vector3() },
        uLightColor: { value: new THREE.Color(0xccccff) },
        uAmbient: { value: new THREE.Color(0x000000) },
        uLightRange: { value: PARTICLE_LIGHT_RANGE },
        uSizeScale: { value: 7.0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uHalfExtent: { value: PARTICLE_AREA },
    },
    vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uOrbPos;
        uniform float uLightRange;
        uniform float uSizeScale;
        uniform float uPixelRatio;
        uniform float uHalfExtent;
        attribute float aSize;
        attribute vec3 aDrift;
        attribute float aPhase;
        varying float vAtten;
        varying float vTwinkle;
        varying float vEdgeFade;

        void main() {
            vec3 p = position;
            // Wrap the static particle field toroidally around the orb so the
            // same point cloud always surrounds the camera target — infinite
            // coverage as you roam, without spawning more particles. Particles
            // that wrap teleport across the far edge of the region.
            float span = uHalfExtent * 2.0;
            p.x = mod(p.x - uOrbPos.x + uHalfExtent, span) - uHalfExtent + uOrbPos.x;
            p.z = mod(p.z - uOrbPos.z + uHalfExtent, span) - uHalfExtent + uOrbPos.z;
            // Fade alpha to zero in the outer band of the region so a particle
            // is fully invisible at the instant it wraps across an edge — kills
            // the faint ambient "pop" the lighting term alone wouldn't hide.
            float edge = max(abs(p.x - uOrbPos.x), abs(p.z - uOrbPos.z)) / uHalfExtent;
            vEdgeFade = smoothstep(1.0, 0.85, edge);
            // Bounded floating drift, fully GPU-side (no CPU updates).
            p.x += sin(uTime * 0.30 + aPhase) * aDrift.x;
            p.y += sin(uTime * 0.40 + aPhase * 1.7) * aDrift.y;
            p.z += cos(uTime * 0.35 + aPhase * 1.3) * aDrift.z;

            // Quadratic falloff from the orb — this is the "light reaction".
            float d = distance(p, uOrbPos);
            float a = clamp(1.0 - d / uLightRange, 0.0, 1.0);
            vAtten = a * a;
            vTwinkle = 0.75 + 0.25 * sin(uTime * 1.5 + aPhase * 3.0);

            vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = aSize * uSizeScale * uPixelRatio / -mvPosition.z;
            gl_Position = projectionMatrix * mvPosition;
        }
    `,
    fragmentShader: /* glsl */ `
        uniform vec3 uLightColor;
        uniform vec3 uAmbient;
        varying float vAtten;
        varying float vTwinkle;
        varying float vEdgeFade;

        void main() {
            vec2 uv = gl_PointCoord - 0.5;
            float r = length(uv);
            if (r > 0.5) discard;
            float soft = smoothstep(0.5, 0.0, r);
            vec3 col = uAmbient + uLightColor * vAtten;
            float alpha = soft * (0.12 + vAtten) * vTwinkle * vEdgeFade;
            gl_FragColor = vec4(col, alpha);
        }
    `,
});

const particles = new THREE.Points(particleGeo, particleMaterial);
particles.frustumCulled = false;
scene.add(particles);

// ----------------------------------------------------------------------------
// Grass — one static non-indexed mesh whose triangles become camera-facing
// blades in the vertex shader. A 2D ground centre is stored per blade; a mod()
// wrap around a per-frame centre uniform tiles a finite patch infinitely so the
// field follows the orb and looks endless with a constant blade count.
// Ported from the WebGPU/TSL guide to WebGL2 GLSL (RawShaderMaterial, GLSL3).
// ----------------------------------------------------------------------------

// Tileable fractal value-noise texture (single channel, RepeatWrapping) used for
// both broad height variation and the scrolling wind. Generated once on the CPU.
function makeNoiseTexture(size = 256, basePeriod = 8) {
    const hash = (ix, iz, period) => {
        ix = ((ix % period) + period) % period;
        iz = ((iz % period) + period) % period;
        let h = (ix * 374761393 + iz * 668265263) | 0;
        h = (h ^ (h >> 13)) * 1274126177;
        h = h ^ (h >> 16);
        return ((h >>> 0) / 4294967295);
    };
    const valueNoise = (x, z, period) => {
        const x0 = Math.floor(x), z0 = Math.floor(z);
        const fx = x - x0, fz = z - z0;
        const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
        const v00 = hash(x0, z0, period), v10 = hash(x0 + 1, z0, period);
        const v01 = hash(x0, z0 + 1, period), v11 = hash(x0 + 1, z0 + 1, period);
        const a = v00 + (v10 - v00) * sx;
        const b = v01 + (v11 - v01) * sx;
        return a + (b - a) * sz;
    };
    // Single channel: only the red channel is ever sampled, so a 1-byte/texel
    // R8 texture uses a quarter of the memory of RGBA for the same result.
    const data = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x / size, v = y / size;
            // Sum octaves; each octave's lattice period scales with frequency so
            // the result still tiles seamlessly across the texture edges.
            let amp = 0.5, sum = 0, norm = 0;
            for (let o = 0; o < 4; o++) {
                const period = basePeriod * (1 << o);
                sum += valueNoise(u * period, v * period, period) * amp;
                norm += amp;
                amp *= 0.5;
            }
            const n = Math.max(0, Math.min(1, sum / norm));
            data[y * size + x] = Math.round(n * 255);
        }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}
const grassNoise = makeNoiseTexture();

const GRASS_RADIUS = 24;              // patch half-extent (fog hides the boundary)
const GRASS_SIZE = GRASS_RADIUS * 2;

// Build the indexed cone-blade geometry for a given subdivision count (density).
// Each blade is a 3-sided cone (pyramid): 3 base vertices on the ground + 1 apex
// on top, drawn as 3 side faces. 'position' (itemSize 2) holds the blade's ground
// centre, repeated per vertex; aCorner tags apex(0) / base corners (1,2,3). The
// mesh is indexed so each blade contributes only its 4 unique vertices (the
// shader runs per unique vertex) instead of 9. Blades are placed on the GPU, so
// the tiny bounding sphere + frustumCulled=false keep Three from culling it.
function buildGrassGeometry(subdivisions) {
    const count = subdivisions * subdivisions;
    const cell = GRASS_SIZE / subdivisions;
    const VERTS = 4; // apex + 3 base corners
    const ground = new Float32Array(count * VERTS * 2);
    const corner = new Float32Array(count * VERTS);
    const heightRand = new Float32Array(count * VERTS);
    const index = new Uint32Array(count * 9); // 3 side faces × 3 verts
    let v = 0, f = 0;
    for (let iX = 0; iX < subdivisions; iX++) {
        const cellX = (iX / subdivisions - 0.5) * GRASS_SIZE + cell * 0.5;
        for (let iZ = 0; iZ < subdivisions; iZ++) {
            const cellZ = (iZ / subdivisions - 0.5) * GRASS_SIZE + cell * 0.5;
            const px = cellX + (Math.random() - 0.5) * cell;
            const pz = cellZ + (Math.random() - 0.5) * cell;
            const hr = Math.random();
            const base = v; // first vertex index of this blade
            for (let c = 0; c < VERTS; c++) {
                ground[v * 2] = px;
                ground[v * 2 + 1] = pz;
                corner[v] = c; // 0 = apex, 1..3 = base corners
                heightRand[v] = hr;
                v++;
            }
            // Three side faces, each spanning two adjacent base corners and the
            // apex (winding doesn't matter — the material is DoubleSide). The apex
            // is listed LAST in every face so it is the provoking vertex: a flat
            // varying then carries the apex-only edge factor across the whole blade.
            const apex = base, b0 = base + 1, b1 = base + 2, b2 = base + 3;
            index[f++] = b0; index[f++] = b1; index[f++] = apex;
            index[f++] = b1; index[f++] = b2; index[f++] = apex;
            index[f++] = b2; index[f++] = b0; index[f++] = apex;
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(ground, 2));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 1));
    geo.setAttribute('aHeightRand', new THREE.BufferAttribute(heightRand, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return geo;
}
const grassGeometry = buildGrassGeometry(params.grassDensity);

const grassWindAngle = Math.PI * 0.6;

// 1×1 stand-in shadow map (packed depth ≈ 1.0 → "nothing closer", i.e. fully
// lit) used until the point light has rendered its cube map for the first time,
// so the grass isn't briefly self-shadowed on frame 0.
const grassShadowFallback = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat,
);
grassShadowFallback.needsUpdate = true;

// Feature map (terrain.png): an authoring reference whose channels mark where
// scene features live — red = paths, blue = water, green = grass. It maps onto
// the same XZ region as the terrain heightmap, so the grass shader can sample it
// (NoColorSpace → read raw channel values, not gamma-decoded) and grow blades
// only where green is the dominant channel. flipY=false matches the heightmap's
// bottom-up row convention; if the orientation looks mirrored we just flip this.
const featureMap = new THREE.TextureLoader().load(featureMapUrl);
featureMap.colorSpace = THREE.NoColorSpace;
featureMap.wrapS = THREE.ClampToEdgeWrapping;
featureMap.wrapT = THREE.ClampToEdgeWrapping;
featureMap.minFilter = THREE.LinearFilter;
featureMap.magFilter = THREE.LinearFilter;
featureMap.flipY = false;

// Shared vertex-stage code for the grass. Both the visible material and the
// shadow (customDistance) material run the EXACT same displacement — cone shape,
// infinite tiling, terrain conform, height, wind and the light repulsor — so the
// cast shadow lines up perfectly with the rendered blades. grassVertex() returns
// the object-space vertex and also outputs the apex factor + world position.
const GRASS_VERTEX_HEAD = /* glsl */ `
    precision highp float;
    uniform mat4 projectionMatrix;
    uniform mat4 modelViewMatrix;
    uniform mat4 modelMatrix;
    uniform vec3 cameraPosition;

    in vec2 position;       // blade ground centre (xz)
    in float aCorner;       // 0 = apex, 1..3 = base corners
    in float aHeightRand;

    uniform vec2 uCenter;
    uniform float uSize;
    uniform float uTime;
    uniform sampler2D uNoise;
    uniform float uBladeWidth;
    uniform float uBladeHeight;
    uniform float uHeightRand;
    uniform float uHeightNoiseScale;
    uniform float uHeightVariation;
    uniform vec2 uWindDir;
    uniform float uWindStrength;
    uniform float uWindFreq;
    uniform vec3 uOrbPos;       // world-space orb light position
    uniform float uRepulsorStrength;
    uniform float uRepulsorRadius;
    uniform float uRepulsorAltFalloff;
    uniform sampler2D uHeightMap;
    uniform vec2 uTerrainMin;
    uniform vec2 uTerrainSize;
    uniform float uHeightMin;
    uniform float uHeightRange;
    uniform sampler2D uFeatureMap;  // RGB authoring mask: green channel = grass
    uniform float uFeatureMaskEnabled;
    uniform float uEdgeSoftness;    // rim ramp width in feature-map texels
    uniform float uEdgeShrink;      // height multiplier for the rim row
    uniform float uEdgeJitter;      // per-blade height scatter on the rim

    vec2 windOffset(vec2 p) {
        vec2 rp = p * uWindFreq;
        float n1 = texture(uNoise, rp * 0.2 + uWindDir * uTime).r - 0.5;
        float n2 = texture(uNoise, rp * 0.1 + uWindDir * (uTime * 0.2)).r - 0.5;
        return uWindDir * (n1 + n2) * uWindStrength;
    }

    // Greenness of the feature map at a UV: positive where grass should grow.
    float grassGreen(vec2 uv) {
        vec3 c = texture(uFeatureMap, uv).rgb;
        return c.g - max(c.r, c.b);
    }

    // Minimum greenness over the 8 neighbours on a ring of half-extent rr (UV).
    // Used for edge distance: a ring is "at an edge" once its min drops non-green.
    float ringMinGreen(vec2 uv, vec2 rr) {
        float g =        grassGreen(uv + vec2( rr.x, 0.0));
        g = min(g,       grassGreen(uv + vec2(-rr.x, 0.0)));
        g = min(g,       grassGreen(uv + vec2(0.0,  rr.y)));
        g = min(g,       grassGreen(uv + vec2(0.0, -rr.y)));
        g = min(g,       grassGreen(uv + rr));
        g = min(g,       grassGreen(uv - rr));
        g = min(g,       grassGreen(uv + vec2( rr.x, -rr.y)));
        g = min(g,       grassGreen(uv + vec2(-rr.x,  rr.y)));
        return g;
    }

    vec3 grassVertex(out float vTipOut, out vec3 vWorldOut, out float vEdgeOut) {
        vEdgeOut = 0.0;   // interior blades carry no edge tint
        // Cone blade corner: aCorner 0 = apex, 1..3 = the three base corners. A
        // per-blade yaw (from aHeightRand) spins the base triangle so the cones
        // don't all share the same orientation.
        float tip = step(aCorner, 0.5);
        float baseIdx = aCorner - 1.0;             // 0,1,2 for the base verts
        float yaw = aHeightRand * 6.2831853;
        float bAng = baseIdx * 2.0943951 + yaw;    // 120° apart + per-blade yaw
        vec2 baseDir = vec2(cos(bAng), sin(bAng));

        // Infinite tiling: wrap the blade into the patch window around centre.
        float halfSize = uSize * 0.5;
        vec2 loop = position - uCenter;
        loop.x = mod(loop.x + halfSize, uSize) - halfSize;
        loop.y = mod(loop.y + halfSize, uSize) - halfSize;
        vec3 ground = vec3(loop.x + uCenter.x, 0.0, loop.y + uCenter.y);

        vec4 worldBase = modelMatrix * vec4(ground, 1.0);
        vec2 bladeXZ = worldBase.xz;

        // Conform the blade to the terrain: lift its base to the sampled ground
        // height so the whole field drapes over the hills/valleys.
        vec2 hUV = (bladeXZ - uTerrainMin) / uTerrainSize;
        ground.y += uHeightMin + texture(uHeightMap, hUV).r * uHeightRange;

        // Height + wind only affect the apex — the three base corners stay flat
        // on the ground and don't sway. So gate their noise fetch behind the apex
        // test and skip it for 3/4 of the vertices.
        float height = 0.0;
        if (tip > 0.5) {
            // Spatially-coherent height field: a coarse octave forms broad clumps
            // of taller/shorter grass while a finer octave keeps neighbouring
            // blades from matching. Centred on 0 and scaled by uHeightVariation
            // (0 = uniform), this is the primary driver of the height variety.
            float coarse = texture(uNoise, bladeXZ * uHeightNoiseScale).r;
            float fine   = texture(uNoise, bladeXZ * uHeightNoiseScale * 4.0 + 17.3).r;
            float field  = mix(coarse, fine, 0.35);                 // ~[0,1]
            float vary   = 1.0 + (field - 0.5) * 2.0 * uHeightVariation;
            // A touch of pure per-blade randomness so clumps still read natural.
            float jitter = mix(1.0 - uHeightRand, 1.0, aHeightRand);
            height = uBladeHeight * max(vary * jitter, 0.05);
        }

        // The apex rises to 'height' above the centre; the three base corners sit
        // on the ground around it (radius = uBladeWidth), forming a cone.
        vec3 local = tip > 0.5
            ? vec3(0.0, height, 0.0)
            : vec3(baseDir.x * uBladeWidth, 0.0, baseDir.y * uBladeWidth);
        vec3 vertPos = ground + local;

        // Wind sways the apex only, scaled by height.
        if (tip > 0.5) {
            vec2 wind = windOffset(bladeXZ) * height * 2.0;
            vertPos.x += wind.x;
            vertPos.z += wind.y;

            // Light repulsor: shove the apex horizontally away from the orb's
            // world-space light. Linear falloff to zero at uRepulsorRadius, and
            // diminished as the light climbs above the apex.
            vec2 fromLight = vertPos.xz - uOrbPos.xz;
            float rd = length(fromLight);
            if (rd < uRepulsorRadius && rd > 1e-5) {
                float t = rd / uRepulsorRadius;       // 0 at light -> 1 at edge
                float falloff = 1.0 - t;              // linear falloff to zero
                float dy = max(uOrbPos.y - vertPos.y, 0.0);
                float altFactor = 1.0 / (1.0 + dy * dy * uRepulsorAltFalloff);
                vertPos.xz += (fromLight / rd) *
                    (uRepulsorStrength * falloff * altFactor);
            }
        }

        // Feature map: only grow grass where green dominates (paths=red,
        // water=blue, outlines=black are all excluded). Collapse masked-out
        // blades to their ground point so the whole triangle has zero area and
        // is never rasterised — cheaper and cleaner than a fragment discard, and
        // it works identically in the shadow pass so cast shadows match.
        if (uFeatureMaskEnabled > 0.5) {
            vec2 fUV = (bladeXZ - uTerrainMin) / uTerrainSize;
            float inside = step(0.0, fUV.x) * step(fUV.x, 1.0) *
                           step(0.0, fUV.y) * step(fUV.y, 1.0);
            // Existence (cheap, runs on every vertex so the whole blade collapses
            // together): grass only where the blade's own texel is green.
            float exists = smoothstep(0.02, 0.18, grassGreen(fUV)) * inside;

            // Graduated rim height (apex only — the result is identical for all 4
            // verts but only scales the apex, so the costly edge search is skipped
            // for the 3 base corners and for non-grass blades that collapse anyway).
            // Walk out ring by ring to find the texel distance to the nearest
            // non-green cell, then ramp height from uEdgeShrink at the outermost
            // row up to full over uEdgeSoftness rows. A single ring sample at the
            // max radius cheaply rejects true-interior blades before the loop.
            float heightFactor = 1.0;
            if (tip > 0.5 && exists > 0.001) {
                vec2 texel = 1.0 / vec2(textureSize(uFeatureMap, 0));
                if (ringMinGreen(fUV, texel * uEdgeSoftness) < 0.1) {
                    float dist = uEdgeSoftness;   // an edge is within the ramp band
                    for (int k = 1; k <= 8; k++) {
                        if (float(k) > uEdgeSoftness) break;
                        if (ringMinGreen(fUV, texel * float(k)) < 0.1) {
                            dist = float(k);
                            break;
                        }
                    }
                    float t = clamp((dist - 1.0) / max(uEdgeSoftness - 1.0, 1.0), 0.0, 1.0);
                    heightFactor = mix(uEdgeShrink, 1.0, t);
                    vEdgeOut = 1.0 - t;   // 1 at the outermost row, fading to 0 inward
                    // Scatter each rim blade's height a little (strongest at the
                    // outer edge, fading to none in the interior) so the boundary
                    // reads as ragged grass instead of one clean, even band.
                    heightFactor = clamp(
                        heightFactor + (aHeightRand - 0.5) * uEdgeJitter * (1.0 - t),
                        0.0, 1.0);
                }
            }

            // Scale the apex's offset (height + wind + repulsor) by the rim factor
            // — a no-op for base corners, whose offset from ground is horizontal —
            // then collapse the whole blade toward its ground point where masked.
            vertPos = ground + (vertPos - ground) * heightFactor;
            vertPos = mix(ground, vertPos, exists);
        }

        vWorldOut = (modelMatrix * vec4(vertPos, 1.0)).xyz;
        vTipOut = tip;
        return vertPos;
    }
`;

const grassMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    // Blades are flat billboards — show both faces so they can never be culled
    // away depending on the viewing direction.
    side: THREE.DoubleSide,
    uniforms: {
        uCenter: { value: new THREE.Vector2() },
        uSize: { value: GRASS_SIZE },
        uTime: { value: 0 },
        uNoise: { value: grassNoise },
        uBladeWidth: { value: params.grassWidth },
        uBladeHeight: { value: params.grassHeight },
        uHeightRand: { value: params.grassHeightRand },
        uHeightNoiseScale: { value: params.grassHeightNoiseScale },
        uHeightVariation: { value: params.grassHeightVariation },
        uWindDir: { value: new THREE.Vector2(Math.sin(grassWindAngle), Math.cos(grassWindAngle)) },
        uWindStrength: { value: params.grassWindStrength },
        uWindFreq: { value: 0.5 },
        uColorBase: { value: new THREE.Color(params.grassColorBase) },
        uColorTip: { value: new THREE.Color(params.grassColorTip) },
        uAmbient: { value: new THREE.Color(0x000000) },
        uOrbPos: { value: new THREE.Vector3() },
        uOrbColor: { value: new THREE.Color(params.orbLightColor) },
        uOrbIntensity: { value: params.orbLightIntensity },
        uOrbRange: { value: params.grassLightRange },
        uRepulsorStrength: { value: params.grassRepulsorStrength },
        uRepulsorRadius: { value: params.grassRepulsorRadius },
        uRepulsorAltFalloff: { value: params.grassRepulsorAltFalloff },
        uFogColor: { value: new THREE.Color(params.fogColor) },
        uFogDensity: { value: params.fogDensity },
        // Terrain conforming: blades ride the baked height texture.
        uHeightMap: { value: terrainHeightTexture },
        uTerrainMin: { value: new THREE.Vector2(TERRAIN_MIN_X, TERRAIN_MIN_Z) },
        uTerrainSize: { value: new THREE.Vector2(TERRAIN_SIZE_X, TERRAIN_SIZE_Z) },
        uHeightMin: { value: TERRAIN_HEIGHT_MIN },
        uHeightRange: { value: TERRAIN_HEIGHT_RANGE },
        // Feature map (green channel) restricts grass to the painted grass areas.
        uFeatureMap: { value: featureMap },
        uFeatureMaskEnabled: { value: params.grassFeatureMaskEnabled ? 1 : 0 },
        uEdgeSoftness: { value: params.grassEdgeSoftness },
        uEdgeShrink: { value: params.grassEdgeShrink },
        uEdgeJitter: { value: params.grassEdgeJitter },
        uEdgeLighten: { value: params.grassEdgeLighten },
        // Point-light shadow receiving (manually wired — RawShaderMaterial is
        // invisible to three's automatic shadow plumbing).
        uShadowEnabled: { value: 1 },
        uShadowMap: { value: grassShadowFallback },
        uShadowMapSize: { value: new THREE.Vector2(1, 1) },
        uShadowBias: { value: 0 },
        uShadowRadius: { value: 1 },
        uShadowNear: { value: 0.1 },
        uShadowFar: { value: 6 },
    },
    vertexShader: GRASS_VERTEX_HEAD + /* glsl */ `
        out float vTip;
        out vec3 vWorldPos;
        out float vFogDist;
        flat out float vEdge;

        void main() {
            float tip;
            vec3 wp;
            float edge;
            vec3 vertPos = grassVertex(tip, wp, edge);
            vTip = tip;
            vWorldPos = wp;
            vFogDist = distance(wp, cameraPosition);
            vEdge = edge;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(vertPos, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        precision highp float;

        in float vTip;
        in vec3 vWorldPos;
        in float vFogDist;
        flat in float vEdge;
        out vec4 fragColor;

        uniform vec3 uColorBase;
        uniform vec3 uColorTip;
        uniform float uEdgeLighten;
        uniform vec3 uAmbient;
        uniform vec3 uOrbPos;
        uniform vec3 uOrbColor;
        uniform float uOrbIntensity;
        uniform float uOrbRange;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        // Point-light shadow receiving. These mirror three's own
        // shadowmap_pars_fragment / packing chunks so the grass reads the exact
        // same packed-distance cube map the renderer fills for the orb light.
        uniform float uShadowEnabled;
        uniform sampler2D uShadowMap;
        uniform vec2 uShadowMapSize;
        uniform float uShadowBias;
        uniform float uShadowRadius;
        uniform float uShadowNear;
        uniform float uShadowFar;

        const float UnpackDownscale = 255.0 / 256.0;
        const vec3 PackFactors = vec3(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
        const vec4 UnpackFactors = UnpackDownscale / vec4(PackFactors, 1.0);
        float unpackRGBAToDepth(const in vec4 v) { return dot(v, UnpackFactors); }
        float texture2DCompare(sampler2D depths, vec2 uv, float compare) {
            return step(compare, unpackRGBAToDepth(texture(depths, uv)));
        }
        vec2 cubeToUV(vec3 v, float texelSizeY) {
            vec3 absV = abs(v);
            float scaleToCube = 1.0 / max(absV.x, max(absV.y, absV.z));
            absV *= scaleToCube;
            v *= scaleToCube * (1.0 - 2.0 * texelSizeY);
            vec2 planar = v.xy;
            float almostATexel = 1.5 * texelSizeY;
            float almostOne = 1.0 - almostATexel;
            if (absV.z >= almostOne) {
                if (v.z > 0.0) planar.x = 4.0 - v.x;
            } else if (absV.x >= almostOne) {
                float signX = sign(v.x);
                planar.x = v.z * signX + 2.0 * signX;
            } else if (absV.y >= almostOne) {
                float signY = sign(v.y);
                planar.x = v.x + 2.0 * signY + 2.0;
                planar.y = v.z * signY - 2.0;
            }
            return vec2(0.125, 0.25) * planar + vec2(0.375, 0.75);
        }
        float getPointShadow(vec3 lightToPosition) {
            vec2 texelSize = vec2(1.0) / (uShadowMapSize * vec2(4.0, 2.0));
            float dp = (length(lightToPosition) - uShadowNear) /
                (uShadowFar - uShadowNear);
            dp += uShadowBias;
            vec3 bd3D = normalize(lightToPosition);
            vec2 offset = vec2(-1.0, 1.0) * uShadowRadius * texelSize.y;
            return (
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.xyy, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.yyy, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.xyx, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.yyx, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.xxy, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.yxy, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.xxx, texelSize.y), dp) +
                texture2DCompare(uShadowMap, cubeToUV(bd3D + offset.yxx, texelSize.y), dp)
            ) * (1.0 / 9.0);
        }

        void main() {
            // Edge blades shift to a slightly brighter colour toward the masked
            // boundary. Apply the lift to the base and tip colours BEFORE the
            // root→tip gradient and AO, so each blade keeps its darker-base /
            // lighter-tip falloff just in a brighter palette. vEdge is a flat,
            // apex-sourced factor: 1 at the outermost row, fading to 0 inside.
            float edgeAmt = vEdge * uEdgeLighten;
            vec3 baseCol = mix(uColorBase, vec3(1.0), edgeAmt);
            vec3 tipCol  = mix(uColorTip,  vec3(1.0), edgeAmt);

            // Base-darkening AO: dark at the root, full bright at the tip.
            float ao = mix(0.4, 1.0, vTip);
            vec3 albedo = mix(baseCol, tipCol, vTip) * ao;

            // Flat up-normal lighting (blades lit like the ground, per the guide)
            // plus the orb's travelling glow as a local point light.
            vec3 N = vec3(0.0, 1.0, 0.0);
            vec3 toLight = uOrbPos - vWorldPos;
            float dist = length(toLight);
            float atten = pow(clamp(1.0 - dist / uOrbRange, 0.0, 1.0), 2.0);
            float ndl = max(dot(N, normalize(toLight)), 0.0);

            // Receive: the orb's contribution is gated by the point shadow cube.
            // lightToPosition (worldPos - lightPos) is exactly three's point-light
            // shadow coordinate, so getPointShadow() matches the renderer. When
            // shadows are toggled off, fall back to fully lit (1.0).
            float shadow = uShadowEnabled > 0.5
                ? getPointShadow(vWorldPos - uOrbPos)
                : 1.0;
            vec3 lit = uAmbient +
                uOrbColor * uOrbIntensity * atten * (0.4 + 0.6 * ndl) * shadow;
            vec3 col = albedo * lit;

            // Exponential-squared fog to match scene.fog (FogExp2).
            float f = 1.0 - exp(-pow(uFogDensity * vFogDist, 2.0));
            col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

            fragColor = vec4(col, 1.0);
        }
    `,
});

// Shadow caster for the grass: a customDistanceMaterial that re-runs the exact
// same vertex displacement (via the shared GRASS_VERTEX_HEAD) and packs the
// light→fragment distance the same way three's MeshDistanceMaterial does, so the
// blades punch correct holes into the orb light's depth cube. It shares the live
// uniform objects with grassMaterial so wind/repulsor/terrain all stay in sync.
const gu = grassMaterial.uniforms;
const grassDistanceMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    uniforms: {
        uCenter: gu.uCenter,
        uSize: gu.uSize,
        uTime: gu.uTime,
        uNoise: gu.uNoise,
        uBladeWidth: gu.uBladeWidth,
        uBladeHeight: gu.uBladeHeight,
        uHeightRand: gu.uHeightRand,
        uHeightNoiseScale: gu.uHeightNoiseScale,
        uHeightVariation: gu.uHeightVariation,
        uWindDir: gu.uWindDir,
        uWindStrength: gu.uWindStrength,
        uWindFreq: gu.uWindFreq,
        uOrbPos: gu.uOrbPos,
        uRepulsorStrength: gu.uRepulsorStrength,
        uRepulsorRadius: gu.uRepulsorRadius,
        uRepulsorAltFalloff: gu.uRepulsorAltFalloff,
        uHeightMap: gu.uHeightMap,
        uTerrainMin: gu.uTerrainMin,
        uTerrainSize: gu.uTerrainSize,
        uHeightMin: gu.uHeightMin,
        uHeightRange: gu.uHeightRange,
        uFeatureMap: gu.uFeatureMap,
        uFeatureMaskEnabled: gu.uFeatureMaskEnabled,
        uEdgeSoftness: gu.uEdgeSoftness,
        uEdgeShrink: gu.uEdgeShrink,
        uEdgeJitter: gu.uEdgeJitter,
        // Set per frame to the light position + shadow camera near/far so the
        // packed distance matches what the rest of the scene writes.
        uRefPosition: { value: new THREE.Vector3() },
        uNearDistance: { value: 0.1 },
        uFarDistance: { value: 6 },
    },
    vertexShader: GRASS_VERTEX_HEAD + /* glsl */ `
        out vec3 vWorldPosition;

        void main() {
            float tip;
            vec3 wp;
            float edge;
            vec3 vertPos = grassVertex(tip, wp, edge);
            vWorldPosition = wp;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(vertPos, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        precision highp float;

        in vec3 vWorldPosition;
        out vec4 fragColor;

        uniform vec3 uRefPosition;
        uniform float uNearDistance;
        uniform float uFarDistance;

        const float PackUpscale = 256.0 / 255.0;
        const vec3 PackFactors = vec3(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
        const float ShiftRight8 = 1.0 / 256.0;
        vec4 packDepthToRGBA(const in float v) {
            vec4 r = vec4(fract(v * PackFactors), v);
            r.yzw -= r.xyz * ShiftRight8;
            return r * PackUpscale;
        }

        void main() {
            float dist = length(vWorldPosition - uRefPosition);
            dist = (dist - uNearDistance) / (uFarDistance - uNearDistance);
            dist = clamp(dist, 0.0, 1.0);
            fragColor = packDepthToRGBA(dist);
        }
    `,
});

const grass = new THREE.Mesh(grassGeometry, grassMaterial);
grass.frustumCulled = false;
grass.castShadow = true;
grass.receiveShadow = true;
grass.customDistanceMaterial = grassDistanceMaterial;
scene.add(grass);

// ----------------------------------------------------------------------------
// Water, layer 1: animated surface ripples. A flat, static plane at the water
// surface whose fragment shader draws white contour bands of the water DEPTH
// (sampled from the baked terrain heightmap), so the bands hug the shoreline
// for free. Not moving geometry — purely an alpha mask: a sawtooth over depth
// scrolled by time, wobbled per-band by tiling noise, and biased by depth so
// bands crowd the shallows and can never appear over deep water.
// Ported from a WebGPU/TSL original to GLSL3, like the grass. The mask is a
// max() of terms so later layers (shore foam, splashes, ...) can join it.
// ----------------------------------------------------------------------------
const waterMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false, // don't occlude, but still depth-test against terrain
    side: THREE.DoubleSide,
    uniforms: {
        uTime: { value: 0 }, // localTime, advanced by dt * waterFlowSpeed
        uNoise: { value: grassNoise },
        uColor: { value: new THREE.Color(params.waterColor) },
        uSurfaceY: { value: params.waterElevation },
        uDepthScale: { value: params.waterDepthScale },
        uRipplesRatio: { value: params.waterRipplesRatio },
        uSlopeFrequency: { value: params.waterSlopeFrequency },
        uNoiseFrequency: { value: params.waterNoiseFrequency },
        uNoiseOffset: { value: params.waterNoiseOffset },
        uHeightMap: { value: terrainHeightTexture },
        uTerrainMin: { value: new THREE.Vector2(TERRAIN_MIN_X, TERRAIN_MIN_Z) },
        uTerrainSize: { value: new THREE.Vector2(TERRAIN_SIZE_X, TERRAIN_SIZE_Z) },
        uHeightMin: { value: TERRAIN_HEIGHT_MIN },
        uHeightRange: { value: TERRAIN_HEIGHT_RANGE },
        uFogColor: { value: new THREE.Color(params.fogColor) },
        uFogDensity: { value: params.fogDensity },
    },
    vertexShader: /* glsl */ `
        uniform mat4 modelMatrix;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        uniform vec3 cameraPosition;

        in vec3 position;

        out vec3 vWorldPos;
        out float vFogDist;

        void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vFogDist = distance(wp.xyz, cameraPosition);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        precision highp float;

        in vec3 vWorldPos;
        in float vFogDist;
        out vec4 fragColor;

        uniform float uTime;
        uniform sampler2D uNoise;
        uniform vec3 uColor;
        uniform float uSurfaceY;
        uniform float uDepthScale;
        uniform float uRipplesRatio;
        uniform float uSlopeFrequency;
        uniform float uNoiseFrequency;
        uniform float uNoiseOffset;
        uniform sampler2D uHeightMap;
        uniform vec2 uTerrainMin;
        uniform vec2 uTerrainSize;
        uniform float uHeightMin;
        uniform float uHeightRange;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        // Water depth at a world XZ, 0 = at/above the waterline, 1 = uDepthScale
        // (or more) below it. The single depth source for every mask term —
        // later layers (foam, colouring) should call this too.
        float depthAt(vec2 worldXZ) {
            vec2 hUV = (worldXZ - uTerrainMin) / uTerrainSize;
            float terrainY = uHeightMin + texture(uHeightMap, hUV).r * uHeightRange;
            return clamp((uSurfaceY - terrainY) / uDepthScale, 0.0, 1.0);
        }

        // Contour-band ripples. The sawtooth slices the depth field into bands;
        // per-band noise (offset by the band's integer id) wobbles each ring
        // independently; the depth-bias subtraction (~1.3 in the shallows, ~0 at
        // full depth) against the -0.4 threshold makes bands dense near shore
        // and IMPOSSIBLE over deep water — intended look, do not "fix".
        float ripplesTerm(float depth) {
            float baseRipple = (depth + uTime * 0.5) * uSlopeFrequency;
            float rippleIndex = floor(baseRipple);

            float ripplesNoise = texture(
                uNoise,
                (vWorldPos.xz + vec2(rippleIndex / uNoiseOffset)) * uNoiseFrequency
            ).r;

            float ripples = fract(baseRipple)
                - (1.0 - (mix(-0.3, 1.0, depth)))   // depth bias
                + ripplesNoise;

            // TSL threshold.step(ripples) == white where ripples <= threshold.
            float threshold = mix(-1.0, -0.4, uRipplesRatio);
            // Fade out in the last sliver before the shore: where the sampled
            // depth clamps to ~0 the sawtooth degenerates (whole strips flip in
            // unison with a frozen noise pattern), so ripples — and only
            // ripples; foam terms belong AT the shore — retreat from it.
            return step(ripples, threshold) * smoothstep(0.0, 0.03, depth);
        }

        void main() {
            float depth = depthAt(vWorldPos.xz);
            // max() of mask terms — shore/splash/ice terms join in later layers.
            float mask = max(0.0, ripplesTerm(depth));

            // Tinted bands, dissolved into the scene's FogExp2 haze.
            float f = 1.0 - exp(-pow(uFogDensity * vFogDist, 2.0));
            vec3 col = mix(uColor, uFogColor, clamp(f, 0.0, 1.0));
            fragColor = vec4(col, mask);
        }
    `,
});

// Static plane spanning exactly the terrain bounds — beyond them the heightmap
// clamps to edge values, so there's nothing meaningful to draw anyway and the
// fog + world boundary hide the rim long before it's reachable.
const waterGeometry = new THREE.PlaneGeometry(TERRAIN_SIZE_X, TERRAIN_SIZE_Z);
waterGeometry.rotateX(-Math.PI / 2);
const water = new THREE.Mesh(waterGeometry, waterMaterial);
water.position.set(
    TERRAIN_MIN_X + TERRAIN_SIZE_X * 0.5,
    params.waterElevation,
    TERRAIN_MIN_Z + TERRAIN_SIZE_Z * 0.5,
);
scene.add(water);

// ----------------------------------------------------------------------------
// Scattered trees — the tree1.glb model instanced across the explorable area.
// Drawing N copies of the model as one InstancedMesh per sub-mesh costs only a
// handful of draw calls regardless of how many trees there are, so it stays
// cheap even with dense scattering. The model is auto-normalised from its own
// bounding box, so it lands at a sensible size no matter how it was authored.
// ----------------------------------------------------------------------------
const treeGroup = new THREE.Group();
scene.add(treeGroup);

// Captured once the GLB loads: each source mesh + its baked transform within the
// model, the model's base (normalised) scale, and the lift that grounds it.
let treeSources = null;
let treeModelHeight = 1; // the model's natural (unscaled) height
let treeBaseScale = 1;
let treeBaseMinY = 0;

// Reused scratch objects so a rebuild allocates nothing per instance.
const _treePos = new THREE.Vector3();
const _treeQuat = new THREE.Quaternion();
const _treeScale = new THREE.Vector3();
const _treeUp = new THREE.Vector3(0, 1, 0);
const _treeInstance = new THREE.Matrix4();
const _treeFinal = new THREE.Matrix4();

function buildTrees() {
    // Clear any previous instanced meshes (e.g. after a GUI count change).
    for (let i = treeGroup.children.length - 1; i >= 0; i--) {
        const child = treeGroup.children[i];
        child.geometry.dispose();
        treeGroup.remove(child);
    }
    if (!treeSources) return;

    const count = Math.max(0, Math.floor(params.treeCount));

    // Per-instance ground transforms (position + Y rotation + scale variation),
    // shared across every sub-mesh so trunk and foliage stay aligned.
    const instances = [];
    for (let i = 0; i < count; i++) {
        // Uniform-ish disk sampling in an annulus between the clearing and the
        // outer radius, so spawn stays open and no tree lands on the orb.
        const rMin = params.treeClearing;
        const rMax = params.treeAreaRadius;
        const r = Math.sqrt(rMin * rMin + Math.random() * (rMax * rMax - rMin * rMin));
        const a = Math.random() * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const variation = 0.8 + Math.random() * 0.5; // 0.8x – 1.3x size spread
        const s = treeBaseScale * variation;

        // Lift so the model base sits on the terrain surface at this XZ.
        _treePos.set(x, terrainHeightAt(x, z) - treeBaseMinY * s, z);
        _treeQuat.setFromAxisAngle(_treeUp, Math.random() * Math.PI * 2);
        _treeScale.setScalar(s);
        instances.push(new THREE.Matrix4().compose(_treePos, _treeQuat, _treeScale));
    }

    // One InstancedMesh per source sub-mesh; bake the sub-mesh's transform inside
    // the model so multi-part trees (trunk + leaves) reconstruct correctly.
    for (const { geometry, material, matrix } of treeSources) {
        const inst = new THREE.InstancedMesh(geometry, material, count);
        inst.castShadow = params.sceneShadowsEnabled;
        inst.receiveShadow = params.sceneShadowsEnabled;
        inst.frustumCulled = false; // instances span the whole area; skip culling
        for (let i = 0; i < count; i++) {
            _treeFinal.multiplyMatrices(instances[i], matrix);
            inst.setMatrixAt(i, _treeFinal);
        }
        inst.instanceMatrix.needsUpdate = true;
        treeGroup.add(inst);
    }
}

new GLTFLoader().load(treeUrl, (gltf) => {
    gltf.scene.updateMatrixWorld(true);

    // Normalise size from the model's own bounds so it sits at treeHeight units.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    treeModelHeight = size.y > 1e-5 ? size.y : 1;
    treeBaseScale = params.treeHeight / treeModelHeight;
    treeBaseMinY = box.min.y;

    // Collect every mesh with its world matrix relative to the model root.
    treeSources = [];
    gltf.scene.traverse((obj) => {
        if (obj.isMesh) {
            treeSources.push({
                geometry: obj.geometry,
                material: obj.material,
                matrix: obj.matrixWorld.clone(),
            });
        }
    });

    buildTrees();
});

// 3/4 view: above the orb, tilted forward
const cameraOffset = new THREE.Vector3(0, 1.8, 1.8);

// Idle hint — 5s the first time, 30s after the user has already moved
const idleHint = document.getElementById('idle-hint');
const IDLE_DELAY_FIRST = 5;
const IDLE_DELAY_REPEAT = 30;
let idleTime = 0;
let hasMoved = false;
const showIdleHint = () => {
    if (!idleHint) return;
    idleHint.style.opacity = '';
    idleHint.classList.add('visible');
};
const resetIdle = () => {
    idleTime = 0;
    hasMoved = true;
    if (!idleHint || !idleHint.classList.contains('visible')) return;
    const current = getComputedStyle(idleHint).opacity;
    idleHint.style.opacity = current;
    idleHint.classList.remove('visible');
    void idleHint.offsetWidth;
    idleHint.style.opacity = '0';
};

// Input
const keys = { w: false, a: false, s: false, d: false };
// Jump is a brief upward "propulsion" rather than an instant impulse: holding
// a thrust acceleration for a short window ramps velocity up from zero, so the
// launch feels like fast acceleration instead of an abrupt bounce.
const SOFT_LAND_DISTANCE = 0.25; // ease zone above hover height
const SOFT_LAND_DAMPING = 20;    // extra cushion right before landing
let velocityY = 0;
let jumpThrustTime = 0;          // remaining propulsion time
let bobScaleSmooth = 1;          // eased bob amplitude factor (avoids snapping)

const isGrounded = () =>
    targetPos.y <= terrainHeightAt(targetPos.x, targetPos.z) + HOVER_HEIGHT + 1e-4;

const keyMap = {
    KeyW: 'w', ArrowUp: 'w',
    KeyA: 'a', ArrowLeft: 'a',
    KeyS: 's', ArrowDown: 's',
    KeyD: 'd', ArrowRight: 'd',
};

window.addEventListener('keydown', (e) => {
    const action = keyMap[e.code];
    if (action) {
        keys[action] = true;
        resetIdle();
        e.preventDefault();
    }
    if (e.code === 'Space') {
        if (isGrounded()) jumpThrustTime = params.jumpThrustTime;
        resetIdle();
        e.preventDefault();
    }
    if (e.code === 'KeyH') {
        gui._hidden ? gui.show() : gui.hide();
    }
});
window.addEventListener('keyup', (e) => {
    const action = keyMap[e.code];
    if (action) keys[action] = false;
});

// Touch controls — drag anywhere on the canvas to steer the orb like a virtual
// joystick. The touch-start point is the anchor; the orb moves in the drag
// direction, and speed scales with how far you drag (full speed past
// TOUCH_MAX_RADIUS). Listeners live on the canvas so they don't fight the GUI.
const TOUCH_MAX_RADIUS = 70; // px of drag for full speed
const touchMove = { x: 0, z: 0 };
let activeTouchId = null;
let touchAnchorX = 0;
let touchAnchorY = 0;

renderer.domElement.style.touchAction = 'none'; // stop browser scroll/zoom gestures

function updateTouchVector(clientX, clientY) {
    let dx = (clientX - touchAnchorX) / TOUCH_MAX_RADIUS;
    let dy = (clientY - touchAnchorY) / TOUCH_MAX_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; } // clamp magnitude to 1 (full speed)
    // Screen +x → world +x; dragging down the screen (+y) pulls the orb toward
    // the camera (+z), matching the 3/4 view.
    touchMove.x = dx;
    touchMove.z = dy;
}

renderer.domElement.addEventListener('touchstart', (e) => {
    if (activeTouchId !== null) return;
    const t = e.changedTouches[0];
    activeTouchId = t.identifier;
    touchAnchorX = t.clientX;
    touchAnchorY = t.clientY;
    touchMove.x = 0;
    touchMove.z = 0;
    resetIdle();
    e.preventDefault();
}, { passive: false });

renderer.domElement.addEventListener('touchmove', (e) => {
    if (activeTouchId === null) return;
    for (const t of e.changedTouches) {
        if (t.identifier === activeTouchId) {
            updateTouchVector(t.clientX, t.clientY);
            resetIdle();
            e.preventDefault();
            break;
        }
    }
}, { passive: false });

function endTouch(e) {
    for (const t of e.changedTouches) {
        if (t.identifier === activeTouchId) {
            activeTouchId = null;
            touchMove.x = 0;
            touchMove.z = 0;
            break;
        }
    }
}
renderer.domElement.addEventListener('touchend', endTouch);
renderer.domElement.addEventListener('touchcancel', endTouch);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    particleMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    syncComposerSize();
});

const clock = new THREE.Clock();
let grassWindTime = 0; // accumulated wind "localTime" (scaled by strength)
let waterTime = 0;     // water ripple "localTime" (scaled by flow speed)
const moveDir = new THREE.Vector3();
const velocity = new THREE.Vector3();
const targetVelocity = new THREE.Vector3();

// Flip the whole shadow pipeline on/off: the orb stops rendering its depth cube
// (so nothing casts), and the grass falls back to fully-lit receiving.
// The orb light only needs to render its (expensive) shadow cube if either the
// scene or the grass is actually using shadows — skip it entirely when both off.
function updateOrbShadowCaster() {
    orbLight.castShadow =
        params.sceneShadowsEnabled || params.grassShadowsEnabled;
}

// Scene shadows: terrain, boxes, and trees cast onto / receive from each other.
function applySceneShadows(v) {
    terrainMesh.traverse((o) => {
        if (o.isMesh) { o.castShadow = v; o.receiveShadow = v; }
    });
    for (const { mesh } of boxes) { mesh.castShadow = v; mesh.receiveShadow = v; }
    for (const inst of treeGroup.children) {
        inst.castShadow = v; inst.receiveShadow = v;
    }
    updateOrbShadowCaster();
}

// Grass shadows: blades cast into the shadow cube and sample it to self-shadow.
function applyGrassShadows(v) {
    grass.castShadow = v;
    grassMaterial.uniforms.uShadowEnabled.value = v ? 1 : 0;
    if (!v) grassMaterial.uniforms.uShadowMap.value = grassShadowFallback;
    updateOrbShadowCaster();
}

// Apply the initial shadow state so the defaults take effect at startup,
// overriding the castShadow=true flags set when each object was created.
applySceneShadows(params.sceneShadowsEnabled);
applyGrassShadows(params.grassShadowsEnabled);

// --- Live controls (lil-gui) ---
const gui = new GUI({ title: 'Controls' });

const orbFolder = gui.addFolder('Orb');
orbFolder.add(params, 'orbRadius', 0.002, 0.05, 0.001).name('radius').onChange((v) => {
    orb.geometry.dispose();
    orb.geometry = new THREE.SphereGeometry(v, 24, 24);
});
orbFolder.add(orbLight, 'intensity', 0, 5, 0.1).name('light intensity');
orbFolder.add(orbLight, 'distance', 0.5, 8, 0.1).name('light distance');
orbFolder.addColor(params, 'orbLightColor').name('light color')
    .onChange((v) => orbLight.color.set(v));
orbFolder.add(params, 'sceneShadowsEnabled').name('scene shadows')
    .onChange(applySceneShadows);
orbFolder.add(params, 'grassShadowsEnabled').name('grass shadows')
    .onChange(applyGrassShadows);

const lightingFolder = gui.addFolder('Lighting');
lightingFolder.add(ambientLight, 'intensity', 0, 1, 0.01).name('ambient');
lightingFolder.add(hemisphereLight, 'intensity', 0, 1, 0.01).name('hemisphere');

const moveFolder = gui.addFolder('Movement');
moveFolder.add(params, 'moveSpeed', 0.5, 6, 0.1).name('speed');
moveFolder.add(params, 'accelRate', 1, 12, 0.5).name('turn smoothing');

const jumpFolder = gui.addFolder('Jump');
jumpFolder.add(params, 'jumpThrustAccel', 5, 80, 1).name('thrust accel');
jumpFolder.add(params, 'jumpThrustTime', 0.05, 0.5, 0.01).name('thrust time');
jumpFolder.add(params, 'gravityUp', 2, 20, 0.5).name('gravity up');
jumpFolder.add(params, 'gravityDown', 1, 12, 0.5).name('gravity down');

const trailFolder = gui.addFolder('Trail');
trailFolder.add(params, 'trailRadius', 0.002, 0.05, 0.001).name('radius');
trailFolder.add(params, 'trailLifetime', 0.2, 4, 0.1).name('lifetime');
trailFolder.add(params, 'trailSpacing', 0.005, 0.1, 0.005).name('spacing');
trailFolder.addColor(params, 'trailColor').name('color')
    .onChange((v) => TRAIL_COLOR.set(v));

const bobFolder = gui.addFolder('Bobbing');
bobFolder.add(params, 'bobXZ', 0, 0.1, 0.005).name('amp X/Z');
bobFolder.add(params, 'bobY', 0, 0.1, 0.005).name('amp Y');
bobFolder.add(params, 'bobIdleBoost', 0, 6, 0.1).name('idle boost');
bobFolder.add(params, 'bobResponse', 0.2, 6, 0.1).name('response');

const particleFolder = gui.addFolder('Particles');
particleFolder.add(particleMaterial.uniforms.uLightRange, 'value', 0.5, 10, 0.1).name('light range');
particleFolder.add(particleMaterial.uniforms.uSizeScale, 'value', 1, 20, 0.5).name('size');
particleFolder.addColor(params, 'particleLightColor').name('light color')
    .onChange((v) => particleMaterial.uniforms.uLightColor.value.set(v));

const boundaryFolder = gui.addFolder('Boundary');
boundaryFolder.add(params, 'boundaryEnabled').name('enabled');
boundaryFolder.add(params, 'boundaryRadius', 8, 40, 1).name('respawn radius');
boundaryFolder.add(params, 'boundaryWarnRadius', 0, 40, 1).name('warn radius');
boundaryFolder.add(params, 'boundaryWarnOpacity', 0, 1, 0.05).name('warn haze');
boundaryFolder.add(params, 'respawnFadeOut', 0.1, 2, 0.1).name('fade out (s)');
boundaryFolder.add(params, 'respawnFadeIn', 0.1, 2, 0.1).name('fade in (s)');

const boxFolder = gui.addFolder('Boxes');
boxFolder.addColor(params, 'boxColor').name('color')
    .onChange((v) => boxMat.color.set(v));

const fogFolder = gui.addFolder('Fog');
fogFolder.addColor(params, 'fogColor').name('sky / fog').onChange((v) => {
    scene.background.set(v);
    scene.fog.color.set(v);
});
fogFolder.add(params, 'fogDensity', 0, 0.15, 0.002).name('fog density')
    .onChange((v) => { scene.fog.density = v; });

const grassFolder = gui.addFolder('Grass');
// Density rebuilds the geometry, so only do it when the slider is released.
grassFolder.add(params, 'grassFeatureMaskEnabled').name('mask to green')
    .onChange((v) => {
        grassMaterial.uniforms.uFeatureMaskEnabled.value = v ? 1 : 0;
    });
grassFolder.add(params, 'grassEdgeSoftness', 1, 8, 1).name('edge rim rows')
    .onChange((v) => {
        grassMaterial.uniforms.uEdgeSoftness.value = v;
    });
grassFolder.add(params, 'grassEdgeShrink', 0, 1, 0.01).name('edge height')
    .onChange((v) => {
        grassMaterial.uniforms.uEdgeShrink.value = v;
    });
grassFolder.add(params, 'grassEdgeJitter', 0, 1, 0.01).name('edge jitter')
    .onChange((v) => {
        grassMaterial.uniforms.uEdgeJitter.value = v;
    });
grassFolder.add(params, 'grassEdgeLighten', 0, 1, 0.01).name('edge lighten')
    .onChange((v) => {
        grassMaterial.uniforms.uEdgeLighten.value = v;
    });
grassFolder.add(params, 'grassDensity', 120, 1400, 20).name('density')
    .onFinishChange((v) => {
        grass.geometry.dispose();
        grass.geometry = buildGrassGeometry(v);
    });
grassFolder.add(params, 'grassHeight', 0.05, 0.6, 0.01).name('height')
    .onChange((v) => { grassMaterial.uniforms.uBladeHeight.value = v; });
grassFolder.add(params, 'grassHeightVariation', 0, 1, 0.01).name('height variation')
    .onChange((v) => { grassMaterial.uniforms.uHeightVariation.value = v; });
grassFolder.add(params, 'grassHeightNoiseScale', 0.01, 0.4, 0.01).name('height noise scale')
    .onChange((v) => { grassMaterial.uniforms.uHeightNoiseScale.value = v; });
grassFolder.add(params, 'grassHeightRand', 0, 1, 0.01).name('height jitter')
    .onChange((v) => { grassMaterial.uniforms.uHeightRand.value = v; });
grassFolder.add(params, 'grassWidth', 0.005, 0.1, 0.005).name('width')
    .onChange((v) => { grassMaterial.uniforms.uBladeWidth.value = v; });
grassFolder.add(params, 'grassWindStrength', 0, 1.5, 0.05).name('wind')
    .onChange((v) => { grassMaterial.uniforms.uWindStrength.value = v; });
grassFolder.add(params, 'grassLightRange', 1, 12, 0.5).name('glow range')
    .onChange((v) => { grassMaterial.uniforms.uOrbRange.value = v; });
grassFolder.add(params, 'grassRepulsorStrength', 0, 0.5, 0.01).name('repulsor strength')
    .onChange((v) => { grassMaterial.uniforms.uRepulsorStrength.value = v; });
grassFolder.add(params, 'grassRepulsorRadius', 0.1, 8, 0.1).name('repulsor radius')
    .onChange((v) => { grassMaterial.uniforms.uRepulsorRadius.value = v; });
grassFolder.add(params, 'grassRepulsorAltFalloff', 0, 16, 0.5).name('repulsor altitude falloff')
    .onChange((v) => { grassMaterial.uniforms.uRepulsorAltFalloff.value = v; });
grassFolder.addColor(params, 'grassColorBase').name('base color')
    .onChange((v) => grassMaterial.uniforms.uColorBase.value.set(v));
grassFolder.addColor(params, 'grassColorTip').name('tip color')
    .onChange((v) => grassMaterial.uniforms.uColorTip.value.set(v));

const waterFolder = gui.addFolder('Water');
waterFolder.add(
    params, 'waterElevation',
    TERRAIN_HEIGHT_MIN - 0.5, TERRAIN_HEIGHT_MAX + 0.5, 0.01,
).name('elevation').onChange((v) => {
    water.position.y = v;
    waterMaterial.uniforms.uSurfaceY.value = v;
});
waterFolder.addColor(params, 'waterColor').name('color')
    .onChange((v) => { waterMaterial.uniforms.uColor.value.set(v); });
waterFolder.add(params, 'waterRipplesRatio', 0, 1, 0.01).name('ripples ratio')
    .onChange((v) => { waterMaterial.uniforms.uRipplesRatio.value = v; });
waterFolder.add(params, 'waterSlopeFrequency', 1, 40, 1).name('slope frequency')
    .onChange((v) => { waterMaterial.uniforms.uSlopeFrequency.value = v; });
waterFolder.add(params, 'waterFlowSpeed', 0, 0.3, 0.005).name('flow speed');
waterFolder.add(
    params, 'waterDepthScale', 0.01, Math.max(0.02, TERRAIN_HEIGHT_RANGE), 0.01,
).name('depth scale')
    .onChange((v) => { waterMaterial.uniforms.uDepthScale.value = v; });
waterFolder.add(params, 'waterNoiseFrequency', 0.01, 1, 0.005).name('wobble scale')
    .onChange((v) => { waterMaterial.uniforms.uNoiseFrequency.value = v; });

const terrainFolder = gui.addFolder('Terrain');
terrainFolder.addColor(params, 'terrainColor').name('color').onChange((v) => {
    for (const mat of terrainMaterials) if (mat.color) mat.color.set(v);
});
terrainFolder.add(params, 'pathEnabled').name('paths (red mask)').onChange((v) => {
    pathUniforms.uPathEnabled.value = v ? 1 : 0;
});
terrainFolder.add(params, 'pathTiling', 1, 60, 1).name('path tiling').onChange((v) => {
    pathUniforms.uPathTiling.value = v;
});
terrainFolder.addColor(params, 'pathTint').name('path tint').onChange((v) => {
    pathUniforms.uPathTint.value.set(v);
});
terrainFolder.add(params, 'pathOpacity', 0, 1, 0.01).name('path opacity').onChange((v) => {
    pathUniforms.uPathOpacity.value = v;
});
terrainFolder.add(params, 'pathEdgeFade', 0, 12, 0.5).name('path edge fade').onChange((v) => {
    pathUniforms.uPathEdgeFade.value = v;
});
terrainFolder.add(params, 'pathPatchiness', 0, 1, 0.01).name('path patchiness').onChange((v) => {
    pathUniforms.uPathPatchiness.value = v;
});
terrainFolder.add(params, 'pathNoiseScale', 0.2, 8, 0.1).name('patch scale').onChange((v) => {
    pathUniforms.uPathNoiseScale.value = v;
});
terrainFolder.add(params, 'pathSparseness', 0, 1, 0.01).name('path sparseness').onChange((v) => {
    pathUniforms.uPathSparseness.value = v;
});
terrainFolder.add(params, 'pathSparseStrength', 0, 1, 0.01).name('sparse opacity').onChange((v) => {
    pathUniforms.uPathSparseStrength.value = v;
});
terrainFolder.add(params, 'terrainNoiseEnabled').name('ground noise').onChange((v) => {
    pathUniforms.uTerrainNoiseEnabled.value = v ? 1 : 0;
});
terrainFolder.add(params, 'terrainNoiseScale', 0.1, 8, 0.1).name('noise scale').onChange((v) => {
    pathUniforms.uTerrainNoiseScale.value = v;
});
terrainFolder.add(params, 'terrainNoiseContrast', 0.1, 6, 0.1).name('noise contrast').onChange((v) => {
    pathUniforms.uTerrainNoiseContrast.value = v;
});
terrainFolder.add(params, 'terrainNoiseStrength', 0, 1, 0.01).name('noise strength').onChange((v) => {
    pathUniforms.uTerrainNoiseStrength.value = v;
});

const treeFolder = gui.addFolder('Trees');
// Each of these reshuffles the scatter, so rebuild only when the slider settles.
treeFolder.add(params, 'treeCount', 0, 300, 1).name('count')
    .onFinishChange(buildTrees);
treeFolder.add(params, 'treeHeight', 0.5, 8, 0.1).name('height')
    .onFinishChange(() => {
        treeBaseScale = params.treeHeight / treeModelHeight;
        buildTrees();
    });
treeFolder.add(params, 'treeAreaRadius', 5, 40, 1).name('area radius')
    .onFinishChange(buildTrees);
treeFolder.add(params, 'treeClearing', 0, 20, 0.5).name('clearing')
    .onFinishChange(buildTrees);

const dofFolder = gui.addFolder('Depth of Field');
dofFolder.add(params, 'dofBlur', 0, 8, 0.1).name('edge blur').onChange((v) => {
    blurH.uniforms.uMaxBlur.value = v;
    blurV.uniforms.uMaxBlur.value = v;
});
dofFolder.add(params, 'dofStart', 0, 1, 0.01).name('blur start').onChange((v) => {
    blurH.uniforms.uStart.value = v;
    blurV.uniforms.uStart.value = v;
});

gui.close(); // start collapsed

// --- World boundary: thick-fog respawn ---
// A small state machine drives a fullscreen veil (matched to the fog colour):
// 'idle' shows a soft warning haze near the edge, 'out' fades to a full white-out
// then teleports to spawn, 'in' fades back. An overlay is used instead of cranking
// scene.fog so the close-up orb/trail are reliably hidden during the swap.
const fogVeil = document.getElementById('fog-veil');
let respawnState = 'idle'; // 'idle' | 'out' | 'in'
let respawnTimer = 0;
let veilOpacity = 0;
let veilApplied = -1; // last opacity actually written to the DOM (-1 = never)
const _spawnDist = new THREE.Vector2();

function respawnToSpawn() {
    targetPos.copy(SPAWN);
    velocity.set(0, 0, 0);
    velocityY = 0;
    jumpThrustTime = 0;
    // Hard-set the kinematic body so the teleport doesn't infer a huge velocity
    // (which would otherwise fling nearby boxes across the scene).
    orbBody.setTranslation({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z }, true);
    // Clear the trail so it doesn't streak from the old location to spawn.
    trailPoints.length = 0;
    lastTrailPos.copy(SPAWN);
    trailMesh.visible = false;
}

function smoothstep01(t) {
    const c = Math.min(1, Math.max(0, t));
    return c * c * (3 - 2 * c);
}

function updateBoundary(dt) {
    _spawnDist.set(targetPos.x - SPAWN.x, targetPos.z - SPAWN.z);
    const dist = _spawnDist.length();

    if (respawnState === 'idle') {
        if (params.boundaryEnabled && dist >= params.boundaryRadius) {
            respawnState = 'out';
            respawnTimer = 0;
            // Match the veil to the live fog colour the moment the fade begins.
            if (fogVeil) fogVeil.style.backgroundColor = '#' + scene.fog.color.getHexString();
        } else {
            // Warning haze ramps up between warn radius and respawn radius.
            const span = params.boundaryRadius - params.boundaryWarnRadius;
            const t = span > 0 ? (dist - params.boundaryWarnRadius) / span : 0;
            veilOpacity = smoothstep01(t) * params.boundaryWarnOpacity;
        }
    }

    if (respawnState === 'out') {
        respawnTimer += dt;
        const t = respawnTimer / Math.max(1e-4, params.respawnFadeOut);
        veilOpacity = params.boundaryWarnOpacity +
            (1 - params.boundaryWarnOpacity) * Math.min(1, t);
        if (t >= 1) {
            veilOpacity = 1;
            respawnToSpawn();
            respawnState = 'in';
            respawnTimer = 0;
        }
    } else if (respawnState === 'in') {
        respawnTimer += dt;
        const t = respawnTimer / Math.max(1e-4, params.respawnFadeIn);
        veilOpacity = 1 - Math.min(1, t);
        if (t >= 1) {
            veilOpacity = 0;
            respawnState = 'idle';
        }
    }

    // Only touch the DOM when the opacity actually changes — when idle and away
    // from the edge it stays a constant 0, so this skips a per-frame style write
    // and string allocation for nearly all of playtime.
    if (fogVeil && veilOpacity !== veilApplied) {
        fogVeil.style.opacity = veilOpacity === 0 ? '0' : veilOpacity.toFixed(3);
        veilApplied = veilOpacity;
    }
}

function animate() {
    const dt = Math.min(clock.getDelta(), 0.05);

    // Keyboard input, normalised so diagonals aren't faster (full speed).
    let inputX = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    let inputZ = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
    const kbLen = Math.hypot(inputX, inputZ);
    if (kbLen > 1) { inputX /= kbLen; inputZ /= kbLen; }
    // Add the touch joystick (its magnitude already encodes partial speed), then
    // clamp the combined vector so the two inputs can't stack past full speed.
    inputX += touchMove.x;
    inputZ += touchMove.z;
    const inLen = Math.hypot(inputX, inputZ);
    if (inLen > 1) { inputX /= inLen; inputZ /= inLen; }
    moveDir.set(inputX, 0, inputZ);
    targetVelocity.set(moveDir.x * params.moveSpeed, 0, moveDir.z * params.moveSpeed);

    // Exponential easing toward target velocity (frame-rate independent)
    const smoothing = 1 - Math.exp(-params.accelRate * dt);
    velocity.x += (targetVelocity.x - velocity.x) * smoothing;
    velocity.z += (targetVelocity.z - velocity.z) * smoothing;

    targetPos.x += velocity.x * dt;
    targetPos.z += velocity.z * dt;

    // Hover level tracks the terrain surface under the orb, so it floats a fixed
    // gap above the hills/valleys. Gravity (always applied below) pulls it down
    // to this level each frame, letting it follow the ground as it roams.
    const hoverY = terrainHeightAt(targetPos.x, targetPos.z) + HOVER_HEIGHT;

    // Propulsion phase: apply upward thrust so the launch accelerates from
    // zero instead of starting at full speed.
    if (jumpThrustTime > 0) {
        const thrustStep = Math.min(jumpThrustTime, dt);
        velocityY += params.jumpThrustAccel * thrustStep;
        jumpThrustTime -= dt;
    }

    velocityY -= (velocityY > 0 ? params.gravityUp : params.gravityDown) * dt;

    // Soft landing — exponentially damp downward velocity as we approach
    // the hover level, so the fall eases out at the very end.
    if (velocityY < 0) {
        const heightAbove = targetPos.y - hoverY;
        if (heightAbove > 0 && heightAbove < SOFT_LAND_DISTANCE) {
            const proximity = 1 - heightAbove / SOFT_LAND_DISTANCE;
            velocityY *= Math.exp(-SOFT_LAND_DAMPING * proximity * dt);
        }
    }

    targetPos.y += velocityY * dt;
    if (targetPos.y < hoverY) {
        targetPos.y = hoverY;
        velocityY = 0;
    }

    // World boundary: may teleport targetPos back to spawn, so run it before the
    // orb/camera positions are derived from targetPos below.
    updateBoundary(dt);

    // Bobbing is more intense when idle; scales down when moving at speed
    const speed = Math.hypot(velocity.x, velocity.z);
    const idleFactor = 1 - Math.min(1, speed / params.moveSpeed);
    const targetBobScale = 1 + idleFactor * params.bobIdleBoost;
    // Ease the bob amplitude toward its target so it fades in/out gently instead
    // of snapping when you stop — otherwise the orb lurches to the enlarged bob
    // offset the instant velocity decays.
    bobScaleSmooth += (targetBobScale - bobScaleSmooth) *
        (1 - Math.exp(-params.bobResponse * dt));
    const bobScale = bobScaleSmooth;

    // Quasi-random bobbing via summed sines on each axis
    const t = clock.elapsedTime;
    const bobX =
        (Math.sin(t * 1.1 + 0.7) * 0.6 + Math.sin(t * 1.9 + 2.1) * 0.4) *
        params.bobXZ *
        bobScale;
    const bobY =
        (Math.sin(t * 1.7) * 0.6 + Math.sin(t * 2.3 + 1.2) * 0.4) *
        params.bobY *
        bobScale;
    const bobZ =
        (Math.sin(t * 1.3 + 1.5) * 0.6 + Math.sin(t * 2.1 + 0.3) * 0.4) *
        params.bobXZ *
        bobScale;
    orb.position.set(
        targetPos.x + bobX,
        targetPos.y + bobY,
        targetPos.z + bobZ
    );

    updateTrail(dt);

    // Drive the particle field's light reaction from the live orb position.
    particleMaterial.uniforms.uTime.value = clock.elapsedTime;
    particleMaterial.uniforms.uOrbPos.value.copy(orb.position);

    // Water: drift the ripple bands and keep the fog uniforms in step with the
    // scene fog (which the GUI can retune live).
    waterTime += dt * params.waterFlowSpeed;
    const wu = waterMaterial.uniforms;
    wu.uTime.value = waterTime;
    wu.uFogColor.value.copy(scene.fog.color);
    wu.uFogDensity.value = scene.fog.density;

    // Grass: re-centre the infinite patch under the orb, advance wind, and sync
    // the orb glow + fog so the field matches the rest of the scene.
    const gu = grassMaterial.uniforms;
    gu.uCenter.value.set(targetPos.x, targetPos.z);
    grassWindTime += dt * 0.1 * gu.uWindStrength.value; // localTime accumulation
    gu.uTime.value = grassWindTime;
    gu.uOrbPos.value.copy(orb.position);
    gu.uOrbColor.value.copy(orbLight.color);
    gu.uOrbIntensity.value = orbLight.intensity;
    gu.uFogColor.value.copy(scene.fog.color);
    gu.uFogDensity.value = scene.fog.density;

    // Hand the grass the orb light's live point-shadow cube + parameters so it
    // can receive shadows, and keep the caster's distance reference in sync.
    if (params.grassShadowsEnabled && orbLight.shadow.map) {
        gu.uShadowMap.value = orbLight.shadow.map.texture;
    }
    gu.uShadowMapSize.value.copy(orbLight.shadow.mapSize);
    gu.uShadowBias.value = orbLight.shadow.bias;
    gu.uShadowRadius.value = orbLight.shadow.radius;
    gu.uShadowNear.value = orbLight.shadow.camera.near;
    gu.uShadowFar.value = orbLight.shadow.camera.far;
    const gd = grassDistanceMaterial.uniforms;
    gd.uRefPosition.value.copy(orb.position);
    gd.uNearDistance.value = orbLight.shadow.camera.near;
    gd.uFarDistance.value = orbLight.shadow.camera.far;

    // Drive the orb's kinematic body from targetPos (un-bobbed, so contacts
    // stay stable) — Rapier infers velocity from successive translations.
    orbBody.setNextKinematicTranslation({
        x: targetPos.x,
        y: targetPos.y,
        z: targetPos.z,
    });
    world.step();
    for (const { mesh, body } of boxes) {
        const t = body.translation();
        const r = body.rotation();
        mesh.position.set(t.x, t.y, t.z);
        mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }

    idleTime += dt;
    const idleDelay = hasMoved ? IDLE_DELAY_REPEAT : IDLE_DELAY_FIRST;
    if (idleHint && idleTime >= idleDelay && !idleHint.classList.contains('visible')) {
        showIdleHint();
    }

    // Camera follows the orb in all three axes so jumps lift the view too
    camera.position.copy(targetPos).add(cameraOffset);
    camera.lookAt(targetPos);

    composer.render();
    requestAnimationFrame(animate);
}
animate();
