// User-tunable settings, persisted in localStorage (which can be unavailable, hence the try/catch).
const KEY = 'jarvis.settings';

export const DEFAULTS = {
  pinchOn: 0.28,    // thumb-index gap / palm size below which a pinch starts
  pinchOff: 0.45,   // ...and above which it ends
  responsive: 0.35, // hand smoothing: low = steadier, high = snappier
  rot3d: true,      // rotate parts with the full 3D orientation of the hand (else: wrist twist only)
  rotSens: 1,       // rotation gain
  sound: true,
  overlay: true,    // draw the hand skeleton
};

export const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore */ }

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
export function resetSettings() {
  Object.assign(settings, DEFAULTS);
  saveSettings();
}
