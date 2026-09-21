# Jarvis Workbench

Build robot hardware with your hands. A webcam-driven 3D workbench: pinch a part, drag it, twist your wrist to rotate it, and use two hands to scale it. Hand tracking runs locally in the browser (MediaPipe Hands + Three.js); nothing is uploaded.

## Run
Double-click `serve.bat` (or `python -m http.server 8000`) and open http://localhost:8000. Camera access requires `localhost`, not `file://`.

## Controls
| Action | Hand | Mouse fallback |
|---|---|---|
| Grab / move | pinch thumb + index over a part | drag |
| Rotate | twist wrist while pinching | shift + wheel |
| Scale | pinch with both hands and spread / close | wheel |
| Spawn | pinch a palette item | click it |
| Delete | drop the part on the trash zone | same |

## Layout
- `js/parts.js` – parametric part catalog (cm dimensions): wheel, motor, servo, plate, beam, link, joint
- `js/interaction.js` – pinch/grab/rotate/scale state machine
- `js/hand-tracker.js` – camera + MediaPipe landmarks → pinch data
- `vendor/` – three.js, MediaPipe and the hand model, vendored so it works offline

## Roadmap
Voice → parts: `window.jarvis.spawn('wheel', { diameter: 10, width: 4 })` is the entry point a speech/LLM layer will call. Next: snap-to-attach, part export.
