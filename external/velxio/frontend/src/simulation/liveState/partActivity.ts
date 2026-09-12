/**
 * partActivity — the live state of the parts the emulator does not solve.
 *
 * Velxio's part simulators cover roughly half of Wireup's catalog. The other
 * half — pumps, fans, motors, drivers, relays, solenoids, radio modules, power
 * regulators and every other CAD-bench part — are real devices: when a sketch
 * drives their pins they DO something, and a 3D view that leaves them dead
 * while the sketch runs is showing a lie.
 *
 * This module is the missing producer for those parts. It does not simulate the
 * device; it observes the two things that are knowable from the running
 * emulation and publishes them where the 3D scene and the 2D canvas read them:
 *
 *   drive            0..1   energy arriving, traced through the wire graph to
 *                           the GPIO / PWM channel / upstream driver that is
 *                           producing it (see driveResolver);
 *   activity         0..1   the part is doing its job right now;
 *   triggered        0/1    a command / output contact is closed;
 *   bus              0..1   the part is being addressed (a bus line changed);
 *   direction        ±1     the direction a driver is commanding;
 *   turnsPerSecond          shaft speed = duty × the device's own nominal rpm;
 *                          0 for anything with no shaft (pumps, solenoids …);
 *   stepAngle               accumulated angle for steppers whose position is
 *                           driven by a commanded coil pattern.
 *
 * Timing: one poll per ~90 ms over a handful of parts, each poll a small graph
 * walk. Values go into the transient render store (read imperatively by the 3D
 * view), never into the persisted component properties, and only changed values
 * are published — a still bench costs nothing.
 *
 * Honesty rules, encoded here rather than promised in a comment:
 *   • a part whose terminals reach no live net publishes NOTHING and stays still;
 *   • a source (battery) never reports "running" — it holds a rail;
 *   • a passive part (a propeller, a camera) reports nothing: nothing about it
 *     changes when its carrier moves;
 *   • a stepper advances one half-step per commanded coil-pattern change, which
 *     is exactly what the hardware does;
 *   • speed is duty × the device's own nominal rpm, so nothing spins implausibly.
 */

import { usePartRenderStore } from '../../store/usePartRenderStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { isPassiveId, isSourceId, ratedRpm, type PartRoles } from './pinRoles';
import {
  anyPinHigh,
  netSignature,
  primeCadPins,
  readPartDrive,
  rememberPins,
  rolesFor,
  type Energy,
  type SimState,
} from './driveResolver';
import { reportPins, reportSim } from '../../scene3d/live/intakeReport';

/** CAD-bench parts arrive as `cad-bench-<catalog key>`. */
const CAD_BENCH_PREFIX = 'cad-bench-';
const POLL_MS = 90;
/** Bus-activity level decays this much per poll (≈0.5 s of visible traffic). */
const BUS_DECAY = 0.86;
/** Half-step angle of a 28BYJ-48-class geared stepper (360 / 8 / 64). */
const STEPPER_HALF_STEP_DEG = 0.703125;

/**
 * PartLiveState — the contract published for a part the emulator has no model
 * for. The keys here are the ONLY signal names a live surface may read from
 * this producer; Wireup's `pnpm verify:3d-live` reads this interface as the
 * producer's evidence, so renaming a key fails the gate instead of silently
 * darkening the 3D view.
 */
export interface PartLiveState {
  drive: number;
  activity: number;
  triggered: number;
  bus: number;
  direction: number;
  /** Signed rotation rate, turns per second (drives the 3D spin integrator). */
  turnsPerSecond: number;
  /** Shaft speed as a positive number of revolutions per minute. */
  rpm: number;
  stepAngle: number;
  /** Route that energised the part: gpio | pwm | output | rail ('' = nowhere). */
  via: string;
  /** The part's own terminal the drive arrived at. */
  viaPin: string;
}

interface WatchEntry {
  metadataId: string;
  published: PartLiveState | null;
  bus: number;
  /** Last seen bus/command net signature, for edge detection. */
  signature: string;
  /** Last coil-pattern code, for stepper half-step counting. */
  coilCode: number | null;
  /** Which way the last half-step went. */
  stepAngleDirection: 1 | -1;
  /** Accumulated stepper angle, degrees (wrapped to 0..360). */
  stepAngle: number;
}

/** The four command pins a unipolar stepper's driver is sequenced on. */
const COIL_PINS = ['IN1', 'IN2', 'IN3', 'IN4'];

/**
 * Coil pattern code (0..15) of a stepper's four command nets.
 *
 * The sketch sequences the coils; every CHANGE of that pattern advances the
 * rotor by one step, which is the mechanism the real motor has (there is nothing
 * to interpolate and nothing to guess). The pattern is the level of its own four
 * pins, read through the same wire-graph trace as everything else.
 */
function coilCode(state: SimState, componentId: string, roles: PartRoles): number {
  let code = 0;
  COIL_PINS.forEach((pin, index) => {
    if (!roles.all.includes(pin)) return;
    if (anyPinHigh(state, componentId, [pin])) code |= 1 << index;
  });
  return code;
}

/** Direction the part itself (or the driver it routes through) is commanding. */
function directionFrom(energy: Energy, state: SimState, componentId: string, roles: PartRoles): number {
  if (energy.direction) return energy.direction;
  if (!roles.controller) return 1;
  const forward = anyPinHigh(state, componentId, ['IN1', 'AIN1', 'BIN1', 'RPWM']);
  const reverse = anyPinHigh(state, componentId, ['IN2', 'AIN2', 'BIN2', 'LPWM']);
  if (forward !== reverse) return reverse ? -1 : 1;
  return 1;
}

/** One observation pass over every CAD-bench part on the bench. */
function sample(state: SimState, entries: Map<string, WatchEntry>, tick = 0): void {
  const store = usePartRenderStore.getState();
  // Pin contracts are read off the mounted elements; re-read them only on a slow
  // cadence (an element mounted after the canvas came up still gets picked up).
  const refreshPins = tick % 30 === 0;

  // What this pass can see, for the intake report: a part whose pin contract is
  // unknown cannot be traced at all, which is a different (and reportable) thing
  // from a part that is simply not driven. Published only when the picture
  // changes — the 3D HUD subscribes to this.
  const unknownPins: string[] = [];
  let knownPins = 0;
  let anyRunning = false;

  for (const board of state.boards) if (board.running !== false) anyRunning = true;

  for (const component of state.components) {
    const metadataId = component.metadataId ?? '';
    // Every mounted element publishes its own pin contract; remembering it for
    // ALL parts (not just the unsolved ones) is what lets the walk follow a
    // wire through a wokwi part into a CAD-bench part.
    if (metadataId) rememberPins(component.id, metadataId, refreshPins);
    if (!metadataId.startsWith(CAD_BENCH_PREFIX)) continue;
    const catalogId = metadataId.slice(CAD_BENCH_PREFIX.length);
    if (isPassiveId(catalogId)) continue;

    const roles = rolesFor(metadataId);
    if (!roles) {
      unknownPins.push(catalogId);
      continue;
    }
    knownPins += 1;

    let entry = entries.get(component.id);
    if (!entry) {
      entry = { metadataId, published: null, bus: 0, signature: '', coilCode: null, stepAngleDirection: 1, stepAngle: 0 };
      entries.set(component.id, entry);
    }

    // ── bus / command traffic: any change on a bus or command net is activity
    const watched = [...roles.busPins, ...roles.controlPins];
    if (watched.length > 0) {
      const signature = netSignature(state, component.id, watched);
      if (entry.signature && signature !== entry.signature) entry.bus = 1;
      entry.signature = signature;
    }
    entry.bus *= BUS_DECAY;

    // ── steppers: advance one half-step per commanded pattern change
    if (COIL_PINS.every((pin) => roles.all.includes(pin))) {
      const code = coilCode(state, component.id, roles);
      if (entry.coilCode !== null && code !== entry.coilCode && code !== 0) {
        entry.stepAngle = (entry.stepAngle + STEPPER_HALF_STEP_DEG * entry.stepAngleDirection) % 360;
      }
      if (entry.coilCode !== null && code !== entry.coilCode) entry.stepAngleDirection = code > entry.coilCode ? 1 : -1;
      entry.coilCode = code;
    }

    // ── energy
    const energy = readPartDrive(state, component.id, roles);
    const commanded = roles.controlPins.length > 0 && anyPinHigh(state, component.id, roles.controlPins);
    const isSource = isSourceId(catalogId);

    let activity = 0;
    let triggered = 0;
    let drive = energy.on ? energy.duty : 0;
    let turnsPerSecond = 0;

    if (isSource) {
      // A source holds a rail: it does not "run", is not "driven", and has no
      // contact that closes. Its live-ness shows through the parts it feeds.
      activity = 0;
      drive = 0;
    } else if (roles.controller) {
      activity = energy.on ? Math.max(energy.duty, commanded ? 1 : entry.bus > 0.15 ? 0.6 : 0.2) : 0;
      if (roles.outputPins.length > 0 && anyPinHigh(state, component.id, roles.outputPins)) triggered = 1;
    } else {
      activity = energy.on ? Math.max(energy.duty, 0.35) : 0;
      if (roles.outputPins.length > 0 && anyPinHigh(state, component.id, roles.outputPins)) triggered = 1;
      const rated = ratedRpm(catalogId);
      turnsPerSecond = rated === null ? 0 : (rated / 60) * Math.min(1, energy.duty);
    }

    const direction = directionFrom(energy, state, component.id, roles);
    const next: PartLiveState = {
      // The measured duty, nothing padded: 0 = not driven, 0.5 = analogWrite 128.
      drive: Math.min(1, Math.max(drive, 0)),
      activity: Math.min(1, activity),
      triggered,
      bus: Number(entry.bus.toFixed(3)),
      direction,
      turnsPerSecond: Number((turnsPerSecond * direction).toFixed(3)),
      rpm: Math.round(turnsPerSecond * 60),
      stepAngle: Number(entry.stepAngle.toFixed(3)),
      via: energy.on ? energy.via : '',
      viaPin: energy.on ? (energy.pin ?? '') : '',
    };

    const previous = entry.published;
    // A part that has nothing to report on the very first pass publishes
    // nothing at all: "no net, no state" must not become a stored zero that
    // some surface later reads as a measurement.
    const idle =
      next.drive === 0 &&
      next.activity === 0 &&
      next.triggered === 0 &&
      next.bus < 0.02 &&
      next.stepAngle === 0 &&
      next.turnsPerSecond === 0;
    if (!previous && idle) {
      entry.published = next;
      continue;
    }
    const changed =
      !previous ||
      Math.abs(previous.drive - next.drive) > 0.01 ||
      Math.abs(previous.activity - next.activity) > 0.01 ||
      previous.triggered !== next.triggered ||
      Math.abs(previous.bus - next.bus) > 0.02 ||
      previous.direction !== next.direction ||
      Math.abs(previous.turnsPerSecond - next.turnsPerSecond) > 0.02 ||
      previous.rpm !== next.rpm ||
      previous.via !== next.via ||
      Math.abs(previous.stepAngle - next.stepAngle) > 0.01;

    if (changed) {
      entry.published = next;
      store.setValue(component.id, { ...next });
    }
  }

  const pinsSignature = `${knownPins}|${unknownPins.join(',')}`;
  if (pinsSignature !== lastPinsSignature) {
    lastPinsSignature = pinsSignature;
    reportPins({ known: knownPins, unknown: unknownPins.sort() });
  }
  if (anyRunning !== lastRunning) {
    lastRunning = anyRunning;
    reportSim({ running: anyRunning });
  }
}

/** Last reported intake picture, so a 90 ms pass never re-publishes it. */
let lastPinsSignature = '';
let lastRunning: boolean | null = null;

/**
 * Prime the pin memory from `/cad-catalog.json`.
 *
 * Elements publish `pinInfo` once their spec resolves, which is the primary
 * source; this covers the frames before that, and any part whose element is not
 * mounted (a bench rebuilt from a project, a test with no DOM).
 */
let priming: Promise<void> | null = null;
let primedAt = 0;
const PRIME_RETRY_MS = 10_000;
function primeFromCatalog(): void {
  if (priming || typeof fetch !== 'function') return;
  // A failed prime is retried on the next tick (a canvas that mounted during a
  // deploy must not stay blind for the session); a successful one is latched.
  if (primedAt > 0 && Date.now() - primedAt < PRIME_RETRY_MS) return;
  priming = primeCadPins()
    .then((learned) => {
      primedAt = learned > 0 ? Date.now() : 0;
    })
    .catch(() => {
      primedAt = 0;
    })
    .finally(() => {
      priming = null;
    });
}

let stopHandle: (() => void) | null = null;

/**
 * Start observing CAD-bench parts. Idempotent: the first caller owns the timer
 * and every caller gets the same stop function.
 */
export function startPartActivityWatch(): () => void {
  if (stopHandle) return stopHandle;
  const entries = new Map<string, WatchEntry>();

  let ticks = 0;
  const tick = (): void => {
    try {
      sample(useSimulatorStore.getState(), entries, ticks++);
    } catch (error) {
      // Observation must never take the canvas down with it.
      console.warn('[liveState] activity sample failed', error);
    }
  };

  primeFromCatalog();
  tick();
  const timer = setInterval(tick, POLL_MS);
  stopHandle = () => {
    clearInterval(timer);
    stopHandle = null;
    entries.clear();
  };
  return stopHandle;
}

/** Test seam: run one pass against a store state without starting the timer. */
export function sampleOnce(
  state: SimState,
  entries = new Map<string, WatchEntry>(),
  tick = 0,
): Map<string, WatchEntry> {
  sample(state, entries, tick);
  return entries;
}
