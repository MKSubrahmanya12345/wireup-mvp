/**
 * cadTypes — the subset of Wireup's `cad-helper/types.ts` the 3D scene needs
 * to render a catalog part's spec as geometry.
 *
 * This is a deliberate copy, not an import: `external/velxio` is a vendored,
 * independently-buildable app (its own package.json, its own tsconfig, its
 * own Vite program) and the root Next.js tsconfig explicitly excludes
 * `external` from its TS program, so there is no module boundary to import
 * across. Keeping the shape identical to `cad-helper/types.ts` means the
 * `/cad-catalog.json` file produced by
 * `scripts/export-cad-catalog-to-velxio.ts` deserializes here without any
 * translation step — if the two ever drift, a shape mismatch is a build-time
 * type error, not a silent runtime one.
 */

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
  name: string;
  pinNumber: number;
  role: PinSignalRole;
  signal: string;
  xMm: number;
  yMm: number;
  zMm: number;
  direction?: 'up' | 'down' | 'left' | 'right' | 'front' | 'back';
  aliases?: string[];
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
  dimensions: [number, number, number];
  position: [number, number, number];
  color?: string;
  rotation?: [number, number, number];
}

export interface CadDimensions {
  widthMm: number;
  lengthMm: number;
  heightMm: number;
}

export type CadBodyStyle = 'pcb' | 'enclosure' | 'discrete' | 'none';
export type CadPinStyle = 'headers' | 'leads' | 'pads' | 'none';

export interface CadComponentSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  bodyStyle?: CadBodyStyle;
  pinStyle?: CadPinStyle;
  voltage: number;
  minVoltage?: number;
  maxVoltage?: number;
  currentMa: number;
  dimensions: CadDimensions;
  bodyColor?: string;
  pins: CadPinDefinition[];
  features: CadFeature[];
  protocols: string[];
  keywords: string[];
  aliases: string[];
}

/** One entry of `/cad-catalog.json`, produced by
 *  `scripts/export-cad-catalog-to-velxio.ts`. */
export interface CadCatalogEntry {
  /** The Wireup catalog id this spec was derived from (for provenance only). */
  catalogId: string;
  /** Whether this instance key names a board or a part. */
  kind: 'board' | 'part';
  /** Tier the spec came from — never presented as more accurate than it is. */
  tier: 'reference' | 'preset' | 'derived';
  spec: CadComponentSpec;
}

export interface CadCatalogManifest {
  version: number;
  generatedAt: string;
  /** Keyed the same way Velxio keys 3D models: board -> boardKind, part ->
   *  metadataId. Matches `models3d/manifest.json`'s key space exactly. */
  entries: Record<string, CadCatalogEntry>;
}
