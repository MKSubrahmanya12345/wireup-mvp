import { useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, OrbitControls, Text } from '@react-three/drei';
import { CatmullRomCurve3, TubeGeometry, Vector3 } from 'three';
import type { Group as ThreeGroup } from 'three';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { usePartRenderStore } from '../store/usePartRenderStore';
import { useCadModels, resolvePinWorld, type LoadedModel } from './models3d';

/**
 * Cad3DScene — the new CAD-driven 3D view (Option A: strictly GLB-only).
 *
 * Renders ONLY parts that have a registered GLB in /models3d/manifest.json.
 * Anything without a model is omitted (no placeholder slab, no primitive
 * stand-in). Wires are drawn only between two registered parts, resolved by
 * pin NAME (getObjectByName), never from the 2D store's pixel x/y.
 *
 * Animated values (servo horn angle, LED emissive) are read imperatively from
 * usePartRenderStore inside useFrame — never reactively, so a 60 Hz write
 * does not re-render this scene.
 */

interface InstancePlace {
  id: string;
  key: string;
  pos: Vector3;
  rotY: number;
  scale: number;
}

function layoutInstances(
  instances: { id: string; key: string }[],
  models: Map<string, LoadedModel>,
): { places: Map<string, InstancePlace>; order: string[] } {
  const places = new Map<string, InstancePlace>();
  const order: string[] = [];
  let cursor = 0;
  for (const inst of instances) {
    const model = models.get(inst.key);
    if (!model) continue; // Option A: no model -> omit
    const size = model.size;
    const spacing = Math.max(size.x, size.z, 120) + 60; // mm between parts
    // Auto-grid along X, then apply the manifest's bench position as an offset
    // so Blender-authored placement is honored without risk of overlap.
    const off = model.def.bench?.position ?? [0, 0, 0];
    const place: InstancePlace = {
      id: inst.id,
      key: inst.key,
      pos: new Vector3(cursor + spacing / 2 + off[0], off[1], off[2]),
      rotY: model.def.bench?.rotation?.[1] ?? 0,
      scale: model.def.bench?.scale ?? 1,
    };
    places.set(inst.id, place);
    order.push(inst.id);
    cursor += spacing;
  }
  return { places, order };
}

/** Find the rotating servo horn node in a model (name is not in the pin
 *  contract, so try a few conventional names). Returns null if absent. */
function findServoHorn(scene: ThreeGroup): { rotation?: { y: number } } | null {
  const names = ['servo_horn', 'servoHorn', 'Servo_Horn', 'SERVO_HORN', 'horn', 'Horn', 'arm', 'Arm'];
  for (const n of names) {
    const o = scene.getObjectByName(n) as unknown as { rotation?: { y: number } } | null;
    if (o && o.rotation) return o;
  }
  return null;
}

/** Render one model instance on the bench, animating its live parts. */
function PartMesh({ place, model }: { place: InstancePlace; model: LoadedModel }) {
  // Independent clone per instance so multiple same-kind parts don't share.
  const scene = useMemo(() => model.group.clone(), [model]);
  const horn = useMemo(() => findServoHorn(scene), [scene]);

  // Drive the servo horn rotation from the store value each frame (imperative).
  useFrame(() => {
    const v = usePartRenderStore.getState().values[place.id];
    if (horn && horn.rotation && v?.angle !== undefined) {
      horn.rotation.y = (v.angle * Math.PI) / 180;
    }
  }, 0);

  return (
    <group
      position={[place.pos.x, place.pos.y, place.pos.z]}
      rotation={[0, place.rotY, 0]}
      scale={place.scale}
    >
      <primitive object={scene} />
    </group>
  );
}

/** A wire as a physical tube between two resolved pin world positions. */
function WireTube({ a, b, color }: { a: Vector3; b: Vector3; color: string }) {
  const geom = useMemo(() => {
    if (a.distanceToSquared(b) < 1e-6) return null;
    const curve = new CatmullRomCurve3([a.clone(), b.clone()], false, 'catmullrom', 0.5);
    return new TubeGeometry(curve, 8, 1.1, 8, false);
  }, [a, b]);

  if (!geom) return null;
  return (
    <mesh geometry={geom}>
      <meshStandardMaterial color={color} roughness={0.4} metalness={0.3} />
    </mesh>
  );
}

function Scene() {
  const boards = useSimulatorStore((s) => s.boards);
  const components = useSimulatorStore((s) => s.components);
  const wires = useSimulatorStore((s) => s.wires);

  const instances = useMemo(
    () => [
      ...boards.map((b) => ({ id: b.id, key: b.boardKind })),
      ...components.map((c) => ({ id: c.id, key: c.metadataId })),
    ],
    [boards, components],
  );
  const keys = useMemo(() => [...new Set(instances.map((i) => i.key))], [instances]);
  const { models, ready } = useCadModels(keys);

  const { places, order } = useMemo(
    () => layoutInstances(instances, models),
    [instances, models],
  );

  const visibleInstances = useMemo(
    () =>
      order
        .map((id) => {
          const place = places.get(id)!;
          const model = models.get(place.key)!;
          return { id, place, model };
        })
        .filter((x) => x.model != null),
    [order, places, models],
  );

  const visibleWires = useMemo(() => {
    const out: { id: string; a: Vector3; b: Vector3; color: string }[] = [];
    for (const w of wires) {
      if (w.bb) continue;
      const a = endpointsToWorld(w.start.componentId, w.start.pinName, places, models);
      const b = endpointsToWorld(w.end.componentId, w.end.pinName, places, models);
      if (a && b) out.push({ id: w.id, a, b, color: w.color });
    }
    return out;
  }, [wires, places, models]);

  const isEmpty = ready && visibleInstances.length === 0;

  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[300, 900, 200]} intensity={1.4} />
      <directionalLight position={[-400, 500, -400]} intensity={0.4} color="#8fb6ff" />

      <Grid
        position={[0, -0.05, 0]}
        infiniteGrid
        cellSize={50}
        sectionSize={250}
        cellThickness={0.6}
        sectionThickness={1.1}
        cellColor="#2a2f38"
        sectionColor="#3a4552"
        fadeDistance={12000}
        fadeStrength={1.5}
      />

      {visibleInstances.map(({ id, place, model }) => (
        <PartMesh key={id} place={place} model={model} />
      ))}

      {visibleWires.map((w) => (
        <WireTube key={w.id} a={w.a} b={w.b} color={w.color} />
      ))}

      {isEmpty ? (
        <Text
          position={[0, 40, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={30}
          color="#5b6673"
          anchorX="center"
          anchorY="middle"
        >
          No 3D models registered yet — add GLBs under /models3d/
        </Text>
      ) : null}

      <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
    </>
  );
}

/** Resolve an endpoint (component id + pin name) to a world position, if any. */
function endpointsToWorld(
  componentId: string,
  pinName: string,
  places: Map<string, InstancePlace>,
  models: Map<string, LoadedModel>,
): Vector3 | null {
  const place = places.get(componentId);
  if (!place) return null;
  const model = models.get(place.key);
  if (!model) return null;
  return resolvePinWorld(model, pinName, place.pos, place.rotY, place.scale);
}

export default function Cad3DScene() {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [300, 600, 500], fov: 45, near: 0.5, far: 100000 }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#101318']} />
      <Scene />
    </Canvas>
  );
}
