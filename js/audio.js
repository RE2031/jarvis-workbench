// Tiny synthesised sound cues (no audio files).
const TONES = {
  spawn: [500, 700, 0.08, 'sine', 0.08],
  lock: [220, 440, 0.09, 'triangle', 0.16],
  snap: [300, 900, 0.12, 'triangle', 0.16],
  pull: [600, 250, 0.1, 'sawtooth', 0.05],
  delete: [400, 120, 0.18, 'square', 0.05],
  error: [200, 140, 0.22, 'square', 0.06],
};
let ac = null, unlocked = false;
// Browsers only allow audio after a user gesture.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { unlocked = true; }, { once: true, capture: true });

export function sfx(name, enabled = true) {
  if (!enabled || !unlocked || !TONES[name]) return;
  try {
    ac ??= new AudioContext();
    if (ac.state === 'suspended') ac.resume();
    const [f1, f2, dur, type, vol] = TONES[name];
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + dur);
  } catch { /* audio unavailable */ }
}
