/** Actuator seed entries. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const ACTUATORS: ComponentDefinition[] = [
  def({
    id: 'led-5mm',
    name: '5 mm LED',
    category: 'actuator',
    description:
      'Standard 5 mm through-hole LED. Forward voltage ~1.8–2.2 V (red/amber) or ~3.0–3.4 V (blue/white) at 20 mA. Always driven through a current-limiting series resistor: 220 Ω from a 5 V pin, 100–150 Ω from a 3.3 V pin.',
    voltage: 2.1,
    minVoltage: 1.8,
    maxVoltage: 3.4,
    currentRequirements: { typicalMa: 10, maxMa: 20 },
    pins: [
      pin('A', 'digital', 'input', { required: true, signal: 'Anode — long leg, to the MCU pin through a resistor', aliases: ['+', 'ANODE', 'LONG'] }),
      pin('C', 'ground', 'input', { required: true, signal: 'Cathode — short leg, to GND', aliases: ['-', 'CATHODE', 'SHORT'] }),
    ],
    keywords: ['led', 'light', 'indicator', 'lamp'],
    aliases: ['led', '5mm led', 'light emitting diode', 'indicator led'],
    simulator: { part: 'wokwi-led', supported: true },
    metadata: { electrical: true, polarity: 'A=anode, C=cathode', requiresSeriesResistor: true, seriesResistorOhmAt5v: 220, seriesResistorOhmAt3v3: 100 },
  }),

  def({
    id: 'rgb-led-common-cathode',
    name: 'RGB LED (common cathode)',
    category: 'actuator',
    description:
      'Four-lead RGB LED sharing a common cathode. Each colour channel needs its own series resistor (220 Ω at 5 V) and its own PWM-capable MCU pin for mixing.',
    voltage: 2.2,
    minVoltage: 1.8,
    maxVoltage: 3.4,
    currentRequirements: { typicalMa: 20, maxMa: 60, note: 'Up to 20 mA per channel.' },
    pins: [
      pin('R', 'pwm', 'input', { required: true, signal: 'Red anode (through a resistor)', aliases: ['RED'] }),
      pin('G', 'pwm', 'input', { required: true, signal: 'Green anode (through a resistor)', aliases: ['GREEN'] }),
      pin('B', 'pwm', 'input', { required: true, signal: 'Blue anode (through a resistor)', aliases: ['BLUE'] }),
      pin('CATHODE', 'ground', 'input', { required: true, signal: 'Common cathode to GND', aliases: ['-', 'GND', 'COMMON'] }),
    ],
    keywords: ['rgb led', 'color led', 'colour led', 'mood light', 'status light'],
    aliases: ['rgb led', 'rgb light', 'common cathode rgb led'],
    simulator: { supported: false, notes: 'Represent as three LED channels.' },
    metadata: { electrical: true, requiresSeriesResistor: true, seriesResistorOhmAt5v: 220, pwmRequired: true },
  }),

  def({
    id: 'buzzer-active-5v',
    name: 'Active buzzer (5 V)',
    category: 'actuator',
    description:
      'Self-oscillating piezo buzzer: drive the + terminal HIGH/LOW for on/off — no PWM tone generation required. ~30 mA at 5 V, so it can be driven directly from a 5 V logic pin but should use a transistor on 3.3 V boards.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 6,
    currentRequirements: { typicalMa: 30, maxMa: 40 },
    pins: [
      pin('+', 'digital', 'input', { required: true, signal: 'Positive drive input', aliases: ['S', 'SIG', 'I/O', 'POS'] }),
      pin('-', 'ground', 'input', { required: true, signal: 'Negative to GND', aliases: ['GND', 'NEG'] }),
    ],
    keywords: ['buzzer', 'alarm', 'beep', 'sound', 'speaker', 'audio alert'],
    aliases: ['buzzer', 'active buzzer', 'piezo buzzer', 'beeper'],
    simulator: { part: 'wokwi-buzzer', supported: true, notes: 'Simulated as a passive buzzer — tone generation differs.' },
    metadata: { electrical: true, active: true, oscillationFrequencyHz: 2300 },
  }),

  def({
    id: 'buzzer-passive',
    name: 'Passive buzzer / piezo element',
    category: 'actuator',
    description:
      'Non-oscillating piezo element: the MCU must generate the tone with PWM/timer output (typically 2–4 kHz). Connect the drive pin through the element to GND.',
    minVoltage: 1.5,
    maxVoltage: 15,
    currentRequirements: { typicalMa: 20, maxMa: 30 },
    pins: [
      pin('+', 'pwm', 'input', { required: true, signal: 'PWM tone input', aliases: ['S', 'SIG'] }),
      pin('-', 'ground', 'input', { required: true, aliases: ['GND'] }),
    ],
    libraryRequirements: [{ name: 'tone()', import: 'Arduino.h', manager: 'arduino', purpose: 'Generates the square wave', builtIn: true }],
    keywords: ['buzzer', 'passive buzzer', 'piezo', 'tone', 'melody', 'sound'],
    aliases: ['passive buzzer', 'piezo element', 'piezo buzzer'],
    simulator: { part: 'wokwi-buzzer', supported: true },
    metadata: { electrical: true, active: false, requiresPwm: true },
  }),

  def({
    id: 'relay-module-5v-1ch',
    name: '5 V single-channel relay module (opto-isolated)',
    category: 'actuator',
    description:
      'Opto-isolated relay module switching up to 250 VAC / 30 VDC at 10 A. IN is typically active LOW and needs ~10 mA at 5 V. Provides COM / NO / NC screw terminals for the load side, electrically isolated from the MCU side.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 70, maxMa: 90, note: 'Coil + opto current; not available from a 3.3 V MCU pin.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'DC+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'DC-'] }),
      pin('IN', 'digital', 'input', { required: true, signal: 'Control input, active LOW on most modules', aliases: ['SIG', 'S'] }),
      pin('COM', 'other', 'bidirectional', { required: true, signal: 'Load common terminal', aliases: ['C'] }),
      pin('NO', 'other', 'bidirectional', { required: true, signal: 'Normally open load terminal', aliases: ['N/O'] }),
      pin('NC', 'other', 'bidirectional', { required: false, signal: 'Normally closed load terminal', aliases: ['N/C'] }),
    ],
    keywords: ['relay', 'switch', 'mains', 'high current', 'pump', 'lamp', 'contactor'],
    aliases: ['relay', 'relay module', '5v relay', '1 channel relay'],
    simulator: { supported: false, notes: 'Represent as a digital load with a switch contact.' },
    metadata: {
      electrical: true,
      activeLevel: 'low',
      contactRating: '250 VAC / 30 VDC, 10 A',
      isolation: 'opto-coupler',
      inPinLogicNote: 'A 3.3 V MCU cannot pull IN low enough on many opto modules — use a 5 V supply for VCC and verify the trigger level, or add a transistor.',
    },
  }),

  def({
    id: 'neopixel-ws2812b-strip',
    name: 'WS2812B addressable LED strip (NeoPixel)',
    category: 'actuator',
    description:
      'Single-wire 800 kHz addressable RGB LEDs, 5 V supply, up to ~60 mA per LED at full white. Data in is a strict timing protocol; level shift from a 3.3 V MCU and inject power at both ends for long runs.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 20, maxMa: 60, note: 'Per LED at full white; budget 60 mA x LED count.' },
    pins: [
      pin('DIN', 'digital', 'input', { required: true, signal: '800 kHz data in', aliases: ['DI', 'DATA', 'IN'] }),
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+5V', '+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('DOUT', 'digital', 'output', { required: false, signal: 'Data out to the next segment', aliases: ['DO'] }),
    ],
    libraryRequirements: [
      { name: 'Adafruit NeoPixel', import: 'Adafruit_NeoPixel.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_NeoPixel', purpose: 'WS2812B timing and colour control' },
    ],
    keywords: ['neopixel', 'ws2812', 'ws2812b', 'addressable led', 'led strip', 'rgb strip'],
    aliases: ['neopixel', 'ws2812b', 'led strip', 'addressable leds'],
    simulator: { part: 'wokwi-neopixel', supported: false, notes: 'Part id unverified — confirm before use.' },
    metadata: { electrical: true, levelShiftFrom3v3: true, protocol: 'ws2812b-single-wire', ledCount: 'per segment' },
  }),
];
