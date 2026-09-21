# Jarvis Workbench

Build robot hardware with your hands. A webcam-driven 3D workbench: pinch a part, drag it, twist your wrist to rotate it, and use two hands to scale it. Hand tracking runs locally in the browser (MediaPipe Hands + Three.js); nothing is uploaded.

## Run
Double-click `serve.bat` (or `python -m http.server 8000`) and open http://localhost:8000. Camera access requires `localhost`, not `file://`.

## Controls
| Action | Hand | Mouse fallback |
|---|---|---|
| Grab / move | pinch thumb + index over a part | drag |
| Rotate | twist wrist while pinching | shift + wheel |
| Scale a loose part | pinch with both hands and spread / close | wheel |
| Spawn | pinch a palette item | click it |
| Snap together (magnetic) | bring compatible parts close: they are pulled in and lock with a green dot; wheel↔motor and motor↔chassis pull from furthest away | same |
| Pull a part off | grab a part that is bolted on and pull firmly away (it takes whatever hangs off it) | same |
| Delete | drop the part / assembly on the trash zone | same |

## Building a rover
Parts have mounting ports that snap to matching ports on other parts:

| Part | Role | Snaps to |
|---|---|---|
| Chassis plate (20×12 cm, hole grid) | frame | – |
| Motor (geared DC) | drive | plate deck, edge rows (shaft points outward) |
| Wheel | drive | motor shaft |
| Ball caster | support | plate underside |
| Battery pack (6 V) | power | plate deck |
| Motor driver | electronics | plate deck |
| Controller | electronics | plate deck |
| Ultrasonic sensor | sensing (optional) | plate deck (faces forward) |
| Servo, frame beam, arm link, joint | for future arm builds | not snappable yet |

The **Rover checklist** (top right) shows what is still missing. When it is complete, press **▶ Simulate**.

## Simulator
Planar rigid-body physics: each motor follows a DC torque–speed curve (from motor size, battery voltage and wheel radius), wheels have friction limits, and mass / inertia / centre of mass come from the parts you placed. Bigger wheels are faster but weaker; a heavier build accelerates slower.
`W A S D` / arrows drive · `M` auto obstacle-avoid (needs the ultrasonic sensor) · `C` camera · `R` reset · `Esc` back.

## Layout
- `js/parts.js` – parametric part catalog (cm dimensions), ports and physical properties
- `js/robot.js` – finds the rover in the assembly, builds the checklist and the physical spec
- `js/sim.js` – differential-drive physics, arena, sonar, chase camera
- `js/interaction.js` – pinch/grab/rotate/scale state machine
- `js/hand-tracker.js` – camera + MediaPipe landmarks → pinch data
- `vendor/` – three.js, MediaPipe and the hand model, vendored so it works offline

## Roadmap
Voice → parts: `window.jarvis.spawn('wheel', { diameter: 10, width: 4 })` is the entry point a speech/LLM layer will call. Next: arm parts that snap, voice input, part export.
