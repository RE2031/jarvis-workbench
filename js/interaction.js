import * as THREE from 'three';
import { createPart, partOf, portsCompatible } from './parts.js';

const PINCH_ON = 0.28;   // thumb-index gap / palm size below which a pinch starts
const PINCH_OFF = 0.45;  // ...and above which it ends (hysteresis)
const LOST_MS = 250;     // tracking dropout tolerated before a hand's grip is released
const MIN_SCALE = 0.25, MAX_SCALE = 4;
const ROLL_DEADZONE = 0.1;
// Magnet ranges (world px). Wheel<->motor and motor<->chassis pull in from further away and lock harder.
const STRONG_KINDS = new Set(['hub', 'shaft', 'motor-base', 'deck-edge']);
const magnetRange = (kind) => (STRONG_KINDS.has(kind) ? 110 : 70);
const LOCK_FRAC = 0.4;   // inside this fraction of the range the part locks onto the port
const LIFT = 40;         // z lift while held
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const deadzone = (v, dz) => (Math.abs(v) < dz ? 0 : v - Math.sign(v) * dz);

function portPose(part, port) {
  const g = part.group;
  const pos = new THREE.Vector3(...port.pos).applyMatrix4(g.matrixWorld);
  const n = new THREE.Vector3(...port.normal).applyQuaternion(g.quaternion).normalize();
  const h = new THREE.Vector3(...port.hint).applyQuaternion(g.quaternion);
  h.addScaledVector(n, -h.dot(n)).normalize();
  return { pos, n, h };
}
const basis = (n, h) => new THREE.Matrix4().makeBasis(n, h, new THREE.Vector3().crossVectors(n, h));

/**
 * Owns the parts and their connections, and turns hand data (or the mouse) into
 * grab / move / rotate / scale / snap-together.
 * `ui` supplies DOM hooks: elementAt, overTrash, setTrashArmed, setPaletteHot.
 */
export class Interaction {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    this.parts = [];
    this.connections = []; // { a, pa, b, pb } — parts joined at named ports
    this.rev = 0;          // bumps whenever the set of parts / connections changes
    this.hands = new Map();
    this.scale = null;     // active two-hand scale gesture
    this.focus = null;     // part to annotate in the HUD
    this.ray = new THREE.Raycaster();

    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(9, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x4de1ff, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    ctx.scene.add(this.marker);
  }

  // ---- parts & assemblies -----------------------------------------------------

  spawn(type, params = {}, at) {
    const part = createPart(type, params);
    const { w, h } = this.ctx.size();
    const p = at ?? { x: w / 2 + (Math.random() - 0.5) * w * 0.25, y: h / 2 + (Math.random() - 0.5) * h * 0.25 };
    const wp = this.ctx.toWorld(p.x, p.y);
    part.group.position.set(wp.x, wp.y, 0);
    this.ctx.scene.add(part.group);
    this.parts.push(part);
    this.rev++;
    return part;
  }

  remove(part) {
    for (const h of this.hands.values()) {
      if (h.held === part) h.held = null;
      if (h.members) h.members = h.members.filter((m) => m !== part);
    }
    if (this.scale?.part === part) { this.scale.b.role = null; this.scale = null; }
    this.connections = this.connections.filter((cn) => cn.a !== part && cn.b !== part);
    this.ctx.scene.remove(part.group);
    part.dispose();
    this.parts.splice(this.parts.indexOf(part), 1);
    if (this.focus === part) this.focus = null;
    this.rev++;
  }

  clear() { [...this.parts].forEach((p) => this.remove(p)); }

  /** All parts connected (directly or not) to `part`, including itself. */
  assemblyOf(part) {
    const seen = new Set([part]), queue = [part];
    while (queue.length) {
      const x = queue.pop();
      for (const cn of this.connections) {
        const y = cn.a === x ? cn.b : cn.b === x ? cn.a : null;
        if (y && !seen.has(y)) { seen.add(y); queue.push(y); }
      }
    }
    return [...seen];
  }

  // Pull `part` off whatever it is attached to (towards the chassis); its own sub-assembly comes with it.
  _pullOff(part) {
    const comp = this.assemblyOf(part);
    const plate = comp.find((p) => p.type === 'plate');
    if (!plate || plate === part || comp.length === 1) return;
    const prev = new Map([[part, null]]);
    const queue = [part];
    while (queue.length && !prev.has(plate)) {
      const x = queue.shift();
      for (const cn of this.connections) {
        const y = cn.a === x ? cn.b : cn.b === x ? cn.a : null;
        if (y && !prev.has(y)) { prev.set(y, { from: x, cn }); queue.push(y); }
      }
    }
    let cur = plate, edge = null;
    while (cur !== part) { const p = prev.get(cur); edge = p.cn; cur = p.from; }
    this.connections.splice(this.connections.indexOf(edge), 1);
    this.rev++;
  }

  // Raycast at (x, y) in stage px, retrying on a small ring so a pinch doesn't need to be pixel-exact.
  pick(x, y) {
    const { w, h } = this.ctx.size();
    const roots = this.parts.map((p) => p.group);
    if (!roots.length) return null;
    const offsets = [[0, 0]];
    for (let i = 0; i < 8; i++) offsets.push([Math.cos((i * Math.PI) / 4) * 22, Math.sin((i * Math.PI) / 4) * 22]);
    for (const [dx, dy] of offsets) {
      this.ray.setFromCamera(new THREE.Vector2(((x + dx) / w) * 2 - 1, -(((y + dy) / h) * 2 - 1)), this.ctx.camera);
      const hit = this.ray.intersectObjects(roots, true)[0];
      if (hit) return partOf(hit.object);
    }
    return null;
  }

  // ---- snapping ------------------------------------------------------------------

  /** Closest pair of free, compatible ports between `members` and the rest of the parts. */
  findSnap(members) {
    const mine = new Set(members);
    const busy = new Set();
    for (const h of this.hands.values()) if (h.held) h.members.forEach((m) => busy.add(m));
    const used = new Set(this.connections.flatMap((cn) => [`${cn.a.id}:${cn.pa}`, `${cn.b.id}:${cn.pb}`]));
    const targets = this.parts.filter((r) => !mine.has(r) && !busy.has(r));
    let best = null;
    for (const q of members) {
      q.group.updateMatrixWorld(true);
      for (const pp of q.ports) {
        if (used.has(`${q.id}:${pp.name}`)) continue;
        let P = null;
        for (const r of targets) {
          for (const tp of r.ports) {
            if (!portsCompatible(pp.kind, tp.kind) || used.has(`${r.id}:${tp.name}`)) continue;
            r.group.updateMatrixWorld(true);
            P ??= portPose(q, pp);
            const T = portPose(r, tp);
            const d = P.pos.distanceTo(T.pos);
            const range = magnetRange(pp.kind);
            if (d < range && (!best || d / range < best.d / best.range)) best = { d, range, q, pp, r, tp, P, T };
          }
        }
      }
    }
    return best;
  }

  _applySnap(members, snap) {
    this._align(members, snap, 1);
    this.connections.push({ a: snap.q, pa: snap.pp.name, b: snap.r, pb: snap.tp.name });
    this.rev++;
  }

  // Move `members` a fraction `f` of the way to the pose where the two ports coincide (f = 1: exactly aligned).
  _align(members, { pp, r, tp, P, T }, f) {
    const strict = pp.strict || tp.strict;
    const nT = T.n.clone().negate();
    const bp = basis(P.n, P.h).transpose();
    let bestQ = null, bestAngle = Infinity;
    for (const k of strict ? [0] : [0, 1, 2, 3]) {
      const ht = T.h.clone().applyAxisAngle(T.n, (k * Math.PI) / 2);
      const R = new THREE.Matrix4().multiplyMatrices(basis(nT, ht), bp);
      const rq = new THREE.Quaternion().setFromRotationMatrix(R);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(rq.w)));
      if (angle < bestAngle) { bestAngle = angle; bestQ = rq; }
    }
    const shift = T.pos.clone().sub(P.pos).multiplyScalar(f);
    const rot = new THREE.Quaternion().slerp(bestQ, f);
    for (const m of members) {
      m.group.position.sub(P.pos).applyQuaternion(rot).add(P.pos).add(shift);
      m.group.quaternion.premultiply(rot);
      if (f === 1) m.lift = r.lift;
    }
  }

  // While a part is dragged: pull it towards a compatible port, and lock it on when it gets close.
  _magnet(h) {
    if (this.ui.overTrash(h.x, h.y)) { h.lock = false; return null; }
    const snap = this.findSnap(h.members);
    if (!snap) { h.lock = false; return null; }
    if (h.lock || snap.d < LOCK_FRAC * snap.range) {
      h.lock = true;
      h.lockRange = snap.range;
      this._align(h.members, snap, 1);
    } else {
      this._align(h.members, snap, 0.25 + 0.5 * (1 - snap.d / snap.range));
    }
    return snap;
  }

  // ---- input ---------------------------------------------------------------------

  _newHand(id) {
    const h = {
      id, virtual: false, present: false, init: false, lastSeen: 0,
      x: 0, y: 0, ratio: 1, landmarks: null,
      lastRoll: 0, rollAccum: 0, rollS: 0, rollBase: 0,
      pinching: false, held: null, members: [], offset: { x: 0, y: 0 }, quatBase: new THREE.Quaternion(), role: null,
    };
    this.hands.set(id, h);
    return h;
  }

  /** Feed the tracked hands for this frame (stage px) and advance the interaction. */
  update(frameHands, now) {
    for (const h of this.hands.values()) if (!h.virtual) h.present = false;

    for (const fh of frameHands) {
      const h = this.hands.get(fh.id) ?? this._newHand(fh.id);
      h.present = true;
      h.lastSeen = now;
      h.landmarks = fh.landmarks;
      h.ratio = fh.ratio;
      if (!h.init) {
        h.x = fh.x; h.y = fh.y; h.lastRoll = fh.roll; h.rollAccum = fh.roll; h.rollS = fh.roll; h.init = true;
      } else {
        // Adaptive smoothing: steady when slow (kills jitter), responsive when fast.
        const a = Math.min(0.9, 0.35 + Math.hypot(fh.x - h.x, fh.y - h.y) / 80);
        h.x += (fh.x - h.x) * a;
        h.y += (fh.y - h.y) * a;
        h.rollAccum += wrapPi(fh.roll - h.lastRoll);
        h.lastRoll = fh.roll;
        h.rollS += (h.rollAccum - h.rollS) * 0.35;
      }
      const want = h.pinching ? fh.ratio < PINCH_OFF : fh.ratio < PINCH_ON;
      if (want !== h.pinching) this._setPinch(h, want);
    }

    for (const [id, h] of this.hands) {
      if (h.virtual || h.present || now - h.lastSeen <= LOST_MS) continue;
      if (h.pinching) this._setPinch(h, false);
      this.hands.delete(id);
    }
    this._step();
  }

  /** Mouse acts as a virtual hand: button = pinch, wheel = scale, shift+wheel = rotate. */
  mouse(type, x, y) {
    let h = this.hands.get('mouse');
    if (!h) { h = this._newHand('mouse'); h.virtual = true; }
    h.x = x; h.y = y; h.init = true; h.present = type !== 'leave';
    if (type === 'down' && !h.pinching) this._setPinch(h, true);
    if ((type === 'up' || type === 'leave') && h.pinching) this._setPinch(h, false);
  }

  wheel(dy, shift) {
    const h = this.hands.get('mouse');
    if (!h) return;
    const part = h.held ?? this.pick(h.x, h.y);
    if (!part) return;
    if (shift) h.rollAccum -= dy * 0.003;
    else if (this.assemblyOf(part).length === 1) {
      part.userScale = clamp(part.userScale * Math.exp(-dy * 0.0012), MIN_SCALE, MAX_SCALE);
      part.group.scale.setScalar(part.userScale);
    }
  }

  // ---- gesture state machine ------------------------------------------------------

  _setPinch(h, on) {
    h.pinching = on;
    if (on) this._pinchStart(h); else this._pinchEnd(h);
  }

  _holderOf(part) {
    for (const h of this.hands.values()) if (h.held && h.members.includes(part)) return h;
    return null;
  }

  _pinchStart(h) {
    const item = this.ui.elementAt(h.x, h.y)?.closest?.('.palette-item');
    if (item) { this._grab(h, this.spawn(item.dataset.type, {}, { x: h.x, y: h.y }), false); return; }

    const part = this.pick(h.x, h.y);
    const other = [...this.hands.values()].find((o) => o !== h && o.pinching && o.held);
    if (part) {
      const holder = this._holderOf(part);
      if (!holder) this._grab(h, part, true);
      else if (holder !== h) this._startScale(holder, h);
    } else if (other) {
      this._startScale(other, h); // second hand pinching empty space scales what the first holds
    }
  }

  _pinchEnd(h) {
    const s = this.scale;
    if (s && (s.a === h || s.b === h)) {
      this.scale = null;
      s.b.role = null;
      if (h === s.b) { this._grab(s.a, s.part, false); return; } // holder keeps the part, re-anchored
      const members = h.members;
      this._detach(s.a);
      if (s.b.pinching) this._grab(s.b, s.part, false); // scaler takes over
      else this._dropped(members, h);
      return;
    }
    if (h.held) {
      const members = h.members;
      this._detach(h);
      this._dropped(members, h);
    }
  }

  // Grabbing a part that is bolted to a chassis pulls it (and anything hanging off it) free.
  _grab(h, part, pull) {
    if (pull) this._pullOff(part);
    const wp = this.ctx.toWorld(h.x, h.y);
    h.held = part;
    h.members = this.assemblyOf(part);
    part.heldBy = h;
    h.offset = { x: part.group.position.x - wp.x, y: part.group.position.y - wp.y };
    h.rollBase = h.rollS;
    h.quatBase.copy(part.group.quaternion);
  }

  _detach(h) {
    if (h.held?.heldBy === h) h.held.heldBy = null;
    h.held = null;
    h.lock = false;
  }

  _dropped(members, h) {
    if (this.ui.overTrash(h.x, h.y)) { members.forEach((m) => this.remove(m)); return; }
    const snap = this.findSnap(members);
    if (snap) this._applySnap(members, snap);
  }

  _startScale(a, b) {
    if (this.scale || !a.held || a.members.length > 1) return; // bolted assemblies can't be resized
    const part = a.held;
    const A = this.ctx.toWorld(a.x, a.y), B = this.ctx.toWorld(b.x, b.y);
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    b.role = 'scaler';
    this.scale = {
      part, a, b,
      dist0: Math.max(40, Math.hypot(B.x - A.x, B.y - A.y)),
      s0: part.userScale,
      quat0: part.group.quaternion.clone(),
      off0: { x: part.group.position.x - mid.x, y: part.group.position.y - mid.y },
      lastAng: Math.atan2(B.y - A.y, B.x - A.x), angAccum: 0,
    };
  }

  _step() {
    const s = this.scale;
    if (s) {
      const A = this.ctx.toWorld(s.a.x, s.a.y), B = this.ctx.toWorld(s.b.x, s.b.y);
      const ang = Math.atan2(B.y - A.y, B.x - A.x);
      s.angAccum += wrapPi(ang - s.lastAng);
      s.lastAng = ang;

      const ratio = clamp((s.s0 * Math.hypot(B.x - A.x, B.y - A.y)) / s.dist0, MIN_SCALE, MAX_SCALE) / s.s0;
      s.part.userScale = s.s0 * ratio;
      s.part.group.scale.setScalar(s.part.userScale);
      s.part.group.quaternion.setFromAxisAngle(Z_AXIS, s.angAccum).multiply(s.quat0);

      // Keep the part anchored at the same spot relative to the midpoint, following its rotation and scale.
      const cos = Math.cos(s.angAccum), sin = Math.sin(s.angAccum);
      s.part.group.position.x = (A.x + B.x) / 2 + (s.off0.x * cos - s.off0.y * sin) * ratio;
      s.part.group.position.y = (A.y + B.y) / 2 + (s.off0.x * sin + s.off0.y * cos) * ratio;
    }

    const hot = new Set();
    let hover = null, trashArmed = false, snapPreview = null;
    for (const h of this.hands.values()) {
      if (h.virtual) h.rollS = h.rollAccum;
      if (!h.present) continue;

      if (h.pinching && h.held && !(s && s.a === h)) {
        this._moveHeld(h);
        const snap = this._magnet(h);
        if (snap) { snapPreview ??= snap; snapPreview.locked = h.lock; }
      }
      if (h.pinching && h.held && this.ui.overTrash(h.x, h.y)) trashArmed = true;
      if (!h.pinching) {
        const item = this.ui.elementAt(h.x, h.y)?.closest?.('.palette-item');
        if (item) hot.add(item); else hover ??= this.pick(h.x, h.y);
      }
    }
    this.ui.setPaletteHot(hot);
    this.ui.setTrashArmed(trashArmed);
    this.marker.visible = !!snapPreview;
    if (snapPreview) {
      this.marker.position.copy(snapPreview.T.pos);
      this.marker.material.color.setHex(snapPreview.locked ? 0x5df2a0 : 0x4de1ff);
      this.marker.scale.setScalar(snapPreview.locked ? 1.4 : 1);
    }

    const lifted = new Set();
    let held = null;
    for (const h of this.hands.values()) {
      if (!h.held) continue;
      held ??= h.held;
      if (!h.lock) h.members.forEach((m) => lifted.add(m)); // a magnet-locked part sits flush, not lifted
    }
    for (const p of this.parts) {
      p.setGlow(lifted.has(p) || p === hover ? 1 : 0);
      const d = ((lifted.has(p) ? LIFT : 0) - p.lift) * 0.25; // lift the whole assembly while held
      p.lift += d;
      p.group.position.z += d;
    }
    this.focus = held ?? hover;
  }

  // Move the held part towards the hand, carrying its assembly along rigidly around the held part.
  _moveHeld(h) {
    const g = h.held.group, wp = this.ctx.toWorld(h.x, h.y);
    if (h.lock) { // held by the magnet: only a firm pull away releases it
      const away = Math.hypot(wp.x + h.offset.x - g.position.x, wp.y + h.offset.y - g.position.y);
      if (away < h.lockRange * 0.9) return;
      h.lock = false;
    }
    const oldPos = g.position.clone(), oldQ = g.quaternion.clone();
    const newPos = new THREE.Vector3(
      oldPos.x + (wp.x + h.offset.x - oldPos.x) * 0.7,
      oldPos.y + (wp.y + h.offset.y - oldPos.y) * 0.7,
      oldPos.z,
    );
    const targetQ = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, deadzone(h.rollS - h.rollBase, ROLL_DEADZONE)).multiply(h.quatBase);
    const dq = targetQ.clone().multiply(oldQ.invert());
    for (const m of h.members) {
      if (m === h.held) continue;
      m.group.position.sub(oldPos).applyQuaternion(dq).add(newPos);
      m.group.quaternion.premultiply(dq);
    }
    g.position.copy(newPos);
    g.quaternion.copy(targetQ);
  }
}
