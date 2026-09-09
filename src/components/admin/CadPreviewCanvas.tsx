'use client';

/**
 * The CAD studio renderer has two deliberately distinct quality paths:
 *
 * 1. reviewed, component-specific GLB assemblies for parts that have a real
 *    CAD asset in the registry; and
 * 2. a polished parametric fallback for a newly parsed datasheet spec.
 *
 * Keeping those paths separate is important. A generic generated model is
 * useful immediately, but it should never be presented as manufacturer-grade
 * geometry simply because it has a PBR material on it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getCadReferenceAsset, type CadComponentSpec, type CadFeature, type CadPinDefinition } from 'cad-helper';

interface CadPreviewCanvasProps {
  spec: CadComponentSpec;
  /** Show named connection-anchor markers. Kept off by default for a clean studio view. */
  showPins?: boolean;
  wireframe?: boolean;
}

type PreviewState = 'loading' | 'reference' | 'parametric' | 'fallback';

interface OrbitState {
  target: THREE.Vector3;
  radius: number;
  azimuth: number;
  polar: number;
}

interface CameraFrame {
  target: THREE.Vector3;
  radius: number;
  azimuth: number;
  polar: number;
}

const PIN_COLOURS: Record<CadPinDefinition['role'], number> = {
  power: 0xfb7185,
  ground: 0x34d399,
  digital: 0x60a5fa,
  analog: 0xc084fc,
  i2c: 0x22d3ee,
  spi: 0xfbbf24,
  uart: 0xf59e0b,
  pwm: 0xa3e635,
  control: 0x94a3b8,
  bidirectional: 0x2dd4bf,
};

const CAD_BLUE = new THREE.Color('#0d4f96');

function asMaterials(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    asMaterials(child.material).forEach((material) => material.dispose());
  });
}

function materialForFeature(feature: CadFeature, wireframe: boolean): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
  const name = feature.name.toLowerCase();
  const colour = feature.color ?? '#aab5c4';

  if (feature.type === 'screen') {
    return new THREE.MeshPhysicalMaterial({
      color: colour,
      metalness: 0.05,
      roughness: 0.08,
      clearcoat: 0.75,
      clearcoatRoughness: 0.1,
      emissive: new THREE.Color(colour).multiplyScalar(0.07),
      wireframe,
    });
  }

  if (feature.type === 'led' || feature.type === 'lens') {
    return new THREE.MeshPhysicalMaterial({
      color: colour,
      roughness: 0.2,
      transmission: 0.08,
      clearcoat: 0.9,
      clearcoatRoughness: 0.11,
      emissive: new THREE.Color(colour).multiplyScalar(0.22),
      emissiveIntensity: 0.8,
      wireframe,
    });
  }

  if (feature.type === 'heatsink' || /usb|crystal|shield|metal|screw/.test(name)) {
    return new THREE.MeshStandardMaterial({
      color: colour,
      metalness: 0.8,
      roughness: 0.24,
      envMapIntensity: 1.25,
      wireframe,
    });
  }

  if (/jack|socket|header|chip|ic|regulator/.test(name)) {
    return new THREE.MeshPhysicalMaterial({
      color: colour,
      roughness: 0.4,
      metalness: 0.12,
      clearcoat: 0.2,
      clearcoatRoughness: 0.3,
      wireframe,
    });
  }

  return new THREE.MeshStandardMaterial({
    color: colour,
    roughness: 0.48,
    metalness: 0.12,
    envMapIntensity: 0.8,
    wireframe,
  });
}

function setShadowFlags(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function roundedBox(width: number, height: number, depth: number, radius = 0.35): THREE.BufferGeometry {
  const safeRadius = Math.max(0.04, Math.min(radius, width / 5, height / 2.2, depth / 5));
  return new RoundedBoxGeometry(width, height, depth, 4, safeRadius);
}

function createSilkscreenTexture(title: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const context = canvas.getContext('2d');

  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'rgba(245, 250, 255, 0.92)';
    context.lineWidth = 5;
    context.strokeRect(24, 26, 976, 204);
    context.fillStyle = 'rgba(245, 250, 255, 0.96)';
    context.font = '700 71px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('WIREUP / CAD ASSEMBLY', 54, 108);
    context.font = '600 36px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillStyle = 'rgba(206, 230, 255, 0.9)';
    context.fillText(title.toUpperCase().slice(0, 40), 56, 174);
    context.fillStyle = 'rgba(206, 230, 255, 0.64)';
    context.font = '500 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('PARAMETRIC PREVIEW · NOT MANUFACTURING ARTWORK', 56, 211);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function addAnchorMarker(parent: THREE.Object3D, pin: CadPinDefinition, radius: number): void {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color: PIN_COLOURS[pin.role], transparent: true, opacity: 0.9, depthWrite: false }),
  );
  marker.name = `anchor:${pin.name}`;
  marker.userData.cadLabel = `${pin.name} · ${pin.signal}`;
  marker.position.set(pin.xMm, pin.yMm, pin.zMm);
  parent.add(marker);
}

function addReferenceAnchorMarker(parent: THREE.Object3D, pin: CadPinDefinition, radius: number): void {
  const node = parent.getObjectByName(pin.name);
  if (!node) return;

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color: PIN_COLOURS[pin.role], transparent: true, opacity: 0.88, depthWrite: false }),
  );
  marker.name = `anchor:${pin.name}`;
  marker.userData.cadLabel = `${pin.name} · ${pin.signal}`;
  // Reviewed GLBs use a 1000× millimetre wrapper around metre-native source geometry.
  // The anchor is under that wrapper, so compensate to keep a sub-millimetre marker.
  marker.scale.setScalar(0.001);
  node.add(marker);
}

function createFeatureAssembly(feature: CadFeature, wireframe: boolean): THREE.Group {
  const assembly = new THREE.Group();
  const [width, height, depth] = feature.dimensions;
  const material = materialForFeature(feature, wireframe);
  const name = feature.name.toLowerCase();
  assembly.name = feature.name;
  assembly.userData.cadLabel = feature.name.replace(/[_-]/g, ' ');
  assembly.position.set(...feature.position);

  if (feature.type === 'cylinder') {
    const radius = Math.max(width, 0.3);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.94, Math.max(height, 0.5), 32, 1, false), material);
    assembly.add(mesh);
  } else if (feature.type === 'led' || feature.type === 'lens') {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.max(width * 0.54, 0.35), Math.max(width * 0.54, 0.35), Math.max(height * 0.34, 0.35), 24),
      new THREE.MeshStandardMaterial({ color: '#16202c', roughness: 0.42, wireframe }),
    );
    base.position.y = -Math.max(height * 0.33, 0.35) / 2;
    const lens = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(width * 0.54, 0.42), 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      material,
    );
    lens.position.y = Math.max(height * 0.08, 0.12);
    assembly.add(base, lens);
  } else if (feature.type === 'screen') {
    const frame = new THREE.Mesh(
      roundedBox(Math.max(width, 1), Math.max(height, 0.7), Math.max(depth, 1), 0.35),
      new THREE.MeshPhysicalMaterial({ color: '#111827', roughness: 0.32, metalness: 0.15, wireframe }),
    );
    const panel = new THREE.Mesh(
      roundedBox(Math.max(width - 1.3, 0.5), Math.max(height * 0.24, 0.18), Math.max(depth - 1.3, 0.5), 0.16),
      material,
    );
    panel.position.y = height * 0.45;
    assembly.add(frame, panel);
  } else if (feature.type === 'header_block') {
    const housing = new THREE.Mesh(
      roundedBox(Math.max(width, 1), Math.max(height, 0.8), Math.max(depth, 1), 0.26),
      new THREE.MeshPhysicalMaterial({ color: feature.color ?? '#181b22', roughness: 0.38, clearcoat: 0.18, wireframe }),
    );
    assembly.add(housing);
    const count = Math.max(2, Math.round(Math.max(width, depth) / 2.54));
    const longOnX = width >= depth;
    for (let index = 0; index < count; index += 1) {
      const opening = new THREE.Mesh(
        new THREE.CylinderGeometry(0.44, 0.44, Math.max(height * 0.08, 0.08), 12),
        new THREE.MeshBasicMaterial({ color: '#05070a', wireframe }),
      );
      const fraction = (index + 0.5) / count - 0.5;
      opening.position.set(longOnX ? fraction * width * 0.86 : 0, height * 0.52, longOnX ? 0 : fraction * depth * 0.86);
      assembly.add(opening);
    }
  } else if (feature.type === 'screw_terminal') {
    const terminal = new THREE.Mesh(roundedBox(Math.max(width, 1), Math.max(height, 0.8), Math.max(depth, 1), 0.38), material);
    const screw = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.min(width, depth) * 0.23, Math.min(width, depth) * 0.23, Math.max(height * 0.15, 0.12), 24),
      new THREE.MeshStandardMaterial({ color: '#b9c1cd', metalness: 0.9, roughness: 0.2, wireframe }),
    );
    screw.position.y = height * 0.54;
    assembly.add(terminal, screw);
  } else if (feature.type === 'potentiometer') {
    const housing = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.max(width * 0.52, 0.8), Math.max(width * 0.52, 0.8), Math.max(height * 0.55, 0.8), 28),
      material,
    );
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.max(width * 0.19, 0.26), Math.max(width * 0.19, 0.26), Math.max(height * 0.75, 0.8), 20),
      new THREE.MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.88, roughness: 0.2, wireframe }),
    );
    shaft.position.y = height * 0.58;
    assembly.add(housing, shaft);
  } else if (feature.type === 'heatsink') {
    const base = new THREE.Mesh(roundedBox(Math.max(width, 1), Math.max(height * 0.16, 0.3), Math.max(depth, 1), 0.16), material);
    assembly.add(base);
    const finCount = Math.max(3, Math.round(Math.max(width, depth) / 2.2));
    const finWidth = width >= depth ? width / finCount : Math.max(width * 0.55, 0.25);
    for (let index = 0; index < finCount; index += 1) {
      const fin = new THREE.Mesh(
        new THREE.BoxGeometry(width >= depth ? finWidth * 0.46 : width * 0.74, Math.max(height * 0.8, 0.4), width >= depth ? depth * 0.78 : depth / finCount * 0.46),
        material,
      );
      const fraction = (index + 0.5) / finCount - 0.5;
      fin.position.set(width >= depth ? fraction * width * 0.84 : 0, height * 0.39, width >= depth ? 0 : fraction * depth * 0.84);
      assembly.add(fin);
    }
  } else {
    const boardComponent = new THREE.Mesh(roundedBox(Math.max(width, 0.5), Math.max(height, 0.35), Math.max(depth, 0.5), 0.32), material);
    assembly.add(boardComponent);

    // A thin metallic cap makes common ICs/connectors read as an assembly rather than a flat block.
    if (/usb|crystal|shield/.test(name)) {
      const cap = new THREE.Mesh(
        roundedBox(Math.max(width * 0.88, 0.3), Math.max(height * 0.12, 0.08), Math.max(depth * 0.88, 0.3), 0.1),
        new THREE.MeshStandardMaterial({ color: '#d4d9e2', metalness: 0.88, roughness: 0.22, wireframe }),
      );
      cap.position.y = height * 0.55;
      assembly.add(cap);
    }
  }

  if (feature.rotation) {
    assembly.rotation.set(...feature.rotation.map((degrees) => THREE.MathUtils.degToRad(degrees)) as [number, number, number]);
  }
  setShadowFlags(assembly);
  return assembly;
}

function addGenericHeaders(root: THREE.Group, spec: CadComponentSpec, wireframe: boolean, showPins: boolean): void {
  const metal = new THREE.MeshStandardMaterial({ color: '#d8b560', metalness: 0.92, roughness: 0.18, envMapIntensity: 1.4, wireframe });
  const housing = new THREE.MeshPhysicalMaterial({ color: '#151820', roughness: 0.37, clearcoat: 0.18, wireframe });

  spec.pins.forEach((pin) => {
    const direction = new THREE.Vector3(
      pin.direction === 'left' ? -1 : pin.direction === 'right' ? 1 : 0,
      pin.direction === 'down' ? -1 : pin.direction === 'up' || !pin.direction ? 1 : 0,
      pin.direction === 'back' ? -1 : pin.direction === 'front' ? 1 : 0,
    );
    if (direction.lengthSq() === 0) direction.set(0, 1, 0);
    direction.normalize();

    const pinLength = 4.8;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.66, pinLength, 0.66), metal);
    if (Math.abs(direction.x) > 0.5) shaft.rotation.z = Math.PI / 2;
    if (Math.abs(direction.z) > 0.5) shaft.rotation.x = Math.PI / 2;
    shaft.position.set(pin.xMm, pin.yMm, pin.zMm).addScaledVector(direction, pinLength * 0.35);
    shaft.name = `pin:${pin.name}`;
    shaft.userData.cadLabel = `${pin.name} · ${pin.signal}`;

    const socket = new THREE.Mesh(roundedBox(2.18, 1.85, 2.18, 0.22), housing);
    socket.position.set(pin.xMm, pin.yMm, pin.zMm).addScaledVector(direction, 0.25);
    socket.name = `socket:${pin.name}`;
    socket.userData.cadLabel = `${pin.name} header`;

    const anchor = new THREE.Object3D();
    anchor.name = pin.name;
    anchor.position.set(pin.xMm, pin.yMm, pin.zMm).addScaledVector(direction, pinLength * 0.88);
    root.add(socket, shaft, anchor);
    if (showPins) addAnchorMarker(root, { ...pin, xMm: anchor.position.x, yMm: anchor.position.y, zMm: anchor.position.z }, 0.56);
  });
}

function buildParametricAssembly(spec: CadComponentSpec, wireframe: boolean, showPins: boolean): THREE.Group {
  const root = new THREE.Group();
  const { widthMm, lengthMm, heightMm } = spec.dimensions;
  root.name = `parametric:${spec.id}`;

  const pcbMaterial = new THREE.MeshPhysicalMaterial({
    color: spec.bodyColor ?? CAD_BLUE,
    roughness: 0.37,
    metalness: 0.16,
    clearcoat: 0.38,
    clearcoatRoughness: 0.34,
    envMapIntensity: 1.05,
    wireframe,
  });
  const board = new THREE.Mesh(roundedBox(widthMm, Math.max(heightMm, 0.8), lengthMm, Math.min(1.45, heightMm * 0.55)), pcbMaterial);
  board.name = 'PCB substrate';
  board.userData.cadLabel = `${spec.name} PCB substrate`;
  board.position.y = Math.max(heightMm, 0.8) / 2;
  root.add(board);

  // Fibreglass edge reads distinctly under studio lights and prevents the board from looking like a flat UI tile.
  const core = new THREE.Mesh(
    roundedBox(widthMm * 0.99, Math.max(heightMm * 0.55, 0.32), lengthMm * 0.99, Math.min(0.7, heightMm * 0.24)),
    new THREE.MeshStandardMaterial({ color: '#0c2d2a', roughness: 0.72, metalness: 0.04, wireframe }),
  );
  core.position.y = Math.max(heightMm, 0.8) * 0.48;
  root.add(core);

  const holeMaterial = new THREE.MeshStandardMaterial({ color: '#c59b43', metalness: 0.72, roughness: 0.25, wireframe });
  const holeInset = Math.min(3.7, Math.max(1.8, Math.min(widthMm, lengthMm) * 0.09));
  [
    [-widthMm / 2 + holeInset, -lengthMm / 2 + holeInset],
    [widthMm / 2 - holeInset, -lengthMm / 2 + holeInset],
    [-widthMm / 2 + holeInset, lengthMm / 2 - holeInset],
    [widthMm / 2 - holeInset, lengthMm / 2 - holeInset],
  ].forEach(([x, z]) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.min(1.5, holeInset * 0.38), 0.2, 10, 28), holeMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, Math.max(heightMm, 0.8) + 0.035, z);
    ring.name = 'mounting hole';
    ring.userData.cadLabel = 'Plated mounting hole';
    root.add(ring);
  });

  const silkscreen = new THREE.Mesh(
    new THREE.PlaneGeometry(widthMm * 0.7, Math.min(lengthMm * 0.18, widthMm * 0.19)),
    new THREE.MeshBasicMaterial({ map: createSilkscreenTexture(spec.name), transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }),
  );
  silkscreen.rotation.x = -Math.PI / 2;
  silkscreen.position.set(0, Math.max(heightMm, 0.8) + 0.045, lengthMm * 0.27);
  silkscreen.name = 'silkscreen';
  silkscreen.userData.cadLabel = `${spec.name} silkscreen`;
  root.add(silkscreen);

  addGenericHeaders(root, spec, wireframe, showPins);
  spec.features.forEach((feature) => root.add(createFeatureAssembly(feature, wireframe)));
  setShadowFlags(root);
  return root;
}

function tuneReferenceMaterials(model: THREE.Object3D, wireframe: boolean): void {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    child.castShadow = true;
    child.receiveShadow = true;
    child.userData.cadLabel = child.name.replace(/^NAUO\d+$/i, 'PCB assembly part').replace(/[_-]/g, ' ');

    const sourceMaterials = asMaterials(child.material);
    const tuned = sourceMaterials.map((source) => {
      const material = source.clone();
      const label = `${child.name} ${material.name}`.toLowerCase();
      if ('wireframe' in material) material.wireframe = wireframe;

      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = 1.15;
        if (/board/.test(label)) {
          material.color.copy(CAD_BLUE);
          material.roughness = 0.34;
          material.metalness = 0.14;
        } else if (/usb|shell|contact|crystal|reg|pads|pin/.test(label)) {
          material.metalness = 0.78;
          material.roughness = 0.22;
        } else if (/header|jack|dip|diode/.test(label)) {
          material.roughness = 0.38;
          material.metalness = 0.12;
        } else if (/led/.test(label)) {
          material.roughness = 0.2;
          material.emissive.copy(material.color).multiplyScalar(0.18);
          material.emissiveIntensity = 0.65;
        } else {
          material.roughness = 0.42;
          material.metalness = 0.2;
        }
      }
      return material;
    });
    child.material = Array.isArray(child.material) ? tuned : tuned[0];
  });
}

function setHighlightedMesh(mesh: THREE.Mesh | null, highlighted: boolean): void {
  if (!mesh) return;
  asMaterials(mesh.material).forEach((material) => {
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    const key = '__wireupStudioOriginalEmissive';
    if (highlighted) {
      if (!mesh.userData[key]) mesh.userData[key] = material.emissive.getHex();
      material.emissive.set('#245bb9');
      material.emissiveIntensity = 0.65;
    } else if (typeof mesh.userData[key] === 'number') {
      material.emissive.setHex(mesh.userData[key]);
      material.emissiveIntensity = 1;
    }
  });
}

function updateCameraFromOrbit(camera: THREE.PerspectiveCamera, orbit: OrbitState): void {
  const sinPolar = Math.sin(orbit.polar);
  camera.position.set(
    orbit.target.x + orbit.radius * sinPolar * Math.sin(orbit.azimuth),
    orbit.target.y + orbit.radius * Math.cos(orbit.polar),
    orbit.target.z + orbit.radius * sinPolar * Math.cos(orbit.azimuth),
  );
  camera.lookAt(orbit.target);
}

function createFrame(camera: THREE.PerspectiveCamera, object: THREE.Object3D): CameraFrame | null {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const target = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 12);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const radius = Math.max(18, maxSize / (2 * Math.tan(fov / 2)) * 1.78);
  return { target, radius, azimuth: -0.82, polar: 1.03 };
}

export function CadPreviewCanvas({ spec, showPins = false, wireframe = false }: CadPreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const floorRef = useRef<THREE.Mesh | null>(null);
  const orbitRef = useRef<OrbitState>({ target: new THREE.Vector3(), radius: 92, azimuth: -0.82, polar: 1.03 });
  const defaultFrameRef = useRef<CameraFrame | null>(null);
  const draggingRef = useRef<{ active: boolean; button: number; x: number; y: number }>({ active: false, button: 0, x: 0, y: 0 });
  const hoveredMeshRef = useRef<THREE.Mesh | null>(null);
  const hoveredLabelRef = useRef<string | null>(null);

  const referenceAsset = getCadReferenceAsset(spec);
  const [previewState, setPreviewState] = useState<PreviewState>(referenceAsset ? 'loading' : 'parametric');
  const [hoveredPart, setHoveredPart] = useState<string | null>(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);

  const resetCamera = useCallback(() => {
    const camera = cameraRef.current;
    const frame = defaultFrameRef.current;
    if (!camera || !frame) return;
    orbitRef.current = {
      target: frame.target.clone(),
      radius: frame.radius,
      azimuth: frame.azimuth,
      polar: frame.polar,
    };
    updateCameraFromOrbit(camera, orbitRef.current);
  }, []);

  // The renderer and controls are created once. Model construction lives in the next effect.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      setWebglUnavailable(true);
      return undefined;
    }

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 440;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#e6ebf2');
    scene.fog = new THREE.Fog('#e6ebf2', 170, 340);
    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 1500);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.16;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = 'cad-studio__canvas';
    renderer.domElement.style.touchAction = 'none';
    container.replaceChildren(renderer.domElement);

    const environmentGenerator = new THREE.PMREMGenerator(renderer);
    const environment = environmentGenerator.fromScene(new RoomEnvironment(), 0.045);
    scene.environment = environment.texture;
    environmentGenerator.dispose();

    const key = new THREE.DirectionalLight('#fff8ea', 3.8);
    key.position.set(90, 125, 80);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 5;
    key.shadow.camera.far = 350;
    key.shadow.bias = -0.00015;
    scene.add(key);

    const fill = new THREE.DirectionalLight('#88baff', 1.55);
    fill.position.set(-110, 65, 25);
    scene.add(fill);

    const rim = new THREE.DirectionalLight('#b79aff', 1.7);
    rim.position.set(15, 55, -130);
    scene.add(rim);
    scene.add(new THREE.HemisphereLight('#ffffff', '#5c6977', 1.15));

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(240, 80),
      new THREE.ShadowMaterial({ color: '#18263b', opacity: 0.22, transparent: true }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.18;
    floor.receiveShadow = true;
    scene.add(floor);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    floorRef.current = floor;
    modelGroupRef.current = modelGroup;
    updateCameraFromOrbit(camera, orbitRef.current);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const updateHoveredMesh = (event: PointerEvent) => {
      if (draggingRef.current.active) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(modelGroup, true).find((intersection) => intersection.object instanceof THREE.Mesh);
      const nextMesh = hit?.object instanceof THREE.Mesh ? hit.object : null;
      if (nextMesh === hoveredMeshRef.current) return;

      setHighlightedMesh(hoveredMeshRef.current, false);
      hoveredMeshRef.current = nextMesh;
      setHighlightedMesh(nextMesh, true);
      const nextLabel = nextMesh?.userData.cadLabel as string | undefined;
      if ((nextLabel ?? null) !== hoveredLabelRef.current) {
        hoveredLabelRef.current = nextLabel ?? null;
        setHoveredPart(nextLabel ?? null);
      }
      renderer.domElement.style.cursor = nextMesh ? 'pointer' : 'grab';
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      renderer.domElement.setPointerCapture(event.pointerId);
      draggingRef.current = { active: true, button: event.button, x: event.clientX, y: event.clientY };
      renderer.domElement.style.cursor = event.button === 2 || event.shiftKey ? 'move' : 'grabbing';
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag.active) {
        updateHoveredMesh(event);
        return;
      }

      const deltaX = event.clientX - drag.x;
      const deltaY = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const orbit = orbitRef.current;
      const isPanning = drag.button === 2 || event.shiftKey;

      if (isPanning) {
        const right = new THREE.Vector3();
        camera.getWorldDirection(right);
        right.cross(camera.up).normalize();
        const up = new THREE.Vector3().crossVectors(right, camera.getWorldDirection(new THREE.Vector3())).normalize();
        const scale = Math.max(orbit.radius / Math.max(boundsWidth(renderer.domElement), 1), 0.025);
        orbit.target.addScaledVector(right, -deltaX * scale);
        orbit.target.addScaledVector(up, deltaY * scale);
      } else {
        orbit.azimuth -= deltaX * 0.008;
        orbit.polar = THREE.MathUtils.clamp(orbit.polar + deltaY * 0.008, 0.18, Math.PI - 0.22);
      }
      updateCameraFromOrbit(camera, orbit);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      draggingRef.current.active = false;
      renderer.domElement.style.cursor = 'grab';
    };

    const onPointerLeave = () => {
      if (draggingRef.current.active) return;
      setHighlightedMesh(hoveredMeshRef.current, false);
      hoveredMeshRef.current = null;
      if (hoveredLabelRef.current) {
        hoveredLabelRef.current = null;
        setHoveredPart(null);
      }
      renderer.domElement.style.cursor = 'grab';
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const orbit = orbitRef.current;
      orbit.radius = THREE.MathUtils.clamp(orbit.radius * Math.exp(event.deltaY * 0.001), 8, 780);
      updateCameraFromOrbit(camera, orbit);
    };

    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('contextmenu', onContextMenu);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width < 1 || entry.contentRect.height < 1) return;
      camera.aspect = entry.contentRect.width / entry.contentRect.height;
      camera.updateProjectionMatrix();
      renderer.setSize(entry.contentRect.width, entry.contentRect.height, false);
    });
    resizeObserver.observe(container);

    let frameId = 0;
    const render = () => {
      frameId = requestAnimationFrame(render);
      renderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      disposeObject(modelGroup);
      environment.dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.replaceChildren();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      modelGroupRef.current = null;
      floorRef.current = null;
    };
  }, []);

  // Add either a reviewed GLB or the polished fallback whenever the selected spec changes.
  useEffect(() => {
    const scene = sceneRef.current;
    const group = modelGroupRef.current;
    const camera = cameraRef.current;
    if (!scene || !group || !camera) return undefined;

    let cancelled = false;
    let activeAssembly: THREE.Object3D | null = null;
    setHoveredPart(null);
    hoveredLabelRef.current = null;
    setHighlightedMesh(hoveredMeshRef.current, false);
    hoveredMeshRef.current = null;

    const replaceAssembly = (assembly: THREE.Object3D, state: PreviewState) => {
      if (cancelled) {
        disposeObject(assembly);
        return;
      }
      while (group.children.length > 0) {
        const child = group.children.pop();
        if (child) {
          group.remove(child);
          disposeObject(child);
        }
      }
      activeAssembly = assembly;
      group.add(assembly);
      const frame = createFrame(camera, assembly);
      if (frame) {
        defaultFrameRef.current = frame;
        orbitRef.current = {
          target: frame.target.clone(),
          radius: frame.radius,
          azimuth: frame.azimuth,
          polar: frame.polar,
        };
        updateCameraFromOrbit(camera, orbitRef.current);
        const floor = floorRef.current;
        if (floor) {
          const bounds = new THREE.Box3().setFromObject(assembly);
          const size = bounds.getSize(new THREE.Vector3());
          floor.scale.setScalar(Math.max(0.48, Math.max(size.x, size.z) / 190));
          floor.position.y = bounds.min.y - 0.16;
        }
      }
      setPreviewState(state);
    };

    if (!referenceAsset) {
      replaceAssembly(buildParametricAssembly(spec, wireframe, showPins), 'parametric');
      return () => {
        cancelled = true;
      };
    }

    setPreviewState('loading');
    const loader = new GLTFLoader();
    loader.load(
      referenceAsset.url,
      (gltf) => {
        const model = gltf.scene;
        tuneReferenceMaterials(model, wireframe);
        model.name = `reference:${spec.id}`;
        model.userData.cadLabel = spec.name;
        if (showPins) {
          // The GLB includes named empty nodes; markers attach to those real anchors rather than estimated locations.
          spec.pins.forEach((pin) => addReferenceAnchorMarker(model, pin, 0.72));
        }
        replaceAssembly(model, 'reference');
      },
      undefined,
      () => {
        // A bad/missing optional asset must never make the authoring console unusable.
        replaceAssembly(buildParametricAssembly(spec, wireframe, showPins), 'fallback');
      },
    );

    return () => {
      cancelled = true;
      if (activeAssembly?.parent === group) {
        group.remove(activeAssembly);
        disposeObject(activeAssembly);
      }
    };
  }, [referenceAsset, showPins, spec, wireframe]);

  const qualityCopy = previewState === 'reference'
    ? 'Reviewed assembly'
    : previewState === 'loading'
      ? 'Loading assembly'
      : previewState === 'fallback'
        ? 'Parametric fallback'
        : 'Parametric preview';

  return (
    <div className="cad-studio" data-quality={previewState}>
      <div ref={containerRef} className="cad-studio__stage" aria-label={`Interactive 3D CAD view for ${spec.name}`} />
      {webglUnavailable ? (
        <div className="cad-studio__unavailable">
          <strong>3D preview needs WebGL</strong>
          <span>Use a WebGL-capable browser to inspect the assembly.</span>
        </div>
      ) : null}

      <div className="cad-studio__topline">
        <div className="cad-studio__asset">
          <span className="cad-studio__eyebrow">CAD STUDIO / PBR</span>
          <strong>{qualityCopy}</strong>
          {referenceAsset ? <small title={referenceAsset.attribution}>{referenceAsset.detail}</small> : <small>Generated from dimensions, pins and surface features.</small>}
        </div>
        <div className="cad-studio__measurements">
          <span>{spec.dimensions.widthMm} × {spec.dimensions.lengthMm} × {spec.dimensions.heightMm} mm</span>
          <i />
          <b>{spec.pins.length} anchors</b>
        </div>
      </div>

      <div className="cad-studio__toolbar" role="group" aria-label="3D view controls">
        <button type="button" onClick={resetCamera}>Frame assembly</button>
        <span>drag orbit</span>
        <span>shift/right drag pan</span>
        <span>scroll zoom</span>
      </div>

      <div className="cad-studio__footer">
        <span className={`cad-studio__quality cad-studio__quality--${previewState}`}>
          <i />
          {wireframe ? 'Technical wireframe' : qualityCopy}
        </span>
        <span className="cad-studio__hover">{hoveredPart ? `part / ${hoveredPart}` : showPins ? 'anchors visible' : 'hover to inspect a part'}</span>
      </div>
    </div>
  );
}

function boundsWidth(element: HTMLElement): number {
  return element.getBoundingClientRect().width;
}
