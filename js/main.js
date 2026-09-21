import { createScene } from './scene.js';
import { CATALOG } from './parts.js';
import { Interaction } from './interaction.js';
import { drawOverlay } from './overlay.js';

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
  el.innerHTML = `<b>${def.name}</b><small>${def.label(def.defaults, 1).split('  ')[1]}</small>`;
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
window.addEventListener('resize', fit);
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
function frame(now) {
  requestAnimationFrame(frame);
  const { w, h } = gl.size();

  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try { lastHands = tracker.detect(video, now, w, h); detections++; } catch (e) { console.warn(e); }
  }
  interaction.update(lastHands, now);

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
  spawn: (type, params) => interaction.spawn(type, params),
  clear: () => interaction.clear(),
  parts: interaction.parts,
  catalog: CATALOG,
};
