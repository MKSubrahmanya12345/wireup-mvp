/**
 * anchors — where a live surface sits on a part's 3D body.
 *
 * A live surface is a tiny piece of extra geometry (a display panel, a glow,
 * a needle) that has to be glued to the right place on a body that comes from
 * one of two asset pipelines:
 *
 *   • a generated GLB / the parametric assembly — both built FROM the CAD spec
 *     (`/cad-catalog.json`), so spec millimetre coordinates are exact;
 *   • a hand-reviewed GLB (Arduino Uno, SG90, DHT22, HC-SR04) — authored by a
 *     human, so only its own named nodes and its own bounding box are
 *     trustworthy.
 *
 * Hence `LiveAnchor.frame`: `spec` resolves against the CAD spec (and is
 * refused by the Wireup gate on any key whose asset is not spec-generated),
 * `model` resolves against the loaded geometry. Both return the same
 * `ResolvedAnchor`, so renderers never care which one ran.
 *
 * Everything is expressed in the PART GROUP's local frame — the frame the
 * caller has already positioned on the bench.
 */

import { Box3, Euler, Group, Material, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import type { CadComponentSpec, CadFeature } from '../cadTypes';
import type { LiveAnchor } from './surfaceTypes';

export type AnchorMode = 'spec-feature' | 'spec-body' | 'model-feature' | 'model-node' | 'body-top';

export interface ResolvedAnchor {
  mode: AnchorMode;
  /** Centre of the surface, in the part group's local frame (mm). */
  position: Vector3;
  /** Orientation of the surface's local +Y axis (the face normal). */
  quaternion: Quaternion;
  /** Footprint of the surface in its own plane (mm). */
  width: number;
  depth: number;
  /** The object the anchor named, when it named one (motion/emissive target). */
  target: Object3D | null;
  /** Material of the feature mesh, when the anchor resolved to one. */
  material: Material | null;
}

const DEG = Math.PI / 180;
/** Lift a panel a hair off the face it sits on, so it never z-fights the body. */
const FACE_EPSILON_MM = 0.05;

/** Does this feature match a name-or-type selector? */
function featureMatches(feature: CadFeature, selector: string): boolean {
  return feature.type === selector || feature.name === selector || feature.name.toLowerCase() === selector.toLowerCase();
}

/** First feature matching a selector, in spec order (spec order is authored). */
export function findSpecFeature(spec: CadComponentSpec | undefined, selector: string): CadFeature | null {
  if (!spec) return null;
  for (const feature of spec.features ?? []) {
    if (featureMatches(feature, selector)) return feature;
  }
  return null;
}

/**
 * Find the mesh (or feature group) a selector names in a loaded model.
 *
 * Generated GLBs carry one primitive per feature, each with a material named
 * `Mat_<feature name>`; the parametric builder names the feature group after
 * the feature and tags it with `userData.cadFeature`. Both are matched here,
 * plus an exact node-name match so a reviewed GLB's own node names work.
 */
export function findModelFeature(group: Object3D, selector: string): { object: Object3D; material: Material | null } | null {
  let byNode: Object3D | null = null;
  let byFeature: { object: Object3D; material: Material | null } | null = null;
  const wanted = selector.toLowerCase();

  group.traverse((child: Object3D) => {
    if (!byNode && child.name && child.name.toLowerCase() === wanted) byNode = child;
    if (byFeature) return;
    const tagged = child.userData?.cadFeature as { name?: string; type?: string } | undefined;
    const meshMaterial = (child as Mesh).material as Material | Material[] | undefined;
    const materialName = Array.isArray(meshMaterial) ? meshMaterial[0]?.name : meshMaterial?.name;
    const matches =
      (tagged && (tagged.type === selector || tagged.name === selector)) ||
      (materialName ? materialName === `Mat_${selector}` || materialName === selector : false) ||
      child.name === selector;
    if (matches) {
      byFeature = { object: child, material: Array.isArray(meshMaterial) ? (meshMaterial[0] ?? null) : (meshMaterial ?? null) };
    }
  });

  return byFeature ?? (byNode ? { object: byNode, material: null } : null);
}

/** Rotation that maps a surface's own +Y face onto the requested face. */
function faceQuaternion(face: LiveAnchor['face']): Quaternion {
  // +Y face is the identity; 'front' faces +Z; 'center' is unrotated.
  if (face === 'front') return new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -90 * DEG);
  return new Quaternion(); // top and center both lie in the XZ plane
}

function objectSize(object: Object3D, fallback: Vector3): Vector3 {
  const box = new Box3().setFromObject(object);
  if (box.isEmpty()) return fallback.clone();
  const size = box.getSize(new Vector3());
  return size.lengthSq() > 0 ? size : fallback.clone();
}

function objectCenter(object: Object3D, fallback: Vector3): Vector3 {
  const box = new Box3().setFromObject(object);
  if (box.isEmpty()) return fallback.clone();
  return box.getCenter(new Vector3());
}

export interface AnchorContext {
  /** The CAD spec for the instance key, when the catalog has one. */
  spec?: CadComponentSpec | undefined;
  /** The model group's recentring offset (`LoadedModel.recenter`). */
  recenter?: Vector3 | undefined;
  /** Bounding box of the loaded model, in the group's local frame. */
  bounds?: Box3 | undefined;
}

/**
 * Resolve an anchor to a placement. Returns null when nothing matches — the
 * caller then renders NO surface, which is the honest outcome: a display that
 * cannot be located is not drawn somewhere wrong.
 */
export function resolveAnchor(anchor: LiveAnchor, group: Object3D | null, ctx: AnchorContext): ResolvedAnchor | null {
  const recenter = ctx.recenter ?? new Vector3();
  const bounds = ctx.bounds ?? (group ? new Box3().setFromObject(group) : new Box3());

  if (anchor.frame === 'spec') {
    const feature = anchor.feature ? findSpecFeature(ctx.spec, anchor.feature) : null;
    if (!feature) return null;
    const [width, height, depth] = feature.dimensions;
    const face = anchor.face ?? 'top';
    const position = new Vector3(feature.position[0], feature.position[1], feature.position[2]).sub(recenter);
    if (face === 'top') position.y += height / 2 + FACE_EPSILON_MM;
    else if (face === 'front') position.z += depth / 2 + FACE_EPSILON_MM;
    const quaternion = faceQuaternion(face);
    const scale = anchor.scale ?? 1;
    return {
      mode: 'spec-feature',
      position,
      quaternion,
      width: (face === 'front' ? width : width) * scale,
      depth: (face === 'front' ? height : depth) * scale,
      target: findModelFeature(group ?? new Group(), feature.name)?.object ?? null,
      material: findModelFeature(group ?? new Group(), feature.name)?.material ?? null,
    };
  }

  // ── model frame ──────────────────────────────────────────────────────────
  const target = anchor.node
    ? (group?.getObjectByName(anchor.node) ?? null)
    : anchor.feature
      ? (findModelFeature(group ?? new Group(), anchor.feature)?.object ?? null)
      : null;

  if (target) {
    const size = objectSize(target, new Vector3(10, 10, 10));
    const position = objectCenter(target, new Vector3());
    const isNode = Boolean(anchor.node);
    return {
      mode: isNode ? 'model-node' : 'model-feature',
      position,
      quaternion: faceQuaternion(anchor.face),
      width: size.x,
      depth: size.z,
      target,
      material: (target as Mesh).material
        ? Array.isArray((target as Mesh).material)
          ? (((target as Mesh).material as Material[])[0] ?? null)
          : ((target as Mesh).material as Material)
        : null,
    };
  }

  // ── body top: the last honest resort, and a real surface (not a stand-in) ─
  if (!anchor.bodyTop && (anchor.node || anchor.feature)) return null;
  if (bounds.isEmpty()) return null;
  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const scale = anchor.scale ?? 1;
  return {
    mode: 'body-top',
    position: new Vector3(center.x, bounds.max.y + FACE_EPSILON_MM, center.z),
    quaternion: new Quaternion(),
    width: size.x * scale,
    depth: size.z * scale,
    target: null,
    material: null,
  };
}

/** Apply the anchor's optional local offset/rotation on top of a placement. */
export function applyAnchorTweaks(placement: ResolvedAnchor, anchor: LiveAnchor): ResolvedAnchor {
  const out: ResolvedAnchor = { ...placement, position: placement.position.clone() };
  if (anchor.offsetMm) {
    out.position.add(new Vector3(anchor.offsetMm[0], anchor.offsetMm[1], anchor.offsetMm[2]));
  }
  if (anchor.rotationDeg) {
    const extra = new Quaternion().setFromEuler(
      new Euler(anchor.rotationDeg[0] * DEG, anchor.rotationDeg[1] * DEG, anchor.rotationDeg[2] * DEG),
    );
    out.quaternion = placement.quaternion.clone().multiply(extra);
  }
  return out;
}
