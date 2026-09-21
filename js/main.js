import { createScene } from './scene.js';
import { CATALOG } from './parts.js';
import { Interaction } from './interaction.js';
import { drawOverlay } from './overlay.js';
import { analyzeRobot } from './robot.js';
import { Simulator } from './sim.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('cam'), fx = $('fx'), fxCtx = fx.getContext('2d');
const palette = $('palette'), trash = $('trash'), label = $('partLabel');

const gl = createScene($('gl'));

// ---- UI hooks handed to the interaction layer --------------------------------
let stageRect = stage.getBoundingClientRect();
const elementAt = (x, y) => document.elementFromPoint(stageRect.left + x, stageRect.top + y);
const ui = {
  elementAt,
  overTrash: (x, y) => !!elementAt(x, y)?.closest?.('#trash'),
  setTrashArmed: (on) => trash.classList.toggle('armed', on),
  setPaletteHot: (set) => palette.querySelectorAll('.palette-item').forEach((el) => el.classList.toggle('hot', set.has(el))),
};
const interaction = new Interaction(gl, ui);

// ---- palette -------------------------------------------------------------------
for (const [type, def] of Object.entries(CATALOG)) {
  const el = document.createElement('div');
  el.className = 'palette-item';
  el.dataset.type = type;
  el.innerHTML = `<b>${def.name}</b><small>${def.label(def.defaults, 1).split('  ').slice(1).join(' · ')}</small>`;
  el.addEventListener('click', () => interaction.spawn(type));
  palette.appendChild(el);
}

// ---- layout ----------------------------------------------------------------------
function fit() {
  const box = $('workspace').getBoundingClientRect();
  const aspect = (video.videoWidth || 1280) / (video.videoHeight || 720);
  const w = Math.floor(Math.min(box.width - 8, (box.height - 8) * aspect));
  const h = Math.floor(w / aspect);
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  gl.resize(w, h);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fx.width = w * dpr; fx.height = h * dpr;
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  stageRect = stage.getBoundingClientRect();
}
window.addEventListener('resize', () => { fit(); sim?.resize(gl.size().w, gl.size().h); });
fit();

// ---- mouse as a fallback "hand" ---------------------------------------------------
const local = (e) => [e.clientX - stageRect.left, e.clientY - stageRect.top];
fx.addEventListener('pointerdown', (e) => { fx.setPointerCapture(e.pointerId); interaction.mouse('down', ...local(e)); });
fx.addEventListener('pointermove', (e) => interaction.mouse('move', ...local(e)));
fx.addEventListener('pointerup', (e) => interaction.mouse('up', ...local(e)));
fx.addEventListener('pointerleave', (e) => interaction.mouse('leave', ...local(e)));
fx.addEventListener('wheel', (e) => { e.preventDefault(); interaction.wheel(e.deltaY, e.shiftKey); }, { passive: false });

$('btn-clear').addEventListener('click', () => interaction.clear());
const overlayOpt = $('opt-overlay');

// ---- rover checklist + simulator ------------------------------------------------------
const checklist = $('checklist'), hud = $('simhud');
let sim = null, lastRev = -1, lastCheck = 0, analysis = null;

function refreshChecklist(now) {
  if (interaction.rev === lastRev && now - lastCheck < 400) return;
  lastRev = interaction.rev; lastCheck = now;
  analysis = analyzeRobot(interaction.parts, interaction.connections, (p) => interaction.assemblyOf(p));
  checklist.innerHTML = '<h3>ROVER CHECKLIST</h3>' + analysis.checklist.map((c) =>
    `<div class="${c.ok ? 'ok' : c.optional ? 'opt' : ''}"><i>${c.ok ? '✓' : c.optional ? '·' : '✗'}</i>${c.label}${c.detail ? `<small>${c.detail}</small>` : ''}</div>`).join('');
}

function enterSim() {
  refreshChecklist(performance.now() + 1e6);
  if (!analysis.ok) {
    checklist.classList.add('flash');
    setTimeout(() => checklist.classList.remove('flash'), 900);
    return;
  }
  interaction.hands.forEach((h) => h.pinching && interaction._setPinch(h, false));
  interaction.marker.visible = false;
  interaction.parts.forEach((p) => p.setGlow(0));
  sim = new Simulator(gl, analysis.spec);
  hud.innerHTML = '<div id="hudtext"></div><button id="btn-exit">← Back to workbench</button>';
  $('btn-exit').onclick = exitSim;
  document.body.classList.add('sim');
}
function exitSim() {
  sim = null;
  document.body.classList.remove('sim');
}
function drawHud() {
  const st = sim.stats();
  const son = sim.spec.sonars.length ? (st.sonar >= 300 ? 'clear' : `${st.sonar.toFixed(0)} cm`) : 'no sensor';
  $('hudtext').innerHTML = `<b>SIMULATOR</b> · ${st.mode}<br>
    speed <b>${(st.speed * 100).toFixed(0)}</b> cm/s <small>(top ${(st.topSpeed * 100).toFixed(0)})</small><br>
    heading <b>${Math.round(st.heading) % 360}°</b> · turn <b>${st.yaw.toFixed(0)}</b>°/s<br>
    sonar <b>${son}</b> · mass <b>${st.mass.toFixed(2)}</b> kg<br>
    <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive · <kbd>M</kbd> ${st.mode === 'auto' ? 'manual' : 'auto-avoid'} · <kbd>C</kbd> camera · <kbd>R</kbd> reset`;
}
$('btn-sim').addEventListener('click', enterSim);
window.addEventListener('keydown', (e) => {
  if (!sim) return;
  if (e.code === 'Escape') exitSim();
  else if (e.code === 'KeyM') sim.mode = sim.mode === 'auto' ? 'manual' : 'auto';
  else if (e.code === 'KeyC') sim.cycleCamera();
  else if (e.code === 'KeyR') sim.reset();
  else { sim.keys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); }
});
window.addEventListener('keyup', (e) => sim?.keys.delete(e.code));

// ---- status pills ------------------------------------------------------------------
function pill(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${cls}`;
}

// ---- camera + tracker ---------------------------------------------------------------
let tracker = null, lastHands = [], lastVideoTime = -1, detections = 0, fps = 0, fpsStamp = performance.now();

async function start(useCamera) {
  $('splash-msg').textContent = '';
  if (useCamera) {
    try {
      $('btn-start').disabled = true;
      $('btn-start').textContent = 'Loading…';
      const { startCamera, createTracker } = await import('./hand-tracker.js');
      await startCamera(video);
      tracker = await createTracker();
      fit();
      pill('st-cam', 'camera: on', 'ok');
    } catch (err) {
      console.error(err);
      $('btn-start').disabled = false;
      $('btn-start').textContent = 'Start camera';
      $('splash-msg').textContent = `Could not start camera / hand tracking: ${err.message}`;
      return;
    }
  } else {
    pill('st-cam', 'mouse mode', 'bad');
  }
  $('splash').classList.add('hidden');
}
$('btn-start').addEventListener('click', () => start(true));
$('btn-mouse').addEventListener('click', () => start(false));

// ---- main loop -----------------------------------------------------------------------
let lastT = performance.now(), hudStamp = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const { w, h } = gl.size();
  const dt = (now - lastT) / 1000;
  lastT = now;

  if (sim) {
    sim.update(dt);
    fxCtx.clearRect(0, 0, w, h);
    if (now - hudStamp > 100) { hudStamp = now; drawHud(); }
    sim.render();
    return;
  }

  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try { lastHands = tracker.detect(video, now, w, h); detections++; } catch (e) { console.warn(e); }
  }
  interaction.update(lastHands, now);
  refreshChecklist(now);

  if (now - fpsStamp > 1000) {
    fps = Math.round((detections * 1000) / (now - fpsStamp));
    detections = 0; fpsStamp = now;
    const n = [...interaction.hands.values()].filter((x) => !x.virtual && x.present).length;
    pill('st-hands', `hands: ${n}`, n ? 'ok' : '');
    pill('st-fps', tracker ? `${fps} fps` : '– fps');
  }

  const focus = interaction.focus;
  if (focus) {
    const p = gl.toStage(focus.group.position.x, focus.group.position.y);
    label.textContent = focus.label();
    label.style.display = 'block';
    label.style.left = `${Math.min(w - 90, Math.max(190, p.x))}px`;
    label.style.top = `${Math.max(28, p.y - focus.radius * focus.userScale - 8)}px`;
  } else {
    label.style.display = 'none';
  }

  drawOverlay(fxCtx, w, h, interaction.hands.values(), overlayOpt.checked);
  gl.render();
}
requestAnimationFrame(frame);

// Console / future voice-command entry point, e.g. jarvis.spawn('wheel', { diameter: 10, width: 4 })
window.jarvis = {
  spawn: (type, params, at) => interaction.spawn(type, params, at),
  clear: () => interaction.clear(),
  parts: interaction.parts,
  connections: interaction.connections,
  analyze: () => analyzeRobot(interaction.parts, interaction.connections, (p) => interaction.assemblyOf(p)),
  simulate: enterSim,
  getSim: () => sim,
  interaction,
  catalog: CATALOG,
};
