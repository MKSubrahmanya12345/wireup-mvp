/**
 * Canvas → `diagram.json` reverse sync.
 *
 * When the user rewires the circuit on the embedded Velxio canvas and pulls it
 * back, that edit must land in THIS project's artifacts — otherwise the
 * download, the wiring guide and the canvas silently disagree, which is the
 * single most dangerous failure mode of an embedded editor.
 *
 * This module folds a pulled `VlxPayload` back into the Wireup diagram:
 *
 *   • components the canvas manages   → rebuilt from the canvas
 *   • wires between a managed part and the board → rebuilt from the canvas
 *   • everything else (the board, part↔part links, unmodelled passives)
 *     → preserved untouched
 *
 * The mapping is the exact inverse of `velxio-project.ts`. Parts the canvas
 * does not manage are never invented and never discarded: the sync only claims
 * authority over what it can actually see on the canvas, and reports the rest.
 */

import type { Diagram, DiagramComponent, DiagramConnection, DiagramPin } from '@/types/diagram';
import type { ConnectionKind, SignalType } from '@/types/wiring';

import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';

import { WOKWI_TYPE_BY_METADATA, cadBenchCatalogId, isCadBenchComponent } from './velxio-project';

import { getSeedComponent } from '@/modules/components/catalog';

/** The subset of Velxio's VlxPayload this sync needs. */
export interface VlxCanvasPayload {
  format?: string;
  version?: number;
  name?: string;
  boards: { id: string; boardKind?: string; activeFileGroupId?: string }[];
  fileGroups?: Record<string, { name: string; content: string }[]>;
  components: { id: string; metadataId: string; x?: number; y?: number; properties?: Record<string, unknown> }[];
  wires: {
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }[];
  activeBoardId?: string | null;
}

export interface CanvasSyncResult {
  /** The diagram after the canvas has been folded in. */
  diagram: Diagram;
  /** Human summary for the UI. */
  summary: string;
  /** Canvas components with no Wireup mapping — reported, never faked. */
  unmapped: string[];
  /** What actually changed, so the UI can say more than "synced". */
  changes: {
    partsFromCanvas: number;
    partsPreserved: number;
    wiresFromCanvas: number;
    wiresPreserved: number;
    wiresDropped: number;
  };
}

export class CanvasSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasSyncError';
  }
}

/** Validate a payload arriving over postMessage before trusting its shape. */
export function assertCanvasPayload(value: unknown): asserts value is VlxCanvasPayload {
  if (!value || typeof value !== 'object') {
    throw new CanvasSyncError('The canvas returned something that is not a Velxio project.');
  }
  const candidate = value as Partial<VlxCanvasPayload>;
  if (!Array.isArray(candidate.boards)) throw new CanvasSyncError('The canvas payload has no "boards" array.');
  if (!Array.isArray(candidate.components)) {
    throw new CanvasSyncError('The canvas payload has no "components" array.');
  }
  if (!Array.isArray(candidate.wires)) throw new CanvasSyncError('The canvas payload has no "wires" array.');
}

/**
 * Inverse of `velxioBoardPin`: a Velxio board element pin name → the pin name
 * the Wireup diagram uses for the controller.
 *
 * ── Why the candidate list matters more than it looks ───────────────────────
 * A diagram component only lists the pins the CURRENT wiring touches. So
 * resolving purely against `controller.pins` makes the sync silently drop the
 * single most common canvas edit there is: dragging a wire to a pin that was
 * previously free. The MCU profile — the same table the pin planner allocates
 * from — knows every pin the board physically has, so it is consulted first
 * and the diagram's list is only the fallback for a controller with no profile.
 *
 * Naming differs per board (`D4`, `GPIO4` and `4` can all be one pin), which
 * is why this matches by shape rather than by string equality.
 */
export function wireupBoardPin(
  velxioPin: string,
  controllerPins: DiagramPin[],
  controllerComponentId?: string,
): string | null {
  const value = velxioPin.trim();
  if (!value) return null;

  const profile = controllerComponentId ? getMcuProfile(controllerComponentId) : undefined;
  // Profile pins first (every pin the board has), diagram pins second (the
  // wired ones, plus power/ground rails a profile does not enumerate).
  const names = [
    ...(profile?.pins.map((pin) => pin.name) ?? []),
    ...controllerPins.map((pin) => pin.name),
  ];
  const find = (predicate: (name: string) => boolean): string | null => names.find(predicate) ?? null;

  const upper = value.toUpperCase();
  const exact = find((name) => name.toUpperCase() === upper);
  if (exact) return exact;

  if (/^GND(\.\d+)?$/.test(upper)) return find((name) => /^GND/i.test(name)) ?? 'GND';
  if (upper === '3V3') return find((name) => /^(3V3|3\.3V)$/i.test(name)) ?? '3V3';
  if (upper === 'VIN' || upper === '5V') return find((name) => /^(5V|VIN|VCC)$/i.test(name)) ?? upper;
  if (/^A\d+$/.test(upper)) return find((name) => name.toUpperCase() === upper);

  const digits = /^(?:GPIO|D)?(\d{1,3})$/.exec(upper);
  if (digits) {
    const number = digits[1] as string;
    const matched = find((name) => new RegExp(`^(?:GPIO|D)?${number}$`, 'i').test(name));
    if (matched) return matched;
    // No profile and no existing wire on this pin: fall back to the naming
    // convention the rest of this diagram's controller already uses, so the
    // pin lands as `GPIO23` on an ESP32 and `D23` on an AVR rather than as a
    // bare number nothing else would match.
    const sample = controllerPins.find((pin) => /^(GPIO|D)\d+$/i.test(pin.name))?.name;
    if (sample) return `${/^GPIO/i.test(sample) ? 'GPIO' : 'D'}${number}`;
    return null;
  }
  return null;
}

/** Classify a rebuilt wire the same way the wiring planner would. */
function classifyConnection(boardPin: string, partPin: string): { kind: ConnectionKind; signal: SignalType } {
  if (/^GND/i.test(boardPin) || /^GND/i.test(partPin)) return { kind: 'ground', signal: 'ground' };
  if (/^(3V3|3\.3V|5V|VIN|VCC)$/i.test(boardPin) || /^(VCC|VIN|VDD)$/i.test(partPin)) {
    return { kind: 'power', signal: 'power' };
  }
  if (/^SCL$/i.test(partPin) || /^SDA$/i.test(partPin)) return { kind: 'signal', signal: 'i2c' };
  if (/^A\d+$/i.test(boardPin)) return { kind: 'signal', signal: 'analog' };
  return { kind: 'signal', signal: 'digital' };
}

/** Which diagram component is the controller the canvas wired everything to? */
function findController(diagram: Diagram): DiagramComponent | null {
  const byMeta = diagram.meta.controllerInstanceId
    ? diagram.components.find((component) => component.id === diagram.meta.controllerInstanceId)
    : undefined;
  if (byMeta) return byMeta;
  return diagram.components.find((component) => component.category === 'microcontroller') ?? null;
}

/**
 * Fold a pulled canvas payload into a Wireup diagram.
 *
 * Throws `CanvasSyncError` when the sync cannot be performed truthfully —
 * never returns a half-applied diagram.
 */
export function applyCanvasToDiagram(payload: VlxCanvasPayload, diagram: Diagram): CanvasSyncResult {
  assertCanvasPayload(payload);

  const controller = findController(diagram);
  if (!controller) {
    throw new CanvasSyncError(
      'This diagram has no controller, so there is nothing to attach the canvas wires to. Re-run the build first.',
    );
  }

  const managedTypes = new Set(Object.values(WOKWI_TYPE_BY_METADATA));
  /*
   * Canvas-managed = the exporter placed it there, so the canvas is the
   * authority for its position, properties and wires. That includes CAD bench
   * parts: they are placed by the same exporter and re-emitted on every sync,
   * so NOT counting them here would preserve the old board wires AND add the
   * canvas's copies — every sync would double the wiring to a pump, solenoid
   * or HC-05. The predicate is shared with the exporter on purpose.
   */
  const isManaged = (component: DiagramComponent): boolean =>
    component.id !== controller.id &&
    (isCadBenchComponent(component) ||
      Boolean(component.simulator?.part && managedTypes.has(component.simulator.part)));

  const previouslyManaged = new Set(diagram.components.filter(isManaged).map((component) => component.id));
  const previousById = new Map(diagram.components.map((component) => [component.id, component]));

  /* 1. Components ---------------------------------------------------------- */
  const unmapped: string[] = [];
  const canvasComponents: DiagramComponent[] = [];
  const canvasBoardIds = new Set(payload.boards.map((board) => board.id));
  const canvasComponentIds = new Set(payload.components.map((c) => c.id));

  // Determine which previously-managed components exist on the canvas.
  // Only replace those — keep the rest of the original diagram intact.
  const previouslyManagedOnCanvas = new Set(
    diagram.components
      .filter((component) => isManaged(component) && canvasComponentIds.has(component.id))
      .map((component) => component.id)
  );

  for (const component of payload.components) {
    if (canvasBoardIds.has(component.id)) continue;

    /*
     * CAD bench part — a real catalog part with no emulator element. Fold the
     * canvas's position/properties back, and if the user placed a NEW one from
     * the picker, enter it into the diagram as the catalog part it is: the
     * registry is bundled offline, so its pins and category are known rather
     * than guessed from whichever wires happen to touch it.
     */
    const benchCatalogId = cadBenchCatalogId(component.metadataId);
    if (benchCatalogId) {
      const definition = getSeedComponent(benchCatalogId);
      const previous = previousById.get(component.id);
      const wired = new Set(pinsFromCanvasWires(component.id, payload).map((pin) => pin.name));
      canvasComponents.push({
        id: component.id,
        ref: benchCatalogId,
        type: previous?.type ?? `catalog.${benchCatalogId}`,
        name: previous?.name ?? definition?.name ?? benchCatalogId,
        ...(previous?.label ? { label: previous.label } : {}),
        category: previous?.category ?? definition?.category ?? 'other',
        width: previous?.width ?? 140,
        height: previous?.height ?? 90,
        x: typeof component.x === 'number' ? component.x : previous?.x ?? 0,
        y: typeof component.y === 'number' ? component.y : previous?.y ?? 0,
        // Keep the diagram's own pin semantics when it had them; a brand-new
        // canvas part takes the catalog's pins, with connectivity from the
        // wires actually drawn to it.
        pins:
          previous?.pins ??
          (definition?.pins ?? []).map((pin) => ({
            name: pin.name,
            type: pin.type,
            direction: pin.direction,
            required: pin.required,
            ...(pin.signal ? { signal: pin.signal } : {}),
            connected: wired.has(pin.name),
          })),
        simulator: {
          ...(previous?.simulator ?? {}),
          ...(definition?.simulator?.part ? { part: definition.simulator.part } : {}),
          supported: false,
          notes:
            'CAD bench part — placed with its real shape and pin anchors; this build has no electrical model for it, so it does not simulate.',
          attrs: stringifyProperties(component.properties),
        },
        metadata: {
          ...(previous?.metadata ?? {}),
          origin: previous?.metadata?.origin ?? 'velxio-canvas',
          catalogBacked: Boolean(definition),
          cadBench: true,
        },
      });
      continue;
    }

    const wokwiType = WOKWI_TYPE_BY_METADATA[component.metadataId];
    if (!wokwiType) {
      unmapped.push(`${component.id} (${component.metadataId})`);
      continue;
    }
    const previous = previousById.get(component.id);
    if (previous) {
      // A part Wireup already knows: keep its catalog identity and pins, take
      // the canvas's position and properties. Re-deriving pins from a
      // metadataId would throw away the catalog's pin semantics.
      canvasComponents.push({
        ...previous,
        x: typeof component.x === 'number' ? component.x : previous?.x ?? 0,
        y: typeof component.y === 'number' ? component.y : previous?.y ?? 0,
        simulator: {
          ...(previous.simulator ?? {}),
          part: wokwiType,
          attrs: {
            ...(previous.simulator?.attrs ?? {}),
            ...stringifyProperties(component.properties),
          },
        },
      });
      continue;
    }
    // A part the user added on the canvas. Wireup has no catalog entry for
    // this instance, so it enters the diagram as a canvas-owned part: real
    // enough to draw and wire, explicitly marked as not catalog-backed so no
    // downstream stage mistakes it for a validated selection.
    canvasComponents.push({
      id: component.id,
      ref: component.metadataId,
      type: `canvas.${component.metadataId}`,
      name: component.metadataId,
      label: component.metadataId,
      category: 'other',
      x: typeof component.x === 'number' ? component.x : 0,
      y: typeof component.y === 'number' ? component.y : 0,
      width: 120,
      height: 80,
      pins: pinsFromCanvasWires(component.id, payload),
      simulator: { part: wokwiType, attrs: stringifyProperties(component.properties), supported: true },
      metadata: { origin: 'velxio-canvas', catalogBacked: false },
    });
  }

  // Preserve components that were NOT replaced by the canvas (either because
  // they were never managed, or because they don't exist on the canvas).
  const preserved = diagram.components.filter((component) => !previouslyManagedOnCanvas.has(component.id));
  const nextComponents = [...preserved, ...canvasComponents];
  const nextIds = new Set(nextComponents.map((component) => component.id));

  /* 2. Connections --------------------------------------------------------- */
  const canvasConnections: DiagramConnection[] = [];
  let dropped = 0;

  payload.wires.forEach((wire, index) => {
    const startIsBoard = canvasBoardIds.has(wire.start.componentId);
    const endIsBoard = canvasBoardIds.has(wire.end.componentId);
    if (startIsBoard === endIsBoard) {
      // part↔part or board↔board — the canvas cannot name a board net for it.
      dropped += 1;
      return;
    }
    const partEnd = startIsBoard ? wire.end : wire.start;
    const boardEnd = startIsBoard ? wire.start : wire.end;
    if (!nextIds.has(partEnd.componentId)) {
      dropped += 1;
      return;
    }
    const boardPin = wireupBoardPin(boardEnd.pinName, controller.pins, controller.ref);
    if (!boardPin) {
      dropped += 1;
      unmapped.push(`wire ${wire.id} → board pin "${boardEnd.pinName}" has no equivalent on ${controller.name}`);
      return;
    }
    const { kind, signal } = classifyConnection(boardPin, partEnd.pinName);
    canvasConnections.push({
      id: `canvas-${wire.id || index + 1}`,
      from: { component: partEnd.componentId, pin: partEnd.pinName },
      to: { component: controller.id, pin: boardPin },
      kind,
      signal,
      label: `${partEnd.componentId}.${partEnd.pinName} → ${controller.id}.${boardPin}`,
    });
  });

  // An existing connection survives when it is NOT a managed-part↔board wire
  // (those are exactly what the canvas owns and regenerates) and both of its
  // endpoints still exist. Part↔part links cannot be expressed as canvas
  // board-wires at all, so they are preserved rather than silently lost.
  const preservedConnections = diagram.connections.filter((connection) => {
    const canvasOwned =
      (previouslyManaged.has(connection.from.component) && connection.to.component === controller.id) ||
      (previouslyManaged.has(connection.to.component) && connection.from.component === controller.id);
    if (canvasOwned) return false;
    return nextIds.has(connection.from.component) && nextIds.has(connection.to.component);
  });

  const nextConnections = [...preservedConnections, ...canvasConnections];

  /* 3. Rebuild the derived fields so nothing is stale --------------------- */
  const nextDiagram: Diagram = {
    ...diagram,
    generator: `${diagram.generator} + velxio-canvas-sync`,
    components: nextComponents,
    connections: nextConnections,
    // Rails and groups reference component ids; prune anything the sync removed
    // rather than leaving dangling members behind.
    rails: diagram.rails.map((rail) => ({
      ...rail,
      members: rail.members.filter((member) => nextIds.has(member.component)),
    })),
    groups: diagram.groups
      .map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => nextIds.has(id)) }))
      .filter((group) => group.memberIds.length > 0),
    stats: {
      components: nextComponents.length,
      connections: nextConnections.length,
      powerConnections: nextConnections.filter((connection) => connection.kind === 'power').length,
      groundConnections: nextConnections.filter((connection) => connection.kind === 'ground').length,
      signalConnections: nextConnections.filter((connection) => connection.kind === 'signal').length,
      pins: nextComponents.reduce((total, component) => total + component.pins.length, 0),
    },
  };

  const summary =
    `${canvasComponents.length} part(s) and ${canvasConnections.length} wire(s) came from the canvas; ` +
    `${preserved.length} part(s) and ${preservedConnections.length} wire(s) were preserved` +
    (dropped > 0 ? `; ${dropped} canvas wire(s) had no diagram equivalent` : '') +
    (unmapped.length > 0 ? `. No Wireup mapping for: ${unmapped.join(', ')}` : '.');

  return {
    diagram: nextDiagram,
    summary,
    unmapped,
    changes: {
      partsFromCanvas: canvasComponents.length,
      partsPreserved: preserved.length,
      wiresFromCanvas: canvasConnections.length,
      wiresPreserved: preservedConnections.length,
      wiresDropped: dropped,
    },
  };
}

/** Velxio properties are `unknown`; diagram attrs are strings. */
function stringifyProperties(properties: Record<string, unknown> | undefined): Record<string, string> {
  if (!properties) return {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
      .map(([key, value]) => [key, String(value)]),
  );
}

/**
 * A canvas-added part has no catalog pin list. The only pins Wireup can honestly
 * claim it has are the ones the user actually wired, so those are what it gets.
 */
function pinsFromCanvasWires(componentId: string, payload: VlxCanvasPayload): DiagramPin[] {
  const names = new Set<string>();
  for (const wire of payload.wires) {
    if (wire.start.componentId === componentId) names.add(wire.start.pinName);
    if (wire.end.componentId === componentId) names.add(wire.end.pinName);
  }
  return [...names].map((name) => ({ name, connected: true }));
}
