/**
 * Unit tests for the pure rasterisers behind the 3D live surfaces.
 *
 * These are the pieces that can be wrong without anything throwing: the glyph
 * ROM walk that turns an HD44780 character buffer into pixels, the segment
 * grouping that turns the wokwi `values` array into per-digit flags, and the
 * readout text formatter. They run in the node environment — no canvas, no DOM,
 * no simulator — because the painters that need a `CanvasRenderingContext2D`
 * are thin wrappers around exactly these.
 */

import { describe, expect, it } from 'vitest';

import { rasteriseTextGrid, readoutText, segmentDigits } from '../scene3d/live/painters';

/** Glyph cell metrics of the HD44780 ROM (5×8, one blank column between). */
const GLYPH_W = 5;
const GLYPH_H = 8;
const GLYPH_GAP = 1;
const CELL_W = GLYPH_W + GLYPH_GAP;

/** A ROM where the given codes carry the given 8 rows of bits. */
function rom(codes: Record<number, number[]>, glyphs = 256): Uint8Array {
  const font = new Uint8Array(glyphs * GLYPH_H);
  for (const [code, rows] of Object.entries(codes)) {
    rows.forEach((bits, index) => {
      font[Number(code) * GLYPH_H + index] = bits;
    });
  }
  return font;
}

const litPixels = (data: Uint8Array): number[] => {
  const out: number[] = [];
  data.forEach((value, index) => {
    if (value) out.push(index);
  });
  return out;
};

describe('rasteriseTextGrid', () => {
  it('refuses to draw without a buffer, a ROM, or a grid', () => {
    expect(rasteriseTextGrid(null, rom({}), 16, 2)).toBeNull();
    expect(rasteriseTextGrid(new Uint8Array(32).fill(0x20), null, 16, 2)).toBeNull();
    expect(rasteriseTextGrid(new Uint8Array(32).fill(0x20), rom({}), 0, 2)).toBeNull();
    expect(rasteriseTextGrid(new Uint8Array(32).fill(0x20), rom({}), 16, 0)).toBeNull();
  });

  it('sizes the bitmap to the character grid', () => {
    const grid = rasteriseTextGrid(new Uint8Array(32).fill(0x20), rom({}), 16, 2);
    expect(grid).not.toBeNull();
    expect(grid?.width).toBe(16 * CELL_W - GLYPH_GAP);
    expect(grid?.height).toBe(2 * GLYPH_H);
  });

  it('leaves a blank buffer blank', () => {
    const grid = rasteriseTextGrid(new Uint8Array(32).fill(0x20), rom({}), 16, 2);
    expect(litPixels(grid?.data ?? new Uint8Array())).toEqual([]);
  });

  it('lights the ROM bits it is given, at the character cell they belong to', () => {
    // 0x41 = 'A' with only its top-left pixel set, so the expected position is
    // unambiguous: cell (0, 0), glyph row 0, glyph column 0.
    const font = rom({ 0x41: [0b10000, 0, 0, 0, 0, 0, 0, 0] });
    const chars = new Uint8Array(32).fill(0x20);
    chars[0] = 0x41;
    const grid = rasteriseTextGrid(chars, font, 16, 2);
    expect(grid?.data[0]).toBe(1);

    // Same glyph in cell (3, 1): offset by 3 cells and one glyph row.
    const second = new Uint8Array(32).fill(0x20);
    second[1 * 16 + 3] = 0x41;
    const moved = rasteriseTextGrid(second, font, 16, 2);
    const expected = GLYPH_H * (grid?.width ?? 0) + 3 * CELL_W;
    expect(litPixels(moved?.data ?? new Uint8Array())).toEqual([expected]);
  });

  it('treats a missing character as a space and skips codes the ROM cannot cover', () => {
    // A one-glyph ROM (code 0x00 only): cell 0 draws, cell 1 (0x41) is skipped
    // rather than wrapping, throwing, or reading past the ROM.
    const cells = [0x00, 0x41];
    const grid = rasteriseTextGrid(cells, rom({ 0x00: [0b11111, 0, 0, 0, 0, 0, 0, 0] }, 1), 2, 1);
    expect(litPixels(grid?.data ?? new Uint8Array())).toEqual([0, 1, 2, 3, 4]);
  });

  it('accepts a plain number[] ROM as well as a Uint8Array', () => {
    const font = Array.from(rom({ 0x41: [0b01000, 0, 0, 0, 0, 0, 0, 0] }));
    const chars = [0x41];
    const grid = rasteriseTextGrid(chars, font, 1, 1);
    expect(litPixels(grid?.data ?? new Uint8Array())).toEqual([1]);
  });
});

describe('segmentDigits', () => {
  it('groups eight segment flags per digit', () => {
    expect(segmentDigits([1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1], 2)).toEqual([
      [1, 0, 1, 0, 1, 0, 1, 0],
      [0, 1, 0, 1, 0, 1, 0, 1],
    ]);
  });

  it('pads a short array so trailing digits stay dark rather than misaligned', () => {
    expect(segmentDigits([1, 1, 1, 1, 1, 1, 1, 1], 3)).toEqual([
      [1, 1, 1, 1, 1, 1, 1, 1],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
  });

  it('always returns at least one digit, even with no values', () => {
    expect(segmentDigits(null, 0)).toEqual([[0, 0, 0, 0, 0, 0, 0, 0]]);
    expect(segmentDigits(undefined, 2)).toHaveLength(2);
  });
});

describe('readoutText', () => {
  it('formats numbers with their unit and precision', () => {
    expect(readoutText('T', 23.456, '°C', 1)).toBe('T: 23.5 °C');
    expect(readoutText('RH', 61.2, '%', 0)).toBe('RH: 61 %');
  });

  it('does not invent a value it does not have', () => {
    expect(readoutText('T', undefined, '°C')).toBe('T: — °C');
    expect(readoutText('T', null, '°C')).toBe('T: — °C');
  });

  it('passes non-numeric live values through as they are', () => {
    expect(readoutText('SW', true)).toBe('SW: on');
    expect(readoutText('SW', false)).toBe('SW: off');
    expect(readoutText('Fix', 'no-fix')).toBe('Fix: no-fix');
    expect(readoutText('Spd', '6.5', 'kn', 1)).toBe('Spd: 6.5 kn');
  });
});
