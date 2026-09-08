/** General purpose parts: passives, inputs, prototyping. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const GENERAL: ComponentDefinition[] = [
  def({
    id: 'resistor-220ohm',
    name: '220 Ω resistor (1/4 W)',
    category: 'passive',
    description: '220 Ω, ±5 %, 1/4 W through-hole resistor. The standard LED current limiter from a 5 V logic pin (≈13 mA at a 2.1 V LED).',
    currentRequirements: { typicalMa: 13, maxMa: 20 },
    pins: [
      pin('1', 'other', 'bidirectional', { required: true, aliases: ['A'] }),
      pin('2', 'other', 'bidirectional', { required: true, aliases: ['B'] }),
    ],
    keywords: ['resistor', '220 ohm', 'led resistor', 'current limiting'],
    aliases: ['220r', '220 ohm resistor', 'resistor 220'],
    simulator: { part: 'wokwi-resistor', supported: true, attrs: { value: '220' } },
    metadata: { electrical: true, noSupplyPins: true, resistanceOhm: 220, tolerancePercent: 5, powerRatingW: 0.25, inSeriesWith: 'LED anode from a 5 V pin' },
  }),

  def({
    id: 'resistor-1kohm',
    name: '1 kΩ resistor (1/4 W)',
    category: 'passive',
    description: '1 kΩ, ±5 %, 1/4 W resistor. Useful for LED limiting from 3.3 V logic and as a general-purpose series/base resistor.',
    pins: [
      pin('1', 'other', 'bidirectional', { required: true, aliases: ['A'] }),
      pin('2', 'other', 'bidirectional', { required: true, aliases: ['B'] }),
    ],
    keywords: ['resistor', '1k', '1 kohm', 'current limiting'],
    aliases: ['1k resistor', '1kohm', 'resistor 1k'],
    simulator: { part: 'wokwi-resistor', supported: true, attrs: { value: '1k' } },
    metadata: { electrical: true, noSupplyPins: true, resistanceOhm: 1000, tolerancePercent: 5, powerRatingW: 0.25 },
  }),

  def({
    id: 'resistor-10kohm',
    name: '10 kΩ resistor (1/4 W)',
    category: 'passive',
    description:
      '10 kΩ, ±5 %, 1/4 W resistor. The default pull-up/pull-down value: used with pushbuttons, DHT data lines and as the bottom leg of an LDR voltage divider.',
    pins: [
      pin('1', 'other', 'bidirectional', { required: true, aliases: ['A'] }),
      pin('2', 'other', 'bidirectional', { required: true, aliases: ['B'] }),
    ],
    keywords: ['resistor', '10k', 'pullup', 'pull-up', 'pull-down', 'voltage divider'],
    aliases: ['10k resistor', '10kohm', 'resistor 10k'],
    simulator: { part: 'wokwi-resistor', supported: true, attrs: { value: '10k' } },
    metadata: { electrical: true, noSupplyPins: true, resistanceOhm: 10000, tolerancePercent: 5, powerRatingW: 0.25 },
  }),

  def({
    id: 'capacitor-100nf-ceramic',
    name: '100 nF ceramic decoupling capacitor',
    category: 'passive',
    description: '100 nF (0.1 µF) 50 V ceramic capacitor placed between VCC and GND of every IC to suppress high-frequency supply noise.',
    pins: [
      pin('1', 'power', 'bidirectional', { required: true, aliases: ['+'] }),
      pin('2', 'ground', 'bidirectional', { required: true, aliases: ['-'] }),
    ],
    keywords: ['capacitor', 'decoupling', 'bypass', '100nf', '0.1uf', 'ceramic'],
    aliases: ['100nf capacitor', '0.1uf capacitor', 'decoupling capacitor', 'bypass capacitor'],
    simulator: {
      part: 'wokwi-capacitor',
      supported: true,
      attrs: { value: '100n' },
      notes: 'Two-terminal capacitor; both simulators model its value, not its ESR.',
    },
    metadata: { electrical: true, capacitanceF: 1e-7, voltageRatingV: 50, polarity: 'non-polar' },
  }),

  def({
    id: 'capacitor-1000uf-electrolytic',
    name: '1000 µF electrolytic bulk capacitor (16 V)',
    category: 'passive',
    description:
      'Polarised 1000 µF / 16 V electrolytic used as a bulk reservoir across a motor or servo supply to absorb inrush and stall transients. Observe polarity — reverse voltage destroys it.',
    pins: [
      pin('+', 'power', 'bidirectional', { required: true, aliases: ['POS'] }),
      pin('-', 'ground', 'bidirectional', { required: true, aliases: ['NEG'] }),
    ],
    keywords: ['capacitor', 'electrolytic', 'bulk', '1000uf', 'reservoir', 'smoothing'],
    aliases: ['1000uf capacitor', 'electrolytic capacitor', 'bulk capacitor'],
    simulator: {
      part: 'wokwi-capacitor',
      supported: true,
      attrs: { value: '1000u', voltage: '16' },
      notes:
        'Simulated as a two-terminal capacitor. Polarity is NOT modelled: on the bench the long leg goes to the supply and the striped leg to ground, or the part vents.',
    },
    metadata: { electrical: true, capacitanceF: 0.001, voltageRatingV: 16, polarity: 'polarised' },
  }),

  def({
    id: 'pushbutton-6mm',
    name: '6 mm tactile pushbutton',
    category: 'input_device',
    description:
      'Momentary 4-leg tactile switch. Legs on the same side are internally connected, so use one leg per side. Wire between a GPIO and GND with the internal pull-up enabled (reads LOW when pressed), or between GPIO and VCC with a pull-down.',
    minVoltage: 0,
    maxVoltage: 12,
    currentRequirements: { typicalMa: 0, maxMa: 50 },
    pins: [
      pin('1', 'digital', 'bidirectional', { required: true, aliases: ['A', 'LEG1'] }),
      pin('2', 'digital', 'bidirectional', { required: true, aliases: ['B', 'LEG2'] }),
    ],
    keywords: ['button', 'pushbutton', 'push button', 'switch', 'tactile', 'input', 'key'],
    aliases: ['pushbutton', 'push button', 'tact switch', 'momentary switch', 'button'],
    simulator: { part: 'wokwi-pushbutton', supported: true },
    metadata: { electrical: true, noSupplyPins: true, momentary: true, requiresPullup: true, recommendedDebounceMs: 20, internalLegPairs: 'legs 1-2 and 3-4 are bridged' },
  }),

  def({
    id: 'keypad-4x4-membrane',
    name: '4x4 membrane keypad',
    category: 'input_device',
    description:
      '16-key membrane matrix keypad (1-9, 0, *, #, A-D). Eight pins, not sixteen: the MCU drives the four row lines (R1-R4) low one at a time and reads the four column lines (C1-C4) through its internal pull-ups. A pressed key shorts one row to one column, so the firmware resolves the key from the (row, column) pair.',
    minVoltage: 0,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 0, maxMa: 5 },
    pins: [
      pin('R1', 'digital', 'input', { required: true, signal: 'Row 1 drive (top row)', aliases: ['ROW1', '1'] }),
      pin('R2', 'digital', 'input', { required: true, signal: 'Row 2 drive', aliases: ['ROW2', '2'] }),
      pin('R3', 'digital', 'input', { required: true, signal: 'Row 3 drive', aliases: ['ROW3', '3'] }),
      pin('R4', 'digital', 'input', { required: true, signal: 'Row 4 drive (bottom row)', aliases: ['ROW4', '4'] }),
      pin('C1', 'digital', 'output', { required: true, signal: 'Column 1 sense (left column)', aliases: ['COL1', '5'] }),
      pin('C2', 'digital', 'output', { required: true, signal: 'Column 2 sense', aliases: ['COL2', '6'] }),
      pin('C3', 'digital', 'output', { required: true, signal: 'Column 3 sense', aliases: ['COL3', '7'] }),
      pin('C4', 'digital', 'output', { required: true, signal: 'Column 4 sense (right column)', aliases: ['COL4', '8'] }),
    ],
    keywords: ['keypad', '4x4 keypad', 'matrix keypad', 'membrane keypad', 'keyboard', 'pin entry', 'code entry', 'keys', 'hex keypad'],
    aliases: ['4x4 keypad', '4x4 matrix keypad', 'matrix keypad', 'membrane keypad', 'keypad', '16 key keypad'],
    simulator: {
      part: 'wokwi-membrane-keypad',
      supported: true,
      notes: 'Wokwi/Velxio pins: R1-R4 (rows, driven low by the MCU) and C1-C4 (columns, read with pull-ups).',
    },
    metadata: {
      electrical: true,
      noSupplyPins: true,
      requiresPullup: true,
      recommendedDebounceMs: 20,
      scanStyle: 'row-drive-column-sense',
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
    },
  }),

  def({
    id: 'potentiometer-10k',
    name: '10 kΩ rotary potentiometer',
    category: 'input_device',
    description: 'Three-terminal 10 kΩ linear-taper rotary potentiometer. Connect the two outer terminals to VCC and GND and read the wiper with an ADC pin for an analog input.',
    minVoltage: 0,
    maxVoltage: 5,
    pins: [
      pin('A', 'power', 'bidirectional', { required: true, signal: 'Counter-clockwise end to VCC', aliases: ['1', 'CCW'] }),
      pin('WIPER', 'analog', 'output', { required: true, signal: 'Center tap to an ADC pin', aliases: ['2', 'W', 'S', 'SIG'] }),
      pin('B', 'ground', 'bidirectional', { required: true, signal: 'Clockwise end to GND', aliases: ['3', 'CW'] }),
    ],
    keywords: ['potentiometer', 'pot', 'knob', 'analog input', 'trimmer', 'throttle', 'variable resistor'],
    aliases: ['potentiometer', 'pot', '10k pot', 'rotary potentiometer'],
    simulator: { part: 'wokwi-potentiometer', supported: true },
    metadata: { electrical: true, resistanceOhm: 10000, taper: 'linear', requiresAdc: true },
  }),

  def({
    id: 'breadboard-830',
    name: '830-point solderless breadboard',
    category: 'prototyping',
    description:
      'Full-size solderless breadboard: 63 columns of 5-point tie rows split by a center DIP channel, plus two power rails per side. This is the wiring medium, not an electrical component — it does not appear in the connection graph.',
    pins: [
      pin('BUS_POSITIVE', 'power', 'power', { required: false, signal: 'Power rail (+)', aliases: ['+', 'RED_RAIL'] }),
      pin('BUS_NEGATIVE', 'ground', 'ground', { required: false, signal: 'Ground rail (-)', aliases: ['-', 'BLUE_RAIL'] }),
      pin('TIE_POINTS', 'other', 'bidirectional', { required: false, description: '830 solderless tie points in 5-point rows' }),
    ],
    keywords: ['breadboard', 'protoboard', 'prototyping', 'solderless'],
    aliases: ['breadboard', 'protoboard', '830 breadboard'],
    simulator: { part: 'wokwi-breadboard', supported: true },
    metadata: { electrical: false, participatesInWiring: false, tiePoints: 830, columns: 63, powerRails: 4 },
  }),

  def({
    id: 'jumper-wires-kit',
    name: 'Jumper wire kit (male-male / male-female)',
    category: 'prototyping',
    description:
      'Assorted 20 cm jumper wires for breadboard connections. Consumable wiring medium — not an electrical component and not represented in the connection graph.',
    pins: [],
    keywords: ['jumper', 'wires', 'jumper wires', 'dupont', 'cables', 'connections'],
    aliases: ['jumper wires', 'dupont wires', 'wires', 'cables'],
    metadata: { electrical: false, participatesInWiring: false, count: 65, gaugeAwg: 24, currentRatingMa: 1000 },
  }),
];
