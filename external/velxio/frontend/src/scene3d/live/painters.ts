/**
 * painters — turn a part's live state into pixels for its 3D display surface.
 *
 * Every painter is generic over the part: an HD44780 panel is painted from the
 * character buffer and the element's OWN glyph ROM, a 7-segment panel from its
 * segment array, a WS2812B field from its pixel list. Nothing here knows what
 * "LCD1602" or "neopixel ring" is — that lives in the data table.
 *
 * The rasterisers are pure (no canvas, no DOM) so the arithmetic that decides
 * what a display shows is unit-tested directly; the `paint*` wrappers only
 * blit those results.
 */

import type { StoredPixel } from './signals';
import type { SurfaceStyle } from './surfaceTypes';

/** HD44780 cell geometry, in font pixels. */
export const GLYPH_W = 5;
export const GLYPH_H = 8;
/** One blank column between characters, so text stays legible when scaled. */
export const GLYPH_GAP = 1;

/**
 * Rasterise a character grid into a 1-bit bitmap.
 *
 * `font` is the element's own HD44780 ROM (the very array the 2D element
 * draws its SVG from — `wokwi-lcd1602` exposes it as `font`): 8 bytes per
 * character, each byte's low five bits are one row, bit 4 leftmost. Using the
 * part's own ROM is what makes the 3D panel show the same glyphs, the same
 * custom characters and the same symbols as the 2D panel.
 *
 * Returns null when the ROM is missing or too short for the highest character
 * code in the buffer — better a blank screen than wrong glyphs.
 */
export function rasteriseTextGrid(
  chars: Uint8Array | number[] | null | undefined,
  font: Uint8Array | number[] | null | undefined,
  cols: number,
  rows: number,
): { data: Uint8Array; width: number; height: number } | null {
  if (!chars || !font || cols <= 0 || rows <= 0) return null;
  const rom = font instanceof Uint8Array ? font : Uint8Array.from(font);
  const width = cols * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP;
  const height = rows * GLYPH_H;
  const out = new Uint8Array(width * height);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const code = (chars[row * cols + col] ?? 0x20) & 0xff;
      const offset = code * GLYPH_H;
      if (offset + GLYPH_H > rom.length) continue; // ROM does not cover this code
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const bits = rom[offset + gy] ?? 0;
        if (bits === 0) continue;
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if ((bits >> (GLYPH_W - 1 - gx)) & 1) {
            const x = col * (GLYPH_W + GLYPH_GAP) + gx;
            const y = row * GLYPH_H + gy;
            out[y * width + x] = 1;
          }
        }
      }
    }
  }
  return { data: out, width, height };
}

/** Paint a text grid: backlight wash, glyphs, cursor. */
export function paintTextGrid(
  ctx: CanvasRenderingContext2D,
  opts: {
    width: number;
    height: number;
    chars: Uint8Array | number[] | null | undefined;
    font: Uint8Array | number[] | null | undefined;
    cols: number;
    rows: number;
    backlight?: boolean;
    cursor?: boolean;
    blink?: boolean;
    cursorX?: number;
    cursorY?: number;
    style?: SurfaceStyle;
  },
): void {
  const { width, height, cols, rows, style } = opts;
  const backlight = opts.backlight !== false;
  ctx.clearRect(0, 0, width, height);
  // Panel: a lit LCD is a green/blue wash; an unlit one keeps a dark tint.
  ctx.fillStyle = backlight ? (style?.backlightColor ?? '#7ec850') : (style?.offColor ?? '#20301c');
  ctx.fillRect(0, 0, width, height);

  const bitmap = rasteriseTextGrid(opts.chars, opts.font, cols, rows);
  if (bitmap) {
    const scaleX = width / bitmap.width;
    const scaleY = height / bitmap.height;
    ctx.fillStyle = style?.textColor ?? '#0b1a08';
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        if (!bitmap.data[y * bitmap.width + x]) continue;
        ctx.fillRect(x * scaleX, y * scaleY, Math.ceil(scaleX), Math.ceil(scaleY));
      }
    }
  }

  if (opts.cursor) {
    const cellW = width / cols;
    const cellH = height / rows;
    const x = Math.min(Math.max(opts.cursorX ?? 0, 0), cols - 1) * cellW;
    const y = Math.min(Math.max(opts.cursorY ?? 0, 0), rows - 1) * cellH;
    ctx.fillStyle = style?.textColor ?? '#0b1a08';
    // A cursor occupies the bottom row of the cell, like the real controller.
    const h = Math.max(1, cellH * 0.14);
    ctx.fillRect(x, y + cellH - h, cellW, h);
  }
}

/** Copy an `ImageData` framebuffer (SSD1306) into the texture. */
export function paintImageData(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData | null | undefined,
  width: number,
  height: number,
  style?: SurfaceStyle,
): void {
  ctx.clearRect(0, 0, width, height);
  if (!imageData || !imageData.data || imageData.width <= 0 || imageData.height <= 0) {
    ctx.fillStyle = style?.offColor ?? '#05070a';
    ctx.fillRect(0, 0, width, height);
    return;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const scratch = document.createElement('canvas');
  scratch.width = imageData.width;
  scratch.height = imageData.height;
  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) {
    ctx.restore();
    return;
  }
  scratchCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(scratch, 0, 0, width, height);
  ctx.restore();
}

/** Copy a real element canvas (ILI9341, ePaper) into the texture. */
export function paintCanvas(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement | null | undefined,
  width: number,
  height: number,
  style?: SurfaceStyle,
): boolean {
  if (!source || source.width === 0 || source.height === 0) return false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  if (style?.opacity !== undefined && style.opacity < 1) {
    ctx.fillStyle = `rgba(0,0,0,${1 - style.opacity})`;
    ctx.fillRect(0, 0, width, height);
  }
  return true;
}

/** Segment names in the order the 7-segment elements store them. */
export const SEGMENT_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'] as const;

/** Segment polygons in a normalised 0..1 cell (x right, y down). */
const SEGMENT_POLYGONS: Record<(typeof SEGMENT_ORDER)[number], [number, number][]> = {
  A: [
    [0.12, 0.06],
    [0.88, 0.06],
    [0.79, 0.16],
    [0.21, 0.16],
  ],
  B: [
    [0.88, 0.08],
    [0.96, 0.18],
    [0.96, 0.48],
    [0.87, 0.44],
    [0.87, 0.18],
  ],
  C: [
    [0.96, 0.52],
    [0.96, 0.82],
    [0.87, 0.92],
    [0.87, 0.56],
  ],
  D: [
    [0.21, 0.84],
    [0.79, 0.84],
    [0.88, 0.94],
    [0.12, 0.94],
  ],
  E: [
    [0.04, 0.52],
    [0.13, 0.56],
    [0.13, 0.92],
    [0.04, 0.82],
  ],
  F: [
    [0.04, 0.18],
    [0.13, 0.18],
    [0.13, 0.44],
    [0.04, 0.48],
  ],
  G: [
    [0.13, 0.5],
    [0.87, 0.5],
    [0.87, 0.56],
    [0.79, 0.56],
    [0.79, 0.5],
    [0.21, 0.5],
    [0.21, 0.56],
    [0.13, 0.56],
  ],
  DP: [
    [0.88, 0.86],
    [0.98, 0.86],
    [0.98, 0.98],
    [0.88, 0.98],
  ],
};

/**
 * Normalise a segment array to one 8-entry group per digit.
 * `values` is 8 flags per digit (A, B, C, D, E, F, G, DP), as the wokwi
 * element documents. Trailing zeros are padded so a short array still paints.
 */
export function segmentDigits(values: number[] | null | undefined, digits: number): number[][] {
  const count = Math.max(1, Math.floor(digits) || 1);
  const out: number[][] = [];
  for (let d = 0; d < count; d++) {
    const group: number[] = [];
    for (let s = 0; s < SEGMENT_ORDER.length; s++) group.push(values?.[d * SEGMENT_ORDER.length + s] ? 1 : 0);
    out.push(group);
  }
  return out;
}

/** Paint a 7-segment panel. */
export function paintSegments(
  ctx: CanvasRenderingContext2D,
  opts: {
    width: number;
    height: number;
    values: number[] | null | undefined;
    digits: number;
    colon?: boolean;
    colonValue?: boolean;
    style?: SurfaceStyle;
  },
): void {
  const { width, height, style } = opts;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = style?.offColor ?? '#0a0a0c';
  ctx.fillRect(0, 0, width, height);

  const groups = segmentDigits(opts.values, opts.digits);
  const showColon = opts.colon === true;
  const colonH = height * 0.07;
  const colonW = width * 0.04;
  const units = groups.length + (showColon ? 0.4 : 0);
  const cellW = width / units;
  const onColor = style?.onColor ?? '#ff3b30';
  const dimColor = style?.dimColor ?? '#1c1c1f';

  groups.forEach((group, index) => {
    const x0 = index * cellW + cellW * 0.06;
    const y0 = height * 0.06;
    const w = cellW * 0.88;
    const h = height * 0.88;
    SEGMENT_ORDER.forEach((name, segIndex) => {
      const lit = group[segIndex] === 1;
      ctx.fillStyle = lit ? onColor : dimColor;
      ctx.beginPath();
      for (const [px, py] of SEGMENT_POLYGONS[name]) {
        const x = x0 + px * w;
        const y = y0 + py * h;
        if (ctx.moveTo) {
          if (ctx.lineTo) {
            if (px === SEGMENT_POLYGONS[name][0][0] && py === SEGMENT_POLYGONS[name][0][1]) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }
      }
      ctx.closePath();
      ctx.fill();
    });
  });

  if (showColon) {
    const cx = groups.length * cellW + cellW * 0.2;
    ctx.fillStyle = opts.colonValue ? onColor : dimColor;
    ctx.fillRect(cx, height * 0.32, colonW, colonH);
    ctx.fillRect(cx, height * 0.62, colonW, colonH);
  }
}

/** Paint an LED bar graph. */
export function paintBarGraph(
  ctx: CanvasRenderingContext2D,
  opts: { width: number; height: number; values: number[] | null | undefined; style?: SurfaceStyle },
): void {
  const { width, height, style } = opts;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = style?.offColor ?? '#0a0a0c';
  ctx.fillRect(0, 0, width, height);
  const values = opts.values ?? [];
  const count = Math.max(values.length, 1);
  const barW = width / count;
  values.forEach((value, index) => {
    const lit = Number(value) > 0;
    ctx.fillStyle = lit ? (style?.onColor ?? '#ffb300') : (style?.dimColor ?? '#1a1a1d');
    ctx.fillRect(index * barW + barW * 0.12, height * 0.12, barW * 0.76, height * 0.76);
  });
}

/**
 * Paint an addressable-RGB pixel field (WS2812B single / strip / ring /
 * matrix). Pixels are drawn as soft dots so a ring reads as a ring and a
 * matrix as a grid — the layout is data (`DisplaySource.layout`).
 */
export function paintRgbPixels(
  ctx: CanvasRenderingContext2D,
  opts: {
    width: number;
    height: number;
    pixels: StoredPixel[] | null | undefined;
    layout: 'single' | 'strip' | 'ring' | 'matrix';
    rows?: number;
    cols?: number;
    style?: SurfaceStyle;
  },
): void {
  const { width, height, layout, style } = opts;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = style?.offColor ?? 'rgba(6,8,10,0.85)';
  ctx.fillRect(0, 0, width, height);

  const pixels = opts.pixels ?? [];
  const cols = Math.max(1, opts.cols ?? (layout === 'matrix' ? 8 : pixels.length || 1));
  const rows = Math.max(1, opts.rows ?? Math.ceil((pixels.length || 1) / cols));
  const radius = layout === 'single' ? Math.min(width, height) / 2 : Math.min(width / cols, height / rows) * 0.45;

  const place = (index: number): { x: number; y: number } => {
    if (layout === 'single') return { x: width / 2, y: height / 2 };
    if (layout === 'strip') {
      const step = width / Math.max(pixels.length, 1);
      return { x: step * (index + 0.5), y: height / 2 };
    }
    if (layout === 'ring') {
      const angle = (index / Math.max(pixels.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const r = Math.min(width, height) / 2 - radius - 1;
      return { x: width / 2 + Math.cos(angle) * r, y: height / 2 + Math.sin(angle) * r };
    }
    const row = Math.floor(index / cols);
    const col = index % cols;
    const stepX = width / cols;
    const stepY = height / rows;
    return { x: stepX * (col + 0.5), y: stepY * (row + 0.5) };
  };

  pixels.forEach((pixel, index) => {
    const { x, y } = place(index);
    const r = Math.max(0, Math.min(255, pixel.r ?? 0));
    const g = Math.max(0, Math.min(255, pixel.g ?? 0));
    const b = Math.max(0, Math.min(255, pixel.b ?? 0));
    const lit = r + g + b > 0;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(radius * 1.6, 0.5));
    gradient.addColorStop(0, `rgba(${r},${g},${b},${lit ? 1 : 0.12})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(radius * 1.6, 0.5), 0, Math.PI * 2);
    ctx.fill();
    if (lit) {
      ctx.fillStyle = `rgb(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/**
 * Text for a readout plaque row.
 *
 * A signal that has no value yet reads `—`, never `0`: `Number(null) === 0`
 * would otherwise print a confident zero for a sensor the sketch has not
 * touched, which is exactly the kind of invention this view avoids.
 */
export function readoutText(label: string, value: unknown, unit?: string, precision = 0): string {
  let shown: string;
  if (value === undefined || value === null || value === '') shown = '—';
  else if (typeof value === 'boolean') shown = value ? 'on' : 'off';
  else if (typeof value === 'number') shown = Number.isFinite(value) ? value.toFixed(precision) : String(value);
  else if (typeof value === 'string') {
    const numeric = Number(value);
    shown = Number.isFinite(numeric) ? numeric.toFixed(precision) : value;
  } else shown = String(value);
  return `${label}: ${shown}${unit ? ` ${unit}` : ''}`;
}
