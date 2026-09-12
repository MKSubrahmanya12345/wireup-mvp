/**
 * <velxio-cad-bench-part> — the generic renderer for a catalog part the
 * simulator has no element for (a pump, a solenoid, an HC-05, an L298N, a
 * bare LDR cell …).
 *
 * WHY THIS EXISTS
 * ---------------
 * Wireup's registry holds 108 parts; Velxio ships a verified element for
 * roughly half of them. The other half were simply dropped from the emitted
 * project, so a design whose whole point was the pump arrived on the canvas
 * as a board with a couple of sensors and nothing else — the user could not
 * see, wire or reason about half their build, and the 3D view had no part to
 * show either.
 *
 * Wireup's CAD layer already models EVERY catalog part (dimensions, body
 * style, every pin's mm anchor — see `/cad-catalog.json`, written by
 * `pnpm export:cad-catalog`). So a CAD-only part is not an unknown: it is a
 * part whose ELECTRICAL behaviour the emulator cannot solve, but whose SHAPE
 * is known exactly. This element therefore renders an honest CAD bench part:
 *
 *   • a top-view symbol drawn from the real spec (body + every pin pad at its
 *     real millimetre coordinate, so the 2D canvas and the 3D bench agree);
 *   • a real `pinInfo` array, which is the ONLY contract the canvas wire
 *     system needs — wires, pin markers, the pin picker and breadboard
 *     seating all work exactly as they do for a wokwi element;
 *   • a visible "CAD" badge, so nobody can mistake it for a simulated part.
 *
 * What it deliberately is NOT: it registers no simulation behaviour and no
 * netlist mapper. It sits on the bench, holds its place, and shows where its
 * wires go — it does not react to signals. That is the honest boundary, and
 * it is stated on the part itself rather than only in a log.
 *
 * The instance key arrives as the `cad-key` attribute/property (Wireup's
 * exporter writes it into the component's properties bag), which is the same
 * key space `/cad-catalog.json` uses (boardKind for boards, metadataId for
 * parts).
 */

import type { CadComponentSpec } from '../scene3d/cadTypes';
import { usePartRenderStore } from '../store/usePartRenderStore';

interface ElementPin {
  name: string;
  x: number;
  y: number;
  signals: unknown[];
}

interface CadCatalogEntry {
  catalogId: string;
  kind: 'board' | 'part';
  tier: string;
  spec: CadComponentSpec;
}

interface CadCatalogManifest {
  version: number;
  generatedAt?: string;
  entries: Record<string, CadCatalogEntry>;
}

/** Canvas px per millimetre. Mirrors wokwi-element proportions closely
 *  enough that a CAD bench part sits next to a wokwi part convincingly
 *  (an Arduino Uno is ~290x210 px on this canvas for its 68x53 mm board). */
const PX_PER_MM = 4;
/** Floor/ceiling on the drawn symbol so a 2 mm LED is still clickable and a
 *  165 mm breadboard does not swallow the viewport. */
const MIN_SPAN_PX = 48;
const MAX_SPAN_PX = 620;
/** How far a pad sits outside the body's edge, along the pin's 2D direction. */
const PAD_OFFSET_PX = 5;
/** Pad radius (drawn), in px. */
const PAD_RADIUS = 3.2;

let catalogPromise: Promise<CadCatalogManifest | null> | null = null;

/** Fetch (and cache, never throw) the CAD catalog. A missing catalog means
 *  the part renders as a labelled placeholder — never a hard failure. */
function loadCatalog(): Promise<CadCatalogManifest | null> {
  if (!catalogPromise) {
    catalogPromise = fetch('/cad-catalog.json', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<CadCatalogManifest>) : null))
      .catch(() => null);
  }
  return catalogPromise;
}

/** Escape a string for safe inclusion in an SVG text node / attribute. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 2D direction of a pin, matching the 3D spec's own axis convention. */
function pinOffset(direction?: string): { x: number; y: number } {
  switch (direction) {
    case 'left':
      return { x: -PAD_OFFSET_PX, y: 0 };
    case 'right':
      return { x: PAD_OFFSET_PX, y: 0 };
    case 'front':
      return { x: 0, y: PAD_OFFSET_PX };
    case 'back':
      return { x: 0, y: -PAD_OFFSET_PX };
    default:
      // 'up' / 'down' are the vertical axis — top-down they project onto the
      // pin's own footprint, which is where the anchor really is.
      return { x: 0, y: 0 };
  }
}

export class CadBenchPartElement extends HTMLElement {
  static observedAttributes = ['cad-key'];

  private root: ShadowRoot;
  private spec: CadComponentSpec | null = null;
  private loadedKey = '';
  private waiting = false;
  private pins: ElementPin[] = [];
  private liveTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>
      :host { display: block; position: relative; }
      .sym { position: relative; }
      .cad-badge {
        position: absolute; right: 1px; bottom: 0;
        font: 600 7px/1.3 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: .04em; padding: 0 3px; border-radius: 3px;
        color: #0b1220; background: #f4c95d; opacity: .92;
        pointer-events: none; white-space: nowrap;
      }
      .live-badge {
        position: absolute; left: 1px; bottom: 0;
        font: 600 7px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .02em; padding: 0 3px; border-radius: 3px;
        color: #04121c; background: #7fd1ff; opacity: .95;
        pointer-events: none; white-space: nowrap; display: none;
      }
      .live-badge.on { display: inline-block; }
      .loading { font: 500 9px/1.4 ui-sans-serif, system-ui, sans-serif; color: #94a3b8; }
    </style><div class="sym"></div><span class="live-badge"></span>`;
    this.startLiveState();
  }

  /** The catalog key for this instance — set by the canvas from the
   *  component's properties bag (`cadKey`), which round-trips through .vlx
   *  and diagram.json like any other property. */
  get cadKey(): string {
    return this.getAttribute('cad-key') ?? '';
  }
  set cadKey(value: string) {
    if (value) this.setAttribute('cad-key', String(value));
  }

  /** The pin contract the canvas wire system reads (see
   *  utils/pinPositionCalculator.ts and utils/breadboardSnap.ts — anything
   *  with a `pinInfo` getter is wireable). */
  get pinInfo(): ElementPin[] {
    return this.pins;
  }

  connectedCallback(): void {
    this.ensureSpec();
    this.startLiveState();
  }

  disconnectedCallback(): void {
    this.stopLiveState();
  }

  /**
   * Live state, shown on the 2D symbol too.
   *
   * A CAD bench part has no electrical model, but it is still a device on a
   * bench whose pins the sketch drives — `simulation/liveState` traces those
   * drives and mirrors the result into the transient render store. This badge
   * is that state, so the canvas and the 3D view never disagree: a pump that is
   * running says so in both places, and a part with no live net says nothing.
   *
   * Polled on an interval rather than subscribed: the store is written by a
   * 90 ms watcher, the CSS class only changes when the text does, and no React
   * render is involved.
   */
  private startLiveState(): void {
    if (this.liveTimer !== null) return;
    this.liveTimer = setInterval(() => this.refreshLiveState(), 200);
    this.refreshLiveState();
  }

  private stopLiveState(): void {
    if (this.liveTimer !== null) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  /** Text for the badge, from the measured state and nothing else. */
  private liveText(): string {
    const componentId = this.closest('[data-component-id]')?.getAttribute('data-component-id') ?? '';
    const values = componentId ? usePartRenderStore.getState().values[componentId] : undefined;
    if (!values) return '';
    const num = (key: string): number => (typeof values[key] === 'number' ? (values[key] as number) : 0);
    const rpm = num('rpm');
    if (rpm > 0) return `${Math.abs(rpm)} rpm`;
    if (num('stepAngle') > 0) return `${num('stepAngle').toFixed(1)}°`;
    if (num('bus') > 0.15) return 'DATA';
    if (num('triggered') > 0) return 'ON';
    if (num('drive') > 0) return 'ENERGISED';
    return '';
  }

  private refreshLiveState(): void {
    const badge = this.root.querySelector('.live-badge');
    if (!(badge instanceof HTMLElement)) return;
    const text = this.liveText();
    if (badge.textContent !== text) badge.textContent = text;
    badge.classList.toggle('on', text.length > 0);
  }

  attributeChangedCallback(name: string): void {
    if (name === 'cad-key') this.ensureSpec();
  }

  /** Resolve the spec for the current key, then draw. */
  private ensureSpec(): void {
    const key = this.cadKey;
    if (!key || key === this.loadedKey || this.waiting) return;
    this.waiting = true;
    loadCatalog().then((catalog) => {
      this.waiting = false;
      const entry = catalog?.entries?.[key];
      if (!entry) {
        this.root.querySelector('.sym')!.innerHTML = `<div class="loading">CAD part "${esc(key)}" is not in /cad-catalog.json — run <b>pnpm export:cad-catalog</b> in Wireup.</div>`;
        return;
      }
      this.loadedKey = key;
      this.spec = entry.spec;
      this.draw();
    });
  }

  /** Draw the top-view symbol and publish pinInfo for the wire system. */
  private draw(): void {
    const spec = this.spec;
    if (!spec) return;

    const xs = spec.pins.map((p) => p.xMm).concat([-spec.dimensions.widthMm / 2, spec.dimensions.widthMm / 2]);
    const zs = spec.pins.map((p) => p.zMm).concat([-spec.dimensions.lengthMm / 2, spec.dimensions.lengthMm / 2]);
    const minX = Math.min(...xs);
    const minZ = Math.min(...zs);

    // Scale so the drawing stays legible across a 5 mm LED and a 100 mm
    // actuator, then letterbox the body inside the chosen canvas box.
    const rawWidth = Math.max(...xs) - minX;
    const rawDepth = Math.max(...zs) - minZ;
    const scale = Math.min(
      PX_PER_MM,
      MAX_SPAN_PX / Math.max(rawWidth, 1),
      MAX_SPAN_PX / Math.max(rawDepth, 1),
    );
    const widthPx = Math.max(MIN_SPAN_PX, rawWidth * scale);
    const heightPx = Math.max(MIN_SPAN_PX, rawDepth * scale);
    const padX = (widthPx - rawWidth * scale) / 2;
    const padY = (heightPx - rawDepth * scale) / 2;

    const toPx = (xMm: number, zMm: number): { x: number; y: number } => ({
      x: padX + (xMm - minX) * scale,
      y: padY + (zMm - minZ) * scale,
    });

    // Pins: real coordinates, nudged outside the body along their own axis.
    const pinPoints = spec.pins.map((pin) => {
      const base = toPx(pin.xMm, pin.zMm);
      const offset = pinOffset(pin.direction);
      return { pin, x: base.x + offset.x, y: base.y + offset.y };
    });

    this.pins = pinPoints.map(({ pin, x, y }) => ({ name: pin.name, x, y, signals: [] }));

    const body = spec.bodyStyle === 'none' ? null : {
      x: padX,
      y: padY,
      width: rawWidth * scale,
      height: rawDepth * scale,
    };

    const padMarkup = pinPoints
      .map(({ pin, x, y }) => {
        const title = esc(`${pin.name}${pin.signal ? ` — ${pin.signal}` : ''}`);
        return `<g><title>${title}</title><circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${PAD_RADIUS}" fill="#e2b53c" stroke="#7a5c11" stroke-width="0.7" /></g>`;
      })
      .join('');

    const label = spec.name.length > 26 ? `${spec.name.slice(0, 25)}…` : spec.name;

    this.root.querySelector('.sym')!.innerHTML = `
      <svg width="${Math.round(widthPx)}" height="${Math.round(heightPx)}"
           viewBox="0 0 ${widthPx.toFixed(2)} ${heightPx.toFixed(2)}"
           xmlns="http://www.w3.org/2000/svg" aria-label="${esc(spec.name)}">
        ${
          body
            ? `<rect x="${body.x.toFixed(2)}" y="${body.y.toFixed(2)}" width="${body.width.toFixed(2)}" height="${body.height.toFixed(2)}"
                     rx="3" fill="${esc(spec.bodyColor ?? '#1f6feb')}" fill-opacity="0.9" stroke="#0b1220" stroke-width="1" />`
            : `<rect x="0.5" y="0.5" width="${(widthPx - 1).toFixed(2)}" height="${(heightPx - 1).toFixed(2)}"
                     rx="3" fill="none" stroke="#64748b" stroke-width="1" stroke-dasharray="3 2" />`
        }
        <text x="${(widthPx / 2).toFixed(2)}" y="${(heightPx / 2 - 1).toFixed(2)}" text-anchor="middle"
              dominant-baseline="middle" font-family="ui-sans-serif, system-ui, sans-serif"
              font-size="8" fill="#f8fafc" fill-opacity="0.92">${esc(label)}</text>
        <text x="${(widthPx / 2).toFixed(2)}" y="${(heightPx / 2 + 8).toFixed(2)}" text-anchor="middle"
              dominant-baseline="middle" font-family="ui-sans-serif, system-ui, sans-serif"
              font-size="6" fill="#f8fafc" fill-opacity="0.6">no electrical model</text>
        ${padMarkup}
      </svg>
      <span class="cad-badge">CAD</span>`;

    // Wires to this part were resolved before its geometry existed; this is
    // the same signal a pin-set change emits, and the canvas listens for it.
    this.dispatchEvent(new Event('pininfo-change'));
  }
}

if (!customElements.get('velxio-cad-bench-part')) {
  customElements.define('velxio-cad-bench-part', CadBenchPartElement);
}
