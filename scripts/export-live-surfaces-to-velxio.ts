/**
 * Export the live-surface table into Velxio's public assets.
 *
 *   pnpm export:live-surfaces
 *
 * Writes `external/velxio/frontend/public/live-surfaces.json`:
 *
 *   { version, generatedAt, parts: { <catalog key>: { tag, name, surfaces } },
 *     noLiveState: { <catalog key>: "why there is nothing to show" } }
 *
 * This is the DATA half of "the 3D view shows what the 2D view shows": the
 * authored table lives in `src/modules/simulation/live-surfaces.ts`, the
 * evidence it is checked against is read from the vendored simulator, and
 * `pnpm verify:3d-live` re-runs this build and diffs it against the file on
 * disk — so a hand-edited table (or a renamed property in Velxio) fails the
 * gate instead of producing a display that is silently dark.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { LIVE_SURFACES_VERSION, buildLiveSurfaces } from '../src/modules/simulation/live-surfaces';
import { collectLiveSurfaceSources } from './live-surface-sources';

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function main(): number {
  const repoRoot = process.cwd();
  const sources = collectLiveSurfaceSources(repoRoot);
  const payload = buildLiveSurfaces(sources);

  const manifest = {
    version: LIVE_SURFACES_VERSION,
    generatedAt: new Date().toISOString(),
    ...payload,
  };

  fs.mkdirSync(path.dirname(sources.outputPath), { recursive: true });
  fs.writeFileSync(sources.outputPath, `${JSON.stringify(manifest, null, 1)}\n`, 'utf-8');

  const surfaceCount = Object.values(payload.parts).reduce((sum, part) => sum + part.surfaces.length, 0);
  const kinds = new Map<string, number>();
  for (const part of Object.values(payload.parts)) {
    for (const surface of part.surfaces) kinds.set(surface.kind, (kinds.get(surface.kind) ?? 0) + 1);
  }

  heading('wireup · live surfaces → Velxio');
  console.log(`CAD keys in catalog : ${sources.cad.size}`);
  console.log(`parts with surfaces : ${Object.keys(payload.parts).length} (${surfaceCount} surfaces)`);
  console.log(`declared inert      : ${Object.keys(payload.noLiveState).length}`);
  console.log(`registered, no 3D   : ${[...sources.registeredIds].filter((id) => !sources.cad.has(id)).length} (registered in Velxio but not a CAD key the bench renders)`);
  console.log(`surface kinds       : ${[...kinds.entries()].map(([kind, n]) => `${kind}×${n}`).join(', ')}`);
  console.log(`written to          : ${path.relative(repoRoot, sources.outputPath)}`);
  return 0;
}

process.exit(main());
