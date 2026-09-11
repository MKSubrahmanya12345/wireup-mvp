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

## Datasheet intake

`/api/admin/cad/parse` now accepts three forms of evidence:

1. a known maker-part name such as `5mm LED`, `HC-SR04`, `L298N`, `SG90`,
   `LCD1602`, `HC-05` or `ESP32 DevKit V1`;
2. pasted datasheet text; or
3. a public HTML/text datasheet URL.

Known names resolve through `cad-helper/online-datasheet.ts`, a small curated
internet-data snapshot that records the source URL/note on `spec.datasheetSources`.
Pasted/URL text still goes through `parseDatasheetText`, but the dimension parser
now preserves the third dimension (`45 × 20 × 15 mm` becomes a 15 mm assembly,
not a flattened 1.6 mm PCB). Binary/PDF URLs are not parsed in-process; the API
warns the admin to paste the relevant table text or use a curated part name.

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

## Registry ↔ CAD link

The studio is no longer driven by a hand-written preset list. `cad-helper/catalog-link.ts`
binds the component registry (`src/modules/components`) to the CAD layer, and
`/api/admin/cad/presets` serves the result:

| Tier | Selector marker | Source of geometry |
| --- | --- | --- |
| `reference` | ★ | reviewed multi-mesh GLB in `public/models3d` |
| `preset` | ◆ | authored spec with measured envelope + datasheet anchors (`presets-motion.ts`, `datasheet-parser.ts`) |
| `derived` | · | generated from the registry entry: real pins, real voltages, generic body |

Because the derived tier exists, **every catalog part is previewable and
exportable immediately** — adding a component to a seed file makes it appear in
the studio with correct anchors on the same run. The derived tier is now
package-aware for common loose parts and modules: 5 mm LEDs/RGB LEDs, axial
resistors, electrolytic/ceramic capacitors, buzzers, switches, keypads,
batteries, regulators, breadboards, propellers, DHT/LDR/IR/MQ sensor packages, HC-05/HC-06,
ESP-01, ESP32 DevKit V1, Arduino Nano and LCD1602 no longer appear as anonymous
boxes when only registry data is available.

### Why the link is verified

A CAD anchor whose name does not match the registry pin produces confidently
wrong 3D wiring: the render looks correct and the connection is not. So the
coupling is a checked contract, not a convention:

```
pnpm verify:cad-link
```

The verifier fails on an orphan preset (a model no project part can reference),
a registry pin with no anchor, an anchor that does not exist on the part, a
studio role that disagrees with the registry category, a dropped pin in a
derived spec, or non-finite anchor coordinates. The admin studio surfaces the
same audit inline, so a mismatch is visible in the UI rather than only in CI.

Running it caught real pre-existing drift on the first pass: the Uno was missing
`AREF`/`IOREF` and its `GND.1-3` aliases, the MPU6050 was missing the `XDA`/`XCL`
auxiliary bus, the L298N motor-supply anchor was named `VCC` against a registry
`+12V`, and the BME280 and KY-040 had CAD models with no catalog entry at all.
Those are fixed in the registry, not papered over in the audit.

### Two more checks, after a self-review of batch 1

Auditing only anchor *names* let two bug classes through, so the audit now also
covers:

**Pin roles.** A CAD anchor can carry the right name and the wrong electrical
role. `CAD_ROLE_TOLERANCE` documents where a registry type legitimately maps to
several CAD roles — an `enable` pin is `control` on the TB6612's STBY and `pwm`
on the L298N's ENA, and both are correct — and anything outside that table must
match `cadPinRole()` exactly. This caught the Uno's AREF/IOREF (typed as generic
control) and the pump/solenoid switched terminals (modelled as ground nets when
they are driver-side motor terminals, not grounds).

**Alias collisions.** `matchComponent()` returns on the *first* exact alias hit,
so a duplicated alias means catalog file order silently decides which part the
user gets. "piezo buzzer" resolved to either the active buzzer (`digitalWrite`)
or the passive one (`tone()`) depending on ordering — different firmware, no
warning — and "battery pack" to either 7.4 V or 6 V. Aliases are now unique:
"piezo buzzer" is the passive one, bare "buzzer" the active one, "battery pack"
the AA holder.

---

## Print exports and the shipped model library (2026-09-11)

The studio's **Build parametric bundle** action does not just report a byte
count any more: the generated bundle is kept on screen and can be saved straight
from the page.

| Button | File | What it is |
| --- | --- | --- |
| Download STL | `<catalogId>.stl` | The binary STL the bundle builder produced — the printable mesh, ready for a slicer |
| Download ASCII STL | `<catalogId>.ascii.stl` | The same geometry in ASCII, for readable diffs and issue reports |
| Download GLB | `<catalogId>.glb` | The shaded model with named pin-anchor nodes, i.e. what the 3D bench renders |

The page also states where the *whole* catalog's exports live —
`external/velxio/frontend/public/models3d/<key>/` — because the studio is the
per-part instrument, not the library. The library is written by
`pnpm export:cad-models` and checked by `pnpm verify:cad-sim-link`:

* every CAD key gets `<key>.glb` + `<key>.stl` + `<key>.ascii.stl` + `spec.json`;
* a **reviewed** asset is never overwritten — not by a re-run and not by
  `--force`; if a reviewed key has no print exports yet, only the missing files
  are added (this is why the Uno and the SG90 carry their own STLs now);
* a model on disk that the manifest does not own is left exactly as found — that
  is how a hand-built asset survives a generator that has not learned its key;
* a manifest entry whose key left the catalog is pruned and reported, so a part
  that moved between tiers cannot keep pointing at a stale model.

`spec.json` records which case it is: `assetKind: generated-model` for a
parametric export, `print-export-of-spec` for the STLs of a reviewed asset, and
for a reviewed asset shipped with its own spec the file is that spec verbatim
(also allowed, and what the hand-built MPU-6050 uses).
