/**
 * live-surfaces — the table that tells Velxio's 3D scene how to show every
 * catalog part's live state.
 *
 *   pnpm export:live-surfaces   → external/velxio/frontend/public/live-surfaces.json
 *   pnpm verify:3d-live         → proves the file is in sync AND every signal
 *                                 in it has a real producer in the vendored
 *                                 simulator source
 *
 * WHY THIS LIVES IN WIREUP
 * ------------------------
 * The 2D canvas already renders every part from a web component whose
 * properties the simulation writes (`el.characters`, `el.brightness`,
 * `el.imageData`, `el.setValue`…). The 3D view must show the SAME state, not a
 * second guess at it. Which property means what, and WHERE on the body it
 * belongs, is design metadata — so it is AUTHORED HERE, in the project that
 * owns the catalog, and shipped to Velxio as data. Velxio's scene contains no
 * per-part branch: it looks up the key it was given and renders whatever the
 * table declares.
 *
 * WHAT "AUTHORED" DOES NOT MEAN
 * -----------------------------
 * Nothing in here is asserted on faith. `collectLiveSurfaceSources` reads:
 *
 *   • `/cad-catalog.json`            — the CAD key space and every spec feature;
 *   • `/components-metadata.json`    — catalog key → element tag;
 *   • `/element-properties.json`     — every property those element tags declare
 *                                      (captured from the pinned @wokwi typings
 *                                      and the vendored element classes);
 *   • the vendored part source       — the properties each part's OWN
 *                                      `PartSimulationRegistry.register(...)`
 *                                      block writes on its element, the keys it
 *                                      emits through `emitPropertyChange`, and
 *                                      the keys it mirrors into the transient
 *                                      render store.
 *
 * `pnpm verify:3d-live` then refuses a table whose signal names a property that
 * no one writes, a `store:`/`bag:`/`pin:` key with no producer, or an anchor on
 * a feature the spec does not have. A renamed property in Velxio is a build
 * failure here instead of a display that is silently dark forever.
 *
 * SIGNAL NAMESPACES (resolved by Velxio's scene3d/live/signals.ts)
 * ---------------------------------------------------------------
 *   `characters`        — element property (or a store mirror of the same name)
 *   `store:pixels`      — `usePartRenderStore` value the part mirrors
 *   `bag:temperature`   — component property bag (`emitPropertyChange`)
 *   `pin:OUT`           — the board GPIO this component pin's net traces to
 */

export const LIVE_SURFACES_VERSION = 1;

/* ────────────────────────────── schema mirror ──────────────────────────────
 * Velxio consumes this as JSON; the interfaces mirror
 * `external/velxio/frontend/src/scene3d/live/surfaceTypes.ts` so both sides
 * stay legible. `verify:3d-live` compares the member names emitted here against
 * that file, so the two cannot drift silently. */

export interface LiveAnchor {
  frame: 'spec' | 'model';
  feature?: string;
  node?: string;
  face?: 'top' | 'front' | 'center';
  bodyTop?: boolean;
  offsetMm?: [number, number, number];
  rotationDeg?: [number, number, number];
  scale?: number;
}

export interface DisplaySource {
  characters?: string;
  font?: string;
  colon?: string;
  colonValue?: string;
  colonVisible?: string;
  backlight?: string;
  cursor?: string;
  cursorX?: string;
  cursorY?: string;
  blink?: string;
  cols?: number;
  rows?: number;
  imageData?: string;
  width?: number;
  height?: number;
  canvas?: string;
  pixels?: boolean;
  layout?: 'single' | 'strip' | 'ring' | 'matrix';
  values?: string;
  digits?: string;
}

export interface EmissiveSource {
  mode: 'brightness' | 'boolean' | 'rgb255' | 'rgb01' | 'channels' | 'value-fraction';
  props: string[];
  colors?: string[];
  color?: string;
  colorProp?: string;
  onValue?: unknown;
  max?: number;
  valueRange?: [number, number];
}

export interface MotionSource {
  /** `spin` integrates a rate over real time (a driven shaft keeps turning);
   *  `rotate` places a node at an absolute angle (a stepper's shaft position). */
  mode: 'angle' | 'fraction' | 'press' | 'tilt' | 'spin' | 'rotate';
  props: string[];
  range?: [number, number];
  valueRange?: [number, number];
  axis?: 'x' | 'y' | 'z';
  invert?: boolean;
  /** `spin`: drive below which the shaft is treated as stopped (default 0.02). */
  deadband?: number;
}

export interface ReadoutRow {
  label: string;
  prop: string;
  unit?: string;
  precision?: number;
}

export interface ReadoutSource {
  rows: ReadoutRow[];
  selectedOnly?: boolean;
}

export interface SurfaceStyle {
  textColor?: string;
  offColor?: string;
  backlightColor?: string;
  onColor?: string;
  dimColor?: string;
  glowMm?: number;
  labelColor?: string;
  opacity?: number;
}

export type SurfaceKind =
  | 'text-grid'
  | 'image-data'
  | 'canvas'
  | 'rgb-pixels'
  | 'segments'
  | 'bar-graph'
  | 'emissive'
  | 'motion'
  | 'readout';

export interface LiveSurface {
  id: string;
  kind: SurfaceKind;
  anchor: LiveAnchor;
  display?: DisplaySource;
  emissive?: EmissiveSource;
  motion?: MotionSource;
  readout?: ReadoutSource;
  style?: SurfaceStyle;
}

export interface PartLiveSurfaces {
  tag?: string;
  name?: string;
  surfaces: LiveSurface[];
}

export interface LiveSurfacesPayload {
  parts: Record<string, PartLiveSurfaces>;
  noLiveState: Record<string, string>;
}

/* ───────────────────────────── source evidence ───────────────────────────── */

export interface CadCatalogEntry {
  catalogId: string;
  kind: 'board' | 'part';
  tier?: string;
  cadOnly?: boolean;
  canvasPlaced?: boolean;
  spec?: {
    pins?: { name: string }[];
    features?: { type: string; name: string }[];
  };
}

/** What one part's own simulation code actually touches. */
export interface PartEvidence {
  /** Element properties it writes (`el.characters = …`). */
  element: Set<string>;
  /** Element methods it calls that carry state (`el.setPixel(…)`). */
  methods: Set<string>;
  /** Property-bag keys it emits (`emitPropertyChange(id, 'value', …)`). */
  bag: Set<string>;
  /** Render-store keys it mirrors (`setValue(id, { angle })`). */
  store: Set<string>;
}

export interface LiveSurfaceSources {
  cad: Map<string, CadCatalogEntry>;
  /** catalog key / metadataId → element tag. */
  tagByKey: Map<string, string>;
  /** element tag → declared properties. */
  elementProps: Map<string, string[]>;
  /** Every metadataId the vendored build registers behaviour for. */
  registeredIds: Set<string>;
  /** metadataId → what its own code touches. */
  evidence: Map<string, PartEvidence>;
  /** Every render-store key written anywhere in the part source. */
  allStoreKeys: Set<string>;
}

const EMPTY_EVIDENCE: PartEvidence = {
  element: new Set(),
  methods: new Set(),
  bag: new Set(),
  store: new Set(),
};

/** Members of a custom element that are DOM/event plumbing, never a signal. */
const NON_SIGNAL_MEMBERS = new Set([
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'setAttribute',
  'getAttribute',
  'removeAttribute',
  'hasAttribute',
  'appendChild',
  'removeChild',
  'querySelector',
  'querySelectorAll',
  'getBoundingClientRect',
  'closest',
  'matches',
  'contains',
  'focus',
  'blur',
  'click',
  'classList',
  'style',
  'dataset',
  'children',
  'parentElement',
  'tagName',
  'requestUpdate',
  'requestAnimationFrame',
  'getRootNode',
]);

/** The `(`-balanced text of a call, starting at its opening parenthesis. */
function balancedCall(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Top-level declarations by name — `function f(){}`, `const f = …`, `class C{}`. */
function topLevelDeclarations(text: string): Map<string, string> {
  const heads: { name: string; start: number }[] = [];
  const pattern = /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=)/gm;
  for (const match of text.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name && match.index !== undefined) heads.push({ name, start: match.index });
  }
  const out = new Map<string, string>();
  heads.forEach((head, index) => {
    const end = index + 1 < heads.length ? (heads[index + 1] as { start: number }).start : text.length;
    // First declaration of a name wins (helpers are declared once).
    if (!out.has(head.name)) out.set(head.name, text.slice(head.start, end));
  });
  return out;
}

/** Element parameter names inside a register block, including local aliases. */
function elementAliases(block: string): string[] {
  const aliases = new Set<string>(['element']);
  const param = /attachEvents:\s*(?:async\s*)?(?:function\s*)?\(\s*([A-Za-z_$][\w$]*)/.exec(block);
  if (param?.[1]) aliases.add(param[1]);
  for (const match of block.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:element|[A-Za-z_$][\w$]*)\s+as\s+any/g)) {
    if (match[1]) aliases.add(match[1]);
  }
  for (const match of block.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:element|[A-Za-z_$][\w$]*)\s*;/g)) {
    if (match[1]) aliases.add(match[1]);
  }
  return [...aliases];
}

/** Everything one part's code touches, following its helper calls one level deep. */
function readEvidence(body: string, declarations: Map<string, string>): PartEvidence {
  const evidence: PartEvidence = { element: new Set(), methods: new Set(), bag: new Set(), store: new Set() };
  const seen = new Set<string>();

  const visit = (text: string, depth: number): void => {
    for (const alias of elementAliases(text)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of text.matchAll(new RegExp(`\\b${escaped}\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)`, 'g'))) {
        const prop = match[1];
        if (prop && !NON_SIGNAL_MEMBERS.has(prop)) evidence.element.add(prop);
      }
      for (const match of text.matchAll(new RegExp(`\\b${escaped}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) {
        const method = match[1];
        if (method && !NON_SIGNAL_MEMBERS.has(method)) evidence.methods.add(method);
      }
    }
    for (const match of text.matchAll(/emitPropertyChange\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'/g)) {
      if (match[1]) evidence.bag.add(match[1]);
    }
    for (const match of text.matchAll(/setValue\(\s*[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\}/g)) {
      for (const key of (match[1] ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
        if (key[1]) evidence.store.add(key[1]);
      }
    }
    if (depth >= 3) return;
    // Follow the helpers this code calls: an LCD's writes live in
    // `createLcdSimulation`, not in the three lines of its register block.
    for (const [name, helperBody] of declarations) {
      if (seen.has(name)) continue;
      if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) continue;
      seen.add(name);
      visit(helperBody, depth + 1);
    }
  };

  visit(body, 0);
  return evidence;
}

/** Scan the vendored part source: who registers what, and what it touches. */
export function scanPartSource(partsDirFiles: { path: string; text: string }[]): {
  registeredIds: Set<string>;
  evidence: Map<string, PartEvidence>;
  allStoreKeys: Set<string>;
} {
  const registeredIds = new Set<string>();
  const evidence = new Map<string, PartEvidence>();
  const allStoreKeys = new Set<string>();

  for (const file of partsDirFiles) {
    const declarations = topLevelDeclarations(file.text);
    const registerPattern = /PartSimulationRegistry\.register\(\s*'([a-z0-9-]+)'/g;
    for (const match of file.text.matchAll(registerPattern)) {
      const id = match[1];
      if (!id || match.index === undefined) continue;
      registeredIds.add(id);
      const open = file.text.indexOf('(', match.index);
      if (open < 0) continue;
      const block = balancedCall(file.text, open);
      const found = readEvidence(block, declarations);
      const existing = evidence.get(id) ?? structuredClone(EMPTY_EVIDENCE);
      for (const [key, set] of Object.entries(found) as [keyof PartEvidence, Set<string>][]) {
        for (const value of set) existing[key].add(value);
      }
      evidence.set(id, existing);
    }
    for (const match of file.text.matchAll(/setValue\(\s*[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\}/g)) {
      for (const key of (match[1] ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
        if (key[1]) allStoreKeys.add(key[1]);
      }
    }
  }

  return { registeredIds, evidence, allStoreKeys };
}

/** Evidence for a part, resolved by metadataId with the CAD-bench prefix stripped. */
export function evidenceFor(sources: LiveSurfaceSources, key: string): PartEvidence {
  return sources.evidence.get(key) ?? EMPTY_EVIDENCE;
}

/* ─────────────────────────── the authored table ───────────────────────────
 * One entry per CAD key that HAS live state. Every signal below names a
 * property the part's own code writes — the `verify:3d-live` gate re-derives
 * that from the vendored source, so these comments describe rather than assert.
 *
 * Anchors are `spec` frame wherever the spec feature exists (the generated GLB
 * and the parametric assembly are both built from that same spec, and the GLB's
 * materials are named `Mat_<feature>`), because millimetre coordinates from the
 * spec are exact. */

const GHOST = { labelColor: '#e8eef7' } as const;

export const LIVE_SURFACES: Record<string, PartLiveSurfaces> = {
  /* ── servos & motion ─────────────────────────────────────────────────── */
  servo: {
    name: 'Hobby servo (SG90 / MG996R / MG90S / FS90R)',
    // ComplexParts:317 writes `el.angle` (and mirrors it into the render store).
    // The servo's asset is the hand-reviewed SG90 GLB (`sg90/sg90.glb`), so the
    // horn is addressed by its own node name — the spec frame is not provably
    // the frame that asset was built in.
    surfaces: [
      {
        id: 'horn',
        kind: 'motion',
        anchor: { frame: 'model', node: 'servo_horn' },
        motion: { mode: 'angle', props: ['angle'], valueRange: [0, 180], range: [0, 180], axis: 'y' },
      },
    ],
  },
  'stepper-motor': {
    name: 'Stepper motor (NEMA 17)',
    // SensorParts:387 mirrors `angle` (degrees, wrapped) on every step.
    surfaces: [
      {
        id: 'shaft',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'shaft' },
        motion: { mode: 'angle', props: ['angle'], valueRange: [0, 360], range: [0, 360], axis: 'y' },
      },
    ],
  },
  'ky-040': {
    name: 'Rotary encoder (KY-040)',
    // The element's own `angle` follows the knob the user turns; the sketch
    // reads the quadrature pins.
    surfaces: [
      {
        id: 'knob',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'encoder_shaft' },
        motion: { mode: 'angle', props: ['angle'], valueRange: [0, 360], range: [0, 360], axis: 'y' },
      },
    ],
  },
  potentiometer: {
    name: 'Potentiometer (10k)',
    // ComplexParts:100 emits `value`; the element holds the same `value` the
    // user drags. 0..1023 spans the shaft's 270° travel.
    surfaces: [
      {
        id: 'shaft',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'knurled_shaft' },
        motion: { mode: 'angle', props: ['value'], valueRange: [0, 1023], range: [0, 270], axis: 'y' },
      },
    ],
  },
  'slide-potentiometer': {
    name: 'Slide potentiometer (10k)',
    // ComplexParts:130 emits `value` (0..100 %). The cap travels along the
    // body's long axis (spec is 20 × 16 mm → x).
    surfaces: [
      {
        id: 'slider',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'actuator_cap' },
        motion: { mode: 'fraction', props: ['value'], valueRange: [0, 100], range: [0, 8], axis: 'x' },
      },
    ],
  },
  'slide-switch': {
    name: 'Slide switch (SPDT)',
    // BasicParts emits `value` (1/0) and the element tracks the toggle.
    surfaces: [
      {
        id: 'lever',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'metal_toggle_lever' },
        motion: { mode: 'angle', props: ['value'], valueRange: [0, 1], range: [0, 24], axis: 'x' },
      },
    ],
  },
  pushbutton: {
    name: 'Pushbutton (6 mm tact)',
    // BasicParts:41/46 emit `pressed`; the element sets it on pointer too.
    surfaces: [
      {
        id: 'cap',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'round_button_cap' },
        motion: { mode: 'press', props: ['pressed'], range: [0, -1.4], axis: 'y' },
      },
    ],
  },
  'analog-joystick': {
    name: 'Analog joystick (2 axis)',
    // ComplexParts writes el.pressed and the element carries xValue/yValue.
    surfaces: [
      {
        id: 'stick-press',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'thumb_stick' },
        motion: { mode: 'press', props: ['pressed'], range: [0, -1.2], axis: 'y' },
      },
      {
        id: 'axes',
        kind: 'readout',
        anchor: { frame: 'spec', feature: 'thumb_stick', face: 'top' },
        readout: {
          rows: [
            { label: 'X', prop: 'xValue' },
            { label: 'Y', prop: 'yValue' },
            { label: 'SW', prop: 'pressed' },
          ],
        },
        style: { ...GHOST },
      },
    ],
  },

  /* ── light ───────────────────────────────────────────────────────────── */
  led: {
    name: 'LED (5 mm)',
    // BasicParts:234 mirrors `brightness` (PWM duty) into the render store.
    surfaces: [
      {
        id: 'lens',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'diffused_5mm_epoxy_lens' },
        emissive: { mode: 'brightness', props: ['brightness'], color: '#ff3b30', colorProp: 'color' },
      },
    ],
  },
  'rgb-led': {
    name: 'RGB LED (common cathode)',
    // ComplexParts writes ledRed/ledGreen/ledBlue (0..255) per channel.
    surfaces: [
      {
        id: 'lens',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'clear_5mm_rgb_epoxy_lens' },
        emissive: { mode: 'rgb255', props: ['ledRed', 'ledGreen', 'ledBlue'] },
      },
    ],
  },
  neopixel: {
    name: 'NeoPixel strip (WS2812B)',
    // SensorParts normalises the decoded colour into el.r/el.g/el.b (0..1),
    // exactly as the 2D element lights all three 5050 packages.
    surfaces: [
      {
        id: 'pixel-1',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'ws2812b_5050_pixel_1' },
        emissive: { mode: 'rgb01', props: ['r', 'g', 'b'] },
      },
      {
        id: 'pixel-2',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'ws2812b_5050_pixel_2' },
        emissive: { mode: 'rgb01', props: ['r', 'g', 'b'] },
      },
      {
        id: 'pixel-3',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'ws2812b_5050_pixel_3' },
        emissive: { mode: 'rgb01', props: ['r', 'g', 'b'] },
      },
    ],
  },
  'led-ring': {
    name: 'LED ring (8 × WS2812B)',
    // The decoder calls el.setPixel(i, {r,g,b}) and mirrors the strip into the
    // render store (`store:pixels`) — the element keeps its own framebuffer.
    surfaces: [
      {
        id: 'ring',
        kind: 'rgb-pixels',
        anchor: { frame: 'spec', feature: 'actuator_body', face: 'top' },
        display: { pixels: true, layout: 'ring', rows: 1, cols: 1 },
        style: { glowMm: 1.2 },
      },
    ],
  },
  'neopixel-matrix': {
    name: 'NeoPixel matrix (8 × 8)',
    surfaces: [
      {
        id: 'matrix',
        kind: 'rgb-pixels',
        anchor: { frame: 'spec', feature: 'actuator_body', face: 'top' },
        display: { pixels: true, layout: 'matrix', rows: 8, cols: 8 },
        style: { glowMm: 0.6 },
      },
    ],
  },
  buzzer: {
    name: 'Buzzer (active + passive)',
    // ComplexParts sets el.playing while a note sounds (the WebAudio onset).
    surfaces: [
      {
        id: 'port',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'sound_port' },
        emissive: { mode: 'boolean', props: ['playing'], color: '#ffd60a', max: 0.6 },
      },
    ],
  },
  'gas-sensor': {
    name: 'Gas sensor (MQ-2)',
    // SensorParts drives the module's two indicator LEDs (ledPower always on,
    // ledD0 when the comparator trips).
    surfaces: [
      {
        id: 'indicator',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'mq2_heater_can' },
        emissive: { mode: 'channels', props: ['ledPower', 'ledD0'], colors: ['#34c759', '#ff9f0a'], max: 0.5 },
      },
    ],
  },
  'pir-motion-sensor': {
    name: 'PIR motion sensor (HC-SR501)',
    // The part has no element property of its own: it drives OUT (HIGH for 3 s
    // on a trigger). Read that pin's real state through the wire graph.
    surfaces: [
      {
        id: 'motion',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'fresnel_dome' },
        emissive: { mode: 'boolean', props: ['pin:OUT'], color: '#ff453a', max: 0.8 },
      },
    ],
  },
  'tilt-switch': {
    name: 'Tilt sensor module',
    // SensorParts toggles OUT on each trigger; nothing is written on the element.
    surfaces: [
      {
        id: 'tilt',
        kind: 'emissive',
        anchor: { frame: 'spec', feature: 'sensor_ic' },
        emissive: { mode: 'boolean', props: ['pin:OUT'], color: '#64d2ff', max: 0.8 },
      },
    ],
  },

  /* ── displays ────────────────────────────────────────────────────────── */
  lcd1602: {
    name: 'LCD 1602 (I2C backpack)',
    // HD44780Decoder → el.characters (Uint8Array, cols × rows) plus
    // backlight/cursor/blink; the element's own `font` is the glyph ROM.
    surfaces: [
      {
        id: 'glass',
        kind: 'text-grid',
        anchor: { frame: 'spec', feature: 'green_lcd_glass', face: 'top' },
        display: {
          characters: 'characters',
          font: 'font',
          backlight: 'backlight',
          cursor: 'cursor',
          cursorX: 'cursorX',
          cursorY: 'cursorY',
          cols: 16,
          rows: 2,
        },
        style: { textColor: '#0b1a12', offColor: '#2f6b4a', backlightColor: '#3ddc84' },
      },
    ],
  },
  lcd2004: {
    name: 'LCD 2004',
    surfaces: [
      {
        id: 'glass',
        kind: 'text-grid',
        anchor: { frame: 'spec', feature: 'glass_panel', face: 'top' },
        display: {
          characters: 'characters',
          font: 'font',
          backlight: 'backlight',
          cursor: 'cursor',
          cursorX: 'cursorX',
          cursorY: 'cursorY',
          cols: 20,
          rows: 4,
        },
        style: { textColor: '#0b1a12', offColor: '#2f6b4a', backlightColor: '#3ddc84' },
      },
    ],
  },
  ssd1306: {
    name: 'OLED SSD1306 (128 × 64)',
    // SSD1306Core paints the GDDRAM into el.imageData and calls el.redraw().
    surfaces: [
      {
        id: 'glass',
        kind: 'image-data',
        anchor: { frame: 'spec', feature: 'oled_glass', face: 'top' },
        display: { imageData: 'imageData', width: 128, height: 64 },
        style: { onColor: '#c8e6ff', offColor: '#05070c' },
      },
    ],
  },
  ili9341: {
    name: 'TFT ILI9341 (240 × 320)',
    // The element exposes a real <canvas>; the driver draws into it.
    surfaces: [
      {
        id: 'glass',
        kind: 'canvas',
        anchor: { frame: 'spec', feature: 'glass_panel', face: 'top' },
        display: { canvas: 'canvas' },
      },
    ],
  },
  '7segment': {
    name: '7-segment display',
    // ChipParts latches segments per digit into el.values (plus colon).
    surfaces: [
      {
        id: 'panel',
        kind: 'segments',
        anchor: { frame: 'spec', feature: 'glass_panel', face: 'top' },
        display: { values: 'values', digits: 'digits', colon: 'colon', colonValue: 'colonValue' },
        style: { onColor: '#ff453a', offColor: '#1b1f26' },
      },
    ],
  },
  'led-bar-graph': {
    name: 'LED bar graph (10)',
    surfaces: [
      {
        id: 'panel',
        kind: 'bar-graph',
        anchor: { frame: 'spec', feature: 'glass_panel', face: 'top' },
        display: { values: 'values' },
        style: { onColor: '#ff9f0a', offColor: '#1b1f26' },
      },
    ],
  },

  /* ── sensors that do carry their reading on the element/bag ──────────── */
  dht22: {
    name: 'DHT22 temperature/humidity',
    // ProtocolParts mirrors `temperature`/`humidity` into the render store and
    // onto the element. The asset is the hand-reviewed DHT22 GLB, so the plaque
    // sits on its own bounding-box top rather than on spec coordinates.
    surfaces: [
      {
        id: 'reading',
        kind: 'readout',
        anchor: { frame: 'model', bodyTop: true },
        readout: {
          rows: [
            { label: 'T', prop: 'temperature', unit: '°C', precision: 1 },
            { label: 'RH', prop: 'humidity', unit: '%', precision: 1 },
          ],
        },
        style: { ...GHOST },
      },
    ],
  },
  'ntc-temperature-sensor': {
    name: 'NTC thermistor module',
    // SensorParts emits `temperature` into the component property bag (the
    // same value the SPICE netlist uses for R_ntc).
    surfaces: [
      {
        id: 'reading',
        kind: 'readout',
        anchor: { frame: 'spec', feature: 'sensor_ic', face: 'top' },
        readout: { rows: [{ label: 'T', prop: 'bag:temperature', unit: '°C', precision: 1 }] },
        style: { ...GHOST },
      },
    ],
  },
  ds3231: {
    name: 'RTC DS3231',
    // ProtocolParts writes the on-chip temperature onto the element.
    surfaces: [
      {
        id: 'reading',
        kind: 'readout',
        anchor: { frame: 'spec', feature: 'sensor_ic', face: 'top' },
        readout: { rows: [{ label: 'T', prop: 'temperature', unit: '°C', precision: 1 }] },
        style: { ...GHOST },
      },
    ],
  },
  'gps-neo6m': {
    name: 'GPS NEO-6M',
    // GpsParts drives the element's lat/lng/altitude/speed with the fix it
    // feeds into the NMEA stream.
    surfaces: [
      {
        id: 'fix',
        kind: 'readout',
        anchor: { frame: 'spec', feature: 'sensor_ic', face: 'top' },
        readout: {
          rows: [
            { label: 'Lat', prop: 'lat', unit: '°', precision: 4 },
            { label: 'Lng', prop: 'lng', unit: '°', precision: 4 },
            { label: 'Spd', prop: 'speed', unit: 'kn', precision: 1 },
          ],
        },
        style: { ...GHOST },
      },
    ],
  },
};

const PASSIVE_REASON =
  'Passive/discrete: its only state is electrical (voltage, current, polarity) and the 2D canvas draws it statically — there is nothing to mirror in 3D.';
const BOARD_REASON =
  'The board body carries no live surface in 2D — its pins are the state, and every other part on the bench reads from them.';
const CAD_BENCH_REASON =
  'CAD bench part: the emulator registers no behaviour, so the 2D canvas draws the static `velxio-cad-bench-part` symbol ("it does not react to signals"). There is no live state in either view.';
const NO_BEHAVIOUR_REASON =
  'No simulator element and no registered behaviour: the 2D canvas draws it statically, so 3D has nothing to mirror.';

/* ── CAD-bench parts: the devices the emulator has no model for ────────────
 * These are real hardware on a real bench. Velxio has no part simulator for
 * them, so there is no element property to read — but the emulation still knows
 * whether they are being DRIVEN, because that is decided by the wiring and the
 * board pins it is already running (`scene3d` reads it; the producer is
 * `simulation/liveState/partActivity.ts`, which traces each terminal through the
 * wire graph to the GPIO / PWM channel / upstream driver that is energising it).
 *
 * The signals used below are therefore measured, not declared:
 *   `drive`           0..1  energy arriving (any terminal)
 *   `activity`        0..1  the part is working: drive, or a commanded input,
 *                           or bus traffic
 *   `triggered`       0/1   a switch / comparator contact is closed
 *   `bus`             0..1  the part is being addressed (bus lines toggling)
 *   `rpm` / `turnsPerSecond` the shaft's speed, duty × its own nominal rpm
 *   `stepAngle`       deg   a stepper's accumulated shaft position
 *   `via`             route 'gpio' | 'pwm' | 'output' | 'rail'
 *
 * A part whose terminals reach no live net gets drive 0 and stays still. */

/** Tint used for "this body is energised" on a sealed part (no moving element
 *  is modelled — a pump's impeller, a driver's silicon, a radio's radio). */
const ENERGISE = '#8fd6ff';
/** Tint for a closed contact / a sensor that has tripped. */
const TRIPPED = '#ffb340';

function energisedSurface(id: string, feature: string, max = 0.5): LiveSurface {
  return {
    id,
    kind: 'emissive',
    anchor: { frame: 'spec', feature },
    emissive: { mode: 'value-fraction', props: ['activity'], valueRange: [0, 1], color: ENERGISE, max },
  };
}

function trippedSurface(id: string, feature: string, max = 0.8): LiveSurface {
  return {
    id,
    kind: 'emissive',
    anchor: { frame: 'spec', feature },
    emissive: { mode: 'value-fraction', props: ['triggered'], valueRange: [0, 1], color: TRIPPED, max },
  };
}

/** A shaft that turns while the part is driven, at the part's own speed. */
function spinning(
  id: string,
  feature: string,
  opts: { axis?: 'x' | 'y' | 'z'; invert?: boolean; deadband?: number } = {},
): LiveSurface {
  return {
    id,
    kind: 'motion',
    anchor: { frame: 'spec', feature },
    motion: {
      mode: 'spin',
      props: ['drive', 'turnsPerSecond'],
      // No axis by default: the renderer reads it off the real geometry, which
      // is the body of revolution's own axis. `opts.axis` overrides it for a
      // feature whose modelled shape is not a simple solid of revolution.
      ...(opts.axis ? { axis: opts.axis } : {}),
      ...(opts.invert ? { invert: true } : {}),
      ...(opts.deadband !== undefined ? { deadband: opts.deadband } : {}),
    },
  };
}

/** A moveable part whose position IS a live angle (a stepper's shaft). */
function angleDriven(id: string, feature: string, axis?: 'x' | 'y' | 'z'): LiveSurface {
  return {
    id,
    kind: 'motion',
    anchor: { frame: 'spec', feature },
    motion: { mode: 'rotate', props: ['stepAngle'], ...(axis ? { axis } : {}) },
  };
}

/** A plaque of measured values, shown when the part is selected. */
function plaque(id: string, feature: string, rows: ReadoutRow[]): LiveSurface {
  return {
    id,
    kind: 'readout',
    anchor: { frame: 'spec', feature, face: 'top' },
    readout: { rows, selectedOnly: true },
    style: { labelColor: '#e8eef7' },
  };
}

/** Rows every driven part can show: how hard it is driven, and through what. */
const DRIVE_ROWS: ReadoutRow[] = [
  { label: 'Drive', prop: 'drive', precision: 2 },
  { label: 'Via', prop: 'via' },
  { label: 'Pin', prop: 'viaPin' },
];
function driveRows(...rows: ReadoutRow[]): ReadoutRow[] {
  return [...DRIVE_ROWS, ...rows];
}
const SPEED_ROW: ReadoutRow = { label: 'Speed', prop: 'rpm', unit: 'rpm' };
const DIRECTION_ROW: ReadoutRow = { label: 'Dir', prop: 'direction' };

const CAD_BENCH_LIVE: Record<string, PartLiveSurfaces> = {
  /* ── rotating loads ──────────────────────────────────────────────────── */
  'dc-motor-generic-6v': {
    name: 'DC motor (6 V, gearbox)',
    surfaces: [
      spinning('shaft-a', 'output_shaft_left'),
      spinning('shaft-b', 'output_shaft_right'),
      plaque('state', 'motor_can', driveRows(SPEED_ROW, DIRECTION_ROW)),
    ],
  },
  'n20-gear-motor-encoder': {
    name: 'N20 gear motor with encoder',
    surfaces: [
      spinning('shaft', 'output_shaft'),
      spinning('magnet', 'encoder_magnet'),
      plaque('state', 'gearbox', driveRows(SPEED_ROW, DIRECTION_ROW)),
    ],
  },
  'vibration-motor-coin-3v': {
    name: 'Vibration motor (coin)',
    surfaces: [spinning('shaft', 'output_shaft', { deadband: 0.05 }), plaque('state', 'motor_can', driveRows())],
  },
  'blower-fan-5v-radial': {
    name: 'Blower fan (5 V radial)',
    surfaces: [spinning('rotor', 'output_shaft'), plaque('state', 'motor_can', driveRows(SPEED_ROW))],
  },
  'peristaltic-pump-12v': {
    name: 'Peristaltic pump (12 V)',
    surfaces: [spinning('roller-head', 'output_shaft'), plaque('state', 'motor_can', driveRows(SPEED_ROW))],
  },
  'bldc-motor-2212-1000kv': {
    name: 'BLDC motor (2212, 1000 kV)',
    surfaces: [spinning('bell', 'output_shaft'), plaque('state', 'motor_can', driveRows(SPEED_ROW))],
  },
  'bldc-motor-2205-2300kv': {
    name: 'BLDC motor (2205, 2300 kV)',
    surfaces: [
      spinning('bell', 'bell'),
      spinning('shaft', 'prop_shaft'),
      spinning('nut', 'prop_nut'),
      plaque('state', 'base_plate', driveRows(SPEED_ROW)),
    ],
  },
  'stepper-28byj48-uln2003': {
    name: 'Stepper 28BYJ-48 with ULN2003',
    // The four command pins are sequenced by the sketch; each pattern change
    // advances the shaft one half-step (0.703°), which is the real mechanism.
    surfaces: [
      angleDriven('shaft', 'output_shaft'),
      plaque('state', 'motor_can', [{ label: 'Shaft', prop: 'stepAngle', unit: '°', precision: 1 }, ...driveRows()]),
    ],
  },
  'fan-5v-40mm': {
    name: 'Fan (5 V, 40 mm)',
    surfaces: [spinning('rotor', 'blade_ring'), spinning('hub', 'hub'), plaque('state', 'hub', driveRows(SPEED_ROW))],
  },
  'fan-12v-4pin-pwm': {
    name: 'Fan (12 V, 4-pin PWM)',
    // The PWM pin is the commanded duty; the emulator reads it like any other
    // PWM channel, so the fan's speed follows the sketch's analogWrite/tone.
    surfaces: [spinning('rotor', 'blade_ring'), spinning('hub', 'hub'), plaque('state', 'hub', driveRows(SPEED_ROW))],
  },
  'water-pump-5v-submersible': {
    name: 'Water pump (5 V submersible)',
    // No impeller is modelled on this body, so the cue is the pump running:
    // the housing lights while it is energised, plus its measured state.
    surfaces: [energisedSurface('running', 'motor_housing'), plaque('state', 'motor_housing', driveRows())],
  },
  'solenoid-valve-12v-water': {
    name: 'Solenoid water valve (12 V)',
    surfaces: [energisedSurface('open', 'actuator_body'), plaque('state', 'actuator_body', driveRows())],
  },
  'linear-actuator-12v-100mm': {
    name: 'Linear actuator (12 V, 100 mm)',
    surfaces: [energisedSurface('driving', 'actuator_body'), plaque('state', 'actuator_body', driveRows(DIRECTION_ROW))],
  },
  'solenoid-12v-push-pull': {
    name: 'Push-pull solenoid (12 V)',
    // A real plunger travels a few millimetres when the coil is energised.
    surfaces: [
      {
        id: 'plunger',
        kind: 'motion',
        anchor: { frame: 'spec', feature: 'plunger' },
        motion: { mode: 'fraction', props: ['activity'], valueRange: [0, 1], range: [0, 4], axis: 'y' },
      },
      energisedSurface('coil', 'coil_bobbin', 0.4),
      plaque('state', 'steel_frame', driveRows()),
    ],
  },

  /* ── drivers & power electronics (sealed bodies: energised cue) ───────── */
  'l298n-motor-driver': {
    name: 'L298N dual H-bridge',
    surfaces: [energisedSurface('driving', 'heatsink'), plaque('state', 'heatsink', driveRows(DIRECTION_ROW))],
  },
  'l293d-motor-driver': {
    name: 'L293D motor driver',
    surfaces: [energisedSurface('driving', 'heatsink'), plaque('state', 'heatsink', driveRows())],
  },
  'tb6612fng-motor-driver': {
    name: 'TB6612FNG motor driver',
    surfaces: [energisedSurface('driving', 'heatsink'), plaque('state', 'heatsink', driveRows())],
  },
  'drv8833-motor-driver': {
    name: 'DRV8833 motor driver',
    surfaces: [energisedSurface('driving', 'drv8833_qfn'), plaque('state', 'drv8833_qfn', driveRows())],
  },
  'bts7960-motor-driver': {
    name: 'BTS7960 high-current driver',
    surfaces: [energisedSurface('driving', 'heatsink'), plaque('state', 'heatsink', driveRows(DIRECTION_ROW))],
  },
  'drv8825-stepper-driver': {
    name: 'DRV8825 stepper driver',
    surfaces: [energisedSurface('driving', 'heatsink'), plaque('state', 'heatsink', driveRows())],
  },
  'tmc2209-stepper-driver': {
    name: 'TMC2209 stepper driver',
    surfaces: [energisedSurface('driving', 'heatsink'), plaque('state', 'heatsink', driveRows())],
  },
  'uln2003-darlington-array': {
    name: 'ULN2003 darlington array',
    surfaces: [energisedSurface('driving', 'heatsink'), plaque('state', 'heatsink', driveRows())],
  },
  'mosfet-module-irf520': {
    name: 'MOSFET module (IRF520)',
    surfaces: [energisedSurface('conducting', 'heatsink'), plaque('state', 'heatsink', driveRows())],
  },
  'pca9685-servo-driver': {
    name: 'PCA9685 16-channel PWM driver',
    surfaces: [energisedSurface('addressed', 'pca9685_ic'), plaque('state', 'pca9685_ic', driveRows())],
  },
  'esc-30a-bldc': {
    name: 'ESC 30 A (BLDC)',
    surfaces: [energisedSurface('armed', 'esc_pcb'), plaque('state', 'esc_pcb', driveRows())],
  },
  'relay-module-5v-1ch': {
    name: 'Relay module (5 V, 1 channel)',
    // The module's own LED follows the command pin; the coil closing is what
    // energises a load wired through COM/NO (that load lights itself).
    surfaces: [
      { id: 'indicator', kind: 'emissive', anchor: { frame: 'spec', feature: 'status_led' }, emissive: { mode: 'boolean', props: ['pin:IN'], color: '#ff453a' } },
      trippedSurface('coil', 'songle_relay_block', 0.45),
      plaque('state', 'songle_relay_block', [{ label: 'IN', prop: 'pin:IN' }, ...driveRows()]),
    ],
  },
  'logic-level-shifter-4ch': {
    name: 'Logic level shifter (4 channel)',
    surfaces: [energisedSurface('rail', 'bss138_array'), plaque('state', 'bss138_array', driveRows())],
  },
  'regulator-ams1117-3v3': {
    name: 'Regulator AMS1117 3.3 V',
    surfaces: [energisedSurface('regulating', 'primary_ic'), plaque('state', 'primary_ic', driveRows())],
  },
  'buck-converter-lm2596': {
    name: 'Buck converter (LM2596)',
    surfaces: [energisedSurface('converting', 'lm2596_regulator_ic'), plaque('state', 'lm2596_regulator_ic', driveRows())],
  },
  'breadboard-power-module-mb102': {
    name: 'Breadboard power module (MB102)',
    surfaces: [energisedSurface('rails-live', 'ams1117_5v'), plaque('state', 'power_jumpers', driveRows())],
  },

  /* ── sensing modules ─────────────────────────────────────────────────── */
  'ir-obstacle-sensor': {
    name: 'IR obstacle sensor',
    // Its emitter is on whenever the module is powered; OUT/DO closing is
    // reported as `triggered` when the emulator sees that net driven.
    surfaces: [
      energisedSurface('emitter', 'ir_led_emitter', 0.7),
      trippedSurface('detection', 'photodiode_receiver'),
      plaque('state', 'comparator_ic', driveRows()),
    ],
  },
  'soil-moisture-sensor': {
    name: 'Soil moisture sensor',
    surfaces: [energisedSurface('probes', 'fork_probe_left', 0.35), trippedSurface('threshold', 'lm393_ic'), plaque('state', 'comparator_board', driveRows())],
  },
  'ldr-photoresistor': {
    name: 'LDR photoresistor',
    surfaces: [energisedSurface('conducting', 'photoresistor_disc', 0.3), plaque('state', 'photoresistor_disc', driveRows())],
  },
  'bh1750-light-sensor': {
    name: 'BH1750 light sensor',
    surfaces: [energisedSurface('addressed', 'primary_ic'), plaque('state', 'primary_ic', driveRows({ label: 'Bus', prop: 'bus', precision: 2 }))],
  },
  'bme280-environmental': {
    name: 'BME280 environmental sensor',
    surfaces: [energisedSurface('addressed', 'bme280_metal_can'), plaque('state', 'bme280_metal_can', driveRows({ label: 'Bus', prop: 'bus', precision: 2 }))],
  },
  'ds18b20-temperature': {
    name: 'DS18B20 temperature probe',
    surfaces: [energisedSurface('addressed', 'to92_body'), plaque('state', 'to92_body', driveRows())],
  },
  'dht11-temperature-humidity': {
    name: 'DHT11 temperature/humidity',
    surfaces: [energisedSurface('reading', 'blue_vented_dht11_body'), plaque('state', 'blue_vented_dht11_body', driveRows())],
  },
  'ina219-current-sensor': {
    name: 'INA219 current sensor',
    surfaces: [energisedSurface('measuring', 'primary_ic'), plaque('state', 'primary_ic', driveRows())],
  },
  'limit-switch-microswitch': {
    name: 'Limit switch (microswitch)',
    surfaces: [energisedSurface('contact', 'microswitch_case', 0.35), plaque('state', 'microswitch_case', driveRows())],
  },

  /* ── radios & modules (bus traffic is their live state) ──────────────── */
  'hc-05-bluetooth': {
    name: 'HC-05 Bluetooth module',
    surfaces: [
      trippedSurface('traffic', 'status_led', 0.9),
      energisedSurface('powered', 'bc417_radio_module', 0.3),
      plaque('state', 'bc417_radio_module', driveRows({ label: 'Bus', prop: 'bus', precision: 2 })),
    ],
  },
  'hc-06-bluetooth': {
    name: 'HC-06 Bluetooth module',
    surfaces: [
      trippedSurface('traffic', 'status_led', 0.9),
      energisedSurface('powered', 'bc417_radio_module', 0.3),
      plaque('state', 'bc417_radio_module', driveRows({ label: 'Bus', prop: 'bus', precision: 2 })),
    ],
  },
  'esp8266-esp01-wifi': {
    name: 'ESP-01 WiFi module',
    surfaces: [
      energisedSurface('addressed', 'esp8266_shield_can'),
      plaque('state', 'esp8266_shield_can', driveRows({ label: 'Bus', prop: 'bus', precision: 2 })),
    ],
  },
  'raspberry-pi-camera-module': {
    name: 'Raspberry Pi camera module',
    surfaces: [energisedSurface('streaming', 'sensor_ic'), plaque('state', 'sensor_ic', driveRows())],
  },
  'usb-webcam-generic': {
    name: 'USB webcam',
    surfaces: [energisedSurface('streaming', 'sensor_ic'), plaque('state', 'sensor_ic', driveRows())],
  },
};

/** Parts that render in 3D but have no live state, with the honest reason. */
export const INERT_REASONS: Record<string, string> = {
  a4988:
    'STEP/DIR driver: it has no visible state of its own — the pulse stream rotates the wired stepper-motor (that part animates), and its heatsink temperature is not modelled.',
  'drv8825-stepper-driver':
    'STEP/DIR driver: no visible state of its own; the wired stepper-motor is the moving part.',
  'hc-sr04':
    'TRIG/ECHO timing is pin-level and the element holds no distance property the canvas shows — the 2D view is static too.',
  mpu6050:
    'IMU registers live on the I2C bus; the element exposes no live property, so there is nothing for 3D to read that 2D shows.',
  'ir-receiver':
    'irAddress / irCommand are user-set inputs the part reads; the element shows no received-code state.',
  hx711: 'The load-cell value is published over the two-wire interface only; the element has no live property.',
  'membrane-keypad':
    'Pressed keys are reported as a `keys` array (no per-cap signal), and the 3D key caps have no per-key anchor.',
  'dip-switch-8':
    'The CAD spec models the 8 levers as one actuator cap, so the individual switch positions have no anchor in 3D.',
  'microsd-card': 'The card is a storage target; nothing about it is displayed in 2D.',
  'ds1307': 'The RTC time is only readable over I2C; the element shows no live property.',
  'bmp280': 'Pressure/temperature go out over I2C; no live element property exists for 3D to mirror.',
  pcf8574: 'The expander mirrors its own pins electrically — the element exposes no live property.',
  '74hc595': 'Shift-register bits are pin-level; the element only shows its output pins.',
  'ir-remote': 'The remote emits codes on demand; nothing is displayed.',
  photodiode: 'Light level feeds the SPICE netlist; the element shows nothing.',
  'flame-sensor': 'The flame LEDs are driven by the element itself, not by a property the sketch sets.',
  'heart-beat-sensor': 'Pulse timing is pin-level; no live element property.',
  'big-sound-sensor': 'Sound level is an analog input; no live element property.',
  'small-sound-sensor': 'Sound level is an analog input; no live element property.',

  /* Passives and discretes: real parts, real electrical state, nothing drawn —
   * in 2D as much as in 3D. The generic "no behaviour" text would be true but
   * would hide why, so they say it. */
  resistor: PASSIVE_REASON,
  capacitor: PASSIVE_REASON,
  'capacitor-100nf-ceramic': PASSIVE_REASON,
  'capacitor-1000uf-electrolytic': PASSIVE_REASON,
  'diode-1n4007': PASSIVE_REASON,
  'diode-1n4148': PASSIVE_REASON,
  'diode-1n5819': PASSIVE_REASON,
  'bjt-2n2222': PASSIVE_REASON,
  'mosfet-2n7000': PASSIVE_REASON,
  'mosfet-irf540': PASSIVE_REASON,
  'opto-pc817': PASSIVE_REASON,
  'reg-7805': PASSIVE_REASON,
  'battery-9v':
    'Power source: its state is the voltage it supplies, which the canvas shows only through the parts it powers.',
};

/** Default reason for a key the authored table leaves inert (evidence-based). */
export function inertReason(key: string, entry: CadCatalogEntry, sources: LiveSurfaceSources): string {
  const curated = INERT_REASONS[key];
  if (curated) return curated;
  if (entry.kind === 'board') return BOARD_REASON;
  if (entry.cadOnly) return CAD_BENCH_REASON;
  if (!sources.registeredIds.has(key)) return NO_BEHAVIOUR_REASON;
  return NO_BEHAVIOUR_REASON;
}

/** Build the payload from authored entries + measured evidence. */
export function buildLiveSurfaces(sources: LiveSurfaceSources): LiveSurfacesPayload {
  const parts: Record<string, PartLiveSurfaces> = {};
  const noLiveState: Record<string, string> = {};

  for (const key of [...sources.cad.keys()].sort()) {
    const entry = sources.cad.get(key) as CadCatalogEntry;
    const authored = LIVE_SURFACES[key] ?? CAD_BENCH_LIVE[key];
    const tag = entry.cadOnly ? 'velxio-cad-bench-part' : sources.tagByKey.get(key);
    if (authored) {
      parts[key] = {
        ...(tag ? { tag } : {}),
        ...(authored.name ? { name: authored.name } : {}),
        surfaces: authored.surfaces,
      };
      continue;
    }
    noLiveState[key] = inertReason(key, entry, sources);
  }

  return { parts, noLiveState };
}
