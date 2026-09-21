import { createScene } from './scene.js';
import { CATALOG, PX_PER_CM } from './parts.js';
import { Interaction } from './interaction.js';
import { drawOverlay } from './overlay.js';
import { analyzeRobot } from './robot.js';
import { Simulator } from './sim.js';
import { settings, saveSettings, resetSettings } from './settings.js';
import { sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('cam'), fx = $('fx'), fxCtx = fx.getContext('2d');
const palette = $('palette'), trash = $('trash'), label = $('partLabel');
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const gl = createScene($('gl'));
let sim = null, tracker = null;

// ---- toasts ---------------------------------------------------------------------------
function toast(msg) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 2300);
}

// ---- UI hooks handed to the interaction layer -------------------------------------------
let stageRect = stage.getBoundingClientRect();
const elementAt = (x, y) => document.elementFromPoint(stageRect.left + x, stageRect.top + y);
const savedDesign = store.get('jarvis.design'); // read before the first autosave overwrites it
const ui = {
  elementAt,
  overTrash: (x, y) => !!elementAt(x, y)?.closest?.('#trash'),
  setTrashArmed: (on) => trash.classList.toggle('armed', on),
  setPaletteHot: (set) => palette.querySelectorAll('.palette-item').forEach((el) => el.classList.toggle('hot', set.has(el))),
  notify: toast,
  sfx: (name) => sfx(name, settings.sound),
  onCommit: (json) => store.set('jarvis.design', json),
};
const interaction = new Interaction(gl, ui);
if (savedDesign) {
  try {
    const state = JSON.parse(savedDesign);
    if (state.parts?.length) { interaction.load(state); setTimeout(() => toast('Restored your last design'), 400); }
  } catch { /* corrupt autosave: ignore */ }
}

// ---- palette ----------------------------------------------------------------------------
for (const [type, def] of Object.entries(CATALOG)) {
  const el = document.createElement('div');
  el.className = 'palette-item';
  el.dataset.type = type;
  if (def.real) el.title = def.real;
  el.innerHTML = `<b>${def.name}</b><small>${def.label(def.defaults, 1).split('  ').slice(1).join(' · ')}</small>`;
  el.addEventListener('click', () => { const p = interaction.spawn(type); interaction.select(p); interaction.commit(); ui.sfx('spawn'); });
  palette.appendChild(el);
}

// ---- layout ------------------------------------------------------------------------------
function fit() {
  const box = $('center').getBoundingClientRect();
  const aspect = (video.videoWidth || 1280) / (video.videoHeight || 720);
  const w = Math.max(320, Math.floor(Math.min(box.width - 8, (box.height - 8) * aspect)));
  const h = Math.floor(w / aspect);
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  gl.resize(w, h);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fx.width = w * dpr; fx.height = h * dpr;
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  stageRect = stage.getBoundingClientRect();
  sim?.resize(w, h);
}
new ResizeObserver(fit).observe($('center'));
window.addEventListener('scroll', () => { stageRect = stage.getBoundingClientRect(); });

// Side docks (CoppeliaSim-style scene hierarchy + object properties)
function setDock(name, on) {
  document.body.classList.toggle(name === 'tree' ? 'show-tree' : 'show-insp', on);
  $(name === 'tree' ? 'btn-tree' : 'btn-insp').classList.toggle('on', on);
  store.set(`jarvis.dock.${name}`, on ? '1' : '0');
  requestAnimationFrame(fit);
}
const dockPref = (name, fallback) => (store.get(`jarvis.dock.${name}`) ?? (fallback ? '1' : '0')) === '1';
setDock('tree', dockPref('tree', window.innerWidth >= 1250));
setDock('insp', dockPref('insp', window.innerWidth >= 1500));
$('btn-tree').onclick = () => setDock('tree', !document.body.classList.contains('show-tree'));
$('btn-insp').onclick = () => setDock('insp', !document.body.classList.contains('show-insp'));

// ---- scene hierarchy ---------------------------------------------------------------------
const treeBody = $('tree-body');
function renderTree() {
  const rows = [];
  const walk = (node, depth) => {
    const p = node.part;
    rows.push(`<div class="node ${p === interaction.selected ? 'sel' : ''}" data-id="${p.id}" style="padding-left:${8 + depth * 14}px">
      ${depth ? '<span class="ref">↳</span>' : ''}<span class="dot"></span>${p.name}
      <small>${p.label().split('  ').slice(1).join(' ')}</small></div>`);
    node.children.forEach((c) => walk(c, depth + 1));
  };
  interaction.hierarchy().forEach((n) => walk(n, 0));
  treeBody.innerHTML = rows.join('') || '<div class="tree-empty">Empty scene.<br>Pull a part out of the left panel.</div>';
}
treeBody.addEventListener('click', (e) => {
  const row = e.target.closest('.node');
  if (row) interaction.select(interaction.parts.find((p) => p.id === +row.dataset.id) ?? null);
});

// ---- object properties -------------------------------------------------------------------
const inspBody = $('insp-body');
let inspKey = '';
function renderInspector() {
  const p = interaction.selected;
  if (!p) { inspKey = ''; inspBody.innerHTML = '<div class="tree-empty">Nothing selected.<br>Click an object, or a row in the scene tree.</div>'; return; }
  const pose = interaction.poseOf(p);
  const num = (attr, i, v, step) => `<label>${'XYZ'[i]}<input type="number" step="${step}" ${attr} data-i="${i}" value="${v.toFixed(1)}"></label>`;
  const params = Object.entries(p.params).filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `<label>${k}<input type="number" step="0.1" min="0.1" data-param="${k}" value="${+v.toFixed(2)}"></label>`).join('');
  const links = interaction.connections.filter((c) => c.a === p || c.b === p)
    .map((c) => `${c.a === p ? c.pa : c.pb} → ${(c.a === p ? c.b : c.a).name}`);
  inspKey = JSON.stringify([p.id, pose]);
  inspBody.innerHTML = `
    <div class="title">${p.name}</div><div class="dim">object #${p.id} · ${p.type}</div>
    <h4>POSITION (cm)</h4><div class="prow">${pose.pos.map((v, i) => num('data-pose="pos"', i, v, 0.1)).join('')}</div>
    <h4>ROTATION (°)</h4><div class="prow">${pose.rot.map((v, i) => num('data-pose="rot"', i, v, 1)).join('')}</div>
    <h4>SIZE (cm)</h4><div class="prow one">${params}</div>
    <div class="prow one"><label>scale<input type="number" step="0.05" min="0.25" max="4" data-scale value="${p.userScale.toFixed(2)}"></label></div>
    <h4>PHYSICS</h4>
    <div class="kv">mass<b>${(p.phys.mass * p.userScale ** 3).toFixed(3)} kg</b></div>
    <h4>CONNECTIONS</h4>
    ${links.length ? links.map((l) => `<div class="kv"><span>${l}</span></div>`).join('') : '<div class="dim">none (loose part)</div>'}
    <div class="btns">
      <button data-act="dup">Duplicate</button>
      ${links.length ? '<button data-act="detach">Detach</button>' : ''}
      <button data-act="del" class="danger">Delete</button>
    </div>
    ${CATALOG[p.type].real ? `<h4>REAL-WORLD PART</h4><div class="dim">${CATALOG[p.type].real}</div>` : ''}`;
}
inspBody.addEventListener('change', (e) => {
  const p = interaction.selected, t = e.target;
  if (!p || !(t instanceof HTMLInputElement)) return;
  const v = parseFloat(t.value);
  if (Number.isNaN(v)) return renderInspector();
  if (t.dataset.pose) {
    const pose = interaction.poseOf(p);
    pose[t.dataset.pose][+t.dataset.i] = v;
    interaction.setPose(p, pose);
  } else if ('scale' in t.dataset) interaction.setScale(p, v);
  else if (t.dataset.param) interaction.setParams(p, { [t.dataset.param]: Math.max(0.1, v) });
  renderInspector();
});
inspBody.addEventListener('click', (e) => {
  const p = interaction.selected, act = e.target.dataset?.act;
  if (!p || !act) return;
  if (act === 'del') { interaction.remove(p); toast(`Deleted ${p.name}`); ui.sfx('delete'); interaction.commit(); }
  if (act === 'dup') { interaction.duplicate(p); ui.sfx('spawn'); }
  if (act === 'detach') { interaction._pullOff(p); interaction.commit(); }
});

// ---- undo / redo / clear ---------------------------------------------------------------------
const undoBtn = $('btn-undo'), redoBtn = $('btn-redo');
undoBtn.onclick = () => interaction.undo();
redoBtn.onclick = () => interaction.redo();
$('btn-clear').onclick = () => { if (interaction.parts.length) { interaction.clear(); toast('Cleared (Ctrl+Z to undo)'); } };
let lastHist = '';
function syncUndo() {
  const key = `${interaction.hIdx}/${interaction.history.length}`;
  if (key === lastHist) return;
  lastHist = key;
  undoBtn.disabled = interaction.hIdx <= 0;
  redoBtn.disabled = interaction.hIdx >= interaction.history.length - 1;
}

// ---- settings panel --------------------------------------------------------------------------
const settingsEl = $('settings');
const bindings = [['pinchOn', 'range'], ['pinchOff', 'range'], ['responsive', 'range'], ['rotSens', 'range'],
  ['rot3d', 'check'], ['overlay', 'check'], ['sound', 'check']];
function syncSettingsUI() {
  for (const [key, kind] of bindings) {
    const el = $(`s-${key}`);
    if (kind === 'check') el.checked = settings[key];
    else { el.value = settings[key]; $(`o-${key}`).textContent = (+settings[key]).toFixed(2); }
  }
}
for (const [key, kind] of bindings) {
  $(`s-${key}`).addEventListener('input', (e) => {
    settings[key] = kind === 'check' ? e.target.checked : parseFloat(e.target.value);
    if (settings.pinchOff < settings.pinchOn + 0.05) {
      if (key === 'pinchOn') settings.pinchOff = settings.pinchOn + 0.05; else settings.pinchOn = settings.pinchOff - 0.05;
    }
    saveSettings();
    syncSettingsUI();
  });
}
syncSettingsUI();
$('btn-settings').onclick = () => { settingsEl.hidden = !settingsEl.hidden; };
$('btn-reset').onclick = () => { resetSettings(); syncSettingsUI(); toast('Settings reset'); };
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { $(b.dataset.close).hidden = true; }; });
$('btn-help').onclick = () => { $('help').hidden = !$('help').hidden; };

// Live pinch meter: shows the thumb-index ratio against the two thresholds.
const meter = $('meter');
let meterStamp = 0;
function renderMeter(now) {
  if (settingsEl.hidden || now - meterStamp < 80) return;
  meterStamp = now;
  const hands = [...interaction.hands.values()].filter((h) => !h.virtual && h.present);
  const pct = (v) => Math.min(100, (v / 1.2) * 100);
  meter.innerHTML = hands.length ? hands.map((h) => `<div class="mrow"><span>${h.id}</span>
    <div class="mbar ${h.pinching ? 'on' : ''}"><i style="width:${pct(h.ratio)}%"></i><u style="left:${pct(settings.pinchOn)}%"></u><u class="off" style="left:${pct(settings.pinchOff)}%"></u></div>
    <span>${h.ratio.toFixed(2)}</span></div>`).join('') + '<small>Bar left of the bright line = pinching.</small>'
    : '<small>Show a hand to the camera to see the live pinch meter.</small>';
}

// Calibration: measure this hand's pinched and open ratios, then place the thresholds between them.
let calibrating = false;
async function calibrate() {
  if (!tracker) return toast('Start the camera first');
  if (calibrating) return;
  calibrating = true;
  const box = $('calib');
  const say = (t) => { box.style.display = 'grid'; box.textContent = t; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const collect = async (ms) => {
    const xs = [], t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const hs = [...interaction.hands.values()].filter((h) => !h.virtual && h.present);
      if (hs.length) xs.push(Math.min(...hs.map((h) => h.ratio)));
      await sleep(40);
    }
    return xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  };
  say('Pinch thumb + index and HOLD…'); await sleep(1200);
  const closed = await collect(1500);
  say('Now open your hand wide'); await sleep(1200);
  const open = await collect(1500);
  box.style.display = 'none';
  calibrating = false;
  if (closed === undefined || open === undefined || open - closed < 0.25) return toast('Calibration failed: keep one hand in view');
  settings.pinchOn = Math.min(0.6, Math.max(0.08, closed + 0.3 * (open - closed)));
  settings.pinchOff = Math.min(0.9, Math.max(settings.pinchOn + 0.08, closed + 0.55 * (open - closed)));
  saveSettings(); syncSettingsUI();
  toast(`Calibrated: pinch < ${settings.pinchOn.toFixed(2)}, release > ${settings.pinchOff.toFixed(2)}`);
}
$('btn-calibrate').onclick = calibrate;

// ---- design save / load / parts list ------------------------------------------------------------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('btn-save').onclick = () => download('jarvis-design.json', JSON.stringify({ app: 'jarvis', ...interaction.serialize() }, null, 1), 'application/json');
$('btn-load').onclick = () => $('file-load').click();
$('file-load').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const state = JSON.parse(await f.text());
    if (!Array.isArray(state.parts) || !Array.isArray(state.conns)) throw new Error('not a Jarvis design');
    interaction.load(state);
    toast(`Loaded ${state.parts.length} parts`);
  } catch (err) { toast(`Could not load: ${err.message}`); }
};
$('btn-bom').onclick = () => {
  const rows = new Map();
  for (const p of interaction.parts) {
    const size = p.label().split('  ').slice(1).join(' ');
    const key = `${p.name}|${size}`;
    rows.set(key, { name: p.name, size, real: CATALOG[p.type].real ?? '', qty: (rows.get(key)?.qty ?? 0) + 1 });
  }
  if (!rows.size) return toast('Nothing to export yet');
  const csv = ['Part,Qty,Size,Suggested real part', ...[...rows.values()].map((r) => `"${r.name}",${r.qty},"${r.size}","${r.real}"`)].join('\n');
  download('jarvis-parts.csv', csv, 'text/csv');
};

// ---- rover checklist + simulator ------------------------------------------------------------------
const checklist = $('checklist'), hud = $('simhud');
let lastRev = -1, lastCheck = 0, analysis = null;
checklist.addEventListener('click', (e) => { if (e.target.closest('h3')) checklist.classList.toggle('collapsed'); });

function refreshChecklist(now) {
  if (interaction.rev === lastRev && now - lastCheck < 400) return;
  lastRev = interaction.rev; lastCheck = now;
  analysis = analyzeRobot(interaction.parts, interaction.connections, (p) => interaction.assemblyOf(p));
  checklist.innerHTML = '<h3>ROVER CHECKLIST ▾</h3>' + analysis.checklist.map((c) =>
    `<div class="${c.ok ? 'ok' : c.optional ? 'opt' : ''}"><i>${c.ok ? '✓' : c.optional ? '·' : '✗'}</i>${c.label}${c.detail ? `<small>${c.detail}</small>` : ''}</div>`).join('');
}

function enterSim() {
  refreshChecklist(performance.now() + 1e6);
  if (!analysis.ok) {
    checklist.classList.remove('collapsed');
    checklist.classList.add('flash');
    setTimeout(() => checklist.classList.remove('flash'), 900);
    toast('The rover is not complete yet — see the checklist');
    ui.sfx('error');
    return;
  }
  interaction.hands.forEach((h) => h.pinching && interaction._setPinch(h, false));
  interaction.marker.visible = false;
  interaction.ghost.geometry.setDrawRange(0, 0);
  interaction.parts.forEach((p) => p.setGlow(0));
  settingsEl.hidden = true;
  sim = new Simulator(gl, analysis.spec);
  hud.innerHTML = '<div id="hudtext"></div>';
  document.body.classList.add('sim');
  requestAnimationFrame(fit);
}
function exitSim() {
  sim = null;
  document.body.classList.remove('sim');
  requestAnimationFrame(fit);
}
function drawHud() {
  const st = sim.stats();
  const son = sim.spec.sonars.length ? (st.sonar >= 300 ? 'clear' : `${st.sonar.toFixed(0)} cm`) : 'no sensor';
  $('hudtext').innerHTML = `<b>SIMULATOR</b> · ${st.mode}<br>
    speed <b>${(st.speed * 100).toFixed(0)}</b> cm/s <small>(top ${(st.topSpeed * 100).toFixed(0)})</small><br>
    heading <b>${Math.round(st.heading) % 360}°</b> · turn <b>${st.yaw.toFixed(0)}</b>°/s<br>
    sonar <b>${son}</b> · mass <b>${st.mass.toFixed(2)}</b> kg<br>
    <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive · <kbd>M</kbd> ${st.mode === 'auto' ? 'manual' : 'auto-avoid'} · <kbd>C</kbd> camera · <kbd>R</kbd> reset · <kbd>Esc</kbd> stop`;
}
$('btn-sim').onclick = enterSim;
$('btn-stop').onclick = exitSim;

// ---- mouse as a fallback "hand" (left = pinch, right-drag = rotate) -------------------------------------
const local = (e) => [e.clientX - stageRect.left, e.clientY - stageRect.top];
let rotating = null;
fx.addEventListener('contextmenu', (e) => e.preventDefault());
fx.addEventListener('pointerdown', (e) => {
  fx.setPointerCapture(e.pointerId);
  if (e.button === 2) { rotating = { x: e.clientX, y: e.clientY }; interaction.mouse('move', ...local(e)); return; }
  interaction.mouse('down', ...local(e));
});
fx.addEventListener('pointermove', (e) => {
  if (rotating) {
    interaction.mouseRotate(e.clientX - rotating.x, e.clientY - rotating.y);
    rotating = { x: e.clientX, y: e.clientY };
    return;
  }
  interaction.mouse('move', ...local(e));
});
fx.addEventListener('pointerup', (e) => {
  if (rotating) { rotating = null; interaction.commit(); return; }
  interaction.mouse('up', ...local(e));
});
fx.addEventListener('pointerleave', (e) => { if (!rotating) interaction.mouse('leave', ...local(e)); });
fx.addEventListener('wheel', (e) => { e.preventDefault(); interaction.wheel(e.deltaY, e.shiftKey); }, { passive: false });

// ---- keyboard ---------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (e.code === 'Escape') {
    if (sim) return exitSim();
    settingsEl.hidden = true; $('help').hidden = true; return;
  }
  if (sim) {
    if (e.code === 'KeyM') sim.mode = sim.mode === 'auto' ? 'manual' : 'auto';
    else if (e.code === 'KeyC') sim.cycleCamera();
    else if (e.code === 'KeyR') sim.reset();
    else { sim.keys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); }
    return;
  }
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) interaction.redo(); else interaction.undo(); }
  else if (mod && e.code === 'KeyY') { e.preventDefault(); interaction.redo(); }
  else if (e.code === 'Delete' || e.code === 'Backspace') {
    if (!interaction.deleteFocus() && interaction.selected) { interaction.remove(interaction.selected); interaction.commit(); }
  } else if (e.key === '?' || e.code === 'KeyH') $('help').hidden = !$('help').hidden;
});
window.addEventListener('keyup', (e) => sim?.keys.delete(e.code));

// ---- status pills -------------------------------------------------------------------------------------
function pill(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${cls}`;
}

// ---- camera + tracker ------------------------------------------------------------------------------------
let lastHands = [], lastVideoTime = -1, detections = 0, fps = 0, fpsStamp = performance.now();

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
  if (!store.get('jarvis.seenHelp')) { $('help').hidden = false; store.set('jarvis.seenHelp', '1'); }
}
$('btn-start').addEventListener('click', () => start(true));
$('btn-mouse').addEventListener('click', () => start(false));

// ---- main loop ---------------------------------------------------------------------------------------------
let lastT = performance.now(), hudStamp = 0, lastSig = '', lastPoseCheck = 0;
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
  syncUndo();
  renderMeter(now);

  // docks: rebuild when the scene / selection changed; keep pose fields live while nothing is being edited
  const sig = `${interaction.rev}:${interaction.selRev}`;
  if (sig !== lastSig) { lastSig = sig; renderTree(); renderInspector(); }
  else if (interaction.selected && now - lastPoseCheck > 250 && !inspBody.contains(document.activeElement)) {
    lastPoseCheck = now;
    const p = interaction.selected;
    if (inspKey !== JSON.stringify([p.id, interaction.poseOf(p)])) renderInspector();
  }

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

  drawOverlay(fxCtx, w, h, interaction.hands.values(), settings.overlay);
  gl.render();
}
fit();
requestAnimationFrame(frame);

// Console / future voice-command entry point, e.g. jarvis.spawn('wheel', { diameter: 10, width: 4 })
window.jarvis = {
  spawn: (type, params, at) => { const p = interaction.spawn(type, params, at); interaction.commit(); return p; },
  clear: () => interaction.clear(),
  get parts() { return interaction.parts; },
  get connections() { return interaction.connections; },
  analyze: () => analyzeRobot(interaction.parts, interaction.connections, (p) => interaction.assemblyOf(p)),
  simulate: enterSim,
  getSim: () => sim,
  interaction,
  settings,
  catalog: CATALOG,
  PX_PER_CM,
};
