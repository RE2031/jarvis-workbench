import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// World units are screen pixels at z = 0, origin at the stage centre, y up.
// 1 cm of a part = PX_PER_CM world units (see parts.js).
const FOV = 40;

export function createScene(mount) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-300, 500, 700);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.3));

  const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 10000);
  let w = 1280, h = 720;

  function resize(nw, nh) {
    w = nw; h = nh;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.position.set(0, 0, (h / 2) / Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    camera.far = camera.position.z + 2000;
    camera.updateProjectionMatrix();
  }
  resize(w, h);

  return {
    scene, camera, renderer, resize, environment: scene.environment,
    size: () => ({ w, h }),
    toWorld: (x, y) => ({ x: x - w / 2, y: h / 2 - y }),
    toStage: (x, y) => ({ x: x + w / 2, y: h / 2 - y }),
    render: () => renderer.render(scene, camera),
  };
}
