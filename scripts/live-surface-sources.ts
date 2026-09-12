/**
 * Collector for everything the live-surface table is built from and checked
 * against. Shared by `pnpm export:live-surfaces` and `pnpm verify:3d-live` so
 * the generator and the gate cannot read the world differently.
 *
 * All inputs are in-repo: Wireup's own generated catalog assets
 * (`/cad-catalog.json`, `/components-metadata.json`,
 * `/element-properties.json` — all under the vendored Velxio's `public/`, next
 * to the file this table is exported to) plus the vendored Velxio part source.
 * No node_modules, no network.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  scanPartSource,
  type CadCatalogEntry,
  type LiveSurfaceSources,
} from '../src/modules/simulation/live-surfaces';

const VELXIO_FRONTEND = path.join('external', 'velxio', 'frontend');

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

export interface CollectedSources extends LiveSurfaceSources {
  /** Path of the table this build produces / checks. */
  outputPath: string;
  /** Element tags with no captured property surface (should be none). */
  tagsMissingProperties: string[];
}

export function collectLiveSurfaceSources(repoRoot: string): CollectedSources {
  const frontend = path.join(repoRoot, VELXIO_FRONTEND);
  const publicDir = path.join(frontend, 'public');

  const catalog = readJson<{ entries: Record<string, CadCatalogEntry> }>(
    path.join(publicDir, 'cad-catalog.json'),
  );
  const metadata = readJson<{ components?: { id: string; tagName: string }[] } | { id: string; tagName: string }[]>(
    path.join(publicDir, 'components-metadata.json'),
  );
  const properties = readJson<{ elements: Record<string, { props: string[] }> }>(
    path.join(publicDir, 'element-properties.json'),
  );

  const metadataList = Array.isArray(metadata) ? metadata : (metadata.components ?? []);
  const tagByKey = new Map<string, string>();
  for (const entry of metadataList) tagByKey.set(entry.id, entry.tagName);

  const elementProps = new Map<string, string[]>();
  const tagsMissingProperties: string[] = [];
  for (const [tag, entry] of Object.entries(properties.elements ?? {})) {
    elementProps.set(tag, entry.props ?? []);
    if ((entry.props ?? []).length === 0) tagsMissingProperties.push(tag);
  }

  const partsDir = path.join(frontend, 'src', 'simulation', 'parts');
  const partFiles = fs.existsSync(partsDir)
    ? listSourceFiles(partsDir).map((file) => ({ path: file, text: fs.readFileSync(file, 'utf-8') }))
    : [];

  const { registeredIds, evidence, allStoreKeys } = scanPartSource(partFiles);

  // The second producer: `simulation/liveState` publishes the parts the emulator
  // has no model for. Its contract is the interface it declares, so that is what
  // is read — a renamed key there fails the gate instead of darkening a surface.
  const liveStateDir = path.join(frontend, 'src', 'simulation', 'liveState');
  for (const file of fs.existsSync(liveStateDir) ? listSourceFiles(liveStateDir) : []) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const block of text.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
      if (block[1] !== 'PartLiveState') continue;
      for (const member of (block[2] ?? '').matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??\s*:/gm)) {
        if (member[1]) allStoreKeys.add(member[1]);
      }
    }
  }

  return {
    cad: new Map(Object.entries(catalog.entries)),
    tagByKey,
    elementProps,
    registeredIds,
    evidence,
    allStoreKeys,
    outputPath: path.join(publicDir, 'live-surfaces.json'),
    tagsMissingProperties,
  };
}
