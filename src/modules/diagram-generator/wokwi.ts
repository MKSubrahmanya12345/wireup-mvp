/**
 * Wokwi adapter.
 *
 * Projects the simulator-agnostic `wireup-diagram` into the Wokwi `diagram.json`
 * shape. Swapping or adding another simulator target only means adding a file
 * like this one — the planners and the diagram generator stay untouched.
 */

import type { Diagram } from '@/types/diagram';

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

const COLOR_NAMES: { name: string; hexes: string[] }[] = [
  { name: 'red', hexes: ['#c62828', '#d32f2f', '#f44336', 'red'] },
  { name: 'black', hexes: ['#212121', '#000000', 'black'] },
  { name: 'blue', hexes: ['#1565c0', '#0277bd', '#2196f3', 'blue'] },
  { name: 'green', hexes: ['#2e7d32', '#558b2f', '#4caf50', 'green'] },
  { name: 'orange', hexes: ['#ef6c00', '#ff9800', 'orange'] },
  { name: 'purple', hexes: ['#6a1b9a', '#9c27b0', 'purple'] },
  { name: 'cyan', hexes: ['#00838f', '#00bcd4', 'cyan'] },
  { name: 'brown', hexes: ['#4e342e', '#795548', 'brown'] },
];

const PALETTE = ['red', 'black', 'blue', 'green', 'orange', 'purple', 'cyan', 'brown', 'white', 'grey'];

function colourFor(value: string | undefined, index: number): string {
  if (value) {
    const normalised = value.toLowerCase().trim();
    const match = COLOR_NAMES.find((entry) => entry.hexes.includes(normalised));
    if (match) return match.name;
  }
  return PALETTE[index % PALETTE.length] as string;
}

export function toWokwiDiagram(diagram: Diagram): WokwiProjection {
  const parts: WokwiPart[] = [];
  const skippedParts: WokwiProjection['skippedParts'] = [];
  const skippedConnections: WokwiProjection['skippedConnections'] = [];
  const warnings: string[] = [];

  const included = new Set<string>();

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

    parts.push({
      type: simulatorPart,
      id: component.id,
      top: component.y,
      left: component.x,
      attrs: component.simulator?.attrs ?? {},
    });
    included.add(component.id);
  }

  const connections: WokwiConnection[] = [];
  diagram.connections.forEach((connection, index) => {
    if (!included.has(connection.from.component) || !included.has(connection.to.component)) {
      skippedConnections.push({
        id: connection.id,
        reason: `Endpoint part is not representable in the target simulator (${connection.from.component} → ${connection.to.component}).`,
      });
      return;
    }
    connections.push([
      `${connection.from.component}:${connection.from.pin}`,
      `${connection.to.component}:${connection.to.pin}`,
      colourFor(connection.wireColor, index),
      ['v0'],
    ]);
  });

  if (skippedParts.length > 0) {
    warnings.push(
      `${skippedParts.length} part(s) have no verified simulator mapping and were omitted: ${skippedParts.map((part) => part.id).join(', ')}.`,
    );
  }
  if (skippedConnections.length > 0) {
    warnings.push(`${skippedConnections.length} connection(s) were dropped because an endpoint part is not representable.`);
  }
  if (parts.length > 0) {
    warnings.push(
      'Pin names are passed through from the Wireup catalog. Confirm they match the target simulator part pin naming before running a simulation.',
    );
  }

  return {
    diagram: {
      version: 1,
      author: 'Wireup',
      editor: 'wireup',
      parts,
      connections,
    },
    skippedParts,
    skippedConnections,
    warnings,
  };
}
