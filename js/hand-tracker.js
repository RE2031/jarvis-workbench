import * as THREE from 'three';
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable. Open via http://localhost, not a file:// URL.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Full 3D orientation of the palm as a quaternion [x, y, z, w], in the same space the user sees on screen
// (mirrored: x right, y up, z towards the viewer). Built from wrist, index knuckle, middle knuckle and
// pinky knuckle of MediaPipe's metric world landmarks, which stay stable while the fingers pinch.
function palmOrientation(wl) {
  if (!wl) return null;
  const P = (k) => new THREE.Vector3(-wl[k].x, -wl[k].y, -wl[k].z);
  const up = P(9).sub(P(0)).normalize();
  const across = P(5).sub(P(17));
  across.addScaledVector(up, -across.dot(up));
  if (across.lengthSq() < 1e-8) return null;
  across.normalize();
  const normal = new THREE.Vector3().crossVectors(across, up);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, up, normal));
  return q.toArray();
}

export async function createTracker() {
  const fileset = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
  const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: './vendor/models/hand_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let landmarker;
  try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }

  return {
    // Returns hands in stage-pixel coordinates. x is mirrored so it matches the mirrored video.
    detect(video, timeMs, W, H) {
      const res = landmarker.detectForVideo(video, timeMs);
      const used = new Set();
      return res.landmarks.map((raw, i) => {
        const lm = raw.map((p) => ({ x: (1 - p.x) * W, y: p.y * H }));
        let id = res.handednesses?.[i]?.[0]?.categoryName ?? `h${i}`;
        while (used.has(id)) id += '+';
        used.add(id);

        const palm = Math.max(1, dist(lm[0], lm[9]));
        const ratio = dist(lm[4], lm[8]) / palm; // thumb-index gap relative to palm size
        return {
          id, landmarks: lm, ratio, orient: palmOrientation(res.worldLandmarks?.[i]),
          x: (lm[4].x + lm[8].x) / 2,
          y: (lm[4].y + lm[8].y) / 2,
          // roll of the hand in the screen plane (y up): wrist -> middle knuckle
          roll: Math.atan2(-(lm[9].y - lm[0].y), lm[9].x - lm[0].x),
        };
      });
    },
  };
}
