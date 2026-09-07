import { useEffect, useState } from 'react';
import { Box3, Group, Vector3 } from 'three';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * models3d — the CAD-asset side of the new 3D view.
 *
 * Only parts with a REGISTERED GLB render in 3D (Option A). Registration lives
 * in `/models3d/manifest.json`; the Blender side produces the .glb files and
 * the manifest. The key for a BOARD is its `boardKind`, the key for a
 * COMPONENT is its `metadataId` (the same ids the 2D store uses).
 *
 * The manifest also carries the pin names the Blender agent must have exported
 * as named nodes/empties (verified to round-trip byte-for-byte), and an
 * optional bench transform. Wires are resolved by pin NAME — never from the
 * 2D store's pixel x/y.
 */

export interface CadModelDef {
  /** Path under /models3d/ (e.g. "arduino-uno/arduino-uno.glb"). */
  file: string;
  /** Optional explicit pin node names to index (for tooling/introspection). */
  pinNodes?: string[];
  /** Optional placement on the bench (world mm). Absent = auto-layout. */
  bench?: {
    position: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
  };
  /** Optional materials hints. baseColorMap path under /models3d/textures/. */
  materials?: {
    baseColorMap?: string;
    baseColor?: [number, number, number];
  };
}

export interface CadManifest {
  version: number;
  models: Record<string, CadModelDef>;
}

export interface LoadedModel {
  def: CadModelDef;
  /** Cloned scene group with identity transform (root at origin). */
  group: Group;
  /** pinName -> local position relative to the group root. */
  pins: Map<string, Vector3>;
  /** Natural size in world units (mm). */
  size: Vector3;
}

let cache: CadManifest | null = null;
let pending: Promise<CadManifest> | null = null;

/** Load (and cache) the manifest. Never throws: a missing manifest yields empty. */
export function loadCadManifest(): Promise<CadManifest> {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetch('/models3d/manifest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { version: 0, models: {} }))
      .catch(() => ({ version: 0, models: {} }))
      .then((m) => {
        cache = m as CadManifest;
        return cache;
      });
  }
  return pending;
}

export function getModelDef(key: string): CadModelDef | undefined {
  return cache?.models?.[key];
}

const gltfLoader = new GLTFLoader();
const groupCache = new Map<string, LoadedModel>();

/** Load one model's glTF, compute pin local positions and bbox, cache it. */
async function loadModel(key: string, def: CadModelDef): Promise<LoadedModel | null> {
  const cached = groupCache.get(key);
  if (cached) return cached;
  try {
    // manifest `file` is a path UNDER /models3d/ (see CadModelDef), so resolve
    // it against that folder — not against the page URL.
    const modelUrl = def.file.startsWith('/') ? def.file : `/models3d/${def.file}`;
    const gltf = await gltfLoader.loadAsync(modelUrl);
    const root = gltf.scene;
    // Normalize: bake transforms down and center the group at the origin.
    root.updateMatrixWorld(true);

    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());

    const group = new Group();
    root.position.sub(center); // center the model so the group origin = centroid
    group.add(root);
    group.updateMatrixWorld(true);

    // Read pin local positions from named nodes/empties.
    const pins = new Map<string, Vector3>();
    group.traverse((o: Object3D) => {
      if (o.name) {
        const p = o.getWorldPosition(new Vector3());
        pins.set(o.name, p.clone());
      }
    });

    const loaded: LoadedModel = { def, group: group.clone(), pins, size };
    groupCache.set(key, loaded);
    return loaded;
  } catch (err) {
    // Unregistered / missing / bad GLB → treated as "no 3D model" (Option A).
    // eslint-disable-next-line no-console
    console.warn(`[models3d] could not load ${def.file} (${key}):`, err);
    return null;
  }
}

/** Given a store component/board key, does a registered model exist? */
export function isModelRegistered(key: string): boolean {
  return cache ? getModelDef(key) !== undefined : false;
}

/**
 * Load all models referenced by a set of keys. Returns a fresh snapshot each
 * call; keys with no manifest entry or a failing load are simply absent.
 */
export async function loadModelsForKeys(keys: string[]): Promise<Map<string, LoadedModel>> {
  await loadCadManifest();
  const out = new Map<string, LoadedModel>();
  for (const key of keys) {
    const def = getModelDef(key);
    if (!def) continue;
    const model = await loadModel(key, def);
    if (model) out.set(key, model);
  }
  return out;
}

/**
 * React hook: load every model for the given keys, re-running when the set
 * changes. Keys that have no model are silently absent from the result.
 * `ready` flips true after the first load pass (even if it produced nothing).
 */
export function useCadModels(keys: string[]): {
  models: Map<string, LoadedModel>;
  ready: boolean;
  keys: string[];
} {
  const [models, setModels] = useState<Map<string, LoadedModel>>(new Map());
  const [ready, setReady] = useState(false);
  const keySig = keys.join('|');

  useEffect(() => {
    let alive = true;
    setReady(false);
    loadModelsForKeys(keys).then((map) => {
      if (!alive) return;
      setModels(map);
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig]);

  return { models, ready, keys };
}

/**
 * Candidate names to try for a wire's pinName, because the runtime exposes a
 * board's pins via the web component's `pinInfo[].name` and different parts use
 * different conventions (Arduino Uno supports BOTH `D0` and `0` etc.). We try
 * the exact name first, then common aliases, so a name mismatch never silently
 * drops a wire.
 */
function pinCandidates(pinName: string): string[] {
  const out: string[] = [pinName];
  const seen = new Set(out);
  const push = (n: string) => {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  // Digital aliases: '13' <-> 'D13', 'D0' <-> '0'.
  if (/^\d+$/.test(pinName)) push(`D${pinName}`);
  else if (/^D\d+$/i.test(pinName)) push(pinName.slice(1));
  // 3.3V / 3V aliases.
  if (pinName === '3V3') push('3.3V');
  else if (pinName === '3.3V') push('3V3');
  else if (pinName === '3V') {
    push('3V3');
    push('3.3V');
  }
  // Some exports drop the dot in GND.N.
  if (/^GND\.\d+$/.test(pinName)) push(pinName.replace('.', ''));
  return out;
}

/** Resolve a wire endpoint's world position on the bench. */
export function resolvePinWorld(
  model: LoadedModel,
  pinName: string,
  benchPos: Vector3,
  benchRotY = 0,
  benchScale = 1,
): Vector3 | null {
  let local: Vector3 | null = null;
  for (const cand of pinCandidates(pinName)) {
    const p = model.pins.get(cand);
    if (p) {
      local = p;
      break;
    }
  }
  if (!local) return null;
  const out = local.clone().multiplyScalar(benchScale);
  if (benchRotY !== 0) {
    // Rotate about Y: (x,z) -> (x*cos+z*sin, -x*sin+z*cos) (three's Y-up).
    out.set(
      out.x * Math.cos(benchRotY) + out.z * Math.sin(benchRotY),
      out.y,
      -out.x * Math.sin(benchRotY) + out.z * Math.cos(benchRotY),
    );
  }
  out.add(benchPos);
  return out;
}
