/**
 * Simulator ↔ CAD bench link verifier.
 *
 *   pnpm verify:cad-sim-link
 *
 * Velxio draws a part from two places that must never disagree:
 *
 *   1. the emulator element (a `velxio-*` tag keyed by a metadataId) — truth
 *      for behaviour, pins and wiring;
 *   2. the CAD catalog (`/cad-catalog.json` + `models3d/`) — truth for the
 *      shape, the mm pin anchors and every part the emulator does NOT have.
 *
 * A part Velxio cannot simulate is carried as a CAD bench part: real geometry,
 * real pins on screen, no electrical model — and never a lookalike element.
 * That promise is only safe if the two key spaces stay disjoint and every key
 * in the catalog names a real registered part, so this gate proves:
 *
 *   1. key spaces — a `cad-bench-*` id can never collide with a simulator
 *      metadataId (collision = one part wearing another part's body);
 *   2. allocation — `velxioCatalogKeyFor()` (THE rule, shared with the
 *      exporter), `/cad-catalog.json` and `isCadBenchComponent()` (the canvas
 *      sync rule) agree for all 108 catalog parts, and every part that can be
 *      placed is reachable;
 *   3. assets — every catalog key has a model file, an STL (binary AND ascii),
 *      a `spec.json` and manifest pin nodes that match the spec exactly;
 *   4. placement — generated models sit at the origin of their own frame (the
 *      bench layout owns the position), pin anchors stay inside the body
 *      bounds, and no two pins collapse to the same GLTF node name;
 *   5. coupling — the vendored files that implement the tier still exist and
 *      still speak the same prefix/tag/asset path.
 *
 * Needs no credentials, no MongoDB and no network. Exits 0 on success, 1 on
 * any mismatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SEED_COMPONENTS } from '@/modules/components/catalog';
import { toWokwiDiagram, translatePin } from '@/modules/diagram-generator/wokwi';
import {
  CAD_BENCH_PREFIX,
  cadBenchCatalogId,
  cadBenchId,
  generateVelxioProject,
  isCadBenchComponent,
  velxioCatalogKeyFor,
} from '@/modules/simulation/velxio-project';
import { VELXIO_RENDER_ONLY_METADATA_IDS, VELXIO_SIMULATED_METADATA_IDS } from '@/modules/simulation/velxio-parts';
import type { Diagram, DiagramComponent, DiagramConnection } from '@/types/diagram';

const PUBLIC_DIR = path.resolve(__dirname, '../external/velxio/frontend/public');
const CATALOG_PATH = path.join(PUBLIC_DIR, 'cad-catalog.json');
const MODELS_DIR = path.join(PUBLIC_DIR, 'models3d');
const MANIFEST_PATH = path.join(MODELS_DIR, 'manifest.json');
const VENDORED_SRC = path.resolve(__dirname, '../external/velxio/frontend');

/**
 * How far a pin anchor may sit outside the mesh generated for its own spec.
 * Every anchor is drawn with its lead, so the correct value is ~0; the slack
 * only absorbs float rounding in the STL.
 */
const ANCHOR_SLACK_MM = 0.5;

interface CadPin {
  name: string;
  xMm: number;
  yMm: number;
  zMm: number;
  aliases?: string[];
}

interface CadDimensions {
  widthMm: number;
  lengthMm: number;
  heightMm: number;
}

interface CadSpec {
  id: string;
  name: string;
  category: string;
  dimensions: CadDimensions;
  pins: CadPin[];
}

interface CatalogEntry {
  catalogId: string;
  kind: 'board' | 'part';
  tier: string;
  cadOnly: boolean;
  canvasPlaced: boolean;
  spec: CadSpec;
}

interface ManifestModel {
  file: string;
  pinNodes?: string[];
  bench?: { position: [number, number, number]; rotation?: [number, number, number]; scale?: number };
  generated?: boolean;
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/**
 * The GLTF node name an anchor gets after the loader sanitizes it. Mirrors
 * `models3d.ts` — if two pins collapse to the same name, `getObjectByName()`
 * resolves a wire to the wrong anchor, which looks like a physics bug.
 */
function sanitizedNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
}

/**
 * Bounds of a binary STL, or null when the file is not one. Used to prove the
 * pin anchors belong to the mesh they claim to (the runtime 3D view re-centres
 * every model at its bounding-box centroid, so a body that is not centred in
 * the file still seats correctly — see `models3d.ts`).
 */
function readBinaryStlBounds(file: string): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  if (buf.length < 84) return null;
  const count = buf.readUInt32LE(80);
  if (buf.length !== 84 + 50 * count || count === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let triangle = 0; triangle < count; triangle += 1) {
    const base = 84 + triangle * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const at = base + vertex * 12;
      const x = buf.readFloatLE(at);
      const y = buf.readFloatLE(at + 4);
      const z = buf.readFloatLE(at + 8);
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    }
  }
  return { min, max };
}

/** First pin name of a catalog part, or '' when it has none. */
function firstPinOf(component: { pins: { name: string }[] }): string {
  return component.pins[0]?.name ?? '';
}

function main(): number {
  const failures: string[] = [];
  const fail = (message: string): void => {
    failures.push(message);
  };

  if (!fs.existsSync(CATALOG_PATH)) {
    console.error(`missing ${path.relative(process.cwd(), CATALOG_PATH)} — run pnpm export:cad-catalog`);
    return 1;
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`missing ${path.relative(process.cwd(), MANIFEST_PATH)} — run pnpm export:cad-models`);
    return 1;
  }

  const catalog = readJson<{ version: number; entries: Record<string, CatalogEntry> }>(CATALOG_PATH);
  const manifest = readJson<{ version: number; models: Record<string, ManifestModel> }>(MANIFEST_PATH);
  const entries = catalog.entries;

  const byCatalogId = new Map(SEED_COMPONENTS.map((component) => [component.id, component]));
  const simulatedKeys = new Set<string>();
  const cadKeys = new Set<string>();
  for (const [key, entry] of Object.entries(entries)) {
    (entry.cadOnly ? cadKeys : simulatedKeys).add(key);
  }

  heading('wireup · simulator ↔ CAD bench link');
  console.log(`catalog components : ${SEED_COMPONENTS.length}`);
  const boardCount = Object.values(entries).filter((entry) => entry.kind === 'board').length;
  console.log(
    `velxio catalog keys : ${Object.keys(entries).length} (${boardCount} boards, ${Object.keys(entries).length - boardCount} parts)`,
  );

  /* 1. Key spaces ------------------------------------------------------- */

  // Identity of the prefix helpers, both directions.
  for (const sample of ['dht22', 'water-pump-5v-submersible']) {
    if (cadBenchCatalogId(cadBenchId(sample)) !== sample) {
      fail(`cadBenchId/cadBenchCatalogId do not round-trip for "${sample}"`);
    }
    if (cadBenchCatalogId(sample) !== null) {
      fail(`cadBenchCatalogId("${sample}") should be null for a key without the prefix`);
    }
  }

  for (const key of cadKeys) {
    if (key.startsWith(CAD_BENCH_PREFIX)) {
      fail(`catalog key "${key}" carries the ${CAD_BENCH_PREFIX} prefix — the catalog is keyed by catalog id`);
      continue;
    }
    const entry = entries[key] as CatalogEntry;
    if (entry.catalogId !== key) {
      fail(`CAD key "${key}" names catalogId "${entry.catalogId}" — a CAD bench part is keyed by its own id`);
    }
    if (simulatedKeys.has(key)) {
      fail(`key "${key}" is in both key spaces — one part would wear another part's body`);
    }
    if (VELXIO_SIMULATED_METADATA_IDS.has(key) || VELXIO_RENDER_ONLY_METADATA_IDS.has(key)) {
      fail(`CAD key "${key}" is a registered simulator metadataId — the key spaces must stay disjoint`);
    }
  }

  /* 2. Allocation + coverage -------------------------------------------- */

  const buckets = { board: 0, simulated: 0, cadBench: 0, catalogOnly: 0, notOnBench: 0 };
  const expectedKeys = new Set<string>();
  for (const component of SEED_COMPONENTS) {
    const expected = velxioCatalogKeyFor(component);
    if (!expected) {
      buckets.notOnBench += 1;
      if (isCadBenchComponent(component)) {
        fail(`${component.id}: exporter refuses a key but the canvas sync would still place it as a CAD part`);
      }
      if (entries[component.id]) {
        fail(`${component.id}: not placeable yet present in the catalog as "${component.id}"`);
      }
      continue;
    }

    expectedKeys.add(expected.key);
    const entry = entries[expected.key] as CatalogEntry | undefined;
    if (!entry) {
      fail(`${component.id}: key "${expected.key}" is missing from /cad-catalog.json — run pnpm export:cad-catalog`);
      continue;
    }
    if (entry.kind !== expected.kind) {
      fail(`${component.id}: catalog says kind "${entry.kind}", the rule says "${expected.kind}"`);
    }
    if (entry.cadOnly !== expected.cadOnly) {
      fail(`${component.id}: catalog says cadOnly=${entry.cadOnly}, the rule says ${expected.cadOnly}`);
    }
    if (entry.canvasPlaced !== expected.canvasPlaced) {
      fail(`${component.id}: catalog says canvasPlaced=${entry.canvasPlaced}, the rule says ${expected.canvasPlaced}`);
    }

    if (expected.kind === 'board') {
      buckets.board += 1;
    } else if (!expected.cadOnly) {
      buckets.simulated += 1;
    } else if (expected.canvasPlaced) {
      buckets.cadBench += 1;
      if (entry.catalogId !== component.id) {
        fail(`${component.id}: CAD key "${expected.key}" is owned by another part (${entry.catalogId})`);
      }
    } else {
      buckets.catalogOnly += 1;
    }

    // The CANVAS rule must agree with the catalog for this part, or the
    // exporter and the reverse sync will disagree about who owns a wire.
    const canvasCadPart = isCadBenchComponent(component);
    if (canvasCadPart !== (expected.cadOnly && expected.canvasPlaced)) {
      fail(
        `${component.id}: isCadBenchComponent()=${canvasCadPart} but the catalog tier is ` +
          `cadOnly=${expected.cadOnly} canvasPlaced=${expected.canvasPlaced}`,
      );
    }

    // A CAD bench part's pins are its catalog pins — the canvas element and
    // the 3D anchors are both keyed by those names, so an alias-only pin
    // would silently fail to resolve.
    if (expected.cadOnly && expected.canvasPlaced) {
      for (const pin of component.pins) {
        const names = entry.spec.pins.map((candidate) => candidate.name.toLowerCase());
        const aliases = entry.spec.pins.flatMap((candidate) => (candidate.aliases ?? []).map((a) => a.toLowerCase()));
        if (!names.includes(pin.name.toLowerCase()) && !aliases.includes(pin.name.toLowerCase())) {
          fail(`${component.id}: registry pin "${pin.name}" has no CAD anchor (the CAD key is the pin contract)`);
        }
      }
    }
  }

  for (const key of Object.keys(entries)) {
    if (!expectedKeys.has(key)) {
      fail(`/cad-catalog.json has a stale key "${key}" that no catalog part maps to — re-run pnpm export:cad-catalog`);
    }
    const entry = entries[key] as CatalogEntry;
    if (!byCatalogId.has(entry.catalogId)) {
      fail(`catalog key "${key}" points at "${entry.catalogId}", which is not a catalog component`);
    }
  }

  console.log(
    `placement tiers     : ${buckets.board} boards · ${buckets.simulated} simulated · ${buckets.cadBench} CAD bench · ` +
      `${buckets.catalogOnly} catalog-only · ${buckets.notOnBench} not on the bench`,
  );

  /* 3. Assets ------------------------------------------------------------ */

  heading('assets');
  let stlCount = 0;
  let asciiCount = 0;
  let glbCount = 0;
  let sizeBytes = 0;

  for (const [key, entry] of Object.entries(entries)) {
    const model = manifest.models[key];
    if (!model) {
      fail(`${key}: no manifest entry — run pnpm export:cad-models`);
      continue;
    }
    const glbPath = path.join(MODELS_DIR, model.file);
    if (!fs.existsSync(glbPath) || fs.statSync(glbPath).size === 0) {
      fail(`${key}: model file "${model.file}" is missing or empty`);
      continue; // the print exports live next to it; no point reporting them too
    }
    glbCount += 1;
    sizeBytes += fs.statSync(glbPath).size;

    // Print exports are siblings of the model file, named after it — so a
    // reviewed asset keeps its own directory and still ships an STL.
    const modelDir = path.dirname(glbPath);
    const modelBase = path.basename(model.file, '.glb');
    const stlPath = path.join(modelDir, `${modelBase}.stl`);
    const asciiPath = path.join(modelDir, `${modelBase}.ascii.stl`);
    const specPath = path.join(modelDir, 'spec.json');
    for (const [label, file] of [
      ['stl', stlPath],
      ['ascii.stl', asciiPath],
      ['spec.json', specPath],
    ] as const) {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        fail(`${key}: ${label} is missing or empty (${path.relative(process.cwd(), file)})`);
      } else if (label === 'stl') stlCount += 1;
      else if (label === 'ascii.stl') asciiCount += 1;
    }
    if (!fs.existsSync(specPath)) continue;

    // Two honest formats exist: the export wrapper ({key, catalogId, spec}) and
    // a bare CadComponentSpec shipped with a reviewed asset.
    const exported = readJson<{ key?: string; catalogId?: string; spec?: CadSpec; pins?: CadPin[] }>(specPath);
    const spec = exported.spec ?? (exported as unknown as CadSpec);
    if (exported.key !== undefined && (exported.key !== key || exported.catalogId !== entry.catalogId)) {
      fail(`${key}: spec.json identifies itself as "${exported.key}" / "${exported.catalogId}"`);
    }
    if (!Array.isArray(spec.pins)) {
      fail(`${key}: spec.json has no pin list`);
      continue;
    }

    // For a GENERATED model the manifest pin nodes ARE the 3D anchor contract
    // and must match the spec exactly. A reviewed GLB carries its own node
    // names (the mesh is the authority there), so it is only checked for a
    // non-empty, unique set.
    const specPins = spec.pins.map((pin) => pin.name);
    const manifestPins = model.pinNodes ?? [];
    if (new Set(manifestPins).size !== manifestPins.length) {
      fail(`${key}: manifest pinNodes contain duplicates`);
    }
    if (model.generated && specPins.join('\u0000') !== manifestPins.join('\u0000')) {
      fail(`${key}: manifest pinNodes do not match spec.json pins (${manifestPins.length} vs ${specPins.length})`);
    }
  }

  console.log(`glb                 : ${glbCount} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`stl (binary)        : ${stlCount}`);
  console.log(`stl (ascii)         : ${asciiCount}`);
  console.log(`spec.json           : ${Object.keys(entries).length}`);

  /* 4. Placement sanity -------------------------------------------------- */

  heading('placement');
  let placedParts = 0;
  let anchorsChecked = 0;
  for (const [key, entry] of Object.entries(entries)) {
    const spec = entry.spec;
    if (entry.kind === 'part') placedParts += 1;

    // No two pins may sanitize to the same GLTF node name (models3d.ts looks
    // anchors up by name) — that would attach a wire to the wrong pin.
    const seen = new Map<string, string>();
    for (const pin of spec.pins) {
      const node = sanitizedNodeName(pin.name);
      if (seen.has(node)) {
        fail(`${key}: pins "${pin.name}" and "${seen.get(node)}" both become the GLTF node "${node}"`);
      }
      seen.set(node, pin.name);
    }

    const model = manifest.models[key];
    if (!model?.generated) continue; // a reviewed GLB has its own geometry

    const [x, y, z] = model.bench?.position ?? [0, 0, 0];
    if (x !== 0 || y !== 0 || z !== 0) {
      fail(`${key}: generated model bakes a bench offset [${x}, ${y}, ${z}] — the layout positions parts`);
    }
    const scale = model.bench?.scale ?? 1;
    if (!(scale > 0)) fail(`${key}: generated model has non-positive bench scale ${scale}`);

    // The STL is generated from the same spec as the model, so every pin
    // anchor must land inside (or on) that mesh — a mixed-up coordinate
    // convention shows up here before it shows up as a wire in mid-air.
    const dir = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const stlPath = path.join(MODELS_DIR, dir, `${dir}.stl`);
    const mesh = readBinaryStlBounds(stlPath);
    if (!mesh) {
      fail(`${key}: could not read ${dir}/${dir}.stl as a binary STL`);
      continue;
    }
    for (const pin of spec.pins) {
      anchorsChecked += 1;
      const outside =
        Math.max(
          mesh.min.x - pin.xMm,
          pin.xMm - mesh.max.x,
          mesh.min.y - pin.yMm,
          pin.yMm - mesh.max.y,
          mesh.min.z - pin.zMm,
          pin.zMm - mesh.max.z,
        ) > ANCHOR_SLACK_MM;
      if (outside) {
        fail(
          `${key}: pin "${pin.name}" at (${pin.xMm}, ${pin.yMm}, ${pin.zMm}) lies outside its own mesh ` +
            `x[${mesh.min.x.toFixed(1)}, ${mesh.max.x.toFixed(1)}] y[${mesh.min.y.toFixed(1)}, ${mesh.max.y.toFixed(1)}] ` +
            `z[${mesh.min.z.toFixed(1)}, ${mesh.max.z.toFixed(1)}]`,
        );
      }
    }
  }
  console.log(`parts walked        : ${placedParts}`);
  console.log(`anchors vs mesh     : ${anchorsChecked} anchors, ≤ ${ANCHOR_SLACK_MM} mm outside their own body`);

  /* 5. CAD bench end-to-end ---------------------------------------------- */

  /*
   * Everything above is bookkeeping; this is the part that would have caught
   * the original bug. A project built around a pump used to reach the canvas
   * with the pump missing, or with its body present and every wire to it gone,
   * because the simulator projection dropped what it could not place. So:
   * build a diagram with a board, EVERY CAD bench part in the catalog and one
   * simulated part, export it, and require that every single part and every
   * single wire survives — and that the simulated end of a mixed wire is
   * translated into the simulator element's own pin vocabulary.
   */
  heading('cad bench end-to-end');
  const boardDefinition = SEED_COMPONENTS.find((component) => component.id === 'arduino-uno-r3');
  const cadParts = SEED_COMPONENTS.filter(
    (component) => component.category !== 'microcontroller' && isCadBenchComponent(component),
  );
  const mixedPartner = SEED_COMPONENTS.find(
    (component) =>
      component.category !== 'microcontroller' &&
      component.simulator?.supported === true &&
      Boolean(component.simulator?.part) &&
      component.pins.length >= 2 &&
      component.metadata?.electrical !== false &&
      !isCadBenchComponent(component),
  );

  if (!boardDefinition || cadParts.length === 0 || !mixedPartner) {
    fail('end-to-end: could not assemble the fixture (board, CAD bench parts, or mixed partner missing)');
  } else {
    const components: DiagramComponent[] = [
      {
        id: 'board-1',
        ref: boardDefinition.id,
        category: 'microcontroller',
        x: 0,
        y: 0,
        simulator: boardDefinition.simulator,
      } as unknown as DiagramComponent,
      ...cadParts.map(
        (component, index) =>
          ({
            id: `cad-${index}`,
            ref: component.id,
            name: component.name,
            category: component.category,
            x: 0,
            y: 0,
            pins: component.pins.map((pin) => ({ name: pin.name, connected: true })),
            simulator: component.simulator,
            metadata: component.metadata,
          }) as unknown as DiagramComponent,
      ),
      {
        id: 'mixed-1',
        ref: mixedPartner.id,
        name: mixedPartner.name,
        category: mixedPartner.category,
        x: 0,
        y: 0,
        simulator: mixedPartner.simulator,
        metadata: mixedPartner.metadata,
      } as unknown as DiagramComponent,
    ];

    const connections: DiagramConnection[] = [];
    cadParts.forEach((component, index) => {
      const id = `cad-${index}`;
      const first = component.pins[0]?.name;
      if (!first) return;
      connections.push({
        id: `cad-power-${index}`,
        from: { component: id, pin: first },
        to: { component: 'board-1', pin: '5V' },
        kind: 'power',
        signal: 'power',
        wireColor: 'red',
      });
    });
    // A real chain: board → simulated part → CAD part. The CAD end keeps its
    // catalog pin; the simulated end must come out in the element's own
    // vocabulary or Velxio drops the wire on import.
    const mixedFrom = mixedPartner.pins[0]?.name;
    const mixedTo = mixedPartner.pins[1]?.name;
    if (mixedFrom && mixedTo) {
      connections.push({
        id: 'mixed-signal',
        from: { component: 'mixed-1', pin: mixedFrom },
        to: { component: 'board-1', pin: 'D9' },
        kind: 'signal',
        signal: 'digital',
        wireColor: '',
      });
      connections.push({
        id: 'mixed-to-cad',
        from: { component: 'cad-0', pin: firstPinOf(cadParts[0]) },
        to: { component: 'mixed-1', pin: mixedTo },
        kind: 'signal',
        signal: 'digital',
        wireColor: '',
      });
    }

    const diagram = {
      components,
      connections,
      version: '1.0',
      format: 'wireup-diagram',
      generator: 'verify-cad-sim-link',
      createdAt: '2026-09-11T00:00:00.000Z',
      projectId: 'verify-cad-sim-link',
      revision: 1,
      meta: { title: 'cad bench e2e', description: '', simulatorTarget: 'velxio', units: 'px', gridSize: 20 },
      rails: [],
      groups: [],
      layout: { width: 0, height: 0, columns: 0, rows: 0 },
      stats: { components: components.length, connections: connections.length, powerConnections: 0, groundConnections: 0, signalConnections: 0, pins: 0 },
    } as unknown as Diagram;

    const projection = toWokwiDiagram(diagram);
    const result = generateVelxioProject({
      projectName: 'verify-cad-sim-link',
      diagram,
      files: [{ path: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }],
      exportedAt: '2026-09-11T00:00:00.000Z',
    });

    const projectedIds = new Set(result.project.components.map((component) => component.id));
    for (const [index, component] of cadParts.entries()) {
      const id = `cad-${index}`;
      if (!projectedIds.has(id)) {
        fail(`end-to-end: CAD bench part ${component.id} never reached the canvas`);
        continue;
      }
      if (!projection.cadBench.some((entry) => entry.id === id)) {
        fail(`end-to-end: ${component.id} is not reported as a CAD bench part by the Wokwi projection`);
      }
      const instance = result.project.components.find((candidate) => candidate.id === id);
      if (instance?.metadataId !== cadBenchId(component.id)) {
        fail(`end-to-end: ${component.id} carries metadataId "${instance?.metadataId}" instead of "${cadBenchId(component.id)}"`);
      }
      if (instance?.properties?.cadKey !== component.id) {
        fail(`end-to-end: ${component.id} carries cadKey "${String(instance?.properties?.cadKey)}"`);
      }
    }

    const expectedWires = connections.length;
    if (result.project.wires.length !== expectedWires) {
      const drawn = new Set(
        result.project.wires.flatMap((wire) => [
          `${wire.start.componentId}:${wire.start.pinName}`,
          `${wire.end.componentId}:${wire.end.pinName}`,
        ]),
      );
      const lost = connections
        .flatMap((connection) => [
          { key: `${connection.from.component}:${connection.from.pin}`, label: `${connection.from.component}.${connection.from.pin}` },
          { key: `${connection.to.component}:${connection.to.pin}`, label: `${connection.to.component}.${connection.to.pin}` },
        ])
        .filter((endpoint) => !drawn.has(endpoint.key) && !endpoint.label.startsWith('board-1'))
        .map((endpoint) => endpoint.label);
      fail(
        `end-to-end: ${expectedWires - result.project.wires.length} of ${expectedWires} wire(s) were dropped between the registry and the canvas` +
          (lost.length > 0 ? ` (missing endpoints: ${lost.join(', ')})` : ''),
      );
    }

    if (mixedFrom && mixedTo) {
      const translated = translatePin(mixedPartner.simulator?.part, mixedTo);
      if (!translated) {
        fail(`end-to-end: the simulated partner ${mixedPartner.id} has no translation for pin "${mixedTo}"`);
      } else if (!result.project.wires.some((wire) => wire.end.pinName === translated || wire.start.pinName === translated)) {
        fail(`end-to-end: the mixed wire's simulated end did not use the element pin "${translated}"`);
      }
    }

    const unexpected = result.unsupported.filter((entry) => !entry.startsWith('cad-bench:'));
    if (unexpected.length > 0) {
      fail(`end-to-end: exporter reported unsupported items: ${unexpected.join('; ')}`);
    }
    if (result.cadBench.length !== cadParts.length) {
      fail(`end-to-end: the exporter reported ${result.cadBench.length}/${cadParts.length} CAD bench parts`);
    }
    console.log(
      `fixture             : ${cadParts.length} CAD bench parts + 1 simulated partner · ` +
        `${result.project.wires.length}/${expectedWires} wires drawn`,
    );
    console.log(`projection          : ${projection.cadBench.length} parts reported as CAD bench`);
  }

  /* 6. Vendored coupling ------------------------------------------------- */

  heading('vendored coupling');
  const coupling: [string, string, string][] = [
    ['src/velxio-elements/cad-bench-element.ts', 'velxio-cad-bench-part', 'the 2D renderer tag'],
    ['src/velxio-elements/cad-bench-element.ts', 'cad-key', 'the observed attribute'],
    ['src/velxio-elements/cad-bench-element.ts', '/cad-catalog.json', 'the spec source'],
    ['src/scene3d/models3d.ts', 'position.sub(center)', 'the centering that makes y = height/2 seat a part'],
    ['src/velxio-elements/index.ts', 'CadBenchPartElement', 'the element registration'],
    ['src/services/ComponentRegistry.ts', 'cad-bench-', 'the metadataId prefix'],
    ['src/services/ComponentRegistry.ts', 'velxio-cad-bench-part', 'the registry tagName'],
    ['src/services/ComponentRegistry.ts', '/cad-catalog.json', 'the registry asset path'],
    ['src/scene3d/Cad3DScene.tsx', 'cad-bench-', 'the 3D key prefix'],
    ['src/scene3d/placement.ts', 'layoutInstances', 'the shared bench layout'],
  ];
  for (const [relative, needle, why] of coupling) {
    const file = path.join(VENDORED_SRC, relative);
    if (!fs.existsSync(file)) {
      fail(`vendored ${relative} is gone — ${why} is unwired`);
      continue;
    }
    if (!fs.readFileSync(file, 'utf-8').includes(needle)) {
      fail(`vendored ${relative} no longer mentions "${needle}" — ${why} is unwired`);
    }
  }
  console.log(`vendored files      : ${coupling.length} checks across the vendored source`);
  console.log(`cad-bench prefix    : ${CAD_BENCH_PREFIX}`);

  /* Result ---------------------------------------------------------------- */

  heading('result');
  if (failures.length === 0) {
    console.log(
      `ok · ${SEED_COMPONENTS.length} catalog parts allocated, ${Object.keys(entries).length} catalog keys asset-complete, ` +
        'key spaces disjoint, bench anchors sane, vendored wiring intact',
    );
    return 0;
  }

  console.log(`${failures.length} problem(s):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  return 1;
}

process.exit(main());
