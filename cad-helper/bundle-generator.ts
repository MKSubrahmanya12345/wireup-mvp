/**
 * cad-helper/bundle-generator.ts
 * Generates seed code and bundles STL, GLB, and metadata without Node filesystem dependencies.
 */

import type { CadComponentSpec, GeneratedCadOutput } from './types';
import { generateAsciiStl, generateBinaryStl } from './stl-generator';
import { generateGlb } from './glb-generator';

/**
 * Generates the TypeScript seed definition code snippet for WireUp's catalog
 */
export function generateSeedCode(spec: CadComponentSpec): string {
  const pinEntries = spec.pins
    .map((p) => {
      const aliasStr = p.aliases && p.aliases.length > 0 ? `, aliases: ${JSON.stringify(p.aliases)}` : '';
      const reqStr = p.required ? `, required: true` : '';
      return `    pin('${p.name}', '${p.role}', '${p.role === 'power' || p.role === 'ground' ? p.role : 'bidirectional'}', { signal: '${p.signal}'${reqStr}${aliasStr} }),`;
    })
    .join('\n');

  const protocolsStr = JSON.stringify(spec.protocols);
  const keywordsStr = JSON.stringify(spec.keywords);
  const aliasesStr = JSON.stringify(spec.aliases);

  return `  def({
    id: '${spec.id}',
    name: '${spec.name}',
    category: '${spec.category}',
    description: '${spec.description.replace(/'/g, "\\'")}',
    voltage: ${spec.voltage},
    minVoltage: ${spec.minVoltage ?? spec.voltage},
    maxVoltage: ${spec.maxVoltage ?? spec.voltage},
    currentRequirements: {
      typicalMa: ${spec.currentMa},
      maxMa: ${spec.currentMa * 1.5},
    },
    communicationProtocols: ${protocolsStr},
    pins: [
${pinEntries}
    ],
    aliases: ${aliasesStr},
    keywords: ${keywordsStr},
    simulator: { part: 'wokwi-${spec.id}', supported: true, attrs: {} },
    metadata: {
      dimensionsMm: { width: ${spec.dimensions.widthMm}, length: ${spec.dimensions.lengthMm}, height: ${spec.dimensions.heightMm} },
      cadModel: '${spec.id}/${spec.id}.glb',
      pinCount: ${spec.pins.length},
    },
  }),`;
}

/**
 * Builds the complete CAD bundle (STL, GLB, Seed Code, Manifest entry)
 */
export function buildCadBundle(spec: CadComponentSpec): GeneratedCadOutput {
  const stlAscii = generateAsciiStl(spec);
  const stlBinary = generateBinaryStl(spec);
  const glbBinary = generateGlb(spec);
  const seedCode = generateSeedCode(spec);

  const manifestEntry = {
    file: `${spec.id}/${spec.id}.glb`,
    pinNodes: spec.pins.map((p) => p.name),
    bench: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: 1,
    },
  };

  return {
    spec,
    stlAscii,
    stlBinary,
    glbBinary,
    seedCode,
    manifestEntry,
  };
}
