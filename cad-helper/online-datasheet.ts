/**
 * Server-side datasheet enrichment for the Admin CAD intake.
 *
 * The browser cannot perform open web search safely. This module gives the API
 * two grounded paths instead:
 *   1. fetch and parse a user supplied datasheet / product URL; and
 *   2. resolve common maker-part names against a small curated set whose
 *      dimensions/pinouts were checked from public vendor pages and datasheets.
 *
 * It intentionally returns the same CadComponentSpec contract as the offline
 * parser so generated geometry, anchors and bundle export stay deterministic.
 */

import { parseDatasheetText } from './datasheet-parser';
import { specForCatalogComponent } from './catalog-link';
import type { CadComponentSpec, CadDatasheetSource } from './types';

interface CuratedDatasheetMatch {
  id: string;
  terms: string[];
  sources: CadDatasheetSource[];
}

export interface DatasheetResolveProvenance {
  mode: 'curated' | 'url' | 'heuristic' | 'curated+url';
  matchedComponentId?: string;
  fetchedUrl?: string;
  sources: CadDatasheetSource[];
  warnings: string[];
}

export interface DatasheetResolveResult {
  spec: CadComponentSpec;
  tier?: 'reference' | 'preset' | 'derived';
  provenance: DatasheetResolveProvenance;
}

const CURATED_DATASHEETS: CuratedDatasheetMatch[] = [
  {
    id: 'led-5mm',
    terms: ['5mm led', '5 mm led', 'through hole led', 'through-hole led', 'light emitting diode', 't-1 3/4 led'],
    sources: [
      {
        label: 'JLCPCB LED size chart',
        url: 'https://jlcpcb.com/blog/led-sizes-explained',
        note: '5 mm through-hole LEDs: 5.0 mm body diameter, ~8.6 mm height, 2.54 mm lead pitch.',
      },
      {
        label: 'Everlight 5 mm LED datasheet',
        url: 'https://www.mouser.com/ds/2/143/EAILP05RDDB1-708504.pdf',
        note: 'Confirms 2.54 mm component lead pitch for a 5 mm through-hole LED package.',
      },
    ],
  },
  {
    id: 'rgb-led-common-cathode',
    terms: ['rgb led', 'common cathode rgb led', '5mm rgb led', '5 mm rgb led'],
    sources: [
      {
        label: '5 mm RGB through-hole LED package reference',
        url: 'https://www.hlx-led.com/news_xq/2078385020783714304-360-6.html',
        note: 'RGB through-hole LED package: 5 mm epoxy body, four 2.54 mm pitch leads.',
      },
    ],
  },
  {
    id: 'hc-sr04-ultrasonic',
    terms: ['hc-sr04', 'hcsr04', 'sr04 ultrasonic', 'ultrasonic distance sensor'],
    sources: [
      {
        label: 'HC-SR04 Ultrasonic Sensor Module user guide',
        url: 'https://handsontec.com/dataspecs/sensor/SR-04-Ultrasonic.pdf',
        note: '45 × 20 × 15 mm module, 4-pin 2.54 mm header, 3.3–5 V operation and 2–400 cm range.',
      },
    ],
  },
  {
    id: 'l298n-motor-driver',
    terms: ['l298n', 'l298n motor driver', 'dual h bridge', 'dual h-bridge'],
    sources: [
      {
        label: 'L298N dual H-bridge module datasheet',
        url: 'https://cdn-reichelt.de/documents/datenblatt/A300/ME089-N.pdf',
        note: '43 × 43 × 27 mm module, 5–35 V drive supply, ENA/IN1/IN2/IN3/IN4/ENB controls.',
      },
    ],
  },
  {
    id: 'servo-motor-sg90',
    terms: ['sg90', 'sg90 servo', 'micro servo', '9g servo'],
    sources: [
      {
        label: 'SG90 mini servo datasheet summary',
        url: 'https://www.espboards.dev/sensors/sg90/',
        note: '22.8 × 12.2 × 28.5 mm, 4.8–6 V, 3-pin PWM servo lead.',
      },
    ],
  },
  {
    id: 'lcd-1602-i2c',
    terms: ['lcd 1602', '16x2 lcd', '1602 i2c', 'i2c lcd 16x2', 'pcf8574 lcd'],
    sources: [
      {
        label: 'Parallax 16×2 I2C LCD module',
        url: 'https://www.parallax.com/product/16x2-i2c-lcd-display-module-with-blue-backlight/',
        note: '80 × 36 × 13 mm overall dimensions, 4-pin 0.1 inch header, 5 V supply.',
      },
    ],
  },
  {
    id: 'hc-05-bluetooth',
    terms: ['hc-05', 'hc05', 'bluetooth module', 'bluetooth classic module'],
    sources: [
      {
        label: 'HC-05 module dimensions and pin list',
        url: 'https://electroslab.com/products/hc-05-6pin-bluetooth-module-no-button',
        note: '37.3 × 15.5 mm PCB, 3.6–6 V input, EN/VCC/GND/RXD/TXD/STATE pins.',
      },
    ],
  },
  {
    id: 'esp32-devkit-v1',
    terms: ['esp32 devkit v1', 'doit esp32', 'esp32 wroom devkit', 'esp32 development board'],
    sources: [
      {
        label: 'ESP32 DevKit V1 component guide',
        url: 'https://www.tinkered.ai/components/esp32-devkit-v1',
        note: '51.4 × 28.5 × 15 mm board envelope for the 30-pin ESP32 DevKit V1 form factor.',
      },
    ],
  },
];

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+.-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findCuratedDatasheet(query: string): CuratedDatasheetMatch | undefined {
  const normalised = normalise(query);
  let best: { entry: CuratedDatasheetMatch; score: number } | undefined;

  for (const entry of CURATED_DATASHEETS) {
    let score = 0;
    for (const term of entry.terms) {
      const needle = normalise(term);
      if (!needle) continue;
      if (normalised === needle) score += 100;
      else if (normalised.includes(needle)) score += Math.min(48, 14 + needle.length);
      else if (needle.split(' ').every((part) => normalised.includes(part))) score += 12;
    }
    if (score > (best?.score ?? 0)) best = { entry, score };
  }

  return best && best.score >= 12 ? best.entry : undefined;
}

function mergeSpec(base: CadComponentSpec, overrides?: Partial<CadComponentSpec>, sources: CadDatasheetSource[] = []): CadComponentSpec {
  return {
    ...base,
    ...overrides,
    dimensions: { ...base.dimensions, ...(overrides?.dimensions ?? {}) },
    pins: overrides?.pins?.length ? overrides.pins : base.pins,
    features: overrides?.features ?? base.features,
    protocols: overrides?.protocols ?? base.protocols,
    keywords: overrides?.keywords ?? base.keywords,
    aliases: overrides?.aliases ?? base.aliases,
    datasheetSources: [...(base.datasheetSources ?? []), ...sources, ...(overrides?.datasheetSources ?? [])],
  };
}

function maybeUrl(rawText: string): URL | undefined {
  const trimmed = rawText.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed);
  } catch {
    return undefined;
  }
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&times;|&#215;/g, '×')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function fetchDatasheetUrl(url: URL): Promise<{ text: string; warning?: string }> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html, text/plain, application/xhtml+xml;q=0.9, */*;q=0.5',
      'User-Agent': 'WireUp-CAD-Datasheet-Resolver/1.0',
    },
    // Keep the admin interaction snappy and avoid downloading huge binary files.
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Datasheet URL returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (/pdf|octet-stream/i.test(contentType)) {
    return {
      text: '',
      warning: 'Fetched URL is a binary/PDF datasheet. Paste the relevant dimension + pin table text, or use a known part name for curated enrichment.',
    };
  }

  return { text: /html/i.test(contentType) || /<html|<table|<body/i.test(body) ? htmlToPlainText(body) : body };
}

export async function resolveDatasheetInput(
  rawText: string,
  overrides?: Partial<CadComponentSpec>,
): Promise<DatasheetResolveResult> {
  const warnings: string[] = [];
  const url = maybeUrl(rawText);
  let fetchedText = '';
  let fetchedUrl: string | undefined;

  if (url) {
    try {
      const fetched = await fetchDatasheetUrl(url);
      fetchedText = fetched.text;
      fetchedUrl = url.toString();
      if (fetched.warning) warnings.push(fetched.warning);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'Could not fetch datasheet URL.');
    }
  }

  const combinedText = [rawText, fetchedText].filter(Boolean).join('\n\n').slice(0, 120_000);
  const curated = findCuratedDatasheet(combinedText);

  if (curated) {
    const linked = specForCatalogComponent(curated.id);
    if (linked) {
      return {
        spec: mergeSpec(linked.spec, overrides, curated.sources),
        tier: linked.tier,
        provenance: {
          mode: fetchedUrl ? 'curated+url' : 'curated',
          matchedComponentId: curated.id,
          fetchedUrl,
          sources: curated.sources,
          warnings,
        },
      };
    }
  }

  const spec = parseDatasheetText(fetchedText || rawText, overrides);
  return {
    tier: 'derived',
    spec: {
      ...spec,
      datasheetSources: fetchedUrl
        ? [{ label: 'Fetched datasheet URL', url: fetchedUrl, note: 'Parsed with WireUp heuristics.' }, ...(spec.datasheetSources ?? [])]
        : spec.datasheetSources,
    },
    provenance: {
      mode: fetchedUrl ? 'url' : 'heuristic',
      fetchedUrl,
      sources: fetchedUrl ? [{ label: 'Fetched datasheet URL', url: fetchedUrl, note: 'Parsed with WireUp heuristics.' }] : [],
      warnings,
    },
  };
}
