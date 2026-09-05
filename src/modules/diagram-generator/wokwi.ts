/**
 * Wokwi adapter.
 *
 * Projects the simulator-agnostic `wireup-diagram` into the Wokwi `diagram.json`
 * shape. Swapping or adding another simulator target only means adding a file
 * like this one — the planners and the diagram generator stay untouched.
 *
 * Wokwi parts name their pins differently from the Wireup catalog (an SSD1306
 * exposes `DATA`/`CLK`/`VIN`, an Arduino digital pin is `4` rather than `D4`,
 * ground is `GND.1`). The per-part tables below translate catalog pin names
 * into the simulator's vocabulary so the exported diagram loads and simulates
 * without hand edits. Sources: docs.wokwi.com/parts/<part>.
 */

import type { Diagram, DiagramComponent } from '@/types/diagram';

export interface WokwiPart {
  type: string;
  id: string;
  top: number;
  left: number;
  attrs: Record<string, string>;
}

/** Wokwi connections are tuples: [from, to, colour, routeHints]. */
export type WokwiConnection = [string, string, string, string[]];

export interface WokwiDiagram {
  version: 1;
  author: string;
  editor: string;
  parts: WokwiPart[];
  connections: WokwiConnection[];
}

export interface WokwiProjection {
  diagram: WokwiDiagram;
  skippedParts: { id: string; ref: string; reason: string }[];
  skippedConnections: { id: string; reason: string }[];
  warnings: string[];
}

/* ------------------------------------------------------------------------- */
/* Pin-name translation                                                       */
/* ------------------------------------------------------------------------- */

type PinMapper = (catalogPin: string) => string | undefined;

/** Case-insensitive lookup table mapper. */
function table(map: Record<string, string>): PinMapper {
  const lower = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return (pin) => lower.get(pin.toLowerCase());
}

/** Arduino AVR boards: `D7` → `7`, `A4` → `A4`, `GND` → `GND.1`, `3V3` → `3.3V`. */
function arduinoAvrPins(hasThreeVoltRail: boolean): PinMapper {
  return (pin) => {
    const upper = pin.toUpperCase();
    const digital = /^D(\d{1,2})$/.exec(upper);
    if (digital) return digital[1];
    if (/^\d{1,2}$/.test(upper)) return upper;
    if (/^A\d$/.test(upper)) return upper;
    switch (upper) {
      case 'GND':
        return 'GND.1';
      case '5V':
      case 'VCC':
        return '5V';
      case 'VIN':
      case 'RAW':
        return 'VIN';
      case '3V3':
      case '3.3V':
        return hasThreeVoltRail ? '3.3V' : undefined;
      case 'AREF':
        return 'AREF';
      case 'RESET':
      case 'RST':
        return 'RESET';
      case 'SDA':
        return 'A4';
      case 'SCL':
        return 'A5';
      default:
        return undefined;
    }
  };
}

/** ESP32 DevKit V1: `GPIO4` → `D4`, strapping/UART pins by their silk names. */
const esp32DevkitPins: PinMapper = (pin) => {
  const upper = pin.toUpperCase();
  const special: Record<string, string> = {
    GPIO1: 'TX0',
    GPIO3: 'RX0',
    GPIO16: 'RX2',
    GPIO17: 'TX2',
    GPIO36: 'VP',
    GPIO39: 'VN',
    '3V3': '3V3',
    '3.3V': '3V3',
    VIN: 'VIN',
    '5V': 'VIN',
    GND: 'GND.1',
    EN: 'EN',
    RESET: 'EN',
  };
  if (special[upper]) return special[upper];
  const gpio = /^GPIO(\d{1,2})$/.exec(upper);
  if (gpio) return `D${gpio[1]}`;
  const d = /^D(\d{1,2})$/.exec(upper);
  if (d) return upper;
  return undefined;
};

/** Identity mapper for parts whose Wokwi pins equal the catalog names. */
const identity: PinMapper = (pin) => pin;

/**
 * Catalog pin → Wokwi pin per simulator part type. Parts missing from this
 * table pass their pin names through unchanged (and a warning is raised).
 */
const PIN_MAPS: Record<string, PinMapper> = {
  'wokwi-arduino-uno': arduinoAvrPins(false),
  'wokwi-arduino-nano': arduinoAvrPins(true),
  'wokwi-arduino-mega': arduinoAvrPins(true),
  'wokwi-esp32-devkit-v1': esp32DevkitPins,
  'wokwi-ssd1306': table({ VCC: 'VIN', VIN: 'VIN', GND: 'GND', SCL: 'CLK', SDA: 'DATA', '3V3': '3V3' }),
  'board-ssd1306': table({ VCC: 'VCC', GND: 'GND', SCL: 'SCL', SDA: 'SDA' }),
  'wokwi-lcd1602': table({ VCC: 'VCC', GND: 'GND', SDA: 'SDA', SCL: 'SCL' }),
  'wokwi-lcd2004': table({ VCC: 'VCC', GND: 'GND', SDA: 'SDA', SCL: 'SCL' }),
  'wokwi-pushbutton': table({ '1': '1.r', '2': '2.r', A: '1.r', B: '2.r', LEG1: '1.r', LEG2: '2.r' }),
  'wokwi-led': table({ A: 'A', C: 'C' }),
  'wokwi-rgb-led': table({ R: 'R', G: 'G', B: 'B', CATHODE: 'COM', COM: 'COM' }),
  'wokwi-resistor': table({ '1': '1', '2': '2', A: '1', B: '2' }),
  'wokwi-servo': table({ SIGNAL: 'PWM', VCC: 'V+', GND: 'GND' }),
  'wokwi-hc-sr04': table({ VCC: 'VCC', TRIG: 'TRIG', ECHO: 'ECHO', GND: 'GND' }),
  'wokwi-dht22': table({ VCC: 'VCC', DATA: 'SDA', GND: 'GND' }),
  'wokwi-dht11': table({ VCC: 'VCC', DATA: 'SDA', GND: 'GND' }),
  'wokwi-buzzer': table({ '+': '2', '-': '1' }),
  'wokwi-potentiometer': table({ A: 'VCC', WIPER: 'SIG', B: 'GND' }),
  'wokwi-photoresistor-sensor': table({ VCC: 'VCC', GND: 'GND', DO: 'DO', AO: 'AO' }),
  'wokwi-neopixel': table({ VCC: 'VDD', GND: 'VSS', DIN: 'DIN', DOUT: 'DOUT' }),
  'wokwi-mpu6050': table({ VCC: 'VCC', GND: 'GND', SCL: 'SCL', SDA: 'SDA', INT: 'INT', AD0: 'AD0' }),
  'wokwi-pir-motion-sensor': table({ VCC: 'VCC', OUT: 'OUT', GND: 'GND' }),
  'wokwi-relay-module': table({ VCC: 'VCC', GND: 'GND', IN: 'IN', COM: 'COM', NO: 'NO', NC: 'NC' }),
};

/** Attributes Wokwi needs for a part to behave like the catalog entry. */
const DEFAULT_ATTRS: Record<string, Record<string, string>> = {
  'wokwi-led': { color: 'red' },
  'wokwi-rgb-led': { common: 'cathode' },
  'wokwi-lcd1602': { pins: 'i2c' },
  'wokwi-lcd2004': { pins: 'i2c' },
};

/** Approximate Wokwi footprint (px) so parts are spaced without overlap. */
const PART_SIZE: Record<string, { width: number; height: number }> = {
  'wokwi-arduino-uno': { width: 290, height: 210 },
  'wokwi-arduino-nano': { width: 180, height: 70 },
  'wokwi-arduino-mega': { width: 390, height: 210 },
  'wokwi-esp32-devkit-v1': { width: 110, height: 210 },
  'wokwi-ssd1306': { width: 150, height: 120 },
  'wokwi-lcd1602': { width: 310, height: 140 },
  'wokwi-servo': { width: 120, height: 90 },
  'wokwi-hc-sr04': { width: 180, height: 100 },
  'wokwi-breadboard': { width: 650, height: 210 },
};

const COLOR_NAMES: { name: string; hexes: string[] }[] = [
  { name: 'red', hexes: ['#c62828', '#d32f2f', '#f44336', 'red'] },
  { name: 'black', hexes: ['#212121', '#000000', 'black'] },
  { name: 'blue', hexes: ['#1565c0', '#0277bd', '#2196f3', 'blue'] },
  { name: 'green', hexes: ['#2e7d32', '#558b2f', '#4caf50', 'green'] },
  { name: 'orange', hexes: ['#ef6c00', '#ff9800', 'orange'] },
  { name: 'purple', hexes: ['#6a1b9a', '#9c27b0', 'purple'] },
  { name: 'cyan', hexes: ['#00838f', '#00bcd4', 'cyan'] },
  { name: 'brown', hexes: ['#4e342e', '#795548', 'brown'] },
  { name: 'yellow', hexes: ['#f9a825', '#fdd835', 'yellow'] },
];

const PALETTE = ['green', 'blue', 'orange', 'purple', 'cyan', 'brown', 'yellow', 'white', 'grey'];

function colourFor(value: string | undefined, kind: string, index: number): string {
  if (kind === 'ground') return 'black';
  if (kind === 'power') return 'red';
  if (value) {
    const normalised = value.toLowerCase().trim();
    const match = COLOR_NAMES.find((entry) => entry.hexes.includes(normalised));
    if (match) return match.name;
  }
  return PALETTE[index % PALETTE.length] as string;
}

/* ------------------------------------------------------------------------- */
/* Placement                                                                  */
/* ------------------------------------------------------------------------- */

interface Placement {
  top: number;
  left: number;
}

/**
 * Lay parts out in three columns — inputs left, controller centre, outputs and
 * displays right — with the controller's footprint deciding the column width.
 * Wireup's own canvas coordinates are tuned for its renderer, not for the
 * physical size of Wokwi parts, so we do not reuse them.
 */
function placeParts(components: DiagramComponent[]): Map<string, Placement> {
  const columnOf = (component: DiagramComponent): number => {
    switch (component.category) {
      case 'microcontroller':
        return 1;
      case 'sensor':
      case 'input_device':
      case 'power':
      case 'communication':
        return 0;
      default:
        return 2;
    }
  };

  const columns: DiagramComponent[][] = [[], [], []];
  for (const component of components) columns[columnOf(component)]!.push(component);

  const GAP = 40;
  const placements = new Map<string, Placement>();
  let left = 0;
  for (const column of columns) {
    let top = 0;
    let widest = 0;
    for (const component of column) {
      const size = PART_SIZE[component.simulator?.part ?? ''] ?? { width: 100, height: 60 };
      placements.set(component.id, { top, left });
      top += size.height + GAP;
      widest = Math.max(widest, size.width);
    }
    left += (widest || 100) + GAP * 2;
  }
  return placements;
}

/* ------------------------------------------------------------------------- */
/* Projection                                                                 */
/* ------------------------------------------------------------------------- */

export function toWokwiDiagram(diagram: Diagram): WokwiProjection {
  const parts: WokwiPart[] = [];
  const skippedParts: WokwiProjection['skippedParts'] = [];
  const skippedConnections: WokwiProjection['skippedConnections'] = [];
  const warnings: string[] = [];

  const included = new Map<string, DiagramComponent>();
  const unmappedTypes = new Set<string>();

  for (const component of diagram.components) {
    const simulatorPart = component.simulator?.part;
    if (!simulatorPart) {
      skippedParts.push({
        id: component.id,
        ref: component.ref,
        reason: component.simulator?.notes ?? 'No simulator part mapping exists in the component catalog for this part.',
      });
      continue;
    }
    if (component.simulator?.supported === false) {
      skippedParts.push({
        id: component.id,
        ref: component.ref,
        reason: component.simulator.notes ?? `Part mapping "${simulatorPart}" is not verified as supported by the target simulator.`,
      });
      continue;
    }
    // The wiring medium (breadboard, jumper wires) carries no connections in
    // the Wireup graph; a floating breadboard only clutters the simulator.
    if (component.metadata?.electrical === false) {
      skippedParts.push({ id: component.id, ref: component.ref, reason: 'Wiring medium — not part of the electrical graph.' });
      continue;
    }
    included.set(component.id, component);
  }

  const placements = placeParts([...included.values()]);
  for (const component of included.values()) {
    const simulatorPart = component.simulator?.part as string;
    const placement = placements.get(component.id) ?? { top: component.y, left: component.x };
    parts.push({
      type: simulatorPart,
      id: component.id,
      top: placement.top,
      left: placement.left,
      attrs: { ...(DEFAULT_ATTRS[simulatorPart] ?? {}), ...(component.simulator?.attrs ?? {}) },
    });
    if (!PIN_MAPS[simulatorPart]) unmappedTypes.add(simulatorPart);
  }

  const translate = (component: DiagramComponent, pin: string): string | undefined => {
    const mapper = PIN_MAPS[component.simulator?.part ?? ''] ?? identity;
    return mapper(pin);
  };

  const connections: WokwiConnection[] = [];
  const seen = new Set<string>();
  let signalIndex = 0;
  for (const connection of diagram.connections) {
    const from = included.get(connection.from.component);
    const to = included.get(connection.to.component);
    if (!from || !to) {
      skippedConnections.push({
        id: connection.id,
        reason: `Endpoint part is not representable in the target simulator (${connection.from.component} → ${connection.to.component}).`,
      });
      continue;
    }
    if (from.id === to.id) {
      skippedConnections.push({ id: connection.id, reason: `Self-connection on ${from.id}.` });
      continue;
    }

    const fromPin = translate(from, connection.from.pin);
    const toPin = translate(to, connection.to.pin);
    if (!fromPin || !toPin) {
      const missing = !fromPin ? `${from.id}:${connection.from.pin}` : `${to.id}:${connection.to.pin}`;
      skippedConnections.push({ id: connection.id, reason: `Pin ${missing} has no equivalent on the simulator part.` });
      continue;
    }

    const key = [`${from.id}:${fromPin}`, `${to.id}:${toPin}`].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const colour = colourFor(connection.wireColor, connection.kind, signalIndex);
    if (connection.kind === 'signal') signalIndex += 1;
    connections.push([`${from.id}:${fromPin}`, `${to.id}:${toPin}`, colour, []]);
  }

  if (skippedParts.some((part) => part.reason !== 'Wiring medium — not part of the electrical graph.')) {
    const ids = skippedParts.filter((part) => !part.reason.startsWith('Wiring medium')).map((part) => part.id);
    warnings.push(`${ids.length} part(s) have no verified simulator mapping and were omitted: ${ids.join(', ')}.`);
  }
  if (skippedConnections.length > 0) {
    warnings.push(`${skippedConnections.length} connection(s) were dropped because an endpoint is not representable in the simulator.`);
  }
  if (unmappedTypes.size > 0) {
    warnings.push(
      `Pin names for ${[...unmappedTypes].join(', ')} are passed through from the Wireup catalog — confirm they match the simulator part before running.`,
    );
  }

  return {
    diagram: {
      version: 1,
      author: 'Wireup',
      editor: 'wokwi',
      parts,
      connections,
    },
    skippedParts,
    skippedConnections,
    warnings,
  };
}
