/**
 * cad-helper/types.ts
 * Type definitions for CAD model generation, datasheet extraction,
 * 3D mesh building (STL/GLB), and Velxio/WireUp integration.
 */

export type ComponentRole =
  | 'controller'
  | 'driver'
  | 'power'
  | 'communication'
  | 'sensor'
  | 'actuator'
  | 'display'
  | 'input'
  | 'passive'
  | 'prototyping'
  | 'other';

export type PinSignalRole =
  | 'power'
  | 'ground'
  | 'digital'
  | 'analog'
  | 'i2c'
  | 'spi'
  | 'uart'
  | 'pwm'
  | 'control'
  | 'bidirectional';

export interface CadPinDefinition {
  /** Canonical pin name matching Wokwi/Velxio contract (e.g. "VCC", "GND", "SDA", "TRIG") */
  name: string;
  /** Numerical index or pin order (1-based or 0-based) */
  pinNumber: number;
  /** Electrical signal function */
  role: PinSignalRole;
  /** Standard voltage level or signal description */
  signal: string;
  /** X position in 3D CAD space (millimeters) */
  xMm: number;
  /** Y position in 3D CAD space (height/upwards in millimeters) */
  yMm: number;
  /** Z position in 3D CAD space (millimeters) */
  zMm: number;
  /** Direction the pin extends: 'up' (+Y), 'down' (-Y), 'left' (-X), 'right' (+X), 'front' (+Z), 'back' (-Z) */
  direction?: 'up' | 'down' | 'left' | 'right' | 'front' | 'back';
  /** Optional aliases (e.g. ["3.3V", "V+"] for "3V3") */
  aliases?: string[];
  /** Is this pin strictly required for operation? */
  required?: boolean;
}

export type FeatureType =
  | 'box'
  | 'cylinder'
  | 'screen'
  | 'header_block'
  | 'led'
  | 'screw_terminal'
  | 'lens'
  | 'potentiometer'
  | 'heatsink';

export interface CadFeature {
  name: string;
  type: FeatureType;
  /** [width, height, depth] or [radius, height, 0] for cylinder */
  dimensions: [number, number, number];
  /** [x, y, z] center position in millimeters relative to component origin */
  position: [number, number, number];
  /** Hex color or semantic color (e.g. "#1e3a8a", "#d97706", "#22c55e", "#111827", "#cbd5e1") */
  color?: string;
  /** Optional rotation in degrees [rotX, rotY, rotZ] */
  rotation?: [number, number, number];
}

export interface CadDimensions {
  /** PCB / main body width (X axis) in mm */
  widthMm: number;
  /** PCB / main body length (Z axis) in mm */
  lengthMm: number;
  /** PCB / main body height/thickness (Y axis) in mm */
  heightMm: number;
}

export interface CadComponentSpec {
  /** Unique catalog identifier (e.g. "hc-sr04-ultrasonic", "oled-ssd1306-i2c") */
  id: string;
  /** Human-readable component name */
  name: string;
  /** Functional category / role */
  category: ComponentRole;
  /** Brief technical summary */
  description: string;
  /** Typical operating logic voltage (e.g. 3.3 or 5.0) */
  voltage: number;
  /** Minimum operating voltage */
  minVoltage?: number;
  /** Maximum operating voltage */
  maxVoltage?: number;
  /** Current draw in mA */
  currentMa: number;
  /** Base body / PCB dimensions in mm */
  dimensions: CadDimensions;
  /** Main substrate / housing color (Hex or CSS format) */
  bodyColor?: string;
  /** List of connector pins with exact XYZ CAD positions */
  pins: CadPinDefinition[];
  /** 3D decorative / functional surface elements */
  features: CadFeature[];
  /** Communication protocols supported */
  protocols: string[];
  /** Search keywords */
  keywords: string[];
  /** Alternative names */
  aliases: string[];
  /** Library dependencies for firmware */
  libraryRequirements?: Array<{
    name: string;
    import: string;
    manager: 'arduino' | 'platformio';
    purpose: string;
  }>;
}

export interface GeneratedCadOutput {
  spec: CadComponentSpec;
  /** ASCII STL format string */
  stlAscii: string;
  /** Binary STL byte buffer */
  stlBinary: Buffer;
  /** GLTF 2.0 Binary (.glb) byte buffer with injected pin empty nodes */
  glbBinary: Buffer;
  /** TypeScript seed code snippet for WireUp component catalog */
  seedCode: string;
  /** Velxio manifest.json snippet */
  manifestEntry: {
    file: string;
    pinNodes: string[];
    bench: {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: number;
    };
  };
}

export interface DeploymentResult {
  success: boolean;
  key: string;
  glbPath: string;
  stlPath: string;
  manifestUpdated: boolean;
  seedUpdated: boolean;
  message: string;
}
