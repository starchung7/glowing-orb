import * as THREE from 'three';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    200
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

// Glossy black floor
const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshPhysicalMaterial({
        color: 0x050505,
        roughness: 0.2,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
    })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// Tiny glowing orb — same radius as the trail tube so they sit flush
const ORB_RADIUS = 0.01;
const orb = new THREE.Mesh(
    new THREE.SphereGeometry(ORB_RADIUS, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
);
orb.position.y = ORB_RADIUS;
scene.add(orb);

// A point light at the orb to faintly illuminate the floor around it
const orbLight = new THREE.PointLight(0xaaffaa, 1.5, 2.5, 2);
orb.add(orbLight);

// Continuous emissive trail tube that fades with age
const TRAIL_LIFETIME = 1.4;
const TRAIL_SPACING = 0.04;
const TRAIL_RADIUS = 0.01;
const TUBE_TUBULAR_SEGMENTS = 96;
const TUBE_RADIAL_SEGMENTS = 6;
const TRAIL_COLOR = new THREE.Color(0x9af07a);

const trailPoints = []; // [{ pos: Vector3, age: number }]
const lastTrailPos = orb.position.clone();

const trailMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
});
const trailMesh = new THREE.Mesh(new THREE.BufferGeometry(), trailMaterial);
trailMesh.frustumCulled = false;
trailMesh.visible = false;
scene.add(trailMesh);

function updateTrail(dt) {
    if (orb.position.distanceTo(lastTrailPos) > TRAIL_SPACING) {
        trailPoints.push({
            pos: orb.position.clone(),
            age: 0,
        });
        lastTrailPos.copy(orb.position);
    }

    for (const p of trailPoints) p.age += dt;
    while (trailPoints.length > 0 && trailPoints[0].age >= TRAIL_LIFETIME) {
        trailPoints.shift();
    }

    if (trailPoints.length < 2) {
        trailMesh.visible = false;
        return;
    }

    const curve = new THREE.CatmullRomCurve3(trailPoints.map((p) => p.pos));
    const tubeGeo = new THREE.TubeGeometry(
        curve,
        TUBE_TUBULAR_SEGMENTS,
        TRAIL_RADIUS,
        TUBE_RADIAL_SEGMENTS,
        false
    );

    // Per-vertex color, fading from oldest (start) to newest (end)
    const positionCount = tubeGeo.attributes.position.count;
    const colorArray = new Float32Array(positionCount * 3);
    const vertsPerRing = TUBE_RADIAL_SEGMENTS + 1;
    for (let i = 0; i < positionCount; i++) {
        const ring = Math.floor(i / vertsPerRing);
        const t = ring / TUBE_TUBULAR_SEGMENTS; // 0 = oldest end, 1 = newest end
        const fIdx = t * (trailPoints.length - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(i0 + 1, trailPoints.length - 1);
        const frac = fIdx - i0;
        const age =
            trailPoints[i0].age * (1 - frac) + trailPoints[i1].age * frac;
        const k = Math.max(0, 1 - age / TRAIL_LIFETIME);
        colorArray[i * 3 + 0] = TRAIL_COLOR.r * k;
        colorArray[i * 3 + 1] = TRAIL_COLOR.g * k;
        colorArray[i * 3 + 2] = TRAIL_COLOR.b * k;
    }
    tubeGeo.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    trailMesh.geometry.dispose();
    trailMesh.geometry = tubeGeo;
    trailMesh.visible = true;
}

// Subtle ambient + hemisphere fill so the floor isn't pitch black everywhere
scene.add(new THREE.AmbientLight(0xffffff, 0.08));
scene.add(new THREE.HemisphereLight(0xffffff, 0x101010, 0.15));

// 3/4 view: above the orb, tilted forward
const cameraOffset = new THREE.Vector3(0, 1.8, 1.8);

// Input
const keys = { w: false, a: false, s: false, d: false };
const JUMP_SPEED = 3;
const GRAVITY = 18;
let velocityY = 0;

const isGrounded = () => orb.position.y <= ORB_RADIUS + 1e-4;

window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k in keys) {
        keys[k] = true;
        e.preventDefault();
    }
    if (e.code === 'Space') {
        if (isGrounded()) velocityY = JUMP_SPEED;
        e.preventDefault();
    }
});
window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k in keys) keys[k] = false;
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
const MOVE_SPEED = 2.5;
const moveDir = new THREE.Vector3();

function animate() {
    const dt = Math.min(clock.getDelta(), 0.05);

    moveDir.set(
        (keys.d ? 1 : 0) - (keys.a ? 1 : 0),
        0,
        (keys.s ? 1 : 0) - (keys.w ? 1 : 0)
    );
    if (moveDir.lengthSq() > 0) {
        moveDir.normalize().multiplyScalar(MOVE_SPEED * dt);
        orb.position.x += moveDir.x;
        orb.position.z += moveDir.z;
    }

    velocityY -= GRAVITY * dt;
    orb.position.y += velocityY * dt;
    if (orb.position.y < ORB_RADIUS) {
        orb.position.y = ORB_RADIUS;
        velocityY = 0;
    }

    updateTrail(dt);

    camera.position.copy(orb.position).add(cameraOffset);
    camera.lookAt(orb.position);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
animate();
