import * as THREE from 'three';

// Every part is parametric: dimensions are in cm, converted to world units here.
// A future voice command ("generate a wheel 10 x 4") just calls createPart('wheel', {diameter: 10, width: 4}).
export const PX_PER_CM = 16;
const c = (cm) => cm * PX_PER_CM;
const f = (v) => (Math.round(v * 10) / 10).toString();

const mat = (color, { metal = 0.3, rough = 0.5 } = {}) =>
  new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });

// Cylinder whose axis is local Z (three's default is Y).
function cyl(r, len, material, seg = 40) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2), material);
}
function box(x, y, z, material, at = [0, 0, 0]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), material);
  m.position.set(...at);
  return m;
}
function at(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }

function extrude(shape, depth, material) {
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, material);
}
function hole(shape, x, y, r) {
  const p = new THREE.Path();
  p.absarc(x, y, r, 0, Math.PI * 2, true);
  shape.holes.push(p);
}

// A port is a mounting point: position and normal in part-local px (unscaled). `hint` fixes the twist
// around the normal; `strict` means the twist may not be re-chosen when snapping.
const port = (name, kind, pos, normal, hint, strict = false) => ({ name, kind, pos, normal, hint, strict });
const KIND_PAIRS = [['motor-base', 'deck-edge'], ['comp-base', 'deck'], ['caster-top', 'underdeck'], ['hub', 'shaft']];
export const portsCompatible = (a, b) => KIND_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

function plateGrid({ length, width }) {
  const pitch = c(2);
  const nx = Math.max(1, Math.floor(length / 2) - 1), ny = Math.max(1, Math.floor(width / 2) - 1);
  return { pitch, nx, ny, x: (i) => (i - (nx - 1) / 2) * pitch, y: (j) => (j - (ny - 1) / 2) * pitch };
}

export const CATALOG = {
  wheel: {
    name: 'Wheel',
    real: '65–100 mm rubber robot wheel with motor hub',
    defaults: { diameter: 10, width: 4 },
    label: (p, s) => `Wheel  Ø${f(p.diameter * s)} × ${f(p.width * s)} cm`,
    ports: (p) => [port('hub', 'hub', [0, 0, -c(p.width) / 2], [0, 0, -1], [1, 0, 0])],
    phys: (p) => ({ mass: 0.05 * (p.diameter / 10) ** 2 * (p.width / 4), mu: 0.8 }),
    build({ diameter, width }) {
      const R = c(diameter / 2), W = c(width), g = new THREE.Group();
      const rubber = mat(0x1b1d22, { metal: 0, rough: 0.9 });
      const rim = mat(0xb7c2cf, { metal: 0.7, rough: 0.35 });
      const dish = mat(0x2c333d, { metal: 0.5, rough: 0.5 });
      const steel = mat(0xdfe6ee, { metal: 0.9, rough: 0.3 });

      g.add(cyl(R, W, rubber, 64));
      const n = Math.max(12, Math.round(diameter * 2.4));
      const tread = new THREE.BoxGeometry(R * 0.07, ((2 * Math.PI * R) / n) * 0.5, W * 1.02);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const m = new THREE.Mesh(tread, rubber);
        m.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
        m.rotation.z = a;
        g.add(m);
      }
      g.add(cyl(R * 0.66, W * 1.02, rim, 64));
      g.add(cyl(R * 0.52, W * 1.04, dish, 64));
      g.add(cyl(R * 0.2, W * 1.14, rim));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.3;
        const spoke = box(R * 0.42, R * 0.09, W * 1.08, rim, [Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36, 0]);
        spoke.rotation.z = a;
        g.add(spoke);
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.add(at(cyl(R * 0.03, W * 1.18, steel, 12), Math.cos(a) * R * 0.12, Math.sin(a) * R * 0.12, 0));
      }
      return g;
    },
  },

  motor: {
    name: 'Motor',
    real: '6 V geared DC motor (TT / N20 class)',
    defaults: { diameter: 3.5, length: 6 },
    label: (p, s) => `Motor  Ø${f(p.diameter * s)} × ${f(p.length * s)} cm`,
    ports: (p) => [
      port('base', 'motor-base', [0, -c(p.diameter) / 2, 0], [0, -1, 0], [0, 0, 1], true),
      port('shaft', 'shaft', [0, 0, c(p.length) * 0.69], [0, 0, 1], [1, 0, 0]),
    ],
    phys: (p) => ({ mass: 0.09 * (p.diameter / 3.5) ** 2 * (p.length / 6), noLoadRPM: 150, stallTorque: 0.12, ratedV: 6 }),
    build({ diameter, length }) {
      const R = c(diameter / 2), L = c(length), g = new THREE.Group();
      const steel = mat(0x8b95a3, { metal: 0.85, rough: 0.35 });
      const dark = mat(0x2b3038, { metal: 0.5, rough: 0.5 });
      const band = mat(0x2a6df4, { metal: 0.2, rough: 0.6 });
      const copper = mat(0xc8873a, { metal: 0.9, rough: 0.3 });

      g.add(cyl(R, L, steel));
      g.add(at(cyl(R * 1.01, L * 0.26, band), 0, 0, -L * 0.1));
      g.add(at(cyl(R * 1.0, L * 0.12, dark), 0, 0, L / 2 - L * 0.06));
      g.add(at(cyl(R * 1.03, L * 0.12, dark), 0, 0, -L / 2 + L * 0.06));
      g.add(at(cyl(R * 0.42, L * 0.05, steel), 0, 0, L / 2 + L * 0.025));
      g.add(at(cyl(R * 0.18, L * 0.38, steel, 24), 0, 0, L / 2 + L * 0.19));
      for (const sx of [-1, 1]) g.add(box(R * 0.25, R * 0.08, L * 0.14, copper, [sx * R * 0.35, 0, -L / 2 - L * 0.07]));
      return g;
    },
  },

  servo: {
    name: 'Servo',
    real: 'MG996R / SG90 hobby servo',
    defaults: { length: 4, width: 2, height: 3.6 },
    label: (p, s) => `Servo  ${f(p.length * s)} × ${f(p.width * s)} × ${f(p.height * s)} cm`,
    build({ length, width, height }) {
      const Lx = c(length), Wy = c(width), Hz = c(height), g = new THREE.Group();
      const body = mat(0x2f3b4c, { metal: 0.3, rough: 0.55 });
      const white = mat(0xe9edf2, { metal: 0.1, rough: 0.6 });
      const steel = mat(0xaab3bf, { metal: 0.9, rough: 0.3 });
      const cable = mat(0xd24a3a, { metal: 0, rough: 0.8 });

      g.add(box(Lx, Wy, Hz, body));
      g.add(box(Lx * 1.38, Wy, c(0.25), body, [0, 0, Hz * 0.18]));
      for (const sx of [-1, 1]) g.add(at(cyl(c(0.18), c(0.4), steel, 16), sx * Lx * 0.64, 0, Hz * 0.18));
      g.add(at(cyl(c(0.85), c(0.3), body), Lx * 0.25, 0, Hz / 2 + c(0.1)));
      g.add(at(cyl(c(0.6), c(0.3), white), Lx * 0.25, 0, Hz / 2 + c(0.35)));
      g.add(box(c(2.4), c(0.5), c(0.15), white, [Lx * 0.25 + c(0.7), 0, Hz / 2 + c(0.55)]));
      g.add(at(cyl(c(0.15), c(0.2), steel, 12), Lx * 0.25, 0, Hz / 2 + c(0.6)));
      g.add(box(c(0.9), c(0.6), c(0.3), cable, [-Lx / 2 - c(0.45), 0, -Hz * 0.15]));
      return g;
    },
  },

  plate: {
    name: 'Chassis plate',
    real: '3 mm acrylic or aluminium plate, drilled on a 2 cm grid',
    defaults: { length: 20, width: 12, thickness: 0.6 },
    label: (p, s) => `Plate  ${f(p.length * s)} × ${f(p.width * s)} × ${f(p.thickness * s)} cm`,
    ports(p) {
      const g = plateGrid(p), T = c(p.thickness), out = [];
      for (let i = 0; i < g.nx; i++)
        for (let j = 0; j < g.ny; j++) {
          const x = g.x(i), y = g.y(j);
          out.push(port(`deck-${i}-${j}`, 'deck', [x, y, T / 2], [0, 0, 1], [1, 0, 0]));
          out.push(port(`under-${i}-${j}`, 'underdeck', [x, y, -T / 2], [0, 0, -1], [1, 0, 0]));
          if (g.ny > 1 && (j === 0 || j === g.ny - 1)) out.push(port(`edge-${i}-${j}`, 'deck-edge', [x, y, T / 2], [0, 0, 1], [0, j === 0 ? -1 : 1, 0]));
        }
      return out;
    },
    phys: (p) => ({ mass: p.length * p.width * p.thickness * 2.7 * 0.0009 }),
    build({ length, width, thickness }) {
      const L = c(length), W = c(width), T = c(thickness);
      const shape = new THREE.Shape();
      shape.moveTo(-L / 2, -W / 2); shape.lineTo(L / 2, -W / 2); shape.lineTo(L / 2, W / 2); shape.lineTo(-L / 2, W / 2); shape.closePath();
      const grid = plateGrid({ length, width });
      for (let i = 0; i < grid.nx; i++)
        for (let j = 0; j < grid.ny; j++) hole(shape, grid.x(i), grid.y(j), c(0.4));
      const g = new THREE.Group();
      g.add(extrude(shape, T, mat(0x9fb0c2, { metal: 0.75, rough: 0.4 })));
      return g;
    },
  },

  beam: {
    name: 'Frame beam',
    real: '2020 aluminium extrusion',
    defaults: { length: 15, size: 2 },
    label: (p, s) => `Beam  ${f(p.length * s)} cm  (${f(p.size * s)} × ${f(p.size * s)})`,
    build({ length, size }) {
      const L = c(length), S = c(size), g = new THREE.Group();
      const alu = mat(0xaab3bf, { metal: 0.85, rough: 0.35 });
      const slot = mat(0x20252c, { metal: 0.3, rough: 0.7 });
      g.add(box(L, S, S, alu));
      for (let i = 0; i < 4; i++) {
        const face = new THREE.Group();
        face.add(box(L * 1.002, S * 0.07, S * 0.3, slot, [0, S / 2, 0]));
        face.rotation.x = (i * Math.PI) / 2;
        g.add(face);
      }
      return g;
    },
  },

  link: {
    name: 'Arm link',
    real: '3 mm aluminium bracket',
    defaults: { length: 12, width: 2.4, thickness: 0.8 },
    label: (p, s) => `Arm link  ${f(p.length * s)} × ${f(p.width * s)} cm`,
    build({ length, width, thickness }) {
      const L = c(length), r = c(width) / 2, T = c(thickness), a = L / 2 - r;
      const shape = new THREE.Shape();
      shape.moveTo(-a, -r);
      shape.lineTo(a, -r);
      shape.absarc(a, 0, r, -Math.PI / 2, Math.PI / 2, false);
      shape.lineTo(-a, r);
      shape.absarc(-a, 0, r, Math.PI / 2, Math.PI * 1.5, false);
      hole(shape, a, 0, r * 0.42);
      hole(shape, -a, 0, r * 0.42);
      const g = new THREE.Group();
      g.add(extrude(shape, T, mat(0xd97a2b, { metal: 0.5, rough: 0.45 })));
      return g;
    },
  },

  joint: {
    name: 'Joint',
    real: 'Servo bracket + bearing pin',
    defaults: { diameter: 3.6, width: 3.2 },
    label: (p, s) => `Joint  Ø${f(p.diameter * s)} × ${f(p.width * s)} cm`,
    build({ diameter, width }) {
      const R = c(diameter / 2), W = c(width), g = new THREE.Group();
      const blue = mat(0x3b82f6, { metal: 0.5, rough: 0.4 });
      const steel = mat(0xdfe6ee, { metal: 0.9, rough: 0.3 });
      g.add(cyl(R, W * 0.7, blue));
      for (const sz of [-1, 1]) {
        g.add(at(cyl(R * 1.25, W * 0.12, blue), 0, 0, sz * W * 0.4));
        g.add(at(cyl(R * 0.55, c(0.25), steel), 0, 0, sz * (W * 0.46 + c(0.12))));
      }
      g.add(cyl(R * 0.32, W * 1.1, steel, 24));
      return g;
    },
  },

  // ---- rover electronics & support -------------------------------------------------------------
  caster: {
    name: 'Ball caster',
    real: 'Ball caster, 25 mm',
    defaults: { height: 2.65, ball: 1.6 },
    label: (p, s) => `Caster  h${f(p.height * s)} cm`,
    ports: (p) => [port('top', 'caster-top', [0, 0, c(p.height) / 2], [0, 0, 1], [1, 0, 0])],
    phys: () => ({ mass: 0.03 }),
    build({ height, ball }) {
      const H = c(height), br = c(ball) / 2, g = new THREE.Group();
      const steel = mat(0xc6ced8, { metal: 0.9, rough: 0.25 });
      const dark = mat(0x2b3038, { metal: 0.5, rough: 0.5 });
      g.add(at(cyl(c(1.3), c(0.25), dark), 0, 0, H / 2 - c(0.125)));
      const hl = H - c(0.25) - br;
      g.add(at(cyl(c(0.95), hl, dark), 0, 0, H / 2 - c(0.25) - hl / 2));
      g.add(at(new THREE.Mesh(new THREE.SphereGeometry(br, 24, 16), steel), 0, 0, -H / 2 + br));
      return g;
    },
  },

  battery: {
    name: 'Battery pack',
    real: '4×AA battery holder (6 V)',
    defaults: { length: 6.2, width: 5.6, height: 1.7, voltage: 6 },
    label: (p, s) => `Battery  ${f(p.voltage)}V  ${f(p.length * s)} × ${f(p.width * s)} cm`,
    ports: (p) => [port('base', 'comp-base', [0, 0, -c(p.height) / 2], [0, 0, -1], [1, 0, 0])],
    phys: () => ({ mass: 0.14 }),
    build({ length, width, height }) {
      const L = c(length), W = c(width), H = c(height), g = new THREE.Group();
      const shell = mat(0x22252b, { metal: 0.1, rough: 0.7 });
      const cell = mat(0xc9a227, { metal: 0.7, rough: 0.35 });
      g.add(box(L, W, H, shell));
      const r = W / 9;
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L * 0.86, 20).rotateZ(Math.PI / 2), cell);
        m.position.set(0, (i - 1.5) * (W / 4.3), H / 2 - r * 0.35);
        g.add(m);
      }
      g.add(box(c(0.5), c(0.3), c(0.3), mat(0xd23a3a), [-L / 2 - c(0.25), W * 0.2, 0]));
      g.add(box(c(0.5), c(0.3), c(0.3), mat(0x101010), [-L / 2 - c(0.25), -W * 0.2, 0]));
      return g;
    },
  },

  controller: {
    name: 'Controller',
    real: 'Arduino Uno-class board',
    defaults: { length: 6.9, width: 5.3, height: 1.4 },
    label: (p, s) => `Controller  ${f(p.length * s)} × ${f(p.width * s)} cm`,
    ports: (p) => [port('base', 'comp-base', [0, 0, -c(p.height) / 2], [0, 0, -1], [1, 0, 0])],
    phys: () => ({ mass: 0.04 }),
    build({ length, width, height }) {
      const L = c(length), W = c(width), H = c(height), g = new THREE.Group();
      const pcb = mat(0x0f6b5c, { metal: 0.2, rough: 0.6 });
      const black = mat(0x15171a, { metal: 0.3, rough: 0.6 });
      const silver = mat(0xc0c7cf, { metal: 0.9, rough: 0.3 });
      g.add(box(L, W, c(0.16), pcb, [0, 0, -H / 2 + c(0.08)]));
      g.add(box(c(1.6), c(1.2), H * 0.7, silver, [-L / 2 + c(0.6), -W * 0.2, -H / 2 + H * 0.35]));
      for (const sy of [-1, 1]) g.add(box(L * 0.7, c(0.25), c(0.85), black, [c(0.2), sy * (W / 2 - c(0.2)), -H / 2 + c(0.42)]));
      g.add(box(c(1.6), c(1.6), c(0.3), black, [c(0.5), 0, -H / 2 + c(0.3)]));
      return g;
    },
  },

  driver: {
    name: 'Motor driver',
    real: 'L298N dual H-bridge module',
    defaults: { length: 4.3, width: 4.3, height: 2.7 },
    label: (p, s) => `Driver  ${f(p.length * s)} × ${f(p.width * s)} cm`,
    ports: (p) => [port('base', 'comp-base', [0, 0, -c(p.height) / 2], [0, 0, -1], [1, 0, 0])],
    phys: () => ({ mass: 0.035 }),
    build({ length, width, height }) {
      const L = c(length), W = c(width), H = c(height), g = new THREE.Group();
      const pcb = mat(0xb3262e, { metal: 0.2, rough: 0.6 });
      const black = mat(0x15171a, { metal: 0.5, rough: 0.5 });
      const blue = mat(0x2a6df4, { metal: 0.1, rough: 0.6 });
      g.add(box(L, W, c(0.16), pcb, [0, 0, -H / 2 + c(0.08)]));
      g.add(box(L * 0.42, W * 0.5, H * 0.85, black, [0, 0, -H / 2 + H * 0.425]));
      for (let i = 0; i < 4; i++) g.add(box(L * 0.44, c(0.08), H * 0.6, black, [0, (i - 1.5) * W * 0.11, -H / 2 + H * 0.9]));
      g.add(box(c(0.9), W * 0.8, H * 0.4, blue, [-L / 2 + c(0.45), 0, -H / 2 + H * 0.2]));
      return g;
    },
  },

  sonar: {
    name: 'Ultrasonic sensor',
    real: 'HC-SR04 ultrasonic distance sensor',
    defaults: { width: 4.5, height: 2 },
    label: (p, s) => `Sonar  ${f(p.width * s)} × ${f(p.height * s)} cm`,
    ports: (p) => [port('base', 'comp-base', [0, 0, -c(p.height) / 2], [0, 0, -1], [1, 0, 0], true)],
    phys: () => ({ mass: 0.01, range: 3 }),
    build({ width, height }) {
      const W = c(width), H = c(height), g = new THREE.Group();
      const pcb = mat(0x1a5fb4, { metal: 0.2, rough: 0.6 });
      const silver = mat(0xc0c7cf, { metal: 0.9, rough: 0.3 });
      const dark = mat(0x101317, { metal: 0.4, rough: 0.6 });
      g.add(box(c(0.2), W, H, pcb));
      for (const sy of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.CylinderGeometry(c(0.8), c(0.8), c(1.1), 28).rotateZ(Math.PI / 2), silver);
        eye.position.set(c(0.65), sy * W * 0.25, 0);
        g.add(eye);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(c(0.55), c(0.55), c(0.05), 24).rotateZ(Math.PI / 2), dark);
        cap.position.set(c(1.22), sy * W * 0.25, 0);
        g.add(cap);
      }
      return g;
    },
  },
};

// mesh -> part lookup (kept out of userData: three clones userData through JSON, which chokes on cycles)
const partOfMesh = new WeakMap();
export const partOf = (obj) => partOfMesh.get(obj);

let uid = 0;
const TILT = new THREE.Euler(-0.5, 0.55, 0); // so the 3D shape is visible at spawn

export function createPart(type, overrides = {}) {
  const def = CATALOG[type];
  if (!def) throw new Error(`Unknown part type "${type}". Available: ${Object.keys(CATALOG).join(', ')}`);
  const params = { ...def.defaults, ...overrides };

  const group = new THREE.Group();
  group.add(def.build(params));
  const radius = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere()).radius;
  const localBox = new THREE.Box3().setFromObject(group);
  group.quaternion.setFromEuler(TILT);

  const materials = new Set();
  const part = {
    id: ++uid, type, name: def.name, params, group, radius, localBox, userScale: 1, heldBy: null, lift: 0,
    ports: def.ports ? def.ports(params) : [],
    phys: def.phys ? def.phys(params) : { mass: 0.05 },
    label: () => def.label(params, part.userScale),
    setGlow(v) { for (const m of materials) m.emissive.setRGB(0.04 * v, 0.3 * v, 0.4 * v); },
    dispose() {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of materials) m.dispose();
    },
  };
  group.traverse((o) => {
    if (o.isMesh) { partOfMesh.set(o, part); materials.add(o.material); }
  });
  return part;
}
