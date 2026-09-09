/**
 * cad-helper/glb-generator.ts
 * Builds standard glTF 2.0 Binary (.glb) files with PBR materials and
 * injected named Empty pin nodes that satisfy Velxio's 3D wire-snapping contract.
 */

import type { CadComponentSpec, CadFeature, CadPinDefinition } from './types';
import { Triangle, createBoxTriangles, createFeatureTriangles, createPinTriangles } from './stl-generator';

interface MeshPart {
  name: string;
  materialIndex: number;
  triangles: Triangle[];
}

function hexToRgba(hex: string, defaultAlpha = 1.0): [number, number, number, number] {
  let cleaned = hex.replace('#', '').trim();
  if (cleaned.length === 3) {
    cleaned = cleaned.split('').map((c) => c + c).join('');
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.substring(0, 2), 16) / 255;
    const g = parseInt(cleaned.substring(2, 4), 16) / 255;
    const b = parseInt(cleaned.substring(4, 6), 16) / 255;
    return [r, g, b, defaultAlpha];
  }
  return [0.12, 0.35, 0.55, defaultAlpha]; // Default PCB Blue
}

/**
 * Builds separate mesh parts with distinct PBR materials for the component
 */
export function buildMeshParts(spec: CadComponentSpec): {
  parts: MeshPart[];
  materials: Array<{
    name: string;
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
  }>;
} {
  const parts: MeshPart[] = [];
  const materials: Array<{
    name: string;
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
  }> = [];

  const { widthMm, lengthMm, heightMm } = spec.dimensions;

  // Material 0: PCB Substrate
  const pcbColor = hexToRgba(spec.bodyColor || '#1a5b8c');
  materials.push({
    name: 'PCB_Substrate',
    baseColorFactor: pcbColor,
    metallicFactor: 0.1,
    roughnessFactor: 0.6,
  });

  // Material 1: Gold / Metallic Pins
  materials.push({
    name: 'Gold_Header_Pins',
    baseColorFactor: [0.95, 0.82, 0.28, 1.0],
    metallicFactor: 0.9,
    roughnessFactor: 0.2,
  });

  // Material 2: Plastic Header Shroud / Collars
  materials.push({
    name: 'Black_Plastic',
    baseColorFactor: [0.1, 0.1, 0.1, 1.0],
    metallicFactor: 0.1,
    roughnessFactor: 0.8,
  });

  // 1. PCB / housing mesh part. Discrete parts model the whole package through features.
  if (spec.bodyStyle !== 'none') {
    parts.push({
      name: 'pcb_body',
      materialIndex: 0,
      triangles: createBoxTriangles(0, heightMm / 2, 0, widthMm, heightMm, lengthMm),
    });
  }

  // 2. Pins & Headers. Geometry now respects each pin's declared anchor and direction;
  // older output always put pins vertically above the PCB, which made front/back/side
  // connectors visibly wrong even when the named anchor nodes were correct.
  const pinMetalTriangles: Triangle[] = [];
  const pinCollarTriangles: Triangle[] = [];

  for (const pin of spec.pins) {
    const { metal, collars } = createPinTriangles(pin, spec.pinStyle ?? 'headers');
    pinMetalTriangles.push(...metal);
    pinCollarTriangles.push(...collars);
  }

  if (pinMetalTriangles.length > 0) {
    parts.push({
      name: 'pins_metal',
      materialIndex: 1,
      triangles: pinMetalTriangles,
    });
  }

  if (pinCollarTriangles.length > 0) {
    parts.push({
      name: 'pins_collars',
      materialIndex: 2,
      triangles: pinCollarTriangles,
    });
  }

  // 3. Surface Features
  for (let i = 0; i < spec.features.length; i++) {
    const feat = spec.features[i];

    const featColor = feat.color ? hexToRgba(feat.color) : [0.7, 0.7, 0.75, 1.0];
    const isMetal = feat.type === 'heatsink' || feat.type === 'cylinder';
    const isGlass = feat.type === 'screen';

    const matIdx = materials.length;
    materials.push({
      name: `Mat_${feat.name}`,
      baseColorFactor: featColor as [number, number, number, number],
      metallicFactor: isMetal ? 0.8 : isGlass ? 0.2 : 0.1,
      roughnessFactor: isMetal ? 0.3 : isGlass ? 0.1 : 0.7,
    });

    parts.push({
      name: feat.name,
      materialIndex: matIdx,
      triangles: createFeatureTriangles(feat),
    });
  }

  return { parts, materials };
}

/**
 * Encodes geometry and builds a glTF 2.0 Binary (.glb) Buffer
 */
export function generateGlb(spec: CadComponentSpec): Buffer {
  const { parts, materials } = buildMeshParts(spec);

  // Collect vertices, normals, and indices
  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allIndices: number[] = [];
  const primitives: Array<{
    material: number;
    indicesAccessor: number;
    positionAccessor: number;
    normalAccessor: number;
  }> = [];

  let vertexOffset = 0;
  let accessorIndex = 0;
  const accessors: any[] = [];
  const bufferViews: any[] = [];

  // Binary buffer chunks
  const byteBuffers: Buffer[] = [];
  let currentByteOffset = 0;

  for (const part of parts) {
    const partPositions: number[] = [];
    const partNormals: number[] = [];
    const partIndices: number[] = [];

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    let localVert = 0;
    for (const tri of part.triangles) {
      const [nx, ny, nz] = tri.normal;
      const verts = [tri.v1, tri.v2, tri.v3];

      for (const v of verts) {
        partPositions.push(v[0], v[1], v[2]);
        partNormals.push(nx, ny, nz);
        partIndices.push(localVert);
        localVert++;

        minX = Math.min(minX, v[0]);
        minY = Math.min(minY, v[1]);
        minZ = Math.min(minZ, v[2]);
        maxX = Math.max(maxX, v[0]);
        maxY = Math.max(maxY, v[1]);
        maxZ = Math.max(maxZ, v[2]);
      }
    }

    // 1. Position BufferView & Accessor
    const posBytes = Buffer.alloc(partPositions.length * 4);
    for (let i = 0; i < partPositions.length; i++) {
      posBytes.writeFloatLE(partPositions[i], i * 4);
    }
    const posViewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: currentByteOffset,
      byteLength: posBytes.length,
      target: 34962, // ARRAY_BUFFER
    });
    byteBuffers.push(posBytes);
    currentByteOffset += posBytes.length;

    const posAccessorIndex = accessors.length;
    accessors.push({
      bufferView: posViewIndex,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: partPositions.length / 3,
      type: 'VEC3',
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });

    // 2. Normal BufferView & Accessor
    const normBytes = Buffer.alloc(partNormals.length * 4);
    for (let i = 0; i < partNormals.length; i++) {
      normBytes.writeFloatLE(partNormals[i], i * 4);
    }
    const normViewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: currentByteOffset,
      byteLength: normBytes.length,
      target: 34962, // ARRAY_BUFFER
    });
    byteBuffers.push(normBytes);
    currentByteOffset += normBytes.length;

    const normAccessorIndex = accessors.length;
    accessors.push({
      bufferView: normViewIndex,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: partNormals.length / 3,
      type: 'VEC3',
    });

    // 3. Index BufferView & Accessor
    const indexBytes = Buffer.alloc(partIndices.length * 4);
    for (let i = 0; i < partIndices.length; i++) {
      indexBytes.writeUInt32LE(partIndices[i], i * 4);
    }
    const indexViewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: currentByteOffset,
      byteLength: indexBytes.length,
      target: 34963, // ELEMENT_ARRAY_BUFFER
    });
    byteBuffers.push(indexBytes);
    currentByteOffset += indexBytes.length;

    const indexAccessorIndex = accessors.length;
    accessors.push({
      bufferView: indexViewIndex,
      byteOffset: 0,
      componentType: 5125, // UNSIGNED_INT
      count: partIndices.length,
      type: 'SCALAR',
    });

    primitives.push({
      material: part.materialIndex,
      positionAccessor: posAccessorIndex,
      normalAccessor: normAccessorIndex,
      indicesAccessor: indexAccessorIndex,
    });
  }

  // Combine binary buffer
  const binBuffer = Buffer.concat(byteBuffers);

  // Nodes hierarchy:
  // Node 0: Root Scene Object
  // Node 1: Mesh Body
  // Nodes 2..N: Injected Named Empty Pin Nodes
  const nodes: any[] = [];
  const rootChildren: number[] = [1];

  // Node 1: Mesh
  nodes.push({}); // Placeholder for root at index 0
  nodes.push({
    name: `${spec.id}_mesh`,
    mesh: 0,
  });

  // Inject Named Empty Pin Nodes for Velxio
  for (const pin of spec.pins) {
    const pinNodeIdx = nodes.length;
    rootChildren.push(pinNodeIdx);
    nodes.push({
      name: pin.name,
      translation: [pin.xMm, pin.yMm, pin.zMm],
    });
  }

  // Fill in Node 0 (Root)
  nodes[0] = {
    name: spec.id,
    children: rootChildren,
  };

  const gltfMaterials = materials.map((m) => ({
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: m.baseColorFactor,
      metallicFactor: m.metallicFactor,
      roughnessFactor: m.roughnessFactor,
    },
    doubleSided: true,
  }));

  const gltfMeshes = [
    {
      name: `${spec.id}_geometry`,
      primitives: primitives.map((p) => ({
        attributes: {
          POSITION: p.positionAccessor,
          NORMAL: p.normalAccessor,
        },
        indices: p.indicesAccessor,
        material: p.material,
      })),
    },
  ];

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'WireUp Parametric CAD & Pin Engine v1.0',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    materials: gltfMaterials,
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBuffer.length }],
  };

  // Convert JSON to Buffer with 4-byte alignment padding
  let jsonString = JSON.stringify(gltf);
  while (Buffer.byteLength(jsonString, 'utf-8') % 4 !== 0) {
    jsonString += ' ';
  }
  const jsonBuffer = Buffer.from(jsonString, 'utf-8');

  // Pad binary buffer to 4-byte boundary
  let paddedBinBuffer = binBuffer;
  const binPadding = (4 - (binBuffer.length % 4)) % 4;
  if (binPadding > 0) {
    paddedBinBuffer = Buffer.concat([binBuffer, Buffer.alloc(binPadding, 0)]);
  }

  // Build final GLB file
  const totalLength = 12 + 8 + jsonBuffer.length + 8 + paddedBinBuffer.length;
  const glb = Buffer.alloc(totalLength);

  // GLB Header (12 bytes)
  glb.writeUInt32LE(0x46546c67, 0); // magic: 'glTF'
  glb.writeUInt32LE(2, 4); // version: 2
  glb.writeUInt32LE(totalLength, 8); // total length

  // Chunk 0: JSON (8 bytes + jsonBuffer.length)
  glb.writeUInt32LE(jsonBuffer.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16); // type: 'JSON'
  jsonBuffer.copy(glb, 20);

  // Chunk 1: BIN (8 bytes + paddedBinBuffer.length)
  const binOffset = 20 + jsonBuffer.length;
  glb.writeUInt32LE(paddedBinBuffer.length, binOffset);
  glb.writeUInt32LE(0x004e4942, binOffset + 4); // type: 'BIN\0'
  paddedBinBuffer.copy(glb, binOffset + 8);

  return glb;
}
