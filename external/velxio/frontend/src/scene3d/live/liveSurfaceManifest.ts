/**
 * liveSurfaceManifest — loads `/live-surfaces.json` (written by Wireup's
 * `pnpm export:live-surfaces`) and serves the per-part live-surface table.
 *
 * The file is DATA, deliberately in `public/` next to `/cad-catalog.json` and
 * `/components-metadata.json`: the same three files that describe every part
 * the canvas can place. Nothing in this module knows a part's name — it looks
 * one up.
 *
 * Intake rules, because a table this load-bearing must not fail silently:
 *
 *   • a fetch failure is NOT cached — it is retried (twice, then again on the
 *     next request after a cool-off), because a momentary 502 on a CDN used to
 *     disable live state for the rest of the session with no trace;
 *   • every part is validated before it is served: a surface with an unknown
 *     `kind` or no anchor is dropped, not passed to the renderer to throw;
 *   • the file's `version` is compared with the schema this build mirrors
 *     (`LIVE_SURFACE_SCHEMA_VERSION`): a mismatch is reported as a stale intake
 *     (the valid parts still load) instead of pretending to be current;
 *   • every outcome — ok, stale, invalid, missing — lands in the intake report,
 *     which the 3D HUD shows and the console logs once.
 *
 * A missing manifest is still not fatal: the 3D view then renders geometry
 * only, exactly as it did before this feature existed, which keeps a standalone
 * Velxio checkout working without Wireup.
 */

import {
  LIVE_SURFACE_SCHEMA_VERSION,
  SURFACE_KINDS,
  type LiveSurface,
  type LiveSurfaceManifest,
  type PartLiveSurfaces,
} from './surfaceTypes';
import { reportManifest } from './intakeReport';

let cache: LiveSurfaceManifest | null = null;
let pending: Promise<LiveSurfaceManifest> | null = null;
/** When the last attempt failed, so a later request can try again. */
let lastFailureAt = 0;
let attempts = 0;

const EMPTY: LiveSurfaceManifest = { version: 0, generatedAt: '', parts: {}, noLiveState: {} };
const RETRY_DELAYS_MS = [150, 900];
const RETRY_COOL_OFF_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One surface is usable only if the renderer can act on every field it reads. */
function surfaceValid(surface: unknown): surface is LiveSurface {
  if (typeof surface !== 'object' || surface === null) return false;
  const candidate = surface as Partial<LiveSurface>;
  if (typeof candidate.id !== 'string' || candidate.id === '') return false;
  if (typeof candidate.kind !== 'string' || !SURFACE_KINDS.includes(candidate.kind)) return false;
  if (typeof candidate.anchor !== 'object' || candidate.anchor === null) return false;
  return true;
}

/**
 * Validate the whole file and drop what cannot be rendered.
 *
 * Returns the usable manifest plus a problem sentence when something had to be
 * dropped — the caller decides how loud to be about it (the gate on the Wireup
 * side is what makes dropping impossible in a released pair of builds).
 */
export function validateManifest(raw: unknown, expectedVersion = LIVE_SURFACE_SCHEMA_VERSION): {
  manifest: LiveSurfaceManifest;
  dropped: number;
  problem?: string;
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { manifest: EMPTY, dropped: 0, problem: 'the file is not a JSON object' };
  }
  const file = raw as Partial<LiveSurfaceManifest>;
  if (typeof file.version !== 'number' || !file.parts || typeof file.parts !== 'object') {
    return { manifest: EMPTY, dropped: 0, problem: 'missing "version" or "parts"' };
  }

  const parts: Record<string, PartLiveSurfaces> = {};
  let dropped = 0;
  for (const [key, definition] of Object.entries(file.parts)) {
    if (typeof definition !== 'object' || definition === null) {
      dropped += 1;
      continue;
    }
    const surfaces = Array.isArray(definition.surfaces) ? definition.surfaces.filter(surfaceValid) : [];
    dropped += (definition.surfaces?.length ?? 0) - surfaces.length;
    // A part whose every surface was dropped is kept with none: the intake
    // report can then say WHICH part lost its live state.
    parts[key] = { ...definition, surfaces };
  }

  const manifest: LiveSurfaceManifest = {
    version: file.version,
    generatedAt: typeof file.generatedAt === 'string' ? file.generatedAt : '',
    parts,
    noLiveState: typeof file.noLiveState === 'object' && file.noLiveState !== null ? file.noLiveState : {},
  };

  const problems: string[] = [];
  if (file.version !== expectedVersion) {
    problems.push(`file is version ${file.version}, this build mirrors version ${expectedVersion}`);
  }
  if (dropped > 0) problems.push(`${dropped} unusable surface definition(s) were dropped`);
  return { manifest, dropped, ...(problems.length ? { problem: problems.join('; ') } : {}) };
}

/** Fetch the manifest once, retrying transient failures. Never throws. */
async function fetchManifest(): Promise<{ raw: unknown; failure?: 'missing' | 'invalid' }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    attempts += 1;
    try {
      const response = await fetch('/live-surfaces.json', { cache: 'no-store' });
      if (response.ok) return { raw: await response.json() };
      lastError = `HTTP ${response.status}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // A definitive "not there" — retrying will not change it.
        return { raw: null, failure: 'missing' };
      }
    } catch (error) {
      lastError = (error as Error).message;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await sleep(delay);
  }
  // Exhausted retries. The reason is kept for the caller's log line.
  return { raw: null, failure: 'missing', ...(lastError ? { error: lastError } : {}) } as { raw: unknown; failure: 'missing' };
}

/** A definitive shape failure vs a transport failure, reported differently. */
function report(manifest: LiveSurfaceManifest, source: 'ok' | 'stale' | 'invalid' | 'missing', problem?: string): void {
  reportManifest({
    source,
    version: manifest.version,
    expectedVersion: LIVE_SURFACE_SCHEMA_VERSION,
    parts: Object.keys(manifest.parts).length,
    noLiveState: Object.keys(manifest.noLiveState).length,
    attempts,
    ...(problem ? { problem } : {}),
  });
}

/**
 * Load (and cache) the manifest. Never throws; retries a failed fetch.
 *
 * A previously-failed load is retried by the next caller once the cool-off has
 * passed, so a page that started during a deploy heals itself.
 */
export function loadLiveSurfaces(): Promise<LiveSurfaceManifest> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  const cooled = Date.now() - lastFailureAt > RETRY_COOL_OFF_MS;
  if (lastFailureAt > 0 && !cooled) return Promise.resolve(EMPTY);

  pending = fetchManifest()
    .then(({ raw, failure }) => {
      if (failure || raw === null) {
        lastFailureAt = Date.now();
        report(EMPTY, 'missing', 'the file was not served by this build');
        return EMPTY;
      }
      const { manifest, problem } = validateManifest(raw);
      if (problem && Object.keys(manifest.parts).length === 0) {
        // Nothing usable: report it as invalid and let a later caller retry.
        lastFailureAt = Date.now();
        report(manifest, 'invalid', problem);
        return EMPTY;
      }
      cache = manifest;
      const stale = manifest.version !== LIVE_SURFACE_SCHEMA_VERSION;
      report(manifest, stale ? 'stale' : 'ok', problem);
      return manifest;
    })
    .catch((error: unknown) => {
      lastFailureAt = Date.now();
      report(EMPTY, 'invalid', (error as Error).message);
      return EMPTY;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Already-loaded manifest, or null (for imperative readers). */
export function cachedLiveSurfaces(): LiveSurfaceManifest | null {
  return cache;
}

/** The definition for a catalog key (metadataId), or null. */
export function liveSurfacesFor(metadataId: string): PartLiveSurfaces | null {
  if (!cache) return null;
  const direct = cache.parts[metadataId];
  if (direct) return direct;
  // A CAD bench part arrives as `cad-bench-<catalog key>`; the table is keyed
  // by the catalog key it names (the same key /cad-catalog.json uses).
  const bench = metadataId.startsWith('cad-bench-') ? cache.parts[metadataId.slice('cad-bench-'.length)] : undefined;
  return bench ?? null;
}

/** Explicitly-declared "this part has no live state" reason, or null. */
export function noLiveStateReason(metadataId: string): string | null {
  if (!cache) return null;
  const direct = cache.noLiveState[metadataId];
  if (direct) return direct;
  const bench = metadataId.startsWith('cad-bench-') ? cache.noLiveState[metadataId.slice('cad-bench-'.length)] : undefined;
  return bench ?? null;
}

/** Test seam: forget the loaded manifest and the attempt bookkeeping. */
export function resetLiveSurfaces(): void {
  cache = null;
  pending = null;
  lastFailureAt = 0;
  attempts = 0;
}
