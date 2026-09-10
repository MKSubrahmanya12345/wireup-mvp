/**
 * OrientationGizmo — Blender/Onshape-style navigation cube, bottom-right.
 *
 * Click a face/edge/corner (GizmoViewcube's own behaviour, via drei's
 * GizmoHelper) snaps the main camera to that view. Dragging anywhere on the
 * cube orbits the camera exactly like dragging the main viewport — that part
 * is layered on top here with plain window pointer listeners (started on the
 * cube's pointerdown) so a drag that leaves the small gizmo hud still tracks
 * correctly, the same reason CadPreviewCanvas's own orbit handler in the
 * admin studio does the same thing.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { GizmoHelper, GizmoViewcube } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

interface MinimalOrbitControls {
  object: THREE.Camera;
  target: THREE.Vector3;
  update: () => void;
}

function isOrbitLike(controls: unknown): controls is MinimalOrbitControls {
  return !!controls && typeof controls === 'object' && 'target' in controls && 'object' in controls && 'update' in controls;
}

export function OrientationGizmo() {
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const controls = useThree((s) => s.controls);
  // Kept in a ref (not a useCallback dependency chain) so the two window
  // listeners always call the LATEST closures without needing to be torn
  // down and re-added mid-drag when `controls` changes identity.
  const controlsRef = useRef(controls);
  useLayoutEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const current = controlsRef.current;
      if (!drag || !isOrbitLike(current)) return;

      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;

      const target = current.target;
      const cam = current.object.position;
      const offset = new THREE.Vector3().subVectors(cam, target);
      const radius = offset.length() || 1;
      let azimuth = Math.atan2(offset.x, offset.z);
      let polar = Math.acos(Math.min(1, Math.max(-1, offset.y / radius)));

      azimuth -= dx * 0.012;
      polar = Math.min(Math.PI - 0.05, Math.max(0.05, polar - dy * 0.012));

      const sinPolar = Math.sin(polar);
      cam.set(
        target.x + radius * sinPolar * Math.sin(azimuth),
        target.y + radius * Math.cos(polar),
        target.z + radius * sinPolar * Math.cos(azimuth),
      );
      current.update();
    };
    const handleUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, []);

  return (
    // Margin-Y is taller than margin-X: the 2D canvas' floating zoom toolbar
    // (`.zoom-controls--floating`, z-index 60) stays visible ON TOP of this
    // WebGL 3D overlay even while the 3D view is open, pinned to the same
    // bottom-right corner — extra headroom keeps the cube from sitting under
    // it instead of stacking cleanly above.
    <GizmoHelper alignment="bottom-right" margin={[70, 100]}>
      <group
        onPointerDown={(e: { nativeEvent: PointerEvent }) => {
          dragRef.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
        }}
      >
        <GizmoViewcube
          color="#20242c"
          hoverColor="#3f7ee8"
          textColor="#d7dde6"
          strokeColor="#454c58"
          faces={['Right', 'Left', 'Top', 'Bottom', 'Front', 'Back']}
        />
      </group>
    </GizmoHelper>
  );
}
