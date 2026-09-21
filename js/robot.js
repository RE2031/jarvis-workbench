import * as THREE from 'three';
import { PX_PER_CM } from './parts.js';

export const PX_PER_M = PX_PER_CM * 100;

/**
 * Inspects the best chassis assembly and reports what a differential-drive rover still needs.
 * When complete, `spec` holds everything the simulator needs (SI units, chassis frame:
 * x forward, y left, z up, origin at the plate centre).
 */
export function analyzeRobot(parts, connections, assemblyOf) {
  let chassis = null, members = [];
  for (const pl of parts.filter((p) => p.type === 'plate')) {
    const m = assemblyOf(pl);
    if (m.length > members.length) { chassis = pl; members = m; }
  }
  const of = (t) => members.filter((p) => p.type === t);
  const motorOf = (w) => connections
    .map((cn) => (cn.a === w ? cn.b : cn.b === w ? cn.a : null))
    .find((o) => o?.type === 'motor');

  // Chassis frame from the plate's pose (scale removed so px stay world px).
  members.forEach((m) => m.group.updateMatrixWorld(true)); // parts may not have been drawn yet (e.g. right after undo)
  const frame = new THREE.Matrix4();
  if (chassis) {
    frame.compose(chassis.group.position, chassis.group.quaternion, new THREE.Vector3(1, 1, 1)).invert();
  }
  const rel = (part) => new THREE.Matrix4().multiplyMatrices(frame, part.group.matrixWorld);
  const centre = (part) => new THREE.Vector3().setFromMatrixPosition(rel(part));

  const wheels = of('wheel'), casters = of('caster');
  const driven = wheels.filter((w) => motorOf(w));
  const side = (w) => (centre(w).y > 0 ? 'L' : 'R');
  const hasL = driven.some((w) => side(w) === 'L'), hasR = driven.some((w) => side(w) === 'R');
  const battery = of('battery')[0], driver = of('driver')[0], controller = of('controller')[0];
  const sonars = of('sonar');
  const contacts = wheels.length + casters.length;

  const checklist = [
    { label: 'Chassis plate', ok: !!chassis },
    { label: 'Motor + wheel on left and right', ok: hasL && hasR, detail: `${driven.length} driven` },
    { label: 'Stable: ≥ 3 ground contacts', ok: contacts >= 3, detail: `${contacts}` },
    { label: 'Battery pack', ok: !!battery },
    { label: 'Motor driver', ok: !!driver },
    { label: 'Controller', ok: !!controller },
    { label: 'Ultrasonic sensor', ok: sonars.length > 0, optional: true },
  ];
  const ok = checklist.every((c) => c.ok || c.optional);
  if (!ok) return { ok, checklist, spec: null };

  // ---- physical model -------------------------------------------------------------
  const s3 = (p) => p.userScale ** 3;
  const voltage = battery.params.voltage;
  const bodies = members.map((part) => ({ part, rel: rel(part), mass: part.phys.mass * s3(part) }));
  const mass = bodies.reduce((a, b) => a + b.mass, 0);
  const com = new THREE.Vector3();
  for (const b of bodies) com.addScaledVector(new THREE.Vector3().setFromMatrixPosition(b.rel), b.mass / mass);

  // Footprint (axis-aligned in chassis frame) from every part's bounding box.
  const box = new THREE.Box3();
  for (const b of bodies) {
    const lb = b.part.localBox;
    for (const x of [lb.min.x, lb.max.x]) for (const y of [lb.min.y, lb.max.y]) for (const z of [lb.min.z, lb.max.z])
      box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(b.rel));
  }

  let inertia = 0;
  for (const b of bodies) {
    const p = new THREE.Vector3().setFromMatrixPosition(b.rel), lb = b.part.localBox.getSize(new THREE.Vector3());
    const d2 = ((p.x - com.x) ** 2 + (p.y - com.y) ** 2) / PX_PER_M ** 2;
    inertia += b.mass * (d2 + (lb.x ** 2 + lb.y ** 2) * b.part.userScale ** 2 / 12 / PX_PER_M ** 2);
  }

  const contactList = [];
  let lowestZ = Infinity;
  for (const w of wheels) {
    const motor = motorOf(w), c = centre(w);
    const R = (w.params.diameter / 2) * PX_PER_CM * w.userScale; // px
    lowestZ = Math.min(lowestZ, c.z - R);
    const contact = { x: c.x, y: c.y, R: R / PX_PER_M, mu: w.phys.mu, driven: !!motor, side: side(w) };
    if (motor) {
      const m = motor.phys, sm = motor.userScale, k = voltage / m.ratedV;
      contact.vmax = ((m.noLoadRPM / sm) * k * 2 * Math.PI) / 60 * contact.R;       // m/s at full command
      contact.fStall = (m.stallTorque * sm ** 3 * k) / contact.R;                     // N at stall
    }
    contactList.push(contact);
  }
  for (const cs of casters) {
    const c = new THREE.Vector3(0, 0, -(cs.params.height / 2) * PX_PER_CM).applyMatrix4(rel(cs));
    lowestZ = Math.min(lowestZ, c.z);
    contactList.push({ x: c.x, y: c.y, R: 0, mu: 0.3, driven: false, side: null });
  }

  const sonarList = sonars.map((sn) => {
    const r = rel(sn), p = new THREE.Vector3().setFromMatrixPosition(r);
    const dir = new THREE.Vector3(1, 0, 0).transformDirection(r);
    return { x: p.x / PX_PER_M, y: p.y / PX_PER_M, ang: Math.atan2(dir.y, dir.x), range: sn.phys.range };
  });

  const m = (v) => v / PX_PER_M;
  const spec = {
    bodies, mass, inertia, voltage,
    com: { x: m(com.x), y: m(com.y), z: m(com.z) },
    lowestZ: m(lowestZ),
    contacts: contactList.map((c) => ({ ...c, x: m(c.x), y: m(c.y) })),
    sonars: sonarList,
    footprint: { // relative to the CoM
      cx: m((box.min.x + box.max.x) / 2 - com.x), cy: m((box.min.y + box.max.y) / 2 - com.y),
      hx: m((box.max.x - box.min.x) / 2), hy: m((box.max.y - box.min.y) / 2),
    },
    driven: driven.map((w) => ({ part: w, side: side(w) })),
  };
  return { ok, checklist, spec };
}
