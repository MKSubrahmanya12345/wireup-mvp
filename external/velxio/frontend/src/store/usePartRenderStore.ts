import { create } from 'zustand';

/**
 * usePartRenderStore — transient, NON-persisted render-time animation values.
 *
 * The 2D part simulators write "live" visual state (servo horn angle, LED
 * brightness) straight onto the web-component DOM element (el.angle,
 * el.brightness). Those values must NOT go into `useSimulatorStore`'s
 * components[].properties — that array is serialized into the .vlx project
 * and is subscribed to by the canvas/editor/console, so a 60 Hz write there
 * re-creates the exact per-frame render storm the boolean-only
 * updateComponentState refactor was made to fix.
 *
 * This store is the single source of truth for those transient values. It is
 * intentionally unrelated to useSimulatorStore:
 *   - never serialized into .vlx / diagram.json
 *   - the 3D view reads it imperatively via getState() inside useFrame (NOT
 *     via the reactive hook form) so it never triggers a React re-render
 *   - written from the SAME call sites that set el.angle / el.brightness, so
 *     2D keeps working exactly as today
 *   - cleared on part unmount so the map never grows unbounded
 */

export interface PartRenderValue {
  /** Servo horn / stepper angle in degrees (matches what el.angle holds). */
  angle?: number;
  /** LED brightness 0..1 (matches what el.brightness holds). */
  brightness?: number;
  /** DHT22 (and other env sensors) live reading, as set on the element. */
  temperature?: number;
  /** DHT22 (and other env sensors) live reading, as set on the element. */
  humidity?: number;
  /**
   * Phase-0 widen: open bag so future parts (pressed, position, digit, r/g/b,
   * …) can be mirrored without reshaping the store again. Additive only —
   * existing `angle` / `brightness` readers are unaffected.
   */
  [key: string]: number | boolean | string | undefined;
}

interface PartRenderState {
  values: Record<string, PartRenderValue>;
  setValue: (id: string, patch: PartRenderValue) => void;
  clear: (id: string) => void;
}

export const usePartRenderStore = create<PartRenderState>((set) => ({
  values: {},
  setValue: (id, patch) =>
    set((s) => ({
      values: { ...s.values, [id]: { ...s.values[id], ...patch } },
    })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.values)) return s;
      const values = { ...s.values };
      delete values[id];
      return { values };
    }),
}));
