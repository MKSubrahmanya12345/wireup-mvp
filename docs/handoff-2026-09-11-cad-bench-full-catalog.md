# Handoff — the full-catalog batch: CAD bench parts, `diagram.json`, STL library, 3D placement

**Branch:** `arena/01a08e90-wireup-mvp`
**Date:** 2026-09-11
**Status:** typecheck clean; `next build` clean; vendored `vite build` clean;
`verify:simulator` ok (57 claims / 54 part mappings / 10 board mappings, 53
peripherals · 100 wires, zero drops); `verify:cad-link` ok (108 parts); `verify:contracts`
28/28; **new gate `verify:cad-sim-link` ok** (108 parts allocated, 97 catalog keys
asset-complete, key spaces disjoint, 603 bench anchors inside their own meshes,
board + 46 CAD-bench parts + 1 simulated partner → 48/48 wires); vendored suite
210 files / 2672 tests green (+1 file, +9 tests vs. baseline).

---

## 1. What was asked

Five things, in the user's words:

1. check the **Velxio integration** with Wireup;
2. check the rules/contract of **`diagram.json`** — "it's not set to work with all CAD components";
3. check the **CAD part in the admin page** where the models are present;
4. "somehow **get out the STL files**" and make `diagram.json` generation include all those parts too;
5. make sure **3D sim placement** is proper.

Two decisions were locked with the user before the work started:

* **Coverage** — "CAD bench parts everywhere": a catalog part Velxio has no
  simulator element for is carried into `.vlx` + `diagram.json` + the 3D bench as
  a clearly-marked **CAD-only** part (real 3D body, wires drawn, generic labelled
  module on the 2D canvas). It is never faked as a simulator element; it simply
  does not behave electrically.
* **Assets** — generate and commit them (~17 MB): `<key>.glb` + `<key>.stl` +
  `spec.json` for every catalog part, registered in
  `frontend/public/models3d/manifest.json`, so Velxio loads real files offline and
  the STLs are downloadable.

Standing rules that shaped every choice: do not regress the Arduino Uno, the admin
panel or the 3D CAD helper; `supported: true` requires the part to render **and**
have registered behaviour in the pinned vendored build; report rather than
substitute.

## 2. The problem, stated precisely

`toWokwiDiagram()` (in `src/modules/diagram-generator/wokwi.ts`) is the only
projector for `diagram.json`, and it projected only parts with a verified
`simulator.part`. Everything else went to `skippedParts` and was **dropped** from
the parts list, and every wire touching it went to `skippedConnections`. Same in
`generateVelxioProject()`: `components` held only the mapped parts.

Measured before the work (`/tmp/probe3.ts`): of 108 catalog parts, 54 were
`supported: true`; 42 were `supported: false`; 0 were claimed-but-unmapped. So the
hole was **42 parts and every wire to them** — pumps, motors, solenoids, motor
drivers, power modules, tool heads.

## 3. The design that closed it

**One rule, one module.** `src/modules/simulation/velxio-key.ts` (new,
dependency-free) owns the key allocation: `velxioCatalogKeyFor(definition)`
returns either the mapped simulator key or the part's own catalog id with
`cadOnly: true`, `canvasPlaced: true` — `null` for a board, an `integrated`
part, a wiring medium, or a part that does not participate in wiring.
`CAD_BENCH_PREFIX = 'cad-bench-'`, `cadBenchId()`, `cadBenchCatalogId()` and
`isCadBenchComponent()` live here too, so the exporter, the Wokwi projection, the
reverse sync and the gate all read the same definition. A second copy anywhere is
a bug the gate catches.

**The projection carries, not drops.** `WokwiProjection` gained
`cadBench: {id, ref, name}[]` and `WokwiSkippedPart` gained
`carriedAs?: 'cad-bench'` plus `cadKey`. A CAD-bench part is reported in
`skippedParts` with `carriedAs: 'cad-bench'` (so a Wokwi download still tells the
truth — a real `diagram.json` cannot contain it) **and** listed in `cadBench[]`
(so the caller knows the part is in the project, just not in this artifact).

**The `.vlx` places them.** `generateVelxioProject()` places each CAD-bench part
as `cad-bench-<ref>` with `properties.cadKey`, on its own column
(`CAD_PART_COLUMN_X`), and **rebuilds its wires from the canonical diagram**: the
CAD end keeps the catalog pin name (aliases resolved through `canonicalPin()`),
while a **simulated partner end** goes through the now-exported `translatePin()`
and `renamePin()` — a pump wired through a MOSFET to an Arduino pin lands on the
element's own vocabulary, not the catalog's. The simulated wire loop skips any
wire that touches a CAD id, so nothing is double-drawn.

**The canvas renders them.** `<velxio-cad-bench-part>` (new, vendored) draws a
top-view symbol from `/cad-catalog.json`: real body outline, every pin pad at its
real millimetre coordinate, a `pinInfo` array (the only contract the wire system
needs), a visible **CAD** badge and a "no electrical model" label.
`ComponentRegistry` appends these `cad-bench-<key>` entries **after** the real
catalogue, so they can never shadow a simulated id.

**The 3D bench seats them.** `scene3d/placement.ts` (new) lays the bench out in
world millimetres: boards on the back row, parts in front rows with a 40 mm gap
and a 1000 mm row span, honouring saved `x3d`/`z3d` exactly when present.
`Cad3DScene` strips the `cad-bench-` prefix to find the CAD key, merges reviewed
GLBs over parametric assemblies (never to nothing), and `models3d.ts`
re-centres each model before lifting it by half its height, so a file authored
base-at-0 seats on the bench instead of floating or sinking.

**The STLs exist.** `pnpm export:cad-models` writes `<key>.glb` + `<key>.stl` +
`<key>.ascii.stl` + `spec.json` for all 97 catalog keys (93 generated, 4
reviewed). Rules: a reviewed GLB is never overwritten; a reviewed key only gains
the exports it is missing; a model on disk the manifest does not own is left
exactly as found; a manifest entry whose key left the catalog is pruned and
reported. The admin CAD studio gained a download bar (binary STL, ASCII STL, GLB)
for whatever the selected part just built.

## 4. The four honest-claim flips (and the one that stayed)

| Catalog part | Was | Now | Evidence in the pinned build |
| --- | --- | --- | --- |
| `mpu6050-imu` | `supported: false` | `wokwi-mpu6050`, **supported** | `PartSimulationRegistry.register('mpu6050')` — register-level I2C model at 0x68/0x69 (AD0), live acceleration/rotation/temperature controls; XDA/XCL are wired but not modelled (said so in the notes) |
| `ir-receiver-tsop38238` | `supported: false` | `wokwi-ir-receiver`, **supported** | `register('ir-receiver')` — 38 kHz demodulator on DAT, idles HIGH, remote codes drive it |
| `rgb-led-common-cathode` | `supported: false` | `wokwi-rgb-led`, **supported** | `register('rgb-led')` — three independently PWM-driven channels, element attr `common: cathode` |
| `bme280-environmental` | `supported: false` | **still false** | The only BME-family element in this build (`velxio-bmp280`, 4 pins SDA/SCL/GND/VCC) models **pressure + temperature**. Humidity is not there. A pin map for the shared I2C/power pins was added so a future flip is safe, and the note says why it is not claimed yet |

The gate is what decided this: `mpu6050` is in the vendored simulated set but was
never claimed; `ir-receiver` and `rgb-led` likewise. Flipping them moved three
parts from the CAD-bench column to the simulated column (49 → 46 CAD bench, 49 →
52 simulated) and raised the claim count 54 → 57.

## 5. The bug the new gate caught (worth remembering)

The end-to-end section of `verify:cad-sim-link` failed on its first run with
**50 of 51 wires missing**. Root cause: `generateVelxioProject()` built
`cadBenchIds` / `cadCatalogIdById` / `componentById` **before** the cadBench
placement loop, so the sets were empty and every CAD-bench wire was discarded (and
the simulated end of a mixed wire was never translated). Moving the three maps
after the loop fixed it; `/tmp/probe4.ts` is the regression probe
(`cad-0:+ -> board-1:5V`, `cad-0:- -> board-1:GND.1`).

Lesson recorded for the next person: the gate was right and the code was wrong.
Do not weaken the assertion — the ordering dependency is real and `verify:cad-sim-link`
is the only thing that sees it.

## 6. Machinery added

| File | Role |
| --- | --- |
| `src/modules/simulation/velxio-key.ts` | The key rule and the shared tables (`BOARD_KIND_BY_*`, `METADATA_BY_WOKWI_TYPE`, `refinePart()`, `WOKWI_TYPE_BY_METADATA`, `cadBench*`) |
| `scripts/export-cad-models-to-velxio.ts` | Writes the model library (idempotent, reviewed-safe, prunes + reports) |
| `scripts/verify-cad-sim-link.ts` | Six checks: allocation, assets, key-space disjointness, placement/anchors, CAD-bench end-to-end, vendored coupling |
| `external/velxio/frontend/src/scene3d/placement.ts` | Bench layout in millimetres |
| `external/velxio/frontend/src/velxio-elements/cad-bench-element.ts` | `<velxio-cad-bench-part>` — the 2D CAD-only part |
| `external/velxio/frontend/src/__tests__/cad-bench-catalog.test.ts` | Velxio-side consumption proof: every part builds a non-empty body, every pin has an anchor node, every generated GLB really contains them |
| `external/velxio/frontend/public/cad-catalog.json` | 97 entries (4 boards, 93 parts, 48 CAD-only) keyed exactly as the exporter places them |
| `external/velxio/frontend/public/models3d/` | 97 GB + 195 STL + 97 `spec.json` (19 MB) |

## 7. What a reader should check first

1. `pnpm verify:cad-sim-link` — if the two halves ever disagree, this fails first
   and says which of the six checks broke.
2. `pnpm verify:simulator` — the claim table is the other half of honesty.
3. `pnpm typecheck && pnpm build`.
4. Vendored: `npx vitest run` (and `npx vite build` — the vendored `tsc -b` has
   429 pre-existing `src/__tests__` errors, so it proves nothing).
