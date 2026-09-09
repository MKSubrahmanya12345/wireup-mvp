/**
 * cad-helper/stl-generator.ts
 * Generates exact 3D solid STL geometry (both standard ASCII and Binary STL formats)
 * in real-world millimeter dimensions for mechanical CAD verification and 3D printing.
 */

import type { CadComponentSpec, CadFeature, CadPinDefinition, CadPinStyle } from './types';

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

function rotatePoint(point: [number, number, number], radians: [number, number, number]): [number, number, number] {
  let [x, y, z] = point;
  const [rx, ry, rz] = radians;

  if (rx) {
    const cos = Math.cos(rx);
    const sin = Math.sin(rx);
    const nextY = y * cos - z * sin;
    const nextZ = y * sin + z * cos;
    y = nextY;
    z = nextZ;
  }

  if (ry) {
    const cos = Math.cos(ry);
    const sin = Math.sin(ry);
    const nextX = x * cos + z * sin;
    const nextZ = -x * sin + z * cos;
    x = nextX;
    z = nextZ;
  }

  if (rz) {
    const cos = Math.cos(rz);
    const sin = Math.sin(rz);
    const nextX = x * cos - y * sin;
    const nextY = x * sin + y * cos;
    x = nextX;
    y = nextY;
  }

  return [x, y, z];
}

function transformTriangles(
  triangles: Triangle[],
  translation: [number, number, number] = [0, 0, 0],
  rotationDegrees: [number, number, number] = [0, 0, 0],
): Triangle[] {
  const radians = rotationDegrees.map((degrees) => (degrees * Math.PI) / 180) as [number, number, number];
  return triangles.map((triangle) => {
    const v1 = rotatePoint(triangle.v1, radians).map((value, index) => value + translation[index]) as [number, number, number];
    const v2 = rotatePoint(triangle.v2, radians).map((value, index) => value + translation[index]) as [number, number, number];
    const v3 = rotatePoint(triangle.v3, radians).map((value, index) => value + translation[index]) as [number, number, number];
    return { normal: computeNormal(v1, v2, v3), v1, v2, v3 };
  });
}

/** Generates triangles for a top hemisphere with its equator centered at `baseY`. */
export function createHemisphereTriangles(
  cx: number,
  baseY: number,
  cz: number,
  radius: number,
  segments = 24,
  rings = 8,
  closeBase = true,
): Triangle[] {
  const triangles: Triangle[] = [];
  const top: [number, number, number] = [cx, baseY + radius, cz];
  const ringPoints: [number, number, number][][] = [];

  for (let ring = 1; ring <= rings; ring += 1) {
    const theta = (ring / rings) * (Math.PI / 2);
    const y = baseY + Math.cos(theta) * radius;
    const radial = Math.sin(theta) * radius;
    const points: [number, number, number][] = [];
    for (let segment = 0; segment < segments; segment += 1) {
      const phi = (segment / segments) * Math.PI * 2;
      points.push([cx + Math.cos(phi) * radial, y, cz + Math.sin(phi) * radial]);
    }
    ringPoints.push(points);
  }

  const firstRing = ringPoints[0];
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    const v1 = top;
    const v2 = firstRing[segment];
    const v3 = firstRing[next];
    triangles.push({ normal: computeNormal(v1, v2, v3), v1, v2, v3 });
  }

  for (let ring = 0; ring < ringPoints.length - 1; ring += 1) {
    const inner = ringPoints[ring];
    const outer = ringPoints[ring + 1];
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const v1 = inner[segment];
      const v2 = outer[segment];
      const v3 = outer[next];
      const v4 = inner[next];
      triangles.push({ normal: computeNormal(v1, v2, v3), v1, v2, v3 });
      triangles.push({ normal: computeNormal(v1, v3, v4), v1, v2: v3, v3: v4 });
    }
  }

  if (closeBase) {
    const baseCenter: [number, number, number] = [cx, baseY, cz];
    const equator = ringPoints[ringPoints.length - 1];
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const v1 = baseCenter;
      const v2 = equator[next];
      const v3 = equator[segment];
      triangles.push({ normal: [0, -1, 0], v1, v2, v3 });
    }
  }

  return triangles;
}

/** A 5 mm through-hole LED body: cylindrical epoxy cup plus rounded lens. */
export function createLedBodyTriangles(diameter: number, totalHeight: number, segments = 28): Triangle[] {
  const radius = Math.max(diameter / 2, 0.35);
  const height = Math.max(totalHeight, radius * 1.7);
  const domeRadius = Math.min(radius, height * 0.45);
  const cylinderHeight = Math.max(height - domeRadius, height * 0.52);
  const bottomY = -height / 2;
  const bodyCenterY = bottomY + cylinderHeight / 2;
  const domeBaseY = bottomY + cylinderHeight;

  return [
    ...createCylinderTriangles(0, bodyCenterY, 0, radius * 0.94, cylinderHeight, segments),
    ...createHemisphereTriangles(0, domeBaseY, 0, domeRadius, segments, 8, false),
  ];
}

/** Build a feature mesh in local space, then rotate/translate it from the spec. */
export function createFeatureTriangles(feature: CadFeature): Triangle[] {
  const [width, height, depth] = feature.dimensions;
  let local: Triangle[];

  if (feature.type === 'cylinder') {
    local = createCylinderTriangles(0, 0, 0, Math.max(width, 0.3), Math.max(height, 0.4), 24);
  } else if (feature.type === 'led') {
    local = createLedBodyTriangles(Math.max(width, depth, 0.8), Math.max(height, 0.8), 28);
  } else if (feature.type === 'lens') {
    const radius = Math.max(width, depth, 0.8) / 2;
    local = createHemisphereTriangles(0, -Math.max(height, radius) / 2, 0, radius, 28, 8, true);
  } else if (feature.type === 'heatsink') {
    local = createBoxTriangles(0, -height * 0.34, 0, Math.max(width, 1), Math.max(height * 0.18, 0.25), Math.max(depth, 1));
    const finCount = Math.max(3, Math.round(Math.max(width, depth) / 2.2));
    for (let index = 0; index < finCount; index += 1) {
      const fraction = (index + 0.5) / finCount - 0.5;
      const finWidth = width >= depth ? width / finCount : Math.max(width * 0.55, 0.25);
      local.push(...createBoxTriangles(
        width >= depth ? fraction * width * 0.84 : 0,
        height * 0.08,
        width >= depth ? 0 : fraction * depth * 0.84,
        width >= depth ? finWidth * 0.46 : width * 0.74,
        Math.max(height * 0.8, 0.4),
        width >= depth ? depth * 0.78 : (depth / finCount) * 0.46,
      ));
    }
  } else {
    local = createBoxTriangles(0, 0, 0, Math.max(width, 0.4), Math.max(height, 0.18), Math.max(depth, 0.4));
  }

  return transformTriangles(local, feature.position, feature.rotation);
}

function pinDirectionVector(direction: CadPinDefinition['direction'] = 'up'): [number, number, number] {
  switch (direction) {
    case 'down': return [0, -1, 0];
    case 'left': return [-1, 0, 0];
    case 'right': return [1, 0, 0];
    case 'front': return [0, 0, 1];
    case 'back': return [0, 0, -1];
    case 'up':
    default: return [0, 1, 0];
  }
}

function pinRotation(direction: CadPinDefinition['direction'] = 'up'): [number, number, number] {
  switch (direction) {
    case 'left': return [0, 0, 90];
    case 'right': return [0, 0, -90];
    case 'front': return [90, 0, 0];
    case 'back': return [-90, 0, 0];
    case 'down': return [180, 0, 0];
    case 'up':
    default: return [0, 0, 0];
  }
}

/** Generate pin/lead geometry that starts at the anchor and extends in the declared direction. */
export function createPinTriangles(pin: CadPinDefinition, style: CadPinStyle = 'headers'): { metal: Triangle[]; collars: Triangle[] } {
  if (style === 'none') return { metal: [], collars: [] };
  if (style === 'pads') {
    return {
      metal: createBoxTriangles(pin.xMm, pin.yMm, pin.zMm, 1.65, 0.08, 1.65),
      collars: [],
    };
  }

  const [dx, dy, dz] = pinDirectionVector(pin.direction);
  const isLead = style === 'leads';
  const length = isLead ? 10.5 : 5.2;
  const center: [number, number, number] = [
    pin.xMm + dx * length * 0.5,
    pin.yMm + dy * length * 0.5,
    pin.zMm + dz * length * 0.5,
  ];
  const rotation = pinRotation(pin.direction);

  const metalLocal = isLead
    ? createCylinderTriangles(0, 0, 0, 0.28, length, 14)
    : createBoxTriangles(0, 0, 0, 0.66, length, 0.66);

  const metal = transformTriangles(metalLocal, center, rotation);
  const collars = isLead ? [] : transformTriangles(
    createBoxTriangles(0, 0, 0, 2.2, 1.55, 2.2),
    [pin.xMm + dx * 0.45, pin.yMm + dy * 0.45, pin.zMm + dz * 0.45],
    rotation,
  );

  return { metal, collars };
}

/** Build complete collection of triangles for a component specification */
export function buildComponentGeometry(spec: CadComponentSpec): Triangle[] {
  const triangles: Triangle[] = [];
  const { widthMm, lengthMm, heightMm } = spec.dimensions;

  // 1. Base PCB / housing substrate. Discrete parts provide their whole body as features.
  if (spec.bodyStyle !== 'none') {
    triangles.push(...createBoxTriangles(0, heightMm / 2, 0, widthMm, heightMm, lengthMm));
  }

  // 2. Connector pins / component leads. Use each pin's declared anchor and direction.
  const pinStyle = spec.pinStyle ?? 'headers';
  for (const pin of spec.pins) {
    const { metal, collars } = createPinTriangles(pin, pinStyle);
    triangles.push(...collars, ...metal);
  }

  // 3. Functional / surface features.
  for (const feat of spec.features) {
    triangles.push(...createFeatureTriangles(feat));
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
