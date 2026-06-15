import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import GUI from 'lil-gui';

await RAPIER.init();

// Live-tunable parameters, exposed through the lil-gui panel below.
const params = {
    orbRadius: 0.008,
    orbLightIntensity: 1.5,
    orbLightColor: '#ccccff',
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
    particleLightColor: '#ccccff',
};

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
const orb = new THREE.Mesh(
    new THREE.SphereGeometry(params.orbRadius, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
);
orb.position.y = 0.3;
scene.add(orb);

// A point light at the orb to faintly illuminate the floor around it
const orbLight = new THREE.PointLight(params.orbLightColor, params.orbLightIntensity, 2.5, 2);
orb.add(orbLight);

// Hover + bobbing — the orb floats above the floor and drifts with sine noise
const HOVER_HEIGHT = 0.3;
const targetPos = new THREE.Vector3(0, HOVER_HEIGHT, 0);

// Physics — kinematic orb pushes dynamic boxes via Rapier
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// Ground plate: thin static cuboid with top face at y = 0
const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(
    RAPIER.ColliderDesc.cuboid(40, 0.05, 40).setTranslation(0, -0.05, 0),
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
    color: 0x262630,
    roughness: 0.35,
    metalness: 0.05,
    clearcoat: 0.7,
    clearcoatRoughness: 0.15,
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
    scene.add(mesh);
    const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(x, BOX_SIZE / 2, z)
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

// Continuous emissive trail tube that fades with age
const TUBE_TUBULAR_SEGMENTS = 96;
const TUBE_RADIAL_SEGMENTS = 6;
const TRAIL_COLOR = new THREE.Color(params.trailColor);

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
    if (orb.position.distanceTo(lastTrailPos) > params.trailSpacing) {
        trailPoints.push({
            pos: orb.position.clone(),
            age: 0,
        });
        lastTrailPos.copy(orb.position);
    }

    for (const p of trailPoints) p.age += dt;
    while (trailPoints.length > 0 && trailPoints[0].age >= params.trailLifetime) {
        trailPoints.shift();
    }

    // Always anchor the tip of the curve at the orb's current position so
    // the trail stays visually attached even between spawns / when stopped.
    const livePoints = trailPoints.slice();
    const last = livePoints[livePoints.length - 1];
    if (!last || orb.position.distanceToSquared(last.pos) > 1e-8) {
        livePoints.push({ pos: orb.position.clone(), age: 0 });
    }

    if (livePoints.length < 2) {
        trailMesh.visible = false;
        return;
    }

    const curve = new THREE.CatmullRomCurve3(livePoints.map((p) => p.pos));
    const tubeGeo = new THREE.TubeGeometry(
        curve,
        TUBE_TUBULAR_SEGMENTS,
        params.trailRadius,
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
        const fIdx = t * (livePoints.length - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(i0 + 1, livePoints.length - 1);
        const frac = fIdx - i0;
        const age =
            livePoints[i0].age * (1 - frac) + livePoints[i1].age * frac;
        const k = Math.max(0, 1 - age / params.trailLifetime);
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

// Floating dust particles — a single GPU point cloud (one draw call) whose
// brightness reacts to the orb's light. Lighting and drift are computed in the
// shader from the orb position, so the only per-frame CPU cost is two uniforms.
const PARTICLE_COUNT = 600;
const PARTICLE_AREA = 6;        // half-extent of the spawn volume in X/Z
const PARTICLE_Y_MIN = 0.15;
const PARTICLE_Y_MAX = 4.0;
const PARTICLE_LIGHT_RANGE = 3.5; // how far the orb's glow reaches a particle

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
        uAmbient: { value: new THREE.Color(0x0a0c14) },
        uLightRange: { value: PARTICLE_LIGHT_RANGE },
        uSizeScale: { value: 7.0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uOrbPos;
        uniform float uLightRange;
        uniform float uSizeScale;
        uniform float uPixelRatio;
        attribute float aSize;
        attribute vec3 aDrift;
        attribute float aPhase;
        varying float vAtten;
        varying float vTwinkle;

        void main() {
            vec3 p = position;
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

        void main() {
            vec2 uv = gl_PointCoord - 0.5;
            float r = length(uv);
            if (r > 0.5) discard;
            float soft = smoothstep(0.5, 0.0, r);
            vec3 col = uAmbient + uLightColor * vAtten;
            float alpha = soft * (0.12 + vAtten) * vTwinkle;
            gl_FragColor = vec4(col, alpha);
        }
    `,
});

const particles = new THREE.Points(particleGeo, particleMaterial);
particles.frustumCulled = false;
scene.add(particles);

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

const isGrounded = () => targetPos.y <= HOVER_HEIGHT + 1e-4;

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
});
window.addEventListener('keyup', (e) => {
    const action = keyMap[e.code];
    if (action) keys[action] = false;
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    particleMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
});

const clock = new THREE.Clock();
const moveDir = new THREE.Vector3();
const velocity = new THREE.Vector3();
const targetVelocity = new THREE.Vector3();

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

const particleFolder = gui.addFolder('Particles');
particleFolder.add(particleMaterial.uniforms.uLightRange, 'value', 0.5, 10, 0.1).name('light range');
particleFolder.add(particleMaterial.uniforms.uSizeScale, 'value', 1, 20, 0.5).name('size');
particleFolder.addColor(params, 'particleLightColor').name('light color')
    .onChange((v) => particleMaterial.uniforms.uLightColor.value.set(v));

function animate() {
    const dt = Math.min(clock.getDelta(), 0.05);

    moveDir.set(
        (keys.d ? 1 : 0) - (keys.a ? 1 : 0),
        0,
        (keys.s ? 1 : 0) - (keys.w ? 1 : 0)
    );
    if (moveDir.lengthSq() > 0) moveDir.normalize();
    targetVelocity.set(moveDir.x * params.moveSpeed, 0, moveDir.z * params.moveSpeed);

    // Exponential easing toward target velocity (frame-rate independent)
    const smoothing = 1 - Math.exp(-params.accelRate * dt);
    velocity.x += (targetVelocity.x - velocity.x) * smoothing;
    velocity.z += (targetVelocity.z - velocity.z) * smoothing;

    targetPos.x += velocity.x * dt;
    targetPos.z += velocity.z * dt;

    // Propulsion phase: apply upward thrust so the launch accelerates from
    // zero instead of starting at full speed.
    if (jumpThrustTime > 0) {
        const thrustStep = Math.min(jumpThrustTime, dt);
        velocityY += params.jumpThrustAccel * thrustStep;
        jumpThrustTime -= dt;
    }

    velocityY -= (velocityY > 0 ? params.gravityUp : params.gravityDown) * dt;

    // Soft landing — exponentially damp downward velocity as we approach
    // the hover plane, so the fall eases out at the very end.
    if (velocityY < 0) {
        const heightAbove = targetPos.y - HOVER_HEIGHT;
        if (heightAbove > 0 && heightAbove < SOFT_LAND_DISTANCE) {
            const proximity = 1 - heightAbove / SOFT_LAND_DISTANCE;
            velocityY *= Math.exp(-SOFT_LAND_DAMPING * proximity * dt);
        }
    }

    targetPos.y += velocityY * dt;
    if (targetPos.y < HOVER_HEIGHT) {
        targetPos.y = HOVER_HEIGHT;
        velocityY = 0;
    }

    // Bobbing is more intense when idle; scales down when moving at speed
    const speed = Math.hypot(velocity.x, velocity.z);
    const idleFactor = 1 - Math.min(1, speed / params.moveSpeed);
    const bobScale = 1 + idleFactor * 3.5;

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

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
animate();
