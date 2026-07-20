import * as THREE from 'three';
import './style.css';

const canvas = document.querySelector('#game');
const startScreen = document.querySelector('#start-screen');
const startButton = document.querySelector('#start-button');
const countdownElement = document.querySelector('#countdown');
const resultElement = document.querySelector('#round-result');
const resultKicker = document.querySelector('#result-kicker');
const resultTitle = document.querySelector('#result-title');
const restartCount = document.querySelector('#restart-count');
const eventToast = document.querySelector('#event-toast');
const speedFill = document.querySelector('#speed-fill');
const speedLabel = document.querySelector('#speed-label');
const soundToggle = document.querySelector('#sound-toggle');
const scoreElements = [document.querySelector('#score-one'), document.querySelector('#score-two')];
const jumpElements = [document.querySelector('#jumps-one'), document.querySelector('#jumps-two')];

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.setScissorTest(true);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080b16);
scene.fog = new THREE.FogExp2(0x080b16, 0.022);

const clock = new THREE.Clock();
const up = new THREE.Vector3(0, 1, 0);
const tempVector = new THREE.Vector3();
const tempVector2 = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();

const PLATFORM = { halfWidth: 8.6, front: 19, back: -43 };
const PLAYER_COLORS = [0xffc91c, 0x22dac9];
const PLAYER_DARK = [0xb96c0b, 0x0c7e93];
const START_POSITIONS = [new THREE.Vector3(-3, 0, 7), new THREE.Vector3(3, 0, 7)];

let gameState = 'menu';
let roundNumber = 1;
let roundTime = 0;
let spawnTimer = 1.5;
let obstacleId = 0;
let speedLevel = 1;
let lastAnnouncedLevel = 1;
let audioContext = null;
let soundEnabled = true;
const scheduledTimers = [];
const pressedKeys = new Set();
const obstacles = [];
const particles = [];

const palettes = {
  concrete: new THREE.MeshStandardMaterial({ color: 0x252b38, roughness: 0.82, metalness: 0.12 }),
  concreteSide: new THREE.MeshStandardMaterial({ color: 0x0d111c, roughness: 0.9, metalness: 0.08 }),
  edge: new THREE.MeshStandardMaterial({ color: 0xf44b3b, emissive: 0xf44b3b, emissiveIntensity: 2.2 }),
  hazard: new THREE.MeshStandardMaterial({ color: 0xff493d, roughness: 0.58, metalness: 0.18 }),
  hazardDark: new THREE.MeshStandardMaterial({ color: 0x311419, roughness: 0.7, metalness: 0.15 }),
  obstacle: new THREE.MeshStandardMaterial({ color: 0x596174, roughness: 0.62, metalness: 0.42 }),
  obstacleDark: new THREE.MeshStandardMaterial({ color: 0x1b202b, roughness: 0.7, metalness: 0.25 }),
};

setupLighting();
createArena();
createVoidDetails();

const players = [
  createPlayer(0, START_POSITIONS[0]),
  createPlayer(1, START_POSITIONS[1]),
];

const cameras = [createCamera(), createCamera()];
window.addEventListener('resize', onResize);
window.addEventListener('keydown', onKeyDown, { passive: false });
window.addEventListener('keyup', onKeyUp, { passive: false });
window.addEventListener('blur', () => pressedKeys.clear());
startButton.addEventListener('click', beginGame);
soundToggle.addEventListener('click', toggleSound);

animate();

function setupLighting() {
  const hemisphere = new THREE.HemisphereLight(0x8598d4, 0x090b12, 2.25);
  scene.add(hemisphere);

  const keyLight = new THREE.DirectionalLight(0xffffff, 3.8);
  keyLight.position.set(-7, 16, 10);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.left = -18;
  keyLight.shadow.camera.right = 18;
  keyLight.shadow.camera.top = 24;
  keyLight.shadow.camera.bottom = -12;
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 55;
  keyLight.shadow.bias = -0.0003;
  scene.add(keyLight);

  const cyanRim = new THREE.PointLight(0x25dccc, 34, 30, 2);
  cyanRim.position.set(9, 3, -9);
  scene.add(cyanRim);

  const warmRim = new THREE.PointLight(0xff7a1a, 30, 28, 2);
  warmRim.position.set(-9, 4, 1);
  scene.add(warmRim);
}

function createArena() {
  const deck = new THREE.Mesh(new THREE.BoxGeometry(18, 0.7, 63), palettes.concrete);
  deck.position.set(0, -0.38, -12);
  deck.receiveShadow = true;
  scene.add(deck);

  const underside = new THREE.Mesh(new THREE.BoxGeometry(16.4, 2.2, 61), palettes.concreteSide);
  underside.position.set(0, -1.75, -12);
  scene.add(underside);

  const edgeGeometry = new THREE.BoxGeometry(0.11, 0.08, 63);
  for (const x of [-8.88, 8.88]) {
    const edge = new THREE.Mesh(edgeGeometry, palettes.edge);
    edge.position.set(x, 0.02, -12);
    scene.add(edge);
  }

  const seamMaterial = new THREE.MeshBasicMaterial({ color: 0x434b5c, transparent: true, opacity: 0.45 });
  for (let z = -40; z <= 18; z += 4) {
    const seam = new THREE.Mesh(new THREE.PlaneGeometry(17.7, 0.035), seamMaterial);
    seam.rotation.x = -Math.PI / 2;
    seam.position.set(0, 0.015, z);
    scene.add(seam);
  }

  const centerMarks = new THREE.MeshBasicMaterial({ color: 0xaab3c7, transparent: true, opacity: 0.18 });
  for (let z = -39; z <= 17; z += 3.3) {
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 1.4), centerMarks);
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(0, 0.025, z);
    scene.add(mark);
  }

  const startLine = new THREE.Group();
  for (let x = -8; x < 8; x += 1) {
    const tile = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 0.65),
      new THREE.MeshBasicMaterial({ color: Math.round(x) % 2 ? 0xeeeeea : 0x181b24 })
    );
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(x + 0.5, 0.03, 11.5);
    startLine.add(tile);
  }
  scene.add(startLine);
}

function createVoidDetails() {
  const starCount = 460;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const side = Math.random() > 0.5 ? 1 : -1;
    positions[i * 3] = side * (11 + Math.random() * 38);
    positions[i * 3 + 1] = -3 - Math.random() * 18;
    positions[i * 3 + 2] = -55 + Math.random() * 95;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x5b647f, size: 0.1, transparent: true, opacity: 0.7 }));
  scene.add(stars);

  const pillarMaterial = new THREE.MeshStandardMaterial({ color: 0x111624, roughness: 0.9, metalness: 0.12 });
  for (let i = 0; i < 26; i++) {
    const side = i % 2 ? 1 : -1;
    const width = 1.2 + Math.random() * 3.4;
    const height = 4 + Math.random() * 15;
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(width, height, width), pillarMaterial);
    pillar.position.set(side * (13 + Math.random() * 20), -4 - height / 2, -47 + Math.random() * 83);
    pillar.rotation.y = Math.random() * 0.5;
    scene.add(pillar);
  }
}

function createCamera() {
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 130);
  camera.position.set(0, 5.8, 13.5);
  return camera;
}

function capsuleSegment(radius, length, material) {
  const group = new THREE.Group();
  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.92, length, 10), material);
  const capTop = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 7), material);
  const capBottom = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.93, 10, 7), material);
  capTop.position.y = length / 2;
  capBottom.position.y = -length / 2;
  group.add(cylinder, capTop, capBottom);
  group.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return group;
}

function createPlayer(index, startPosition) {
  const color = PLAYER_COLORS[index];
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.12 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: PLAYER_DARK[index], roughness: 0.55, metalness: 0.2 });
  const jointMaterial = new THREE.MeshStandardMaterial({ color: 0x151925, roughness: 0.5, metalness: 0.55 });
  const visorMaterial = new THREE.MeshStandardMaterial({ color: 0x080c17, emissive: color, emissiveIntensity: 0.24, roughness: 0.2, metalness: 0.82 });
  const group = new THREE.Group();
  group.position.copy(startPosition);

  const rig = new THREE.Group();
  group.add(rig);

  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.48, 0.48), darkMaterial);
  pelvis.position.y = 1.05;
  pelvis.castShadow = true;
  rig.add(pelvis);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.92, 0.56), material);
  torso.position.y = 1.66;
  torso.castShadow = true;
  rig.add(torso);

  const chestPanel = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.25, 0.06), darkMaterial);
  chestPanel.position.set(0, 1.72, -0.3);
  rig.add(chestPanel);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.2, 10), jointMaterial);
  neck.position.y = 2.23;
  rig.add(neck);

  const headPivot = new THREE.Group();
  headPivot.position.y = 2.52;
  rig.add(headPivot);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.39, 14, 11), material);
  head.scale.set(0.95, 1.05, 0.92);
  head.castShadow = true;
  headPivot.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.08), visorMaterial);
  visor.position.set(0, 0.04, -0.35);
  headPivot.add(visor);

  const limbRig = {};
  for (const side of [-1, 1]) {
    const sideName = side < 0 ? 'left' : 'right';
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.66, 2.0, 0);
    rig.add(shoulder);
    const shoulderJoint = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 7), jointMaterial);
    shoulder.add(shoulderJoint);
    const upperArm = capsuleSegment(0.16, 0.58, material);
    upperArm.position.y = -0.34;
    shoulder.add(upperArm);
    const elbow = new THREE.Group();
    elbow.position.y = -0.7;
    shoulder.add(elbow);
    const elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 7), jointMaterial);
    elbow.add(elbowJoint);
    const lowerArm = capsuleSegment(0.14, 0.52, darkMaterial);
    lowerArm.position.y = -0.3;
    elbow.add(lowerArm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 7), material);
    hand.position.y = -0.61;
    elbow.add(hand);
    limbRig[`${sideName}Shoulder`] = shoulder;
    limbRig[`${sideName}Elbow`] = elbow;

    const hip = new THREE.Group();
    hip.position.set(side * 0.27, 0.91, 0);
    rig.add(hip);
    const upperLeg = capsuleSegment(0.2, 0.68, darkMaterial);
    upperLeg.position.y = -0.4;
    hip.add(upperLeg);
    const knee = new THREE.Group();
    knee.position.y = -0.82;
    hip.add(knee);
    const kneeJoint = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 7), jointMaterial);
    knee.add(kneeJoint);
    const lowerLeg = capsuleSegment(0.17, 0.62, material);
    lowerLeg.position.y = -0.36;
    knee.add(lowerLeg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.2, 0.62), jointMaterial);
    foot.position.set(0, -0.72, -0.12);
    foot.castShadow = true;
    knee.add(foot);
    limbRig[`${sideName}Hip`] = hip;
    limbRig[`${sideName}Knee`] = knee;
  }

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.73, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.035;
  group.add(marker);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.65, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.025;
  group.add(shadow);

  scene.add(group);
  const ragdoll = createPhysicsRagdoll(color, darkMaterial.color.getHex());
  scene.add(ragdoll.group);

  return {
    index,
    group,
    rig,
    marker,
    shadow,
    headPivot,
    limbRig,
    ragdoll,
    position: group.position,
    velocity: new THREE.Vector3(),
    startPosition: startPosition.clone(),
    jumps: 0,
    alive: true,
    falling: false,
    hitCooldown: 0,
    stun: 0,
    runPhase: index * Math.PI,
    score: 0,
  };
}

function createPhysicsRagdoll(color, darkColor) {
  const group = new THREE.Group();
  group.visible = false;
  const bright = new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.12 });
  const dark = new THREE.MeshStandardMaterial({ color: darkColor, roughness: 0.55, metalness: 0.2 });
  const points = {};
  const definitions = {
    pelvis: [0, 1.05, 0], chest: [0, 1.78, 0], head: [0, 2.55, 0],
    leftShoulder: [-0.58, 1.98, 0], leftElbow: [-0.73, 1.34, 0], leftHand: [-0.8, 0.75, 0],
    rightShoulder: [0.58, 1.98, 0], rightElbow: [0.73, 1.34, 0], rightHand: [0.8, 0.75, 0],
    leftHip: [-0.25, 0.93, 0], leftKnee: [-0.27, 0.16, 0], leftFoot: [-0.27, -0.52, -0.14],
    rightHip: [0.25, 0.93, 0], rightKnee: [0.27, 0.16, 0], rightFoot: [0.27, -0.52, -0.14],
  };
  for (const [name, array] of Object.entries(definitions)) {
    const position = new THREE.Vector3(...array);
    points[name] = { position, previous: position.clone(), locked: false };
  }

  const constraints = [
    ['pelvis', 'chest'], ['chest', 'head'],
    ['chest', 'leftShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftHand'],
    ['chest', 'rightShoulder'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightHand'],
    ['pelvis', 'leftHip'], ['leftHip', 'leftKnee'], ['leftKnee', 'leftFoot'],
    ['pelvis', 'rightHip'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightFoot'],
    ['leftShoulder', 'rightShoulder'], ['leftHip', 'rightHip'],
  ].map(([a, b]) => ({ a, b, length: points[a].position.distanceTo(points[b].position) }));

  const segments = [];
  const addSegment = (a, b, radius, material) => {
    const mesh = capsuleSegment(radius, 1, material);
    group.add(mesh);
    segments.push({ a, b, mesh });
  };
  addSegment('pelvis', 'chest', 0.35, bright);
  addSegment('leftShoulder', 'leftElbow', 0.16, bright);
  addSegment('leftElbow', 'leftHand', 0.14, dark);
  addSegment('rightShoulder', 'rightElbow', 0.16, bright);
  addSegment('rightElbow', 'rightHand', 0.14, dark);
  addSegment('leftHip', 'leftKnee', 0.2, dark);
  addSegment('leftKnee', 'leftFoot', 0.17, bright);
  addSegment('rightHip', 'rightKnee', 0.2, dark);
  addSegment('rightKnee', 'rightFoot', 0.17, bright);

  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.39, 14, 10), bright);
  headMesh.castShadow = true;
  group.add(headMesh);

  return { group, points, constraints, segments, headMesh, active: false };
}

function resetRagdoll(ragdoll, origin, inheritedVelocity) {
  const offsets = {
    pelvis: [0, 1.05, 0], chest: [0, 1.78, 0], head: [0, 2.55, 0],
    leftShoulder: [-0.58, 1.98, 0], leftElbow: [-0.73, 1.34, 0], leftHand: [-0.8, 0.75, 0],
    rightShoulder: [0.58, 1.98, 0], rightElbow: [0.73, 1.34, 0], rightHand: [0.8, 0.75, 0],
    leftHip: [-0.25, 0.93, 0], leftKnee: [-0.27, 0.16, 0], leftFoot: [-0.27, -0.52, -0.14],
    rightHip: [0.25, 0.93, 0], rightKnee: [0.27, 0.16, 0], rightFoot: [0.27, -0.52, -0.14],
  };
  for (const [name, point] of Object.entries(ragdoll.points)) {
    point.position.set(...offsets[name]).add(origin);
    const scatter = new THREE.Vector3((Math.random() - 0.5) * 0.08, Math.random() * 0.05, (Math.random() - 0.5) * 0.08);
    point.previous.copy(point.position).sub(inheritedVelocity.clone().multiplyScalar(1 / 60)).sub(scatter);
  }
  ragdoll.group.visible = true;
  ragdoll.active = true;
  updateRagdollMeshes(ragdoll);
}

function updateRagdoll(ragdoll, dt) {
  if (!ragdoll.active) return;
  const step = Math.min(dt, 1 / 30);
  for (const point of Object.values(ragdoll.points)) {
    const velocity = tempVector.copy(point.position).sub(point.previous).multiplyScalar(0.992);
    point.previous.copy(point.position);
    point.position.add(velocity);
    point.position.y -= 20 * step * step;
  }

  for (let iteration = 0; iteration < 7; iteration++) {
    for (const constraint of ragdoll.constraints) {
      const a = ragdoll.points[constraint.a].position;
      const b = ragdoll.points[constraint.b].position;
      tempVector.copy(b).sub(a);
      const distance = Math.max(tempVector.length(), 0.0001);
      const correction = tempVector.multiplyScalar((distance - constraint.length) / distance * 0.5);
      a.add(correction);
      b.sub(correction);
    }
  }
  updateRagdollMeshes(ragdoll);
}

function updateRagdollMeshes(ragdoll) {
  for (const segment of ragdoll.segments) {
    const a = ragdoll.points[segment.a].position;
    const b = ragdoll.points[segment.b].position;
    tempVector.copy(b).sub(a);
    segment.mesh.position.copy(a).add(b).multiplyScalar(0.5);
    segment.mesh.scale.set(1, tempVector.length(), 1);
    segment.mesh.quaternion.setFromUnitVectors(up, tempVector.normalize());
  }
  ragdoll.headMesh.position.copy(ragdoll.points.head.position);
  const chestDirection = tempVector.copy(ragdoll.points.head.position).sub(ragdoll.points.chest.position).normalize();
  ragdoll.headMesh.quaternion.setFromUnitVectors(up, chestDirection);
}

function onKeyDown(event) {
  const controlledKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];
  if (controlledKeys.includes(event.code)) event.preventDefault();
  if (event.repeat) return;
  pressedKeys.add(event.code);

  if (gameState === 'menu' && (event.code === 'Space' || event.code === 'Enter')) {
    beginGame();
    return;
  }
  if (gameState !== 'playing') return;
  if (event.code === 'Space') jump(players[0]);
  if (event.code === 'Enter') jump(players[1]);
}

function onKeyUp(event) {
  pressedKeys.delete(event.code);
}

function jump(player) {
  if (!player.alive || player.jumps >= 2 || player.stun > 0.1) return;
  player.velocity.y = player.jumps === 0 ? 9.2 : 8.2;
  player.jumps += 1;
  updateJumpHud(player);
  spawnBurst(player.position.clone().add(new THREE.Vector3(0, 0.08, 0)), PLAYER_COLORS[player.index], 7, 2.2);
  playSound(player.jumps === 1 ? 'jump' : 'double');
}

function inputAxis(negativeKey, positiveKey) {
  return (pressedKeys.has(positiveKey) ? 1 : 0) - (pressedKeys.has(negativeKey) ? 1 : 0);
}

function updatePlayer(player, dt) {
  if (!player.alive) {
    updateRagdoll(player.ragdoll, dt);
    return;
  }

  player.hitCooldown = Math.max(0, player.hitCooldown - dt);
  player.stun = Math.max(0, player.stun - dt);
  const controls = player.index === 0
    ? { x: inputAxis('KeyA', 'KeyD'), z: inputAxis('KeyW', 'KeyS') }
    : { x: inputAxis('ArrowLeft', 'ArrowRight'), z: inputAxis('ArrowUp', 'ArrowDown') };

  const acceleration = player.stun > 0 ? 11 : 38;
  const targetX = controls.x * (player.stun > 0 ? 3.4 : 7.3);
  const targetZ = controls.z * (player.stun > 0 ? 2.7 : 5.4);
  player.velocity.x = THREE.MathUtils.damp(player.velocity.x, targetX, acceleration, dt);
  player.velocity.z = THREE.MathUtils.damp(player.velocity.z, targetZ, acceleration, dt);
  player.velocity.y -= 21 * dt;

  player.position.addScaledVector(player.velocity, dt);
  const overPlatform = Math.abs(player.position.x) < PLATFORM.halfWidth && player.position.z < PLATFORM.front && player.position.z > PLATFORM.back;
  if (overPlatform && player.position.y <= 0 && player.velocity.y <= 0) {
    if (player.jumps > 0) {
      spawnBurst(player.position.clone().add(new THREE.Vector3(0, 0.05, 0)), 0xb7becc, 5, 1.4);
    }
    player.position.y = 0;
    player.velocity.y = 0;
    player.jumps = 0;
    player.falling = false;
    updateJumpHud(player);
  } else if (!overPlatform && player.position.y <= 0.05) {
    player.falling = true;
  }

  player.position.z = Math.max(player.position.z, PLATFORM.back - 3);
  animateRig(player, controls, dt, overPlatform);

  if (player.position.y < -2.2) killPlayer(player);
}

function animateRig(player, controls, dt, overPlatform) {
  const planarSpeed = Math.hypot(player.velocity.x, player.velocity.z);
  player.runPhase += dt * (5.5 + planarSpeed * 1.25);
  const stride = Math.sin(player.runPhase) * Math.min(planarSpeed / 7, 1);
  const bounce = Math.abs(Math.sin(player.runPhase * 2)) * 0.055 * Math.min(planarSpeed / 5, 1);
  const airborne = player.position.y > 0.05 || !overPlatform;
  const hitWobble = player.stun > 0 ? Math.sin(player.stun * 28) * player.stun * 0.6 : 0;

  player.rig.position.y = 0.72 + bounce;
  player.rig.rotation.z = THREE.MathUtils.damp(player.rig.rotation.z, -player.velocity.x * 0.035 + hitWobble, 8, dt);
  player.rig.rotation.x = THREE.MathUtils.damp(player.rig.rotation.x, player.velocity.z * -0.035, 7, dt);
  player.headPivot.rotation.z = -player.rig.rotation.z * 0.42;
  player.headPivot.rotation.x = Math.sin(player.runPhase * 0.5) * 0.035;

  const armAngle = airborne ? -0.55 : stride * 0.75;
  const legAngle = airborne ? 0.38 : stride * 0.78;
  player.limbRig.leftShoulder.rotation.x = THREE.MathUtils.damp(player.limbRig.leftShoulder.rotation.x, armAngle, 12, dt);
  player.limbRig.rightShoulder.rotation.x = THREE.MathUtils.damp(player.limbRig.rightShoulder.rotation.x, -armAngle, 12, dt);
  player.limbRig.leftElbow.rotation.x = airborne ? -0.7 : -0.2 - Math.max(0, -stride) * 0.45;
  player.limbRig.rightElbow.rotation.x = airborne ? -0.7 : -0.2 - Math.max(0, stride) * 0.45;
  player.limbRig.leftHip.rotation.x = THREE.MathUtils.damp(player.limbRig.leftHip.rotation.x, -legAngle, 12, dt);
  player.limbRig.rightHip.rotation.x = THREE.MathUtils.damp(player.limbRig.rightHip.rotation.x, legAngle, 12, dt);
  player.limbRig.leftKnee.rotation.x = airborne ? -0.65 : Math.max(0, stride) * 0.65;
  player.limbRig.rightKnee.rotation.x = airborne ? -0.15 : Math.max(0, -stride) * 0.65;
  player.marker.visible = overPlatform && player.position.y < 2.8;
  player.marker.position.y = -player.position.y + 0.035;
  player.shadow.visible = overPlatform && player.position.y < 3.8;
  player.shadow.position.y = -player.position.y + 0.025;
  const shadowScale = 1 - Math.min(player.position.y / 8, 0.6);
  player.shadow.scale.setScalar(shadowScale);
  player.shadow.material.opacity = 0.3 * shadowScale;
}

function killPlayer(player) {
  if (!player.alive) return;
  player.alive = false;
  player.group.visible = false;
  const inherited = player.velocity.clone().multiplyScalar(0.85);
  inherited.y = Math.min(inherited.y, -2);
  resetRagdoll(player.ragdoll, player.position, inherited);
  spawnBurst(player.position.clone(), PLAYER_COLORS[player.index], 20, 5.5);
  playSound('fall');
  window.setTimeout(checkRoundEnd, 160);
}

function createObstacleMesh(group, width, height, depth, x, y = height / 2, material = palettes.obstacle) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function decorateHazard(mesh, width, height, depth) {
  const stripeMaterial = new THREE.MeshBasicMaterial({ color: 0xff4b3b });
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.08, width * 0.78), 0.065, depth + 0.018), stripeMaterial);
  stripe.position.set(mesh.position.x, mesh.position.y + height / 2 + 0.035, mesh.position.z);
  mesh.parent.add(stripe);
}

function spawnObstaclePattern() {
  const difficulty = Math.min(roundTime / 45, 1);
  const roll = Math.random();
  if (roll < 0.28) spawnCratePattern();
  else if (roll < 0.53) spawnHurdle();
  else if (roll < 0.76 || difficulty < 0.22) spawnWallGap();
  else spawnSpinner();
}

function baseObstacle(type, z = -38) {
  const group = new THREE.Group();
  group.position.z = z;
  scene.add(group);
  const obstacle = { id: obstacleId++, type, group, z, colliders: [], passed: new Set(), rotation: 0, speedBoost: 1 };
  obstacles.push(obstacle);
  return obstacle;
}

function spawnCratePattern() {
  const obstacle = baseObstacle('crates');
  const laneXs = [-6, -3, 0, 3, 6].sort(() => Math.random() - 0.5);
  const count = Math.random() > 0.45 ? 3 : 2;
  for (let i = 0; i < count; i++) {
    const x = laneXs[i];
    const height = 1.35 + Math.random() * 0.65;
    const mesh = createObstacleMesh(obstacle.group, 2.15, height, 1.45, x, height / 2, palettes.obstacle);
    decorateHazard(mesh, 2.15, height, 1.45);
    obstacle.colliders.push({ kind: 'box', x, y: height / 2, width: 2.15, height, depth: 1.45 });
  }
}

function spawnHurdle() {
  const obstacle = baseObstacle('hurdle');
  const y = 0.68;
  const beam = createObstacleMesh(obstacle.group, 15.4, 0.65, 0.75, 0, y, palettes.hazard);
  decorateHazard(beam, 15.4, 0.65, 0.75);
  for (const x of [-7.2, 7.2]) createObstacleMesh(obstacle.group, 0.24, 1.35, 0.52, x, 0.67, palettes.obstacleDark);
  obstacle.colliders.push({ kind: 'box', x: 0, y, width: 15.4, height: 0.65, depth: 0.75 });
}

function spawnWallGap() {
  const obstacle = baseObstacle('wall');
  const gapCenter = [-4.5, -1.5, 1.5, 4.5][Math.floor(Math.random() * 4)];
  const segmentWidth = 2.45;
  for (const x of [-6.3, -3.15, 0, 3.15, 6.3]) {
    if (Math.abs(x - gapCenter) < 2.3) continue;
    const height = 2.55;
    const mesh = createObstacleMesh(obstacle.group, segmentWidth, height, 0.9, x, height / 2, palettes.obstacleDark);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(segmentWidth * 0.68, height * 0.48, 0.08), palettes.hazard);
    panel.position.set(x, height * 0.54, -0.49);
    obstacle.group.add(panel);
    obstacle.colliders.push({ kind: 'box', x, y: height / 2, width: segmentWidth, height, depth: 0.9 });
  }
}

function spawnSpinner() {
  const obstacle = baseObstacle('spinner');
  const centerX = (Math.random() - 0.5) * 4.5;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.75, 12), palettes.obstacleDark);
  post.position.set(centerX, 0.88, 0);
  post.castShadow = true;
  obstacle.group.add(post);
  const spinnerPivot = new THREE.Group();
  spinnerPivot.position.set(centerX, 0.86, 0);
  obstacle.group.add(spinnerPivot);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.38, 0.48), palettes.hazard);
  beam.castShadow = true;
  spinnerPivot.add(beam);
  for (const x of [-4.15, 4.15]) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.72, 0.68), palettes.obstacleDark);
    cap.position.x = x;
    spinnerPivot.add(cap);
  }
  obstacle.spinnerPivot = spinnerPivot;
  obstacle.centerX = centerX;
  obstacle.radius = 4.35;
  obstacle.rotation = Math.random() * Math.PI;
  obstacle.speedBoost = 0.82;
}

function updateObstacles(dt) {
  const forwardSpeed = 7.4 * speedLevel;
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const obstacle = obstacles[i];
    obstacle.group.position.z += forwardSpeed * obstacle.speedBoost * dt;
    if (obstacle.type === 'spinner') {
      obstacle.rotation += dt * (2.2 + speedLevel * 0.55);
      obstacle.spinnerPivot.rotation.y = obstacle.rotation;
    }
    for (const player of players) {
      if (!player.alive || player.hitCooldown > 0) continue;
      if (obstacle.type === 'spinner') checkSpinnerCollision(player, obstacle, forwardSpeed);
      else checkBoxCollisions(player, obstacle, forwardSpeed);
    }
    if (obstacle.group.position.z > 24) {
      scene.remove(obstacle.group);
      disposeObject(obstacle.group);
      obstacles.splice(i, 1);
    }
  }
}

function checkBoxCollisions(player, obstacle, forwardSpeed) {
  for (const collider of obstacle.colliders) {
    const worldZ = obstacle.group.position.z;
    const overlapX = Math.abs(player.position.x - collider.x) < collider.width / 2 + 0.43;
    const overlapZ = Math.abs(player.position.z - worldZ) < collider.depth / 2 + 0.4;
    const playerBottom = player.position.y + 0.06;
    const verticalOverlap = playerBottom < collider.height && player.position.y + 2.45 > 0;
    if (overlapX && overlapZ && verticalOverlap) {
      const side = Math.sign(player.position.x - collider.x) || (Math.random() > 0.5 ? 1 : -1);
      hitPlayer(player, new THREE.Vector3(side * 4.7, 2.6, forwardSpeed * 1.18));
      return;
    }
  }
}

function checkSpinnerCollision(player, obstacle, forwardSpeed) {
  if (Math.abs(player.position.y - 0.85) > 0.78) return;
  const localZ = player.position.z - obstacle.group.position.z;
  const localX = player.position.x - obstacle.centerX;
  const directionX = Math.cos(obstacle.rotation);
  const directionZ = -Math.sin(obstacle.rotation);
  const projection = THREE.MathUtils.clamp(localX * directionX + localZ * directionZ, -obstacle.radius, obstacle.radius);
  const closestX = directionX * projection;
  const closestZ = directionZ * projection;
  const distance = Math.hypot(localX - closestX, localZ - closestZ);
  if (distance < 0.68) {
    const tangentX = -directionZ * Math.sign(projection || 1);
    hitPlayer(player, new THREE.Vector3(tangentX * 8.5, 3.3, forwardSpeed + directionX * 4));
  }
}

function hitPlayer(player, impulse) {
  player.velocity.x += impulse.x;
  player.velocity.y = Math.max(player.velocity.y, impulse.y);
  player.velocity.z += impulse.z;
  player.hitCooldown = 0.5;
  player.stun = 0.64;
  spawnBurst(player.position.clone().add(new THREE.Vector3(0, 1.2, 0)), 0xff503e, 13, 5.4);
  playSound('hit');
  shakeCamera(player.index, 0.26);
}

function disposeObject(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
  });
}

function spawnBurst(position, color, amount, force) {
  const material = new THREE.MeshBasicMaterial({ color });
  for (let i = 0; i < amount; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.08 + Math.random() * 0.1, 0.08 + Math.random() * 0.1, 0.08), material);
    mesh.position.copy(position);
    scene.add(mesh);
    particles.push({
      mesh,
      velocity: new THREE.Vector3((Math.random() - 0.5) * force, Math.random() * force, (Math.random() - 0.5) * force),
      life: 0.35 + Math.random() * 0.45,
      maxLife: 0.8,
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const particle = particles[i];
    particle.life -= dt;
    particle.velocity.y -= 11 * dt;
    particle.mesh.position.addScaledVector(particle.velocity, dt);
    particle.mesh.rotation.x += dt * 8;
    particle.mesh.rotation.y += dt * 11;
    particle.mesh.scale.setScalar(Math.max(0, particle.life / particle.maxLife));
    if (particle.life <= 0) {
      scene.remove(particle.mesh);
      particle.mesh.geometry.dispose();
      particles.splice(i, 1);
    }
  }
}

function updateCamera(camera, player, dt) {
  const targetX = THREE.MathUtils.clamp(player.position.x, -5, 5);
  const targetY = Math.max(5.7, player.position.y + 4.8);
  const targetZ = player.position.z + 12.6;
  camera.position.x = THREE.MathUtils.damp(camera.position.x, targetX, 5.5, dt);
  camera.position.y = THREE.MathUtils.damp(camera.position.y, targetY, 4.5, dt);
  camera.position.z = THREE.MathUtils.damp(camera.position.z, targetZ, 4.2, dt);
  if (camera.userData.shake > 0) {
    camera.userData.shake -= dt;
    camera.position.x += (Math.random() - 0.5) * camera.userData.shake * 0.65;
    camera.position.y += (Math.random() - 0.5) * camera.userData.shake * 0.45;
  }
  tempVector.set(player.position.x * 0.72, Math.max(1.15, player.position.y + 0.9), player.position.z - 6.7);
  camera.lookAt(tempVector);
}

function shakeCamera(index, amount) {
  cameras[index].userData.shake = amount;
}

function updateGame(dt) {
  updateParticles(dt);
  for (const player of players) updatePlayer(player, dt);

  if (gameState === 'playing') {
    roundTime += dt;
    speedLevel = 1 + Math.min(roundTime / 52, 0.88);
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnObstaclePattern();
      const baseInterval = 1.9 - Math.min(roundTime / 80, 0.72);
      spawnTimer = baseInterval + Math.random() * 0.52;
    }
    updateObstacles(dt);
    updateSpeedHud();
    const currentAnnouncement = Math.floor((speedLevel - 1) / 0.2) + 1;
    if (currentAnnouncement > lastAnnouncedLevel) {
      lastAnnouncedLevel = currentAnnouncement;
      showToast('TEMPO STEIGT');
      playSound('speed');
    }
  }

  updateCamera(cameras[0], players[0], dt);
  updateCamera(cameras[1], players[1], dt);
}

function render() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const leftWidth = Math.floor(width / 2);
  const rightWidth = width - leftWidth;
  const viewportWidths = [leftWidth, rightWidth];
  const viewportXs = [0, leftWidth];
  for (let i = 0; i < 2; i++) {
    cameras[i].aspect = viewportWidths[i] / height;
    cameras[i].updateProjectionMatrix();
    renderer.setViewport(viewportXs[i], 0, viewportWidths[i], height);
    renderer.setScissor(viewportXs[i], 0, viewportWidths[i], height);
    renderer.render(scene, cameras[i]);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateGame(dt);
  render();
}

function beginGame() {
  if (gameState !== 'menu') return;
  initAudio();
  startScreen.classList.remove('overlay--visible');
  roundNumber = 1;
  players.forEach((player) => { player.score = 0; });
  updateScoreHud();
  startRound();
}

function startRound() {
  clearScheduledTimers();
  clearObstacles();
  resultElement.classList.remove('show', 'is-p2', 'is-draw');
  roundTime = 0;
  speedLevel = 1;
  lastAnnouncedLevel = 1;
  spawnTimer = 1.25;
  document.querySelector('#round-number').textContent = roundNumber;
  updateSpeedHud();
  players.forEach(resetPlayer);
  gameState = 'countdown';
  runCountdown();
}

function resetPlayer(player) {
  player.group.visible = true;
  player.position.copy(player.startPosition);
  player.velocity.set(0, 0, 0);
  player.jumps = 0;
  player.alive = true;
  player.falling = false;
  player.hitCooldown = 0;
  player.stun = 0;
  player.rig.position.set(0, 0.72, 0);
  player.rig.rotation.set(0, 0, 0);
  player.ragdoll.active = false;
  player.ragdoll.group.visible = false;
  updateJumpHud(player);
}

function runCountdown() {
  const entries = [
    { text: '3', delay: 0, sound: 'tick' },
    { text: '2', delay: 760, sound: 'tick' },
    { text: '1', delay: 1520, sound: 'tick' },
    { text: 'RUN!', delay: 2280, sound: 'go', go: true },
  ];
  for (const entry of entries) {
    schedule(() => {
      countdownElement.textContent = entry.text;
      countdownElement.className = `countdown${entry.go ? ' go' : ''}`;
      void countdownElement.offsetWidth;
      countdownElement.classList.add('show');
      playSound(entry.sound);
    }, entry.delay);
  }
  schedule(() => {
    countdownElement.className = 'countdown';
    gameState = 'playing';
  }, 2920);
}

function checkRoundEnd() {
  if (gameState !== 'playing') return;
  const alivePlayers = players.filter((player) => player.alive);
  if (alivePlayers.length === 2) return;
  gameState = 'roundOver';
  let winner = null;
  if (alivePlayers.length === 1) {
    winner = alivePlayers[0];
    winner.score += 1;
  }
  updateScoreHud();
  showRoundResult(winner);
}

function showRoundResult(winner) {
  resultElement.classList.remove('is-p2', 'is-draw');
  if (winner) {
    resultKicker.textContent = 'RUNDE BEENDET';
    resultTitle.innerHTML = `SPIELER ${winner.index + 1}<br><span>GEWINNT</span>`;
    if (winner.index === 1) resultElement.classList.add('is-p2');
    playSound('win');
  } else {
    resultKicker.textContent = 'BEIDE GEFALLEN';
    resultTitle.innerHTML = 'KEINER<br><span>GEWINNT</span>';
    resultElement.classList.add('is-draw');
  }
  resultElement.classList.add('show');
  restartCount.textContent = '3';
  schedule(() => { restartCount.textContent = '2'; }, 1000);
  schedule(() => { restartCount.textContent = '1'; }, 2000);
  schedule(() => {
    roundNumber += 1;
    startRound();
  }, 3000);
}

function clearObstacles() {
  for (const obstacle of obstacles) {
    scene.remove(obstacle.group);
    disposeObject(obstacle.group);
  }
  obstacles.length = 0;
}

function schedule(callback, delay) {
  const timer = window.setTimeout(callback, delay);
  scheduledTimers.push(timer);
}

function clearScheduledTimers() {
  while (scheduledTimers.length) window.clearTimeout(scheduledTimers.pop());
}

function updateJumpHud(player) {
  const bars = jumpElements[player.index].querySelectorAll('i');
  bars.forEach((bar, index) => bar.classList.toggle('used', index < player.jumps));
}

function updateScoreHud() {
  players.forEach((player, index) => { scoreElements[index].textContent = player.score; });
}

function updateSpeedHud() {
  const progress = THREE.MathUtils.clamp((speedLevel - 1) / 0.88, 0, 1);
  speedFill.style.width = `${12 + progress * 88}%`;
  speedLabel.textContent = `${speedLevel.toFixed(1)}×`;
}

function showToast(text) {
  eventToast.textContent = text;
  eventToast.classList.remove('show');
  void eventToast.offsetWidth;
  eventToast.classList.add('show');
}

function initAudio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') audioContext.resume();
}

function playSound(type) {
  if (!soundEnabled || !audioContext) return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  const presets = {
    jump: ['square', 220, 360, 0.1, 0.055],
    double: ['square', 320, 560, 0.13, 0.05],
    hit: ['sawtooth', 120, 48, 0.18, 0.075],
    fall: ['sawtooth', 170, 34, 0.52, 0.07],
    tick: ['square', 280, 220, 0.08, 0.045],
    go: ['square', 330, 660, 0.22, 0.055],
    win: ['triangle', 330, 740, 0.5, 0.065],
    speed: ['sine', 440, 660, 0.18, 0.04],
  };
  const [wave, from, to, duration, volume] = presets[type] || presets.tick;
  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(from, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(to, 1), now + duration);
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  soundToggle.classList.toggle('is-muted', !soundEnabled);
  soundToggle.textContent = soundEnabled ? '♪' : '×';
  if (soundEnabled) {
    initAudio();
    playSound('tick');
  }
}

function onResize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
