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
import type { CadBodyStyle, CadComponentSpec, CadFeature, CadPinDefinition, CadPinStyle, ComponentRole, PinSignalRole } from './types';

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
  bodyStyle?: CadBodyStyle;
  pinStyle?: CadPinStyle;
}

const DATA_ENRICHED_PROFILES: Record<string, BodyProfile> = {
  // Package-aware fallbacks from common vendor / module datasheets. These are
  // not reviewed STEP models, but they stop loose parts from being rendered as
  // generic blue boards.
  'led-5mm': { widthMm: 5.0, lengthMm: 5.0, heightMm: 8.6, bodyColor: '#ef4444', bodyStyle: 'none', pinStyle: 'leads' },
  'rgb-led-common-cathode': { widthMm: 5.0, lengthMm: 5.0, heightMm: 8.6, bodyColor: '#f8fafc', bodyStyle: 'none', pinStyle: 'leads' },
  'resistor-220ohm': { widthMm: 17.0, lengthMm: 2.5, heightMm: 2.5, bodyColor: '#d6b47a', bodyStyle: 'none', pinStyle: 'leads' },
  'resistor-1kohm': { widthMm: 17.0, lengthMm: 2.5, heightMm: 2.5, bodyColor: '#d6b47a', bodyStyle: 'none', pinStyle: 'leads' },
  'resistor-10kohm': { widthMm: 17.0, lengthMm: 2.5, heightMm: 2.5, bodyColor: '#d6b47a', bodyStyle: 'none', pinStyle: 'leads' },
  'capacitor-100nf-ceramic': { widthMm: 5.2, lengthMm: 2.8, heightMm: 5.0, bodyColor: '#d97706', bodyStyle: 'none', pinStyle: 'leads' },
  'capacitor-1000uf-electrolytic': { widthMm: 10.0, lengthMm: 10.0, heightMm: 20.0, bodyColor: '#1f2937', bodyStyle: 'none', pinStyle: 'leads' },
  'diode-1n4007': { widthMm: 12.0, lengthMm: 2.8, heightMm: 2.8, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'buzzer-active-5v': { widthMm: 12.0, lengthMm: 12.0, heightMm: 9.5, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'buzzer-passive': { widthMm: 12.0, lengthMm: 12.0, heightMm: 7.5, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'relay-module-5v-1ch': { widthMm: 50.0, lengthMm: 26.0, heightMm: 1.6, bodyColor: '#14532d', pinStyle: 'headers' },
  'neopixel-ws2812b-strip': { widthMm: 60.0, lengthMm: 10.0, heightMm: 1.0, bodyColor: '#f8fafc', pinStyle: 'headers' },
  'pushbutton-6mm': { widthMm: 6.0, lengthMm: 6.0, heightMm: 5.0, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'toggle-switch-spdt': { widthMm: 12.7, lengthMm: 6.6, heightMm: 8.0, bodyColor: '#1f2937', bodyStyle: 'none', pinStyle: 'leads' },
  'limit-switch-microswitch': { widthMm: 20.0, lengthMm: 10.0, heightMm: 6.5, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'potentiometer-10k': { widthMm: 17.0, lengthMm: 17.0, heightMm: 10.0, bodyColor: '#2563eb', bodyStyle: 'none', pinStyle: 'leads' },
  'keypad-4x4-membrane': { widthMm: 70.0, lengthMm: 77.0, heightMm: 0.8, bodyColor: '#e5e7eb', pinStyle: 'pads' },
  'dht11-temperature-humidity': { widthMm: 15.5, lengthMm: 12.0, heightMm: 5.5, bodyColor: '#2563eb', bodyStyle: 'none', pinStyle: 'leads' },
  'dht22-temperature-humidity': { widthMm: 28.0, lengthMm: 12.0, heightMm: 8.0, bodyColor: '#f8fafc', bodyStyle: 'none', pinStyle: 'leads' },
  'ldr-photoresistor': { widthMm: 5.0, lengthMm: 5.0, heightMm: 2.0, bodyColor: '#eab308', bodyStyle: 'none', pinStyle: 'leads' },
  'ir-receiver-tsop38238': { widthMm: 6.9, lengthMm: 5.6, heightMm: 5.3, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'ir-obstacle-sensor': { widthMm: 32.0, lengthMm: 14.0, heightMm: 1.6, bodyColor: '#1e3a8a', pinStyle: 'headers' },
  'soil-moisture-sensor': { widthMm: 60.0, lengthMm: 20.0, heightMm: 1.6, bodyColor: '#14532d', pinStyle: 'headers' },
  'mq-2-gas-sensor': { widthMm: 32.0, lengthMm: 20.0, heightMm: 1.6, bodyColor: '#1e3a8a', pinStyle: 'headers' },
  'load-cell-hx711': { widthMm: 34.0, lengthMm: 20.0, heightMm: 1.6, bodyColor: '#7c3aed', pinStyle: 'headers' },
  'bh1750-light-sensor': { widthMm: 21.0, lengthMm: 16.0, heightMm: 1.6, bodyColor: '#7c3aed', pinStyle: 'headers' },
  'ina219-current-sensor': { widthMm: 25.0, lengthMm: 22.0, heightMm: 1.6, bodyColor: '#1e40af', pinStyle: 'headers' },
  'lcd-1602-i2c': { widthMm: 80.0, lengthMm: 36.0, heightMm: 1.6, bodyColor: '#14532d', pinStyle: 'headers' },
  'hc-05-bluetooth': { widthMm: 37.3, lengthMm: 15.5, heightMm: 1.6, bodyColor: '#14532d', pinStyle: 'headers' },
  'hc-06-bluetooth': { widthMm: 37.3, lengthMm: 15.5, heightMm: 1.6, bodyColor: '#14532d', pinStyle: 'headers' },
  'esp8266-esp01-wifi': { widthMm: 24.8, lengthMm: 14.3, heightMm: 1.2, bodyColor: '#123b73', pinStyle: 'headers' },
  'esp32-devkit-v1': { widthMm: 51.4, lengthMm: 28.5, heightMm: 1.6, bodyColor: '#0b4f9c', pinStyle: 'headers' },
  'arduino-nano': { widthMm: 45.0, lengthMm: 18.0, heightMm: 1.6, bodyColor: '#0b4f9c', pinStyle: 'headers' },
  'joystick-module-2axis': { widthMm: 26.0, lengthMm: 34.0, heightMm: 1.6, bodyColor: '#1e3a8a', pinStyle: 'headers' },
  'battery-9v': { widthMm: 26.5, lengthMm: 17.5, heightMm: 48.5, bodyColor: '#334155', bodyStyle: 'none', pinStyle: 'leads' },
  'battery-2s-lipo': { widthMm: 65.0, lengthMm: 35.0, heightMm: 12.0, bodyColor: '#475569', bodyStyle: 'none', pinStyle: 'leads' },
  'battery-holder-4xaa': { widthMm: 63.0, lengthMm: 58.0, heightMm: 17.0, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'breadboard-power-module-mb102': { widthMm: 53.0, lengthMm: 32.0, heightMm: 1.6, bodyColor: '#1e40af', pinStyle: 'headers' },
  'regulator-lm7805': { widthMm: 10.0, lengthMm: 4.6, heightMm: 9.2, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'leads' },
  'regulator-ams1117-3v3': { widthMm: 16.0, lengthMm: 12.0, heightMm: 1.6, bodyColor: '#15803d', pinStyle: 'headers' },
  'buck-converter-lm2596': { widthMm: 43.0, lengthMm: 21.0, heightMm: 1.6, bodyColor: '#1e40af', pinStyle: 'headers' },
  'logic-level-shifter-4ch': { widthMm: 16.0, lengthMm: 13.0, heightMm: 1.6, bodyColor: '#dc2626', pinStyle: 'headers' },
  'breadboard-830': { widthMm: 165.0, lengthMm: 55.0, heightMm: 9.0, bodyColor: '#f8fafc', pinStyle: 'pads' },
  'jumper-wires-kit': { widthMm: 24.0, lengthMm: 42.0, heightMm: 8.0, bodyColor: '#475569', bodyStyle: 'none', pinStyle: 'none' },
  'propeller-ep-1045-two-blade': { widthMm: 254.0, lengthMm: 254.0, heightMm: 8.0, bodyColor: '#111827', bodyStyle: 'none', pinStyle: 'none' },
};

function resistorBandColours(componentId: string): string[] {
  if (componentId.includes('220')) return ['#ef4444', '#ef4444', '#7c2d12', '#d4af37'];
  if (componentId.includes('10k')) return ['#7c2d12', '#111827', '#f97316', '#d4af37'];
  return ['#7c2d12', '#111827', '#ef4444', '#d4af37'];
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

  const curated = DATA_ENRICHED_PROFILES[component.id];
  if (curated) {
    return {
      ...curated,
      widthMm: Number(declared?.width ?? curated.widthMm),
      lengthMm: Number(declared?.length ?? curated.lengthMm),
      heightMm: Number(declared?.height ?? curated.heightMm),
    };
  }

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
  const makePin = (
    componentPin: ComponentPin,
    index: number,
    position: Pick<CadPinDefinition, 'xMm' | 'yMm' | 'zMm' | 'direction'>,
  ): CadPinDefinition => ({
    name: componentPin.name,
    pinNumber: index + 1,
    role: cadPinRole(componentPin),
    signal: componentPin.signal ?? componentPin.description ?? `${componentPin.name} (${componentPin.type})`,
    ...position,
    ...(componentPin.aliases && componentPin.aliases.length ? { aliases: componentPin.aliases } : {}),
    required: componentPin.required,
  });

  if (component.id === 'led-5mm') {
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: index === 0 ? -1.27 : 1.27,
      yMm: -body.heightMm / 2,
      zMm: 0,
      direction: 'down',
    }));
  }

  if (component.id === 'rgb-led-common-cathode') {
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: Number((-3.81 + index * pitch).toFixed(3)),
      yMm: -body.heightMm / 2,
      zMm: 0,
      direction: 'down',
    }));
  }

  if (component.id.startsWith('resistor-') || component.id === 'diode-1n4007') {
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: index === 0 ? -3.4 : 3.4,
      yMm: 0,
      zMm: 0,
      direction: index === 0 ? 'left' : 'right',
    }));
  }

  if (component.id === 'capacitor-100nf-ceramic' || component.id === 'capacitor-1000uf-electrolytic' || component.id.includes('buzzer')) {
    const startX = -((component.pins.length - 1) * pitch) / 2;
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: Number((startX + index * pitch).toFixed(3)),
      yMm: -body.heightMm / 2,
      zMm: 0,
      direction: 'down',
    }));
  }

  if (component.id === 'pushbutton-6mm' || component.id === 'toggle-switch-spdt' || component.id === 'limit-switch-microswitch') {
    const startX = -((component.pins.length - 1) * pitch) / 2;
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: Number((startX + index * pitch).toFixed(3)),
      yMm: -body.heightMm / 2,
      zMm: body.lengthMm / 2 - 1.2,
      direction: 'down',
    }));
  }

  if (component.id === 'keypad-4x4-membrane') {
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: Number((-8.89 + index * pitch).toFixed(3)),
      yMm: body.heightMm + 0.08,
      zMm: -body.lengthMm / 2 - 1.2,
      direction: 'front',
    }));
  }

  if (component.id === 'battery-9v') {
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: index === 0 ? -5.0 : 5.0,
      yMm: body.heightMm / 2 + 0.6,
      zMm: 0,
      direction: 'up',
    }));
  }

  if (component.id === 'battery-2s-lipo' || component.id === 'battery-holder-4xaa') {
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: index === 0 ? -4.0 : 4.0,
      yMm: 0,
      zMm: body.lengthMm / 2,
      direction: 'front',
    }));
  }

  if (body.pinStyle === 'leads') {
    const startX = -((component.pins.length - 1) * pitch) / 2;
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: Number((startX + index * pitch).toFixed(3)),
      yMm: -body.heightMm / 2,
      zMm: 0,
      direction: 'down',
    }));
  }

  if (component.id === 'breadboard-830') {
    return component.pins.map((componentPin, index) => makePin(componentPin, index, {
      xMm: index === 0 ? -body.widthMm / 2 + 7 : index === 1 ? body.widthMm / 2 - 7 : 0,
      yMm: body.heightMm + 0.25,
      zMm: index === 0 ? body.lengthMm / 2 - 5 : index === 1 ? -body.lengthMm / 2 + 5 : 0,
      direction: 'up',
    }));
  }

  const perRow = Math.max(1, Math.min(component.pins.length, Math.floor((body.widthMm - 2) / pitch) || 1));
  const rows = Math.ceil(component.pins.length / perRow);
  const surfaceY = body.heightMm + 4.4;

  return component.pins.map((componentPin, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    const countInRow = Math.min(perRow, component.pins.length - row * perRow);
    const startX = -((countInRow - 1) * pitch) / 2;
    const rowZ = rows > 1 ? -body.lengthMm / 2 + 2.54 + row * pitch : -body.lengthMm / 2 + 2.54;

    return makePin(componentPin, index, {
      xMm: Number((startX + column * pitch).toFixed(3)),
      yMm: Number(surfaceY.toFixed(3)),
      zMm: Number(rowZ.toFixed(3)),
      direction: 'up',
    });
  });
}

/** Category-appropriate surface furniture so a derived preview is readable. */
function deriveFeatures(component: ComponentDefinition, body: BodyProfile, pins: CadPinDefinition[]): CadFeature[] {
  const features: CadFeature[] = [];
  const headerZ = pins[0]?.zMm ?? -body.lengthMm / 2 + 2.54;
  const headerWidth = Math.max(pins.length, 1) * 2.54;

  if (component.id === 'led-5mm') {
    return [
      { name: 'diffused_5mm_epoxy_lens', type: 'led', dimensions: [5.0, 8.6, 5.0], position: [0, 0, 0], color: '#ef4444' },
      { name: 'anode_bond_wire', type: 'cylinder', dimensions: [0.08, 3.1, 0], position: [-0.9, -1.2, 0.05], color: '#facc15' },
      { name: 'cathode_bond_wire', type: 'cylinder', dimensions: [0.08, 2.4, 0], position: [0.9, -1.55, 0.05], color: '#facc15' },
    ];
  }

  if (component.id === 'rgb-led-common-cathode') {
    return [
      { name: 'clear_5mm_rgb_epoxy_lens', type: 'led', dimensions: [5.0, 8.6, 5.0], position: [0, 0, 0], color: '#e0f2fe' },
      { name: 'red_die', type: 'led', dimensions: [0.85, 0.5, 0.85], position: [-1.25, -2.0, 0.25], color: '#ef4444' },
      { name: 'green_die', type: 'led', dimensions: [0.85, 0.5, 0.85], position: [0, -2.0, 0.25], color: '#22c55e' },
      { name: 'blue_die', type: 'led', dimensions: [0.85, 0.5, 0.85], position: [1.25, -2.0, 0.25], color: '#3b82f6' },
    ];
  }

  if (component.id.startsWith('resistor-')) {
    const bandColours = resistorBandColours(component.id);
    return [
      { name: 'axial_resistor_body', type: 'cylinder', dimensions: [1.25, 6.4, 0], position: [0, 0, 0], rotation: [0, 0, 90], color: '#d6b47a' },
      ...bandColours.map((color, index) => ({
        name: `colour_band_${index + 1}`,
        type: 'cylinder' as const,
        dimensions: [1.31, 0.34, 0] as [number, number, number],
        position: [-2.05 + index * 0.78, 0, 0] as [number, number, number],
        rotation: [0, 0, 90] as [number, number, number],
        color,
      })),
    ];
  }

  if (component.id === 'diode-1n4007') {
    return [
      { name: 'do41_diode_body', type: 'cylinder', dimensions: [1.35, 5.2, 0], position: [0, 0, 0], rotation: [0, 0, 90], color: '#111827' },
      { name: 'cathode_silver_band', type: 'cylinder', dimensions: [1.42, 0.46, 0], position: [2.0, 0, 0], rotation: [0, 0, 90], color: '#d1d5db' },
    ];
  }

  if (component.id === 'capacitor-100nf-ceramic') {
    return [
      { name: 'ceramic_disc_body', type: 'box', dimensions: [5.2, 5.0, 2.2], position: [0, 0, 0], color: '#d97706' },
      { name: 'dielectric_marking', type: 'box', dimensions: [3.5, 0.05, 1.8], position: [0, 1.2, 1.13], color: '#78350f' },
    ];
  }

  if (component.id === 'capacitor-1000uf-electrolytic') {
    return [
      { name: 'electrolytic_can', type: 'cylinder', dimensions: [5.0, 20.0, 0], position: [0, 0, 0], color: '#1f2937' },
      { name: 'negative_polarity_stripe', type: 'box', dimensions: [1.1, 18.0, 0.08], position: [4.3, 0, 0], color: '#e5e7eb' },
      { name: 'rubber_bung', type: 'cylinder', dimensions: [4.8, 0.5, 0], position: [0, -10.0, 0], color: '#0f172a' },
    ];
  }

  if (component.id.includes('buzzer')) {
    return [
      { name: 'piezo_buzzer_can', type: 'cylinder', dimensions: [body.widthMm / 2, body.heightMm, 0], position: [0, 0, 0], color: '#111827' },
      { name: 'sound_port', type: 'cylinder', dimensions: [1.55, 0.18, 0], position: [0, body.heightMm / 2 + 0.05, 0], color: '#020617' },
      { name: component.id === 'buzzer-active-5v' ? 'active_driver_mark' : 'passive_piezo_mark', type: 'box', dimensions: [5.5, 0.08, 1.0], position: [0, body.heightMm / 2 + 0.1, -3.2], color: component.id === 'buzzer-active-5v' ? '#22c55e' : '#f97316' },
    ];
  }

  if (component.id === 'pushbutton-6mm') {
    return [
      { name: 'tactile_switch_base', type: 'box', dimensions: [6.0, 3.0, 6.0], position: [0, -0.3, 0], color: '#111827' },
      { name: 'round_button_cap', type: 'potentiometer', dimensions: [3.6, 2.8, 3.6], position: [0, 2.6, 0], color: '#e5e7eb' },
    ];
  }

  if (component.id === 'toggle-switch-spdt') {
    return [
      { name: 'switch_body', type: 'box', dimensions: [12.7, 4.8, 6.6], position: [0, 0, 0], color: '#1f2937' },
      { name: 'metal_toggle_lever', type: 'cylinder', dimensions: [0.7, 8.0, 0], position: [0, 5.0, 0], rotation: [0, 0, -18], color: '#cbd5e1' },
    ];
  }

  if (component.id === 'limit-switch-microswitch') {
    return [
      { name: 'microswitch_case', type: 'box', dimensions: [20.0, 6.5, 10.0], position: [0, 0, 0], color: '#111827' },
      { name: 'roller_lever', type: 'box', dimensions: [18.0, 0.65, 2.0], position: [0, 4.6, -3.0], rotation: [0, 0, -12], color: '#d1d5db' },
      { name: 'roller', type: 'cylinder', dimensions: [1.8, 2.2, 0], position: [8.2, 5.7, -4.2], rotation: [90, 0, 0], color: '#94a3b8' },
    ];
  }

  if (component.id === 'lcd-1602-i2c') {
    return [
      { name: 'lcd_bezel', type: 'box', dimensions: [72.0, 6.5, 25.0], position: [0, body.heightMm + 3.4, 0], color: '#111827' },
      { name: 'green_lcd_glass', type: 'screen', dimensions: [64.5, 2.2, 16.0], position: [0, body.heightMm + 6.8, 0], color: '#7dd3a8' },
      { name: 'i2c_backpack_pcb', type: 'box', dimensions: [41.0, 1.4, 19.0], position: [0, -1.0, -3.0], color: '#0f766e' },
      { name: 'pcf8574_ic', type: 'box', dimensions: [8.0, 1.6, 8.0], position: [-7.0, -2.1, -3.0], color: '#111827' },
      { name: 'contrast_trimmer', type: 'potentiometer', dimensions: [6.0, 3.2, 6.0], position: [8.5, -2.0, -3.0], color: '#2563eb' },
      { name: 'i2c_header', type: 'header_block', dimensions: [10.16, 2.5, 2.5], position: [0, body.heightMm + 1.2, headerZ], color: '#111827' },
    ];
  }

  if (component.id === 'hc-05-bluetooth' || component.id === 'hc-06-bluetooth') {
    return [
      { name: 'bc417_radio_module', type: 'box', dimensions: [27.0, 2.1, 13.0], position: [-3.5, body.heightMm + 1.4, 0], color: '#14532d' },
      { name: 'meander_antenna_keepout', type: 'box', dimensions: [8.5, 0.15, 11.5], position: [13.0, body.heightMm + 2.55, 0], color: '#d6a940' },
      { name: 'status_led', type: 'led', dimensions: [1.5, 1.2, 1.5], position: [-13.0, body.heightMm + 2.7, 4.3], color: '#ef4444' },
      { name: 'voltage_regulator', type: 'box', dimensions: [3.1, 1.1, 1.8], position: [-13.5, body.heightMm + 2.1, -3.8], color: '#111827' },
      { name: 'serial_header', type: 'header_block', dimensions: [Math.max(headerWidth, 10.16), 2.5, 2.5], position: [0, body.heightMm + 1.2, headerZ], color: '#111827' },
    ];
  }

  if (component.id === 'esp8266-esp01-wifi') {
    return [
      { name: 'esp8266_shield_can', type: 'box', dimensions: [16.0, 2.2, 12.0], position: [-2.8, body.heightMm + 1.5, 0], color: '#cbd5e1' },
      { name: 'pcb_antenna_zone', type: 'box', dimensions: [6.0, 0.15, 12.0], position: [9.0, body.heightMm + 2.6, 0], color: '#d6a940' },
      { name: 'two_by_four_header', type: 'header_block', dimensions: [10.16, 2.5, 5.08], position: [-7.0, body.heightMm + 1.3, headerZ], color: '#111827' },
    ];
  }

  if (component.id === 'esp32-devkit-v1') {
    return [
      { name: 'esp_wroom_32_module', type: 'box', dimensions: [25.5, 3.2, 18.0], position: [0, body.heightMm + 2.2, 4.0], color: '#1e293b' },
      { name: 'pcb_antenna_keepout', type: 'box', dimensions: [18.0, 0.18, 5.0], position: [0, body.heightMm + 3.9, 15.5], color: '#d6a940' },
      { name: 'micro_usb_connector', type: 'box', dimensions: [7.8, 3.2, 6.0], position: [0, body.heightMm + 2.1, -13.0], color: '#cbd5e1' },
      { name: 'usb_uart_bridge', type: 'box', dimensions: [5.0, 1.1, 5.0], position: [-8.5, body.heightMm + 1.4, -5.0], color: '#111827' },
      { name: 'boot_button', type: 'potentiometer', dimensions: [4.2, 2.0, 4.2], position: [-18.0, body.heightMm + 2.2, -10.5], color: '#e5e7eb' },
      { name: 'en_button', type: 'potentiometer', dimensions: [4.2, 2.0, 4.2], position: [18.0, body.heightMm + 2.2, -10.5], color: '#e5e7eb' },
    ];
  }

  if (component.id === 'arduino-nano') {
    return [
      { name: 'atmega328p_tqfp', type: 'box', dimensions: [8.5, 1.4, 8.5], position: [0, body.heightMm + 1.2, 0], color: '#111827' },
      { name: 'mini_usb_connector', type: 'box', dimensions: [7.6, 3.1, 5.6], position: [0, body.heightMm + 2.0, -17.0], color: '#cbd5e1' },
      { name: 'crystal_16mhz', type: 'box', dimensions: [5.0, 1.8, 3.2], position: [8.0, body.heightMm + 1.2, -3.0], color: '#d1d5db' },
      { name: 'power_led', type: 'led', dimensions: [1.4, 1.1, 1.4], position: [-8.5, body.heightMm + 1.8, -8.0], color: '#22c55e' },
    ];
  }

  if (component.id === 'joystick-module-2axis') {
    features.push({ name: 'joystick_gimbal', type: 'potentiometer', dimensions: [17.0, 9.0, 17.0], position: [0, body.heightMm + 5.5, 4.0], color: '#111827' });
    features.push({ name: 'thumb_stick', type: 'cylinder', dimensions: [4.0, 18.0, 0], position: [0, body.heightMm + 18.0, 4.0], color: '#334155' });
  }

  if (component.id === 'breadboard-830') {
    const rows: CadFeature[] = [];
    for (let row = 0; row < 5; row += 1) {
      rows.push({ name: `tie_strip_${row + 1}`, type: 'box', dimensions: [150, 0.12, 1.0], position: [0, body.heightMm + 0.12, -14 + row * 7], color: '#d1d5db' });
    }
    rows.push({ name: 'positive_power_rail', type: 'box', dimensions: [154, 0.14, 1.1], position: [0, body.heightMm + 0.15, 24], color: '#ef4444' });
    rows.push({ name: 'negative_power_rail', type: 'box', dimensions: [154, 0.14, 1.1], position: [0, body.heightMm + 0.15, -24], color: '#3b82f6' });
    return rows;
  }

  if (component.id === 'propeller-ep-1045-two-blade') {
    return [
      { name: 'hub', type: 'cylinder', dimensions: [10.0, 8.0, 0], position: [0, 0, 0], color: '#1f2937' },
      { name: 'bore', type: 'cylinder', dimensions: [3.0, 8.2, 0], position: [0, 0.1, 0], color: '#020617' },
      { name: 'blade_a', type: 'box', dimensions: [118.0, 2.2, 18.0], position: [59.0, 0, 0], rotation: [0, 0, 5], color: '#111827' },
      { name: 'blade_b', type: 'box', dimensions: [118.0, 2.2, 18.0], position: [-59.0, 0, 0], rotation: [0, 0, -5], color: '#111827' },
    ];
  }

  if (component.id === 'jumper-wires-kit') {
    return [
      { name: 'red_jumper_wire', type: 'cylinder', dimensions: [0.45, 36.0, 0], position: [-5, 0, 0], rotation: [0, 0, 82], color: '#ef4444' },
      { name: 'yellow_jumper_wire', type: 'cylinder', dimensions: [0.45, 38.0, 0], position: [0, 0, 0], rotation: [0, 0, 95], color: '#eab308' },
      { name: 'blue_jumper_wire', type: 'cylinder', dimensions: [0.45, 34.0, 0], position: [5, 0, 0], rotation: [0, 0, 78], color: '#3b82f6' },
      { name: 'dupont_connector_bundle', type: 'header_block', dimensions: [13.0, 3.0, 6.0], position: [0, -15.0, 0], color: '#111827' },
    ];
  }

  if (component.id === 'relay-module-5v-1ch') {
    return [
      { name: 'songle_relay_block', type: 'box', dimensions: [19.0, 15.5, 15.0], position: [8.0, body.heightMm + 7.8, 0], color: '#2563eb' },
      { name: 'load_screw_terminal', type: 'screw_terminal', dimensions: [16.5, 10.0, 8.0], position: [-16.0, body.heightMm + 5.0, 6.0], color: '#22c55e' },
      { name: 'logic_header', type: 'header_block', dimensions: [7.62, 2.5, 2.5], position: [-18.0, body.heightMm + 1.2, -9.0], color: '#111827' },
      { name: 'opto_isolator', type: 'box', dimensions: [5.2, 2.0, 6.2], position: [-4.5, body.heightMm + 1.6, -5.5], color: '#111827' },
      { name: 'flyback_diode', type: 'cylinder', dimensions: [0.8, 4.5, 0], position: [-4.0, body.heightMm + 1.8, 4.5], rotation: [0, 0, 90], color: '#111827' },
      { name: 'status_led', type: 'led', dimensions: [1.6, 1.2, 1.6], position: [-16.0, body.heightMm + 2.2, -1.0], color: '#ef4444' },
    ];
  }

  if (component.id === 'neopixel-ws2812b-strip') {
    const pixels: CadFeature[] = [
      { name: 'flex_strip_substrate', type: 'box', dimensions: [60.0, 0.6, 10.0], position: [0, 0.3, 0], color: '#fef3c7' },
      { name: 'din_pad_label', type: 'box', dimensions: [5.0, 0.08, 3.0], position: [-25.0, 0.75, 0], color: '#22c55e' },
      { name: 'dout_pad_label', type: 'box', dimensions: [5.0, 0.08, 3.0], position: [25.0, 0.75, 0], color: '#3b82f6' },
    ];
    for (let index = 0; index < 3; index += 1) {
      pixels.push({ name: `ws2812b_5050_pixel_${index + 1}`, type: 'led', dimensions: [5.0, 2.0, 5.0], position: [-18 + index * 18, 2.0, 0], color: '#e0f2fe' });
    }
    return pixels;
  }

  if (component.id === 'battery-9v') {
    return [
      { name: 'pp3_battery_body', type: 'box', dimensions: [26.5, 48.5, 17.5], position: [0, 0, 0], color: '#334155' },
      { name: 'positive_snap', type: 'cylinder', dimensions: [2.7, 1.2, 0], position: [-5.0, 24.85, 0], color: '#d1d5db' },
      { name: 'negative_snap', type: 'cylinder', dimensions: [3.2, 1.2, 0], position: [5.0, 24.85, 0], color: '#94a3b8' },
    ];
  }

  if (component.id === 'battery-2s-lipo') {
    return [
      { name: 'soft_lipo_pouch', type: 'box', dimensions: [65.0, 12.0, 35.0], position: [0, 0, 0], color: '#475569' },
      { name: 'balance_connector', type: 'header_block', dimensions: [7.62, 3.0, 3.0], position: [-22.0, -2.5, 18.5], color: '#f8fafc' },
      { name: 'xt30_lead_bundle', type: 'cylinder', dimensions: [1.0, 24.0, 0], position: [18.0, -1.5, 22.0], rotation: [90, 0, 20], color: '#ef4444' },
    ];
  }

  if (component.id === 'battery-holder-4xaa') {
    const cells: CadFeature[] = [
      { name: 'aa_holder_tray', type: 'box', dimensions: [63.0, 5.0, 58.0], position: [0, -6.0, 0], color: '#111827' },
    ];
    for (let index = 0; index < 4; index += 1) {
      cells.push({ name: `aa_cell_slot_${index + 1}`, type: 'cylinder', dimensions: [6.8, 52.0, 0], position: [-22.5 + index * 15.0, 0, 0], rotation: [90, 0, 0], color: index % 2 === 0 ? '#d1d5db' : '#94a3b8' });
    }
    return cells;
  }

  if (component.id === 'regulator-lm7805') {
    return [
      { name: 'to220_body', type: 'box', dimensions: [10.0, 9.2, 4.6], position: [0, 0, 0], color: '#111827' },
      { name: 'metal_tab', type: 'box', dimensions: [10.0, 3.0, 0.8], position: [0, 5.7, 0], color: '#cbd5e1' },
      { name: 'mounting_hole_mark', type: 'cylinder', dimensions: [1.6, 0.9, 0], position: [0, 6.0, 0.1], rotation: [90, 0, 0], color: '#0f172a' },
    ];
  }

  if (component.id === 'breadboard-power-module-mb102') {
    return [
      { name: 'usb_a_connector', type: 'box', dimensions: [14.0, 6.5, 13.0], position: [-16.0, body.heightMm + 3.5, 0], color: '#cbd5e1' },
      { name: 'barrel_jack', type: 'box', dimensions: [9.0, 7.0, 11.0], position: [16.0, body.heightMm + 3.8, 0], color: '#111827' },
      { name: 'ams1117_5v', type: 'box', dimensions: [6.5, 1.8, 4.5], position: [-3.5, body.heightMm + 1.5, -5.5], color: '#111827' },
      { name: 'ams1117_3v3', type: 'box', dimensions: [6.5, 1.8, 4.5], position: [5.5, body.heightMm + 1.5, -5.5], color: '#111827' },
      { name: 'power_jumpers', type: 'header_block', dimensions: [12.0, 2.5, 5.0], position: [0, body.heightMm + 1.4, 8.0], color: '#111827' },
    ];
  }

  if (component.id === 'buck-converter-lm2596') {
    return [
      { name: 'lm2596_regulator_ic', type: 'box', dimensions: [10.0, 3.0, 8.0], position: [-5.0, body.heightMm + 2.0, 0], color: '#111827' },
      { name: 'inductor', type: 'cylinder', dimensions: [5.5, 6.0, 0], position: [8.5, body.heightMm + 4.2, 0], color: '#334155' },
      { name: 'trim_pot', type: 'potentiometer', dimensions: [6.0, 4.0, 6.0], position: [14.0, body.heightMm + 3.0, -6.0], color: '#2563eb' },
      { name: 'input_terminal', type: 'screw_terminal', dimensions: [10.0, 9.0, 8.0], position: [-17.0, body.heightMm + 4.5, 7.0], color: '#2563eb' },
      { name: 'output_terminal', type: 'screw_terminal', dimensions: [10.0, 9.0, 8.0], position: [17.0, body.heightMm + 4.5, 7.0], color: '#2563eb' },
    ];
  }

  if (component.id === 'logic-level-shifter-4ch') {
    return [
      { name: 'bss138_array', type: 'box', dimensions: [9.0, 1.1, 6.0], position: [0, body.heightMm + 1.2, 0], color: '#111827' },
      { name: 'hv_header', type: 'header_block', dimensions: [12.7, 2.4, 2.4], position: [-5.0, body.heightMm + 1.2, -5.0], color: '#111827' },
      { name: 'lv_header', type: 'header_block', dimensions: [12.7, 2.4, 2.4], position: [5.0, body.heightMm + 1.2, 5.0], color: '#111827' },
    ];
  }

  if (component.id === 'dht11-temperature-humidity' || component.id === 'dht22-temperature-humidity') {
    const isDht22 = component.id.includes('dht22');
    return [
      { name: isDht22 ? 'white_vented_dht22_body' : 'blue_vented_dht11_body', type: 'box', dimensions: [body.widthMm, body.heightMm, body.lengthMm], position: [0, 0, 0], color: isDht22 ? '#f8fafc' : '#2563eb' },
      { name: 'vent_slots', type: 'box', dimensions: [body.widthMm * 0.72, 0.08, 1.0], position: [0, 0.6, body.lengthMm / 2 + 0.05], color: '#0f172a' },
      { name: 'label_panel', type: 'box', dimensions: [body.widthMm * 0.55, 0.08, 2.1], position: [0, -1.2, body.lengthMm / 2 + 0.06], color: isDht22 ? '#e5e7eb' : '#93c5fd' },
    ];
  }

  if (component.id === 'ldr-photoresistor') {
    return [
      { name: 'photoresistor_disc', type: 'cylinder', dimensions: [2.5, 1.6, 0], position: [0, 0, 0], color: '#d6a940' },
      { name: 'serpentine_cds_track', type: 'box', dimensions: [3.2, 0.08, 0.55], position: [0, 0.86, 0], color: '#78350f' },
    ];
  }

  if (component.id === 'ir-receiver-tsop38238') {
    return [
      { name: 'tsop_black_package', type: 'box', dimensions: [6.9, 5.3, 5.6], position: [0, 0, 0], color: '#111827' },
      { name: 'rounded_ir_window', type: 'lens', dimensions: [5.0, 3.0, 5.0], position: [0, 1.2, 2.85], color: '#171717' },
    ];
  }

  if (component.id === 'ir-obstacle-sensor') {
    return [
      { name: 'ir_led_emitter', type: 'led', dimensions: [5.0, 7.0, 5.0], position: [-7.0, body.heightMm + 4.0, 2.5], color: '#581c87' },
      { name: 'photodiode_receiver', type: 'led', dimensions: [5.0, 7.0, 5.0], position: [7.0, body.heightMm + 4.0, 2.5], color: '#111827' },
      { name: 'comparator_ic', type: 'box', dimensions: [5.0, 1.2, 5.0], position: [0, body.heightMm + 1.2, -3.5], color: '#111827' },
      { name: 'sensitivity_trimmer', type: 'potentiometer', dimensions: [6.0, 3.5, 6.0], position: [10.0, body.heightMm + 3.0, -3.5], color: '#2563eb' },
      { name: 'three_pin_header', type: 'header_block', dimensions: [7.62, 2.5, 2.5], position: [-10.0, body.heightMm + 1.2, headerZ], color: '#111827' },
    ];
  }

  if (component.id === 'soil-moisture-sensor') {
    return [
      { name: 'fork_probe_left', type: 'box', dimensions: [6.0, 0.8, 42.0], position: [-5.0, body.heightMm + 0.3, 9.0], color: '#d6a940' },
      { name: 'fork_probe_right', type: 'box', dimensions: [6.0, 0.8, 42.0], position: [5.0, body.heightMm + 0.3, 9.0], color: '#d6a940' },
      { name: 'comparator_board', type: 'box', dimensions: [20.0, 1.2, 18.0], position: [0, body.heightMm + 0.7, -18.0], color: '#14532d' },
      { name: 'lm393_ic', type: 'box', dimensions: [5.0, 1.2, 5.0], position: [-4.0, body.heightMm + 1.5, -18.0], color: '#111827' },
      { name: 'sensitivity_trimmer', type: 'potentiometer', dimensions: [6.0, 3.5, 6.0], position: [5.5, body.heightMm + 3.0, -18.0], color: '#2563eb' },
    ];
  }

  if (component.id === 'mq-2-gas-sensor') {
    return [
      { name: 'mq2_heater_can', type: 'cylinder', dimensions: [8.5, 12.0, 0], position: [0, body.heightMm + 7.0, 1.5], color: '#cbd5e1' },
      { name: 'perforated_cap_band', type: 'cylinder', dimensions: [8.9, 1.2, 0], position: [0, body.heightMm + 12.3, 1.5], color: '#94a3b8' },
      { name: 'lm393_ic', type: 'box', dimensions: [5.0, 1.2, 5.0], position: [-9.0, body.heightMm + 1.3, -5.0], color: '#111827' },
      { name: 'sensitivity_trimmer', type: 'potentiometer', dimensions: [6.0, 3.5, 6.0], position: [9.0, body.heightMm + 3.0, -5.0], color: '#2563eb' },
    ];
  }

  if (component.id === 'load-cell-hx711') {
    return [
      { name: 'hx711_ic', type: 'box', dimensions: [5.0, 1.2, 5.0], position: [0, body.heightMm + 1.2, 0], color: '#111827' },
      { name: 'load_cell_header', type: 'header_block', dimensions: [10.16, 2.5, 2.5], position: [-10.0, body.heightMm + 1.2, -7.0], color: '#111827' },
      { name: 'mcu_header', type: 'header_block', dimensions: [10.16, 2.5, 2.5], position: [10.0, body.heightMm + 1.2, -7.0], color: '#111827' },
      { name: 'excitation_resistor_bank', type: 'box', dimensions: [16.0, 0.7, 2.2], position: [0, body.heightMm + 1.0, 6.0], color: '#d6b47a' },
    ];
  }

  if (component.id === 'bh1750-light-sensor' || component.id === 'ina219-current-sensor' || component.id === 'regulator-ams1117-3v3') {
    return [
      { name: 'primary_ic', type: 'box', dimensions: [component.id === 'ina219-current-sensor' ? 5.2 : 3.2, 1.1, component.id === 'ina219-current-sensor' ? 5.2 : 3.2], position: [0, body.heightMm + 1.1, 1.5], color: '#111827' },
      { name: 'breakout_header', type: 'header_block', dimensions: [Math.min(headerWidth, body.widthMm - 2), 2.5, 2.5], position: [0, body.heightMm + 1.2, headerZ], color: '#111827' },
      ...(component.id === 'ina219-current-sensor' ? [{ name: 'current_sense_shunt', type: 'box' as const, dimensions: [8.0, 1.2, 3.0] as [number, number, number], position: [7.0, body.heightMm + 1.3, 1.5] as [number, number, number], color: '#cbd5e1' }] : []),
    ];
  }

  if (component.id === 'keypad-4x4-membrane') {
    const keys: CadFeature[] = [{ name: 'membrane_sheet', type: 'box', dimensions: [70.0, 0.8, 77.0], position: [0, 0.4, 0], color: '#e5e7eb' }];
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        keys.push({ name: `key_${row + 1}_${col + 1}`, type: 'box', dimensions: [12.0, 0.45, 10.0], position: [-24 + col * 16, 1.05, -24 + row * 16], color: '#f8fafc' });
      }
    }
    keys.push({ name: 'flex_tail_contacts', type: 'box', dimensions: [24.0, 0.2, 8.0], position: [0, 0.9, -43.0], color: '#d6a940' });
    return keys;
  }

  if (component.id === 'potentiometer-10k') {
    return [
      { name: 'potentiometer_body', type: 'potentiometer', dimensions: [17.0, 10.0, 17.0], position: [0, 0, 0], color: '#2563eb' },
      { name: 'knurled_shaft', type: 'cylinder', dimensions: [2.9, 15.0, 0], position: [0, 11.0, 0], color: '#cbd5e1' },
    ];
  }

  if ((!body.pinStyle || body.pinStyle === 'headers') && pins.length > 0) {
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
    ...(body.bodyStyle ? { bodyStyle: body.bodyStyle } : {}),
    ...(body.pinStyle ? { pinStyle: body.pinStyle } : {}),
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
