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
import type { CommandSpec, SoftwarePlan } from '@/types/project';

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
}

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
  // The sketch always compiles these three in when it has any command set.
  if (commands.length > 0) {
    for (const builtIn of [
      { character: '+', label: 'Speed +10%', meaning: 'Raise the speed setpoint by 10 percentage points.' },
      { character: '-', label: 'Speed −10%', meaning: 'Lower the speed setpoint by 10 percentage points.' },
      { character: '?', label: 'Refresh now', meaning: 'Force an immediate telemetry frame.' },
    ]) {
      if (seen.has(builtIn.character)) continue;
      seen.add(builtIn.character);
      commands.push({ ...builtIn, builtIn: true });
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
