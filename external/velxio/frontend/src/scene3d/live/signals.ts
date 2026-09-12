/**
 * signals — how the 3D view reads a part's live state.
 *
 * THE RULE: the 3D view reads the 2D element. Not a copy, not a second
 * simulation — the same DOM node the canvas is already rendering, looked up by
 * component id (`document.getElementById(componentId)`, the same lookup
 * `DynamicComponent` mounts that `MotorDriverParts` already uses to find a
 * wired element). Whatever the sketch made the part do in 2D is therefore
 * exactly what the 3D view shows; there is no code path that can drift.
 *
 * Four channels exist, and only four — the table names one per signal:
 *
 *   1. element properties — `characters`, `imageData`, `brightness`, `angle`,
 *      `values`, `xValue`, a real `canvas`, …;
 *   2. `usePartRenderStore` — the transient, deliberately NON-persisted mirror
 *      the parts already write for continuous values that are cheaper to push
 *      than to poll (pixel streams, horn angles). It is read imperatively via
 *      `getState()` and never subscribed to, so a 60 Hz write in a part cannot
 *      re-render React. Named `store:<key>` in the table;
 *   3. the component property bag — the keys a part emits with
 *      `emitPropertyChange` (the same values the property panel shows), named
 *      `bag:<key>`. This is how a sensor reading reaches 3D without any element
 *      property existing for it;
 *   4. pin state through the wire graph — `pin:<PIN>`, resolved with the same
 *      `traceBoardGpio` walk the 2D canvas and SPICE use, for parts whose only
 *      output IS their pin (motion detectors, tilt switches, relay coils).
 *
 * A value that is neither is treated as absent: the surface stays dark rather
 * than inventing something.
 */

import { usePartRenderStore, type StoredPixel } from '../../store/usePartRenderStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { traceBoardGpio } from '../../simulation/PinTrace';

/** The parts of an element this module reads. Everything is optional — the
 *  table decides what a given part actually exposes. */
export interface LiveElementLike {
  characters?: Uint8Array | number[] | null;
  font?: Uint8Array | number[] | null;
  backlight?: boolean;
  cursor?: boolean;
  blink?: boolean;
  cursorX?: number;
  cursorY?: number;
  colon?: boolean;
  colonValue?: boolean;
  imageData?: ImageData | null;
  canvas?: HTMLCanvasElement | null;
  values?: number[] | null;
  digits?: number;
  brightness?: number;
  angle?: number;
  value?: number | boolean | string;
  xValue?: number;
  yValue?: number;
  pressed?: boolean;
  ledRed?: number;
  ledGreen?: number;
  ledBlue?: number;
  r?: number;
  g?: number;
  b?: number;
  temperature?: number;
  humidity?: number;
  distance?: number;
  hasSignal?: boolean;
  ledPower?: boolean;
  ledSignal?: boolean;
  ledD0?: boolean;
  led1?: boolean;
  led2?: boolean;
  [key: string]: unknown;
}

/** Find the live 2D element for a component instance, or null. */
export function liveElement(componentId: string): LiveElementLike | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(componentId);
  return (el as unknown as LiveElementLike) ?? null;
}

/** Read one property off an element, defensively. */
export function readProp(el: LiveElementLike | null, prop: string | undefined): unknown {
  if (!el || !prop) return undefined;
  try {
    return el[prop];
  } catch {
    return undefined;
  }
}

/** Read a store-mirrored value (the transient channel), or undefined. */
export function readStore(componentId: string, key: string): unknown {
  const values = usePartRenderStore.getState().values[componentId];
  return values ? values[key] : undefined;
}

/** Read a key the part emitted into its component property bag. */
export function readPropertyBag(componentId: string, key: string): unknown {
  const component = useSimulatorStore.getState().components.find((entry) => entry.id === componentId);
  if (!component) return undefined;
  return (component.properties as Record<string, unknown> | undefined)?.[key];
}

/**
 * Read the live state of one of the part's own pins, THROUGH the wire graph:
 * which board GPIO owns this pin's net (`traceBoardGpio`) and what that GPIO is
 * currently driving (`PinManager.getPinState`).
 *
 * This is the channel for parts that have no element property of their own —
 * a PIR that pulls OUT high for three seconds, a tilt switch, a relay coil —
 * and it is the same net resolution the 2D canvas and the SPICE layer use, so
 * it cannot disagree with them. Returns null when the pin is not wired to a
 * board at all (nothing to read, surface stays dark).
 */
export function readPinState(componentId: string, pinName: string): boolean | null {
  const state = useSimulatorStore.getState();
  const gpio = traceBoardGpio(state, componentId, pinName);
  if (gpio === null) return null;
  return state.pinManager.getPinState(gpio);
}

/**
 * Read a signal by name. Namespaces let the table name a channel explicitly:
 *
 *   `store:pixels`     — the render-store mirror (`usePartRenderStore`)
 *   `bag:temperature`  — the component property bag (`emitPropertyChange`)
 *   `pin:OUT`          — the board GPIO this part pin's net traces to
 *   `characters`       — bare: store, then property bag, then the element
 */
export function readSignal(
  componentId: string,
  el: LiveElementLike | null,
  prop: string | undefined,
): unknown {
  if (!prop) return undefined;
  if (prop.startsWith('store:')) return readStore(componentId, prop.slice('store:'.length));
  if (prop.startsWith('bag:')) return readPropertyBag(componentId, prop.slice('bag:'.length));
  if (prop.startsWith('pin:')) return readPinState(componentId, prop.slice('pin:'.length)) ?? undefined;
  const fromStore = readStore(componentId, prop);
  if (fromStore !== undefined) return fromStore;
  const fromBag = readPropertyBag(componentId, prop);
  if (fromBag !== undefined) return fromBag;
  return readProp(el, prop);
}

/** Coerce to a finite number, or null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Coerce to a boolean. Strings 'false'/'0'/'' are false (the canvas stores
 *  attributes as strings on some elements). */
export function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0';
  return Boolean(value);
}

/** Parse a CSS colour into [r, g, b] in 0..1 (three's colour space). */
export function parseColor(css: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!css) return fallback;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const body = hex[1] as string;
    const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
    const n = parseInt(full, 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css.trim());
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  return fallback;
}

/** A single addressable pixel as the store mirror carries it (re-exported so
 *  painters and consumers share ONE definition of the pixel shape). */
export type { StoredPixel };

/** Read the RGB pixel field a part mirrored into the store (`pixels`). */
export function readPixels(componentId: string): StoredPixel[] | null {
  const value = readStore(componentId, 'pixels');
  if (!Array.isArray(value)) return null;
  return (value as StoredPixel[]).filter((p) => p && typeof p === 'object');
}
