/**
 * 3D live-surface gate.
 *
 *   pnpm verify:3d-live
 *
 * `pnpm export:live-surfaces` writes the table Velxio's 3D scene renders from.
 * A generated table is only worth as much as the gate behind it: the failure
 * mode this feature can produce is a display that is permanently dark because
 * the property it reads was renamed, or a glow welded to a feature that is not
 * there — both invisible without a machine check.
 *
 * So this script proves, against the repo (no network, no node_modules):
 *
 *   1. the exported file is EXACTLY what the generator produces now — a
 *      hand-edited table, or drift in the vendored simulator, fails;
 *   2. every CAD key the 3D bench can render is covered: either surfaces, or an
 *      explicit `noLiveState` reason (nothing is silently absent);
 *   3. every signal names a REAL producer — an element property the part's own
 *      register() block (or the helper it calls) writes, a property the element
 *      itself declares, a render-store key some part mirrors, a property-bag key
 *      some part emits, or a pin the CAD spec actually has;
 *   4. every anchor resolves: `spec` anchors must name a feature the spec has
 *      AND a key whose GLB is generated FROM that spec (the frame is only
 *      trustworthy there); `model` anchors must name a feature/node or be an
 *      explicit body-top fallback;
 *   5. the table's vocabulary still matches Velxio's consumer
 *      (`scene3d/live/surfaceTypes.ts`): unknown members or enum values fail.
 *
 * Exits 0 on success.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  LIVE_SURFACES_VERSION,
  buildLiveSurfaces,
  type CadCatalogEntry,
  type LiveSurface,
  type LiveSurfacesPayload,
  type PartLiveSurfaces,
} from '../src/modules/simulation/live-surfaces';
import { collectLiveSurfaceSources } from './live-surface-sources';

const VELXIO_FRONTEND = path.join('external', 'velxio', 'frontend');
const PUBLIC_DIR = path.join(VELXIO_FRONTEND, 'public');
const MODELS_DIR = path.join(PUBLIC_DIR, 'models3d');

interface ManifestEntry {
  file: string;
  pinNodes?: string[];
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/** A generated asset lives at `<key>/<key>.glb` next to the spec it came from. */
function isSpecGenerated(key: string, manifest: Record<string, ManifestEntry>): boolean {
  const entry = manifest[key];
  if (!entry) return false;
  if (entry.file !== `${key}/${key}.glb`) return false;
  return (
    fs.existsSync(path.join(MODELS_DIR, entry.file)) && fs.existsSync(path.join(MODELS_DIR, key, 'spec.json'))
  );
}

/** Member names of every interface in Velxio's consumer schema. */
function schemaMembers(surfaceTypesPath: string): { members: Set<string>; literals: Set<string> } {
  const text = fs.readFileSync(surfaceTypesPath, 'utf-8');
  const members = new Set<string>();
  for (const block of text.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    for (const member of (block[2] ?? '').matchAll(/^\s{2}([a-zA-Z_$][\w$]*)\??\s*:/gm)) {
      if (member[1]) members.add(member[1]);
    }
  }
  const literals = new Set<string>();
  for (const literal of text.matchAll(/'([a-z0-9-]+)'/g)) {
    if (literal[1]) literals.add(literal[1]);
  }
  return { members, literals };
}

function main(): number {
  const repoRoot = process.cwd();
  const failures: string[] = [];
  const notes: string[] = [];

  heading('wireup · 3D live surfaces');

  /* ---- 0. inputs -------------------------------------------------------- */
  const sources = collectLiveSurfaceSources(repoRoot);
  const tablePath = sources.outputPath;
  if (!fs.existsSync(tablePath)) {
    console.error(`live-surface table missing at ${path.relative(repoRoot, tablePath)} — run \`pnpm export:live-surfaces\``);
    return 1;
  }
  const file = readJson<LiveSurfacesPayload & { version: number; generatedAt: string }>(tablePath);
  const rebuilt = buildLiveSurfaces(sources);

  const manifest = readJson<{ models: Record<string, ManifestEntry> }>(
    path.join(MODELS_DIR, 'manifest.json'),
  ).models;
  const surfaceTypesPath = path.join(repoRoot, VELXIO_FRONTEND, 'src', 'scene3d', 'live', 'surfaceTypes.ts');
  const { members, literals } = schemaMembers(surfaceTypesPath);

  /* ---- 1. drift --------------------------------------------------------- */
  if (file.version !== LIVE_SURFACES_VERSION) {
    failures.push(`table version ${file.version} != generator version ${LIVE_SURFACES_VERSION}`);
  }
  // The consumer mirrors the schema AND declares which version of it it
  // understands. Two independent numbers (Wireup's generator, Velxio's
  // renderer) can only meet if both are pinned to each other here.
  const velxioVersion = /LIVE_SURFACE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(
    fs.readFileSync(surfaceTypesPath, 'utf-8'),
  )?.[1];
  if (velxioVersion === undefined) {
    failures.push('Velxio\'s surfaceTypes.ts declares no LIVE_SURFACE_SCHEMA_VERSION (the renderer cannot detect a stale manifest)');
  } else if (Number(velxioVersion) !== LIVE_SURFACES_VERSION) {
    failures.push(
      `schema version skew: Wireup generates version ${LIVE_SURFACES_VERSION}, Velxio's renderer expects ${velxioVersion}`,
    );
  }
  // The renderer only draws the kinds it lists; a new kind added on one side
  // must be added on the other or the surface silently never renders.
  const velxioKinds = [
    ...(fs
      .readFileSync(surfaceTypesPath, 'utf-8')
      .match(/SURFACE_KINDS[^=]*=\s*\[([\s\S]*?)\]/)?.[1] ?? '')
      .matchAll(/'([a-z-]+)'/g),
  ].map((match) => match[1]!);
  const tableKinds = [...new Set(Object.values(file.parts).flatMap((part) => (part.surfaces ?? []).map((surface) => surface.kind)))];
  const unknownKinds = tableKinds.filter((kind) => !velxioKinds.includes(kind));
  if (unknownKinds.length > 0) {
    failures.push(`the table uses surface kind(s) the renderer does not list: ${unknownKinds.join(', ')}`);
  }
  const generated = JSON.stringify({ parts: file.parts, noLiveState: file.noLiveState });
  const expected = JSON.stringify(rebuilt);
  if (generated !== expected) {
    const actualKeys = Object.keys(file.parts);
    const wantedKeys = Object.keys(rebuilt.parts);
    const added = wantedKeys.filter((key) => !actualKeys.includes(key));
    const removed = actualKeys.filter((key) => !wantedKeys.includes(key));
    const changed = wantedKeys.filter(
      (key) => actualKeys.includes(key) && JSON.stringify(rebuilt.parts[key]) !== JSON.stringify(file.parts[key]),
    );
    failures.push(
      `table is out of date (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}; changed: ${changed.join(', ') || 'none'}) — run \`pnpm export:live-surfaces\``,
    );
  }

  /* ---- 2. coverage ------------------------------------------------------ */
  const cadKeys = [...sources.cad.keys()];
  const withSurfaces = Object.keys(file.parts);
  const inert = Object.keys(file.noLiveState);
  for (const key of cadKeys) {
    const hasSurfaces = Object.prototype.hasOwnProperty.call(file.parts, key);
    const hasReason = Object.prototype.hasOwnProperty.call(file.noLiveState, key);
    if (hasSurfaces && hasReason) failures.push(`"${key}" is both driven and declared inert`);
    if (!hasSurfaces && !hasReason) failures.push(`"${key}" is not covered by the table at all`);
  }
  for (const key of [...withSurfaces, ...inert]) {
    if (!sources.cad.has(key)) failures.push(`"${key}" is in the table but not a CAD key the bench renders`);
  }
  for (const key of withSurfaces) {
    const part = file.parts[key] as PartLiveSurfaces;
    if (!part.surfaces?.length) failures.push(`"${key}" has an empty surface list — omit it or declare it inert`);
  }
  for (const key of inert) {
    if (!(file.noLiveState[key] ?? '').trim()) failures.push(`"${key}" is declared inert with an empty reason`);
  }

  /* ---- 3+4. signals and anchors ----------------------------------------- */
  const signalChecks: { part: string; surface: string; signal: string }[] = [];
  const anchorChecks: { part: string; surface: string; anchor: string }[] = [];

  const checkSignal = (key: string, tag: string, where: string, raw: string): void => {
    signalChecks.push({ part: key, surface: where, signal: raw });
    const entry = sources.evidence.get(key);
    const declared = new Set(sources.elementProps.get(tag) ?? []);
    if (raw.startsWith('store:')) {
      const name = raw.slice('store:'.length);
      if (!(entry?.store.has(name) ?? false) && !sources.allStoreKeys.has(name)) {
        failures.push(`"${key}" ${where}: no part mirrors \`${name}\` into the render store`);
      }
      return;
    }
    if (raw.startsWith('bag:')) {
      const name = raw.slice('bag:'.length);
      const emitted =
        (entry?.bag.has(name) ?? false) ||
        [...sources.evidence.values()].some((evidence) => evidence.bag.has(name));
      if (!emitted) failures.push(`"${key}" ${where}: nothing emits \`${name}\` into the property bag`);
      return;
    }
    if (raw.startsWith('pin:')) {
      const name = raw.slice('pin:'.length);
      const pins = new Set((sources.cad.get(key)?.spec?.pins ?? []).map((pin) => pin.name));
      if (!pins.has(name)) {
        failures.push(`"${key}" ${where}: the CAD spec has no pin named "${name}" (has: ${[...pins].join(', ')})`);
      }
      return;
    }
    // Three producers can answer a bare name: the element's own declared
    // property (read off the live DOM element), the part's simulator writes, and
    // the live-state producer that publishes activity for the parts the emulator
    // has no model for (`simulation/liveState`'s declared payload).
    const produced =
      declared.has(raw) ||
      (entry?.element.has(raw) ?? false) ||
      (entry?.methods.has(raw) ?? false) ||
      sources.allStoreKeys.has(raw);
    if (!produced) {
      failures.push(
        `"${key}" ${where}: "${raw}" is neither a declared property of <${tag}>, nor written by the part's simulator code, nor published by the live-state producer`,
      );
    }
  };

  const checkAnchor = (key: string, where: string, surface: LiveSurface): void => {
    const anchor = surface.anchor;
    const entry = sources.cad.get(key) as CadCatalogEntry;
    const features = entry.spec?.features ?? [];
    anchorChecks.push({ part: key, surface: where, anchor: `${anchor.frame}${anchor.feature ? `:${anchor.feature}` : ''}` });
    if (anchor.frame === 'spec') {
      if (!isSpecGenerated(key, manifest)) {
        failures.push(
          `"${key}" ${where}: a \`spec\` anchor needs an asset generated from that spec, but the 3D model is "${manifest[key]?.file ?? 'none'}"`,
        );
      }
      if (!anchor.feature) {
        failures.push(`"${key}" ${where}: a \`spec\` anchor must name a feature`);
      } else {
        const match = features.some(
          (feature) => feature.type === anchor.feature || feature.name === anchor.feature,
        );
        if (!match) {
          failures.push(
            `"${key}" ${where}: the spec has no feature "${anchor.feature}" (has: ${features.map((f) => f.name).join(', ')})`,
          );
        }
      }
      return;
    }
    if (!anchor.feature && !anchor.node && !anchor.bodyTop) {
      failures.push(`"${key}" ${where}: a \`model\` anchor must name a feature/node or set bodyTop`);
    }
  };

  const checkSurface = (key: string, tag: string, surface: LiveSurface): void => {
    const where = `surface "${surface.id}"`;
    if (!surface.id) failures.push(`"${key}": a surface has no id`);
    checkAnchor(key, where, surface);

    const wants: Record<string, 'display' | 'emissive' | 'motion' | 'readout'> = {
      'text-grid': 'display',
      'image-data': 'display',
      canvas: 'display',
      'rgb-pixels': 'display',
      segments: 'display',
      'bar-graph': 'display',
      emissive: 'emissive',
      motion: 'motion',
      readout: 'readout',
    };
    const required = wants[surface.kind];
    if (!required) {
      failures.push(`"${key}" ${where}: unknown kind "${surface.kind}"`);
      return;
    }
    if (!surface[required]) failures.push(`"${key}" ${where}: kind "${surface.kind}" needs a \`${required}\` block`);

    const display = surface.display;
    if (display) {
      const names: (string | undefined)[] = [];
      switch (surface.kind) {
        case 'text-grid':
          names.push(display.characters, display.font);
          if (!display.cols || !display.rows) failures.push(`"${key}" ${where}: a text grid needs cols and rows`);
          break;
        case 'image-data':
          names.push(display.imageData);
          if (!display.width || !display.height) failures.push(`"${key}" ${where}: image-data needs width and height`);
          break;
        case 'canvas':
          names.push(display.canvas);
          break;
        case 'rgb-pixels':
          if (display.pixels !== true) failures.push(`"${key}" ${where}: rgb-pixels needs \`pixels: true\``);
          if (display.layout === 'matrix' && (!display.rows || !display.cols)) {
            failures.push(`"${key}" ${where}: a matrix layout needs rows and cols`);
          }
          break;
        case 'segments':
          names.push(display.values, display.digits);
          break;
        case 'bar-graph':
          names.push(display.values);
          break;
        default:
          break;
      }
      names.push(
        display.colon,
        display.colonValue,
        display.colonVisible,
        display.backlight,
        display.cursor,
        display.cursorX,
        display.cursorY,
        display.blink,
      );
      for (const name of names) if (name) checkSignal(key, tag, where, name);
    }

    const emissive = surface.emissive;
    if (emissive) {
      const arity: Record<string, number> = { brightness: 1, boolean: 1, 'value-fraction': 1, rgb255: 3, rgb01: 3 };
      const expectedCount = arity[emissive.mode] ?? emissive.props.length;
      if (emissive.mode !== 'channels' && emissive.props.length !== expectedCount) {
        failures.push(`"${key}" ${where}: emissive mode "${emissive.mode}" takes ${expectedCount} props`);
      }
      if (emissive.mode === 'channels' && (emissive.colors?.length ?? 0) !== emissive.props.length) {
        failures.push(`"${key}" ${where}: "channels" needs one colour per channel`);
      }
      for (const prop of emissive.props) checkSignal(key, tag, where, prop);
      if (emissive.colorProp) checkSignal(key, tag, where, emissive.colorProp);
    }

    const motion = surface.motion;
    if (motion) {
      if (!motion.props.length) failures.push(`"${key}" ${where}: motion needs a property`);
      for (const prop of motion.props) checkSignal(key, tag, where, prop);
      if (motion.mode === 'angle' && !motion.range) {
        failures.push(`"${key}" ${where}: an angle motion needs its degree range`);
      }
    }

    const readout = surface.readout;
    if (readout) {
      if (!readout.rows.length) failures.push(`"${key}" ${where}: a readout needs rows`);
      for (const row of readout.rows) {
        if (!row.label) failures.push(`"${key}" ${where}: a readout row has no label`);
        if (!row.prop) failures.push(`"${key}" ${where}: readout row "${row.label}" has no property`);
        else checkSignal(key, tag, where, row.prop);
      }
    }
  };

  for (const key of withSurfaces) {
    const part = file.parts[key] as PartLiveSurfaces;
    const entry = sources.cad.get(key) as CadCatalogEntry;
    const expectedTag = entry.cadOnly ? 'velxio-cad-bench-part' : sources.tagByKey.get(key);
    if (!part.tag) {
      failures.push(`"${key}": no element tag recorded (provenance for every signal)`);
    } else if (part.tag !== expectedTag) {
      failures.push(`"${key}": tag "${part.tag}" != the tag the catalog allocates ("${expectedTag}")`);
    } else if (!sources.elementProps.has(part.tag)) {
      failures.push(`"${key}": tag "${part.tag}" has no captured property surface`);
    }
    for (const surface of part.surfaces) checkSurface(key, part.tag ?? '', surface);
  }

  /* ---- 5. schema mirror ------------------------------------------------- */
  const allowed = new Set([
    ...members,
    'version',
    'generatedAt',
    'parts',
    'noLiveState',
    'id',
    'kind',
    'anchor',
    'display',
    'emissive',
    'motion',
    'readout',
    'style',
    'surfaces',
    'tag',
    'name',
    'visible',
    'reason',
  ]);
  const enumKeys = new Set(['frame', 'face', 'layout', 'axis', 'mode', 'kind']);
  /** Keys of a map container (catalog keys), not members of a schema object. */
  const walk = (node: unknown, where: string, depth: number, mapKeys = false): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${where}[${index}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!mapKeys && !allowed.has(key)) {
        failures.push(`table member "${key}" (at ${where}) is unknown to Velxio's surfaceTypes.ts`);
      }
      if (enumKeys.has(key) && typeof value === 'string' && literals.size > 0 && !literals.has(value)) {
        failures.push(`table value "${value}" for "${key}" (at ${where}) is not a literal Velxio accepts`);
      }
      walk(value, `${where}.${key}`, depth + 1);
    }
  };
  walk(file.parts, 'parts', 0, true);
  walk(file.noLiveState, 'noLiveState', 0, true);

  /* ---- report ----------------------------------------------------------- */
  console.log(`CAD keys                : ${cadKeys.length}`);
  console.log(`parts with live state   : ${withSurfaces.length} (${Object.values(file.parts).reduce((n, p) => n + p.surfaces.length, 0)} surfaces, ${signalChecks.length} signals, ${anchorChecks.length} anchors)`);
  console.log(`declared inert          : ${inert.length}`);
  console.log(`registered, not in 3D   : ${[...sources.registeredIds].filter((id) => !sources.cad.has(id)).length} (Velxio registers behaviour, but the bench has no CAD key/geometry for them)`);
  if (sources.tagsMissingProperties.length > 0) {
    notes.push(`${sources.tagsMissingProperties.length} element tags declare no readable property (expected for pure wiring parts)`);
  }

  const inertByReason = new Map<string, string[]>();
  for (const key of inert) {
    const reason = file.noLiveState[key] as string;
    const group = inertByReason.get(reason) ?? [];
    group.push(key);
    inertByReason.set(reason, group);
  }
  console.log('\ninert parts, by reason:');
  for (const [reason, keys] of inertByReason) {
    const sorted = keys.sort();
    const shown = sorted.slice(0, 4).join(', ');
    console.log(`  · ${String(keys.length).padStart(2)}× ${reason}`);
    console.log(`       ${shown}${sorted.length > 4 ? `, +${sorted.length - 4} more` : ''}`);
  }
  if (notes.length > 0) console.log(`\nnotes:\n${notes.join('\n')}`);

  const driven = new Set(withSurfaces);
  for (const id of sources.registeredIds) {
    if (!sources.cad.has(id) && driven.has(id)) failures.push(`"${id}" has surfaces but no CAD key — the 3D bench cannot render it`);
  }

  if (failures.length > 0) {
    heading(`FAIL (${failures.length})`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    return 1;
  }
  heading('ok');
  console.log('every CAD key is either driven by a verified signal or declared inert with a reason');
  return 0;
}

process.exit(main());
