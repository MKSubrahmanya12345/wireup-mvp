/**
 * pinRoles — what KIND of pin each pin of a part is, read from its name.
 *
 * The emulator has no electrical model for a CAD-bench part (Wireup places it
 * from its CAD catalog: a pump, an L298N, an HC-05, a battery holder …). What it
 * DOES have is the part's pin list — published by the mounted
 * `<velxio-cad-bench-part>` element from `/cad-catalog.json` — and real hardware
 * pin names are a vocabulary, not arbitrary labels:
 *
 *   GND / V- / '-'          the return path
 *   VCC / + / A / B / M1    where energy arrives
 *   IN / STEP / DIR / EN    what tells the part what to do
 *   OUT / NO / AO / PHASE_A what the part drives
 *   SDA / SCL / DQ / TX,RX  buses (state is a protocol, not a level)
 *
 * Classifying a pin list by that vocabulary is enough to answer the two
 * questions the 3D view asks about a part it cannot solve:
 *
 *   • is this part being DRIVEN right now? (some drive pin carries a voltage)
 *   • is it being ADDRESSED right now? (some bus pin is toggling)
 *
 * The only context needed is whether the part is a CONTROLLER (it has command
 * inputs, so its output-shaped pins really are outputs) or a LOAD (no command
 * inputs: its bare `A`/`B`/`PHASE_A` are the terminals energy arrives at). That
 * distinction is itself derived from the names, and it is why the same pin name
 * means opposite things on an L298N and on the motor wired to it.
 *
 * Nothing here is keyed to a part id: the tables are the industry-wide naming
 * conventions and every part is classified from its own spec.
 */

export type PinRole = 'ground' | 'output' | 'control' | 'bus' | 'power';

export interface PartRoles {
  /** Has command inputs ⇒ its output-shaped pins are outputs, not energy in. */
  controller: boolean;
  /** Terminals that receive energy (a motor's `A`/`B`, a fan's `VCC` …). */
  drivePins: string[];
  /** Command inputs (`IN`, `STEP`, `DIR`, `EN`, `SIG`, `PWM`, `TX` …). */
  controlPins: string[];
  /** Pins the part drives (`OUT1`, `NO`, `A1`, `PHASE_A`, `DO` …). */
  outputPins: string[];
  /** Data-bus lines (`SDA`, `SCL`, `DQ`, `SQW` …). */
  busPins: string[];
  /** Return path (`GND`, `-`, `V-`, `COM` …). */
  groundPins: string[];
  /** Every pin, in spec order — for diagnostics. */
  all: string[];
}

const GROUND = new Set([
  'GND',
  'GND4',
  'GND5',
  'GND12',
  'GND13',
  'GND_MOT',
  'GND_IN',
  'ENC_GND',
  'COM', // the return of a switch/relay contact, never energy in
  '-',
  '−',
  'V-',
  'BAT-',
  'IN-',
  'OUT-',
]);

const CONTROL = new Set([
  'IN',
  'IN1',
  'IN2',
  'IN3',
  'IN4',
  'IN5',
  'IN6',
  'IN7',
  'IN8',
  'SIG',
  'SIGNAL',
  'STEP',
  'STP',
  'DIR',
  'EN',
  'ENA',
  'ENB',
  'EN1_2',
  'EN3_4',
  'OE',
  'PWM',
  'PWMA',
  'PWMB',
  'RPWM',
  'LPWM',
  'R_EN',
  'L_EN',
  'AIN1',
  'AIN2',
  'BIN1',
  'BIN2',
  'STBY',
  'SLP',
  'SLEEP',
  'RST',
  'RESET',
  'CH_PD',
  'PDN_UART',
  'DIAG',
  'FAULT',
  'FLT',
  'TRIG',
  'ECHO',
  'M0',
  'M1',
  'M2',
  'MS1',
  'MS2',
  'MS3',
  'COIL_A',
  'COIL_B',
  'COIL1',
  'COIL2',
  'COIL_A1',
  'COIL_A2',
  'COIL_B1',
  'COIL_B2',
  'KEY',
  'IRQ',
  'INT',
]);

const BUS = new Set([
  'SDA',
  'SCL',
  'TX',
  'RX',
  'TXD',
  'RXD',
  'PPS',
  'SQW',
  '32K',
  'AD0',
  'XDA',
  'XCL',
  'DQ',
  'CSI',
  'SCK',
  'SDI',
  'SDO',
  'DC',
  'CS',
  'CSB',
  'ADDR',
  'ID',
  'PWM0',
  'LED',
  'ENC_A',
  'ENC_B',
]);

/**
 * Output-shaped names. Checked BEFORE the power default, so a controller's
 * `OUT1`/`NO`/`A1`/`PHASE_A` are outputs — and AFTER the controller test, so a
 * motor's `A`/`B`/`PHASE_A` stay energy inputs.
 */
const OUTPUT_PATTERNS: RegExp[] = [
  /^OUT(\d+|[+-])?$/, // OUT, OUT1, OUT+, OUT-
  /^AO\d*$/, // analog output (a sensor's AO, a driver's bridge out)
  /^BO\d*$/,
  /^OA\d*$/, // h-bridge outputs (OpenA/OpenB)
  /^OB\d*$/,
  /^PHASE_[ABC]$/, // the three phases a BLDC driver pushes
  /^M[+-]$/, // motor terminals on a driver
  /^NO$/, // relay / switch normally-open contact
  /^NC$/, // normally-closed contact
  /^A[12]$/, // stepper bridge outputs on a driver
  /^B[12]$/,
  /^DO$/, // digital output of a sensor module
];

const SUPPLY = new Set([
  'VCC',
  'VDD',
  'VIN',
  'VIO',
  'VM',
  'VMOT',
  'V+',
  '+',
  '+5V',
  '5V',
  '3V3',
  '12V',
  'BAT+',
  'USB_5V',
  'IN+',
  'HV',
  'LV',
  'VIN_DC',
  'VS',
  'V_LOG',
]);

/** Is this pin name one of a board's supply rails (always live while running)? */
export function isSupplyPin(name: string): boolean {
  return SUPPLY.has(name);
}

function looksLikeOutput(name: string): boolean {
  return OUTPUT_PATTERNS.some((pattern) => pattern.test(name));
}

/** One pin's role, given whether its part is a controller. */
export function roleOfPin(name: string, controller: boolean): PinRole {
  if (GROUND.has(name)) return 'ground';
  if (BUS.has(name)) return 'bus';
  if (controller && looksLikeOutput(name)) return 'output';
  if (CONTROL.has(name)) return 'control';
  if (SUPPLY.has(name)) return 'power';
  if (looksLikeOutput(name)) return 'output';
  // Anything left is an electrical terminal with no command semantics — a
  // motor's `A`/`B`, a stepper's `M1`/`M2`, a custom pin labelled `1`/`2`.
  return 'power';
}

/** Classify a whole part from its own pin names. */
export function classifyPart(pins: string[]): PartRoles {
  const controller = pins.some((pin) => CONTROL.has(pin));
  const roles: PartRoles = {
    controller,
    drivePins: [],
    controlPins: [],
    outputPins: [],
    busPins: [],
    groundPins: [],
    all: [...pins],
  };
  for (const pin of pins) {
    switch (roleOfPin(pin, controller)) {
      case 'ground':
        roles.groundPins.push(pin);
        break;
      case 'output':
        roles.outputPins.push(pin);
        break;
      case 'control':
        roles.controlPins.push(pin);
        break;
      case 'bus':
        roles.busPins.push(pin);
        break;
      default:
        roles.drivePins.push(pin);
        break;
    }
  }
  // A controller takes energy at its supply pins and commands at its control
  // pins; both are part of "is it powered / being told to do something".
  if (roles.controller) {
    const supplies = roles.drivePins.filter((pin) => SUPPLY.has(pin));
    const terminals = roles.drivePins.filter((pin) => !SUPPLY.has(pin));
    roles.drivePins = [...supplies, ...terminals];
  }
  return roles;
}

/* ─────────────────────────── part-level hints ──────────────────────────────
 * Two facts about a part that its pin names cannot express, keyed by catalog id
 * fragment. Both are about the part's physical nature, not about an instance of
 * it: a battery is a source (its terminals SUPPLY), and a propeller is a passive
 * aerodynamic part (nothing about it changes when its carrier turns). */

const SOURCE_FRAGMENTS = ['battery', 'holder', 'power-module'];
const PASSIVE_FRAGMENTS = ['propeller'];

export function isSourceId(catalogId: string): boolean {
  return SOURCE_FRAGMENTS.some((fragment) => catalogId.includes(fragment));
}

export function isPassiveId(catalogId: string): boolean {
  return PASSIVE_FRAGMENTS.some((fragment) => catalogId.includes(fragment));
}

/**
 * The rated speed of a device family, in rpm.
 *
 * Used to turn a measured duty into a real rotation rate (`drive × rated`), so a
 * fan visibly turns faster at 100 % than at 20 % and nothing spins faster than
 * the hardware it stands for. These are datasheet-class figures for the device
 * the catalog key names — the actual rotation on screen is this number scaled by
 * the PWM duty the sketch produced, never a fixed animation.
 */
const RATED_RPM: { fragment: string; rpm: number }[] = [
  { fragment: 'stepper-28byj48', rpm: 15 },
  { fragment: 'peristaltic', rpm: 120 },
  { fragment: 'n20', rpm: 200 },
  { fragment: 'linear-actuator', rpm: 600 }, // the motor inside the screw drive
  { fragment: 'dc-motor', rpm: 300 }, // geared output (the spec models a gearbox)
  { fragment: 'blower-fan', rpm: 3500 },
  { fragment: 'fan-12v-4pin', rpm: 2000 },
  { fragment: 'fan-5v-40mm', rpm: 6000 },
  { fragment: 'water-pump', rpm: 2400 },
  { fragment: 'vibration-motor', rpm: 9000 },
  { fragment: 'bldc-motor-2212', rpm: 7000 },
  { fragment: 'bldc-motor-2205', rpm: 15000 },
];

export function ratedRpm(catalogId: string): number | null {
  for (const entry of RATED_RPM) if (catalogId.includes(entry.fragment)) return entry.rpm;
  return null;
}
