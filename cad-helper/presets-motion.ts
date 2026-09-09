/**
 * cad-helper/presets-motion.ts
 *
 * Authored CAD specs for the motion / power-stage half of the registry:
 * motors, fans, propellers, pumps, drivers and PWM expanders.
 *
 * Every pin name here is written to match the component-registry entry with
 * the same `id` exactly — `auditCatalogCadLink()` fails the build-time check if
 * an anchor drifts from the electrical truth, because a wrong anchor produces
 * confidently-wrong 3D wiring.
 *
 * Geometry is real-world millimetre data from vendor drawings where the part
 * has a standard footprint (40 mm fan, 80 mm fan, SG90, NEMA 17, Pololu
 * carriers, Adafruit PCA9685) and a faithful envelope otherwise. None of these
 * are reviewed manufacturer CAD assemblies, so none of them declare
 * `visualAsset`: the studio labels them as parametric.
 */

import type { CadComponentSpec } from './types';

export const MOTION_PRESETS: Record<string, CadComponentSpec> = {
  'servo-motor-sg90': {
    id: 'servo-motor-sg90',
    name: 'SG90 micro servo',
    category: 'actuator',
    description:
      '9 g hobby servo: 23 x 12.2 x 29 mm body with mounting tabs, output spline on top and a 3-wire lead. Position is commanded by a 50 Hz pulse between 0.5 and 2.5 ms.',
    voltage: 5.0,
    minVoltage: 4.8,
    maxVoltage: 6.0,
    currentMa: 100,
    dimensions: { widthMm: 22.8, lengthMm: 12.2, heightMm: 22.5 },
    bodyColor: '#1e6fd9',
    pins: [
      { name: 'SIGNAL', pinNumber: 1, role: 'pwm', signal: '50 Hz position PWM (0.5-2.5 ms)', xMm: -13.5, yMm: 6.0, zMm: 2.54, direction: 'left', aliases: ['S', 'SIG', 'PWM', 'ORANGE'], required: true },
      { name: 'VCC', pinNumber: 2, role: 'power', signal: '4.8-6 V servo supply', xMm: -13.5, yMm: 6.0, zMm: 0, direction: 'left', aliases: ['+', 'RED'], required: true },
      { name: 'GND', pinNumber: 3, role: 'ground', signal: 'Ground', xMm: -13.5, yMm: 6.0, zMm: -2.54, direction: 'left', aliases: ['-', 'BROWN', 'BLACK'], required: true },
    ],
    features: [
      { name: 'gear_case', type: 'box', dimensions: [22.8, 6.0, 12.2], position: [0, 19.5, 0], color: '#2563eb' },
      { name: 'mounting_tabs', type: 'box', dimensions: [32.2, 2.5, 12.2], position: [0, 16.0, 0], color: '#1e6fd9' },
      { name: 'output_spline', type: 'cylinder', dimensions: [2.4, 4.0, 0], position: [-5.9, 24.5, 0], color: '#f8fafc' },
      { name: 'servo_horn', type: 'box', dimensions: [20.0, 1.6, 4.0], position: [0, 26.5, 0], color: '#e2e8f0' },
      { name: 'rear_bearing_boss', type: 'cylinder', dimensions: [2.5, 2.0, 0], position: [5.9, 23.5, 0], color: '#1d4ed8' },
    ],
    protocols: ['pwm'],
    keywords: ['servo', 'sg90', 'micro servo', 'position', 'steering'],
    aliases: ['servo', 'sg90', 'micro servo', 'hobby servo', '9g servo'],
    libraryRequirements: [{ name: 'Servo', import: 'Servo.h', manager: 'arduino', purpose: 'Hardware timer servo PWM' }],
  },

  'dc-motor-generic-6v': {
    id: 'dc-motor-generic-6v',
    name: 'DC gear motor (6 V)',
    category: 'actuator',
    description:
      'Yellow TT-style plastic gearbox motor with a can motor mounted on the side and a dual output shaft. Two solder tabs, no logic interface — it must be wired to an H-bridge output pair.',
    voltage: 6.0,
    minVoltage: 3.0,
    maxVoltage: 12.0,
    currentMa: 250,
    dimensions: { widthMm: 70.0, lengthMm: 22.5, heightMm: 18.0 },
    bodyColor: '#eab308',
    pins: [
      { name: 'A', pinNumber: 1, role: 'power', signal: 'Motor terminal A', xMm: 30.0, yMm: 14.0, zMm: 4.0, direction: 'right', aliases: ['+', 'M+', 'RED'], required: true },
      { name: 'B', pinNumber: 2, role: 'power', signal: 'Motor terminal B', xMm: 30.0, yMm: 14.0, zMm: -4.0, direction: 'right', aliases: ['-', 'M-', 'BLACK'], required: true },
    ],
    features: [
      { name: 'gearbox_housing', type: 'box', dimensions: [42.0, 18.0, 22.5], position: [-10.0, 9.0, 0], color: '#facc15' },
      { name: 'motor_can', type: 'cylinder', dimensions: [11.0, 25.0, 0], position: [22.0, 9.0, 0], color: '#94a3b8', rotation: [0, 0, 90] },
      { name: 'output_shaft_left', type: 'cylinder', dimensions: [2.7, 10.0, 0], position: [-10.0, 9.0, 16.0], color: '#cbd5e1', rotation: [90, 0, 0] },
      { name: 'output_shaft_right', type: 'cylinder', dimensions: [2.7, 10.0, 0], position: [-10.0, 9.0, -16.0], color: '#cbd5e1', rotation: [90, 0, 0] },
    ],
    protocols: [],
    keywords: ['dc motor', 'gear motor', 'tt motor', 'wheel', 'drive'],
    aliases: ['dc motor', 'motor', 'tt motor', 'bo motor', 'geared dc motor'],
  },

  'n20-gear-motor-encoder': {
    id: 'n20-gear-motor-encoder',
    name: 'N20 micro gear motor with magnetic encoder',
    category: 'actuator',
    description:
      'N20 metal gearbox motor, 12 x 10 mm body with a 3 mm D-shaft, plus a rear magnetic encoder PCB bringing out a 6-wire lead: two motor terminals and a 4-wire quadrature encoder.',
    voltage: 6.0,
    minVoltage: 3.0,
    maxVoltage: 12.0,
    currentMa: 120,
    dimensions: { widthMm: 12.0, lengthMm: 45.0, heightMm: 10.0 },
    bodyColor: '#64748b',
    pins: [
      { name: 'M1', pinNumber: 1, role: 'power', signal: 'Motor terminal 1', xMm: -6.0, yMm: 5.0, zMm: -20.0, direction: 'back', aliases: ['A', 'M+'], required: true },
      { name: 'M2', pinNumber: 2, role: 'power', signal: 'Motor terminal 2', xMm: -3.6, yMm: 5.0, zMm: -20.0, direction: 'back', aliases: ['B', 'M-'], required: true },
      { name: 'ENC_VCC', pinNumber: 3, role: 'power', signal: 'Encoder supply 3.3-5 V', xMm: -1.2, yMm: 5.0, zMm: -20.0, direction: 'back', aliases: ['VCC', 'C1_VCC'], required: true },
      { name: 'ENC_GND', pinNumber: 4, role: 'ground', signal: 'Encoder ground', xMm: 1.2, yMm: 5.0, zMm: -20.0, direction: 'back', aliases: ['GND'], required: true },
      { name: 'ENC_A', pinNumber: 5, role: 'digital', signal: 'Quadrature channel A', xMm: 3.6, yMm: 5.0, zMm: -20.0, direction: 'back', aliases: ['C1', 'A'], required: true },
      { name: 'ENC_B', pinNumber: 6, role: 'digital', signal: 'Quadrature channel B', xMm: 6.0, yMm: 5.0, zMm: -20.0, direction: 'back', aliases: ['C2', 'B'], required: true },
    ],
    features: [
      { name: 'gearbox', type: 'box', dimensions: [12.0, 10.0, 10.0], position: [0, 5.0, 15.0], color: '#94a3b8' },
      { name: 'motor_can', type: 'box', dimensions: [12.0, 10.0, 15.0], position: [0, 5.0, 0], color: '#475569' },
      { name: 'encoder_pcb', type: 'box', dimensions: [12.0, 1.2, 12.0], position: [0, 5.0, -13.0], color: '#0f172a' },
      { name: 'encoder_magnet', type: 'cylinder', dimensions: [3.0, 2.0, 0], position: [0, 5.0, -8.0], color: '#111827' },
      { name: 'output_shaft', type: 'cylinder', dimensions: [1.5, 10.0, 0], position: [0, 5.0, 25.0], color: '#cbd5e1', rotation: [90, 0, 0] },
    ],
    protocols: ['gpio', 'quadrature'],
    keywords: ['n20', 'gear motor', 'encoder', 'quadrature', 'odometry'],
    aliases: ['n20 motor', 'micro gear motor', 'encoder motor'],
  },

  'fan-5v-40mm': {
    id: 'fan-5v-40mm',
    name: '40 mm 5 V axial cooling fan (2-wire)',
    category: 'actuator',
    description:
      'Standard 40 x 40 x 10 mm axial fan: square frame with four M3 corner holes, a seven-blade impeller and a hub carrying the motor. Two wires only, so speed control means switching the ground side.',
    voltage: 5.0,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentMa: 120,
    dimensions: { widthMm: 40.0, lengthMm: 40.0, heightMm: 10.0 },
    bodyColor: '#111827',
    pins: [
      { name: 'VCC', pinNumber: 1, role: 'power', signal: 'Fan supply +5 V', xMm: 20.0, yMm: 5.0, zMm: 2.0, direction: 'right', aliases: ['+', 'RED', '5V'], required: true },
      { name: 'GND', pinNumber: 2, role: 'ground', signal: 'Fan return (switched side)', xMm: 20.0, yMm: 5.0, zMm: -2.0, direction: 'right', aliases: ['-', 'BLACK'], required: true },
    ],
    features: [
      { name: 'frame', type: 'box', dimensions: [40.0, 10.0, 40.0], position: [0, 5.0, 0], color: '#1f2937' },
      { name: 'hub', type: 'cylinder', dimensions: [8.0, 10.0, 0], position: [0, 5.0, 0], color: '#0f172a' },
      { name: 'blade_ring', type: 'cylinder', dimensions: [18.5, 6.0, 0], position: [0, 5.0, 0], color: '#374151' },
      { name: 'mount_hole_a', type: 'cylinder', dimensions: [1.6, 10.0, 0], position: [16.0, 5.0, 16.0], color: '#0b0f16' },
      { name: 'mount_hole_b', type: 'cylinder', dimensions: [1.6, 10.0, 0], position: [-16.0, 5.0, 16.0], color: '#0b0f16' },
      { name: 'mount_hole_c', type: 'cylinder', dimensions: [1.6, 10.0, 0], position: [16.0, 5.0, -16.0], color: '#0b0f16' },
      { name: 'mount_hole_d', type: 'cylinder', dimensions: [1.6, 10.0, 0], position: [-16.0, 5.0, -16.0], color: '#0b0f16' },
    ],
    protocols: [],
    keywords: ['fan', 'cooling fan', 'axial fan', '40mm', 'airflow'],
    aliases: ['fan', '5v fan', '40mm fan', 'cooling fan'],
  },

  'fan-12v-4pin-pwm': {
    id: 'fan-12v-4pin-pwm',
    name: '12 V 4-wire PWM fan (80 mm, tach)',
    category: 'actuator',
    description:
      '80 x 80 x 25 mm four-wire fan built to the Intel PWM specification: permanent 12 V, a 25 kHz open-drain control input and an open-collector tachometer giving two pulses per revolution.',
    voltage: 12.0,
    minVoltage: 10.8,
    maxVoltage: 13.2,
    currentMa: 200,
    dimensions: { widthMm: 80.0, lengthMm: 80.0, heightMm: 25.0 },
    bodyColor: '#0f172a',
    pins: [
      { name: 'GND', pinNumber: 1, role: 'ground', signal: 'Ground (black)', xMm: 40.0, yMm: 12.5, zMm: 3.81, direction: 'right', aliases: ['-', 'BLACK'], required: true },
      { name: '12V', pinNumber: 2, role: 'power', signal: 'Continuous 12 V supply (yellow)', xMm: 40.0, yMm: 12.5, zMm: 1.27, direction: 'right', aliases: ['VCC', '+12V', 'YELLOW'], required: true },
      { name: 'TACH', pinNumber: 3, role: 'digital', signal: 'Open-collector tach, 2 pulses/rev (green)', xMm: 40.0, yMm: 12.5, zMm: -1.27, direction: 'right', aliases: ['SENSE', 'RPM', 'GREEN'], required: false },
      { name: 'PWM', pinNumber: 4, role: 'pwm', signal: '25 kHz open-drain speed control (blue)', xMm: 40.0, yMm: 12.5, zMm: -3.81, direction: 'right', aliases: ['CONTROL', 'BLUE'], required: false },
    ],
    features: [
      { name: 'frame', type: 'box', dimensions: [80.0, 25.0, 80.0], position: [0, 12.5, 0], color: '#111827' },
      { name: 'hub', type: 'cylinder', dimensions: [20.0, 25.0, 0], position: [0, 12.5, 0], color: '#0b0f16' },
      { name: 'blade_ring', type: 'cylinder', dimensions: [38.0, 16.0, 0], position: [0, 12.5, 0], color: '#334155' },
      { name: 'control_header', type: 'header_block', dimensions: [10.16, 4.0, 4.0], position: [36.0, 12.5, 0], color: '#1c1917' },
    ],
    protocols: ['pwm', 'gpio'],
    keywords: ['fan', 'pwm fan', '4-pin fan', 'tachometer', 'rpm', '12v'],
    aliases: ['pwm fan', '4 wire fan', '12v fan'],
  },

  'propeller-5045-tri-blade': {
    id: 'propeller-5045-tri-blade',
    name: '5045 tri-blade propeller (5 in, 4.5 in pitch)',
    category: 'other',
    description:
      'Purely mechanical part: 127 mm diameter three-blade propeller with a 5 mm bore hub. Included in CAD so a drone assembly can be laid out and clearance-checked; it has no pin anchors.',
    voltage: 0,
    currentMa: 0,
    dimensions: { widthMm: 127.0, lengthMm: 127.0, heightMm: 8.0 },
    bodyColor: '#0f172a',
    pins: [],
    features: [
      { name: 'hub', type: 'cylinder', dimensions: [7.0, 8.0, 0], position: [0, 4.0, 0], color: '#1f2937' },
      { name: 'bore', type: 'cylinder', dimensions: [2.5, 8.0, 0], position: [0, 4.0, 0], color: '#020617' },
      { name: 'blade_a', type: 'box', dimensions: [58.0, 2.0, 11.0], position: [29.0, 4.0, 0], color: '#111827', rotation: [0, 0, 8] },
      { name: 'blade_b', type: 'box', dimensions: [58.0, 2.0, 11.0], position: [-14.5, 4.0, 25.1], color: '#111827', rotation: [0, 120, 8] },
      { name: 'blade_c', type: 'box', dimensions: [58.0, 2.0, 11.0], position: [-14.5, 4.0, -25.1], color: '#111827', rotation: [0, 240, 8] },
    ],
    protocols: [],
    keywords: ['propeller', 'prop', '5045', 'tri-blade', 'drone', 'thrust'],
    aliases: ['propeller', 'prop', '5045 prop', 'drone propeller'],
  },

  'bldc-motor-2205-2300kv': {
    id: 'bldc-motor-2205-2300kv',
    name: '2205 brushless outrunner (2300 KV)',
    category: 'actuator',
    description:
      'Outrunner brushless motor: 27.9 mm bell over a 22 mm stator, M3 16 x 16 mm mounting pattern and a 5 mm prop shaft. Three phase wires, no polarity — swapping any two reverses rotation.',
    voltage: 14.8,
    minVoltage: 7.4,
    maxVoltage: 16.8,
    currentMa: 8000,
    dimensions: { widthMm: 27.9, lengthMm: 27.9, heightMm: 32.0 },
    bodyColor: '#dc2626',
    pins: [
      { name: 'PHASE_A', pinNumber: 1, role: 'power', signal: 'Motor phase A', xMm: -4.0, yMm: 2.0, zMm: -14.0, direction: 'back', aliases: ['A', 'U'], required: true },
      { name: 'PHASE_B', pinNumber: 2, role: 'power', signal: 'Motor phase B', xMm: 0, yMm: 2.0, zMm: -14.0, direction: 'back', aliases: ['B', 'V'], required: true },
      { name: 'PHASE_C', pinNumber: 3, role: 'power', signal: 'Motor phase C', xMm: 4.0, yMm: 2.0, zMm: -14.0, direction: 'back', aliases: ['C', 'W'], required: true },
    ],
    features: [
      { name: 'base_plate', type: 'cylinder', dimensions: [13.9, 3.0, 0], position: [0, 1.5, 0], color: '#334155' },
      { name: 'bell', type: 'cylinder', dimensions: [13.9, 16.0, 0], position: [0, 12.0, 0], color: '#ef4444' },
      { name: 'prop_shaft', type: 'cylinder', dimensions: [2.5, 12.0, 0], position: [0, 26.0, 0], color: '#e2e8f0' },
      { name: 'prop_nut', type: 'cylinder', dimensions: [4.0, 4.0, 0], position: [0, 22.0, 0], color: '#f59e0b' },
    ],
    protocols: [],
    keywords: ['brushless', 'bldc', 'outrunner', '2205', 'drone'],
    aliases: ['brushless motor', '2205 motor', 'drone motor'],
  },

  'esc-30a-bldc': {
    id: 'esc-30a-bldc',
    name: '30 A brushless ESC (with 5 V/2 A BEC)',
    category: 'driver',
    description:
      'Shrink-wrapped 30 A ESC brick: battery leads at one end, three motor phase leads at the other and a 3-wire servo cable for throttle plus BEC output.',
    voltage: 11.1,
    minVoltage: 7.4,
    maxVoltage: 16.8,
    currentMa: 15000,
    dimensions: { widthMm: 25.0, lengthMm: 52.0, heightMm: 11.0 },
    bodyColor: '#111827',
    pins: [
      { name: 'SIGNAL', pinNumber: 1, role: 'pwm', signal: 'Throttle pulse 1000-2000 us', xMm: -12.5, yMm: 5.5, zMm: 28.0, direction: 'front', aliases: ['SIG', 'THROTTLE', 'WHITE'], required: true },
      { name: 'BEC_5V', pinNumber: 2, role: 'power', signal: '5 V / 2 A BEC output', xMm: -10.0, yMm: 5.5, zMm: 28.0, direction: 'front', aliases: ['5V', 'BEC', 'RED'], required: false },
      { name: 'GND', pinNumber: 3, role: 'ground', signal: 'Signal / power ground', xMm: -7.5, yMm: 5.5, zMm: 28.0, direction: 'front', aliases: ['-', 'BLACK'], required: true },
      { name: 'BAT+', pinNumber: 4, role: 'power', signal: 'Battery positive (2-4S)', xMm: -6.0, yMm: 5.5, zMm: -28.0, direction: 'back', aliases: ['VBAT', 'B+'], required: true },
      { name: 'BAT-', pinNumber: 5, role: 'ground', signal: 'Battery negative', xMm: 6.0, yMm: 5.5, zMm: -28.0, direction: 'back', aliases: ['B-'], required: true },
      { name: 'PHASE_A', pinNumber: 6, role: 'power', signal: 'Motor phase A', xMm: -8.0, yMm: 5.5, zMm: 28.0, direction: 'front', aliases: ['A', 'M1'], required: true },
      { name: 'PHASE_B', pinNumber: 7, role: 'power', signal: 'Motor phase B', xMm: 0, yMm: 5.5, zMm: 28.0, direction: 'front', aliases: ['B', 'M2'], required: true },
      { name: 'PHASE_C', pinNumber: 8, role: 'power', signal: 'Motor phase C', xMm: 8.0, yMm: 5.5, zMm: 28.0, direction: 'front', aliases: ['C', 'M3'], required: true },
    ],
    features: [
      { name: 'esc_pcb', type: 'box', dimensions: [25.0, 3.0, 52.0], position: [0, 1.5, 0], color: '#0f172a' },
      { name: 'mosfet_bank_a', type: 'box', dimensions: [22.0, 3.0, 8.0], position: [0, 4.5, 10.0], color: '#1f2937' },
      { name: 'mosfet_bank_b', type: 'box', dimensions: [22.0, 3.0, 8.0], position: [0, 4.5, -6.0], color: '#1f2937' },
      { name: 'capacitor', type: 'cylinder', dimensions: [5.0, 12.0, 0], position: [0, 9.0, -18.0], color: '#111827' },
      { name: 'heat_shrink', type: 'box', dimensions: [25.4, 11.0, 52.4], position: [0, 5.5, 0], color: '#0b0f16' },
    ],
    protocols: ['pwm'],
    keywords: ['esc', 'speed controller', 'brushless', '30a', 'drone'],
    aliases: ['esc', '30a esc', 'brushless esc'],
    libraryRequirements: [{ name: 'Servo', import: 'Servo.h', manager: 'arduino', purpose: 'Throttle pulse generation' }],
  },

  'bts7960-motor-driver': {
    id: 'bts7960-motor-driver',
    name: 'BTS7960 (IBT-2) high-current half-bridge pair',
    category: 'driver',
    description:
      'IBT-2 module: two BTS7960 half-bridge packages on a heavy copper board with a large aluminium heatsink, four screw terminals for battery and motor, and an 8-pin logic header.',
    voltage: 5.0,
    minVoltage: 5.0,
    maxVoltage: 27.0,
    currentMa: 10000,
    dimensions: { widthMm: 50.0, lengthMm: 50.0, heightMm: 1.6 },
    bodyColor: '#b91c1c',
    pins: [
      { name: 'RPWM', pinNumber: 1, role: 'pwm', signal: 'Forward PWM input', xMm: -8.89, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['R_PWM'], required: true },
      { name: 'LPWM', pinNumber: 2, role: 'pwm', signal: 'Reverse PWM input', xMm: -6.35, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['L_PWM'], required: true },
      { name: 'R_EN', pinNumber: 3, role: 'control', signal: 'Forward half-bridge enable', xMm: -3.81, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['REN'], required: true },
      { name: 'L_EN', pinNumber: 4, role: 'control', signal: 'Reverse half-bridge enable', xMm: -1.27, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['LEN'], required: true },
      { name: 'R_IS', pinNumber: 5, role: 'analog', signal: 'Forward current sense', xMm: 1.27, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['RIS'], required: false },
      { name: 'L_IS', pinNumber: 6, role: 'analog', signal: 'Reverse current sense', xMm: 3.81, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['LIS'], required: false },
      { name: 'VCC', pinNumber: 7, role: 'power', signal: 'Logic supply 3.3-5 V', xMm: 6.35, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['5V'], required: true },
      { name: 'GND', pinNumber: 8, role: 'ground', signal: 'Logic ground', xMm: 8.89, yMm: 8.0, zMm: 22.0, direction: 'up', aliases: ['-'], required: true },
      { name: 'B+', pinNumber: 9, role: 'power', signal: 'Battery positive 6-27 V', xMm: -18.0, yMm: 9.0, zMm: -20.0, direction: 'up', aliases: ['VM', 'VBAT'], required: true },
      { name: 'B-', pinNumber: 10, role: 'ground', signal: 'Battery negative', xMm: -6.0, yMm: 9.0, zMm: -20.0, direction: 'up', aliases: ['PGND'], required: true },
      { name: 'M+', pinNumber: 11, role: 'power', signal: 'Motor output +', xMm: 6.0, yMm: 9.0, zMm: -20.0, direction: 'up', aliases: ['MOTOR+'], required: true },
      { name: 'M-', pinNumber: 12, role: 'power', signal: 'Motor output -', xMm: 18.0, yMm: 9.0, zMm: -20.0, direction: 'up', aliases: ['MOTOR-'], required: true },
    ],
    features: [
      { name: 'heatsink', type: 'heatsink', dimensions: [44.0, 26.0, 20.0], position: [0, 12.0, 4.0], color: '#475569' },
      { name: 'bts7960_a', type: 'box', dimensions: [15.0, 4.5, 10.0], position: [-11.0, 3.8, -4.0], color: '#111827' },
      { name: 'bts7960_b', type: 'box', dimensions: [15.0, 4.5, 10.0], position: [11.0, 3.8, -4.0], color: '#111827' },
      { name: 'battery_terminal', type: 'screw_terminal', dimensions: [22.0, 11.0, 9.0], position: [-12.0, 5.5, -20.0], color: '#166534' },
      { name: 'motor_terminal', type: 'screw_terminal', dimensions: [22.0, 11.0, 9.0], position: [12.0, 5.5, -20.0], color: '#166534' },
      { name: 'logic_header', type: 'header_block', dimensions: [20.32, 2.5, 2.5], position: [0, 2.5, 22.0], color: '#0f172a' },
    ],
    protocols: ['pwm', 'gpio', 'analog'],
    keywords: ['bts7960', 'ibt-2', 'high current', 'motor driver', 'h-bridge'],
    aliases: ['bts7960', 'ibt-2', 'ibt2', 'high current motor driver'],
  },

  'drv8833-motor-driver': {
    id: 'drv8833-motor-driver',
    name: 'DRV8833 dual motor driver carrier',
    category: 'driver',
    description:
      'Small Pololu-style carrier, 20.3 x 12.7 mm, with the DRV8833 QFN in the centre and two 0.1 in header rows: control inputs on one edge, motor and power terminals on the other.',
    voltage: 3.3,
    minVoltage: 2.7,
    maxVoltage: 10.8,
    currentMa: 400,
    dimensions: { widthMm: 20.3, lengthMm: 12.7, heightMm: 1.6 },
    bodyColor: '#0f172a',
    pins: [
      { name: 'VIN', pinNumber: 1, role: 'power', signal: 'Motor supply 2.7-10.8 V', xMm: -7.62, yMm: 6.0, zMm: 5.0, direction: 'up', aliases: ['VM', 'VMOT'], required: true },
      { name: 'GND', pinNumber: 2, role: 'ground', signal: 'Common ground', xMm: -5.08, yMm: 6.0, zMm: 5.0, direction: 'up', aliases: ['-'], required: true },
      { name: 'AOUT1', pinNumber: 3, role: 'power', signal: 'Channel A output 1', xMm: -2.54, yMm: 6.0, zMm: 5.0, direction: 'up', aliases: ['AO1'], required: true },
      { name: 'AOUT2', pinNumber: 4, role: 'power', signal: 'Channel A output 2', xMm: 0, yMm: 6.0, zMm: 5.0, direction: 'up', aliases: ['AO2'], required: true },
      { name: 'BOUT1', pinNumber: 5, role: 'power', signal: 'Channel B output 1', xMm: 2.54, yMm: 6.0, zMm: 5.0, direction: 'up', aliases: ['BO1'], required: true },
      { name: 'BOUT2', pinNumber: 6, role: 'power', signal: 'Channel B output 2', xMm: 5.08, yMm: 6.0, zMm: 5.0, direction: 'up', aliases: ['BO2'], required: true },
      { name: 'AIN1', pinNumber: 7, role: 'pwm', signal: 'Channel A input 1', xMm: -7.62, yMm: 6.0, zMm: -5.0, direction: 'up', aliases: ['IN1'], required: true },
      { name: 'AIN2', pinNumber: 8, role: 'pwm', signal: 'Channel A input 2', xMm: -5.08, yMm: 6.0, zMm: -5.0, direction: 'up', aliases: ['IN2'], required: true },
      { name: 'BIN1', pinNumber: 9, role: 'pwm', signal: 'Channel B input 1', xMm: -2.54, yMm: 6.0, zMm: -5.0, direction: 'up', aliases: ['IN3'], required: true },
      { name: 'BIN2', pinNumber: 10, role: 'pwm', signal: 'Channel B input 2', xMm: 0, yMm: 6.0, zMm: -5.0, direction: 'up', aliases: ['IN4'], required: true },
      { name: 'SLP', pinNumber: 11, role: 'control', signal: 'nSLEEP — HIGH to enable', xMm: 2.54, yMm: 6.0, zMm: -5.0, direction: 'up', aliases: ['nSLEEP'], required: false },
      { name: 'FLT', pinNumber: 12, role: 'digital', signal: 'nFAULT open-drain output', xMm: 5.08, yMm: 6.0, zMm: -5.0, direction: 'up', aliases: ['nFAULT'], required: false },
    ],
    features: [
      { name: 'drv8833_qfn', type: 'box', dimensions: [4.0, 1.0, 4.0], position: [0, 1.3, 0], color: '#18181b' },
      { name: 'bulk_cap', type: 'box', dimensions: [3.2, 1.6, 1.6], position: [-6.0, 1.6, 0], color: '#d97706' },
      { name: 'header_top', type: 'header_block', dimensions: [15.24, 2.5, 2.5], position: [-1.27, 2.0, 5.0], color: '#111827' },
      { name: 'header_bottom', type: 'header_block', dimensions: [15.24, 2.5, 2.5], position: [-1.27, 2.0, -5.0], color: '#111827' },
    ],
    protocols: ['pwm', 'gpio'],
    keywords: ['drv8833', 'motor driver', 'h-bridge', 'dual', 'low voltage'],
    aliases: ['drv8833', 'cjmcu-8833'],
  },

  'pca9685-servo-driver': {
    id: 'pca9685-servo-driver',
    name: 'PCA9685 16-channel PWM/servo driver',
    category: 'driver',
    description:
      'Adafruit-style 62.5 x 25.4 mm board: I2C header on one edge, a screw terminal for the servo rail, six address-select solder jumpers and sixteen 3-pin servo headers along the body.',
    voltage: 3.3,
    minVoltage: 2.3,
    maxVoltage: 5.5,
    currentMa: 10,
    dimensions: { widthMm: 62.5, lengthMm: 25.4, heightMm: 1.6 },
    bodyColor: '#166534',
    pins: [
      { name: 'GND', pinNumber: 1, role: 'ground', signal: 'Common ground', xMm: -28.0, yMm: 6.0, zMm: -11.0, direction: 'up', aliases: ['-'], required: true },
      { name: 'OE', pinNumber: 2, role: 'control', signal: 'Output enable (active low)', xMm: -25.46, yMm: 6.0, zMm: -11.0, direction: 'up', aliases: ['nOE'], required: false },
      { name: 'SCL', pinNumber: 3, role: 'i2c', signal: 'I2C clock', xMm: -22.92, yMm: 6.0, zMm: -11.0, direction: 'up', aliases: ['CLK'], required: true },
      { name: 'SDA', pinNumber: 4, role: 'i2c', signal: 'I2C data', xMm: -20.38, yMm: 6.0, zMm: -11.0, direction: 'up', aliases: ['DATA'], required: true },
      { name: 'VCC', pinNumber: 5, role: 'power', signal: 'Logic supply 2.3-5.5 V', xMm: -17.84, yMm: 6.0, zMm: -11.0, direction: 'up', aliases: ['VDD'], required: true },
      { name: 'V+', pinNumber: 6, role: 'power', signal: 'Servo power rail (separate supply)', xMm: -15.3, yMm: 6.0, zMm: -11.0, direction: 'up', aliases: ['VSERVO'], required: true },
      { name: 'EXTCLK', pinNumber: 7, role: 'control', signal: 'Optional external clock input', xMm: -12.76, yMm: 6.0, zMm: -11.0, direction: 'up', required: false },
      { name: 'PWM0', pinNumber: 8, role: 'pwm', signal: 'Channel 0 output', xMm: -26.0, yMm: 6.0, zMm: 9.0, direction: 'up', aliases: ['CH0'], required: false },
      { name: 'PWM15', pinNumber: 9, role: 'pwm', signal: 'Channel 15 output', xMm: 26.0, yMm: 6.0, zMm: 9.0, direction: 'up', aliases: ['CH15'], required: false },
    ],
    features: [
      { name: 'pca9685_ic', type: 'box', dimensions: [10.0, 1.4, 6.0], position: [0, 1.4, 0], color: '#18181b' },
      { name: 'servo_rail_terminal', type: 'screw_terminal', dimensions: [10.0, 9.0, 8.0], position: [-2.0, 5.0, -9.0], color: '#2563eb' },
      { name: 'bulk_cap', type: 'cylinder', dimensions: [3.0, 7.0, 0], position: [8.0, 4.6, -6.0], color: '#1e293b' },
      { name: 'servo_headers', type: 'header_block', dimensions: [56.0, 2.5, 7.62], position: [0, 2.0, 9.0], color: '#111827' },
      { name: 'i2c_header', type: 'header_block', dimensions: [17.78, 2.5, 2.5], position: [-20.4, 2.0, -11.0], color: '#111827' },
    ],
    protocols: ['i2c', 'pwm'],
    keywords: ['pca9685', 'servo driver', '16 channel', 'pwm', 'i2c'],
    aliases: ['pca9685', 'servo shield', '16 channel servo driver'],
    libraryRequirements: [
      { name: 'Adafruit PWM Servo Driver Library', import: 'Adafruit_PWMServoDriver.h', manager: 'arduino', purpose: '12-bit PWM over I2C' },
    ],
  },

  'stepper-motor-nema17': {
    id: 'stepper-motor-nema17',
    name: 'NEMA 17 bipolar stepper motor',
    category: 'actuator',
    description:
      'NEMA 17 frame: 42.3 mm square body, 47 mm long, 5 mm D-shaft, 31 mm bolt circle. Four leads for two coils, driven from a chopper driver.',
    voltage: 12.0,
    minVoltage: 8.0,
    maxVoltage: 24.0,
    currentMa: 1500,
    dimensions: { widthMm: 42.3, lengthMm: 42.3, heightMm: 47.0 },
    bodyColor: '#1f2937',
    pins: [
      { name: 'COIL_A1', pinNumber: 1, role: 'power', signal: 'Coil A +', xMm: -6.0, yMm: 4.0, zMm: -21.0, direction: 'back', aliases: ['A+', 'BLACK'], required: true },
      { name: 'COIL_A2', pinNumber: 2, role: 'power', signal: 'Coil A -', xMm: -2.0, yMm: 4.0, zMm: -21.0, direction: 'back', aliases: ['A-', 'GREEN'], required: true },
      { name: 'COIL_B1', pinNumber: 3, role: 'power', signal: 'Coil B +', xMm: 2.0, yMm: 4.0, zMm: -21.0, direction: 'back', aliases: ['B+', 'RED'], required: true },
      { name: 'COIL_B2', pinNumber: 4, role: 'power', signal: 'Coil B -', xMm: 6.0, yMm: 4.0, zMm: -21.0, direction: 'back', aliases: ['B-', 'BLUE'], required: true },
    ],
    features: [
      { name: 'stator_stack', type: 'box', dimensions: [42.3, 34.0, 42.3], position: [0, 23.0, 0], color: '#334155' },
      { name: 'front_end_cap', type: 'box', dimensions: [42.3, 6.0, 42.3], position: [0, 44.0, 0], color: '#1f2937' },
      { name: 'rear_end_cap', type: 'box', dimensions: [42.3, 6.0, 42.3], position: [0, 3.0, 0], color: '#1f2937' },
      { name: 'shaft', type: 'cylinder', dimensions: [2.5, 24.0, 0], position: [0, 59.0, 0], color: '#e2e8f0' },
      { name: 'pilot_boss', type: 'cylinder', dimensions: [11.0, 2.0, 0], position: [0, 48.0, 0], color: '#94a3b8' },
    ],
    protocols: [],
    keywords: ['stepper', 'nema17', 'bipolar', '3d printer', 'cnc'],
    aliases: ['nema 17', 'nema17', 'bipolar stepper'],
  },

  'ds18b20-temperature': {
    id: 'ds18b20-temperature',
    name: 'DS18B20 1-Wire digital thermometer',
    category: 'sensor',
    description:
      'TO-92 package, 4.3 x 4.3 x 5.2 mm body with three 0.5 mm leads on a 1.27 mm pitch. Flat face towards the viewer, the leads read GND, DQ, VDD left to right.',
    voltage: 5.0,
    minVoltage: 3.0,
    maxVoltage: 5.5,
    currentMa: 1.5,
    dimensions: { widthMm: 4.3, lengthMm: 4.3, heightMm: 5.2 },
    bodyColor: '#111827',
    pins: [
      { name: 'GND', pinNumber: 1, role: 'ground', signal: 'Ground (pin 1)', xMm: -1.27, yMm: 0, zMm: 0, direction: 'down', aliases: ['-', 'BLACK'], required: true },
      { name: 'DQ', pinNumber: 2, role: 'digital', signal: '1-Wire data (pin 2), 4.7 kOhm pull-up required', xMm: 0, yMm: 0, zMm: 0, direction: 'down', aliases: ['DATA', 'YELLOW'], required: true },
      { name: 'VDD', pinNumber: 3, role: 'power', signal: 'Supply 3.0-5.5 V (pin 3)', xMm: 1.27, yMm: 0, zMm: 0, direction: 'down', aliases: ['VCC', 'RED'], required: true },
    ],
    features: [
      { name: 'to92_body', type: 'cylinder', dimensions: [2.3, 5.2, 0], position: [0, 2.6, 0], color: '#18181b' },
      { name: 'flat_face', type: 'box', dimensions: [4.3, 5.2, 0.8], position: [0, 2.6, 1.6], color: '#0f172a' },
    ],
    protocols: ['one_wire'],
    keywords: ['ds18b20', 'temperature', '1-wire', 'thermometer', 'probe'],
    aliases: ['ds18b20', 'dallas temperature sensor'],
    libraryRequirements: [
      { name: 'OneWire', import: 'OneWire.h', manager: 'arduino', purpose: '1-Wire transport' },
      { name: 'DallasTemperature', import: 'DallasTemperature.h', manager: 'arduino', purpose: 'DS18B20 conversion' },
    ],
  },

  'water-pump-5v-submersible': {
    id: 'water-pump-5v-submersible',
    name: 'Submersible water pump (5 V, 120 L/h)',
    category: 'actuator',
    description:
      'Potted brushless-style mini pump in a plastic housing with an inlet cage at the base and a 7 mm barb outlet on top. Two flying leads, fully submersible.',
    voltage: 5.0,
    minVoltage: 3.0,
    maxVoltage: 6.0,
    currentMa: 200,
    dimensions: { widthMm: 24.0, lengthMm: 24.0, heightMm: 45.0 },
    bodyColor: '#1e293b',
    pins: [
      { name: '+', pinNumber: 1, role: 'power', signal: 'Pump positive (red)', xMm: -3.0, yMm: 44.0, zMm: -8.0, direction: 'up', aliases: ['VCC', 'RED'], required: true },
      { name: '-', pinNumber: 2, role: 'ground', signal: 'Pump negative (black, switched)', xMm: 3.0, yMm: 44.0, zMm: -8.0, direction: 'up', aliases: ['GND', 'BLACK'], required: true },
    ],
    features: [
      { name: 'motor_housing', type: 'cylinder', dimensions: [12.0, 28.0, 0], position: [0, 26.0, 0], color: '#0f172a' },
      { name: 'inlet_cage', type: 'cylinder', dimensions: [12.0, 12.0, 0], position: [0, 6.0, 0], color: '#334155' },
      { name: 'outlet_barb', type: 'cylinder', dimensions: [3.5, 12.0, 0], position: [0, 34.0, 12.0], color: '#475569', rotation: [90, 0, 0] },
    ],
    protocols: [],
    keywords: ['pump', 'water pump', 'submersible', 'irrigation'],
    aliases: ['water pump', 'mini pump', '5v pump'],
  },

  'solenoid-12v-push-pull': {
    id: 'solenoid-12v-push-pull',
    name: '12 V push-pull solenoid (JF-0530B)',
    category: 'actuator',
    description:
      'Open-frame solenoid: a steel U-frame around the coil bobbin with a sliding plunger and return spring, roughly 32 x 22 x 27 mm with a 10 mm stroke.',
    voltage: 12.0,
    minVoltage: 9.0,
    maxVoltage: 12.0,
    currentMa: 650,
    dimensions: { widthMm: 32.0, lengthMm: 22.0, heightMm: 27.0 },
    bodyColor: '#334155',
    pins: [
      { name: 'COIL_A', pinNumber: 1, role: 'power', signal: 'Coil terminal A (+12 V)', xMm: -6.0, yMm: 26.0, zMm: -9.0, direction: 'up', aliases: ['+', 'RED'], required: true },
      { name: 'COIL_B', pinNumber: 2, role: 'ground', signal: 'Coil terminal B (switched)', xMm: 6.0, yMm: 26.0, zMm: -9.0, direction: 'up', aliases: ['-', 'BLACK'], required: true },
    ],
    features: [
      { name: 'steel_frame', type: 'box', dimensions: [32.0, 27.0, 22.0], position: [0, 13.5, 0], color: '#475569' },
      { name: 'coil_bobbin', type: 'cylinder', dimensions: [9.0, 20.0, 0], position: [0, 13.5, 0], color: '#7c2d12', rotation: [0, 0, 90] },
      { name: 'plunger', type: 'cylinder', dimensions: [4.0, 26.0, 0], position: [14.0, 13.5, 0], color: '#cbd5e1', rotation: [0, 0, 90] },
    ],
    protocols: [],
    keywords: ['solenoid', 'plunger', 'latch', 'actuator'],
    aliases: ['solenoid', '12v solenoid'],
  },
};
