// @vitest-environment jsdom
/**
 * The CAD bench catalog — the contract the 3D view and the 2D element both
 * read. Two files ship every non-emulated catalog part to Velxio:
 *
 *   • `public/cad-catalog.json` — the spec per key (body, dimensions, every
 *     pin's millimetre anchor). The 3D view builds the parametric assembly
 *     from it, and `<velxio-cad-bench-part>` draws its 2D symbol from it;
 *   • `public/models3d/<key>/…` — a generated GLB (+ STL + spec.json) whose
 *     named pin-anchor nodes are what `resolvePinWorld` looks up when a wire
 *     is drawn to that part.
 *
 * Wireup writes both (`pnpm export:cad-catalog`, `pnpm export:cad-models`) and
 * `pnpm verify:cad-sim-link` checks them from that side. This test is the
 * other half: it proves Velxio can actually CONSUME them, so a part can never
 * arrive with no body, no anchors, or anchors the GLB does not have.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Box3, Group, Vector3 } from 'three';
import { buildParametricAssembly } from '../scene3d/cadParametric';
import type { CadComponentSpec } from '../scene3d/cadTypes';

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const CATALOG_PATH = path.join(PUBLIC_DIR, 'cad-catalog.json');
const MANIFEST_PATH = path.join(PUBLIC_DIR, 'models3d/manifest.json');

interface CatalogEntry {
  catalogId: string;
  kind: 'board' | 'part';
  tier: string;
  cadOnly: boolean;
  canvasPlaced: boolean;
  spec: CadComponentSpec;
}

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as {
  version: number;
  entries: Record<string, CatalogEntry>;
};
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as {
  models: Record<string, { file: string; pinNodes?: string[]; generated?: boolean }>;
};

const entries = Object.entries(catalog.entries);
const partEntries = entries.filter(([, entry]) => entry.kind === 'part');

/** Node names declared by a GLB (the names `getObjectByName` resolves). */
function glbNodeNames(file: string): string[] {
  const buffer = fs.readFileSync(file);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf-8')) as {
    nodes?: { name?: string }[];
  };
  return (gltf.nodes ?? []).map((node) => node.name).filter((name): name is string => Boolean(name));
}

describe('cad-catalog.json', () => {
  it('is keyed once per part, with the catalog id the exporter uses', () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const [key, entry] of entries) {
      expect(entry.spec.id, `${key} spec.id`).toBeTruthy();
      expect(entry.catalogId, `${key} catalogId`).toBeTruthy();
      // A CAD bench part is keyed by its own catalog id; a simulated part is
      // keyed by the emulator's metadataId (a different, disjoint space).
      if (entry.cadOnly) expect(key, `${key} must be its own catalog id`).toBe(entry.catalogId);
    }
  });

  it('gives every part real, positive dimensions', () => {
    for (const [key, entry] of partEntries) {
      const { widthMm, lengthMm, heightMm } = entry.spec.dimensions;
      for (const [label, value] of Object.entries({ widthMm, lengthMm, heightMm })) {
        expect(Number.isFinite(value) && value > 0, `${key} ${label}=${value}`).toBe(true);
      }
    }
  });

  it('builds a non-empty parametric body for every part — never an empty mesh', () => {
    for (const [key, entry] of partEntries) {
      const group = buildParametricAssembly(entry.spec);
      expect(group, `${key} group`).toBeInstanceOf(Group);
      expect(group.children.length, `${key} has no mesh`).toBeGreaterThan(0);
      const box = new Box3().setFromObject(group);
      const size = box.getSize(new Vector3());
      expect(size.x + size.y + size.z, `${key} degenerate bounds`).toBeGreaterThan(0);
    }
  });

  it('names a pin-anchor node for every declared pin (the GLB anchor contract)', () => {
    for (const [key, entry] of partEntries) {
      const group = buildParametricAssembly(entry.spec);
      for (const pin of entry.spec.pins) {
        const anchor = group.getObjectByName(pin.name);
        expect(anchor, `${key}: no 3D anchor for pin "${pin.name}"`).toBeTruthy();
      }
    }
  });
});

describe('models3d manifest + generated GLBs', () => {
  it('has a model file on disk for every catalog key it registers', () => {
    for (const [key, model] of Object.entries(manifest.models)) {
      expect(catalog.entries[key], `${key} is registered but not in the catalog`).toBeTruthy();
      const file = path.join(PUBLIC_DIR, 'models3d', model.file);
      expect(fs.existsSync(file), `${key}: missing ${model.file}`).toBe(true);
      expect(fs.statSync(file).size, `${key}: empty ${model.file}`).toBeGreaterThan(0);
    }
  });

  it('gives every CAD bench part a model, and every generated GLB its anchors', () => {
    for (const [key, entry] of partEntries) {
      if (!entry.cadOnly) continue;
      const model = manifest.models[key];
      expect(model, `${key}: CAD bench part has no model`).toBeTruthy();
      const file = path.join(PUBLIC_DIR, 'models3d', model.file);
      expect(fs.existsSync(file), `${key}: missing ${model.file}`).toBe(true);

      if (!model.generated) continue;
      const nodes = new Set(glbNodeNames(file));
      for (const pin of entry.spec.pins) {
        expect(nodes.has(pin.name), `${key}: generated GLB has no "${pin.name}" anchor node`).toBe(true);
      }
    }
  });
});
