/**
 * Registry ↔ simulator link verifier.
 *
 *   pnpm verify:simulator
 *
 * The CAD link has a gate (`verify:cad-link`) because geometry that looks right
 * but wires wrong is the worst kind of failure. The simulator link has the same
 * failure mode: a catalog entry that claims `supported: true` produces a part
 * on the simulator canvas that either does not render or — worse — renders and
 * then silently drops every wire to it, because the pins it was wired to do not
 * exist on the real element.
 *
 * This script proves the coupling holds against the VENDORED Velxio itself:
 *
 *   1. every catalog `supported: true` claim maps through the exporter tables
 *      to a Velxio id that has registered simulation behaviour (or is an
 *      accepted render-only passive / wiring medium);
 *   2. every exporter metadata id exists in the vendored
 *      `components-metadata.json` AND its element tag is runtime-definable in
 *      the pinned build (npm `@wokwi/elements@1.9.2` tags + velxio custom
 *      elements);
 *   3. every exporter board kind is a member of Velxio's own `BoardKind` union;
 *   4. the static `VELXIO_SIMULATED_METADATA_IDS` table in
 *      `src/modules/simulation/velxio-parts.ts` matches the `register(...)`
 *      calls actually present in the vendored simulation source (both
 *      directions — drift in either fails);
 *   5. every catalog microcontroller that claims simulator support resolves to
 *      a Velxio board kind (never a default Uno substituted silently).
 *
 * Needs no credentials, no MongoDB and no network. Exits 0 on success.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SEED_COMPONENTS } from '@/modules/components/catalog';
import { toWokwiDiagram } from '@/modules/diagram-generator/wokwi';
import {
  VELXIO_METADATA_RELATIVE_PATH,
  VELXIO_NPM_ELEMENT_TAGS,
  VELXIO_RENDER_ONLY_METADATA_IDS,
  VELXIO_RUNTIME_ONLY_REGISTERED_IDS,
  VELXIO_SIMULATED_METADATA_IDS,
  checkSimulatorClaims,
} from '@/modules/simulation/velxio-parts';
import { BOARD_KIND_BY_WOKWI_TYPE, METADATA_BY_WOKWI_TYPE, generateVelxioProject } from '@/modules/simulation/velxio-project';
import type { Diagram, DiagramComponent, DiagramConnection } from '@/types/diagram';

interface VelxioMetadataEntry {
  id: string;
  tagName: string;
  name?: string;
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

/** Recursively list .ts/.tsx files under a directory, skipping tests. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function main(): number {
  const failures: string[] = [];
  const repoRoot = process.cwd();
  const metadataPath = path.join(repoRoot, VELXIO_METADATA_RELATIVE_PATH);
  const velxioFrontendSrc = path.join(repoRoot, 'external', 'velxio', 'frontend', 'src');

  heading('wireup · registry ↔ Velxio simulator link');

  /* ---- Load the vendored ground truth ----------------------------------- */
  if (!fs.existsSync(metadataPath)) {
    console.error(`vendored Velxio metadata not found at ${VELXIO_METADATA_RELATIVE_PATH}`);
    return 1;
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as { components: VelxioMetadataEntry[] };
  const metadataById = new Map(metadata.components.map((entry) => [entry.id, entry]));

  // Runtime-definable tags: the pinned npm element set + velxio's own custom
  // elements (customElements.define across the vendored frontend source).
  const velxioDefinedTags = new Set<string>(VELXIO_NPM_ELEMENT_TAGS);
  for (const file of sourceFiles(velxioFrontendSrc)) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const match of text.matchAll(/customElements\.define\(['"]([a-z0-9-]+)['"]/g)) {
      velxioDefinedTags.add(match[1] as string);
    }
  }
  // The registry also injects the Raspberry Pi metadata at runtime.
  velxioDefinedTags.add('velxio-raspberry-pi-3');

  const isDefinable = (metadataId: string): boolean => {
    const entry = metadataById.get(metadataId);
    if (!entry) return false;
    return velxioDefinedTags.has(entry.tagName) || metadataId.startsWith('raspberry-pi');
  };

  console.log(`vendored metadata ids : ${metadata.components.length}`);
  console.log(`runtime-definable tags: ${velxioDefinedTags.size}`);

  /* ---- 1. catalog claims ------------------------------------------------ */
  const claimProblems = checkSimulatorClaims(SEED_COMPONENTS, METADATA_BY_WOKWI_TYPE, BOARD_KIND_BY_WOKWI_TYPE);
  const supportedCount = SEED_COMPONENTS.filter((c) => c.simulator?.supported === true).length;
  console.log(`catalog claims checked: ${supportedCount} supported / ${SEED_COMPONENTS.length} total`);
  for (const problem of claimProblems) {
    failures.push(`${problem.componentId}: claims "${problem.part}" but ${problem.problem}`);
  }

  /* ---- 2. exporter metadata ids ----------------------------------------- */
  for (const [wokwiType, metadataId] of Object.entries(METADATA_BY_WOKWI_TYPE)) {
    if (!metadataById.has(metadataId)) {
      failures.push(`exporter: "${wokwiType}" → "${metadataId}" has no entry in the vendored metadata`);
      continue;
    }
    if (!isDefinable(metadataId)) {
      const entry = metadataById.get(metadataId);
      failures.push(
        `exporter: "${wokwiType}" → "${metadataId}" is in the metadata but its element tag "${entry?.tagName}" is not defined by the pinned build`,
      );
    }
  }

  /* ---- 3. board kinds against Velxio's own union ------------------------ */
  const boardUnion = new Set<string>();
  const boardTypeDecl = fs.readFileSync(path.join(velxioFrontendSrc, 'types', 'board.ts'), 'utf-8');
  const unionBody = /export type BoardKind =([\s\S]*?);/.exec(boardTypeDecl)?.[1] ?? '';
  for (const match of unionBody.matchAll(/'([a-z0-9-]+)'/g)) boardUnion.add(match[1] as string);
  if (boardUnion.size === 0) failures.push('could not parse the BoardKind union from the vendored source');
  for (const [wokwiType, kind] of Object.entries(BOARD_KIND_BY_WOKWI_TYPE)) {
    if (boardUnion.size > 0 && !boardUnion.has(kind)) {
      failures.push(`exporter: board "${wokwiType}" → "${kind}" is not a BoardKind the vendored build knows`);
    }
  }

  /* ---- 4. static registry table vs the vendored source ------------------ */
  const registered = new Set<string>();
  const partsDir = path.join(velxioFrontendSrc, 'simulation', 'parts');
  if (fs.existsSync(partsDir)) {
    for (const file of sourceFiles(partsDir)) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/PartSimulationRegistry\.register\(\s*'([a-z0-9-]+)'/g)) {
        registered.add(match[1] as string);
      }
    }
  } else {
    failures.push('vendored simulation/parts directory not found');
  }
  for (const id of registered) {
    if (!VELXIO_SIMULATED_METADATA_IDS.has(id)) {
      failures.push(`velxio-parts: Velxio registers behaviour for "${id}" but the static table does not list it — update VELXIO_SIMULATED_METADATA_IDS`);
    }
  }
  for (const id of VELXIO_SIMULATED_METADATA_IDS) {
    if (!registered.has(id)) {
      failures.push(`velxio-parts: static table lists "${id}" as registered but the vendored source has no register() call — the build drifted`);
    }
    const inMetadata = metadataById.has(id);
    const runtimeOnly = VELXIO_RUNTIME_ONLY_REGISTERED_IDS.has(id);
    if (!inMetadata && !runtimeOnly) {
      failures.push(`velxio-parts: "${id}" is registered but absent from the vendored metadata (and not declared runtime-only)`);
    }
    if (inMetadata && runtimeOnly) {
      failures.push(`velxio-parts: "${id}" is declared runtime-only but now exists in the vendored metadata — promote it`);
    }
  }
  for (const id of VELXIO_RENDER_ONLY_METADATA_IDS) {
    if (registered.has(id)) {
      failures.push(`velxio-parts: "${id}" is listed render-only but Velxio registers behaviour for it — promote it`);
    }
    if (!isDefinable(id)) {
      failures.push(`velxio-parts: render-only id "${id}" is not runtime-definable in the pinned build`);
    }
  }

  /* ---- 5. every simulatable MCU resolves to a board kind ---------------- */
  for (const component of SEED_COMPONENTS) {
    if (component.category !== 'microcontroller' || component.simulator?.supported !== true) continue;
    const part = component.simulator.part ?? '';
    const resolved = BOARD_KIND_BY_WOKWI_TYPE[part];
    if (!resolved) {
      failures.push(`${component.id}: claims simulator support but "${part}" has no BoardKind mapping`);
      continue;
    }
    if (boardUnion.size > 0 && !boardUnion.has(resolved)) {
      failures.push(`${component.id}: board kind "${resolved}" is not in the vendored BoardKind union`);
    }
  }

  /* ---- 6. end-to-end: every simulatable part lands on the canvas --------- */
  // Claims and tables can all agree and the projection can still drop a wire
  // (a pin name that exists in the catalog but not on the real element). So
  // project a synthetic board + every supported peripheral, export the .vlx
  // and assert nothing was skipped, unmapped or silently dropped.
  const catalogById = new Map(SEED_COMPONENTS.map((c) => [c.id, c]));
  const peripherals = SEED_COMPONENTS.filter(
    (c) => c.category !== 'microcontroller' && c.simulator?.supported === true && c.simulator.part && c.pins.length > 0,
  );
  const e2eComponents = [
    {
      id: 'board-1',
      ref: 'arduino-mega',
      category: 'microcontroller' as const,
      x: 0,
      y: 0,
      simulator: catalogById.get('arduino-mega')?.simulator,
    },
    ...peripherals.map((component, index) => ({
      id: `p-${index}`,
      ref: component.id,
      category: component.category,
      x: 0,
      y: 0,
      simulator: component.simulator,
      metadata: component.metadata,
    })),
  ] as unknown as DiagramComponent[];
  // One power wire and one signal wire per ELECTRICAL peripheral, using its
  // FIRST power pin and its first non-power pin — enough to exercise every pin
  // mapper. Wiring media (breadboard) carry no connections in the real graph,
  // so they contribute none here either.
  const e2eConnections: DiagramConnection[] = [];
  peripherals.forEach((component, index) => {
    if (component.metadata.electrical === false) return;
    const id = `p-${index}`;
    const powerPin = component.powerPins[0] ?? component.groundPins[0] ?? component.pins[0]?.name;
    const signalPin = component.pins.find((p) => !component.powerPins.includes(p.name) && !component.groundPins.includes(p.name))?.name;
    if (powerPin) {
      e2eConnections.push({
        id: `e2e-power-${index}`,
        from: { component: id, pin: powerPin },
        to: { component: 'board-1', pin: component.groundPins.includes(powerPin) ? 'GND' : '5V' },
        kind: component.groundPins.includes(powerPin) ? 'ground' : 'power',
        signal: 'power',
        wireColor: component.groundPins.includes(powerPin) ? 'black' : 'red',
      });
    }
    if (signalPin) {
      e2eConnections.push({
        id: `e2e-signal-${index}`,
        from: { component: id, pin: signalPin },
        to: { component: 'board-1', pin: 'D22' },
        kind: 'signal',
        signal: 'digital',
        wireColor: '',
      });
    }
  });

  const e2eDiagram = { components: e2eComponents, connections: e2eConnections } as unknown as Diagram;
  const e2eProjection = toWokwiDiagram(e2eDiagram);
  const e2eResult = generateVelxioProject({
    projectName: 'verify-simulator-e2e',
    diagram: e2eDiagram,
    files: [{ path: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }],
    exportedAt: '2026-09-09T00:00:00.000Z',
  });

  console.log(`end-to-end projection : ${peripherals.length} peripherals, ${e2eResult.project.wires.length} wires on the canvas`);
  for (const skipped of e2eProjection.skippedParts) {
    if (skipped.reason.startsWith('Wiring medium')) continue; // the breadboard: deliberate, never carries wires
    failures.push(`end-to-end: ${skipped.ref} was skipped by the projection — ${skipped.reason}`);
  }
  if (e2eProjection.warnings.length > 0) {
    for (const warning of e2eProjection.warnings) failures.push(`end-to-end: projection warning — ${warning}`);
  }
  if (e2eResult.project.boards[0]?.boardKind !== 'arduino-mega') {
    failures.push(`end-to-end: controller resolved to "${e2eResult.project.boards[0]?.boardKind}" instead of arduino-mega`);
  }
  const expectedComponents = peripherals.filter((c) => c.metadata.electrical !== false).length;
  if (e2eResult.project.components.length !== expectedComponents) {
    failures.push(
      `end-to-end: only ${e2eResult.project.components.length}/${expectedComponents} parts reached the Velxio canvas`,
    );
  }
  const expectedWires = e2eProjection.diagram.connections.length;
  if (e2eResult.project.wires.length !== expectedWires) {
    const dropped = expectedWires - e2eResult.project.wires.length;
    failures.push(`end-to-end: ${dropped} wire(s) were dropped between the projection and the Velxio canvas`);
  }
  if (e2eResult.unsupported.length > 0) {
    failures.push(`end-to-end: exporter reported unsupported items: ${e2eResult.unsupported.join('; ')}`);
  }

  /* ---- Opportunity report (informational) ------------------------------- */
  const opportunities: string[] = [];
  for (const component of SEED_COMPONENTS) {
    const claim = component.simulator;
    if (!claim || claim.supported !== false || !claim.notes) continue;
    for (const metadataId of registered) {
      // Word-boundary match against the note only, so ids like "led" do not
      // light up inside unrelated words ("modelled"). A hit here is a hint a
      // human evaluates — the gate deliberately does not flip the claim.
      if (new RegExp(`\\b${metadataId}\\b`).test(claim.notes)) {
        opportunities.push(`${component.id}: note mentions registered Velxio id "${metadataId}" — re-check if it can be claimed`);
        break;
      }
    }
  }

  if (opportunities.length > 0) {
    heading('opportunities (informational — deliberate claims, not failures)');
    for (const line of opportunities) console.log(`  · ${line}`);
  }

  if (failures.length === 0) {
    console.log(
      `\nok · ${supportedCount} simulator claims, ${Object.keys(METADATA_BY_WOKWI_TYPE).length} part mappings and ` +
        `${Object.keys(BOARD_KIND_BY_WOKWI_TYPE).length} board mappings all verified against the vendored Velxio build`,
    );
    return 0;
  }

  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  return 1;
}

process.exit(main());
