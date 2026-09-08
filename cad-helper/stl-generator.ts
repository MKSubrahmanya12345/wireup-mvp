/**
 * cad-helper/stl-generator.ts
 * Generates exact 3D solid STL geometry (both standard ASCII and Binary STL formats)
 * in real-world millimeter dimensions for mechanical CAD verification and 3D printing.
 */

import type { CadComponentSpec, CadFeature, CadPinDefinition } from './types';

export interface Triangle {
  normal: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
}

/** Compute triangle unit normal vector from vertices using cross product */
export function computeNormal(
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number]
): [number, number, number] {
  const ax = v2[0] - v1[0];
  const ay = v2[1] - v1[1];
  const az = v2[2] - v1[2];

  const bx = v3[0] - v1[0];
  const by = v3[1] - v1[1];
  const bz = v3[2] - v1[2];

  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;

  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-9) return [0, 1, 0];
  return [nx / len, ny / len, nz / len];
}

/** Generates triangles for a 3D box centered at (cx, cy, cz) with size (sx, sy, sz) */
export function createBoxTriangles(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number
): Triangle[] {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;

  // 8 vertices
  const p0: [number, number, number] = [cx - hx, cy - hy, cz - hz];
  const p1: [number, number, number] = [cx + hx, cy - hy, cz - hz];
  const p2: [number, number, number] = [cx + hx, cy + hy, cz - hz];
  const p3: [number, number, number] = [cx - hx, cy + hy, cz - hz];
  const p4: [number, number, number] = [cx - hx, cy - hy, cz + hz];
  const p5: [number, number, number] = [cx + hx, cy - hy, cz + hz];
  const p6: [number, number, number] = [cx + hx, cy + hy, cz + hz];
  const p7: [number, number, number] = [cx - hx, cy + hy, cz + hz];

  const triangles: Triangle[] = [];

  const addQuad = (
    v1: [number, number, number],
    v2: [number, number, number],
    v3: [number, number, number],
    v4: [number, number, number]
  ) => {
    triangles.push({ normal: computeNormal(v1, v2, v3), v1, v2, v3 });
    triangles.push({ normal: computeNormal(v1, v3, v4), v1, v2: v3, v3: v4 });
  };

  // Top (+Y)
  addQuad(p3, p2, p6, p7);
  // Bottom (-Y)
  addQuad(p4, p5, p1, p0);
  // Front (+Z)
  addQuad(p7, p6, p5, p4);
  // Back (-Z)
  addQuad(p1, p2, p3, p0);
  // Right (+X)
  addQuad(p5, p6, p2, p1);
  // Left (-X)
  addQuad(p0, p3, p7, p4);

  return triangles;
}

/** Generates triangles for a 3D cylinder standing vertically (+Y) */
export function createCylinderTriangles(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  height: number,
  segments = 16
): Triangle[] {
  const triangles: Triangle[] = [];
  const hy = height / 2;
  const topCenter: [number, number, number] = [cx, cy + hy, cz];
  const bottomCenter: [number, number, number] = [cx, cy - hy, cz];

  const topRim: [number, number, number][] = [];
  const botRim: [number, number, number][] = [];

  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * 2 * Math.PI;
    const x = cx + radius * Math.cos(theta);
    const z = cz + radius * Math.sin(theta);
    topRim.push([x, cy + hy, z]);
    botRim.push([x, cy - hy, z]);
  }

  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;

    // Top cap
    triangles.push({
      normal: [0, 1, 0],
      v1: topCenter,
      v2: topRim[i],
      v3: topRim[next],
    });

    // Bottom cap
    triangles.push({
      normal: [0, -1, 0],
      v1: bottomCenter,
      v2: botRim[next],
      v3: botRim[i],
    });

    // Side quad
    const v1 = botRim[i];
    const v2 = botRim[next];
    const v3 = topRim[next];
    const v4 = topRim[i];
    triangles.push({ normal: computeNormal(v1, v2, v3), v1, v2, v3 });
    triangles.push({ normal: computeNormal(v1, v3, v4), v1, v2: v3, v3: v4 });
  }

  return triangles;
}

/** Build complete collection of triangles for a component specification */
export function buildComponentGeometry(spec: CadComponentSpec): Triangle[] {
  const triangles: Triangle[] = [];
  const { widthMm, lengthMm, heightMm } = spec.dimensions;

  // 1. Base PCB Substrate (Center at Y = heightMm / 2)
  triangles.push(...createBoxTriangles(0, heightMm / 2, 0, widthMm, heightMm, lengthMm));

  // 2. Connector Pins & Header Shrouds
  for (const pin of spec.pins) {
    const pinSize = 0.64; // standard square 0.025" (0.64mm) header pin
    const pinLength = 6.0; // pin protrusion height

    // Pin metal blade
    const pinCy = pin.direction === 'down' ? -(pinLength / 2) : heightMm + pinLength / 2;
    triangles.push(...createBoxTriangles(pin.xMm, pinCy, pin.zMm, pinSize, pinLength, pinSize));

    // Pin plastic collar base
    const collarCy = pin.direction === 'down' ? -1.0 : heightMm + 1.0;
    triangles.push(...createBoxTriangles(pin.xMm, collarCy, pin.zMm, 2.4, 2.0, 2.4));
  }

  // 3. Functional / Surface Features
  for (const feat of spec.features) {
    const [fx, fy, fz] = feat.position;
    const [d1, d2, d3] = feat.dimensions;

    if (feat.type === 'cylinder' || feat.type === 'lens') {
      const radius = d1;
      const height = d2;
      triangles.push(...createCylinderTriangles(fx, fy, fz, radius, height, 20));
    } else {
      // Box / Screen / Heatsink / Terminal / Potentiometer
      triangles.push(...createBoxTriangles(fx, fy, fz, d1, d2, d3));
    }
  }

  return triangles;
}

/** Generates standard ASCII STL format text */
export function generateAsciiStl(spec: CadComponentSpec): string {
  const triangles = buildComponentGeometry(spec);
  const solidName = spec.id.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines: string[] = [`solid ${solidName}`];

  for (const tri of triangles) {
    const [nx, ny, nz] = tri.normal;
    lines.push(`  facet normal ${nx.toFixed(6)} ${ny.toFixed(6)} ${nz.toFixed(6)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${tri.v1[0].toFixed(6)} ${tri.v1[1].toFixed(6)} ${tri.v1[2].toFixed(6)}`);
    lines.push(`      vertex ${tri.v2[0].toFixed(6)} ${tri.v2[1].toFixed(6)} ${tri.v2[2].toFixed(6)}`);
    lines.push(`      vertex ${tri.v3[0].toFixed(6)} ${tri.v3[1].toFixed(6)} ${tri.v3[2].toFixed(6)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }

  lines.push(`endsolid ${solidName}`);
  return lines.join('\n');
}

/** Generates compact binary STL Buffer format */
export function generateBinaryStl(spec: CadComponentSpec): Buffer {
  const triangles = buildComponentGeometry(spec);
  const numTriangles = triangles.length;
  const bufferSize = 80 + 4 + numTriangles * 50;
  const buf = Buffer.alloc(bufferSize);

  // 80-byte header
  const headerStr = `WireUp CAD Auto-Generated STL: ${spec.name.slice(0, 45)}`;
  buf.write(headerStr, 0, 'utf-8');

  // 4-byte unsigned int: triangle count
  buf.writeUInt32LE(numTriangles, 80);

  let offset = 84;
  for (const tri of triangles) {
    // Normal vector (3x float32)
    buf.writeFloatLE(tri.normal[0], offset);
    buf.writeFloatLE(tri.normal[1], offset + 4);
    buf.writeFloatLE(tri.normal[2], offset + 8);

    // Vertex 1 (3x float32)
    buf.writeFloatLE(tri.v1[0], offset + 12);
    buf.writeFloatLE(tri.v1[1], offset + 16);
    buf.writeFloatLE(tri.v1[2], offset + 20);

    // Vertex 2 (3x float32)
    buf.writeFloatLE(tri.v2[0], offset + 24);
    buf.writeFloatLE(tri.v2[1], offset + 28);
    buf.writeFloatLE(tri.v2[2], offset + 32);

    // Vertex 3 (3x float32)
    buf.writeFloatLE(tri.v3[0], offset + 36);
    buf.writeFloatLE(tri.v3[1], offset + 40);
    buf.writeFloatLE(tri.v3[2], offset + 44);

    // 2-byte attribute byte count (0)
    buf.writeUInt16LE(0, offset + 48);

    offset += 50;
  }

  return buf;
}
