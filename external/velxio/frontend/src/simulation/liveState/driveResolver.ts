/**
 * driveResolver — "is this part being driven right now?", answered from the
 * wire graph and the emulator's own pin state.
 *
 * The emulator cannot SOLVE a part it has no model for (a pump's flow, a
 * solenoid's force). It can see everything that decides whether such a part is
 * energised, and that is what this module reads:
 *
 *   • the net the part's terminal sits on reaches a board GPIO whose state (or
 *     PWM duty) the emulator is driving — resolved by `PinTrace.traceBoardGpio`,
 *     the same net tracer the 2D canvas and the SPICE layer use;
 *   • or it reaches a SOURCE (a battery holder, an MB102 module) whose rail is
 *     therefore live;
 *   • or it reaches another part's OUTPUT pin (`OUT1`, `NO`, `A1`, `PHASE_A` …)
 *     and THAT part is itself being driven — followed recursively, which is how
 *     `Arduino → L298N IN1 → motor A` energises the motor behind the bridge.
 *
 * Every answer is a READ of existing emulator state and existing wiring: no new
 * simulation, no invented voltages, no per-part rules. A net that reaches
 * nothing resolves to `none` and the 3D view leaves that part still.
 *
 * PIN KNOWLEDGE. Roles are per part TYPE (a part's pin list does not change),
 * taken from the mounted element's own `pinInfo` — which for a CAD-bench part is
 * the catalog spec — with `/cad-catalog.json` as the offline fallback. Nothing
 * is hardcoded per part id.
 */

import type { useSimulatorStore } from '../../store/useSimulatorStore';
import { traceBoardGpio } from '../PinTrace';
import { classifyPart, isSourceId, isSupplyPin, roleOfPin, type PartRoles } from './pinRoles';

/** The simulator store's shape, derived — never imported as a value. */
export type SimState = ReturnType<typeof useSimulatorStore.getState>;

export interface Energy {
  /** Is there a live drive on this net? */
  on: boolean;
  /** Duty / intensity 0..1 (a PWM channel, or a driven GPIO). */
  duty: number;
  /** Where the answer came from. */
  via: 'gpio' | 'pwm' | 'output' | 'rail' | 'none';
  /** The part the energy passed through, when it came via an output. */
  through?: string;
  /** Direction an upstream driver is commanding (-1 reverse, 1 forward). */
  direction?: number;
  /** The pin the drive arrived at (the part's own terminal). */
  pin?: string;
}

const OFF: Energy = { on: false, duty: 0, via: 'none' };

/* ───────────────────────────── pin knowledge ───────────────────────────── */

const pinsByType = new Map<string, string[]>();
const rolesByType = new Map<string, PartRoles>();

/** The pin contract a mounted element publishes (the canvas wire contract). */
function elementPins(componentId: string): string[] {
  if (typeof document === 'undefined') return [];
  const element = document.getElementById(componentId) as unknown as { pinInfo?: { name: string }[] } | null;
  return (element?.pinInfo ?? []).map((pin) => pin.name).filter(Boolean);
}

/**
 * Learn a part type's pins from one of its mounted instances.
 *
 * `refresh` re-reads the element on a slow cadence, so an element that mounted
 * after the canvas came up is still picked up.
 */
export function rememberPins(componentId: string, metadataId: string, refresh = false): string[] {
  const known = pinsByType.get(metadataId);
  if (known && known.length > 0 && !refresh) return known;
  const fromElement = elementPins(componentId);
  if (fromElement.length > 0 && (!known || known.join(',') !== fromElement.join(','))) {
    pinsByType.set(metadataId, fromElement);
    rolesByType.delete(metadataId);
  }
  return pinsByType.get(metadataId) ?? [];
}

/** Seed a part type's pins directly (catalog priming, tests). */
export function rememberPinsFor(metadataId: string, pins: string[]): void {
  if (pins.length === 0) return;
  pinsByType.set(metadataId, pins);
  rolesByType.delete(metadataId);
}

/** Classified roles for a part type, or null while its pins are unknown. */
export function rolesFor(metadataId: string): PartRoles | null {
  const cached = rolesByType.get(metadataId);
  if (cached) return cached;
  const pins = pinsByType.get(metadataId);
  if (!pins || pins.length === 0) return null;
  const roles = classifyPart(pins);
  rolesByType.set(metadataId, roles);
  return roles;
}

/** Pins known for a part type (diagnostics). */
export function knownPinTypes(): string[] {
  return [...pinsByType.keys()];
}

/** Test seam: forget every learned pin list. */
export function forgetPins(): void {
  pinsByType.clear();
  rolesByType.clear();
}

/**
 * Learn every catalog part's pins from `/cad-catalog.json`.
 *
 * The mounted elements are the primary source (they publish the pins the wire
 * system uses); this covers the frames before they mount, a bench rebuilt
 * without a DOM, and tests. Failure is silent by design — it only removes a
 * fallback, it never breaks a working canvas.
 */
let catalogPins: Promise<number> | null = null;
export function primeCadPins(): Promise<number> {
  if (catalogPins) return catalogPins;
  catalogPins = (async () => {
    try {
      const response = await fetch('/cad-catalog.json', { cache: 'no-store' });
      if (!response.ok) {
        // A failure is not latched: the caller may retry (a canvas that mounted
        // during a deploy used to stay blind for the rest of the session).
        catalogPins = null;
        return 0;
      }
      const catalog = (await response.json()) as { entries?: Record<string, { spec?: { pins?: { name: string }[] } }> };
      let learned = 0;
      for (const [key, entry] of Object.entries(catalog.entries ?? {})) {
        const pins = (entry.spec?.pins ?? []).map((pin) => pin.name).filter(Boolean);
        if (pins.length === 0) continue;
        const metadataId = `cad-bench-${key}`;
        // Never overwrite what a mounted element already told us.
        if (pinsByType.has(metadataId)) continue;
        rememberPinsFor(metadataId, pins);
        learned += 1;
      }
      return learned;
    } catch {
      catalogPins = null;
      return 0;
    }
  })();
  return catalogPins;
}

/* ─────────────────────────────── net reading ───────────────────────────── */

/** Normalise a PWM reading to 0..1 — the engine reports 0..255 on AVR. */
function normaliseDuty(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? Math.min(1, value / 255) : Math.min(1, value);
}

interface Endpoint {
  componentId: string;
  pinName: string;
}

/** Every endpoint wired directly to (componentId, pinName). */
function partnersAt(state: SimState, componentId: string, pinName: string): Endpoint[] {
  const out: Endpoint[] = [];
  for (const wire of state.wires) {
    const start: Endpoint = { componentId: wire.start.componentId, pinName: wire.start.pinName };
    const end: Endpoint = { componentId: wire.end.componentId, pinName: wire.end.pinName };
    if (start.componentId === componentId && start.pinName === pinName) out.push(end);
    else if (end.componentId === componentId && end.pinName === pinName) out.push(start);
  }
  return out;
}

/** Read the level the emulator holds on a board pin (null = not a board pin). */
function boardLevel(state: SimState, componentId: string, pinName: string): { high: boolean; duty: number } | null {
  const gpio = traceBoardGpio(state, componentId, pinName);
  if (gpio === null) return null;
  return {
    high: state.pinManager.getPinState(gpio),
    duty: normaliseDuty(state.pinManager.getPwmValue(gpio)),
  };
}

/**
 * Direction a driver is commanding, from its own command pins: `DIR` high means
 * reverse, `IN1`/`IN2` (or `AIN1`/`AIN2`, `BIN1`/`BIN2`) at opposite levels mean
 * "one way or the other". `undefined` when the part says nothing.
 */
function directionOf(state: SimState, componentId: string, roles: PartRoles): number | undefined {
  const level = (pin: string): boolean | null => {
    if (!roles.all.includes(pin)) return null;
    return boardLevel(state, componentId, pin)?.high ?? null;
  };
  const dir = level('DIR');
  if (dir !== null) return dir ? -1 : 1;
  const forward = level('IN1') ?? level('AIN1') ?? level('BIN1') ?? level('RPWM');
  const reverse = level('IN2') ?? level('AIN2') ?? level('BIN2') ?? level('LPWM');
  if (forward === null || reverse === null) return undefined;
  if (forward === reverse) return undefined; // brake or coast
  return reverse ? -1 : 1;
}

/**
 * Read the energy arriving at one terminal of one part.
 *
 * `depth`/`seen` bound the recursion through series parts (a relay feeding a
 * pump must not loop back through the wire graph).
 */
export function readPinEnergy(
  state: SimState,
  componentId: string,
  pinName: string,
  depth = 0,
  seen = new Set<string>(),
): Energy {
  const key = `${componentId}:${pinName}`;
  if (depth > 3 || seen.has(key)) return OFF;
  seen.add(key);

  // 1. The net reaches a board pin the emulator is driving. A pin that IS a
  //    board pin but is not being driven is not an answer on its own: a rail is
  //    resolved by the wire walk below (its net reaches the board's 5 V/3V3 pin),
  //    and an idle GPIO falls through so a second driver on the same net is
  //    still found.
  const board = boardLevel(state, componentId, pinName);
  if (board) {
    if (board.duty > 0) return { on: true, duty: board.duty, via: 'pwm', pin: pinName };
    if (board.high) return { on: true, duty: 1, via: 'gpio', pin: pinName };
  }

  // 2. Otherwise follow the net to whatever else is on it.
  let best: Energy = OFF;
  for (const partner of partnersAt(state, componentId, pinName)) {
    if (partner.componentId === componentId) continue;

    // A board's supply rail is live whenever the board is running.
    const boardEntry = state.boards.find((entry) => entry.id === partner.componentId);
    if (boardEntry) {
      if (boardEntry.running !== false && isSupplyPin(partner.pinName)) {
        return { on: true, duty: 1, via: 'rail', through: boardEntry.id, pin: pinName };
      }
      continue;
    }

    const partnerComponent = state.components.find((entry) => entry.id === partner.componentId);
    if (!partnerComponent) continue;
    const partnerRoles = rolesFor(partnerComponent.metadataId);
    if (!partnerRoles) continue;

    // A source on the net means the rail is live.
    if (isSourceId(partnerComponent.metadataId) && roleOfPin(partner.pinName, partnerRoles.controller) === 'power') {
      return { on: true, duty: 1, via: 'rail', through: partnerComponent.id, pin: pinName };
    }

    // A partner pin carries energy only where the partner drives it out (or
    // where the partner is itself a load sharing the same net), and only if the
    // partner is being driven.
    const role = roleOfPin(partner.pinName, partnerRoles.controller);
    const carries = role === 'output' || partnerRoles.drivePins.includes(partner.pinName);
    if (!carries) continue;

    const upstream = readPartDrive(state, partnerComponent.id, partnerRoles, depth + 1, seen);
    if (!upstream.on) continue;
    const routed: Energy = {
      on: true,
      duty: upstream.duty,
      via: 'output',
      through: partnerComponent.id,
      pin: pinName,
      ...(directionOf(state, partnerComponent.id, partnerRoles) !== undefined
        ? { direction: directionOf(state, partnerComponent.id, partnerRoles) }
        : {}),
    };
    if (routed.duty >= best.duty) best = routed;
  }
  return best;
}

/**
 * The strongest drive arriving at a part.
 *
 * A load is driven through its energy terminals. A CONTROLLER (a driver, a
 * module with command inputs) is also driven when a command arrives — a relay
 * module with `VCC` on 5 V and `IN` high is working, even though `IN` is a
 * control pin, and an I2C sensor that is merely powered is "active" too.
 */
export function readPartDrive(
  state: SimState,
  componentId: string,
  roles: PartRoles,
  depth = 0,
  seen = new Set<string>(),
): Energy {
  let best: Energy = OFF;
  const consider = (energy: Energy): void => {
    if (energy.on && energy.duty >= best.duty) best = { ...energy, ...(best.direction ? { direction: best.direction } : {}) };
  };
  for (const pin of roles.drivePins) consider(readPinEnergy(state, componentId, pin, depth, seen));
  for (const pin of roles.controlPins) consider(readPinEnergy(state, componentId, pin, depth, seen));
  return best;
}

/** Is any of these pins of this part HIGH right now? */
export function anyPinHigh(state: SimState, componentId: string, pins: string[]): boolean {
  return pins.some((pin) => readPinEnergy(state, componentId, pin, 0, new Set()).on);
}

/** A short signature of a set of pins' net state, for change detection. */
export function netSignature(state: SimState, componentId: string, pins: string[]): string {
  return pins
    .map((pin) => {
      const level = boardLevel(state, componentId, pin);
      const energy = level ? null : readPinEnergy(state, componentId, pin, 0, new Set());
      if (level) return `${pin}:${level.high ? 1 : 0}:${level.duty}`;
      return `${pin}:${energy?.on ? 1 : 0}:${energy?.duty ?? 0}`;
    })
    .join('|');
}
