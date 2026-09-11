/**
 * Export every catalog key's CAD bundle into Velxio's public assets.
 *
 *   pnpm export:cad-models           # write what is missing
 *   pnpm export:cad-models --force   # rewrite every GENERATED model
 *
 * Why this exists next to `export:cad-catalog`:
 *
 *   • `export:cad-catalog` ships the SPEC JSON — enough for Velxio to build the
 *     parametric body live (that is what the 3D view renders by default, and
 *     it needs no files at all);
 *   • this script ships the FILES: a `.glb` (named pin-anchor nodes, PBR
 *     materials — the same contract the reviewed Blender assets use), a binary
 *     `.stl`, a human-readable `.ascii.stl` and a `spec.json` for provenance.
 *     Everything is generated from the same spec data the admin CAD studio
 *     previews, so nothing here can disagree with the studio.
 *
 * Rules this keeps:
 *   1. A REVIEWED asset is never overwritten — not even by `--force`. Its GLB
 *      is the rendered model; for those keys this script only adds the print
 *      exports (`spec.json` records that the STL is a parametric spec export,
 *      not the reviewed mesh).
 *   2. An asset on disk that the manifest does not own is NEVER touched: a
 *      hand-built model can exist under a key this script has not generated
 *      yet (that is how the reviewed assets arrived), and overwriting it
 *      because it was untracked would destroy real work.
 *   3. Deterministic: keys are written in sorted order and the manifest keeps
 *      its existing key order, so a re-run is a no-op unless a spec changed.
 *   4. Nothing is invented: a key with no CAD spec is reported, not guessed,
 *      and a manifest entry whose key left the catalog is pruned (reported).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildCadBundle } from '../cad-helper/bundle-generator';
import { listLinkedSpecs } from '../cad-helper/catalog-link';

const MODELS_DIR = path.resolve(__dirname, '../external/velxio/frontend/public/models3d');
const CATALOG_PATH = path.resolve(__dirname, '../external/velxio/frontend/public/cad-catalog.json');
const MANIFEST_PATH = path.join(MODELS_DIR, 'manifest.json');

interface CatalogEntry {
  catalogId: string;
  kind: 'board' | 'part';
  tier: string;
  cadOnly?: boolean;
  canvasPlaced?: boolean;
}

interface CatalogFile {
  version: number;
  generatedAt?: string;
  entries: Record<string, CatalogEntry>;
}

interface ManifestModel {
  file: string;
  pinNodes?: string[];
  bench?: { position: [number, number, number]; rotation?: [number, number, number]; scale?: number };
  generated?: boolean;
  provenance?: string;
}

interface Manifest {
  version: number;
  models: Record<string, ManifestModel>;
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

/** Filesystem-safe directory name for a Velxio key. */
function dirFor(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function main(): void {
  const force = process.argv.includes('--force');

  if (!fs.existsSync(CATALOG_PATH)) {
    console.error(`missing ${path.relative(process.cwd(), CATALOG_PATH)} — run pnpm export:cad-catalog first`);
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as CatalogFile;
  const manifest: Manifest = fs.existsSync(MANIFEST_PATH)
    ? (JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest)
    : { version: 1, models: {} };
  manifest.models ??= {};

  const specs = new Map(listLinkedSpecs().map((entry) => [entry.spec.id, entry]));
  const keys = Object.keys(catalog.entries).sort();

  let modelsWritten = 0;
  let printsWritten = 0;
  let kept = 0;
  let bytes = 0;
  const missingSpec: string[] = [];
  const untracked: string[] = [];

  for (const key of keys) {
    const entry = catalog.entries[key] as CatalogEntry;
    const existing = manifest.models[key];
    const reviewed = Boolean(existing && !existing.generated);

    const linked = specs.get(entry.catalogId);
    if (!linked) {
      missingSpec.push(`${key} (catalog id ${entry.catalogId})`);
      continue;
    }

    /*
     * Where the files live. A registered model keeps its own path — a reviewed
     * asset sits in its own directory (`sg90/sg90.glb` under the key `servo`),
     * and its print exports must be siblings of THAT file, not of the key.
     */
    const dir = dirFor(key);
    const targetDir = existing ? path.dirname(path.join(MODELS_DIR, existing.file)) : path.join(MODELS_DIR, dir);
    const fileBase = existing ? path.basename(existing.file, '.glb') : dir;
    const glbPath = path.join(targetDir, `${fileBase}.glb`);
    // A model already on disk that the manifest does not own is someone
    // else's asset (a reviewed mesh, a build from another tool): hands off.
    if (!existing && fs.existsSync(glbPath)) {
      untracked.push(`${key} (${path.relative(MODELS_DIR, glbPath)})`);
      kept += 1;
      continue;
    }
    const stlPath = path.join(targetDir, `${fileBase}.stl`);
    const asciiPath = path.join(targetDir, `${fileBase}.ascii.stl`);
    const specPath = path.join(targetDir, 'spec.json');
    const havePrints = fs.existsSync(stlPath) && fs.existsSync(asciiPath) && fs.existsSync(specPath);

    const needsModel = !reviewed && (!existing || force);
    const needsPrints = !havePrints;
    if (!needsModel && !needsPrints) {
      kept += 1;
      continue;
    }

    const bundle = buildCadBundle(linked.spec);
    fs.mkdirSync(targetDir, { recursive: true });

    if (needsModel) {
      fs.writeFileSync(glbPath, bundle.glbBinary);
      manifest.models[key] = {
        file: `${path.relative(MODELS_DIR, glbPath).split(path.sep).join('/')}`,
        pinNodes: bundle.spec.pins.map((pin) => pin.name),
        bench: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
        generated: true,
        provenance:
          `Generated by Wireup (pnpm export:cad-models) from the component registry (${entry.tier} CAD tier). ` +
          'Parametric geometry with named pin-anchor nodes — not a manufacturer STEP source.',
      };
      bytes += bundle.glbBinary.length;
      modelsWritten += 1;
    }

    /*
     * STL is the format the user asked for: printable, offline, no viewer
     * needed. Written for every key — but for a REVIEWED key only the files
     * that are missing are added, so a hand-built asset's own STL/spec are
     * never replaced by a parametric approximation of them.
     */
    const write = (file: string, content: string | Buffer): void => {
      if (reviewed && fs.existsSync(file)) return;
      fs.writeFileSync(file, content);
    };
    write(stlPath, bundle.stlBinary);
    write(asciiPath, bundle.stlAscii);
    write(
      specPath,
      `${JSON.stringify(
        {
          key,
          catalogId: entry.catalogId,
          tier: entry.tier,
          cadOnly: entry.cadOnly ?? false,
          assetKind: reviewed ? 'print-export-of-spec' : 'generated-model',
          renderedModel: reviewed ? (existing as ManifestModel).file : `${dir}/${dir}.glb`,
          note: reviewed
            ? 'The rendered 3D model is the reviewed GLB named in renderedModel; these STLs are exported from the CAD spec.'
            : 'Geometry and pin anchors are generated from the CAD spec by Wireup.',
          spec: bundle.spec,
        },
        null,
        2,
      )}\n`,
    );
    bytes += bundle.stlBinary.length;
    printsWritten += 1;
  }

  // Prune entries whose key is no longer in the catalog: a key that moved
  // between tiers (simulated <-> CAD bench) must not leave a stale model
  // pointing at an asset that no longer represents it.
  const catalogKeys = new Set(keys);
  const pruned: string[] = [];
  for (const key of Object.keys(manifest.models)) {
    if (catalogKeys.has(key)) continue;
    pruned.push(key);
    delete manifest.models[key];
  }

  // Keep the manifest's own key order stable: existing keys first (in their
  // current order), then any new ones sorted.
  const ordered: Record<string, ManifestModel> = {};
  for (const key of Object.keys(manifest.models)) ordered[key] = manifest.models[key] as ManifestModel;
  manifest.models = ordered;

  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  heading('wireup · CAD models -> Velxio');
  console.log(`catalog keys        : ${keys.length}`);
  console.log(`models written      : ${modelsWritten}`);
  console.log(`print exports wrote : ${printsWritten}`);
  console.log(`kept (reviewed/ok)  : ${kept}`);
  console.log(`bytes written       : ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`manifest entries    : ${Object.keys(manifest.models).length}`);
  console.log(`assets              : ${path.relative(process.cwd(), MODELS_DIR)}`);
  if (missingSpec.length > 0) {
    console.log(`no CAD spec for     : ${missingSpec.length} — ${missingSpec.join(', ')}`);
  }
  if (untracked.length > 0) {
    console.log(`untracked on disk   : ${untracked.length} — left exactly as found: ${untracked.join(', ')}`);
  }
  if (pruned.length > 0) {
    console.log(`pruned entries      : ${pruned.length} — ${pruned.join(', ')}`);
  }

  if (missingSpec.length > 0) process.exitCode = 1;
}

main();
