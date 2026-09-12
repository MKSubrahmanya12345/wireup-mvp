/**
 * Motion in the 3D live layer.
 *
 * A spinning shaft is invisible: a solid of revolution looks identical at every
 * angle, so a bench where motors turn and a bench where nothing moves render
 * the same picture. These tests pin down the two things that fix that, on the
 * REAL parametric models the scene draws:
 *
 *   • the rotation axis comes from the body's own shape (the CAD specs rotate a
 *     motor's output shafts 90°, so "always spin about Y" would spin a shaft
 *     about nothing);
 *   • a rotating body gets one raised index mark, sized to that body, so the
 *     rotation is visible — and it gets exactly one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';

import { loadParametricForKeys } from '../scene3d/cadCatalog';
import { resolveAnchor } from '../scene3d/live/anchors';
import { addSpinMark, inferSpinAxis, localBounds } from '../scene3d/live/LivePartSurfaces';
import type { LoadedModel } from '../scene3d/models3d';
import type { CadComponentSpec } from '../scene3d/cadTypes';

const PUBLIC = join(process.cwd(), 'public');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'live-surfaces.json'), 'utf-8')) as {
  parts: Record<
    string,
    { surfaces: { id: string; kind: string; anchor: Record<string, unknown>; motion?: { mode: string; props: string[] } }[] }
  >;
};
const catalog = JSON.parse(readFileSync(join(PUBLIC, 'cad-catalog.json'), 'utf-8')) as {
  entries: Record<string, { spec: CadComponentSpec }>;
};

/** The real scene builds geometry through a 2D canvas silkscreen; here it only
 *  has to exist, since this test is about the resulting solids. */
function stubCanvas(): void {
  const context = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'measureText') return () => ({ width: 12 });
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return () => ({ addColorStop: () => undefined });
        }
        return () => undefined;
      },
      set: () => true,
    },
  );
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => context }),
    getElementById: () => null,
  });
}

let models: Map<string, LoadedModel>;

beforeAll(async () => {
  stubCanvas();
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const file = join(PUBLIC, String(input).replace(/^\//, ''));
    if (!existsSync(file)) return { ok: false, status: 404, json: async () => null } as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf-8')) } as Response;
  });
  models = await loadParametricForKeys(Object.keys(manifest.parts));
});

/**
 * A per-instance copy of a catalogue model, exactly as the scene builds one
 * (`useMemo(() => model.group.clone())`): live marks belong to the instance, so
 * every test that adds one works on a clone and the shared asset stays export-clean.
 */
function instanceOf(key: string) {
  const model = models.get(key);
  if (!model) throw new Error(`no model for ${key}`);
  const clone = model.group.clone();
  clone.updateMatrixWorld(true);
  return clone;
}

/** The feature node a surface's anchor points at, on the real model. */
function targetFor(key: string, anchor: Record<string, unknown>) {
  const model = models.get(key);
  if (!model) return undefined;
  const bounds = model.bounds ?? new Box3().setFromObject(model.group);
  return resolveAnchor(anchor as never, model.group, {
    spec: catalog.entries[key]?.spec,
    recenter: model.recenter,
    bounds,
  })?.target;
}

const rotating = (): { key: string; id: string; anchor: Record<string, unknown> }[] =>
  Object.entries(manifest.parts).flatMap(([key, part]) =>
    (part.surfaces ?? [])
      .filter((surface) => surface.kind === 'motion' && ['spin', 'rotate'].includes(surface.motion?.mode ?? ''))
      .map((surface) => ({ key, id: surface.id, anchor: surface.anchor })),
  );

describe('rotation in the 3D live layer', () => {
  it('reads the axis of a body of revolution from its own shape', () => {
    const makeShaft = (size: [number, number, number]) => {
      const group = new Group();
      group.add(new Mesh(new BoxGeometry(size[0], size[1], size[2]), new MeshStandardMaterial()));
      return group;
    };
    expect(inferSpinAxis(makeShaft([3, 20, 3]))).toBe('y');
    expect(inferSpinAxis(makeShaft([20, 3, 3]))).toBe('x');
    expect(inferSpinAxis(makeShaft([3, 3, 20]))).toBe('z');
    // A flat disc is a body of revolution too, about its thin dimension.
    expect(inferSpinAxis(makeShaft([24, 2, 24]))).toBe('y');
    // A cube has no axis of its own; the bench's up axis is the honest default.
    expect(inferSpinAxis(makeShaft([10, 10, 10]))).toBe('y');
    // An empty body has nothing to turn about and must not throw.
    expect(inferSpinAxis(new Group())).toBe('y');
  });

  it('finds a turning axis for every rotating surface of the catalog', () => {
    const surfaces = rotating();
    expect(surfaces.length).toBeGreaterThan(12);
    const shapeless: string[] = [];
    for (const { key, id, anchor } of surfaces) {
      const target = targetFor(key, anchor);
      if (!target) {
        shapeless.push(`${key}/${id}: anchor did not resolve`);
        continue;
      }
      const size = localBounds(target).getSize(new Vector3());
      const extents = [size.x, size.y, size.z];
      const axis = inferSpinAxis(target);
      const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const along = extents[index] ?? 0;
      const others = extents.filter((_, position) => position !== index);
      const mean = ((others[0] ?? 0) + (others[1] ?? 0)) / 2;
      if (!(Math.abs(along - mean) > mean * 0.1) || mean <= 0) {
        shapeless.push(`${key}/${id}: ${axis} is not the odd axis of ${extents.map((n) => n.toFixed(1)).join('×')}`);
      }
    }
    expect(shapeless).toEqual([]);
  });

  it('turns each part about ITS OWN axis, not the bench’s up axis', () => {
    // `dc-motor-generic-6v` models both output shafts with `rotation: [90,0,0]`,
    // so on the bench they point along Z. The axis is read in the shaft's own
    // frame — where it is still the shaft's own long dimension — which is what
    // makes the composite rotation spin the shaft rather than precess it.
    expect(inferSpinAxis(targetFor('dc-motor-generic-6v', { frame: 'spec', feature: 'output_shaft_left' })!)).toBe('y');

    // …and the mark that makes that rotation visible lands PERPENDICULAR to the
    // shaft in world space: off the Z axis it turns about, not on it.
    const shaft = instanceOf('dc-motor-generic-6v').getObjectByName('output_shaft_left')!;
    addSpinMark(shaft);
    const mark = shaft.children.find((child) => child.name === 'live:index-mark') as Mesh;
    expect(mark).toBeDefined();
    const world = mark.getWorldPosition(new Vector3());
    const axisPoint = new Vector3();
    shaft.getWorldPosition(axisPoint);
    // World-space: the spec's `rotation: [90,0,0]` points this shaft along Z,
    // so a mark on its barrel is displaced in X/Y, never along Z.
    expect(Math.hypot(world.x - axisPoint.x, world.y - axisPoint.y)).toBeGreaterThan(0.3);
    expect(Math.abs(world.z - axisPoint.z)).toBeLessThan(0.6);
  });

  it('marks a rotating body once, sized to that body', () => {
    const target = instanceOf('dc-motor-generic-6v').getObjectByName('output_shaft_right')!;
    const before = localBounds(target).getSize(new Vector3());
    expect(target.children.some((child) => child.name === 'live:index-mark')).toBe(false);

    addSpinMark(target);
    addSpinMark(target); // idempotent: a re-mount must not stack a second key

    const marks = target.children.filter((child) => child.name === 'live:index-mark');
    expect(marks).toHaveLength(1);

    const mark = marks[0] as Mesh;
    expect(mark.material).toBeInstanceOf(MeshStandardMaterial);
    expect(Math.hypot(mark.position.x, mark.position.y, mark.position.z)).toBeGreaterThan(0.3);
    // Sized in the body's own frame: a key along the shaft, not a slab.
    mark.geometry.computeBoundingBox();
    const markSize = mark.geometry.boundingBox!.getSize(new Vector3());
    expect(markSize.y).toBeLessThanOrEqual(before.y + 0.5);
    expect(markSize.y).toBeGreaterThan(before.y * 0.5);
    expect(markSize.x).toBeLessThan(before.x);
    // A key never changes what the shaft IS: the body's own extent is intact.
    expect(localBounds(target).getSize(new Vector3()).y).toBeCloseTo(before.y, 1);
  });

  it('adds its marks to the instance, never to the shared catalogue model', () => {
    // The scene clones a model per instance (`useMemo(() => model.group.clone())`),
    // so two identical motors turn independently and the exported asset stays
    // exactly as generated.
    const shared = models.get('dc-motor-generic-6v')!;
    const clone = instanceOf('dc-motor-generic-6v');
    const target = clone.getObjectByName('output_shaft_left');
    expect(target).toBeDefined();
    addSpinMark(target!);
    expect(target!.children.some((child) => child.name === 'live:index-mark')).toBe(true);
    expect(clone.getObjectsByProperty('name', 'live:index-mark')).toHaveLength(1);
    expect(shared.group.getObjectsByProperty('name', 'live:index-mark')).toHaveLength(0);
  });
});
