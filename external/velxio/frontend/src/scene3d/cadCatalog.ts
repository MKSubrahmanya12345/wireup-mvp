/**
 * cadCatalog — fetches `/cad-catalog.json` (written by
 * `scripts/export-cad-catalog-to-velxio.ts` from Wireup's CAD studio specs)
 * and turns each entry into a cached, ready-to-place THREE.Group via
 * `buildParametricAssembly`.
 *
 * This is the sibling of `models3d.ts`'s GLB loader: same instance-key space
 * (board -> boardKind, part -> metadataId), same caching shape
 * (`LoadedModel`-compatible group + named pin nodes + bbox size), so
 * `Cad3DScene.tsx` can treat "loaded from a GLB" and "built parametrically"
 * as the same kind of thing and never fall back to an unshaded placeholder.
 */

import { useEffect, useState } from 'react';
import { Box3, Group, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { CadCatalogManifest, CadComponentSpec } from './cadTypes';
import { buildParametricAssembly } from './cadParametric';
import type { LoadedModel } from './models3d';
import { reportCatalog, reportModels } from './live/intakeReport';

let cache: CadCatalogManifest | null = null;
let pending: Promise<CadCatalogManifest> | null = null;

/** Load (and cache) the CAD catalog. Never throws: missing/bad JSON -> empty. */
export function loadCadCatalog(): Promise<CadCatalogManifest> {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetch('/cad-catalog.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { version: 0, generatedAt: '', entries: {} }))
      .catch(() => ({ version: 0, generatedAt: '', entries: {} }))
      .then((m) => {
        cache = m as CadCatalogManifest;
        const entries = Object.values(cache.entries ?? {});
        reportCatalog({
          entries: entries.length,
          withoutSpec: entries.filter((entry) => !entry?.spec?.features || entry.spec.pins === undefined).length,
        });
        return cache;
      });
  }
  return pending;
}

const groupCache = new Map<string, LoadedModel>();

/** Build (and cache) the parametric assembly for one catalog key. */
function buildAndIndex(key: string): LoadedModel | null {
  const cached = groupCache.get(key);
  if (cached) return cached;
  const entry = cache?.entries?.[key];
  if (!entry) return null;

  const assembly = buildParametricAssembly(entry.spec);
  assembly.updateMatrixWorld(true);

  const box = new Box3().setFromObject(assembly);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());

  // Match models3d.ts's convention: the returned group's origin is the
  // assembly's centroid, so a part's bench position lands on its middle the
  // same way a centered GLB does.
  const group = new Group();
  assembly.position.sub(center);
  group.add(assembly);
  group.updateMatrixWorld(true);

  const pins = new Map<string, Vector3>();
  group.traverse((o: Object3D) => {
    if (o.name) pins.set(o.name, o.getWorldPosition(new Vector3()));
  });

  // No manifest `def` of its own (this isn't a GLB), so a minimal
  // GLB-compatible CadModelDef is synthesised for the shared LoadedModel
  // shape — `layoutInstances()` and `resolvePinWorld()` only ever read
  // `def.bench`, which parametric parts don't need (auto-grid layout).
  const bounds = new Box3().setFromObject(group);
  const loaded: LoadedModel = { def: { file: '' }, group, pins, size, recenter: center.clone(), bounds };
  groupCache.set(key, loaded);
  return loaded;
}

/** The CAD spec for an instance key (live-surface anchors read it), or null. */
export function cadSpecFor(key: string): CadComponentSpec | null {
  return cache?.entries?.[key]?.spec ?? null;
}

/** React hook: the CAD spec for a key, once the catalog has loaded. */
export function useCadSpec(key: string): CadComponentSpec | null {
  const [spec, setSpec] = useState<CadComponentSpec | null>(() => cadSpecFor(key));
  useEffect(() => {
    let alive = true;
    void loadCadCatalog().then(() => {
      if (alive) setSpec(cadSpecFor(key));
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return spec;
}

/** Does the CAD catalog have an entry for this instance key? */
export function isParametricRegistered(key: string): boolean {
  return cache ? Boolean(cache.entries?.[key]) : false;
}

/** Build every requested key's parametric assembly (cache-backed). Keys with
 *  no catalog entry are simply absent from the result. */
export async function loadParametricForKeys(keys: string[]): Promise<Map<string, LoadedModel>> {
  await loadCadCatalog();
  const out = new Map<string, LoadedModel>();
  for (const key of keys) {
    const model = buildAndIndex(key);
    if (model) out.set(key, model);
  }
  // The parametric tier is the fallback for a key with no reviewed GLB: what it
  // could build is part of the intake picture (a key missing from BOTH tiers is
  // a part the bench cannot draw at all).
  reportModels({ parametric: [...out.keys()].sort() });
  return out;
}

/** React hook mirroring `useCadModels` for the parametric catalog. */
export function useParametricModels(keys: string[]): {
  models: Map<string, LoadedModel>;
  ready: boolean;
} {
  const [models, setModels] = useState<Map<string, LoadedModel>>(new Map());
  const [ready, setReady] = useState(false);
  const keySig = keys.join('|');

  useEffect(() => {
    let alive = true;
    setReady(false);
    loadParametricForKeys(keys).then((map) => {
      if (!alive) return;
      setModels(map);
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig]);

  return { models, ready };
}
