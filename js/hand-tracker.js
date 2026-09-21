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
          id, landmarks: lm, ratio,
          x: (lm[4].x + lm[8].x) / 2,
          y: (lm[4].y + lm[8].y) / 2,
          // roll of the hand in the screen plane (y up): wrist -> middle knuckle
          roll: Math.atan2(-(lm[9].y - lm[0].y), lm[9].x - lm[0].x),
        };
      });
    },
  };
}
