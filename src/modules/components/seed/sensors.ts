/** Sensor seed entries. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const SENSORS: ComponentDefinition[] = [
  def({
    id: 'dht11-temperature-humidity',
    name: 'DHT11 temperature & humidity sensor',
    category: 'sensor',
    description:
      'Single-wire digital temperature (0–50 °C, ±2 °C) and humidity (20–90 %RH, ±5 %) sensor. 1 Hz maximum sample rate. Needs a 4.7–10 kΩ pull-up on DATA (many 3-pin modules include one).',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 0.5, maxMa: 2.5, note: 'Standby ~0.06 mA; 0.5–2.5 mA during conversion.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('DATA', 'one_wire', 'bidirectional', { required: true, signal: 'Single-wire digital data', aliases: ['OUT', 'S', 'SIG', 'DQ'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    libraryRequirements: [
      { name: 'DHT sensor library', import: 'DHT.h', manager: 'arduino', repository: 'https://github.com/adafruit/DHT-sensor-library', purpose: 'Decodes the DHT single-wire protocol' },
      { name: 'Adafruit Unified Sensor', import: 'Adafruit_Sensor.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_Sensor', purpose: 'Dependency of the DHT sensor library' },
    ],
    keywords: ['dht11', 'temperature', 'humidity', 'weather', 'climate'],
    aliases: ['dht11', 'dht 11', 'temp humidity sensor'],
    simulator: { supported: false, notes: 'Simulators commonly provide the DHT22 variant instead.' },
    metadata: { electrical: true, sampleRateHz: 1, requiresPullupOhm: 10000, protocolAddress: 'single-wire' },
  }),

  def({
    id: 'dht22-temperature-humidity',
    name: 'DHT22 (AM2302) temperature & humidity sensor',
    category: 'sensor',
    description:
      'Single-wire digital temperature (-40–80 °C, ±0.5 °C) and humidity (0–100 %RH, ±2 %) sensor. 0.5 Hz maximum sample rate, 3.3–6 V supply. Needs a 4.7–10 kΩ pull-up on DATA.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 6,
    currentRequirements: { typicalMa: 0.5, maxMa: 2.5 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('DATA', 'one_wire', 'bidirectional', { required: true, signal: 'Single-wire digital data', aliases: ['OUT', 'S', 'SIG', 'DQ'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    libraryRequirements: [
      { name: 'DHT sensor library', import: 'DHT.h', manager: 'arduino', repository: 'https://github.com/adafruit/DHT-sensor-library', purpose: 'Decodes the DHT single-wire protocol' },
      { name: 'Adafruit Unified Sensor', import: 'Adafruit_Sensor.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_Sensor', purpose: 'Dependency of the DHT sensor library' },
    ],
    keywords: ['dht22', 'am2302', 'temperature', 'humidity', 'weather'],
    aliases: ['dht22', 'am2302', 'dht 22'],
    simulator: { part: 'wokwi-dht22', supported: true },
    metadata: { electrical: true, sampleRateHz: 0.5, requiresPullupOhm: 4700 },
  }),

  def({
    id: 'hc-sr04-ultrasonic',
    name: 'HC-SR04 ultrasonic distance sensor',
    category: 'sensor',
    description:
      '2 cm – 4 m ultrasonic rangefinder. TRIG receives a 10 µs pulse, ECHO returns a pulse whose width is proportional to distance (58 µs per cm). 5 V supply; ECHO is a 5 V output, so a 3.3 V MCU needs a divider or level shifter on that line.',
    voltage: 5,
    minVoltage: 5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 15, maxMa: 20, note: 'Quiescent 2 mA, 15 mA during a measurement cycle.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('TRIG', 'digital', 'input', { required: true, signal: '10 µs trigger pulse from the MCU', aliases: ['T', 'TRIGGER'] }),
      pin('ECHO', 'digital', 'output', { required: true, signal: '5 V pulse output — level shift for 3.3 V MCUs', aliases: ['E', 'OUT'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    keywords: ['ultrasonic', 'hc-sr04', 'distance', 'range', 'obstacle', 'sonar', 'parking'],
    aliases: ['hc-sr04', 'hcsr04', 'ultrasonic sensor', 'ultrasonic distance sensor'],
    simulator: { part: 'wokwi-hc-sr04', supported: true },
    metadata: { electrical: true, echoOutputVoltage: 5, minRangeCm: 2, maxRangeCm: 400, usPerCm: 58 },
  }),

  def({
    id: 'pir-sensor-hc-sr501',
    name: 'HC-SR501 PIR motion sensor',
    category: 'sensor',
    description:
      'Passive infrared motion detector with on-board amplifier and comparator. Digital HIGH output on motion, adjustable sensitivity and delay pots, and a retrigger/non-retrigger jumper. 4.5–20 V supply, 3.3 V compatible output.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 20,
    currentRequirements: { typicalMa: 0.05, maxMa: 65, note: '<50 µA quiescent; up to 65 mA during output high.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('OUT', 'digital', 'output', { required: true, signal: '3.3 V HIGH on motion', aliases: ['SIG', 'S', 'DATA'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    keywords: ['pir', 'motion', 'hc-sr501', 'presence', 'intruder', 'security'],
    aliases: ['pir', 'pir sensor', 'hc-sr501', 'motion sensor'],
    simulator: { supported: false, notes: 'Represent as a digital input source.' },
    metadata: { electrical: true, outputLogicVoltage: 3.3, warmUpSeconds: 30, detectionRangeM: 7, adjustableDelay: [1.3, 25] },
  }),

  def({
    id: 'ir-obstacle-sensor',
    name: 'IR obstacle avoidance sensor module',
    category: 'sensor',
    description:
      'Infrared LED + photodiode module with an on-board comparator and sensitivity trimmer. Digital OUT goes LOW when an obstacle is detected within roughly 2–30 cm. 3.3–5 V supply.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 15, maxMa: 35 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('OUT', 'digital', 'output', { required: true, signal: 'LOW = obstacle detected', aliases: ['DO', 'SIG', 'S'] }),
    ],
    keywords: ['ir', 'infrared', 'obstacle', 'avoidance', 'line follower', 'proximity'],
    aliases: ['ir obstacle sensor', 'ir sensor', 'obstacle sensor', 'infrared obstacle module'],
    simulator: { supported: false, notes: 'Represent as a digital input source.' },
    metadata: { electrical: true, activeLevel: 'low', detectionRangeCm: [2, 30] },
  }),

  def({
    id: 'ldr-photoresistor',
    name: 'LDR photoresistor (CdS cell)',
    category: 'sensor',
    description:
      'Light dependent resistor: ~1 MΩ in darkness down to ~1–10 kΩ in bright light. Two terminals, no polarity. Must be used in a voltage divider with a fixed resistor (10 kΩ is a good default) into an ADC pin.',
    minVoltage: 0,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 0.5, maxMa: 5 },
    pins: [
      pin('1', 'analog', 'bidirectional', { required: true, signal: 'Terminal 1 (to supply rail in a divider)', aliases: ['A'] }),
      pin('2', 'analog', 'bidirectional', { required: true, signal: 'Terminal 2 (to ADC node)', aliases: ['B'] }),
    ],
    keywords: ['ldr', 'photoresistor', 'light', 'brightness', 'cds', 'ambient light'],
    aliases: ['ldr', 'photoresistor', 'light sensor', 'cds cell'],
    simulator: { part: 'wokwi-photoresistor', supported: false, notes: 'Part id unverified — confirm before use.' },
    metadata: { electrical: true, requiresVoltageDivider: true, dividerResistorOhm: 10000, resistanceDarkOhm: 1000000, resistanceLightOhm: 5000 },
  }),

  def({
    id: 'soil-moisture-sensor',
    name: 'Resistive soil moisture sensor module',
    category: 'sensor',
    description:
      'Two-probe resistive soil moisture sensor with a comparator module providing an analog output (AO, more moisture = lower resistance = higher voltage) and a digital threshold output (DO). 3.3–5 V supply.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 15, maxMa: 35 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('AO', 'analog', 'output', { required: false, signal: 'Analog moisture level to an ADC pin', aliases: ['A0', 'ANALOG'] }),
      pin('DO', 'digital', 'output', { required: false, signal: 'Digital threshold output', aliases: ['D0', 'DIGITAL'] }),
    ],
    keywords: ['soil', 'moisture', 'plant', 'irrigation', 'water level', 'garden'],
    aliases: ['soil moisture sensor', 'soil sensor', 'moisture module'],
    simulator: { supported: false, notes: 'Represent as a potentiometer into an ADC pin.' },
    metadata: { electrical: true, corrosionNote: 'Resistive probes corrode quickly — sample infrequently and power the probe through a GPIO or transistor.' },
  }),

  def({
    id: 'mpu6050-imu',
    name: 'MPU6050 6-axis IMU (accelerometer + gyroscope)',
    category: 'sensor',
    description:
      'I2C 6-axis motion sensor (3-axis accelerometer ±2/4/8/16 g, 3-axis gyroscope ±250–2000 °/s) with a digital motion processor and programmable interrupt. Most breakouts include a 3.3 V regulator so they accept 5 V VCC while keeping 3.3 V logic. Default address 0x68 (0x69 with AD0 high).',
    voltage: 3.3,
    minVoltage: 3,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 3.9, maxMa: 5 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock', aliases: ['SCLK'] }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data', aliases: ['SDI'] }),
      pin('INT', 'digital', 'output', { required: false, signal: 'Data-ready / motion interrupt', aliases: ['IRQ'] }),
      pin('AD0', 'digital', 'input', { required: false, signal: 'Address select: LOW = 0x68, HIGH = 0x69' }),
    ],
    communicationProtocols: ['i2c'],
    keywords: ['mpu6050', 'imu', 'accelerometer', 'gyroscope', 'gyro', 'tilt', 'orientation', 'balance'],
    aliases: ['mpu6050', 'mpu 6050', 'imu', 'gyro accelerometer', '6-axis imu'],
    libraryRequirements: [
      { name: 'Adafruit MPU6050', import: 'Adafruit_MPU6050.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_MPU6050', purpose: 'MPU6050 register driver' },
      { name: 'Adafruit Unified Sensor', import: 'Adafruit_Sensor.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_Sensor', purpose: 'Dependency of the Adafruit sensor drivers' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    simulator: { supported: false, notes: 'Part id unverified — confirm before use.' },
    metadata: { electrical: true, i2cAddress: '0x68', i2cAddressAlt: '0x69', i2cMaxClockHz: 400000, logicVoltage: 3.3 },
  }),

  def({
    id: 'mq-2-gas-sensor',
    name: 'MQ-2 gas / smoke sensor module',
    category: 'sensor',
    description:
      'Heated tin-dioxide sensor for LPG, propane, hydrogen, methane and smoke. The module carries an on-board heater, a comparator with a digital output (DO) and an analog output (AO) for ppm estimation. 5 V supply, heater draws 150–800 mA and needs 24–48 h burn-in for stable readings.',
    voltage: 5,
    minVoltage: 5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 150, maxMa: 800, note: 'Heater current — cannot be powered from a 3.3 V MCU regulator pin.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('AO', 'analog', 'output', { required: false, signal: 'Analog gas concentration', aliases: ['A0', 'ANALOG'] }),
      pin('DO', 'digital', 'output', { required: false, signal: 'Digital threshold alarm (active low on most modules)', aliases: ['D0', 'DOUT'] }),
    ],
    keywords: ['mq-2', 'mq2', 'gas', 'smoke', 'lpg', 'air quality', 'flammable'],
    aliases: ['mq2', 'mq-2', 'mq series', 'gas sensor', 'smoke sensor'],
    simulator: { supported: false, notes: 'Represent as an analog source.' },
    metadata: { electrical: true, heaterCurrentMa: 800, burnInHours: 24, detectionPpm: { lpg: [300, 10000], smoke: [100, 1000] } },
  }),
];
