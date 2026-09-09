/**
 * cad-helper/catalog-link.ts
 *
 * The bridge between the WireUp component registry (`src/modules/components`)
 * and the CAD studio.
 *
 * Two things were previously disconnected:
 *
 *   1. the registry knew a part's electrical truth (pins, roles, voltages) but
 *      nothing about its geometry;
 *   2. the CAD presets knew geometry but were hand-authored, so a catalog part
 *      without a preset simply had no model and nobody could tell which ones.
 *
 * This module makes the relationship explicit and checkable:
 *
 *   - `specForCatalogComponent` returns the reviewed/authored preset when one
 *     exists, otherwise derives an honest parametric spec straight from the
 *     registry entry, so every catalog part is previewable and exportable;
 *   - `auditCatalogCadLink` reports coverage and, more importantly, *pin
 *     parity* — a model whose anchors disagree with the registry pin names
 *     would silently produce wrong wiring anchors, so it is flagged.
 *
 * Nothing here invents electrical data: a derived spec only re-expresses what
 * the registry already asserts, and it is always labelled `derived` so the UI
 * never presents it as a reviewed assembly.
 */

import type { ComponentDefinition, ComponentPin } from '@/types/component';
import { SEED_COMPONENTS } from '@/modules/components/catalog';

import { COMPONENT_PRESETS } from './datasheet-parser';
import { getCadReferenceAsset } from './reference-assets';
import type { CadComponentSpec, CadFeature, CadPinDefinition, ComponentRole, PinSignalRole } from './types';

/** How a spec came to exist. Surfaced in the studio so the tier is never implied. */
export type CadSpecTier = 'reference' | 'preset' | 'derived';

export interface LinkedCadSpec {
  spec: CadComponentSpec;
  tier: CadSpecTier;
  /** Catalog entry this spec is bound to, when the id exists in the registry. */
  component?: ComponentDefinition;
}

/* ------------------------------------------------------------------ *
 * Category / pin-role translation
 * ------------------------------------------------------------------ */

/** Registry category -> CAD studio role. */
export function cadRoleForCategory(category: ComponentDefinition['category']): ComponentRole {
  switch (category) {
    case 'microcontroller':
      return 'controller';
    case 'motor_driver':
      return 'driver';
    case 'motor':
    case 'actuator':
      return 'actuator';
    case 'sensor':
      return 'sensor';
    case 'communication':
      return 'communication';
    case 'display':
      return 'display';
    case 'power':
      return 'power';
    case 'passive':
    case 'electromechanical':
      return 'passive';
    case 'input_device':
      return 'input';
    case 'prototyping':
      return 'prototyping';
    default:
      return 'other';
  }
}

/** Registry pin type -> CAD signal role. */
export function cadPinRole(componentPin: ComponentPin): PinSignalRole {
  switch (componentPin.type) {
    case 'power':
      return 'power';
    case 'ground':
      return 'ground';
    case 'analog':
      return 'analog';
    case 'pwm':
      return 'pwm';
    case 'i2c':
      return 'i2c';
    case 'spi':
      return 'spi';
    case 'uart':
      return 'uart';
    case 'enable':
    case 'control':
      return 'control';
    case 'motor':
      // A motor terminal carries power, not logic: colour it as such in CAD.
      return 'power';
    case 'one_wire':
    case 'signal':
      return 'digital';
    default:
      return componentPin.direction === 'bidirectional' ? 'bidirectional' : 'digital';
  }
}

/* ------------------------------------------------------------------ *
 * Parametric derivation
 * ------------------------------------------------------------------ */

interface BodyProfile {
  widthMm: number;
  lengthMm: number;
  heightMm: number;
  bodyColor: string;
}

/**
 * Reasonable module envelopes per category. These are deliberately generic:
 * an exact envelope comes from a preset or a reviewed asset, and the studio
 * labels a derived spec as such.
 */
function bodyProfile(component: ComponentDefinition): BodyProfile {
  const declared = component.metadata?.dimensionsMm as
    | { width?: number; length?: number; height?: number }
    | undefined;

  const pinSpan = Math.max(component.pins.length, 2) * 2.54 + 5;

  const base: BodyProfile = (() => {
    switch (component.category) {
      case 'microcontroller':
        return { widthMm: Math.max(pinSpan / 2, 25), lengthMm: 55, heightMm: 1.6, bodyColor: '#0b4f9c' };
      case 'motor_driver':
        return { widthMm: Math.max(pinSpan / 2, 30), lengthMm: 30, heightMm: 1.6, bodyColor: '#b91c1c' };
      case 'motor':
        return { widthMm: 25, lengthMm: 40, heightMm: 20, bodyColor: '#1f2937' };
      case 'actuator':
        return { widthMm: 24, lengthMm: 30, heightMm: 12, bodyColor: '#334155' };
      case 'display':
        return { widthMm: 27, lengthMm: 27, heightMm: 1.6, bodyColor: '#0f172a' };
      case 'power':
        return { widthMm: 43, lengthMm: 21, heightMm: 1.6, bodyColor: '#15803d' };
      case 'communication':
        return { widthMm: 27, lengthMm: 17, heightMm: 1.6, bodyColor: '#1e3a8a' };
      case 'passive':
        return { widthMm: 8, lengthMm: 4, heightMm: 3, bodyColor: '#78350f' };
      case 'input_device':
        return { widthMm: 20, lengthMm: 16, heightMm: 1.6, bodyColor: '#1e293b' };
      case 'prototyping':
        return { widthMm: 165, lengthMm: 55, heightMm: 9, bodyColor: '#f8fafc' };
      default:
        return { widthMm: Math.max(pinSpan, 20), lengthMm: 20, heightMm: 1.6, bodyColor: '#1e3a8a' };
    }
  })();

  return {
    widthMm: Number(declared?.width ?? base.widthMm),
    lengthMm: Number(declared?.length ?? base.lengthMm),
    heightMm: Number(declared?.height ?? base.heightMm),
    bodyColor: base.bodyColor,
  };
}

/** Lay the registry pins out on one (or two) 2.54 mm headers along the body edge. */
function derivePins(component: ComponentDefinition, body: BodyProfile): CadPinDefinition[] {
  const pitch = 2.54;
  const perRow = Math.max(1, Math.min(component.pins.length, Math.floor((body.widthMm - 2) / pitch) || 1));
  const rows = Math.ceil(component.pins.length / perRow);
  const surfaceY = body.heightMm + 4.4;

  return component.pins.map((componentPin, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    const countInRow = Math.min(perRow, component.pins.length - row * perRow);
    const startX = -((countInRow - 1) * pitch) / 2;
    const rowZ = rows > 1 ? -body.lengthMm / 2 + 2.54 + row * pitch : -body.lengthMm / 2 + 2.54;

    return {
      name: componentPin.name,
      pinNumber: index + 1,
      role: cadPinRole(componentPin),
      signal: componentPin.signal ?? componentPin.description ?? `${componentPin.name} (${componentPin.type})`,
      xMm: Number((startX + column * pitch).toFixed(3)),
      yMm: Number(surfaceY.toFixed(3)),
      zMm: Number(rowZ.toFixed(3)),
      direction: 'up',
      ...(componentPin.aliases && componentPin.aliases.length ? { aliases: componentPin.aliases } : {}),
      required: componentPin.required,
    };
  });
}

/** Category-appropriate surface furniture so a derived preview is readable. */
function deriveFeatures(component: ComponentDefinition, body: BodyProfile, pins: CadPinDefinition[]): CadFeature[] {
  const features: CadFeature[] = [];
  const headerZ = pins[0]?.zMm ?? -body.lengthMm / 2 + 2.54;
  const headerWidth = Math.max(pins.length, 1) * 2.54;

  if (pins.length > 0) {
    features.push({
      name: 'header_block',
      type: 'header_block',
      dimensions: [Math.min(headerWidth, body.widthMm), 2.5, 2.5],
      position: [0, body.heightMm + 1.2, headerZ],
      color: '#111827',
    });
  }

  switch (component.category) {
    case 'motor':
      features.push({
        name: 'motor_can',
        type: 'cylinder',
        dimensions: [body.widthMm / 2, body.lengthMm * 0.7, 0],
        position: [0, body.heightMm + body.lengthMm * 0.35, 0],
        color: '#4b5563',
      });
      features.push({
        name: 'output_shaft',
        type: 'cylinder',
        dimensions: [2, 12, 0],
        position: [0, body.heightMm + body.lengthMm * 0.7 + 6, 0],
        color: '#cbd5e1',
      });
      break;
    case 'motor_driver':
      features.push({ name: 'bridge_ic', type: 'box', dimensions: [10, 2.5, 10], position: [0, body.heightMm + 1.4, 0], color: '#111827' });
      features.push({ name: 'heatsink', type: 'heatsink', dimensions: [body.widthMm * 0.5, body.lengthMm * 0.4, 10], position: [0, body.heightMm + 6, -body.lengthMm * 0.15], color: '#334155' });
      features.push({ name: 'screw_terminal', type: 'screw_terminal', dimensions: [12, 9, 8], position: [-body.widthMm / 2 + 7, body.heightMm + 4.5, body.lengthMm / 2 - 6], color: '#2563eb' });
      break;
    case 'display':
      features.push({ name: 'glass_panel', type: 'screen', dimensions: [body.widthMm * 0.85, 2, body.lengthMm * 0.5], position: [0, body.heightMm + 1.2, 2.5], color: '#090d16' });
      break;
    case 'power':
      features.push({ name: 'regulator_ic', type: 'box', dimensions: [8, 3, 6], position: [-body.widthMm * 0.2, body.heightMm + 1.8, 0], color: '#20242c' });
      features.push({ name: 'bulk_capacitor', type: 'cylinder', dimensions: [4, 10, 0], position: [body.widthMm * 0.2, body.heightMm + 5.2, 0], color: '#1e293b' });
      break;
    case 'sensor':
      features.push({ name: 'sensor_ic', type: 'box', dimensions: [5, 1.4, 5], position: [0, body.heightMm + 1.2, 1.5], color: '#18181b' });
      break;
    case 'communication':
      features.push({ name: 'rf_shield', type: 'box', dimensions: [body.widthMm * 0.5, 1.6, body.lengthMm * 0.4], position: [0, body.heightMm + 1.2, 1.0], color: '#94a3b8' });
      break;
    case 'actuator':
      features.push({ name: 'actuator_body', type: 'box', dimensions: [body.widthMm * 0.8, 10, body.lengthMm * 0.7], position: [0, body.heightMm + 5.5, 0], color: '#475569' });
      break;
    case 'input_device':
      features.push({ name: 'actuator_cap', type: 'potentiometer', dimensions: [6, 4, 6], position: [0, body.heightMm + 3, 1.5], color: '#e2e8f0' });
      break;
    default:
      features.push({ name: 'main_ic', type: 'box', dimensions: [6, 1.4, 6], position: [0, body.heightMm + 1.2, 0], color: '#18181b' });
  }

  return features;
}

/** Build a CAD spec purely from a registry entry (parametric, never "reviewed"). */
export function deriveSpecFromComponent(component: ComponentDefinition): CadComponentSpec {
  const body = bodyProfile(component);
  const pins = derivePins(component, body);

  return {
    id: component.id,
    name: component.name,
    category: cadRoleForCategory(component.category),
    description: component.description,
    voltage: component.voltage ?? component.minVoltage ?? 5,
    ...(component.minVoltage !== undefined ? { minVoltage: component.minVoltage } : {}),
    ...(component.maxVoltage !== undefined ? { maxVoltage: component.maxVoltage } : {}),
    currentMa: component.currentRequirements?.typicalMa ?? 20,
    dimensions: { widthMm: body.widthMm, lengthMm: body.lengthMm, heightMm: body.heightMm },
    bodyColor: body.bodyColor,
    pins,
    features: deriveFeatures(component, body, pins),
    protocols: component.communicationProtocols.length ? component.communicationProtocols : ['gpio'],
    keywords: component.keywords ?? [],
    aliases: component.aliases ?? [],
    ...(component.libraryRequirements && component.libraryRequirements.length
      ? {
          libraryRequirements: component.libraryRequirements
            .filter((library) => library.manager === 'arduino' || library.manager === 'platformio')
            .map((library) => ({
              name: library.name,
              import: library.import,
              manager: library.manager as 'arduino' | 'platformio',
              purpose: library.purpose,
            })),
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Resolution + audit
 * ------------------------------------------------------------------ */

function componentIndex(components: ComponentDefinition[]): Map<string, ComponentDefinition> {
  return new Map(components.map((component) => [component.id, component]));
}

/**
 * Resolve the best available CAD spec for a catalog id.
 * Preference: reviewed assembly > authored preset > derived from the registry.
 */
export function specForCatalogComponent(
  componentId: string,
  components: ComponentDefinition[] = SEED_COMPONENTS,
): LinkedCadSpec | undefined {
  const component = componentIndex(components).get(componentId);
  const preset = COMPONENT_PRESETS[componentId];

  if (preset) {
    const tier: CadSpecTier = getCadReferenceAsset(preset) ? 'reference' : 'preset';
    return { spec: preset, tier, ...(component ? { component } : {}) };
  }

  if (!component) return undefined;
  return { spec: deriveSpecFromComponent(component), tier: 'derived', component };
}

/** Every catalog part, each with the best model the studio can offer today. */
export function listLinkedSpecs(components: ComponentDefinition[] = SEED_COMPONENTS): LinkedCadSpec[] {
  return components
    .map((component) => specForCatalogComponent(component.id, components))
    .filter((entry): entry is LinkedCadSpec => Boolean(entry));
}

export interface CadLinkIssue {
  componentId: string;
  kind: 'missing-anchor' | 'extra-anchor' | 'orphan-preset' | 'role-mismatch' | 'pin-role-mismatch' | 'alias-collision';
  detail: string;
}

export interface CadLinkAudit {
  totalCatalogComponents: number;
  reference: number;
  preset: number;
  derived: number;
  /** Presets whose id is not in the registry — a model nothing can be wired to. */
  orphanPresets: string[];
  issues: CadLinkIssue[];
  ok: boolean;
}

function normalisePinName(name: string): string {
  return name.trim().toUpperCase().replace(/[\s_.-]/g, '');
}

/**
 * Compare every authored preset against its registry entry.
 *
 * The contract that matters is the *anchor contract*: the wiring layer looks up
 * a catalog pin name and expects a CAD anchor with that name (or one of the
 * registry aliases). A drift here produces confidently-wrong 3D wiring, so it
 * is reported rather than silently tolerated.
 */
/**
 * Registry pin types whose CAD role is legitimately one-to-many.
 *
 * An `enable` pin is the clear case: the L298N's ENA takes a PWM duty cycle for
 * speed, while the TB6612's STBY is a plain logic gate. Both are `enable` in the
 * registry, and forcing a single CAD role would be false precision. Anything not
 * listed here must match `cadPinRole()` exactly.
 */
const CAD_ROLE_TOLERANCE: Partial<Record<ComponentPin['type'], PinSignalRole[]>> = {
  enable: ['control', 'pwm', 'digital'],
  control: ['control', 'digital'],
  signal: ['digital', 'analog'],
  motor: ['power'],
};

function cadRoleAcceptable(componentPin: ComponentPin, actual: PinSignalRole): boolean {
  if (actual === cadPinRole(componentPin)) return true;
  return (CAD_ROLE_TOLERANCE[componentPin.type] ?? []).includes(actual);
}

/**
 * Aliases that resolve to more than one part.
 *
 * `matchComponent()` returns on the first exact alias hit, so a duplicated alias
 * means catalog *file order* silently decides which part a user gets. That is
 * how "piezo buzzer" could resolve to the active buzzer (digitalWrite) or the
 * passive one (tone()) — different firmware, no warning. Detected here because
 * this is the module that already owns cross-catalog consistency.
 */
export function findAliasCollisions(components: ComponentDefinition[] = SEED_COMPONENTS): CadLinkIssue[] {
  const byTerm = new Map<string, Set<string>>();
  for (const component of components) {
    for (const term of [component.name, ...(component.aliases ?? [])]) {
      const key = term.toLowerCase().trim();
      if (!key) continue;
      const bucket = byTerm.get(key) ?? new Set<string>();
      bucket.add(component.id);
      byTerm.set(key, bucket);
    }
  }

  const issues: CadLinkIssue[] = [];
  for (const [term, ids] of byTerm) {
    if (ids.size < 2) continue;
    const owners = [...ids].sort();
    issues.push({
      componentId: owners[0],
      kind: 'alias-collision',
      detail: `alias "${term}" also resolves to ${owners.slice(1).join(', ')} — catalog order would decide the match`,
    });
  }
  return issues;
}

export function auditCatalogCadLink(components: ComponentDefinition[] = SEED_COMPONENTS): CadLinkAudit {
  const index = componentIndex(components);
  const issues: CadLinkIssue[] = [];
  const orphanPresets: string[] = [];

  let reference = 0;
  let preset = 0;
  let derived = 0;

  for (const [presetId, presetSpec] of Object.entries(COMPONENT_PRESETS)) {
    const component = index.get(presetId);
    if (!component) {
      orphanPresets.push(presetId);
      issues.push({
        componentId: presetId,
        kind: 'orphan-preset',
        detail: 'CAD preset has no matching component-registry entry, so nothing in a project can reference it.',
      });
      continue;
    }

    const anchorNames = new Set(presetSpec.pins.map((entry) => normalisePinName(entry.name)));
    const anchorAliases = new Set(
      presetSpec.pins.flatMap((entry) => (entry.aliases ?? []).map(normalisePinName)),
    );

    for (const componentPin of component.pins) {
      const wanted = normalisePinName(componentPin.name);
      const aliasHit = (componentPin.aliases ?? []).some(
        (alias) => anchorNames.has(normalisePinName(alias)) || anchorAliases.has(normalisePinName(alias)),
      );
      if (!anchorNames.has(wanted) && !anchorAliases.has(wanted) && !aliasHit) {
        issues.push({
          componentId: presetId,
          kind: 'missing-anchor',
          detail: `registry pin "${componentPin.name}" has no CAD anchor`,
        });
      }
    }

    const registryNames = new Set(component.pins.map((entry) => normalisePinName(entry.name)));
    const registryAliases = new Set(component.pins.flatMap((entry) => (entry.aliases ?? []).map(normalisePinName)));
    for (const anchor of presetSpec.pins) {
      const anchorName = normalisePinName(anchor.name);
      const aliasHit = (anchor.aliases ?? []).some(
        (alias) => registryNames.has(normalisePinName(alias)) || registryAliases.has(normalisePinName(alias)),
      );
      if (!registryNames.has(anchorName) && !registryAliases.has(anchorName) && !aliasHit) {
        issues.push({
          componentId: presetId,
          kind: 'extra-anchor',
          detail: `CAD anchor "${anchor.name}" does not exist on the registry part`,
        });
      }
    }

    for (const componentPin of component.pins) {
      const anchor = presetSpec.pins.find((entry) => normalisePinName(entry.name) === normalisePinName(componentPin.name));
      if (anchor && !cadRoleAcceptable(componentPin, anchor.role)) {
        issues.push({
          componentId: presetId,
          kind: 'pin-role-mismatch',
          detail: `pin "${componentPin.name}": registry type "${componentPin.type}" implies CAD role "${cadPinRole(componentPin)}", model says "${anchor.role}"`,
        });
      }
    }

    const expectedRole = cadRoleForCategory(component.category);
    if (presetSpec.category !== expectedRole) {
      issues.push({
        componentId: presetId,
        kind: 'role-mismatch',
        detail: `preset role "${presetSpec.category}" vs registry category "${component.category}" (expected "${expectedRole}")`,
      });
    }

    if (getCadReferenceAsset(presetSpec)) reference += 1;
    else preset += 1;
  }

  for (const component of components) {
    if (!COMPONENT_PRESETS[component.id]) derived += 1;
  }

  issues.push(...findAliasCollisions(components));

  return {
    totalCatalogComponents: components.length,
    reference,
    preset,
    derived,
    orphanPresets,
    issues,
    ok: issues.length === 0,
  };
}
