/**
 * Export the CAD studio's spec-per-catalog-part into Velxio's own public
 * assets so its embedded 3D view can render EVERY catalog part — not just the
 * four parts with a reviewed GLB in models3d/manifest.json.
 *
 *   pnpm export:cad-catalog
 *
 * `specForCatalogComponent` already gives every catalog part a spec (reviewed
 * GLB reference / hand-authored preset / honestly-derived-from-registry), the
 * same three-tier system the admin CAD studio previews. This script is the
 * only thing that turns that into something the vendored Velxio app can
 * fetch at runtime: a flat JSON manifest keyed the same way Velxio already
 * keys its models (board -> `boardKind`, part -> `metadataId`), so the 3D
 * scene's existing instance-key lookup keeps working unchanged.
 *
 * Nothing here writes GLBs — Velxio's 3D view builds the same polished
 * parametric geometry the admin studio previews (ported into
 * `frontend/src/scene3d/cadParametric.ts`) directly from this spec data, so a
 * part with no reviewed asset still renders at full quality instead of a
 * degraded "fallback" tier. The reviewed GLBs already in models3d/ continue
 * to take precedence where they exist (currently just arduino-uno).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { listLinkedSpecs } from '../cad-helper';
import { SEED_COMPONENTS } from '../src/modules/components/catalog';
import {
  BOARD_KIND_BY_CATALOG_ID,
  BOARD_KIND_BY_WOKWI_TYPE,
  METADATA_BY_WOKWI_TYPE,
} from '../src/modules/simulation/velxio-project';

const OUTPUT_PATH = path.resolve(
  __dirname,
  '../external/velxio/frontend/public/cad-catalog.json',
);

function velxioKeyFor(componentId: string): { key: string; kind: 'board' | 'part' } | null {
  const component = SEED_COMPONENTS.find((c) => c.id === componentId);
  if (!component) return null;
  const wokwiPart = component.simulator?.part;
  if (component.category === 'microcontroller') {
    const key = (wokwiPart ? BOARD_KIND_BY_WOKWI_TYPE[wokwiPart] : undefined) ?? BOARD_KIND_BY_CATALOG_ID[component.id];
    return key ? { key, kind: 'board' } : null;
  }
  if (!wokwiPart || component.simulator?.supported === false) return null;
  const key = METADATA_BY_WOKWI_TYPE[wokwiPart];
  return key ? { key, kind: 'part' } : null;
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function main(): void {
  const linked = listLinkedSpecs();
  const entries: Record<string, unknown> = {};
  let boards = 0;
  let parts = 0;
  const skipped: string[] = [];

  for (const { spec, tier } of linked) {
    const resolved = velxioKeyFor(spec.id);
    if (!resolved) {
      skipped.push(spec.id);
      continue;
    }
    const { key, kind } = resolved;
    // A shared Velxio key (e.g. several servo catalog ids all map to the
    // wokwi-servo element) keeps the first spec seen — `listLinkedSpecs`
    // walks the catalog in a stable order, and Velxio only needs one
    // geometry per rendered element.
    if (entries[key]) continue;
    entries[key] = { catalogId: spec.id, kind, tier, spec };
    if (kind === 'board') boards += 1;
    else parts += 1;
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  heading('wireup · CAD catalog -> Velxio');
  console.log(`catalog components : ${SEED_COMPONENTS.length}`);
  console.log(`exported boards    : ${boards}`);
  console.log(`exported parts     : ${parts}`);
  console.log(`no simulator link  : ${skipped.length}${skipped.length ? ` (${skipped.join(', ')})` : ''}`);
  console.log(`written to         : ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main();
