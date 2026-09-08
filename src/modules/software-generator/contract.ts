/**
 * The device contract — the single fact both halves are generated from.
 *
 * The firmware this repo generates speaks one very specific protocol over its
 * control link (see `modules/code-generator/templates.ts`):
 *
 *   board → host   `status:{"state":"idle","speed":70,"tempC":21.4,...}`
 *                  `ok:<what happened>` / `warn:<...>` / `err:<...>`
 *   host → board   one command CHARACTER per keystroke, plus the built-ins
 *                  `+` / `-` (speed ±10) and `?` (force a telemetry frame)
 *
 * The generated dashboard is not allowed to invent a REST API the board does
 * not serve, and it is not allowed to guess which fields arrive. So this module
 * derives the contract from the SAME inputs the sketch was generated from —
 * the pin plan, the selections and the software plan — and both the firmware
 * and the website are described by it. If the firmware would not print a
 * field, the dashboard does not display a card for it.
 *
 * This is what makes the hardware⇄software link real rather than a mock: the
 * website reads exactly the keys the sketch emits, and sends exactly the
 * characters the sketch's `handleCommand` switch accepts.
 */

import type { ComponentSelection } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';
import type { CommandSpec, GeneratedCodeFile, SoftwarePlan } from '@/types/project';

import { commandCharacters, telemetryFields } from './firmware-signals';

export interface DeviceMetric {
  /** Key as it appears in the telemetry JSON. */
  field: string;
  label: string;
  unit: string;
  kind: 'number' | 'string';
  /** Expected display range, when the physical quantity has one. */
  min?: number;
  max?: number;
  /** Decimal places the firmware prints. */
  precision?: number;
  /** Which part of the build produces this reading. */
  source: string;
}

export interface DeviceCommand {
  /** The single character written to the board's link. */
  character: string;
  label: string;
  meaning: string;
  /** Built-ins are emitted by the sketch generator for every project. */
  builtIn: boolean;
}

export interface DeviceContract {
  projectName: string;
  controller: string;
  /** Baud the sketch opens the control link at. */
  baud: number;
  /** Prefix of a telemetry line, e.g. `status:`. */
  telemetryPrefix: string;
  /** Milliseconds between unforced telemetry frames. */
  telemetryIntervalMs: number;
  metrics: DeviceMetric[];
  commands: DeviceCommand[];
  /** Transport the sketch actually uses, in the user's words. */
  transport: string;
  /** Things the dashboard must NOT claim, spelled out for the README. */
  caveats: string[];
}

/** The sketch's own constant — keep in sync with templates.ts. */
const TELEMETRY_INTERVAL_MS = 1000;
const TELEMETRY_PREFIX = 'status:';

/** Mirrors `safeIdentifier(...).toLowerCase()` in the sketch generator. */
function telemetryFieldFor(instanceId: string): string {
  return instanceId.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export interface DeviceContractInput {
  projectName: string;
  controllerName: string;
  selections: ComponentSelection[];
  assignments: PinAssignment[];
  softwarePlan: SoftwarePlan;
  /** Control states the sketch compiled in — the `state` field's domain. */
  hasCounter?: boolean;
  /**
   * The generated firmware. When present it is authoritative: a metric the
   * sketch never prints is not offered to the dashboard, and a command the
   * parser never accepts is not shown as a button.
   */
  firmware?: Pick<GeneratedCodeFile, 'path' | 'content'>[];
}

/**
 * Shape of every telemetry key an access-control (PIN lock) build can print,
 * mirroring `behaviours/access-control.ts`'s `sendTelemetry()`.
 */
const ACCESS_CONTROL_FIELDS: Record<string, Omit<DeviceMetric, 'field'>> = {
  state: { label: 'Lock state', unit: '', kind: 'string', source: 'PIN / lock state machine' },
  locked: { label: 'Locked', unit: '', kind: 'string', source: 'lock actuator position' },
  door: { label: 'Door', unit: '', kind: 'string', source: 'door switch (or auto-relock timer)' },
  attempts: {
    label: 'Failed attempts',
    unit: '',
    kind: 'number',
    min: 0,
    precision: 0,
    source: 'PIN attempt counter',
  },
  angle: {
    label: 'Bolt angle',
    unit: '°',
    kind: 'number',
    min: 0,
    max: 180,
    precision: 0,
    source: 'servo position',
  },
};

/** Labels for the command characters a generated sketch handles but the planner did not name. */
const BUILT_IN_COMMANDS: Record<string, { label: string; meaning: string }> = {
  '?': { label: 'Refresh now', meaning: 'Force an immediate telemetry frame.' },
  S: { label: 'Status now', meaning: 'Force an immediate telemetry frame.' },
  L: { label: 'Lock now', meaning: 'Drive the lock back to its locked position and clear the entered PIN.' },
  '+': { label: 'Speed +10%', meaning: 'Raise the speed setpoint by 10 percentage points.' },
  '-': { label: 'Speed −10%', meaning: 'Lower the speed setpoint by 10 percentage points.' },
};

/**
 * Recreate, from the plan, exactly which fields `sendTelemetry()` prints.
 *
 * The conditions below intentionally mirror the sketch generator's own
 * feature detection one-for-one. When that changes, this changes with it —
 * a mismatch here would put a permanently empty card on the dashboard.
 */
export function deriveDeviceContract(input: DeviceContractInput): DeviceContract {
  const { selections, assignments, softwarePlan } = input;
  const has = (pattern: RegExp): boolean => selections.some((selection) => pattern.test(selection.componentId));
  const libraries = softwarePlan.libraries;
  const hasLibrary = (header: string): boolean =>
    libraries.some((library) => library.import.toLowerCase() === header.toLowerCase());

  const metrics: DeviceMetric[] = [
    {
      field: 'state',
      label: 'Movement state',
      unit: '',
      kind: 'string',
      source: 'firmware state machine',
    },
    {
      field: 'speed',
      label: 'Speed',
      unit: '%',
      kind: 'number',
      min: 0,
      max: 100,
      precision: 0,
      source: 'firmware speed setpoint',
    },
  ];

  if (input.hasCounter) {
    metrics.push({
      field: 'count',
      label: 'Press count',
      unit: '',
      kind: 'number',
      min: 0,
      precision: 0,
      source: 'debounced button counter',
    });
  }

  // DHT: the sketch prints tempC + rh only when the DHT library is linked.
  if (has(/dht/i) && hasLibrary('DHT.h')) {
    metrics.push(
      {
        field: 'tempC',
        label: 'Temperature',
        unit: '°C',
        kind: 'number',
        min: -40,
        max: 80,
        precision: 1,
        source: 'DHT sensor',
      },
      {
        field: 'rh',
        label: 'Relative humidity',
        unit: '%',
        kind: 'number',
        min: 0,
        max: 100,
        precision: 1,
        source: 'DHT sensor',
      },
    );
  }

  // Ultrasonic: printed only when BOTH TRIG and ECHO got a pin.
  const ultrasonic = selections.find((selection) => /sr04/i.test(selection.componentId));
  const ultrasonicInstance = ultrasonic?.instances[0]?.instanceId;
  const hasTrig = assignments.some(
    (assignment) => assignment.targetInstanceId === ultrasonicInstance && /trig/i.test(assignment.targetPin),
  );
  const hasEcho = assignments.some(
    (assignment) => assignment.targetInstanceId === ultrasonicInstance && /echo/i.test(assignment.targetPin),
  );
  if (hasTrig && hasEcho) {
    metrics.push({
      field: 'distanceCm',
      label: 'Distance',
      unit: 'cm',
      kind: 'number',
      min: 0,
      max: 400,
      precision: 1,
      source: 'HC-SR04 ultrasonic sensor',
    });
  }

  // Every ADC assignment gets its own field, named after its instance id.
  for (const assignment of assignments.filter((entry) => entry.protocol === 'adc')) {
    metrics.push({
      field: telemetryFieldFor(assignment.targetInstanceId),
      label: assignment.purpose || assignment.targetInstanceId,
      unit: 'counts',
      kind: 'number',
      min: 0,
      max: 4095,
      precision: 0,
      source: `analog read on ${assignment.pin}`,
    });
  }

  /* Reconcile with the firmware that was actually generated ---------------- */
  const printed = telemetryFields(input.firmware ?? []);
  if (printed) {
    for (const field of printed) {
      const shape = ACCESS_CONTROL_FIELDS[field];
      if (!shape) continue;
      if (metrics.some((metric) => metric.field === field)) {
        // The access-control state machine relabels `state`: use its words.
        const existing = metrics.find((metric) => metric.field === field);
        if (existing) {
          existing.label = shape.label;
          existing.source = shape.source;
        }
        continue;
      }
      metrics.push({ field, ...shape });
    }
    /*
     * Drop anything the sketch does not print. A keypad safe has no speed
     * setpoint, so a "Speed %" card would sit empty forever — and the static
     * cross-check would (rightly) flag it on every build.
     */
    for (let index = metrics.length - 1; index >= 0; index--) {
      const metric = metrics[index];
      if (metric && !printed.includes(metric.field)) metrics.splice(index, 1);
    }
    // Keep the declared order: `state` first, then the build's own readings.
    metrics.sort((a, b) => printed.indexOf(a.field) - printed.indexOf(b.field));
  }

  /* Commands --------------------------------------------------------------- */
  const planned: CommandSpec[] = softwarePlan.communication?.commandSet ?? [];
  const commands: DeviceCommand[] = [];
  const seen = new Set<string>();
  for (const entry of planned) {
    const character = entry.command.length > 0 ? entry.command.charAt(0) : '';
    if (!character || seen.has(character)) continue;
    seen.add(character);
    commands.push({
      character,
      label: entry.meaning || character,
      meaning: entry.response ? `${entry.meaning} — replies ${entry.response}` : entry.meaning,
      builtIn: false,
    });
  }
  const accepted = commandCharacters(input.firmware ?? []);
  if (accepted) {
    /*
     * The parser in the sketch is the truth: it decides what the board does
     * with a keystroke. Anything it does not accept would come back as
     * "err:unknown command", and anything it accepts but the planner never
     * named still deserves a button.
     */
    for (let index = commands.length - 1; index >= 0; index--) {
      const command = commands[index];
      if (command && !accepted.includes(command.character)) commands.splice(index, 1);
    }
    for (const character of accepted) {
      if (commands.some((command) => command.character === character)) continue;
      const known = BUILT_IN_COMMANDS[character];
      commands.push({
        character,
        label: known?.label ?? `Send "${character}"`,
        meaning: known?.meaning ?? `The firmware's command parser accepts "${character}".`,
        builtIn: true,
      });
    }
  } else if (commands.length > 0) {
    // No firmware to read (e.g. the model wrote the sketch): assume the
    // generator's built-ins are present.
    for (const character of ['+', '-', '?']) {
      if (seen.has(character)) continue;
      seen.add(character);
      const known = BUILT_IN_COMMANDS[character];
      commands.push({ character, label: known?.label ?? character, meaning: known?.meaning ?? '', builtIn: true });
    }
  }

  /* Transport + caveats ---------------------------------------------------- */
  const communication = softwarePlan.communication;
  const usesBluetooth = /bluetooth/i.test(communication?.protocol ?? '');
  const transport = usesBluetooth
    ? 'Bluetooth Classic serial (ESP32 BluetoothSerial) — the same byte stream as USB serial.'
    : communication?.transport || 'USB serial (the board\'s primary UART).';
  const baud = usesBluetooth ? 9600 : 115_200;

  const caveats: string[] = [
    'The dashboard reads the board\'s serial stream. It does not poll an HTTP API on the device — the generated firmware does not serve one.',
    `Telemetry arrives at most every ${TELEMETRY_INTERVAL_MS} ms unless "?" is sent.`,
  ];
  if (commands.length === 0) {
    caveats.push(
      'This build\'s firmware has no command set, so the dashboard is read-only. That is the firmware\'s doing, not a missing feature.',
    );
  }
  if (usesBluetooth) {
    caveats.push(
      'Over Bluetooth Classic the browser cannot open the port directly; the bundled Node bridge does it and relays over WebSocket.',
    );
  }

  return {
    projectName: input.projectName,
    controller: input.controllerName,
    baud,
    telemetryPrefix: TELEMETRY_PREFIX,
    telemetryIntervalMs: TELEMETRY_INTERVAL_MS,
    metrics,
    commands,
    transport,
    caveats,
  };
}
