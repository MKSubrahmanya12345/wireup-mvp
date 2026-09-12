/**
 * The signal layer: how the 3D view reads a part's live state.
 *
 * The table names a channel per signal (`characters`, `store:pixels`,
 * `bag:temperature`, `pin:OUT`). Which one wins, and what happens when a
 * channel has nothing, is decided in `scene3d/live/signals.ts` — so it is
 * tested here without React, without a canvas and without a running simulator.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asBoolean, asNumber, liveElement, parseColor, readPixels, readPropertyBag, readSignal } from '../scene3d/live/signals';
import { usePartRenderStore } from '../store/usePartRenderStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

interface FakeElement {
  id: string;
  characters?: Uint8Array;
  brightness?: number;
  angle?: number;
  color?: string;
  [key: string]: unknown;
}

const elements = new Map<string, FakeElement>();

beforeEach(() => {
  elements.clear();
  usePartRenderStore.setState({ values: {} });
  vi.stubGlobal('document', {
    getElementById: (id: string) => elements.get(id) ?? null,
  });
});

/** Add a component (with its property bag) to the simulator store. */
function withComponent(id: string, properties: Record<string, unknown>): void {
  const state = useSimulatorStore.getState();
  useSimulatorStore.setState({
    components: [...state.components.filter((component) => component.id !== id), { id, properties } as never],
  });
}

describe('liveElement', () => {
  it('finds the mounted 2D element by component id, and nothing else', () => {
    elements.set('c1', { id: 'c1', brightness: 0.5 });
    expect(liveElement('c1')?.brightness).toBe(0.5);
    expect(liveElement('c2')).toBeNull();
  });
});

describe('readSignal channels', () => {
  it('reads a bare property off the element', () => {
    const el: FakeElement = { id: 'c1', brightness: 0.25 };
    expect(readSignal('c1', el, 'brightness')).toBe(0.25);
    expect(readSignal('c1', el, 'missing-property')).toBeUndefined();
  });

  it('prefers the render-store mirror the part pushed over the element', () => {
    // A servo writes both; the mirror is the value the 3D view animates from.
    const el: FakeElement = { id: 'c1', angle: 10 };
    usePartRenderStore.getState().setValue('c1', { angle: 175 });
    expect(readSignal('c1', el, 'angle')).toBe(175);
  });

  it('reads the render store explicitly, and reads a frame of pixels', () => {
    const el: FakeElement = { id: 'c1' };
    const frame = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 0, b: 255 },
    ];
    usePartRenderStore.getState().setValue('c1', { pixels: frame });
    expect(readSignal('c1', el, 'store:pixels')).toEqual(frame);
    expect(readPixels('c1')).toEqual(frame);
    expect(readPixels('c2')).toBeNull();
  });

  it('reads the component property bag a sensor emits into', () => {
    const el: FakeElement = { id: 'c1' };
    withComponent('c1', { temperature: 26.4 });
    expect(readPropertyBag('c1', 'temperature')).toBe(26.4);
    expect(readSignal('c1', el, 'bag:temperature')).toBe(26.4);
    // The bag also answers a bare name, behind the store.
    expect(readSignal('c1', el, 'temperature')).toBe(26.4);
    expect(readSignal('c1', el, 'bag:nothing-emitted')).toBeUndefined();
  });

  it('returns nothing for a pin that is not wired to a board', () => {
    const el: FakeElement = { id: 'c1' };
    withComponent('c1', {});
    // No board, no wires: the honest answer is "no state", not `false`.
    expect(readSignal('c1', el, 'pin:OUT')).toBeUndefined();
  });
});

describe('value coercion', () => {
  it('coerces the shapes an element can hand back', () => {
    expect(asNumber(12)).toBe(12);
    expect(asNumber(true)).toBe(1);
    expect(asNumber('3.5')).toBe(3.5);
    expect(asNumber('abc')).toBeNull();
    expect(asNumber(undefined)).toBeNull();
    expect(asNumber(Number.NaN)).toBeNull();
  });

  it('treats attribute-style strings as booleans', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(0)).toBe(false);
    expect(asBoolean('false')).toBe(false);
    expect(asBoolean('0')).toBe(false);
    expect(asBoolean('')).toBe(false);
    expect(asBoolean('i2c')).toBe(true);
  });

  it('parses the colours an element carries, falling back when it has none', () => {
    expect(parseColor('#ff0000', [0, 0, 0])).toEqual([1, 0, 0]);
    expect(parseColor('#0f0', [0, 0, 0])).toEqual([0, 1, 0]);
    expect(parseColor('rgb(0, 128, 255)', [0, 0, 0])[2]).toBeCloseTo(1, 5);
    expect(parseColor(undefined, [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    expect(parseColor('var(--x)', [0.4, 0.5, 0.6])).toEqual([0.4, 0.5, 0.6]);
  });
});
