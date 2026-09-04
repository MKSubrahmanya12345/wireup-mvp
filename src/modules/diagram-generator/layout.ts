/**
 * Deterministic diagram layout.
 *
 * Parts are placed in functional columns (power/sensing on the left, the
 * controller in the middle, drive and actuation on the right, passives and the
 * prototyping medium at the far right), stacked with a gap, and each part gets
 * pin anchors on its left/right edges so a renderer — or a simulator adapter —
 * can route wires without guessing.
 */

import type { ComponentDefinition } from '@/types/component';
import type { DiagramComponent, DiagramPin } from '@/types/diagram';

export const GRID_SIZE = 20;
const COLUMN_X = [40, 320, 620, 900, 1160];
const COLUMN_GAP = 24;
const TOP_MARGIN = 40;

const COLUMN_BY_CATEGORY: Record<string, number> = {
  power: 0,
  sensor: 0,
  input_device: 0,
  microcontroller: 1,
  communication: 1,
  motor_driver: 2,
  display: 2,
  motor: 3,
  actuator: 3,
  passive: 4,
  electromechanical: 4,
  prototyping: 4,
  other: 4,
};

const WIDTH_BY_CATEGORY: Record<string, number> = {
  microcontroller: 220,
  motor_driver: 190,
  sensor: 150,
  communication: 160,
  display: 170,
  motor: 130,
  actuator: 120,
  power: 150,
  passive: 90,
  input_device: 110,
  prototyping: 200,
  other: 130,
};

export interface LayoutInput {
  instanceId: string;
  definition?: ComponentDefinition;
  label?: string;
}

interface ColumnState {
  y: number;
}

function snap(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function pinSide(name: string, direction: string, type: string): 'left' | 'right' {
  const upper = name.toUpperCase();
  if (type === 'power' || direction === 'power') return 'left';
  if (type === 'ground' || direction === 'ground') return 'right';
  if (direction === 'output') return 'right';
  if (/^(OUT|AO|BO|Y|DOUT|TX)/.test(upper)) return 'right';
  return 'left';
}

function buildPins(definition: ComponentDefinition, x: number, y: number, width: number, height: number): DiagramPin[] {
  const left: ComponentDefinition['pins'] = [];
  const right: ComponentDefinition['pins'] = [];

  for (const entry of definition.pins) {
    if (pinSide(entry.name, entry.direction, entry.type) === 'left') left.push(entry);
    else right.push(entry);
  }

  const pins: DiagramPin[] = [];
  const place = (list: ComponentDefinition['pins'], edgeX: number) => {
    const spacing = list.length > 1 ? (height - 24) / (list.length - 1) : 0;
    list.forEach((entry, entryIndex) => {
      pins.push({
        name: entry.name,
        ...(entry.signal ? { label: entry.signal } : {}),
        type: entry.type,
        direction: entry.direction,
        x: edgeX,
        y: snap(y + 12 + (list.length > 1 ? entryIndex * spacing : (height - 24) / 2)),
        connected: false,
      });
    });
  };

  place(left, x);
  place(right, x + width);
  return pins;
}

export interface LayoutResult {
  components: DiagramComponent[];
  width: number;
  height: number;
  columns: number;
  rows: number;
}

export function layoutComponents(entries: LayoutInput[]): LayoutResult {
  const columns = new Map<number, ColumnState>();
  for (let index = 0; index < COLUMN_X.length; index += 1) columns.set(index, { y: TOP_MARGIN });

  const components: DiagramComponent[] = [];
  let maxRows = 0;

  for (const entry of entries) {
    const category = entry.definition?.category ?? 'other';
    const columnIndex = COLUMN_BY_CATEGORY[category] ?? 4;
    const column = columns.get(columnIndex) ?? { y: TOP_MARGIN };
    const pinCount = entry.definition?.pins.length ?? 2;
    const width = WIDTH_BY_CATEGORY[category] ?? 130;
    const height = Math.max(60, snap(28 + pinCount * 16));

    const x = COLUMN_X[columnIndex] ?? 40;
    const y = column.y;

    components.push({
      id: entry.instanceId,
      ref: entry.definition?.id ?? entry.instanceId,
      type: `${category}.${entry.definition?.id ?? 'unknown'}`,
      name: entry.definition?.name ?? entry.instanceId,
      ...(entry.label ? { label: entry.label } : {}),
      category,
      x,
      y,
      width,
      height,
      pins: entry.definition ? buildPins(entry.definition, x, y, width, height) : [],
      ...(entry.definition?.simulator
        ? {
            simulator: {
              ...(entry.definition.simulator.part ? { part: entry.definition.simulator.part } : {}),
              ...(entry.definition.simulator.attrs ? { attrs: entry.definition.simulator.attrs } : {}),
              supported: entry.definition.simulator.supported ?? false,
              ...(entry.definition.simulator.notes ? { notes: entry.definition.simulator.notes } : {}),
            },
          }
        : {}),
      metadata: {
        ...(entry.definition?.voltage !== undefined ? { voltage: entry.definition.voltage } : {}),
        ...(entry.definition?.currentRequirements?.maxMa !== undefined ? { maxCurrentMa: entry.definition.currentRequirements.maxMa } : {}),
        electrical: entry.definition?.metadata.electrical !== false,
      },
    });

    column.y = y + height + COLUMN_GAP;
    columns.set(columnIndex, column);
    maxRows = Math.max(maxRows, Math.ceil(column.y / (height + COLUMN_GAP)));
  }

  const width = Math.max(...components.map((component) => component.x + component.width), 600) + 40;
  const height = Math.max(...components.map((component) => component.y + component.height), 400) + 40;

  return {
    components,
    width: snap(width),
    height: snap(height),
    columns: COLUMN_X.length,
    rows: maxRows,
  };
}

/** Simulator part type token, e.g. `wokwi-esp32-devkit-v1` when known. */
export function simulatorPartFor(definition: ComponentDefinition | undefined): string | undefined {
  return definition?.simulator?.part;
}
