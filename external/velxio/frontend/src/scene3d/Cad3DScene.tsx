import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, OrbitControls, Text, TransformControls } from '@react-three/drei';
import { CatmullRomCurve3, TubeGeometry, Vector3 } from 'three';
import type { Group as ThreeGroup } from 'three';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { usePartRenderStore } from '../store/usePartRenderStore';
import { useCadModels, resolvePinWorld, type LoadedModel } from './models3d';
import { useParametricModels } from './cadCatalog';
import { OrientationGizmo } from './OrientationGizmo';
import { layoutInstances, type BenchInstance, type InstancePlace } from './placement';

/**
 * Cad3DScene — the CAD-driven 3D view.
 *
 * Every part in the catalog gets a real shaded body: a reviewed GLB when one
 * is registered in /models3d/manifest.json (Arduino Uno, servo, DHT22,
 * HC-SR04, plus the generated per-catalog-part models — see Wireup's
 * `pnpm export:cad-models`), and otherwise the SAME parametric assembly the
 * admin CAD studio previews, built live from `/cad-catalog.json` (see
 * cadCatalog.ts / cadParametric.ts, sourced from
 * `scripts/export-cad-catalog-to-velxio.ts`). Nothing renders as a degraded
 * placeholder box — a part with no reviewed asset still gets full-quality
 * shaded geometry, just not manufacturer-exact geometry. Wires are drawn only
 * between two resolvable parts, resolved by pin NAME (getObjectByName), never
 * from the 2D store's pixel x/y.
 *
 * That includes CAD-bench parts (a pump, an L298N, an HC-05 …): catalog parts
 * the simulator has no element for are still placed in 3D, because they are
 * physically on the bench whether or not the emulator can solve them. Their
 * wires to the board are drawn from the same pin anchors as everything else.
 *
 * Placement (bench anchor, rows, parts resting on the grid) lives in
 * `./placement` and is unit-tested independently of this scene.
 *
 * Animated values (servo horn angle, LED emissive) are read imperatively from
 * usePartRenderStore inside useFrame — never reactively, so a 60 Hz write
 * does not re-render this scene.
 *
 * Double-click a part to attach a Blender-style move gizmo (TransformControls,
 * translate mode). Releasing the drag writes the new mm position into that
 * component's `properties.x3d/y3d/z3d` (see `commitPosition` below) — the
 * SAME properties bag `buildVlxPayload` already serializes verbatim, so
 * Wireup's existing "pull canvas → diagram.json" sync
 * (`src/modules/simulation/vlx-sync.ts`) carries the 3D position into the
 * project's diagram.json with no protocol changes: it already merges
 * `component.properties` into `simulator.attrs` for every managed part.
 */

/**
 * Bench placement lives in `./placement` (pure, three-only, unit-tested).
 * Re-exported here because this module was its original home and the
 * existing scene test imports it from this path.
 */
export { layoutInstances, numberProp, BENCH_GAP_MM, BENCH_ROW_SPAN_MM } from './placement';
export type { BenchInstance, InstancePlace } from './placement';

/**
 * CAD-bench parts — catalog parts the simulator has NO element for (a pump,
 * a solenoid, an HC-05, an L298N …).
 *
 * Wireup still carries them onto the canvas, because omitting them from the
 * emitted project was the reason a design with a pump looked like a design
 * with nothing attached. They arrive with a `cad-bench-<key>` metadataId
 * (see the exporter in Wireup's `src/modules/simulation/velxio-project.ts`)
 * and the generic `<velxio-cad-bench-part>` element renders them from
 * `/cad-catalog.json`; the real key for the 3D asset is the part after the
 * prefix.
 *
 * Honest by construction: they are inert (no PartSimulationRegistry entry, no
 * netlist mapper) — a mechanical stand-in that holds the right place on the
 * bench and draws its wires, never a lookalike pretending to be a sensor.
 */
const CAD_BENCH_PREFIX = 'cad-bench-';

/** The `/cad-catalog.json` key behind a `cad-bench-<key>` metadataId. */
export function cadBenchKey(metadataId: string): string | null {
  return metadataId.startsWith(CAD_BENCH_PREFIX)
    ? metadataId.slice(CAD_BENCH_PREFIX.length)
    : null;
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
function PartMesh({
  id,
  place,
  model,
  movable,
  selected,
  onSelect,
  registerRef,
}: {
  id: string;
  place: InstancePlace;
  model: LoadedModel;
  movable: boolean;
  selected: boolean;
  onSelect: (id: string | null) => void;
  registerRef: (id: string, group: ThreeGroup | null) => void;
}) {
  // Independent clone per instance so multiple same-kind parts don't share.
  const scene = useMemo(() => model.group.clone(), [model]);
  const horn = useMemo(() => findServoHorn(scene), [scene]);
  const groupRef = useRef<ThreeGroup>(null);

  // Drive the servo horn rotation from the store value each frame (imperative).
  useFrame(() => {
    const v = usePartRenderStore.getState().values[id];
    if (horn && horn.rotation && v?.angle !== undefined) {
      horn.rotation.y = (v.angle * Math.PI) / 180;
    }
  }, 0);

  return (
    <group
      ref={(g) => {
        groupRef.current = g;
        registerRef(id, g);
      }}
      position={[place.pos.x, place.pos.y, place.pos.z]}
      rotation={[0, place.rotY, 0]}
      scale={place.scale}
      onDoubleClick={(e) => {
        if (!movable) return;
        e.stopPropagation();
        onSelect(selected ? null : id);
      }}
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

function Scene({
  selectedId,
  setSelectedId,
}: {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  const boards = useSimulatorStore((s) => s.boards);
  const components = useSimulatorStore((s) => s.components);
  const wires = useSimulatorStore((s) => s.wires);
  const pushCommand = useSimulatorStore((s) => s.pushCommand);

  const instances = useMemo<BenchInstance[]>(
    () => [
      ...boards.map((b) => ({
        id: b.id,
        key: b.boardKind,
        kind: 'board' as const,
        properties: undefined as Record<string, unknown> | undefined,
      })),
      ...components.map((c) => {
        // A CAD-bench part keys its 3D asset by the metadataId WITHOUT the
        // prefix (`cad-bench-l298n-motor-driver` -> `l298n-motor-driver`),
        // which is the same key `/cad-catalog.json` is indexed by.
        const cadKey = cadBenchKey(c.metadataId);
        return {
          id: c.id,
          key: cadKey ?? c.metadataId,
          kind: 'part' as const,
          properties: c.properties,
        };
      }),
    ],
    [boards, components],
  );
  const keys = useMemo(() => [...new Set(instances.map((i) => i.key))], [instances]);
  const { models: glbModels, ready: glbReady } = useCadModels(keys);
  const { models: parametricModels, ready: parametricReady } = useParametricModels(keys);

  // Reviewed GLBs win where both exist; every other catalog part falls
  // through to the parametric assembly built from /cad-catalog.json — never
  // to nothing.
  const models = useMemo(() => {
    const merged = new Map<string, LoadedModel>(parametricModels);
    for (const [key, model] of glbModels) merged.set(key, model);
    return merged;
  }, [glbModels, parametricModels]);
  const ready = glbReady && parametricReady;

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

  const componentIds = useMemo(() => new Set(components.map((c) => c.id)), [components]);

  const groupRefs = useRef(new Map<string, ThreeGroup>());
  // `selectedGroup` (the TransformControls target) is kept in real React
  // state rather than read from `groupRefs.current` during render — reading a
  // ref's `.current` in the render body is unsafe. Instead, whenever a group
  // mounts/unmounts OR the selection changes, this effect below re-derives it.
  const [selectedGroup, setSelectedGroup] = useState<ThreeGroup | null>(null);
  const registerRef = useCallback(
    (id: string, group: ThreeGroup | null) => {
      if (group) groupRefs.current.set(id, group);
      else groupRefs.current.delete(id);
      if (id === selectedId) setSelectedGroup(group);
    },
    [selectedId],
  );

  useEffect(() => {
    setSelectedGroup(selectedId ? groupRefs.current.get(selectedId) ?? null : null);
  }, [selectedId]);

  const commitPosition = useCallback(
    (id: string) => {
      const group = groupRefs.current.get(id);
      const component = components.find((c) => c.id === id);
      if (!group || !component) return;
      const prevProperties = component.properties;
      const nextProperties = {
        ...component.properties,
        x3d: Number(group.position.x.toFixed(2)),
        y3d: Number(group.position.y.toFixed(2)),
        z3d: Number(group.position.z.toFixed(2)),
      };
      // Undo-stack recorded (not a raw updateComponent) so a 3D drag behaves
      // like every other canvas edit — Ctrl+Z reverts it, and the change
      // shows up the same way a 2D move does. `useSimulatorStore.setComponents`
      // already serializes `properties` verbatim into buildVlxPayload(), so
      // this needs no new plumbing to reach a pulled .vlx / diagram.json sync.
      pushCommand({
        description: 'Move part (3D)',
        execute: () =>
          useSimulatorStore.setState((s) => ({
            components: s.components.map((c) => (c.id === id ? { ...c, properties: nextProperties } : c)),
          })),
        undo: () =>
          useSimulatorStore.setState((s) => ({
            components: s.components.map((c) => (c.id === id ? { ...c, properties: prevProperties } : c)),
          })),
      });
    },
    [components, pushCommand],
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
        <PartMesh
          key={id}
          id={id}
          place={place}
          model={model}
          movable={componentIds.has(id)}
          selected={selectedId === id}
          onSelect={setSelectedId}
          registerRef={registerRef}
        />
      ))}

      {visibleWires.map((w) => (
        <WireTube key={w.id} a={w.a} b={w.b} color={w.color} />
      ))}

      {selectedGroup ? (
        <TransformControls
          object={selectedGroup}
          mode="translate"
          onMouseUp={() => selectedId && commitPosition(selectedId)}
        />
      ) : null}

      {isEmpty ? (
        <Text
          position={[0, 40, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={30}
          color="#5b6673"
          anchorX="center"
          anchorY="middle"
        >
          No 3D bodies available — register GLBs under /models3d/ or export the
          CAD catalog (pnpm export:cad-catalog in Wireup)
        </Text>
      ) : null}

      <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
      <OrientationGizmo />
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [300, 600, 500], fov: 45, near: 0.5, far: 100000 }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      style={{ width: '100%', height: '100%' }}
      onPointerMissed={() => setSelectedId(null)}
    >
      <color attach="background" args={['#101318']} />
      <Scene selectedId={selectedId} setSelectedId={setSelectedId} />
    </Canvas>
  );
}
