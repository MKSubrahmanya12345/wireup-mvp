/**
 * cadParametric — builds a shaded THREE.Group straight from a CAD spec
 * (`CadComponentSpec`), so every catalog part gets a real 3D body in this
 * scene, not a fallback box.
 *
 * This is a direct port of the geometry-building half of Wireup's admin CAD
 * studio (`src/components/admin/CadPreviewCanvas.tsx`'s
 * `buildParametricAssembly` / `createFeatureAssembly` / `addGenericHeaders`).
 * The admin studio and this scene render the SAME geometry from the SAME
 * spec data — intentionally: the user asked for parts here to have the same
 * polish as the studio's preview, not a degraded stand-in. Only the
 * React/DOM/orbit-camera machinery around it was left behind, because this
 * scene already has its own (r3f's Canvas + drei's OrbitControls).
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CadComponentSpec, CadFeature, CadPinDefinition } from './cadTypes';

const CAD_BLUE = new THREE.Color('#0d4f96');

function asMaterials(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function materialForFeature(feature: CadFeature): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
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
    });
  }

  if (feature.type === 'heatsink' || /usb|crystal|shield|metal|screw/.test(name)) {
    return new THREE.MeshStandardMaterial({
      color: colour,
      metalness: 0.8,
      roughness: 0.24,
      envMapIntensity: 1.25,
    });
  }

  if (/jack|socket|header|chip|ic|regulator/.test(name)) {
    return new THREE.MeshPhysicalMaterial({
      color: colour,
      roughness: 0.4,
      metalness: 0.12,
      clearcoat: 0.2,
      clearcoatRoughness: 0.3,
    });
  }

  return new THREE.MeshStandardMaterial({
    color: colour,
    roughness: 0.48,
    metalness: 0.12,
    envMapIntensity: 0.8,
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
    context.fillText('VELXIO / CAD ASSEMBLY', 54, 108);
    context.font = '600 36px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillStyle = 'rgba(206, 230, 255, 0.9)';
    context.fillText(title.toUpperCase().slice(0, 40), 56, 174);
    context.fillStyle = 'rgba(206, 230, 255, 0.64)';
    context.font = '500 25px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('PARAMETRIC ASSEMBLY', 56, 211);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function createFeatureAssembly(feature: CadFeature): THREE.Group {
  const assembly = new THREE.Group();
  const [width, height, depth] = feature.dimensions;
  const material = materialForFeature(feature);
  const name = feature.name.toLowerCase();
  assembly.name = feature.name;
  assembly.position.set(...feature.position);
  // Identity of this feature, for the live-surface layer: generated GLBs carry
  // the same information as a material name (`Mat_<feature name>`), so tagging
  // here makes "find the feature called X" work the same for both pipelines.
  assembly.userData.cadFeature = { name: feature.name, type: feature.type };
  material.name = feature.name;

  if (feature.type === 'cylinder') {
    const radius = Math.max(width, 0.3);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.94, Math.max(height, 0.5), 32, 1, false), material);
    assembly.add(mesh);
  } else if (feature.type === 'led') {
    const diameter = Math.max(width, depth, 0.8);
    const radius = diameter / 2;
    const totalHeight = Math.max(height, radius * 1.7);
    const domeRadius = Math.min(radius, totalHeight * 0.45);
    const cylinderHeight = Math.max(totalHeight - domeRadius, totalHeight * 0.52);
    const bottomY = -totalHeight / 2;

    const epoxy = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.94, radius * 0.94, cylinderHeight, 36),
      material,
    );
    epoxy.position.y = bottomY + cylinderHeight / 2;

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(domeRadius, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2),
      material,
    );
    dome.position.y = bottomY + cylinderHeight;

    const leadFrame = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(radius * 0.9, 0.7), Math.max(cylinderHeight * 0.35, 1.1), 0.12),
      new THREE.MeshStandardMaterial({ color: '#f7d46a', roughness: 0.2, metalness: 0.65, transparent: true, opacity: 0.42 }),
    );
    leadFrame.position.y = bottomY + cylinderHeight * 0.36;
    assembly.add(epoxy, dome, leadFrame);
  } else if (feature.type === 'lens') {
    const radius = Math.max(width, depth, 0.8) / 2;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2),
      material,
    );
    dome.position.y = -Math.max(height, radius) / 2;
    assembly.add(dome);
  } else if (feature.type === 'screen') {
    const frame = new THREE.Mesh(
      roundedBox(Math.max(width, 1), Math.max(height, 0.7), Math.max(depth, 1), 0.35),
      new THREE.MeshPhysicalMaterial({ color: '#111827', roughness: 0.32, metalness: 0.15 }),
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
      new THREE.MeshPhysicalMaterial({ color: feature.color ?? '#181b22', roughness: 0.38, clearcoat: 0.18 }),
    );
    assembly.add(housing);
    const count = Math.max(2, Math.round(Math.max(width, depth) / 2.54));
    const longOnX = width >= depth;
    for (let index = 0; index < count; index += 1) {
      const opening = new THREE.Mesh(
        new THREE.CylinderGeometry(0.44, 0.44, Math.max(height * 0.08, 0.08), 12),
        new THREE.MeshBasicMaterial({ color: '#05070a' }),
      );
      const fraction = (index + 0.5) / count - 0.5;
      opening.position.set(longOnX ? fraction * width * 0.86 : 0, height * 0.52, longOnX ? 0 : fraction * depth * 0.86);
      assembly.add(opening);
    }
  } else if (feature.type === 'screw_terminal') {
    const terminal = new THREE.Mesh(roundedBox(Math.max(width, 1), Math.max(height, 0.8), Math.max(depth, 1), 0.38), material);
    const screw = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.min(width, depth) * 0.23, Math.min(width, depth) * 0.23, Math.max(height * 0.15, 0.12), 24),
      new THREE.MeshStandardMaterial({ color: '#b9c1cd', metalness: 0.9, roughness: 0.2 }),
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
      new THREE.MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.88, roughness: 0.2 }),
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
        new THREE.BoxGeometry(width >= depth ? finWidth * 0.46 : width * 0.74, Math.max(height * 0.8, 0.4), width >= depth ? depth * 0.78 : (depth / finCount) * 0.46),
        material,
      );
      const fraction = (index + 0.5) / finCount - 0.5;
      fin.position.set(width >= depth ? fraction * width * 0.84 : 0, height * 0.39, width >= depth ? 0 : fraction * depth * 0.84);
      assembly.add(fin);
    }
  } else {
    const boardComponent = new THREE.Mesh(roundedBox(Math.max(width, 0.5), Math.max(height, 0.35), Math.max(depth, 0.5), 0.32), material);
    assembly.add(boardComponent);

    if (/usb|crystal|shield/.test(name)) {
      const cap = new THREE.Mesh(
        roundedBox(Math.max(width * 0.88, 0.3), Math.max(height * 0.12, 0.08), Math.max(depth * 0.88, 0.3), 0.1),
        new THREE.MeshStandardMaterial({ color: '#d4d9e2', metalness: 0.88, roughness: 0.22 }),
      );
      cap.position.y = height * 0.55;
      assembly.add(cap);
    }
  }

  if (feature.rotation) {
    assembly.rotation.set(...(feature.rotation.map((degrees) => THREE.MathUtils.degToRad(degrees)) as [number, number, number]));
  }
  setShadowFlags(assembly);
  return assembly;
}

function directionVector(direction: CadPinDefinition['direction'] = 'up'): THREE.Vector3 {
  return new THREE.Vector3(
    direction === 'left' ? -1 : direction === 'right' ? 1 : 0,
    direction === 'down' ? -1 : direction === 'up' || !direction ? 1 : 0,
    direction === 'back' ? -1 : direction === 'front' ? 1 : 0,
  ).normalize();
}

function orientAlongDirection(object: THREE.Object3D, direction: THREE.Vector3): void {
  object.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()));
}

/**
 * Adds physical header/lead/pad geometry AND a named empty node per pin
 * (`anchor.name = pin.name`) — the same contract `models3d.ts`'s
 * `loadModel()` reads off a GLB via `group.traverse` + `o.name`. That's what
 * lets `resolvePinWorld()` treat a parametric assembly exactly like a loaded
 * GLB: wires attach to it the same way, with no scene-specific branching.
 */
function addGenericHeaders(root: THREE.Group, spec: CadComponentSpec): void {
  const pinStyle = spec.pinStyle ?? 'headers';
  if (pinStyle === 'none') return;

  const metal = new THREE.MeshStandardMaterial({ color: '#d8b560', metalness: 0.92, roughness: 0.18, envMapIntensity: 1.4 });
  const housing = new THREE.MeshPhysicalMaterial({ color: '#151820', roughness: 0.37, clearcoat: 0.18 });

  spec.pins.forEach((pin) => {
    const direction = directionVector(pin.direction);
    const pinLength = pinStyle === 'leads' ? 10.5 : 5.2;
    const pinRoot = new THREE.Vector3(pin.xMm, pin.yMm, pin.zMm);
    const anchorPosition = pinRoot.clone().addScaledVector(direction, pinLength * 0.88);

    if (pinStyle === 'pads') {
      const pad = new THREE.Mesh(roundedBox(1.65, 0.08, 1.65, 0.18), metal);
      pad.position.copy(pinRoot);
      const anchor = new THREE.Object3D();
      anchor.name = pin.name;
      anchor.position.copy(pinRoot);
      root.add(pad, anchor);
      return;
    }

    if (pinStyle === 'leads') {
      const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, pinLength, 16), metal);
      orientAlongDirection(lead, direction);
      lead.position.copy(pinRoot).addScaledVector(direction, pinLength * 0.5);

      const anchor = new THREE.Object3D();
      anchor.name = pin.name;
      anchor.position.copy(anchorPosition);
      root.add(lead, anchor);
      return;
    }

    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.66, pinLength, 0.66), metal);
    orientAlongDirection(shaft, direction);
    shaft.position.copy(pinRoot).addScaledVector(direction, pinLength * 0.42);

    const socket = new THREE.Mesh(roundedBox(2.18, 1.85, 2.18, 0.22), housing);
    orientAlongDirection(socket, direction);
    socket.position.copy(pinRoot).addScaledVector(direction, 0.25);

    const anchor = new THREE.Object3D();
    anchor.name = pin.name;
    anchor.position.copy(anchorPosition);
    root.add(socket, shaft, anchor);
  });
}

/** Build a shaded assembly for a spec. Root is centred over its own footprint
 *  on the XZ plane with the body resting on Y=0, matching a loaded GLB's
 *  centroid-centered convention closely enough for the bench layout. */
export function buildParametricAssembly(spec: CadComponentSpec): THREE.Group {
  const root = new THREE.Group();
  const { widthMm, lengthMm, heightMm } = spec.dimensions;
  root.name = `parametric:${spec.id}`;

  if (spec.bodyStyle !== 'none') {
    const pcbMaterial = new THREE.MeshPhysicalMaterial({
      color: spec.bodyColor ?? CAD_BLUE,
      roughness: 0.37,
      metalness: 0.16,
      clearcoat: 0.38,
      clearcoatRoughness: 0.34,
      envMapIntensity: 1.05,
    });
    const board = new THREE.Mesh(roundedBox(widthMm, Math.max(heightMm, 0.8), lengthMm, Math.min(1.45, heightMm * 0.55)), pcbMaterial);
    board.name = spec.bodyStyle === 'enclosure' ? 'Main housing' : 'PCB substrate';
    board.position.y = Math.max(heightMm, 0.8) / 2;
    root.add(board);

    if (spec.bodyStyle !== 'enclosure') {
      const core = new THREE.Mesh(
        roundedBox(widthMm * 0.99, Math.max(heightMm * 0.55, 0.32), lengthMm * 0.99, Math.min(0.7, heightMm * 0.24)),
        new THREE.MeshStandardMaterial({ color: '#0c2d2a', roughness: 0.72, metalness: 0.04 }),
      );
      core.position.y = Math.max(heightMm, 0.8) * 0.48;
      root.add(core);
    }

    const showMountingHoles = Math.min(widthMm, lengthMm) >= 12 && spec.bodyStyle !== 'enclosure';
    if (showMountingHoles) {
      const holeMaterial = new THREE.MeshStandardMaterial({ color: '#c59b43', metalness: 0.72, roughness: 0.25 });
      const holeInset = Math.min(3.7, Math.max(1.8, Math.min(widthMm, lengthMm) * 0.09));
      [
        [-widthMm / 2 + holeInset, -lengthMm / 2 + holeInset],
        [widthMm / 2 - holeInset, -lengthMm / 2 + holeInset],
        [-widthMm / 2 + holeInset, lengthMm / 2 - holeInset],
        [widthMm / 2 - holeInset, lengthMm / 2 - holeInset],
      ].forEach(([x, z]) => {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.min(1.5, holeInset * 0.38), 0.2, 10, 28), holeMaterial);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(x as number, Math.max(heightMm, 0.8) + 0.035, z as number);
        root.add(ring);
      });
    }

    const showSilkscreen = widthMm >= 14 && lengthMm >= 10 && spec.bodyStyle !== 'enclosure';
    if (showSilkscreen) {
      const silkscreen = new THREE.Mesh(
        new THREE.PlaneGeometry(widthMm * 0.7, Math.min(lengthMm * 0.18, widthMm * 0.19)),
        new THREE.MeshBasicMaterial({ map: createSilkscreenTexture(spec.name), transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }),
      );
      silkscreen.rotation.x = -Math.PI / 2;
      silkscreen.position.set(0, Math.max(heightMm, 0.8) + 0.045, lengthMm * 0.27);
      root.add(silkscreen);
    }
  }

  addGenericHeaders(root, spec);
  spec.features.forEach((feature) => root.add(createFeatureAssembly(feature)));
  setShadowFlags(root);
  return root;
}

export function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    asMaterials(child.material).forEach((material) => material.dispose());
  });
}
