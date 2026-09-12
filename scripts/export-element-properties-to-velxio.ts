/**
 * Export the LIVE PROPERTY SURFACE of every element the pinned Velxio build
 * can instantiate.
 *
 *   pnpm export:element-properties
 *
 * Writes `external/velxio/frontend/public/element-properties.json`:
 *
 *   { version, generatedAt, packages: { '@wokwi/elements': '1.9.2' },
 *     elements: { 'wokwi-lcd1602': { props: ['characters', …], source: 'npm' },
 *                 'velxio-gps-neo6m': { props: ['lat', …], source: 'vendored' } } }
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The 3D view reads a part's live state off the very element the 2D canvas
 * renders (`el.characters`, `el.imageData`, `el.brightness`, …). Which
 * properties exist on that element is therefore a contract, and a table that
 * reads `el.characters` on an element that renamed it would silently show a
 * black screen forever.
 *
 * The typings that prove the contract live in `node_modules`, which this repo
 * does NOT commit (and the verify gates must run offline), so the contract is
 * captured here once and committed — the same pattern as
 * `components-metadata.json`. `pnpm verify:3d-live` then proves every signal in
 * Wireup's live-surface table is a declared property of the element it comes
 * from, with no network and no node_modules.
 *
 * Sources, per tag:
 *   • `wokwi-*` — the pinned `@wokwi/elements` package's generated `.d.ts`
 *     (public class fields/accessors; methods and Lit internals excluded);
 *   • `velxio-*` — the vendored element classes under
 *     `external/velxio/frontend/src/{velxio-elements,components/velxio-components}`.
 *
 * Nothing is invented: a tag whose properties cannot be read is reported and
 * simply absent from the file (the gate then refuses a surface that needs it).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const FRONTEND = path.resolve(__dirname, '../external/velxio/frontend');
const WOKWI_DIST = path.join(FRONTEND, 'node_modules', '@wokwi', 'elements', 'dist', 'esm');
const OUT_PATH = path.join(FRONTEND, 'public', 'element-properties.json');

interface ElementEntry {
  props: string[];
  source: 'npm' | 'vendored';
  /** The file the contract was read from (provenance). */
  file: string;
}

interface PropertiesFile {
  version: number;
  generatedAt: string;
  packages: Record<string, string>;
  elements: Record<string, ElementEntry>;
}

/** Properties every custom element has but no part simulation ever reads. */
const ALWAYS_EXCLUDED = new Set([
  'renderRoot',
  'shadowRoot',
  'updateComplete',
  'hasUpdated',
  'isUpdatePending',
  'attribute',
  'pinInfo',
  'pins',
]);

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/** Public class members declared by a TypeScript source, in declaration order. */
function declaredMembers(text: string): string[] {
  const out: string[] = [];
  // Class fields: `    name: type;` / `= value;` and accessors `get name()`.
  for (const match of text.matchAll(/^\s{2,4}(?:declare\s+)?(?:readonly\s+)?([a-zA-Z_$][\w$]*)\??\s*[:=]/gm)) {
    out.push(match[1] as string);
  }
  for (const match of text.matchAll(/^\s{2,4}(?:get|set)\s+([a-zA-Z_$][\w$]*)\s*\(/gm)) {
    out.push(match[1] as string);
  }
  return out.filter((name) => !name.startsWith('_') && !ALWAYS_EXCLUDED.has(name));
}

/** Recursively list source files under a directory. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Property names a class really has at runtime: its own, plus everything it
 * inherits.
 *
 * The typings only declare what a subclass adds — `LCD2004Element extends
 * LCD1602Element` declares two protected fields and nothing else, while the
 * element genuinely carries `characters`, `backlight`, `font`, … from its base.
 * Reading only the leaf class would report a display with no properties at all,
 * which is exactly how a 3D table ends up unable to reference a real signal.
 */
function resolveInheritedProps(
  className: string,
  classes: Map<string, { props: string[]; base?: string }>,
  seen = new Set<string>(),
): string[] {
  const entry = classes.get(className);
  if (!entry || seen.has(className)) return [];
  seen.add(className);
  const inherited = entry.base ? resolveInheritedProps(entry.base, classes, seen) : [];
  return [...new Set([...entry.props, ...inherited])];
}

/** `class Foo extends Bar` / `export class Foo extends Bar`. */
function classHeads(text: string): { name: string; base?: string }[] {
  const out: { name: string; base?: string }[] = [];
  for (const match of text.matchAll(/class\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([A-Za-z_$][\w$.]*))?/g)) {
    if (!match[1]) continue;
    out.push({ name: match[1], ...(match[2] ? { base: (match[2].split('.')[0] as string) } : {}) });
  }
  return out;
}

function main(): number {
  heading('wireup · element property surface → Velxio public assets');

  const elements: Record<string, ElementEntry> = {};
  const packageVersions: Record<string, string> = {};
  /** Every class seen while reading, for the `extends` chain resolution. */
  const classes = new Map<string, { props: string[]; base?: string }>();

  /* ---- 1. upstream npm elements (the typings ARE the contract) ---------- */
  if (fs.existsSync(WOKWI_DIST)) {
    const pkg = readJson<{ version?: string }>(path.join(FRONTEND, 'node_modules', '@wokwi', 'elements', 'package.json'));
    packageVersions['@wokwi/elements'] = pkg.version ?? 'unknown';
    /** tag → the element class declared by `tag-element.d.ts`. */
    const classByTag = new Map<string, string>();
    const dtsFiles = fs
      .readdirSync(WOKWI_DIST)
      .filter((file) => file.endsWith('-element.d.ts') && !file.endsWith('.spec.d.ts'));
    for (const file of dtsFiles) {
      const text = fs.readFileSync(path.join(WOKWI_DIST, file), 'utf-8');
      const heads = classHeads(text);
      for (const head of heads) {
        // A later file never overrides an earlier declaration of the same class.
        if (!classes.has(head.name)) {
          classes.set(head.name, { props: declaredMembers(text), ...(head.base ? { base: head.base } : {}) });
        }
      }
      const fileName = file.replace(/-element\.d\.ts$/, '');
      const elementClass = heads[0]?.name;
      if (elementClass) classByTag.set(`wokwi-${fileName}`, elementClass);
    }
    let count = 0;
    for (const [tag, className] of classByTag) {
      elements[tag] = {
        props: resolveInheritedProps(className, classes).sort(),
        source: 'npm',
        file: `node_modules/@wokwi/elements/dist/esm/${tag.replace(/^wokwi-/, '')}-element.d.ts`,
      };
      count += 1;
    }
    console.log(`npm elements read   : ${count} (from @wokwi/elements@${packageVersions['@wokwi/elements']})`);
  } else {
    console.warn('@wokwi/elements is not installed — run `pnpm install` in external/velxio/frontend first');
    console.warn('(the npm half of the file cannot be regenerated without it)');
  }

  /* ---- 2. vendored velxio-* elements ------------------------------------ */
  const vendoredRoots = [
    path.join(FRONTEND, 'src', 'velxio-elements'),
    path.join(FRONTEND, 'src', 'components', 'velxio-components'),
    path.join(FRONTEND, 'src', 'components', 'customChips'),
  ];
  let vendoredCount = 0;
  for (const root of vendoredRoots) {
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, 'utf-8');
      const heads = classHeads(text);
      for (const head of heads) {
        classes.set(head.name, { props: declaredMembers(text), ...(head.base ? { base: head.base } : {}) });
      }
      // `customElements.define('tag', Class)` and the local `def('tag', Class)`
      // helper both appear in the vendored elements.
      const tagAndClass: [string, string][] = [];
      for (const match of text.matchAll(/customElements\.define\(\s*'([a-z0-9-]+)'\s*,\s*([A-Za-z_$][\w$]*)/g)) {
        if (match[1] && match[2]) tagAndClass.push([match[1], match[2]]);
      }
      for (const match of text.matchAll(/^\s*def\(\s*'([a-z0-9-]+)'\s*,\s*([A-Za-z_$][\w$]*)/gm)) {
        if (match[1] && match[2]) tagAndClass.push([match[1], match[2]]);
      }
      const propsByClass = (name: string): string[] => resolveInheritedProps(name, classes).sort();
      const fallback = declaredMembers(text).sort();
      for (const [tag, className] of tagAndClass) {
        // First writer wins: a tag defined twice is a build error elsewhere.
        if (!elements[tag]) {
          const props = classes.has(className) ? propsByClass(className) : fallback;
          elements[tag] = { props, source: 'vendored', file: path.relative(FRONTEND, file) };
          vendoredCount += 1;
        }
      }
    }
  }
  console.log(`vendored elements   : ${vendoredCount}`);
  console.log(`elements total      : ${Object.keys(elements).length}`);

  const payload: PropertiesFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    packages: packageVersions,
    elements,
  };

  // Keep the file's element order stable so a re-run is a no-op.
  const ordered: Record<string, ElementEntry> = {};
  for (const tag of Object.keys(elements).sort()) ordered[tag] = elements[tag] as ElementEntry;
  payload.elements = ordered;

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 1)}\n`, 'utf-8');
  console.log(`\nwritten             : ${path.relative(process.cwd(), OUT_PATH)}`);
  return 0;
}

process.exit(main());
