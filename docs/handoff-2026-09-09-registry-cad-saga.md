# Handoff — the registry ↔ CAD saga (component truth + previewable geometry)

**Branch:** `arena/01a086c1-wireup-mvp`
**Date:** 2026-09-09
**Status:** typecheck clean; `next build` clean; `verify:contracts` 28/28,
`verify:cad-link` ok (86 parts), `verify:offline` pass, `verify:behavioral`
19/19. Three commits pushed (`7cf59bb`, `9453912`, `ae472d7`). No PR opened yet.

---

## 1. Vision and mission

**Vision.** A user describes a machine in plain language and Wireup returns a
build that a competent engineer would sign off on: the right parts, wired
correctly, powered adequately, with firmware that compiles and geometry you can
actually look at. The component registry is the ground truth that makes this
possible — every downstream stage (pin planning, wiring, power budget, diagram,
firmware, CAD preview) reads from it, so the registry's honesty *is* the
product's honesty.

**Mission for this workstream.** Two registries, one identity:

1. **Electrical registry** (`src/modules/components/*`) — what a part needs and
   provides: pins, current, voltage, control signal, libraries, incompatibilities.
2. **CAD registry** (`cad-helper/*`) — what a part looks like and where its pins
   physically sit, in real millimetres.

They are linked by a **shared component id**. `ComponentDefinition.id ===
CadComponentSpec.id`. Nothing else. That single rule is what lets the preview
be driven by the catalog instead of by a hand-maintained parallel list.

**The standing user request:** research both sides from the internet and expand
them "with utmost perfection" — DC motors, servos, fans, propellers, and every
other component — *incrementally*, forever. This is not a one-shot task. Each
batch adds parts, and each batch is expected to harden the machinery that keeps
those parts honest.

**The non-negotiable:** the admin panel and the 3D CAD helper are considered
finished and correct by the user. Do not regress them. Extend around them.

---

## 2. The governing principle (read this before writing code)

> A registry that guesses confidently is worse than a registry with holes.

Every bug found in this saga so far has been the same bug wearing a different
hat: **the system produced a confident answer where it had no basis for one.**

- The fuzzy matcher scored 123 on a 100-point scale and shipped an SG90 when
  asked for a DS3218.
- Alias `"uno"` matched inside `"unobtainium"` and returned an Arduino.
- The driver ladder handed a 5 A motor a 2 A L298N.
- A CAD anchor could carry the right pin *name* with the wrong *role*.

So the test for any new work is not "does it produce output" but **"when it does
not know, does it say so?"** Concretely: test every new matcher, fallback or
defaulting rule against nonsense input, not just plausible input. The single
most valuable check in `verify:contracts` is the one that feeds it
`"unobtainium widget ZZ9"` and asserts nothing comes back.

---

## 3. Where things stand

### 3.1 The catalog

86 components, all previewable, all anchors matching the registry.

| Category | Count | | Category | Count |
| --- | --- | --- | --- | --- |
| motor | 16 | | input_device | 7 |
| sensor | 15 | | passive | 5 |
| motor_driver | 12 | | communication | 4 |
| actuator | 9 | | microcontroller | 3 |
| power | 9 | | display | 2 |
| prototyping | 2 | | other | 2 |

Seed files live in `src/modules/components/seed/` (`motors.ts` 863 lines,
`motion.ts` 514, `sensors.ts` 410, `general.ts` 304, `microcontrollers.ts` 246,
`power.ts` 232, `actuators.ts` 150, `communication.ts` 131, `displays.ts` 62)
and are aggregated by `catalog.ts`, which also runs `checkCatalogIntegrity`.
`helpers.ts` exports the `def()` / `pin()` builders every seed file uses.

### 3.2 The CAD link

`cad-helper/catalog-link.ts` is the bridge. Three tiers, best first:

- **reference** (1 part) — a real reviewed GLB asset on disk.
- **preset** (22 parts) — hand-authored millimetre geometry in
  `COMPONENT_PRESETS` / `presets-motion.ts`.
- **derived** (63 parts) — parametric geometry inferred from the registry entry
  by `deriveSpecFromComponent()`.

`auditCatalogCadLink()` is the gate: it fails on orphan presets (a spec whose id
is not in the catalog), on missing geometry, and on anchor/pin mismatches.
`CAD_ROLE_TOLERANCE` encodes the legitimate slack between an electrical pin role
and a CAD anchor role (`enable`→control|pwm|digital, `control`→control|digital,
`signal`→digital|analog, `motor`→power); everything else must match
`cadPinRole()` exactly.

### 3.3 The honesty layer (this batch)

When the catalog has no entry for a requested part, the planner no longer
substitutes silently. `src/modules/components/contracts.ts` defines six
**electrical contracts** — hobby servo, brushed DC motor, I2C sensor, digital
sensor, UART module, relay/switch — each able to `build()` a **provisional**
`ComponentDefinition` from the family alone, with deliberately **worst-case**
envelopes so the power budget errs toward refusing rather than approving.

Provisional parts are **first-class**: `planHardware` merges them into a
`workingCatalog` that the whole pipeline uses, so pins, wiring, diagram and
firmware treat them like any other part. The difference lives entirely in
`metadata.provisional` — there is no second pipeline to keep in sync. The
validator emits an `unverified_component` warning for each one, so a provisional
part can never pass silently.

`src/modules/components/demand.ts` records every request to an append-only
JSONL at `.wireup/demand.jsonl` (gitignored) with outcome
`catalog | substituted | provisional | unmatched`. `summariseDemand()` ranks
gaps by frequency × cost (unmatched 3, substituted 2.5, provisional 1,
catalog 0). This is **the answer to "what should we add next?"** — evidence
instead of intuition. Exposed at `GET /api/admin/catalog/demand`.

---

## 4. What was fixed, and why it mattered

| Fix | Harm it prevented |
| --- | --- |
| De-duplicated matcher haystack + clamped ratio | A part repeating a family word ("servo motor sg90", "micro servo", "9g servo") counted "servo" 6× and scored **123/100**, letting a vague family word beat an exact part match. |
| `containsPhrase()` whole-token containment | Alias `"uno"` matched inside `"unobtainium widget"` at score 80. Every short alias (esc, led, pot) was hiding inside ordinary English words. |
| Contract preference (`CONFIDENT_MATCH = 85`) | "DS3218 waterproof servo" hit the SG90 at 80 on the word "servo" alone. Shipping a 500 mA servo for a 2500 mA one understates the supply **5×** with nothing downstream able to detect it. Now yields a provisional part at 5000 mA peak + a validator warning. |
| `workingCatalog` threaded through the pipeline | The orchestrator passed the *original* catalog to all 9 downstream stages, so pins, wiring, diagram and firmware would have silently skipped the very part the user asked for. |
| Current-aware driver ladder | Selection fell through to the L298N for anything over 1.2 A regardless of magnitude — a 5 A motor got a 2 A Darlington bridge. Now picks the smallest driver that carries the stall current, efficient parts first (the L298N's ~2 V drop wastes battery). |
| `TMCStepper.h` runtime shim | NEMA17 correctly routes to a TMC2209, but the emulator had no header, so the sketch failed to compile and behavioural checks degraded 19→17. |
| Alias collision audit (earlier batch) | First exact-alias hit won, so *file order* decided the part. "piezo buzzer" now → passive (`tone()`), bare "buzzer" → active (`digitalWrite`). |
| `CAD_ROLE_TOLERANCE` (earlier batch) | A CAD anchor could carry the right pin name with the wrong role — geometry that looks right and wires wrong. |

---

## 5. How to work here

### 5.1 The gates — run all of these before committing

```bash
pnpm typecheck            # tsc --noEmit, strict
pnpm verify:contracts     # 28/28 — unknown parts degrade honestly
pnpm verify:cad-link      # 86 parts previewable, anchors match registry
pnpm verify:offline       # deterministic build path, no Bedrock
pnpm verify:behavioral    # 19/19 — emulated firmware behaviour
pnpm build                # next build
```

Also available: `verify:firmware` (9/9 host compile), `verify:llm-codegen`
(32/32), `verify:workbench` (30/30). There is **no `pnpm lint`** — do not
look for it.

`pnpm seed -- --dry-run` always exits 1 without `MONGODB_URI`; the validation
output printed *above* the error is the authoritative signal.

### 5.2 Authoring a registry entry

- Honest `currentRequirements` with a `note` naming the source or assumption.
- `motorRequirements` on motors/ESCs/drivers. Note the field is
  `maxCurrentPerChannelMa`, **not** `maxCurrentMa`.
- `incompatibleComponents` + `metadata.incompatibleReason` when parts conflict.
- `metadata.inductiveLoad` + `flybackDiodeRequired` on coils and motors.
- `metadata.electrical: false` + `mechanicalOnly: true` for propellers etc.
- `metadata.noSupplyPins: true` for two-terminal bridge-driven loads.
- `simulator: { supported: false }` unless a *verified* Wokwi part exists.
- If the part declares a library, make sure a shim header exists in
  `scripts/firmware-shim-runtime/` or behavioural checks will regress.

### 5.3 Authoring a CAD spec

- Pin `name` must match the registry pin exactly (alias-aware).
- Real millimetre geometry — measured or datasheet, never eyeballed.
- No `visualAsset` without a reviewed assembly.
- Add the id to a preset only if the parametric derivation is genuinely wrong;
  a good derived tier entry beats a sloppy preset.

### 5.4 Traps that already cost time

- `npx tsc --noEmit` in a repo with no `node_modules` installs the unrelated
  `tsc@2.0.4` package. Use `pnpm typecheck` / `pnpm exec tsc`.
- `AgentEventStatus` is only `started | completed | failed | info` — there is
  **no `'warning'`**. User-facing severity belongs in the validation issue.
- `ProjectState` has **no `artifacts.components`**; selections live at
  `project.components`.
- `StatusDot` accepts only `NodeStatus | 'live' | 'ok'` — no `'warn'`.
- `src/lib/mongodb/components.ts` `toDefinition()` does **not** copy
  `metadata`. Check this before relying on provisional parts round-tripping
  through Mongo.
- `tsx` scratch scripts are CJS: no top-level `await`, wrap in `main()`.

---

## 6. What to do next

**Immediately actionable, in priority order:**

1. **Wire the new ids into `defaults.ts` candidate lists.** The driver ladder
   consumes some, but these are still not reachable through feature defaults:
   `drv8833-motor-driver`, `bts7960-motor-driver`, `tmc2209-stepper-driver`,
   `drv8825-stepper-driver`, `pca9685-servo-driver`, `mosfet-module-irf520`,
   `uln2003-darlington-array`, `servo-motor-mg90s`, `servo-continuous-fs90r`,
   `n20-gear-motor-encoder`.
2. **Surface provisional parts and the demand report in the admin panel.** The
   API exists (`/api/admin/catalog/demand`); the UI does not. Additive only —
   do not disturb existing admin surfaces.
3. **Next expansion batch.** The user explicitly named fans and propellers;
   neither is well covered. Suggested: BLDC motors + ESCs (with the
   arm/calibration sequence documented), propellers as `mechanicalOnly`,
   cooling fans (2/3/4-wire, tach + PWM), then load cells/HX711, TOF
   (VL53L0X), current sensing (INA219/ACS712), RTC (DS3231), SD card, audio
   (DFPlayer/MAX98357A), stepper linear actuators.
4. **Consider a seventh+ contract** as the demand log fills — the current six
   leave capacitors, displays and power supplies with no fallback family (the
   "quantum flux capacitor" case degrades to a logged substitution, which is
   honest but improvable).
5. **Open a PR** for the three commits on this branch.

**Method for each expansion batch** (this is the part that makes it a saga
rather than a pile):

1. Read `GET /api/admin/catalog/demand` — let evidence pick the parts.
2. Research each part from primary sources: datasheet first, then vendor
   hookup guides (Pololu, Adafruit, SparkFun, Sparkfun/TI/Trinamic PDFs).
   Record the numbers that matter: voltage range, continuous *and* stall
   current, logic level, control signal, pin order on the physical header.
3. Author the registry entry, then the CAD spec, sharing one id.
4. Add or extend a contract if the part reveals a family with no fallback.
5. Add a shim header if it declares a new library.
6. Run every gate. Add a `verify:contracts` case for anything subtle.
7. Commit with a message that explains the *harm avoided*, not the diff.

---

## 7. Map of the territory

| Path | What it is |
| --- | --- |
| `src/types/component.ts` | Canonical `ComponentDefinition`, `ComponentPin`, `MotorRequirements`, `PowerSourceRequirements`, `ComponentSelection`, `PowerBudget`. |
| `src/modules/components/seed/*.ts` | The parts themselves. `helpers.ts` has `def()`/`pin()`. |
| `src/modules/components/catalog.ts` | Aggregation + `checkCatalogIntegrity`. |
| `src/modules/components/service.ts` | `matchComponent`/`matchComponentStrict` (minScore 55). Scoring: id 100 → exact alias 95 → exact name 92 → substring alias 80 → substring name 75 → keyword 65 → token overlap 30–65. `containsPhrase()` guards containment. |
| `src/modules/components/contracts.ts` | Six electrical contracts; `matchContract()` with anti-signal vetoes. |
| `src/modules/components/demand.ts` | `recordDemandBatch`, `summariseDemand`, `getDemandReport`. All I/O failures swallowed to `logger.debug` — telemetry must never break a build. |
| `src/modules/components/schema.ts` | zod schema; pin type enum. |
| `src/modules/hardware-planner/index.ts` | `normaliseModelSelections`, `planHardware`, `CONFIDENT_MATCH`, `workingCatalog`. |
| `src/modules/hardware-planner/defaults.ts` | Feature→candidate rules and the driver ladder. |
| `src/modules/hardware-planner/power.ts` | `computePowerBudget`. |
| `src/modules/validator/rules.ts` | `power.budget` check + the `unverified_component` loop. |
| `src/modules/orchestrator/pipeline.ts` | Stage 5 plans hardware and builds `workingCatalog` for all downstream stages. |
| `src/modules/pin-planner/mcu-profiles.ts` | MCU pin capability ground truth. |
| `cad-helper/catalog-link.ts` | `auditCatalogCadLink`, `deriveSpecFromComponent`, `cadPinRole`, `CAD_ROLE_TOLERANCE`, `findAliasCollisions`. |
| `cad-helper/presets-motion.ts`, `types.ts`, `*-generator.ts` | Geometry presets, spec types, STL/GLB/bundle output. |
| `scripts/verify-*.ts` | The gates. `verify-contracts.ts` is 6 sections, needs no network or credentials. |
| `scripts/firmware-shim-runtime/` | Host-compile headers for the behavioural emulator. |
| `docs/admin-cad-studio.md` | "Registry ↔ CAD link" reference. |

---

## 8. Verified reference data (already researched, do not re-fetch)

**BTS7960 / IBT-2 dual half-bridge.** Motor supply 6–27 V DC; logic Vcc 5 V,
inputs 3.3–5 V tolerant; 43 A peak (~10 A continuous with cooling); PWM to
25 kHz. 8-pin header in order **RPWM, LPWM, R_EN, L_EN, R_IS, L_IS, Vcc, GND**
(R_IS/L_IS are analog current-sense outputs). Screw terminals B+/B− and M+/M−.
Over-current, thermal and under-voltage protection. ~50×50×43 mm, ~66 g.
RPWM/LPWM must land on PWM-capable MCU pins; R_EN/L_EN are plain digital.

**DRV8833 dual H-bridge carrier.** VIN 2.7–10.8 V; 1.2 A continuous per channel
(Pololu; TI datasheet says 1.5 A), 2 A peak; channels paralleled → 2.4 A cont /
4 A peak. No separate logic supply; inputs 3.3 V and 5 V compatible. Pins: VIN,
VMM, GND, AOUT1, AOUT2, BOUT1, BOUT2, AIN1, AIN2, BIN1, BIN2, nSLEEP
(silkscreen SLP, default HIGH), nFAULT (silkscreen FLT, open-drain, low on
fault), AISEN/BISEN (grounded by default; current limiting needs break points
cut + sense resistors). All four IN pins accept PWM. Drives two brushed DC
motors or one bipolar stepper.

**Driver ladder behaviour as shipped** (rated per-channel × 0.8 ≥ stall):

| Stall | 3.3 V MCU | 5 V MCU |
| --- | --- | --- |
| 200 mA | DRV8833 | TB6612FNG |
| 700 mA | DRV8833 | TB6612FNG |
| 1000 mA | L298N | L298N |
| 1500 mA | L298N | L298N |
| 2000 mA+ | BTS7960 | BTS7960 |

Steppers branch first by coil current: ≤1000 mA A4988, ≤1500 mA DRV8825,
above that TMC2209.
