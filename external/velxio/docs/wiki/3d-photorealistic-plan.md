# 3D Photorealistic Simulation — Plan

## Status

**Stage 0 + Stage 1 implemented** (this branch):

- `frontend/package.json` — `three`, `@react-three/fiber` (v9), `@react-three/drei` added.
- `frontend/src/three/` — new lazy-loaded renderer:
  - `Simulation3D.tsx` — orthographic "lifted bench" over `useSimulatorStore`
    (boards/components/wires), auto-framing OrbitControls, grid + lights.
  - `Card3D.tsx` — flat card (slab + SVG-textured face) for a board/component.
  - `Wire3D.tsx` — wire as a polyline under the parts.
  - `partArt.ts` — maps board/component → real `/component-svgs` art + size.
  - `useSvgTexture.ts` — cached SVG texture loader.
- `SimulatorCanvas.tsx` — a **3D/2D toggle** in the floating zoom controls;
  the 2D world is hidden (not unmounted) while 3D is active, and the 3D view
  mounts via `React.lazy` + `Suspense`. The 2D view stays the default.
- `CircuitPreview.tsx` — `CompDef` / `BOARD_DEFS` / `getCompDef` exported so the
  3D view reuses the gallery's asset mapping.

Not done yet (later stages): interaction (drag/select/pins) in 3D, real 3D
geometry + GLBs, photoreal lighting/shadows/bloom, wire sag, display
framebuffers on 3D faces.

> Scope: **Velxio frontend only** (`frontend/`). No backend changes, no
> emulator changes. The simulation core is already decoupled from rendering
> (avr8js / rp2040js / QEMU / ngspice-WASM mutate Zustand state; they do not
> know whether the canvas is 2D SVG or a 3D scene), so a 3D view is a *second
> renderer over the same stores*, shipped as a toggle beside the existing 2D
> canvas (2D stays the default; nothing breaks).

## Current state (all 2D)

- Canvas: `components/simulator/SimulatorCanvas.tsx` — absolutely-positioned
  DOM in a `world` div, panned/zoomed via
  `transform: translate(pan) scale(zoom)`. No WebGL, no glTF, no three.js
  anywhere in `frontend/`.
- Components: Web Components drawing SVG in shadow DOM
  (`@wokwi/elements`, `velxio-elements/*`, `components/velxio-components/*`).
  2D pin anchors come from the `element.pinInfo` getter
  (`utils/pinPositionCalculator.ts`).
- Wires: 2D SVG paths with orthogonal routing (`utils/wireUtils.ts`,
  `components/simulator/WireRenderer.tsx`).
- Data model (`store/useSimulatorStore.ts`):
  `Component {id, metadataId, x, y, properties}`,
  `Wire {id, start, end, color, signalType, waypoints, bb?}`.

## Stages

### Stage 0 — 3D scaffold (view toggle + empty viewport)
- Add `three`, `@react-three/fiber` (v9, React 19-compatible) and
  `@react-three/drei` to `frontend/package.json`.
- New `frontend/src/three/` tree, lazy-loaded as its own `manualChunks`
  entry (same pattern as the ngspice WASM chunk in `vite.config.ts`).
- A "3D" toggle in the canvas toolbar next to the zoom controls.
- Both views read `useSimulatorStore.components` / `.wires` — no new state
  source of truth.

### Stage 1 — 2.5D "lifted bench" (fast, low-risk win)
- Orthographic camera, ground plane/grid.
- Each component rendered as a flat card textured with its **existing SVG**,
  extruded to its real physical height; boards float slightly above the bench.
- Lift `pinInfo` (x, y) → (x, y, boardZ); wires become simple 3D tubes.
- Reuses every current asset → visual continuity + immediate depth.

### Stage 2 — true 3D components
- Per-component procedural geometry (boxes/cylinders/PCB extrusions) with
  PBR materials — no need for 150 GLBs on day one.
- `useGLTF` path for hero parts (boards, common modules) with DRACO/meshopt
  compression and lazy loading.
- Per-component **3D pin-anchor map** (2D `pinInfo` stays untouched) so wire
  endpoints remain electrically correct in 3D.
- Display parts (TFT/OLED/NeoPixel/7-seg) become emissive texture planes fed
  by the existing framebuffer/decoder logic.

### Stage 3 — photoreal
- HDRI environment lighting (`<Environment>`), roughness/metalness PBR,
  soft/contact shadows, ACES tone mapping, bloom for LEDs.
- GPU instancing (`<Instances>`) for the sea of resistors/LEDs to hold 60 fps.
- Photorealism is mostly lighting + materials once assets are PBR.

### Stage 4 — interaction parity
- Raycast selection, drag on a ground plane, rotation, pin snapping.
- 3D wire editing with sag (catenary) cables + connector ferrules.
- Labels (R1 330Ω) as sprites; reuse existing property dialogs.
- Keep 2D as the always-available schematic/layout fallback.

### Stage 5 (optional)
- Photogrammetry/scanned part library; full lab-bench environment scene;
  WebGPU renderer; AR/video passthrough.

## Hard parts

1. **Assets, not code** — "photorealistic" = PBR materials + good geometry +
   lighting across 150+ components. Procedural + curated GLB set is the
   pragmatic route.
2. **Wires** — 2D orthogonal routing → 3D cables with sag/collision
   (`wireAutoRoute.ts` / `WireRenderer.tsx`) is real rework.
3. **Pin anchoring** — `pinInfo` is 2D-only; the 3D view needs its own anchor
   map in lockstep with the electrical model.
4. **Live content displays** — emissive textures; fiddly but bounded.
5. **Perf** — instancing + LOD on integrated GPUs; keep 2D as fallback.

## Recommendation

Start with Stage 0 + 1 (orthographic 2.5D over the same stores + existing
textures). Days of work, zero risk to the 2D product, and it proves the
pin-anchor + wire-tube plumbing before committing to asset production.
Photorealism then becomes a lighting/material pass + incremental GLB adoption.

## License note

`external/velxio` is AGPL-3.0 (commercial license offered separately). Running
a *modified* Velxio as a network service triggers AGPL's source-offer clause —
see `external/README.md` for how this repo already handles that boundary.
