/**
 * Reference CAD assets used by the admin's studio renderer.
 *
 * A reference asset is deliberately separate from the generic parametric
 * fallback: the former is a known, component-specific assembly with many
 * meshes; the latter is generated only from an abstract component spec. This
 * lets the UI be honest about what is accurate while keeping every new spec
 * previewable immediately.
 */

import type { CadComponentSpec } from './types';

export interface CadReferenceAsset {
  /** Stable asset key. A spec can point here through `visualAsset.key`. */
  key: string;
  /** Public URL served by the Wireup app. */
  url: string;
  /** Human-facing source label used in the studio's provenance chip. */
  label: string;
  /** Short capability statement; do not imply a generated model is this accurate. */
  detail: string;
  /** Asset provenance / deployment reminder, surfaced by the admin only. */
  attribution: string;
}

/**
 * Known high-fidelity assemblies. Keep this intentionally small: a key enters
 * this registry only after its geometry and pin-anchor contract are reviewed.
 */
export const CAD_REFERENCE_ASSETS: Record<string, CadReferenceAsset> = {
  'arduino-uno-r3': {
    key: 'arduino-uno-r3',
    url: '/models3d/arduino-uno/arduino-uno.glb',
    label: 'Reference CAD assembly',
    detail: 'Multi-part Arduino Uno R3 assembly with board, headers, USB, jack, ICs and passives.',
    attribution: 'Mirrored from the vendored Velxio asset registry; review its AGPL/commercial licensing before a proprietary hosted release.',
  },
};

/** Resolve a reviewed asset for a component spec, if one exists. */
export function getCadReferenceAsset(spec: Pick<CadComponentSpec, 'id' | 'visualAsset'>): CadReferenceAsset | undefined {
  const key = spec.visualAsset?.key ?? spec.id;
  return CAD_REFERENCE_ASSETS[key];
}
