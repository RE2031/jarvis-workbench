import * as THREE from 'three';
import { PX_PER_M } from './robot.js';

const G = 9.81;
const ARENA = 3; // half-size in metres
const OBSTACLES = [
  { cx: 1.2, cy: 0.7, hx: 0.25, hy: 0.25 },
  { cx: -0.9, cy: -1.2, hx: 0.45, hy: 0.15 },
  { cx: 1.9, cy: -1.5, hx: 0.2, hy: 0.55 },
  { cx: -1.7, cy: 1.4, hx: 0.3, hy: 0.3 },
];
const WALLS = [
  { cx: 0, cy: ARENA + 0.1, hx: ARENA + 0.2, hy: 0.1 }, { cx: 0, cy: -ARENA - 0.1, hx: ARENA + 0.2, hy: 0.1 },
  { cx: ARENA + 0.1, cy: 0, hx: 0.1, hy: ARENA }, { cx: -ARENA - 0.1, cy: 0, hx: 0.1, hy: ARENA },
];
const SOLIDS = [...OBSTACLES, ...WALLS];

// Robot rectangle (centre rc, unit axes f/l, half sizes) vs axis-aligned box: SAT. Normal points box -> robot.
function obbVsAabb(rc, f, l, hx, hy, b) {
  const axes = [[1, 0], [0, 1], [f[0], f[1]], [l[0], l[1]]];
  let best = null;
  for (const a of axes) {
    const r = hx * Math.abs(f[0] * a[0] + f[1] * a[1]) + hy * Math.abs(l[0] * a[0] + l[1] * a[1]);
    const br = b.hx * Math.abs(a[0]) + b.hy * Math.abs(a[1]);
    const dist = (rc[0] - b.cx) * a[0] + (rc[1] - b.cy) * a[1];
    const overlap = r + br - Math.abs(dist);
    if (overlap <= 0) return null;
    if (!best || overlap < best.depth) best = { depth: overlap, n: dist >= 0 ? [a[0], a[1]] : [-a[0], -a[1]] };
  }
  return best;
}

function rayVsAabb(o, d, b, maxT) {
  let t0 = 0, t1 = maxT;
  for (const [i, lo, hi] of [[0, b.cx - b.hx, b.cx + b.hx], [1, b.cy - b.hy, b.cy + b.hy]]) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo || o[i] > hi) return Infinity; continue; }
    let a = (lo - o[i]) / d[i], c = (hi - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

export class Simulator {
  constructor(gl, spec) {
    this.gl = gl;
    this.spec = spec;
    this.cmd = { L: 0, R: 0 };
    this.keys = new Set();
    this.mode = 'manual';
    this.autoState = 'go';
    this.camMode = 'chase';
    this.sonarCm = spec.sonars.length ? null : undefined;
    this._reset();
    this._buildScene();
  }

  _reset() {
    Object.assign(this, { x: 0, y: 0, th: 0, vx: 0, vy: 0, om: 0, speed: 0 });
    this.contactsN = this.spec.mass * G / this.spec.contacts.length;
  }
  reset() { this._reset(); this.mode = 'manual'; }

  // ---- scene ----------------------------------------------------------------------
  _buildScene() {
    const { gl, spec } = this;
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x0a1017);
    scene.fog = new THREE.Fog(0x0a1017, 5, 14);
    scene.environment = gl.environment;
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-3, 6, 4);
    scene.add(sun, new THREE.AmbientLight(0xffffff, 0.25));

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x18222d, roughness: 0.9, metalness: 0 }));
    const grid = new THREE.GridHelper(2 * ARENA, 2 * ARENA * 4, 0x2a7a8c, 0x1b3440);
    grid.position.y = 0.002;
    scene.add(floor, grid);
    const solid = (b, h, color) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2, h, b.hy * 2), new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 }));
      m.position.set(b.cx, h / 2, -b.cy);
      scene.add(m);
    };
    WALLS.forEach((b) => solid(b, 0.3, 0x2b3947));
    OBSTACLES.forEach((b) => solid(b, 0.35, 0xd97a2b));

    // Robot: chassis frame (x fwd, y left, z up, px) -> three (x, z, -y), scaled px -> m, centred on the CoM.
    const { com, footprint: fp } = spec;
    this.robot = new THREE.Group();
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.scale.setScalar(1 / PX_PER_M);
    frame.position.set(-com.x, -com.z, com.y);
    this.robot.add(frame);
    this.robot.position.y = com.z - spec.lowestZ;

    this.wheelSpin = [];
    for (const { part, rel } of spec.bodies) {
      const pivot = new THREE.Group();
      rel.decompose(pivot.position, pivot.quaternion, pivot.scale);
      const body = part.group.children[0].clone(true);
      pivot.add(body);
      frame.add(pivot);
      const idx = spec.driven.findIndex((d) => d.part === part);
      if (idx >= 0) {
        // rolling forward spins the wheel about the chassis +y axis; project onto this wheel's axle
        const axle = new THREE.Vector3(0, 0, 1).applyQuaternion(pivot.quaternion);
        this.wheelSpin.push({ body, k: axle.y, R: spec.contacts.filter((c) => c.driven)[idx].R });
      }
    }
    scene.add(this.robot);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(fp.hx * 2.3, fp.hy * 2.3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
    shadow.position.y = 0.004;
    this.shadow = shadow;
    scene.add(shadow);

    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.05, 60);
    this.camera.position.set(-1, 0.8, 0);
    this.resize(gl.size().w, gl.size().h);
  }

  resize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  cycleCamera() { this.camMode = this.camMode === 'chase' ? 'top' : 'chase'; }

  // ---- control -------------------------------------------------------------------
  _drive() {
    if (this.mode === 'auto') {
      const d = this.sonarCm ?? 999;
      if (this.autoState === 'go' && d < 30) this.autoState = 'turn';
      else if (this.autoState === 'turn' && d > 55) this.autoState = 'go';
      return this.autoState === 'turn' ? [0.6, -0.6] : [0.7, 0.7]; // [left, right]
    }
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const t = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    const l = f - t, r = f + t, m = Math.max(1, Math.abs(l), Math.abs(r));
    return [l / m, r / m];
  }

  // ---- physics ---------------------------------------------------------------------
  _step(dt) {
    const { spec } = this;
    const c = Math.cos(this.th), s = Math.sin(this.th);
    let Fx = 0, Fy = 0, T = 0;
    for (const w of spec.contacts) {
      const rx = w.x - spec.com.x, ry = w.y - spec.com.y;
      const rwx = c * rx - s * ry, rwy = s * rx + c * ry;
      const vx = this.vx - this.om * rwy, vy = this.vy + this.om * rwx; // contact-point velocity
      const vl = vx * c + vy * s, vt = -vx * s + vy * c;                // along / across the wheel
      const muN = w.mu * this.contactsN;
      let fl, ft;
      if (w.driven) {
        const u = this.cmd[w.side];
        fl = w.fStall * (u - vl / w.vmax);         // DC motor: torque falls linearly with speed
        ft = -muN * Math.tanh(vt / 0.02);
        const mag = Math.hypot(fl, ft);
        if (mag > muN) { fl *= muN / mag; ft *= muN / mag; } // friction circle
      } else {
        fl = -0.03 * this.contactsN * Math.tanh(vl / 0.02);
        ft = -0.08 * this.contactsN * Math.tanh(vt / 0.02);
      }
      const fxw = fl * c - ft * s, fyw = fl * s + ft * c;
      Fx += fxw; Fy += fyw; T += rwx * fyw - rwy * fxw;
    }
    this.vx += (Fx / spec.mass) * dt;
    this.vy += (Fy / spec.mass) * dt;
    this.om += (T / spec.inertia) * dt;
    this.x += this.vx * dt; this.y += this.vy * dt; this.th += this.om * dt;
    this._collide();
  }

  _collide() {
    const { footprint: fp } = this.spec;
    const c = Math.cos(this.th), s = Math.sin(this.th);
    const f = [c, s], l = [-s, c];
    const rc = [this.x + c * fp.cx - s * fp.cy, this.y + s * fp.cx + c * fp.cy];
    for (const b of SOLIDS) {
      const hit = obbVsAabb(rc, f, l, fp.hx, fp.hy, b);
      if (!hit) continue;
      this.x += hit.n[0] * hit.depth; this.y += hit.n[1] * hit.depth;
      rc[0] += hit.n[0] * hit.depth; rc[1] += hit.n[1] * hit.depth;
      const vn = this.vx * hit.n[0] + this.vy * hit.n[1];
      if (vn < 0) {
        this.vx -= 1.1 * vn * hit.n[0]; this.vy -= 1.1 * vn * hit.n[1];
        this.vx *= 0.97; this.vy *= 0.97; this.om *= 0.9;
      }
    }
  }

  _sonar() {
    if (!this.spec.sonars.length) return;
    const { spec } = this, sn = spec.sonars[0];
    const c = Math.cos(this.th), s = Math.sin(this.th);
    const rx = sn.x - spec.com.x, ry = sn.y - spec.com.y;
    const o = [this.x + c * rx - s * ry, this.y + s * rx + c * ry];
    const a = this.th + sn.ang, d = [Math.cos(a), Math.sin(a)];
    let t = Infinity;
    for (const b of SOLIDS) t = Math.min(t, rayVsAabb(o, d, b, sn.range));
    this.sonarCm = Number.isFinite(t) ? t * 100 : null; // null = nothing in range
    if (this.sonarCm === null) this.sonarCm = 999;
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    const [l, r] = this._drive();
    this.cmd.L = l; this.cmd.R = r;
    const sub = 8;
    for (let i = 0; i < sub; i++) this._step(dt / sub);
    this._sonar();

    const c = Math.cos(this.th), s = Math.sin(this.th);
    const vl = this.vx * c + this.vy * s;
    this.speed = vl;
    for (const w of this.wheelSpin) w.body.rotation.z += (vl / w.R) * w.k * dt;

    this.robot.position.x = this.x;
    this.robot.position.z = -this.y;
    this.robot.rotation.y = this.th;
    this.shadow.position.x = this.x; this.shadow.position.z = -this.y; this.shadow.rotation.y = this.th;

    const p = this.robot.position;
    if (this.camMode === 'top') {
      this.camera.position.lerp(new THREE.Vector3(p.x, 3.4, p.z + 0.01), 0.1);
    } else {
      const back = new THREE.Vector3(-Math.cos(this.th), 0, Math.sin(this.th)).multiplyScalar(0.6);
      this.camera.position.lerp(new THREE.Vector3(p.x + back.x, 0.4, p.z + back.z), 0.08);
    }
    this.camera.lookAt(p.x, 0.05, p.z);
  }

  render() { this.gl.renderer.render(this.scene, this.camera); }

  stats() {
    return {
      speed: this.speed, yaw: (this.om * 180) / Math.PI, heading: ((this.th * 180) / Math.PI % 360 + 360) % 360,
      sonar: this.sonarCm, mass: this.spec.mass, mode: this.mode, cmd: this.cmd,
      topSpeed: Math.max(...this.spec.contacts.filter((w) => w.driven).map((w) => w.vmax)),
    };
  }
}
