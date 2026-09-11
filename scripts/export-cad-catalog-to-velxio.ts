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
 * ── The CAD bench key space (added 2026-09-11) ──────────────────────────────
 * A catalog part the emulator has NO element for (a pump, an L298N, an HC-05,
 * a bare LDR cell …) used to get no entry at all, so it could not be drawn
 * anywhere — not on the 2D canvas, not on the 3D bench — and half of a real
 * build simply vanished from the simulator. Every such part now gets an entry
 * keyed by its CATALOG ID, which is also the key Wireup's project exporter
 * uses (`cad-bench-<catalogId>` metadataId, `cadKey` property). The 2D canvas
 * renders it through `<velxio-cad-bench-part>`, the 3D scene through this
 * catalog, and both agree on every pin.
 *
 * The two key spaces must stay disjoint (a CAD-only catalog id colliding with
 * a simulator metadataId would silently give a part someone else's geometry);
 * `pnpm verify:cad-sim-link` fails if they ever overlap.
 *
 * Nothing here writes GLBs — Velxio's 3D view builds the same polished
 * parametric geometry the admin studio previews (ported into
 * `frontend/src/scene3d/cadParametric.ts`) directly from this spec data, so a
 * part with no reviewed asset still renders at full quality instead of a
 * degraded "fallback" tier. The reviewed GLBs already in models3d/ continue
 * to take precedence where they exist (arduino-uno, sg90, dht22,
 * hc-sr04-ultrasonic). `pnpm export:cad-models` additionally writes a
 * generated GLB + STL + spec.json per key for offline/3D-print use.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { listLinkedSpecs } from '../cad-helper';
import { SEED_COMPONENTS } from '../src/modules/components/catalog';
import { velxioCatalogKeyFor } from '../src/modules/simulation/velxio-project';

const OUTPUT_PATH = path.resolve(
  __dirname,
  '../external/velxio/frontend/public/cad-catalog.json',
);

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function main(): void {
  const linked = listLinkedSpecs();
  const entries: Record<string, unknown> = {};
  let boards = 0;
  let parts = 0;
  let cadOnly = 0;
  const skipped: string[] = [];
  const collisions: string[] = [];

  for (const { spec, tier } of linked) {
    const component = SEED_COMPONENTS.find((c) => c.id === spec.id);
  const resolved = component ? velxioCatalogKeyFor(component) : null;
    if (!resolved) {
      skipped.push(spec.id);
      continue;
    }
    const { key, kind, cadOnly: isCadOnly, canvasPlaced } = resolved;
    // A shared Velxio key (e.g. several servo catalog ids all map to the
    // wokwi-servo element) keeps the first spec seen — `listLinkedSpecs`
    // walks the catalog in a stable order, and Velxio only needs one
    // geometry per rendered element. A collision between the simulator and
    // CAD-bench key spaces is NOT that case: two different parts would share
    // one body, so it is reported loudly and the second one is dropped.
    const existing = entries[key] as { catalogId?: string } | undefined;
    if (existing) {
      if (existing.catalogId !== spec.id && Boolean((existing as { cadOnly?: boolean }).cadOnly) !== isCadOnly) {
        collisions.push(`${spec.id} -> "${key}" is already used by ${existing.catalogId}`);
      }
      continue;
    }
    entries[key] = { catalogId: spec.id, kind, tier, cadOnly: isCadOnly, canvasPlaced, spec };
    if (kind === 'board') boards += 1;
    else {
      parts += 1;
      if (isCadOnly) cadOnly += 1;
    }
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
  console.log(`exported parts     : ${parts} (${cadOnly} of them CAD bench / no emulator element)`);
  console.log(`not placeable      : ${skipped.length}${skipped.length ? ` (${skipped.join(', ')})` : ''}`);
  if (collisions.length > 0) {
    console.log(`KEY COLLISIONS     : ${collisions.length}`);
    for (const line of collisions) console.log(`  ! ${line}`);
  }
  console.log(`written to         : ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  if (collisions.length > 0) process.exitCode = 1;
}

main();
