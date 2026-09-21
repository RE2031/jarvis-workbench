import * as THREE from 'three';
import { createPart } from './parts.js';

const PINCH_ON = 0.28;   // thumb-index gap / palm size below which a pinch starts
const PINCH_OFF = 0.45;  // ...and above which it ends (hysteresis)
const LOST_MS = 250;     // tracking dropout tolerated before a hand's grip is released
const MIN_SCALE = 0.25, MAX_SCALE = 4;
const ROLL_DEADZONE = 0.1;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const deadzone = (v, dz) => (Math.abs(v) < dz ? 0 : v - Math.sign(v) * dz);

/**
 * Owns the parts and turns hand data (or the mouse) into grab / move / rotate / scale.
 * `ui` supplies DOM hooks: elementAt, overTrash, setTrashArmed, setPaletteHot.
 */
export class Interaction {
  constructor(ctx, ui) {
    this.ctx = ctx;
    this.ui = ui;
    this.parts = [];
    this.hands = new Map();
    this.scale = null; // active two-hand scale gesture
    this.focus = null; // part to annotate in the HUD
    this.ray = new THREE.Raycaster();
  }

  // ---- parts ---------------------------------------------------------------

  spawn(type, params = {}, at) {
    const part = createPart(type, params);
    const { w, h } = this.ctx.size();
    const p = at ?? { x: w / 2 + (Math.random() - 0.5) * w * 0.25, y: h / 2 + (Math.random() - 0.5) * h * 0.25 };
    const wp = this.ctx.toWorld(p.x, p.y);
    part.group.position.set(wp.x, wp.y, 0);
    this.ctx.scene.add(part.group);
    this.parts.push(part);
    return part;
  }

  remove(part) {
    for (const h of this.hands.values()) if (h.held === part) h.held = null;
    if (this.scale?.part === part) { this.scale.b.role = null; this.scale = null; }
    this.ctx.scene.remove(part.group);
    part.dispose();
    this.parts.splice(this.parts.indexOf(part), 1);
    if (this.focus === part) this.focus = null;
  }

  clear() { [...this.parts].forEach((p) => this.remove(p)); }

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
      if (hit) return hit.object.userData.part;
    }
    return null;
  }

  // ---- input ---------------------------------------------------------------

  _newHand(id) {
    const h = {
      id, virtual: false, present: false, init: false, lastSeen: 0,
      x: 0, y: 0, ratio: 1, landmarks: null,
      lastRoll: 0, rollAccum: 0, rollS: 0, rollBase: 0,
      pinching: false, held: null, offset: { x: 0, y: 0 }, quatBase: new THREE.Quaternion(), role: null,
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
    else {
      part.userScale = clamp(part.userScale * Math.exp(-dy * 0.0012), MIN_SCALE, MAX_SCALE);
      part.group.scale.setScalar(part.userScale);
    }
  }

  // ---- gesture state machine ----------------------------------------------

  _setPinch(h, on) {
    h.pinching = on;
    if (on) this._pinchStart(h); else this._pinchEnd(h);
  }

  _pinchStart(h) {
    const item = this.ui.elementAt(h.x, h.y)?.closest?.('.palette-item');
    if (item) { this._grab(h, this.spawn(item.dataset.type, {}, { x: h.x, y: h.y })); return; }

    const part = this.pick(h.x, h.y);
    const other = [...this.hands.values()].find((o) => o !== h && o.pinching && o.held);
    if (part) {
      if (!part.heldBy) this._grab(h, part);
      else if (part.heldBy !== h) this._startScale(part.heldBy, h);
    } else if (other) {
      this._startScale(other, h); // second hand pinching empty space scales what the first holds
    }
  }

  _pinchEnd(h) {
    const s = this.scale;
    if (s && (s.a === h || s.b === h)) {
      this.scale = null;
      s.b.role = null;
      if (h === s.b) { this._grab(s.a, s.part); return; } // holder keeps the part, re-anchored
      this._detach(s.a);
      if (s.b.pinching) this._grab(s.b, s.part); // scaler takes over
      else this._dropped(s.part, h);
      return;
    }
    if (h.held) {
      const part = h.held;
      this._detach(h);
      this._dropped(part, h);
    }
  }

  _grab(h, part) {
    const wp = this.ctx.toWorld(h.x, h.y);
    h.held = part;
    part.heldBy = h;
    h.offset = { x: part.group.position.x - wp.x, y: part.group.position.y - wp.y };
    h.rollBase = h.rollS;
    h.quatBase.copy(part.group.quaternion);
  }

  _detach(h) {
    if (h.held?.heldBy === h) h.held.heldBy = null;
    h.held = null;
  }

  _dropped(part, h) {
    if (this.ui.overTrash(h.x, h.y)) this.remove(part);
  }

  _startScale(a, b) {
    if (this.scale || !a.held) return;
    const part = a.held;
    const A = this.ctx.toWorld(a.x, a.y), B = this.ctx.toWorld(b.x, b.y);
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const ang = Math.atan2(B.y - A.y, B.x - A.x);
    b.role = 'scaler';
    this.scale = {
      part, a, b,
      dist0: Math.max(40, Math.hypot(B.x - A.x, B.y - A.y)),
      s0: part.userScale,
      quat0: part.group.quaternion.clone(),
      off0: { x: part.group.position.x - mid.x, y: part.group.position.y - mid.y },
      lastAng: ang, angAccum: 0,
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
    let hover = null, trashArmed = false;
    for (const h of this.hands.values()) {
      if (h.virtual) h.rollS = h.rollAccum;
      if (!h.present) continue;

      if (h.pinching && h.held && !(s && s.a === h)) {
        const g = h.held.group, wp = this.ctx.toWorld(h.x, h.y);
        g.position.x += (wp.x + h.offset.x - g.position.x) * 0.7;
        g.position.y += (wp.y + h.offset.y - g.position.y) * 0.7;
        const d = deadzone(h.rollS - h.rollBase, ROLL_DEADZONE);
        g.quaternion.setFromAxisAngle(Z_AXIS, d).multiply(h.quatBase);
      }
      if (h.pinching && h.held && this.ui.overTrash(h.x, h.y)) trashArmed = true;
      if (!h.pinching) {
        const item = this.ui.elementAt(h.x, h.y)?.closest?.('.palette-item');
        if (item) hot.add(item); else hover ??= this.pick(h.x, h.y);
      }
    }
    this.ui.setPaletteHot(hot);
    this.ui.setTrashArmed(trashArmed);

    let held = null;
    for (const p of this.parts) {
      if (p.heldBy) held ??= p;
      p.setGlow(p.heldBy || p === hover ? 1 : 0);
      const z = p.heldBy ? 40 : 0;
      p.group.position.z += (z - p.group.position.z) * 0.25; // lift while held
    }
    this.focus = held ?? hover;
  }
}
