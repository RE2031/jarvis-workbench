# Jarvis Workbench

Build robot hardware with your hands. A webcam-driven 3D workbench: pinch a part, drag it, twist your wrist to rotate it, and use two hands to scale it. Hand tracking runs locally in the browser (MediaPipe Hands + Three.js); nothing is uploaded.

## Run
Double-click `serve.bat` (or `python -m http.server 8000`) and open http://localhost:8000. Camera access requires `localhost`, not `file://`.

## Editor (CoppeliaSim-style)
- **Scene hierarchy** (left): every object, with bolted-on parts nested under their chassis. Click a row to select.
- **Object properties** (right): edit position (cm), rotation (°), scale and the part's own dimensions. Changing a wheel's diameter rebuilds it and keeps it seated on its motor.
- **Start / Stop simulation** in the toolbar. Undo / redo (Ctrl+Z / Ctrl+Y), autosave, save / load file, and *Export parts list* (CSV with suggested real-world parts).

## Controls
| Action | Hand | Mouse fallback |
|---|---|---|
| Grab / move | pinch thumb + index over a part | drag |
| Rotate | turn your hand (full 3D palm orientation) | right-drag (trackball), shift + wheel = twist |
| Scale a loose part | pinch with both hands and spread / close | wheel |
| Spawn | pinch a palette item | click it |
| Snap together (magnetic) | bring compatible parts close: dots show where they fit, the part is pulled in and locks (green dot) | same |
| Pull a part off | grab a bolted-on part and pull firmly away | same |
| Delete | drop on the trash, or hover + Delete | same |

Pinch feels off? Open ⚙ Settings: a live pinch meter shows the thumb-index ratio against the thresholds, and **Calibrate pinch** measures your hand and sets them for you.

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
