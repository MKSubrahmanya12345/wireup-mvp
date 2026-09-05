/** Display seed entries. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const DISPLAYS: ComponentDefinition[] = [
  def({
    id: 'lcd-1602-i2c',
    name: '1602 LCD with I2C backpack (PCF8574)',
    category: 'display',
    description:
      '16x2 character LCD on a PCF8574 I2C backpack. Only four wires are needed (VCC, GND, SDA, SCL). Default address 0x27 (some backpacks use 0x3F), 5 V supply with a contrast trimmer and backlight jumper.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 20, maxMa: 40, note: 'Backlight dominates; ~2 mA with the backlight off.' },
    communicationProtocols: ['i2c'],
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data', aliases: ['D', 'SDI'] }),
      pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock', aliases: ['C', 'SCK'] }),
    ],
    libraryRequirements: [
      { name: 'LiquidCrystal I2C', import: 'LiquidCrystal_I2C.h', manager: 'arduino', repository: 'https://github.com/johnrickman/LiquidCrystal_I2C', purpose: 'PCF8574 backpack driver for HD44780 LCDs' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    keywords: ['lcd', '1602', 'display', 'i2c lcd', 'character lcd', 'screen', 'text display'],
    aliases: ['lcd1602', '16x2 lcd', 'lcd display', 'i2c lcd'],
    simulator: { part: 'wokwi-lcd1602', supported: true, attrs: {} },
    metadata: { electrical: true, i2cAddress: '0x27', i2cAddressAlt: '0x3F', columns: 16, rows: 2 },
  }),

  def({
    id: 'oled-ssd1306-i2c',
    name: '0.96" SSD1306 OLED display (I2C)',
    category: 'display',
    description:
      '128x64 monochrome OLED driven by an SSD1306 over I2C. Works from 3.3 V or 5 V, draws ~20 mA, and needs only four wires. Default address 0x3C.',
    voltage: 5,
    minVoltage: 3,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 20, maxMa: 25 },
    communicationProtocols: ['i2c'],
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, minVoltage: 3, maxVoltage: 5.5, aliases: ['+', 'V+', 'VIN', 'VDD'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('SCL', 'i2c', 'input', { required: true, aliases: ['C', 'D0'] }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, aliases: ['D', 'D1'] }),
    ],
    libraryRequirements: [
      { name: 'Adafruit SSD1306', import: 'Adafruit_SSD1306.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_SSD1306', purpose: 'SSD1306 OLED driver' },
      { name: 'Adafruit GFX Library', import: 'Adafruit_GFX.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit-GFX-Library', purpose: 'Graphics primitives required by the SSD1306 driver' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    keywords: ['oled', 'ssd1306', 'display', 'i2c display', 'graphics', 'screen'],
    aliases: ['ssd1306', 'oled display', '0.96 oled', 'i2c oled'],
    simulator: { part: 'wokwi-ssd1306', supported: true, attrs: { i2cAddress: '0x3C' }, notes: 'Wokwi pins: DATA (SDA), CLK (SCL), VIN, GND, 3V3.' },
    metadata: { electrical: true, i2cAddress: '0x3C', resolution: '128x64', logicVoltage: 3.3, wideSupplyRange: true, fiveVoltTolerant: true },
  }),
];
