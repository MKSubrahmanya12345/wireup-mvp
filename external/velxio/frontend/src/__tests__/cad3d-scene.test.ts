// @vitest-environment jsdom
/**
 * Cad3DScene's pure helpers — the 3D-position round-trip contract:
 *
 *   1. `numberProp` must read a saved x3d/y3d/z3d back whether it arrives as
 *      a JS number (fresh session) or a string (round-tripped through
 *      Wireup's diagram.json, where `simulator.attrs` is string-only).
 *   2. `layoutInstances` must "pin" any instance with a saved x3d/z3d at that
 *      exact spot instead of the auto-grid layout, and must NOT let a pinned
 *      instance consume the auto-grid cursor (so unpinned parts don't leave a
 *      gap where the pinned one would have sat).
 *
 * `buildParametricAssembly` is exercised too: every catalog part must get a
 * REAL shaded body — the whole point of this feature is that nothing falls
 * back to an empty/placeholder mesh.
 */
import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { numberProp, layoutInstances, type InstancePlace } from '../scene3d/Cad3DScene';
import { buildParametricAssembly } from '../scene3d/cadParametric';
import type { CadComponentSpec } from '../scene3d/cadTypes';
import type { LoadedModel } from '../scene3d/models3d';

describe('numberProp', () => {
  it('reads a numeric property', () => {
    expect(numberProp({ x3d: 12.5 }, 'x3d')).toBe(12.5);
  });

  it('reads a stringified property (diagram.json round-trip)', () => {
    expect(numberProp({ z3d: '-30.25' }, 'z3d')).toBe(-30.25);
  });

  it('treats an empty string as absent, not zero', () => {
    expect(numberProp({ y3d: '' }, 'y3d')).toBeNull();
  });

  it('returns null for a missing key', () => {
    expect(numberProp({}, 'x3d')).toBeNull();
    expect(numberProp(undefined, 'x3d')).toBeNull();
  });

  it('returns null for a non-numeric string rather than NaN', () => {
    expect(numberProp({ x3d: 'not-a-number' }, 'x3d')).toBeNull();
  });
});

function fakeModel(sizeX = 20): LoadedModel {
  return {
    def: { file: '' },
    group: new Group(),
    pins: new Map(),
    size: { x: sizeX, y: 5, z: sizeX } as unknown as LoadedModel['size'],
  };
}

describe('layoutInstances', () => {
  it('auto-grids instances with no saved 3D position', () => {
    const models = new Map([['led', fakeModel()]]);
    const { places, order } = layoutInstances(
      [
        { id: 'a', key: 'led' },
        { id: 'b', key: 'led' },
      ],
      models,
    );
    expect(order).toEqual(['a', 'b']);
    const a = places.get('a') as InstancePlace;
    const b = places.get('b') as InstancePlace;
    expect(a.pinned).toBe(false);
    expect(b.pinned).toBe(false);
    // b sits further along the auto-grid cursor than a.
    expect(b.pos.x).toBeGreaterThan(a.pos.x);
  });

  it('places a part with saved x3d/z3d at exactly that spot', () => {
    const models = new Map([['led', fakeModel()]]);
    const { places } = layoutInstances(
      [{ id: 'a', key: 'led', properties: { x3d: 42, y3d: 3, z3d: -17 } }],
      models,
    );
    const a = places.get('a') as InstancePlace;
    expect(a.pinned).toBe(true);
    expect(a.pos.x).toBe(42);
    expect(a.pos.y).toBe(3);
    expect(a.pos.z).toBe(-17);
  });

  it('does not let a pinned instance consume the auto-grid cursor', () => {
    const models = new Map([['led', fakeModel()]]);
    const { places } = layoutInstances(
      [
        { id: 'pinned', key: 'led', properties: { x3d: 999, z3d: 999 } },
        { id: 'auto', key: 'led' },
      ],
      models,
    );
    const auto = places.get('auto') as InstancePlace;
    // The auto-grid cursor starts at 0 regardless of the pinned part's
    // location — it must land at the very first grid slot, not be pushed
    // past 999.
    expect(auto.pos.x).toBeLessThan(200);
  });

  it('omits an instance with no resolvable model (GLB or parametric)', () => {
    const models = new Map<string, LoadedModel>();
    const { order } = layoutInstances([{ id: 'a', key: 'unknown-part' }], models);
    expect(order).toEqual([]);
  });

  it('rests every auto-placed part ON the bench (no sinking through the grid)', () => {
    const models = new Map([['led', fakeModel()]]);
    const { places } = layoutInstances([{ id: 'a', key: 'led' }], models);
    const a = places.get('a') as InstancePlace;
    // Models are origin-centred at their bbox centroid by the loader, so a
    // part that is not lifted by half its height has half its body under the
    // bench. y must be exactly height / 2 (the fake model is 5 mm tall).
    expect(a.pos.y).toBeCloseTo(2.5, 5);
  });

  it('anchors boards on the back row and packs parts in front of them (+z)', () => {
    const models = new Map([
      ['board', fakeModel(80)],
      ['led', fakeModel(10)],
    ]);
    const { places } = layoutInstances(
      [
        { id: 'b', key: 'board', kind: 'board' },
        { id: 'p', key: 'led', kind: 'part' },
      ],
      models,
    );
    const board = places.get('b') as InstancePlace;
    const part = places.get('p') as InstancePlace;
    expect(board.pos.z).toBe(0);
    expect(part.pos.z).toBeGreaterThan(board.pos.z);
    // Both are seated, not floating and not sunk.
    expect(board.pos.y).toBeCloseTo(2.5, 5);
    expect(part.pos.y).toBeCloseTo(2.5, 5);
  });

  it('wraps a long row instead of running off to infinity', () => {
    const models = new Map([['led', fakeModel(400)]]);
    const instances = Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, key: 'led', kind: 'part' as const }));
    const { places } = layoutInstances(instances, models);
    const zs = instances.map((inst) => (places.get(inst.id) as InstancePlace).pos.z);
    // 400 mm parts + a 40 mm gap: three fit in the 1000 mm span, so the fourth
    // must start a new row further from the boards.
    expect(new Set(zs).size).toBeGreaterThan(1);
    expect(Math.max(...zs)).toBeGreaterThan(Math.min(...zs));
  });

  it('accepts a numeric-string saved position (post diagram.json round-trip)', () => {
    const models = new Map([['led', fakeModel()]]);
    const { places } = layoutInstances(
      [{ id: 'a', key: 'led', properties: { x3d: '10', y3d: '0', z3d: '5' } }],
      models,
    );
    const a = places.get('a') as InstancePlace;
    expect(a.pinned).toBe(true);
    expect(a.pos.x).toBe(10);
    expect(a.pos.z).toBe(5);
  });
});

const MINIMAL_SPEC: CadComponentSpec = {
  id: 'test-part',
  name: 'Test part',
  category: 'sensor',
  description: 'A minimal spec for geometry-builder tests.',
  voltage: 5,
  currentMa: 10,
  dimensions: { widthMm: 20, lengthMm: 10, heightMm: 2 },
  pins: [
    { name: 'VCC', pinNumber: 1, role: 'power', signal: '5V', xMm: -5, yMm: 2, zMm: 5, direction: 'front' },
    { name: 'GND', pinNumber: 2, role: 'ground', signal: 'GND', xMm: 5, yMm: 2, zMm: 5, direction: 'front' },
  ],
  features: [
    { name: 'sensor_dome', type: 'lens', dimensions: [6, 6, 6], position: [0, 3, 0], color: '#eeeeee' },
  ],
  protocols: ['gpio'],
  keywords: [],
  aliases: [],
};

describe('buildParametricAssembly', () => {
  it('builds a non-empty shaded group for a spec — never an empty placeholder', () => {
    const group = buildParametricAssembly(MINIMAL_SPEC);
    expect(group.children.length).toBeGreaterThan(0);
  });

  it('adds a named pin-anchor node for every declared pin, matching the GLB pin contract', () => {
    const group = buildParametricAssembly(MINIMAL_SPEC);
    expect(group.getObjectByName('VCC')).toBeTruthy();
    expect(group.getObjectByName('GND')).toBeTruthy();
  });

  it('renders a real feature mesh (not just the base body) for a declared feature', () => {
    const group = buildParametricAssembly(MINIMAL_SPEC);
    expect(group.getObjectByName('sensor_dome')).toBeTruthy();
  });

  it('respects bodyStyle "none" (loose parts get no fake PCB slab)', () => {
    const looseSpec: CadComponentSpec = { ...MINIMAL_SPEC, bodyStyle: 'none', pinStyle: 'leads' };
    const group = buildParametricAssembly(looseSpec);
    expect(group.getObjectByName('PCB substrate')).toBeFalsy();
    // Still gets its pins + feature — not empty.
    expect(group.children.length).toBeGreaterThan(0);
  });
});
