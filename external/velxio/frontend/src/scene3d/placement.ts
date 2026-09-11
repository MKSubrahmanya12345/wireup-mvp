/**
 * placement — where every instance sits on the 3D bench.
 *
 * Extracted from Cad3DScene so the layout is a PURE function of
 * (instances, loaded models) and can be tested without a canvas, a DOM or
 * React (see `src/__tests__/cad3d-scene.test.ts`).
 *
 * What changed and why (2026-09-11):
 *
 *   1. **Parts rest ON the bench.** Every loaded model (GLB or parametric) is
 *      origin-centred at its bounding-box centroid, so a part placed at y = 0
 *      has HALF ITS BODY UNDER the grid. The auto layout now lifts each part by
 *      its own half-height. A saved `y3d` still wins (that is a user's
 *      explicit edit).
 *
 *   2. **Boards anchor the bench, parts sit in front of them.** The old layout
 *      was one endless left-to-right row for boards AND parts alike, so a
 *      100-part project became a 30-metre corridor and the board was lost in
 *      the middle of it. Boards now hold the back row (z = 0, side by side)
 *      and peripherals pack into rows in front (+z, toward the default
 *      camera).
 *
 *   3. **Rows wrap, spacing comes from real footprints.** Spacing uses each
 *      model's actual bounding box plus a gap, and a row wraps once it would
 *      exceed `BENCH_ROW_SPAN_MM` — so nothing overlaps and nothing runs off
 *      to infinity. A part that is wider than the span still gets its own row
 *      (never dropped, never overlapped).
 *
 * Pinned instances (`x3d` + `z3d` saved on the component — a user dragged it
 * in 3D, or Wireup's exporter wrote a floor plan) are placed exactly, and do
 * not consume any auto-layout cursor, so unpinned parts do not leave a gap
 * where the pinned one would have sat.
 */

import { Vector3 } from 'three';
import type { LoadedModel } from './models3d';

export interface BenchInstance {
  id: string;
  key: string;
  /** 'board' instances anchor the back row; 'part' instances grid in front. */
  kind?: 'board' | 'part';
  properties?: Record<string, unknown>;
}

export interface InstancePlace {
  id: string;
  key: string;
  pos: Vector3;
  rotY: number;
  scale: number;
  /** True when the user (or a saved project) pinned this instance's spot —
   *  it then does not participate in the auto-grid layout cursor. */
  pinned: boolean;
}

/** Clear space between neighbouring parts, in world mm. */
export const BENCH_GAP_MM = 40;
/** A row wraps once it would exceed this width, in world mm. */
export const BENCH_ROW_SPAN_MM = 1000;

/** Read a numeric override out of a properties bag. Values may arrive as
 *  strings — they round-trip through Wireup's diagram.json as
 *  `simulator.attrs`, which is string-only (see stringifyProperties in
 *  vlx-sync.ts) — so a plain `Number()` coercion is required on read. */
export function numberProp(
  properties: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const raw = properties?.[key];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface Resolved {
  inst: BenchInstance;
  model: LoadedModel;
}

/** Natural footprint of a model, guarded against a degenerate bbox. */
function footprint(model: LoadedModel): { width: number; depth: number; height: number } {
  const { x, y, z } = model.size;
  return {
    width: Number.isFinite(x) && x > 0 ? x : 1,
    depth: Number.isFinite(z) && z > 0 ? z : 1,
    height: Number.isFinite(y) && y > 0 ? y : 1,
  };
}

/**
 * Lay every instance out on the bench.
 *
 * Deterministic: the same instances + models always produce the same places,
 * in the order the caller supplied them.
 */
export function layoutInstances(
  instances: BenchInstance[],
  models: Map<string, LoadedModel>,
): { places: Map<string, InstancePlace>; order: string[] } {
  const places = new Map<string, InstancePlace>();
  const order: string[] = [];

  const resolved: Resolved[] = [];
  for (const inst of instances) {
    const model = models.get(inst.key);
    if (!model) continue; // no GLB and no CAD-catalog entry -> omit
    resolved.push({ inst, model });
    order.push(inst.id);
  }

  const rotYOf = (model: LoadedModel): number => model.def.bench?.rotation?.[1] ?? 0;
  const scaleOf = (model: LoadedModel): number => model.def.bench?.scale ?? 1;
  const benchOffset = (model: LoadedModel): [number, number, number] =>
    (model.def.bench?.position as [number, number, number] | undefined) ?? [0, 0, 0];

  const pinnedIds = new Set<string>();

  /* 1. Explicit positions win, and never consume an auto slot. ------------ */
  for (const { inst, model } of resolved) {
    const x = numberProp(inst.properties, 'x3d');
    const z = numberProp(inst.properties, 'z3d');
    if (x === null || z === null) continue;
    const { height } = footprint(model);
    const offset = benchOffset(model);
    const y = numberProp(inst.properties, 'y3d') ?? height / 2 + offset[1];
    places.set(inst.id, {
      id: inst.id,
      key: inst.key,
      pos: new Vector3(x, y, z),
      rotY: rotYOf(model),
      scale: scaleOf(model),
      pinned: true,
    });
    pinnedIds.add(inst.id);
  }

  const auto = resolved.filter((entry) => !pinnedIds.has(entry.inst.id));
  const boardEntries = auto.filter((entry) => entry.inst.kind === 'board');
  const partEntries = auto.filter((entry) => entry.inst.kind !== 'board');

  /* 2. Boards hold the back row (z = 0), left to right. ------------------- */
  let boardCursorX = 0;
  let boardDepth = 0;
  for (const { inst, model } of boardEntries) {
    const { width, depth, height } = footprint(model);
    const offset = benchOffset(model);
    boardDepth = Math.max(boardDepth, depth);
    places.set(inst.id, {
      id: inst.id,
      key: inst.key,
      pos: new Vector3(boardCursorX + width / 2 + offset[0], height / 2 + offset[1], offset[2]),
      rotY: rotYOf(model),
      scale: scaleOf(model),
      pinned: false,
    });
    boardCursorX += width + BENCH_GAP_MM;
  }

  /* 3. Parts pack into rows in front of the boards (+z). ------------------ */
  const partFrontZ = boardDepth > 0 ? boardDepth / 2 + BENCH_GAP_MM : 0;
  type RowItem = { inst: BenchInstance; model: LoadedModel; centreX: number };
  const rows: { items: RowItem[]; depth: number }[] = [];
  let row: { items: RowItem[]; depth: number } | null = null;
  let cursorX = 0;

  for (const { inst, model } of partEntries) {
    const { width, depth } = footprint(model);
    // Wrap to a new row — but never onto an empty row, so an oversized part
    // still gets placed (alone) instead of looping.
    if (row && cursorX + width > BENCH_ROW_SPAN_MM) {
      rows.push(row);
      row = null;
      cursorX = 0;
    }
    if (!row) row = { items: [], depth: 0 };
    row.items.push({ inst, model, centreX: cursorX + width / 2 });
    row.depth = Math.max(row.depth, depth);
    cursorX += width + BENCH_GAP_MM;
  }
  if (row) rows.push(row);

  let rowZ = partFrontZ;
  for (const current of rows) {
    for (const { inst, model, centreX } of current.items) {
      const { height } = footprint(model);
      const offset = benchOffset(model);
      places.set(inst.id, {
        id: inst.id,
        key: inst.key,
        pos: new Vector3(
          centreX + offset[0],
          height / 2 + offset[1],
          rowZ + current.depth / 2 + offset[2],
        ),
        rotY: rotYOf(model),
        scale: scaleOf(model),
        pinned: false,
      });
    }
    rowZ += current.depth + BENCH_GAP_MM;
  }

  return { places, order };
}
