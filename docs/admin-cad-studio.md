# Admin CAD Studio: asset-quality contract

The Admin CAD view now uses a quality ladder rather than treating all generated
geometry as equally accurate.

| Tier | UI treatment | Source of geometry | Export claim |
| --- | --- | --- | --- |
| **Reviewed assembly** | Studio loads a multi-mesh GLB with PBR lighting, soft shadows, part hover and real named anchors. | A known, provenance-reviewed CAD source built offline. | The viewer identifies it as a reference assembly. |
| **Parametric preview** | Studio renders a rounded PCB/housing, headers, pins, feature-specific geometry, silk-screen decal and PBR materials. | Wireup dimensions, pins and feature schema. | Useful visual / anchor fallback, not production CAD. |
| **Fallback** | Same parametric renderer when a reviewed GLB cannot load. | Wireup dimensions, pins and feature schema. | Never silently claims the failed asset is present. |

## Runtime architecture

The browser uses Three.js only for rendering. `CadPreviewCanvas` sets an sRGB
color pipeline, ACES filmic tone mapping, a generated studio environment,
key/fill/rim lighting, soft shadows, camera framing, orbit/pan/zoom and part
inspection. It loads reviewed assets through public-relative URLs, so the live
preview proxy and production host do not need `localhost` access.

The only currently registered reviewed asset is **Arduino Uno R3**. It is a
multi-mesh GLB copied into `public/models3d/arduino-uno/` from the vendored
asset registry and provides an assembly-quality comparison point for the
rendering experience.

## Build architecture

`tools/cad/build_glb.py` is the independent, headless asset job:

1. requires a reviewed STEP/STP source;
2. calls OpenCASCADE through `cascadio` to make a GLB;
3. adds a millimetre wrapper and named pin-anchor empties;
4. applies explicit PBR material rules based on mesh-name mapping;
5. checks output size, meshes, materials, wrapper and every required anchor;
6. writes the result to `public/models3d` for a human-reviewed registry entry.

It is suitable for a container/CI worker, never for a synchronous app/API
request. See `tools/cad/README.md` for the input contract and setup command.

## Scope boundary

The pipeline can use a KiCad 3D library model when an exact footprint/package
mapping exists. It does not manufacture missing physical geometry and it does
not solve text-specification-to-`.kicad_pcb` generation. That upstream EDA layer
needs netlist, footprint, placement and routing data before any CAD conversion
is meaningful.

## Asset provenance

A source, license/provenance note, dimensions, anchor contract and visual review
must be attached before adding an asset to `cad-helper/reference-assets.ts`.
The Uno demonstration asset has a specific licensing note at
`public/models3d/ATTRIBUTION.md`; retain that notice until its licensing is
resolved for the target deployment.
