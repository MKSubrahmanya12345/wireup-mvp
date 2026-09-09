/**
 * cad-helper/datasheet-parser.ts
 * Parses raw datasheet text, Markdown, or specs into structured CAD & electrical specifications.
 * Includes built-in high-accuracy presets for Maker and Industrial components.
 */

import type { CadComponentSpec, CadPinDefinition, CadFeature, ComponentRole, PinSignalRole } from './types';
import { MOTION_PRESETS } from './presets-motion';

/**
 * Standard pin header spacing helper.
 * Generates an array of pins spaced along an axis at standard 2.54mm pitch (or custom pitch).
 */
export function generateHeaderPins(options: {
  names: string[];
  roles: PinSignalRole[];
  signals?: string[];
  startX: number;
  startY: number;
  startZ: number;
  pitchMm?: number;
  axis?: 'x' | 'z';
  direction?: 'up' | 'down' | 'left' | 'right' | 'front' | 'back';
}): CadPinDefinition[] {
  const pitch = options.pitchMm ?? 2.54;
  const axis = options.axis ?? 'x';
  const pins: CadPinDefinition[] = [];

  for (let i = 0; i < options.names.length; i++) {
    const name = options.names[i];
    const role = options.roles[i] ?? 'digital';
    const signal = options.signals?.[i] ?? `${name} signal/pin`;
    const offset = i * pitch;

    pins.push({
      name,
      pinNumber: i + 1,
      role,
      signal,
      xMm: Number((options.startX + (axis === 'x' ? offset : 0)).toFixed(3)),
      yMm: Number(options.startY.toFixed(3)),
      zMm: Number((options.startZ + (axis === 'z' ? offset : 0)).toFixed(3)),
      direction: options.direction ?? 'up',
      required: role === 'power' || role === 'ground',
    });
  }

  return pins;
}

/**
 * High-accuracy built-in presets for common Maker & IoT components.
 */
const UNO_DIGITAL = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
const UNO_PWM = new Set(['3', '5', '6', '9', '10', '11']);

/** Pin anchor positions for the standard Arduino Uno R3 header layout. */
function arduinoUnoPins(): CadPinDefinition[] {
  const pins: CadPinDefinition[] = [];
  const add = (name: string, role: PinSignalRole, xMm: number, zMm: number, signal: string, required = false) => {
    pins.push({
      name,
      pinNumber: pins.length + 1,
      role,
      signal,
      xMm,
      yMm: 5.6,
      zMm,
      direction: 'up',
      required,
    });
  };

  // Digital header (two physical segments on the Uno) including AREF and its adjacent ground pin.
  add('AREF', 'analog', -24.3, 20.5, 'Analog reference');
  add('GND.1', 'ground', -24.3, 17.96, 'Digital-header ground', true);
  UNO_DIGITAL.forEach((name, index) => add(name, UNO_PWM.has(name) ? 'pwm' : 'digital', -24.3, 15.42 - index * 2.54, `Digital I/O ${name}`));
  // Power header. Distinct ground names match the named-anchor contract in the GLB.
  [
    ['IOREF', 'power', 20.5],
    ['RESET', 'control', 17.96],
    ['3V3', 'power', 15.42],
    ['5V', 'power', 12.88],
    ['GND.2', 'ground', 10.34],
    ['GND.3', 'ground', 7.8],
    ['VIN', 'power', 5.26],
  ].forEach(([name, role, zMm]) => add(String(name), role as PinSignalRole, 24.3, Number(zMm), `${name} rail`, role === 'power' || role === 'ground'));
  // Analog header.
  ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'].forEach((name, index) => add(name, name === 'A4' || name === 'A5' ? 'i2c' : 'analog', 24.3, -8.5 - index * 2.54, `${name} input`));

  return pins;
}

/**
 * Hand-authored specs for the original studio components.
 *
 * Newer families live in their own preset modules (see `presets-motion.ts`) and
 * are merged into `COMPONENT_PRESETS` below, so the studio, the presets API and
 * the catalog link all see one registry.
 */
const BASE_PRESETS: Record<string, CadComponentSpec> = {
  'arduino-uno-r3': {
    id: 'arduino-uno-r3',
    name: 'Arduino Uno R3',
    category: 'controller',
    description: 'Arduino Uno R3 development board with ATmega328P, USB-B, barrel jack, header rows and on-board power circuitry.',
    voltage: 5.0,
    minVoltage: 5.0,
    maxVoltage: 12.0,
    currentMa: 50,
    dimensions: { widthMm: 53.4, lengthMm: 68.6, heightMm: 1.6 },
    bodyColor: '#0b4f9c',
    pins: arduinoUnoPins(),
    features: [
      { name: 'usb_b_connector', type: 'box', dimensions: [14.5, 11.5, 15.5], position: [-25.8, 7.0, 23.5], color: '#c8ced8' },
      { name: 'barrel_jack', type: 'box', dimensions: [13.0, 11.0, 14.0], position: [-17.5, 7.0, -24.5], color: '#12161d' },
      { name: 'atmega328p_dip', type: 'box', dimensions: [10.0, 4.6, 35.5], position: [1.5, 4.0, -1.0], color: '#111318' },
      { name: 'atmega16u2', type: 'box', dimensions: [7.0, 2.0, 7.0], position: [-17.0, 2.6, 2.5], color: '#171a20' },
      { name: 'crystal_16mhz', type: 'box', dimensions: [10.5, 3.6, 4.8], position: [-6.5, 3.3, 13.0], color: '#c5c9c8' },
      { name: 'reset_button', type: 'potentiometer', dimensions: [4.4, 2.0, 4.4], position: [-11.5, 3.0, 19.5], color: '#d9dde5' },
      { name: 'power_led', type: 'led', dimensions: [1.8, 2.4, 1.8], position: [-5.5, 2.8, 19.0], color: '#31d17c' },
      { name: 'tx_led', type: 'led', dimensions: [1.5, 1.8, 1.5], position: [-2.8, 2.5, 19.0], color: '#f5a623' },
      { name: 'rx_led', type: 'led', dimensions: [1.5, 1.8, 1.5], position: [-0.4, 2.5, 19.0], color: '#f5a623' },
      { name: 'capacitor_47uf_a', type: 'cylinder', dimensions: [3.6, 8.0, 0], position: [-18.8, 5.2, -9.5], color: '#20242c' },
      { name: 'capacitor_47uf_b', type: 'cylinder', dimensions: [3.6, 8.0, 0], position: [-13.8, 5.2, -9.5], color: '#20242c' },
      { name: 'voltage_regulator', type: 'box', dimensions: [7.5, 3.0, 6.0], position: [-16.5, 3.0, -15.5], color: '#20242c' },
    ],
    visualAsset: { key: 'arduino-uno-r3', quality: 'reference' },
    protocols: ['gpio', 'i2c', 'spi', 'uart', 'pwm', 'analog'],
    keywords: ['arduino', 'uno', 'atmega328p', 'microcontroller', 'development board'],
    aliases: ['arduino uno', 'uno r3', 'arduino-uno-r3'],
  },

  'hc-sr04-ultrasonic': {
    id: 'hc-sr04-ultrasonic',
    name: 'HC-SR04 Ultrasonic Distance Sensor',
    category: 'sensor',
    description: 'Ultrasonic ranging module with 2cm to 400cm non-contact measurement capability.',
    voltage: 5.0,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentMa: 15,
    dimensions: { widthMm: 45.0, lengthMm: 20.0, heightMm: 1.6 },
    bodyColor: '#1a5b8c', // Deep Blue PCB
    pins: [
      { name: 'VCC', pinNumber: 1, role: 'power', signal: '5V Power Supply', xMm: -3.81, yMm: 8.5, zMm: 8.5, direction: 'front', required: true },
      { name: 'TRIG', pinNumber: 2, role: 'digital', signal: 'Trigger Pulse Input', xMm: -1.27, yMm: 8.5, zMm: 8.5, direction: 'front', required: true },
      { name: 'ECHO', pinNumber: 3, role: 'digital', signal: 'Echo Pulse Output', xMm: 1.27, yMm: 8.5, zMm: 8.5, direction: 'front', required: true },
      { name: 'GND', pinNumber: 4, role: 'ground', signal: 'Ground Reference', xMm: 3.81, yMm: 8.5, zMm: 8.5, direction: 'front', required: true },
    ],
    features: [
      // Left Transducer Cylinder (Transmitter)
      { name: 'transducer_tx', type: 'cylinder', dimensions: [8.0, 12.0, 0], position: [-13.0, 7.6, 0], color: '#94a3b8' },
      // Right Transducer Cylinder (Receiver)
      { name: 'transducer_rx', type: 'cylinder', dimensions: [8.0, 12.0, 0], position: [13.0, 7.6, 0], color: '#94a3b8' },
      // Crystal Oscillator
      { name: 'crystal', type: 'box', dimensions: [10.0, 3.5, 3.0], position: [0, 2.5, 0], color: '#cbd5e1' },
      // IC Package
      { name: 'ic_controller', type: 'box', dimensions: [7.0, 1.2, 5.0], position: [0, 1.5, -5.0], color: '#18181b' },
    ],
    protocols: ['gpio', 'digital'],
    keywords: ['sonar', 'ultrasonic', 'distance', 'ranging', 'hc-sr04', 'sr04'],
    aliases: ['hcsr04', 'hc-sr04', 'ultrasonic sensor'],
  },

  'oled-ssd1306-i2c': {
    id: 'oled-ssd1306-i2c',
    name: '0.96" I2C OLED Display (SSD1306)',
    category: 'display',
    description: '128x64 pixel monochrome OLED display module communicating over I2C interface.',
    voltage: 3.3,
    minVoltage: 3.0,
    maxVoltage: 5.5,
    currentMa: 20,
    dimensions: { widthMm: 27.0, lengthMm: 27.0, heightMm: 1.6 },
    bodyColor: '#0f172a', // Matte Black PCB
    pins: [
      { name: 'GND', pinNumber: 1, role: 'ground', signal: 'Ground', xMm: -3.81, yMm: 6.0, zMm: -11.5, direction: 'up', required: true },
      { name: 'VCC', pinNumber: 2, role: 'power', signal: '3.3V/5V Power Supply', xMm: -1.27, yMm: 6.0, zMm: -11.5, direction: 'up', required: true },
      { name: 'SCL', pinNumber: 3, role: 'i2c', signal: 'I2C Clock Line', xMm: 1.27, yMm: 6.0, zMm: -11.5, direction: 'up', required: true },
      { name: 'SDA', pinNumber: 4, role: 'i2c', signal: 'I2C Data Line', xMm: 3.81, yMm: 6.0, zMm: -11.5, direction: 'up', required: true },
    ],
    features: [
      // 0.96" Glass OLED Display Screen
      { name: 'oled_glass', type: 'screen', dimensions: [24.0, 2.0, 14.0], position: [0, 2.0, 2.5], color: '#090d16' },
      // 4-pin Header Block Base
      { name: 'header_block', type: 'header_block', dimensions: [10.2, 2.5, 2.5], position: [0, 2.0, -11.5], color: '#1c1917' },
    ],
    protocols: ['i2c'],
    keywords: ['oled', 'ssd1306', 'display', 'screen', '128x64', 'i2c display'],
    aliases: ['ssd1306', 'oled 0.96', 'oled i2c'],
  },

  'bme280-environmental': {
    id: 'bme280-environmental',
    name: 'BME280 Temperature, Humidity & Pressure Sensor',
    category: 'sensor',
    description: 'Precision digital environmental sensor with combined barometric pressure, temperature, and relative humidity sensing.',
    voltage: 3.3,
    minVoltage: 1.8,
    maxVoltage: 3.6,
    currentMa: 3.6,
    dimensions: { widthMm: 15.2, lengthMm: 12.0, heightMm: 1.6 },
    bodyColor: '#15803d', // Purple/Green PCB
    pins: [
      { name: 'VIN', pinNumber: 1, role: 'power', signal: '3.3V Power', xMm: -6.35, yMm: 6.0, zMm: -4.5, direction: 'up', required: true },
      { name: 'GND', pinNumber: 2, role: 'ground', signal: 'Ground', xMm: -3.81, yMm: 6.0, zMm: -4.5, direction: 'up', required: true },
      { name: 'SCL', pinNumber: 3, role: 'i2c', signal: 'I2C/SPI Clock', xMm: -1.27, yMm: 6.0, zMm: -4.5, direction: 'up', required: true },
      { name: 'SDA', pinNumber: 4, role: 'i2c', signal: 'I2C Data / SPI MOSI', xMm: 1.27, yMm: 6.0, zMm: -4.5, direction: 'up', required: true },
      { name: 'CSB', pinNumber: 5, role: 'control', signal: 'Chip Select', xMm: 3.81, yMm: 6.0, zMm: -4.5, direction: 'up', required: false },
      { name: 'SDO', pinNumber: 6, role: 'spi', signal: 'SPI MISO / I2C Address Select', xMm: 6.35, yMm: 6.0, zMm: -4.5, direction: 'up', required: false },
    ],
    features: [
      // Metal Sensor Can (LGA-8 Package)
      { name: 'bme280_metal_can', type: 'box', dimensions: [2.5, 1.2, 2.5], position: [0, 1.5, 1.5], color: '#d1d5db' },
      // 6-pin Header Block
      { name: 'header_strip', type: 'header_block', dimensions: [15.2, 2.5, 2.5], position: [0, 2.0, -4.5], color: '#1e293b' },
    ],
    protocols: ['i2c', 'spi'],
    keywords: ['bme280', 'bmp280', 'temperature', 'humidity', 'pressure', 'barometer', 'weather'],
    aliases: ['bme280', 'bme-280', 'bosch bme280'],
  },

  'mpu6050-imu': {
    id: 'mpu6050-imu',
    name: 'MPU-6050 6-Axis Gyroscope and Accelerometer',
    category: 'sensor',
    description: 'Motion tracking device combining a 3-axis gyroscope and a 3-axis accelerometer with on-board Digital Motion Processor.',
    voltage: 3.3,
    minVoltage: 3.0,
    maxVoltage: 5.0,
    currentMa: 4.0,
    dimensions: { widthMm: 21.0, lengthMm: 16.0, heightMm: 1.6 },
    bodyColor: '#1e3a8a', // Royal Blue PCB
    pins: [
      { name: 'VCC', pinNumber: 1, role: 'power', signal: 'Power 3.3V-5V', xMm: -8.89, yMm: 6.0, zMm: -6.0, direction: 'up', required: true },
      { name: 'GND', pinNumber: 2, role: 'ground', signal: 'Ground', xMm: -6.35, yMm: 6.0, zMm: -6.0, direction: 'up', required: true },
      { name: 'SCL', pinNumber: 3, role: 'i2c', signal: 'I2C Serial Clock', xMm: -3.81, yMm: 6.0, zMm: -6.0, direction: 'up', required: true },
      { name: 'SDA', pinNumber: 4, role: 'i2c', signal: 'I2C Serial Data', xMm: -1.27, yMm: 6.0, zMm: -6.0, direction: 'up', required: true },
      { name: 'XDA', pinNumber: 5, role: 'i2c', signal: 'Auxiliary I2C SDA', xMm: 1.27, yMm: 6.0, zMm: -6.0, direction: 'up', required: false },
      { name: 'XCL', pinNumber: 6, role: 'i2c', signal: 'Auxiliary I2C SCL', xMm: 3.81, yMm: 6.0, zMm: -6.0, direction: 'up', required: false },
      { name: 'AD0', pinNumber: 7, role: 'digital', signal: 'I2C Address Select', xMm: 6.35, yMm: 6.0, zMm: -6.0, direction: 'up', required: false },
      { name: 'INT', pinNumber: 8, role: 'digital', signal: 'Interrupt Output', xMm: 8.89, yMm: 6.0, zMm: -6.0, direction: 'up', required: false },
    ],
    features: [
      // QFN IC Chip
      { name: 'mpu_ic', type: 'box', dimensions: [4.0, 1.0, 4.0], position: [0, 1.4, 1.5], color: '#111827' },
      // LDO Regulator
      { name: 'ldo_regulator', type: 'box', dimensions: [3.0, 1.0, 1.5], position: [-6.0, 1.4, 2.0], color: '#1f2937' },
      // 8-pin Header Block
      { name: 'header_strip', type: 'header_block', dimensions: [20.32, 2.5, 2.5], position: [0, 2.0, -6.0], color: '#1e293b' },
    ],
    protocols: ['i2c'],
    keywords: ['mpu6050', 'gyro', 'accelerometer', 'imu', 'motion', 'orientation', '6-axis'],
    aliases: ['mpu6050', 'mpu-6050', 'gy-521'],
  },

  'pir-sensor-hc-sr501': {
    id: 'pir-sensor-hc-sr501',
    name: 'HC-SR501 PIR Motion Sensor Module',
    category: 'sensor',
    description: 'Pyroelectric infrared motion detection module with adjustable sensitivity and delay time.',
    voltage: 5.0,
    minVoltage: 4.5,
    maxVoltage: 20.0,
    currentMa: 0.065,
    dimensions: { widthMm: 32.0, lengthMm: 24.0, heightMm: 1.6 },
    bodyColor: '#15803d', // Green PCB
    pins: [
      { name: 'VCC', pinNumber: 1, role: 'power', signal: 'DC 4.5V-20V Supply', xMm: -2.54, yMm: -6.0, zMm: 10.0, direction: 'down', required: true },
      { name: 'OUT', pinNumber: 2, role: 'digital', signal: 'Digital High/Low Output (3.3V TTL)', xMm: 0, yMm: -6.0, zMm: 10.0, direction: 'down', required: true },
      { name: 'GND', pinNumber: 3, role: 'ground', signal: 'Ground Reference', xMm: 2.54, yMm: -6.0, zMm: 10.0, direction: 'down', required: true },
    ],
    features: [
      // White Dome Fresnel Lens
      { name: 'fresnel_dome', type: 'lens', dimensions: [11.0, 12.0, 0], position: [0, 7.5, 0], color: '#f8fafc' },
      // Dual Trimmer Potentiometers
      { name: 'pot_sensitivity', type: 'potentiometer', dimensions: [4.0, 3.5, 4.0], position: [-10.0, 2.5, -7.0], color: '#f59e0b' },
      { name: 'pot_time', type: 'potentiometer', dimensions: [4.0, 3.5, 4.0], position: [10.0, 2.5, -7.0], color: '#f59e0b' },
    ],
    protocols: ['gpio', 'digital'],
    keywords: ['pir', 'motion', 'infrared', 'human detection', 'hc-sr501', 'sr501'],
    aliases: ['hcsr501', 'hc-sr501', 'pir motion sensor'],
  },

  'l298n-motor-driver': {
    id: 'l298n-motor-driver',
    name: 'L298N Dual H-Bridge Motor Driver Module',
    category: 'driver',
    description: 'High-power dual full-bridge driver designed to drive inductive loads such as relays, solenoids, DC and stepping motors.',
    voltage: 5.0,
    minVoltage: 4.5,
    maxVoltage: 35.0,
    currentMa: 2000,
    dimensions: { widthMm: 43.0, lengthMm: 43.0, heightMm: 1.6 },
    bodyColor: '#b91c1c', // Red PCB
    pins: [
      { name: 'ENA', pinNumber: 1, role: 'pwm', signal: 'Motor A Speed Enable (PWM)', xMm: -6.35, yMm: 6.0, zMm: 18.0, direction: 'up' },
      { name: 'IN1', pinNumber: 2, role: 'digital', signal: 'Motor A Direction 1', xMm: -3.81, yMm: 6.0, zMm: 18.0, direction: 'up' },
      { name: 'IN2', pinNumber: 3, role: 'digital', signal: 'Motor A Direction 2', xMm: -1.27, yMm: 6.0, zMm: 18.0, direction: 'up' },
      { name: 'IN3', pinNumber: 4, role: 'digital', signal: 'Motor B Direction 1', xMm: 1.27, yMm: 6.0, zMm: 18.0, direction: 'up' },
      { name: 'IN4', pinNumber: 5, role: 'digital', signal: 'Motor B Direction 2', xMm: 3.81, yMm: 6.0, zMm: 18.0, direction: 'up' },
      { name: 'ENB', pinNumber: 6, role: 'pwm', signal: 'Motor B Speed Enable (PWM)', xMm: 6.35, yMm: 6.0, zMm: 18.0, direction: 'up' },
      { name: '+12V', pinNumber: 7, role: 'power', signal: 'Motor Power Input (+5V - 35V)', xMm: -16.0, yMm: 8.0, zMm: 15.0, direction: 'up', aliases: ['VCC', 'VMOT', 'VS'], required: true },
      { name: 'GND', pinNumber: 8, role: 'ground', signal: 'Power & Logic Ground', xMm: -16.0, yMm: 8.0, zMm: 10.0, direction: 'up', required: true },
      { name: '5V', pinNumber: 9, role: 'power', signal: '5V Logic Supply / 5V Output', xMm: -16.0, yMm: 8.0, zMm: 5.0, direction: 'up', required: true },
      { name: 'OUT1', pinNumber: 10, role: 'power', signal: 'Motor A Output 1', xMm: -18.0, yMm: 8.0, zMm: -10.0, direction: 'up' },
      { name: 'OUT2', pinNumber: 11, role: 'power', signal: 'Motor A Output 2', xMm: -18.0, yMm: 8.0, zMm: -15.0, direction: 'up' },
      { name: 'OUT3', pinNumber: 12, role: 'power', signal: 'Motor B Output 1', xMm: 18.0, yMm: 8.0, zMm: -10.0, direction: 'up' },
      { name: 'OUT4', pinNumber: 13, role: 'power', signal: 'Motor B Output 2', xMm: 18.0, yMm: 8.0, zMm: -15.0, direction: 'up' },
    ],
    features: [
      // Central Aluminum Heatsink
      { name: 'aluminum_heatsink', type: 'heatsink', dimensions: [25.0, 22.0, 12.0], position: [0, 12.0, -5.0], color: '#334155' },
      // Power Terminal Block (Blue 3-position)
      { name: 'power_terminal', type: 'screw_terminal', dimensions: [15.0, 10.0, 8.0], position: [-16.0, 5.5, 10.0], color: '#2563eb' },
      // Motor Output Terminals
      { name: 'motor_terminal_a', type: 'screw_terminal', dimensions: [10.0, 10.0, 8.0], position: [-18.0, 5.5, -12.5], color: '#2563eb' },
      { name: 'motor_terminal_b', type: 'screw_terminal', dimensions: [10.0, 10.0, 8.0], position: [18.0, 5.5, -12.5], color: '#2563eb' },
      // Electrolytic Capacitor
      { name: 'filter_cap', type: 'cylinder', dimensions: [4.0, 11.0, 0], position: [-8.0, 6.5, 3.0], color: '#1e293b' },
    ],
    protocols: ['pwm', 'gpio'],
    keywords: ['l298n', 'motor driver', 'h-bridge', 'dc motor', 'stepper driver', 'dual motor'],
    aliases: ['l298n', 'l298', 'l298n dual h-bridge'],
  },

  'rotary-encoder-ky040': {
    id: 'rotary-encoder-ky040',
    name: 'KY-040 Rotary Encoder Module',
    category: 'input',
    description: 'Incremental rotary encoder with built-in momentary push button switch and pull-up resistors.',
    voltage: 5.0,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentMa: 5,
    dimensions: { widthMm: 26.0, lengthMm: 19.0, heightMm: 1.6 },
    bodyColor: '#1e293b', // Black PCB
    pins: [
      { name: 'CLK', pinNumber: 1, role: 'digital', signal: 'Encoder Output A (Clock)', xMm: -5.08, yMm: 6.0, zMm: -7.5, direction: 'up', required: true },
      { name: 'DT', pinNumber: 2, role: 'digital', signal: 'Encoder Output B (Data)', xMm: -2.54, yMm: 6.0, zMm: -7.5, direction: 'up', required: true },
      { name: 'SW', pinNumber: 3, role: 'digital', signal: 'Pushbutton Switch', xMm: 0, yMm: 6.0, zMm: -7.5, direction: 'up', required: false },
      { name: '+', pinNumber: 4, role: 'power', signal: 'VCC Supply (5V/3.3V)', xMm: 2.54, yMm: 6.0, zMm: -7.5, direction: 'up', required: true },
      { name: 'GND', pinNumber: 5, role: 'ground', signal: 'Ground Reference', xMm: 5.08, yMm: 6.0, zMm: -7.5, direction: 'up', required: true },
    ],
    features: [
      // Metal Rotary Shaft Body
      { name: 'encoder_body', type: 'box', dimensions: [12.0, 5.0, 12.0], position: [0, 4.0, 1.5], color: '#94a3b8' },
      // D-Shaft Cylinder
      { name: 'encoder_shaft', type: 'cylinder', dimensions: [3.0, 15.0, 0], position: [0, 14.0, 1.5], color: '#cbd5e1' },
      // 5-Pin Header
      { name: 'header_strip', type: 'header_block', dimensions: [12.7, 2.5, 2.5], position: [0, 2.0, -7.5], color: '#0f172a' },
    ],
    protocols: ['gpio', 'quadrature'],
    keywords: ['rotary encoder', 'ky-040', 'knob', 'dial', 'pulse encoder', 'push switch'],
    aliases: ['ky040', 'ky-040', 'rotary encoder'],
  },
};

/**
 * Every authored CAD spec available to the studio, keyed by catalog id.
 *
 * A key here must exist in the component registry: `auditCatalogCadLink()`
 * reports an orphan preset otherwise, because a model that no project part can
 * reference cannot be wired to anything.
 */
export const COMPONENT_PRESETS: Record<string, CadComponentSpec> = {
  ...BASE_PRESETS,
  ...MOTION_PRESETS,
};

/**
 * Parses raw datasheet text using heuristics to extract geometry dimensions,
 * pin tables, voltage ranges, and component categorization.
 */
export function parseDatasheetText(rawText: string, userOverrides?: Partial<CadComponentSpec>): CadComponentSpec {
  const text = rawText || '';
  
  // 1. Extract ID & Name
  let id = userOverrides?.id || '';
  let name = userOverrides?.name || '';
  
  if (!name) {
    const titleMatch = text.match(/(?:module|sensor|board|controller|driver|display)?:?\s*([A-Z0-9\-_]{3,20}\s+[A-Za-z0-9\s\-–]{3,40})/i);
    name = titleMatch ? titleMatch[1].trim() : 'Custom Electronic Component';
  }
  
  if (!id) {
    id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // 2. Extract Category
  let category: ComponentRole = userOverrides?.category || 'sensor';
  if (/motor|stepper|servo|driver|h-bridge/i.test(text)) category = 'driver';
  else if (/oled|lcd|screen|tft|display|7-segment/i.test(text)) category = 'display';
  else if (/button|keypad|potentiometer|encoder|switch/i.test(text)) category = 'input';
  else if (/regulator|buck|boost|battery|power/i.test(text)) category = 'power';
  else if (/bluetooth|wifi|lora|zigbee|nrf|transceiver|rf/i.test(text)) category = 'communication';
  else if (/mcu|microcontroller|atmega|esp32|rp2040|stm32|arduino/i.test(text)) category = 'controller';
  else if (/buzzer|relay|solenoid|led|laser/i.test(text)) category = 'actuator';

  // 3. Extract Voltage
  let voltage = userOverrides?.voltage || 5.0;
  let minVoltage = userOverrides?.minVoltage;
  let maxVoltage = userOverrides?.maxVoltage;

  const voltMatch = text.match(/(\d+(?:\.\d+)?)\s*V(?:\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*V)?/i);
  if (voltMatch) {
    const v1 = parseFloat(voltMatch[1]);
    const v2 = voltMatch[2] ? parseFloat(voltMatch[2]) : undefined;
    if (v2) {
      minVoltage = v1;
      maxVoltage = v2;
      voltage = v1 <= 3.3 && v2 >= 3.3 ? 3.3 : v1;
    } else {
      voltage = v1;
    }
  }

  // 4. Extract Dimensions (e.g. 45 x 20 x 15 mm or 45mm x 20mm)
  let widthMm = userOverrides?.dimensions?.widthMm || 25.0;
  let lengthMm = userOverrides?.dimensions?.lengthMm || 20.0;
  let heightMm = userOverrides?.dimensions?.heightMm || 1.6;

  const dimMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*(?:mm)?(?:\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*(?:mm)?)?/);
  if (dimMatch) {
    const d1 = parseFloat(dimMatch[1]);
    const d2 = parseFloat(dimMatch[2]);
    const d3 = dimMatch[3] ? parseFloat(dimMatch[3]) : undefined;
    if (d1 && d2) {
      widthMm = Math.max(d1, d2);
      lengthMm = Math.min(d1, d2);
      if (d3) heightMm = 1.6; // standard PCB thickness
    }
  }

  // 5. Extract Pins
  const pins: CadPinDefinition[] = userOverrides?.pins?.length ? userOverrides.pins : [];
  if (pins.length === 0) {
    // Scan for pin table patterns: "1: VCC", "PIN 1 - GND", "VCC, GND, SDA, SCL"
    const pinLines = text.split('\n');
    const detectedPinNames: string[] = [];

    for (const line of pinLines) {
      const pMatch = line.match(/(?:pin\s*)?(\d+)?[:\-–\s]+([A-Z0-9_\+\*]{1,8})(?:\s*[:\-–\s]+(.+))?/i);
      if (pMatch && pMatch[2]) {
        const pName = pMatch[2].toUpperCase().trim();
        if (['VCC', 'GND', 'VIN', '3V3', '5V', 'SDA', 'SCL', 'TX', 'RX', 'MISO', 'MOSI', 'SCK', 'CS', 'TRIG', 'ECHO', 'OUT', 'IN', 'CLK', 'DT', 'SW', 'ENA', 'ENB', 'IN1', 'IN2', 'IN3', 'IN4', 'AO', 'DO', 'INT', 'AD0', 'PWM'].includes(pName)) {
          if (!detectedPinNames.includes(pName)) detectedPinNames.push(pName);
        }
      }
    }

    if (detectedPinNames.length > 0) {
      const pitch = 2.54;
      const startX = -((detectedPinNames.length - 1) * pitch) / 2;
      for (let i = 0; i < detectedPinNames.length; i++) {
        const name = detectedPinNames[i];
        let role: PinSignalRole = 'digital';
        if (name === 'VCC' || name === 'VIN' || name === '3V3' || name === '5V' || name === '+') role = 'power';
        else if (name === 'GND' || name === 'GND.1' || name === 'GND.2' || name === '-') role = 'ground';
        else if (name === 'SDA' || name === 'SCL') role = 'i2c';
        else if (name === 'TX' || name === 'RX') role = 'uart';
        else if (name === 'MOSI' || name === 'MISO' || name === 'SCK' || name === 'CS') role = 'spi';
        else if (name === 'AO' || name === 'ANALOG') role = 'analog';
        else if (name.includes('PWM') || name.startsWith('EN')) role = 'pwm';

        pins.push({
          name,
          pinNumber: i + 1,
          role,
          signal: `${name} signal`,
          xMm: Number((startX + i * pitch).toFixed(3)),
          yMm: 6.0,
          zMm: Number((-(lengthMm / 2) + 2.54).toFixed(3)),
          direction: 'up',
          required: role === 'power' || role === 'ground',
        });
      }
    } else {
      // Default 4 pins
      pins.push(
        { name: 'VCC', pinNumber: 1, role: 'power', signal: 'VCC', xMm: -3.81, yMm: 6.0, zMm: -5.0, direction: 'up', required: true },
        { name: 'GND', pinNumber: 2, role: 'ground', signal: 'GND', xMm: -1.27, yMm: 6.0, zMm: -5.0, direction: 'up', required: true },
        { name: 'OUT', pinNumber: 3, role: 'digital', signal: 'Signal Out', xMm: 1.27, yMm: 6.0, zMm: -5.0, direction: 'up', required: true },
        { name: 'NC', pinNumber: 4, role: 'control', signal: 'Not Connected', xMm: 3.81, yMm: 6.0, zMm: -5.0, direction: 'up', required: false }
      );
    }
  }

  // 6. Features
  const features: CadFeature[] = userOverrides?.features || [
    { name: 'main_ic', type: 'box', dimensions: [6.0, 1.2, 6.0], position: [0, 1.4, 0], color: '#18181b' },
    { name: 'header_block', type: 'header_block', dimensions: [pins.length * 2.54, 2.5, 2.5], position: [0, 2.0, pins[0]?.zMm ?? 0], color: '#1e293b' },
  ];

  return {
    id,
    name,
    category,
    description: userOverrides?.description || `Precision ${name} with integrated interface and standard 2.54mm pin headers.`,
    voltage,
    minVoltage,
    maxVoltage,
    currentMa: userOverrides?.currentMa || 15,
    dimensions: { widthMm, lengthMm, heightMm },
    bodyColor: userOverrides?.bodyColor || '#1e3a8a',
    pins,
    features,
    protocols: userOverrides?.protocols || ['gpio'],
    keywords: userOverrides?.keywords || [id, category, name.toLowerCase()],
    aliases: userOverrides?.aliases || [id, name],
  };
}
