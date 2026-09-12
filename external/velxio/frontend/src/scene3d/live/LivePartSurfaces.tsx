/**
 * LivePartSurfaces — the 3D half of "the LCD shows what the code printed".
 *
 * Mounted inside a part's group, it renders every surface the live-surface
 * table declares for that part and drives it from the part's own live state:
 * the character buffer the sketch wrote, the framebuffer the driver pushed, the
 * pixel stream the WS2812B decoder decoded, the PWM duty, the horn angle, the
 * sensor reading.
 *
 * How it stays honest and generic:
 *   • the SOURCE is the live 2D element (`document.getElementById(id)`) and the
 *     transient render store the parts already write — the same values the 2D
 *     canvas shows, not a re-simulation;
 *   • the WHAT and WHERE come from `/live-surfaces.json` (data, verified by
 *     Wireup's `pnpm verify:3d-live`), never from a switch on a part name in
 *     this file;
 *   • a surface whose anchor does not resolve is not drawn — no stand-in.
 *
 * Updates run in `useFrame`, imperatively, and only when the value that feeds a
 * surface actually changed — so a 60 Hz render loop never repaints a static
 * LCD, and React never re-renders on a sketch's print.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Box3,
  BoxGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from 'three';
import type { LoadedModel } from '../models3d';
import type { CadComponentSpec } from '../cadTypes';
import { applyAnchorTweaks, resolveAnchor, type ResolvedAnchor } from './anchors';
import { paintBarGraph, paintCanvas, paintImageData, paintRgbPixels, paintSegments, paintTextGrid, readoutText } from './painters';
import { asBoolean, asNumber, liveElement, parseColor, readPixels, readSignal } from './signals';
import { liveSurfacesFor, loadLiveSurfaces } from './liveSurfaceManifest';
import type { LiveSurface, PartLiveSurfaces, SurfaceStyle } from './surfaceTypes';

/** A driven part below this level does not visibly turn (a motor at 1 % duty
 *  is stopped as far as the eye is concerned). Overridable per surface. */
const DISPLAY_DEADBAND = 0.02;
/** The fastest rotation the renderer draws, in turns per second. A 9000 rpm
 *  coin motor turns 150×/s, which at 60 Hz aliases into a blur that reads as
 *  stationary; the readout still reports the true figure. */
const DISPLAY_MAX_TURNS_PER_SECOND = 6;

/** Pixels per millimetre for a display texture — one setting, so an LCD and an
 *  OLED are equally crisp without either dictating its own resolution. */
const PX_PER_MM = 18;
const MIN_TEXTURE = 64;
const MAX_TEXTURE = 1024;

function textureSize(widthMm: number, depthMm: number, aspectOverride?: [number, number]): [number, number] {
  if (aspectOverride) {
    const [w, h] = aspectOverride;
    if (w > 0 && h > 0) {
      const scale = Math.min(MAX_TEXTURE / w, MAX_TEXTURE / h, PX_PER_MM);
      return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
    }
  }
  return [
    Math.max(MIN_TEXTURE, Math.min(MAX_TEXTURE, Math.round(Math.abs(widthMm) * PX_PER_MM))),
    Math.max(MIN_TEXTURE, Math.min(MAX_TEXTURE, Math.round(Math.abs(depthMm) * PX_PER_MM))),
  ];
}

interface PaintedSurface {
  surface: LiveSurface;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  lastKey: string;
}

interface MotionSurface {
  surface: LiveSurface;
  target: Object3D;
  baseRotation: [number, number, number];
  basePosition: Vector3;
  /** Angle a `spin` motion has integrated to (radians, about its axis). */
  spinAngle?: number;
}

interface EmissiveSurface {
  surface: LiveSurface;
  material: MeshStandardMaterial;
  baseEmissive: [number, number, number];
}

interface PlaqueSurface {
  surface: LiveSurface;
  mesh: Mesh;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  lastKey: string;
}

/** A cheap change key: values that feed a painter, stringified. */
function hashKey(parts: unknown[]): string {
  let out = '';
  for (const part of parts) {
    if (part === null || part === undefined) out += '|';
    else if (Array.isArray(part) || ArrayBuffer.isView(part)) out += `|${(part as ArrayLike<number>).length}:${Array.from(part as ArrayLike<number>).join(',')}`;
    else if (typeof part === 'object') out += `|${JSON.stringify(part)}`;
    else out += `|${String(part)}`;
  }
  return out;
}

function styledMaterial(style: SurfaceStyle | undefined, texture: CanvasTexture): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    opacity: style?.opacity ?? 1,
    toneMapped: false,
  });
}

/**
 * Bounding box of a subtree, expressed in the object's OWN frame.
 *
 * `Box3.setFromObject` answers in world space, which is the wrong frame for a
 * feature that carries a rotation of its own (the CAD specs rotate a motor's
 * output shafts 90° so they lie along Z): a shaft must turn about its own axis,
 * whatever the model's orientation on the bench.
 */
export function localBounds(object: Object3D): Box3 {
  object.updateWorldMatrix(true, true);
  const toLocal = new Matrix4().copy(object.matrixWorld).invert();
  const box = new Box3();
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.geometry || mesh.userData.liveSpinMark) return;
    mesh.geometry.computeBoundingBox();
    const bounds = mesh.geometry.boundingBox?.clone();
    if (!bounds) return;
    bounds.applyMatrix4(new Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld));
    box.union(bounds);
  });
  return box;
}

/**
 * The axis a rotating feature turns about — read from its own shape.
 *
 * Every rotating feature is a body of revolution: a shaft is long and thin, a
 * fan's blade ring is wide and flat, a stepper's shaft is long and thin again.
 * In both shapes the axis is the dimension that differs from the other two, so
 * it comes from the geometry rather than from a per-part declaration (which the
 * spec's own rotations would contradict). Ties prefer `y`, then `x`, then `z`.
 */
export function inferSpinAxis(object: Object3D): 'x' | 'y' | 'z' {
  const size = localBounds(object).getSize(new Vector3());
  const candidates: { axis: 'x' | 'y' | 'z'; extent: number }[] = [
    { axis: 'y', extent: size.y },
    { axis: 'x', extent: size.x },
    { axis: 'z', extent: size.z },
  ];
  let best = candidates[0] as { axis: 'x' | 'y' | 'z'; extent: number };
  let bestScore = -1;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.extent) || candidate.extent <= 0) continue;
    const others = candidates.filter((entry) => entry.axis !== candidate.axis).map((entry) => entry.extent);
    const mean = (others[0]! + others[1]!) / 2;
    if (mean <= 0) continue;
    const score = Math.abs(candidate.extent - mean) / mean;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best.axis;
}

/**
 * A raised index mark on a turning body.
 *
 * A shaft is a solid of revolution: spinning it changes nothing on screen, and
 * a bench of invisible motion is as useless as a bench of fake motion. Real
 * hardware solves this the same way — a keyway, a painted stripe, a cooling fin
 * — so the 3D layer adds one small key to a rotating feature. It is geometry,
 * not animation: it turns because the part turns, and it is the only added
 * geometry in the whole live layer.
 */
export function addSpinMark(target: Object3D): void {
  if (target.userData.liveSpinMark) return;
  if (target.children.some((child) => child.name === 'live:index-mark')) return;
  const size = localBounds(target).getSize(new Vector3());
  if (size.x <= 0 && size.y <= 0 && size.z <= 0) return;
  const axis = inferSpinAxis(target);
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const extents = [size.x, size.y, size.z];
  const length = extents[index] ?? 0;
  const radial = Math.max(...extents.filter((_, position) => position !== index)) / 2;
  if (!(radial > 0.25) || !(length > 0.25)) return;

  // A key lying along the axis, proud of the surface by a few percent of radius.
  const thickness = Math.max(radial * 0.22, 0.12);
  const tangential = Math.max(radial * 0.5, 0.2);
  const along = Math.max(length * 0.72, 0.3);
  const geometry =
    axis === 'x'
      ? new BoxGeometry(along, tangential, thickness)
      : axis === 'y'
        ? new BoxGeometry(tangential, along, thickness)
        : new BoxGeometry(tangential, thickness, along);

  const material = new MeshStandardMaterial({
    color: markColorFor(target),
    roughness: 0.45,
    metalness: 0.2,
  });
  const mark = new Mesh(geometry, material);
  mark.name = 'live:index-mark';
  // Both ends carry the flag: `localBounds` skips marks while measuring, and a
  // second pass (a re-mount, a spec reload) must not stack a second key.
  mark.userData.liveSpinMark = true;
  target.userData.liveSpinMark = true;
  mark.position.set(
    axis === 'y' ? radial * 0.92 : 0,
    axis === 'x' ? radial * 0.92 : 0,
    axis === 'z' ? radial * 0.92 : 0,
  );
  target.add(mark);
}

/** Dark mark on a pale body, pale mark on a dark one — always legible. */
export function markColorFor(target: Object3D): string {
  let luminance = 0.2;
  target.traverse((child) => {
    const material = ((child as Mesh).material ?? null) as MeshStandardMaterial | null;
    if (material && material.color && 'r' in material.color) {
      luminance = 0.2126 * material.color.r + 0.7152 * material.color.g + 0.0722 * material.color.b;
    }
  });
  return luminance > 0.5 ? '#0f1728' : '#e8f0fb';
}

/** Seat a panel on the anchor's face: the plane's +Y face becomes the anchor's
 *  face normal, with the texture's top edge pointing away from the bench
 *  camera (so a top-mounted LCD reads upright from the viewer's side). */
function seatPanel(mesh: Object3D, placement: ResolvedAnchor): void {
  mesh.position.copy(placement.position);
  mesh.quaternion.copy(placement.quaternion);
  mesh.rotateX(-Math.PI / 2);
}

export interface LivePartSurfacesProps {
  componentId: string;
  /** The catalog key this instance was placed under (metadataId). */
  catalogKey: string;
  /** Is this part selected in the scene (drives `selectedOnly` plaques)? */
  selected?: boolean;
  model: LoadedModel;
  spec?: CadComponentSpec | undefined;
  /** Root object the surfaces belong to (the part's scene clone). */
  root: Object3D;
  /** Body bounds in the group's frame (for `bodyTop` anchors). */
  bounds?: Box3 | undefined;
}

export function LivePartSurfaces({ componentId, catalogKey, model, spec, root, bounds, selected = false }: LivePartSurfacesProps) {
  const [manifestEpoch, setManifestEpoch] = useState(0);
  const [group, setGroup] = useState<Group | null>(null);
  const frameUpdate = useRef<((deltaSeconds: number) => void) | null>(null);

  useEffect(() => {
    let alive = true;
    void loadLiveSurfaces().then(() => {
      if (alive) setManifestEpoch((epoch) => epoch + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  const definition = useMemo<PartLiveSurfaces | null>(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => liveSurfacesFor(catalogKey),
    [catalogKey, manifestEpoch],
  );

  useEffect(() => {
    if (!group || !definition?.surfaces?.length) return undefined;

    const painted: PaintedSurface[] = [];
    const motions: MotionSurface[] = [];
    const emissives: EmissiveSurface[] = [];
    const plaques: PlaqueSurface[] = [];
    const disposers: (() => void)[] = [];
    const addPanel = (surface: LiveSurface, placement: ResolvedAnchor, aspect?: [number, number]): PaintedSurface | null => {
      const [width, height] = textureSize(placement.width, placement.depth, aspect);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = 'srgb';
      texture.anisotropy = 4;
      const geometry = new PlaneGeometry(Math.max(placement.width, 0.5), Math.max(placement.depth, 0.5));
      const mesh = new Mesh(geometry, styledMaterial(surface.style, texture));
      mesh.renderOrder = 4;
      seatPanel(mesh, placement);
      group.add(mesh);
      disposers.push(() => {
        geometry.dispose();
        mesh.material.dispose();
        texture.dispose();
        group.remove(mesh);
      });
      return { surface, canvas, ctx, texture, lastKey: '' };
    };

    for (const surface of definition.surfaces) {
      const resolved = resolveAnchor(surface.anchor, root, { spec, recenter: model.recenter, bounds });
      if (!resolved) continue; // no anchor → no surface (never a stand-in)
      const placement = applyAnchorTweaks(resolved, surface.anchor);

      if (surface.kind === 'emissive') {
        const material = placement.material;
        if (!(material instanceof MeshStandardMaterial)) continue;
        const cloned = material.clone();
        root.traverse((object: Object3D) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          if (mesh.material === material) mesh.material = cloned;
          else if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((entry) => (entry === material ? cloned : entry));
          }
        });
        emissives.push({ surface, material: cloned, baseEmissive: [cloned.emissive.r, cloned.emissive.g, cloned.emissive.b] });
        continue;
      }

      if (surface.kind === 'motion') {
        if (!placement.target) continue;
        motions.push({
          surface,
          target: placement.target,
          baseRotation: [placement.target.rotation.x, placement.target.rotation.y, placement.target.rotation.z],
          basePosition: placement.target.position.clone(),
        });
        continue;
      }

      if (surface.kind === 'readout') {
        const rows = surface.readout?.rows ?? [];
        const rowsCount = Math.max(rows.length, 1);
        const panel = addPanel(surface, { ...placement, width: 64, depth: rowsCount * 9 }, [64, rowsCount * 9]);
        if (panel) {
          const mesh = group.children[group.children.length - 1] as Mesh;
          plaques.push({ surface, mesh, canvas: panel.canvas, ctx: panel.ctx, texture: panel.texture, lastKey: '' });
        }
        continue;
      }

      const aspect =
        surface.kind === 'image-data'
          ? ([surface.display?.width ?? 128, surface.display?.height ?? 64] as [number, number])
          : surface.kind === 'canvas'
            ? undefined
            : undefined;
      const panel = addPanel(surface, placement, aspect);
      if (panel) painted.push(panel);
    }

    // ── per-frame update (imperative; no React state) ──────────────────────
    const update = (deltaSeconds: number): void => {
      const el = liveElement(componentId);

      for (const entry of painted) {
        const { surface, ctx, canvas } = entry;
        const display = surface.display;
        let key = '';

        switch (surface.kind) {
          case 'text-grid': {
            const chars = readSignal(componentId, el, display?.characters) as Uint8Array | number[] | null;
            const font = readSignal(componentId, el, display?.font) as Uint8Array | number[] | null;
            const backlight = display?.backlight ? asBoolean(readSignal(componentId, el, display.backlight)) : undefined;
            const cursor = display?.cursor ? asBoolean(readSignal(componentId, el, display.cursor)) : undefined;
            const cursorX = display?.cursorX ? (asNumber(readSignal(componentId, el, display.cursorX)) ?? 0) : 0;
            const cursorY = display?.cursorY ? (asNumber(readSignal(componentId, el, display.cursorY)) ?? 0) : 0;
            key = hashKey([chars, backlight, cursor, cursorX, cursorY]);
            if (key === entry.lastKey) break;
            paintTextGrid(ctx, {
              width: canvas.width,
              height: canvas.height,
              chars,
              font,
              cols: display?.cols ?? 16,
              rows: display?.rows ?? 2,
              ...(backlight !== undefined ? { backlight } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
              cursorX,
              cursorY,
              ...(surface.style ? { style: surface.style } : {}),
            });
            entry.texture.needsUpdate = true;
            break;
          }
          case 'image-data': {
            const imageData = readSignal(componentId, el, display?.imageData) as ImageData | null;
            // The buffer is mutated in place, so sample a slice as the key.
            const sample = imageData?.data ? `${imageData.width}x${imageData.height}:${Array.from(imageData.data.slice(0, 96)).join(',')}` : 'none';
            key = sample;
            if (key === entry.lastKey) break;
            paintImageData(ctx, imageData, canvas.width, canvas.height, surface.style);
            entry.texture.needsUpdate = true;
            break;
          }
          case 'canvas': {
            const source = readSignal(componentId, el, display?.canvas) as HTMLCanvasElement | null;
            if (!paintCanvas(ctx, source, canvas.width, canvas.height, surface.style)) break;
            entry.texture.needsUpdate = true;
            break;
          }
          case 'rgb-pixels': {
            const pixels = readPixels(componentId);
            key = hashKey([pixels]);
            if (key === entry.lastKey) break;
            paintRgbPixels(ctx, {
              width: canvas.width,
              height: canvas.height,
              pixels,
              layout: display?.layout ?? 'matrix',
              ...(display?.rows !== undefined ? { rows: display.rows } : {}),
              ...(display?.cols !== undefined ? { cols: display.cols } : {}),
              ...(surface.style ? { style: surface.style } : {}),
            });
            entry.texture.needsUpdate = true;
            break;
          }
          case 'segments': {
            const values = readSignal(componentId, el, display?.values ?? 'values') as number[] | null;
            const digits = asNumber(readSignal(componentId, el, display?.digits ?? 'digits')) ?? 1;
            const colon = display?.colon ? asBoolean(readSignal(componentId, el, display.colon)) : undefined;
            const colonValue = display?.colonValue ? asBoolean(readSignal(componentId, el, display.colonValue)) : undefined;
            key = hashKey([values, digits, colon, colonValue]);
            if (key === entry.lastKey) break;
            paintSegments(ctx, {
              width: canvas.width,
              height: canvas.height,
              values,
              digits,
              ...(colon !== undefined ? { colon } : {}),
              ...(colonValue !== undefined ? { colonValue } : {}),
              ...(surface.style ? { style: surface.style } : {}),
            });
            entry.texture.needsUpdate = true;
            break;
          }
          case 'bar-graph': {
            const values = readSignal(componentId, el, display?.values ?? 'values') as number[] | null;
            key = hashKey([values]);
            if (key === entry.lastKey) break;
            paintBarGraph(ctx, { width: canvas.width, height: canvas.height, values, ...(surface.style ? { style: surface.style } : {}) });
            entry.texture.needsUpdate = true;
            break;
          }
          default:
            break;
        }
        entry.lastKey = key;
      }

      for (const plaque of plaques) {
        // A measurement plaque is an inspection aid, not part of the model: it
        // appears when the part is selected, so a bench full of motors is not
        // buried under floating labels.
        const selectedOnly = plaque.surface.readout?.selectedOnly === true;
        plaque.mesh.visible = !selectedOnly || selected;
        if (!plaque.mesh.visible) continue;
        const rows = plaque.surface.readout?.rows ?? [];
        const values = rows.map((row) => readSignal(componentId, el, row.prop));
        const key = hashKey(values);
        if (key === plaque.lastKey) continue;
        plaque.lastKey = key;
        const { ctx, canvas } = plaque;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(8,12,18,0.82)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = plaque.surface.style?.labelColor ?? '#e8eef7';
        const rowsCount = Math.max(rows.length, 1);
        const size = Math.max(9, Math.floor((canvas.height / rowsCount) * 0.52));
        ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textBaseline = 'middle';
        rows.forEach((row, index) => {
          ctx.fillText(readoutText(row.label, values[index], row.unit, row.precision ?? 0), 8, (index + 0.5) * (canvas.height / rowsCount));
        });
        plaque.texture.needsUpdate = true;
      }

      for (const emissive of emissives) {
        const source = emissive.surface.emissive;
        if (!source) continue;
        const props = source.props ?? [];
        let intensity = 0;
        let color: [number, number, number] | null = null;

        switch (source.mode) {
          case 'brightness':
            intensity = asNumber(readSignal(componentId, el, props[0])) ?? 0;
            break;
          case 'value-fraction': {
            const value = asNumber(readSignal(componentId, el, props[0]));
            const [min, max] = source.valueRange ?? [0, 1];
            intensity = value === null ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
            break;
          }
          case 'boolean':
            intensity = asBoolean(readSignal(componentId, el, props[0])) ? 1 : 0;
            break;
          case 'rgb255': {
            const channels = props.map((p) => (asNumber(readSignal(componentId, el, p)) ?? 0) / 255);
            color = [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
            intensity = Math.max(color[0], color[1], color[2]);
            break;
          }
          case 'rgb01': {
            const channels = props.map((p) => asNumber(readSignal(componentId, el, p)) ?? 0);
            color = [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
            intensity = Math.max(color[0], color[1], color[2]);
            break;
          }
          case 'channels': {
            const lit = props.map((p) => asBoolean(readSignal(componentId, el, p)));
            const colors = source.colors ?? ['#ff3b30', '#34c759', '#0a84ff'];
            const sum: [number, number, number] = [0, 0, 0];
            lit.forEach((isOn, index) => {
              if (!isOn) return;
              const [r, g, b] = parseColor(colors[index], [1, 1, 1]);
              sum[0] += r;
              sum[1] += g;
              sum[2] += b;
            });
            const norm = Math.max(sum[0], sum[1], sum[2], 1);
            if (Math.max(sum[0], sum[1], sum[2]) > 0) color = [sum[0] / norm, sum[1] / norm, sum[2] / norm];
            intensity = Math.max(sum[0], sum[1], sum[2]) > 0 ? 1 : 0;
            break;
          }
          default:
            break;
        }

        const clamped = Math.max(0, Math.min(1, intensity));
        emissive.material.emissiveIntensity = clamped * (source.max ?? 1) * 2.2;
        // The part's own colour wins over the table's fallback: a red LED glows
        // red, and a WS2812B strand lit green is not tinted by a default.
        const fromElement = source.colorProp ? readSignal(componentId, el, source.colorProp) : undefined;
        if (color) emissive.material.emissive.setRGB(color[0], color[1], color[2]);
        else if (typeof fromElement === 'string' && fromElement.length > 0) {
          const [r, g, b] = parseColor(fromElement, emissive.baseEmissive);
          emissive.material.emissive.setRGB(r, g, b);
        } else if (source.color) {
          const [r, g, b] = parseColor(source.color, emissive.baseEmissive);
          emissive.material.emissive.setRGB(r, g, b);
        }
      }

      for (const motion of motions) {
        const source = motion.surface.motion;
        if (!source) continue;
        const target = motion.target;
        // Rotating modes read their axis from the body's own shape; a declared
        // axis wins, and the other modes keep the bench's up axis as default.
        const axis =
          source.axis ?? (source.mode === 'spin' || source.mode === 'rotate' ? inferSpinAxis(target) : 'y');
        if (source.mode === 'spin' || source.mode === 'rotate') addSpinMark(target);
        const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;

        if (source.mode === 'rotate') {
          // The live value IS an absolute angle (a stepper's accumulated shaft
          // position): place the node there, no integration, no clamping.
          const degrees = asNumber(readSignal(componentId, el, source.props[0])) ?? 0;
          target.rotation.set(motion.baseRotation[0], motion.baseRotation[1], motion.baseRotation[2]);
          target.rotation[axis === 'x' ? 'x' : axis === 'y' ? 'y' : 'z'] +=
            ((source.invert ? -degrees : degrees) * Math.PI) / 180;
          continue;
        }

        if (source.mode === 'spin') {
          // A driven shaft TURNS: the live signals are the drive level and the
          // part's own rate in turns per second, so the angle integrates over
          // real time. A shaft with no drive keeps the angle it stopped at.
          const drive = asNumber(readSignal(componentId, el, source.props[0])) ?? 0;
          const rate = source.props[1] ? (asNumber(readSignal(componentId, el, source.props[1])) ?? 0) : 0;
          const deadband = source.deadband ?? DISPLAY_DEADBAND;
          if (drive <= deadband || rate === 0) continue; // stopped: hold the angle
          // Legibility clamp: a 9000 rpm coin motor would alias into noise at
          // 60 Hz, so the ANGLE advances at most DISPLAY_MAX_TURNS_PER_SECOND
          // while the readout still reports the true rpm. Without this every
          // fast part looks stationary (or worse, backwards).
          const visibleRate = Math.sign(rate) * Math.min(Math.abs(rate), DISPLAY_MAX_TURNS_PER_SECOND);
          motion.spinAngle = (motion.spinAngle ?? motion.baseRotation[0]) + visibleRate * Math.PI * 2 * deltaSeconds;
          target.rotation.set(
            motion.baseRotation[0],
            motion.baseRotation[1],
            motion.baseRotation[2],
          );
          target.rotation[axis === 'x' ? 'x' : axis === 'y' ? 'y' : 'z'] += motion.spinAngle;
          continue;
        }

        if (source.mode === 'angle') {
          const value = asNumber(readSignal(componentId, el, source.props[0])) ?? 0;
          const [, maxDeg] = source.range ?? [0, 270];
          const [minVal, maxVal] = source.valueRange ?? [0, Math.abs(maxDeg) || 180];
          const fraction = maxVal === minVal ? 0 : (value - minVal) / (maxVal - minVal);
          const clamped = Math.max(0, Math.min(1, source.invert ? 1 - fraction : fraction));
          const degrees = clamped * maxDeg;
          target.rotation.set(
            motion.baseRotation[0],
            motion.baseRotation[1],
            motion.baseRotation[2],
          );
          target.rotation[axis === 'x' ? 'x' : axis === 'y' ? 'y' : 'z'] += (degrees * Math.PI) / 180;
          continue;
        }

        // fraction / press / tilt → a translation along one axis.
        const raw = readSignal(componentId, el, source.props[0]);
        const numeric = asNumber(raw);
        const value = numeric === null ? (asBoolean(raw) ? 1 : 0) : numeric;
        const [minVal, maxVal] = source.valueRange ?? [0, 1];
        const fraction = maxVal === minVal ? 0 : Math.max(0, Math.min(1, (value - minVal) / (maxVal - minVal)));
        const travel = (source.range?.[1] ?? 5) * (source.invert ? -fraction : fraction);
        target.position.copy(motion.basePosition);
        target.position.setComponent(axisIndex, motion.basePosition.getComponent(axisIndex) + travel);
      }
    };

    // Store the updater so useFrame can drive it without re-creating it.
    frameUpdate.current = update;
    update(0);

    return () => {
      frameUpdate.current = null;
      for (const dispose of disposers) dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, definition, root, spec, model, bounds, componentId, selected]);

  useFrame((_state, delta) => frameUpdate.current?.(delta));

  if (!definition?.surfaces?.length) return null;
  return <group ref={setGroup} userData={{ liveSurfacesFor: catalogKey }} />;
}

export default LivePartSurfaces;
