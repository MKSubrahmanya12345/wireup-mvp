/**
 * Door hardware: lock actuators, the driver that actually switches them,
 * door-state feedback, the keypad fallback and the supplies they need.
 *
 * Everything here is a real, purchasable part with real numbers. Where the
 * engineering has a known failure mode (flyback diode, common ground, 3.3 V
 * gate drive, mains safety) it is recorded in metadata so the planner can
 * surface it instead of learning it from a burnt MOSFET.
 */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const LOCK_HARDWARE: ComponentDefinition[] = [
  def({
    id: 'solenoid-lock-12v',
    name: '12 V electric solenoid door bolt (fail-secure)',
    category: 'actuator',
    description:
      'Spring-loaded solenoid bolt. Applying 12 V retracts the bolt; removing power lets the spring throw it back, so the door is LOCKED when power is lost (fail-secure). Two-terminal inductive coil — it must be switched by a driver, never by a GPIO pin, and it needs a flyback diode across the coil.',
    voltage: 12,
    minVoltage: 11,
    maxVoltage: 13,
    currentRequirements: {
      typicalMa: 900,
      maxMa: 2000,
      note: 'Holding ~300-900 mA depending on the model, with a 1.5-2 A inrush for the first ~100 ms as the bolt pulls in. Size the supply for the inrush, not the hold.',
    },
    motorRequirements: {
      motorType: 'dc',
      requiresDriver: true,
      requiresExternalSupply: true,
      supplyVoltageMin: 11,
      supplyVoltageMax: 13,
      maxCurrentPerChannelMa: 2000,
      stallCurrentMa: 2000,
      controlSignal: 'digital',
      logicVoltage: 12,
    },
    pins: [
      pin('A', 'motor', 'input', { required: true, signal: 'Coil terminal A (typically red, to +12 V)', voltage: 12, aliases: ['+', 'V+', 'RED'] }),
      pin('B', 'motor', 'input', { required: true, signal: 'Coil terminal B (typically black, switched low side)', voltage: 12, aliases: ['-', 'V-', 'BLACK'] }),
    ],
    incompatibleComponents: ['raspberry-pi-4b', 'raspberry-pi-5', 'raspberry-pi-zero-2-w', 'esp32-devkit-v1', 'arduino-uno-r3', 'arduino-nano'],
    libraryRequirements: [
      { name: 'gpiozero', import: 'gpiozero', manager: 'pip', purpose: 'OutputDevice to drive the MOSFET gate from a GPIO', builtIn: false },
    ],
    keywords: ['solenoid', 'lock', 'bolt', 'door', 'strike', 'fail secure', 'access control', '12v'],
    aliases: ['solenoid lock', 'electric bolt', '12v solenoid', 'door lock solenoid', 'solenoid bolt'],
    exampleUsage: ['Face recognition door lock', 'Keypad or RFID access control'],
    simulator: { supported: false, notes: 'Represent as an inductive load on a switched rail.' },
    metadata: {
      kind: 'lock',
      electrical: true,
      noSupplyPins: true,
      lockBehaviour: 'fail-secure',
      lockBehaviourNote: 'Locked with no power. If this door is the only way out of an occupied room, that is a fire-safety problem — use a fail-safe strike or provide a mechanical override.',
      inductive: true,
      requiresFlybackDiode: true,
      flybackNote: 'Fit the diode ANTI-PARALLEL across the coil (cathode to +12 V), not in series. A diode in series simply reverse-biases and the bolt never moves.',
      inrushNote: 'Budget ~2 A for the pull-in pulse even though holding current is under an amp.',
      incompatibleReason: 'A GPIO pin can neither source 1 A nor survive the inductive kick. Use a logic-level MOSFET and a flyback diode.',
      dutyCycleNote: 'Most bolts are not rated for continuous energisation. Unlock pulses of a few seconds, then release.',
    },
  }),

  def({
    id: 'mosfet-low-side-driver',
    name: 'Logic-level N-MOSFET low-side switch module',
    category: 'motor_driver',
    description:
      'N-channel MOSFET low-side switch with a gate resistor, a 10 kΩ gate pull-down and a screw terminal for the load. The gate must be a LOGIC-LEVEL part (IRLZ44N, AO3414, AO3422 class) that fully enhances at a 3.3 V gate — a standard IRF510 or IRF540 needs 10 V and will only half-turn on from a Raspberry Pi, which cooks the MOSFET.',
    voltage: 12,
    minVoltage: 3.3,
    maxVoltage: 24,
    currentRequirements: { typicalMa: 2, maxMa: 20, note: 'Gate is a capacitive load; steady draw is the pull-down resistor, a couple of mA.' },
    pins: [
      pin('IN', 'digital', 'input', { required: true, signal: 'Gate input through the series resistor — 3.3 V logic compatible', voltage: 3.3, aliases: ['G', 'GATE', 'SIG'] }),
      pin('V+', 'power', 'power', { required: false, signal: 'Load supply pass-through (+12 V in this build)', voltage: 12, aliases: ['VIN', '12V', 'LOAD+'] }),
      pin('OUT', 'motor', 'output', { required: true, signal: 'Drain: connect to the load negative terminal', aliases: ['D', 'DRAIN', 'LOAD-'] }),
      pin('GND', 'ground', 'ground', { required: true, signal: 'Source: common ground with the logic board AND the load supply', aliases: ['S', 'SOURCE', '-'] }),
    ],
    communicationProtocols: ['pwm'],
    keywords: ['mosfet', 'driver', 'switch', 'low side', 'solenoid driver', 'relay alternative', 'logic level'],
    aliases: ['mosfet driver', 'mosfet module', 'low side switch', 'logic level mosfet', 'irfz44n module', 'irlz44n'],
    exampleUsage: ['Switching a 12 V solenoid from a 3.3 V GPIO', 'Driving a 12 V fan or LED strip with PWM'],
    simulator: { supported: false, notes: 'Represent as a controlled switch on the low side.' },
    metadata: {
      electrical: true,
      driverKind: 'low-side-mosfet',
      gateLogicVoltage: 3.3,
      gateLogicNote: 'Must be a logic-level MOSFET. Verify the datasheet Vgs threshold at the CURRENT you need, not just the threshold voltage — IRF510/IRF540 are the classic mistake here.',
      requiresFlybackDiode: true,
      commonGroundRequired: true,
      commonGroundNote: 'Without a shared ground between the logic board and the load supply, the gate has no return path and nothing switches. This is the single most common cause of "the transistor does not work".',
      gatePullDown: '10 kΩ gate-to-source so the load stays off while the host boots and the GPIO is high-impedance.',
      gateResistor: '220 Ω series resistor to limit the GPIO current into the gate capacitance.',
      maxLoadCurrentA: 5,
      maxLoadVoltageV: 24,
      testSequence: [
        'Leave the logic board disconnected. Power the load directly from the supply and confirm the solenoid actually moves.',
        'Wire the MOSFET in series on the low side and confirm it still moves.',
        'Tie the gate to the load supply positive through a resistor and confirm it switches.',
        'Only then connect the GPIO and drive it from software.',
      ],
    },
  }),

  def({
    id: 'door-reed-switch',
    name: 'Magnetic door contact (reed switch, NO/COM)',
    category: 'sensor',
    description:
      'Two-terminal magnetic reed contact in a screw-mount housing. The magnet on the door holds the reed closed when the door is shut; opening the door opens the circuit. Reads as a plain GPIO input with a pull-up — no power rail of its own.',
    voltage: 3.3,
    currentRequirements: { typicalMa: 0, maxMa: 0, note: 'Passive contact. Ratings (100 mA / 10 W) are a switching limit, not a draw.' },
    pins: [
      pin('A', 'other', 'input', { required: true, signal: 'Contact terminal A', aliases: ['1', 'COM'] }),
      pin('B', 'other', 'input', { required: true, signal: 'Contact terminal B', aliases: ['2', 'NO'] }),
    ],
    libraryRequirements: [
      { name: 'gpiozero', import: 'gpiozero', manager: 'pip', purpose: 'Button with pull_up=True to read the contact', builtIn: false },
    ],
    keywords: ['reed switch', 'door sensor', 'magnetic contact', 'door state', 'open closed'],
    aliases: ['reed switch', 'door contact', 'magnetic switch', 'door sensor'],
    exampleUsage: ['Confirming a door actually closed after unlocking', 'Forced-open alarm'],
    simulator: { supported: false, notes: 'Represent as a normally-open switch to ground.' },
    metadata: {
      kind: 'door_sensor',
      electrical: true,
      noSupplyPins: true,
      contactRating: '100 mA / 10 W',
      contactRatingNote: 'A switching limit. It is not a supply load — never sum reed contacts into a power budget.',
      closedWhen: 'magnet near (door shut)',
      wiringNote: 'One side to GND, the other to a GPIO with the internal pull-up enabled. Add 100 nF across the contacts if long cable runs cause false triggers.',
      whyItMatters: 'Without it the system can only assume the door closed. With it, "unlocked then never opened" and "opened without unlocking" both become detectable.',
    },
  }),

  def({
    id: 'membrane-keypad-4x4',
    name: '4x4 matrix membrane keypad',
    category: 'input_device',
    description:
      '16-key membrane keypad with 8 row/column pins scanned as a 4x4 matrix. No active electronics and no supply rail; the host drives the rows and reads the columns with pull-ups. Used here as the PIN fallback so the door is never locked out by a failed camera.',
    voltage: 3.3,
    currentRequirements: { typicalMa: 0, maxMa: 1, note: 'Scanning current only. The 50 mA figures on some datasheets are contact ratings.' },
    pins: [
      pin('R1', 'digital', 'output', { required: true, signal: 'Matrix row 1' }),
      pin('R2', 'digital', 'output', { required: true, signal: 'Matrix row 2' }),
      pin('R3', 'digital', 'output', { required: true, signal: 'Matrix row 3' }),
      pin('R4', 'digital', 'output', { required: true, signal: 'Matrix row 4' }),
      pin('C1', 'digital', 'input', { required: true, signal: 'Matrix column 1' }),
      pin('C2', 'digital', 'input', { required: true, signal: 'Matrix column 2' }),
      pin('C3', 'digital', 'input', { required: true, signal: 'Matrix column 3' }),
      pin('C4', 'digital', 'input', { required: true, signal: 'Matrix column 4' }),
    ],
    libraryRequirements: [
      { name: 'gpiozero', import: 'gpiozero', manager: 'pip', purpose: 'OutputDevice/Button scan of the matrix', builtIn: false },
    ],
    keywords: ['keypad', 'matrix keypad', 'pin pad', 'membrane', 'access control', 'fallback'],
    aliases: ['keypad', '4x4 keypad', 'matrix keypad', 'membrane keypad', 'pin pad'],
    exampleUsage: ['PIN fallback for a face recognition lock', 'Local enrollment authorisation'],
    metadata: {
      electrical: true,
      noSupplyPins: true,
      keypadMatrix: {
        rows: ['R1', 'R2', 'R3', 'R4'],
        columns: ['C1', 'C2', 'C3', 'C4'],
        keyMap: [
          ['1', '2', '3', 'A'],
          ['4', '5', '6', 'B'],
          ['7', '8', '9', 'C'],
          ['*', '0', '#', 'D'],
        ],
      },
      scanNote: 'Drive rows high one at a time and read the columns with pull-downs, or drive rows low and read with pull-ups. Enable the pull-ups in software; most membranes ship without them.',
      fallbackRole: 'PIN fallback so a failed camera or a locked-out user is not a permanently shut door.',
    },
  }),

  def({
    id: 'psu-5v-3a-usbc',
    name: '5 V 3 A USB-C power supply (official Raspberry Pi supply)',
    category: 'power',
    description:
      'Mains to USB-C switched supply, 5.1 V at 3 A with a captive cable. The recommended supply for a Raspberry Pi 4B driving a camera. Under-rated phone chargers are the most common cause of intermittent Pi failures: brownouts present as camera glitches, USB resets and corrupted SD cards, and they look exactly like software bugs.',
    voltage: 5.1,
    minVoltage: 5,
    maxVoltage: 5.25,
    currentRequirements: { typicalMa: 0, maxMa: 3000 },
    powerSourceRequirements: { outputVoltage: 5, outputVoltageMin: 5, outputVoltageMax: 5.25, maxCurrentMa: 3000, rail: '5V' },
    pins: [
      pin('+V', 'power', 'output', { required: true, signal: '5 V out on the USB-C captive cable', voltage: 5, aliases: ['5V', 'VOUT+', 'VBUS'] }),
      pin('-V', 'ground', 'output', { required: true, signal: 'Ground', aliases: ['GND', 'VOUT-'] }),
    ],
    keywords: ['power supply', 'usb-c', '5v', '3a', 'mains', 'adapter', 'charger'],
    aliases: ['pi power supply', '5v 3a supply', 'usb-c power supply', 'official raspberry pi psu'],
    metadata: {
      electrical: true,
      mains: true,
      connector: 'usb-c',
      safetyNote: 'Mains voltage. Use a properly rated, certified supply in an enclosure — never a bare board or exposed terminals where they can be touched.',
      whyItMatters: 'A 1 A phone charger will boot the Pi and then fail under camera load.',
    },
  }),

  def({
    id: 'psu-12v-2a',
    name: '12 V 2 A DC power supply',
    category: 'power',
    description:
      'Mains to 12 V DC regulated supply, 2 A, 5.5/2.1 mm barrel jack or screw terminals. Sized for a solenoid bolt: it must cover the ~2 A pull-in inrush, not just the holding current. Lives on its own rail and shares its ground with the logic supply.',
    voltage: 12,
    minVoltage: 11.5,
    maxVoltage: 12.5,
    currentRequirements: { typicalMa: 0, maxMa: 2000 },
    powerSourceRequirements: { outputVoltage: 12, outputVoltageMin: 11.5, outputVoltageMax: 12.5, maxCurrentMa: 2000, rail: '12V' },
    pins: [
      pin('+V', 'power', 'output', { required: true, signal: '12 V out', voltage: 12, aliases: ['12V', 'VOUT+'] }),
      pin('-V', 'ground', 'output', { required: true, signal: 'Ground — must be common with the logic supply', aliases: ['GND', 'VOUT-'] }),
    ],
    keywords: ['power supply', '12v', '2a', 'mains', 'adapter', 'solenoid supply'],
    aliases: ['12v supply', '12v power supply', '12v adapter', '12v 2a'],
    metadata: {
      electrical: true,
      mains: true,
      connector: 'barrel jack or screw terminals',
      rail: '12V',
      safetyNote: 'Mains voltage. Enclose the terminals. If you fit the flyback diode, remember it is only for DC — never fit one across an AC solenoid.',
      commonGroundNote: 'Tie this ground to the logic board ground, otherwise the MOSFET gate has no return path.',
    },
  }),
];
