# Handoff — electronic-safe build, firmware behaviours, and quality fixes

**Branch:** `arena/01a07c4a-wireup-mvp` (branched from `acb3350` of `main`)
**Date:** 2026-09-08 (second pass same day — §2.11–§2.14, §10)
**Status:** all verification gates pass; §7 items 7.2–7.5 are DONE. Remaining work is listed in §7.

This document is written for an agent (or engineer) picking the work up cold. It records what the
user reported, what was actually wrong, what was changed and why, how to prove it still works, and
what is deliberately left undone.

---

## 1. Environment: read this first

| Fact | Consequence |
| --- | --- |
| `node_modules/` is **not persisted** between sandbox turns/sessions | Run `npm install --no-audit --no-fund` (~10 s from cache) before anything else. `npx tsx`/`npx tsc` fail confusingly ("tsx: not found", or npx installs the unrelated `tsc@2.0.4` package) when it is missing. |
| No MongoDB, no AWS credentials, no network to Bedrock | Everything must be verified offline. The pipeline detects `EAI_AGAIN` and falls back to its deterministic path — that is the path all harnesses exercise. |
| `g++` **is** available (no `arduino-cli`, no `avr-gcc`) | Generated firmware is type-checked against the stub core in `scripts/firmware-shim/` — see §5. |
| `package-lock.json` exists in the working tree but is **untracked upstream** | Left out of commits on purpose (the repo tracks no root lockfile). Do not commit it unless the maintainer asks. |
| `tsconfig.json` excludes `external/` | `external/velxio/**` is a vendored reference checkout (pnpm, its own tests). Read it, do not build it, do not "fix" it. |

Useful commands:

```bash
npm install --no-audit --no-fund      # after every sandbox reset
npx tsc --noEmit                      # typecheck (must stay clean)
npm run verify:offline                # pipeline + fixer end-to-end, offline
npm run verify:firmware               # generate 13 builds, compile-check every sketch
npx tsx scripts/repro-safe.ts         # NEW: the user's "electronic safe" prompt, full artifact dump
npx tsx scripts/seed-components.ts --dry-run   # catalog integrity + zod schema check
```

`scripts/repro-safe.ts` writes artifacts to `/tmp/wireup-artifacts` (override with `REPRO_OUT=…`):
`sketch.ino`, `diagram.json`, `power.json`, `validation.json`, `velxio-project.json`,
`velxio-unsupported.txt`, `contract.json`.

---

## 2. What the user reported, and what was actually wrong

The user pasted the rendered output of a Wireup build ("electronic safe" on an Arduino Nano,
revision 5, 32 parts / 56 wires / 91 pins, 24 errors + 12 warnings) and asked for root causes and
fixes. Nine defect clusters; each one is now either fixed and verified, or explained as a
non-defect (§8).

### 2.1 Firmware was a generic "button counter", not a safe — **FIXED**

Root cause: `generateSketch()` in `src/modules/code-generator/templates.ts` had exactly two shapes —
a generic skeleton and a `counterMode` branch — and `counterMode` fired whenever the build had
buttons. A keypad + servo + OLED build therefore got a press counter that *declared* `Servo` and
`Adafruit_SSD1306` objects and never used them.

Fix (the biggest piece of work in this branch):

- **New behaviour module** `src/modules/code-generator/behaviours/access-control.ts` (~1100 lines):
  `detectAccessControl(ctx)` + `buildAccessControlSketch(ctx, plan)`. It emits a complete,
  non-blocking PIN/lock state machine (details in §9).
- **Dispatch** in `generateSketch()`: access control is checked *first*; `counterMode` now requires
  explicit counting words in the brief **or** `nothingElseToDrive` (no drive channels, no command
  set, no servo, no display, no LEDs).
- Detection is **structural**, not keyword-based: a lock actuator (servo with an assigned signal
  pin, or a relay assignment) **and** key input (a `metadata.keypadMatrix` part, or **≥3** discrete
  `input_device` buttons). Prompt words only influence labels and messages. The ≥3 rule matters:
  "servo + one button" is a sweep, and it used to be forced into a PIN state machine.
- `src/modules/code-generator/managed-blocks.ts` (new) holds the pin-map/include primitives
  extracted from `templates.ts` so a behaviour module can compose a full sketch **without importing
  the generic template** (which would be a circular dependency). `templates.ts` re-exports them, so
  existing importers keep one stable path.

### 2.2 Duplicate / malformed `const int` in the pin map — **FIXED**

Two independent causes:

1. **Emission:** two assignments for the same `(instance, pin)` produced two `const int` with the
   same name → redefinition. Also a pin named `+` sanitised to the empty string, producing
   `PIN_BUZZER_PASSIVE_1_`. Fixed by `uniqueCodeAssignments()` (first assignment wins, duplicates
   reported) and `pinToken()` (`+` → `PLUS`, `-` → `MINUS`) in `managed-blocks.ts`.
2. **Creation:** the fixer could add a second assignment for a pin that already had one
   (`set_pin_assignment` in `src/modules/fixer/apply.ts`, `fixFloatingPin` in
   `src/modules/fixer/strategies.ts`). Both now merge/guard instead of appending.

`scripts/compile-check.ts` asserts uniqueness of every constant in the sketch, so a regression here
fails the harness, not the user's build.

### 2.3 Nine signals collapsed onto A2; A6/A7 driven as digital; D0/D1 (UART) used — **FIXED**

- `src/modules/pin-planner/index.ts`: `Demand` now carries `hardCapabilities`. `digital` and `adc`
  are **hard**; `pwm`/`i2c`/`uart`/`spi` are **soft** (preferred, not required). `reassignPin()`
  takes an `alsoExclude` set, and `relocateAssignments()` threads `ctx.plannedPins` so a fallback
  cannot land on a pin another signal already took (that was the A2 ×9 collapse).
- `src/modules/pin-planner/mcu-profiles.ts`: Nano/Uno `usablePins` marks A6/A7 **input-only** (no
  digital I/O on the ATmega328P) and D0/D1 as UART-reserved.
- `src/modules/fixer/strategies.ts`: `freePin()` has a hard floor — it will not propose a pin that
  violates a hard capability, and it respects already-planned pins.

### 2.4 No 4×4 keypad in the catalog → 16 pushbuttons — **FIXED**

- New catalog part `keypad-4x4-membrane` in `src/modules/components/seed/general.ts`:
  pins R1–R4 (digital/input/required), C1–C4 (digital/output/required),
  `simulator.part = 'wokwi-membrane-keypad'`, `metadata.keypadMatrix` with row/col constants and the
  standard `keyMap` (`1 2 3 A / 4 5 6 B / 7 8 9 C / * 0 # D`).
- Feature rules so it is *selected*: `src/modules/project-understanding/heuristics.ts` (keypad rule
  **before** the generic `user_input` rule) and `src/modules/hardware-planner/defaults.ts`
  (`FEATURE_PART_RULES`).
- Pin naming: Wokwi and Velxio both use R1–R4 / C1–C4, so `PIN_MAPS` needs **identity** for the
  keypad (verified against `docs.wokwi.com/parts/wokwi-membrane-keypad` and against
  `external/velxio/frontend/src/simulation/parts/BasicParts.ts` L647-712).
- **Simulator convention (must match the firmware):** the Velxio/Wokwi keypad model pulls rows LOW
  and reads columns LOW on press. `buildAccessControlSketch` therefore drives rows as `OUTPUT`
  (one LOW at a time) and reads columns as `INPUT_PULLUP`. Do not "simplify" this.

### 2.5 Velxio embed: wrong board, 26 parts / 0 wires, rejected LED-resistor wires — **FIXED (3 of 3 observed causes)**

- **Part↔part wires were dropped.** `src/modules/simulation/velxio-project.ts` assumed a wire must
  have a board net at one end. A Velxio wire is simply
  `start.componentId/pinName → end.componentId/pinName` (see
  `external/velxio/frontend/src/types/wire.ts`), so a series resistor feeding an LED anode is fully
  representable. Now emitted, with `classifyPartWire()` for colour/signal type. Result on the safe
  build: **24 wires, 0 unsupported** (was: 2 rejected). Velxio's own gallery test
  (`__tests__/examples-led-resistor.test.ts`) flags an LED with no limiter as a defect — dropping
  those wires recreated exactly that.
- **Capacitors were declared unsimulatable and were wrong.** `wokwi-capacitor` **does** exist
  (verified in `external/velxio/frontend/public/components-metadata.json`, `tagName:
  'wokwi-capacitor'`, and Velxio even simulates its charge transient —
  `__tests__/capacitor-charge-transient.test.ts`). Both capacitor catalog entries are now
  `supported: true` with `attrs.value` (`100n`, `1000u` + `voltage: 16`), a `wokwi-capacitor` entry
  was added to `PIN_MAPS`, and the Velxio exporter maps them to `capacitor`.
  Velxio *also* has a distinct polarised part (`capacitor-electrolytic`, terminals `+` and **U+2212
  `−`**, and it verifies polarity against the rail voltage), so `METADATA_REFINEMENTS` in
  `velxio-project.ts` upgrades `capacitor-*electrolytic*` instances to it and renames `1`→`+`,
  `2`→`−`.
- **Two catalog entries were honestly wrong before, and are now honest:**
  `neopixel-ws2812b-strip` (`wokwi-neopixel`, DIN/DOUT/VDD/VSS match pin for pin) is now
  `supported: true` with a note that the simulator models **one** pixel; `ldr-photoresistor` stays
  `supported: false` but the reason is now the truth — Wokwi/Velxio only model a **four-pin
  photoresistor module** (VCC/GND/DO/AO), not a bare two-terminal LDR, and placing the module would
  wire a divider to pins the part does not have.
- **Board fallback — FIXED.** It used to default to `arduino-uno` whenever no controller reached the
  projection (that is what the user saw: "no controller maps to a Velxio board"). Resolution is now
  Wokwi part → the diagram's own controller ref → `arduino-uno`, the substituted board is named in
  `unsupported` with the reason, and the Wokwi projection raises a first-position warning when the
  controller itself is skipped. See §7.1.

### 2.6 Power plan: over budget, SG90 on 9 V, capacitor on the wrong rail, noisy notes — **PARTLY FIXED**

`src/modules/hardware-planner/power.ts`:

- **Rail placement is now voltage-driven, not category-driven.** An SG90 is category `motor` but a
  4.8–6 V part, so with a 9 V pack it belongs on the regulated 5 V rail (which is where the wiring
  planner already put it). Judging it against the raw supply produced a blocking *"SG90 accepts at
  most 6 V but the supply provides 9 V"* error on a correct design. `belongsOnLogicRail()` decides,
  and the window check now judges such a part against the logic rail and says so.
- **Contact-only parts draw nothing.** `metadata.noSupplyPins === true` parts are skipped in
  `sumLoads()`. Summing sixteen 50 mA pushbutton *contact ratings* once produced a "1025 mA peak"
  logic rail and a budget error for a build that idles at microamps.
- **Stall vs sustained.** New catalog metadata `stallIsTransient: true` on position servos (SG90,
  MG996R): a servo holds at a few mA and only stalls when mechanically blocked, so treating stall
  current as a continuous draw failed every single-servo build on paper. Sustained load is now
  `supply-rail peak + logic-rail typical + 20 % of transient stall`; the raw transient peak is still
  reported with the bulk-capacitor note.
- **Conflict codes are honest now.** A power shortfall was emitted as `invalid_voltage` quoting
  `power.notes[last]` (generic capacitor advice), then the validator relabelled every non-auto-fixable
  wiring conflict as `dangling_reference`. The user saw *"dangling_reference: Power budget check
  failed: Add a bulk electrolytic capacitor…"* — two wrong codes and the wrong sentence. Now:
  `power_budget_exceeded` (added to `WiringConflictCode` in `src/types/wiring.ts`), quoting
  `power.shortfalls[0]`, and the validator keeps each conflict's own code (every
  `WiringConflictCode` is already a valid `ValidationIssueCode`).
- **Wiring notes de-noised.** `src/modules/wiring-planner/index.ts` now collects contact-only parts
  and reports them once instead of per instance (sixteen identical "left unpowered" notes).

Still open: bulk-capacitor *placement* (which rail it is physically attached to) and the
linear-regulator dissipation note (9 V → 5 V at 500 mA ≈ 2 W in the Nano's regulator). See §7.3.

### 2.7 UI: `&amp;` entities, broken markdown tables, "Dig in" cards concatenated — **PARTLY FIXED / ONE NON-ISSUE**

- **`&amp;` — real, fixed at the source.** Model-authored prose arrives HTML-escaped, is stored as
  markdown and rendered by React, which escapes it a *second* time. New shared helper
  `src/lib/text/entities.ts` (`unescapeHtmlEntities`) is applied where model text enters the system:
  `extractModelMarkdown()` in `src/modules/instructions-generator/index.ts` (markdown, section
  titles, section bodies). `src/modules/diagram-generator/index.ts` now imports the shared helper
  instead of its own local copy. Note the ordering subtlety encoded there: `&amp;` must be decoded
  **last**, or `&amp;lt;` becomes `<` and invents markup.
- **Markdown tables — already fixed** (earlier in this branch): the block parser in
  `src/components/workspace/ui.tsx` requires the column pipes in its table regex, otherwise only a
  single-column table ever matched and real tables rendered as flat paragraphs. It also seeds the
  paragraph branch with the current line to guarantee forward progress (a `|` row with no separator
  used to spin the parser into an infinite loop).
- **"Dig in" cards — not a defect.** `src/components/workspace/panels/OverviewPanel.tsx` renders a
  proper `<Link>` grid and `.overview__links` in `src/app/globals.css` is a
  `grid` with `repeat(auto-fit, minmax(220px, 1fr))`. Copying rendered *text* out of a card grid
  concatenates it; that is what the user pasted. Do not "fix" this (§8).

### 2.8 24 errors / 12 warnings on the quality page, incl. sketch-vs-pin-plan mismatches — **FIXED for the deterministic path**

The safe repro now validates **passed: true, 0 errors, 0 warnings**, and the dashboard's static
cross-check reports **0 findings**. Two of the largest contributors were the mislabelled power
conflict (§2.6) and contract drift (§2.9).

### 2.9 Dashboard contract did not match the firmware — **FIXED (structural)**

`src/modules/software-generator/contract.ts` derived metrics from heuristics: it advertised a
`speed` card for a keypad safe that has no speed, and `validate.ts` looked for `case 'X':` labels
while the sketches parse with `if (command == 'X')`, so **every** command in **every** build was
reported unhandled.

New module `src/modules/software-generator/firmware-signals.ts` reads the generated sketch once and
answers three questions — `telemetryFields()` (scoped to the body of `sendTelemetry()`),
`commandCharacters()` (accepts both `case 'x':` and `command == 'x'`, upper-cases an `L`/`l` pair),
`opensControlLink()`. Both `contract.ts` and `validate.ts` now consume it, so the dashboard, the
README and the findings agree with the firmware **by construction**:

- metrics = exactly the printed keys (`state, locked, door, attempts, angle` for the safe), with
  labels/units from `ACCESS_CONTROL_FIELDS`; anything not printed is dropped;
- commands = exactly the accepted characters (`?`, `L`, `S`), labelled from `BUILT_IN_COMMANDS`;
- the contract input gained `firmware`, passed from `generateSoftware()`.

### 2.10 EEPROM library was never planned → no PIN persistence — **FIXED**

The managed include block is authoritative: `ensureIncludesBlock()`/`pruneIncludes()` drop any
include not present in the library manifest, so emitting `#include <EEPROM.h>` in the sketch was not
enough. `src/modules/software-planner/index.ts` gained `needsPersistentStorage()` (exported): true
when a lock actuator and key input coexist with a credential word in the brief, or when the brief
asks to store/persist/remember a PIN or setting. `resolveLibraries()` then adds the built-in
`EEPROM` entry, `plan.eeprom` goes true, and the sketch keeps the PIN across resets. Without it the
firmware degrades to a compiled-in PIN **and records a warning note in the sketch header** — that
graceful path is deliberate, keep it.

---

### 2.11 Pin-plan defence rules (validator) — **DONE (second pass)**

The planner and fixer no longer *created* the reported pin-plan defects, but a model-authored pin
plan still could, and nothing reported it. Three new rules in `src/modules/validator/rules.ts`
(§5 "pins"), codes added to `src/types/validation.ts`, vocabulary in
`src/lib/bedrock/prompts.ts`:

- `duplicate_pin_assignment` (error, auto-fixable) — two assignments claiming one
  `mcuInstanceId`+`pin` for different targets. Shared buses are exempt (all members `i2c`/`spi`):
  an OLED and an LCD on the same A4/A5 is legal. The fixer case mirrors
  `uniqueCodeAssignments()`: the FIRST assignment is kept, the later one is dropped via
  `remove_pin_assignment` (which also removes its wire; the freed peripheral pin is re-reported as
  `floating_required_pin` and fixed in the next pass).
- `analog_only_pin_driven` (error, auto-fixable) — an assignment on an input-only pin with **no
  digital capability** (Nano/Uno A6/A7, ESP32 GPIO34–39) whose direction is `output` **or** whose
  protocol is not `adc`. A digital READ on those pins returns garbage just as surely as a write;
  the old `input_only_pin_driven` only covered outputs. That code still exists for future
  digital-capable input-only pins (e.g. RP2040). Fixer: `relocateAssignments` mode `analog-only`.
- `uart_pin_used_as_gpio` (error, auto-fixable) — a GPIO assignment on a hardware-UART pin while
  the generated sketch actually starts that port. Gated on the sketch text
  (`opensSerialPort()` looks for `Serial.begin(` in the code artifact), so plan-only validation
  never guesses. Fixer: mode `uart`.

Proof: `scripts/verify-offline-fallback.ts` §6 sabotages the working ESP32 project three times
(independent rounds) — duplicate claim on the I²C pin, GPIO34 as digital output, GPIO1 (Serial TX)
as GPIO — and asserts each code fires as an error, the deterministic fixer repairs it, and
re-validation no longer reports it. A profile assertion also pins the Nano A6/A7 facts the rule
relies on.

### 2.12 Power honesty: rail placement, capacitor rail, regulator heat — **DONE (second pass)**

Empirically re-testing the user's scenario (9 V PP3 + Nano + SG90 + OLED + 1000 µF) showed §2.6's
"voltage-driven rails" fix only worked in the USB-powered case; **the battery build still failed
validation**. Three defects, all fixed in `src/modules/hardware-planner/power.ts` +
`src/modules/wiring-planner/index.ts`:

1. `belongsOnLogicRail()` compared the part's **max** voltage against `logic + 0.6` — no
   4.8–6 V part can pass that at 5 V logic, so the SG90 was booked onto the 9 V rail the wiring
   planner had correctly avoided, and the budget emitted the blocking "SG90 accepts at most 6 V
   but the supply provides 9 V" again. The test now asks whether the logic voltage sits INSIDE the
   part's window (`logic >= min − 0.6 && logic <= max + 0.6`). The power budget and the wiring
   graph agree by construction again.
2. The logic rail's totals excluded `logicSideLoads` (the servo's current), so the moment the
   servo was classified onto the 5 V rail its stall vanished from the transient-peak math. Rail
   totals now include them.
3. **Bulk capacitor placement.** The wiring planner hardcoded the 1000 µF cap across
   `rails.supply` (the battery in a 9 V build) while the servo pulled from the Nano's 5 V pin —
   the user's "capacitor on wrong rail". It now reads the power budget's rail membership for the
   stall-prone loads (majority vote, ties → supply) and wires the cap to THAT rail, with an
   explanation naming the rail and what it feeds. The power note in `power.ts` uses the same
   classification: all-logic → "across the 5 V logic rail that feeds the SG90", all-supply →
   supply wording, mixed → both rails named.
4. **Linear-regulator dissipation note.** When `supplyVoltage − logicVoltage > 3`, the logic-rail
   throughput (sustained logic typical + 20 % of logic-rail stall, same convention as the
   sustained budget) is significant (≥ 0.5 W), and no switching regulator is in the conversion
   path, the plan now notes the linear burn (9 V → 5 V at ~160 mA ≈ 0.6 W; the mission's 500 mA
   example ≈ 2 W) and recommends a buck converter or a separate 5 V source. The throughput stays
   in mA on both sides — a linear regulator passes current through (`I_in ≈ I_out`); only a
   switching regulator would need a power-based conversion, and that case is skipped.

Proof: `scripts/verify-offline-fallback.ts` §7 builds the synthetic battery scenario from the
seed catalog, then asserts: adequate = true, no false blocking voltage error, the servo on the 5 V
rail, the capacitor note naming that rail, the dissipation note with a W figure + buck
recommendation, mA kept as mA, and — via a real `planWiring` call — the capacitor's power wire
landing on `arduino-nano-1.5V`, not on the battery.

### 2.13 Compile harness extended + CI — **DONE (second pass)**

`scripts/compile-check.ts` now runs **13** builds. Added (each with case-specific `extraChecks`
that pin the DEGRADED path the generic checks cannot judge):

- `esp32-oled-i2c` — asserts `Wire.begin(PIN_…_SDA, PIN_…_SCL)`, the remappable path.
  `scripts/firmware-shim/Wire.h` gained the ESP32 core's `begin(int sda, int scl,
  uint32_t frequency = 0)` overload; without it every ESP32 I²C sketch failed the shim.
- `relay-lock-keypad` — access control with a relay lock and NO display (asserts no display
  header is pulled in and EEPROM is planned). Prompt-writing gotcha recorded in the case comment:
  never write "no display" in a brief — the feature matcher is keyword-based and the negation
  still selects the OLED.
- `safe-no-eeprom` — a lock brief whose wording avoids every persistence AND credential word the
  planner matches; asserts the managed include block prunes `<EEPROM.h>` and the sketch header
  warns "the PIN is compiled in".
- `l298n-two-motor` — asserts the driver + a battery are selected (supply-rail exercise).
- `line-follower-l298n` — the new behaviour (§2.14); asserts the steer controller exists and
  `setup()` stops the motors first.

CI landed as `.github/workflows/ci.yml`: typecheck, `verify:offline`, `verify:firmware`,
`seed-components --dry-run` on every push/PR, ubuntu-latest (g++ preinstalled; the script
degrades to static-checks-only with a clear message where no compiler exists).

### 2.14 Line-follower behaviour module — **DONE (second pass)**

`src/modules/code-generator/behaviours/line-follower.ts` is the second member of `behaviours/`.
For a line-follower brief the generic template wired the parts and emitted NO follow logic —
right parts, wrong program, the safe-build failure class again.

- Detection is structural and catalog-grounded: ≥2 instances of a part the catalog marks as a
  line/reflectance sensor (keywords include "line follower") with digital input assignments, plus
  an H-bridge driver with ≥2 `IN`-paired channels. A single sensor cannot steer, so it bails to
  the generic template rather than faking a follower. A coverage guard bails when the plan
  contains anything the module cannot drive (display, servo, second button) — invariant 7 holds
  by construction.
- Firmware: sensors straddle the line, steer toward the sensor that sees it, pivot on the inner
  channel; 400 ms lost-line grace then a reported stop; edge-debounced start/stop button; motors
  stopped before anything else in `setup()`; PWM on enable pins when assigned; LED + mirror LEDs;
  telemetry `state/left/right/command/speed` at 1 Hz; commands `?`, `S`, `G`, `H` (the
  `incoming == 'G'` idiom is already accepted by `firmware-signals.ts`).
- Sensor polarity is ONE constant (`LINE_READS_HIGH`, derived from catalog
  `metadata.activeLevel`, mixed-polarity builds get a header note) — report the assumption, never
  fake it.
- `src/modules/project-understanding/heuristics.ts`: the `line_following` feature rule now emits
  `ir_sensors` quantities (`quantityKey`/`quantityNouns`), so "two line sensors" actually selects
  TWO instances — the hardware-planner rule for `line_following` already consumed
  `quantities.ir_sensors` but nothing produced it.
- Dispatch in `generateSketch()` sits after access-control; the behaviour module imports
  primitives from `managed-blocks.ts` and the `SketchContext` TYPE only from `templates.ts`
  (invariant 3). No new libraries are required (invariant 1 is untouched).

Proof: the `line-follower-l298n` compile case (behaviour `line-follower`, compiles clean, both
extra checks pass), and the build passes validation with 0 errors / 0 warnings.

---

## 3. Invariants the next agent must respect



1. **The managed include block is authoritative.** Any include the firmware needs must exist in
   `softwarePlan.libraries`, or hygiene prunes it. Add libraries in `software-planner`, not in code.
2. **Generated code must not contain** `TODO`/`FIXME`/`placeholder`/`…` (`assessCodeQuality` regex),
   must have `setup()` + `loop()`, balanced braces, and ≥80 characters.
3. **No circular imports between codegen modules.** Behaviour modules import primitives from
   `managed-blocks.ts` and the `SketchContext` **type only** from `templates.ts`.
4. **Keypad firmware is self-contained** — a hand-written matrix scan, *no* `Keypad` library. Rows
   driven LOW one at a time, columns `INPUT_PULLUP`.
5. **Hard vs soft pin capabilities:** `digital`/`adc` are hard (never violate), `pwm`/`i2c`/`uart`/
   `spi` are soft (prefer, but a fallback may ignore them).
6. **Nothing in `loop()` blocks.** Servo travel is stepped (`stepLock()`), tones are scheduled
   (`toneUntil`), displays redraw only on change, the alarm countdown redraws once per second.
7. **Every assigned pin must be driven by the firmware.** `compile-check.ts` fails a build whose pin
   map declares a constant the sketch never uses (this is how the "third LED nobody drove" bug was
   found).
8. **Report, never fake.** Unmappable simulator parts, unrepresentable wires and degraded firmware
   features are listed in `unsupported` / `warnings` / `plan.notes` — never silently substituted.

---

## 4. Files changed on this branch

New:

| Path | What it is |
| --- | --- |
| `src/modules/code-generator/behaviours/access-control.ts` | PIN/lock state-machine generator (~1100 lines) |
| `src/modules/code-generator/managed-blocks.ts` | Pin-map + include-block primitives, shared by all sketch builders |
| `src/modules/software-generator/firmware-signals.ts` | Reads telemetry keys / command chars / link open out of a generated sketch |
| `src/lib/text/entities.ts` | `unescapeHtmlEntities()` — decode model-authored entities once, at the boundary |
| `scripts/firmware-shim/*.h`, `Arduino.cpp` | Host-side stub of the Arduino core + 18 library headers, for type-checking generated firmware |
| `scripts/compile-check.ts` | `npm run verify:firmware`: 13 representative prompts → generate → static checks → `g++ -fsyntax-only` |
| `scripts/repro-safe.ts` | The user's safe prompt through the whole pipeline, dumping every artifact |

Modified (with the reason in one line):

| Path | Why |
| --- | --- |
| `src/modules/code-generator/templates.ts` | Dispatch access control first; stricter `counterMode`; re-export managed-blocks; shared I²C init |
| `src/modules/code-generator/hygiene.ts` | `EEPROM.h` is a toolchain header (never pruned) |
| `src/modules/software-planner/index.ts` | `needsPersistentStorage()` + EEPROM library entry |
| `src/modules/software-generator/{contract,index,validate}.ts` | Contract derived from the firmware text; command check accepts both parser idioms |
| `src/modules/components/catalog.ts` | `checkCatalogIntegrity` exempts `metadata.noSupplyPins === true` (this is why `pnpm seed` failed on a clean checkout) |
| `src/modules/components/seed/{general,sensors,motors,actuators,power}.ts` | Keypad part; `noSupplyPins` on contact-only parts; `stallIsTransient` on servos; capacitor/neopixel/LDR simulator facts; `metadata.active` for buzzers |
| `src/modules/project-understanding/heuristics.ts`, `src/modules/hardware-planner/defaults.ts` | Keypad feature rule ordered **before** generic `user_input` |
| `src/modules/pin-planner/index.ts`, `mcu-profiles.ts` | Hard capabilities, matrix-scan bypass, `alsoExclude` reassignment, A6/A7 input-only, UART pins, `i2cRemappable` |
| `src/modules/fixer/{strategies,apply}.ts` | Hard floor on `freePin`, planned-pin threading, include-block rebuild, assignment merge + dup guards |
| `src/modules/hardware-planner/power.ts` | Voltage-driven rails, contact-only parts draw nothing, transient stall, honest shortfall text |
| `src/modules/wiring-planner/{index,conflicts}.ts` | Aggregated contact-only note; `power_budget_exceeded` code + real reason |
| `src/modules/validator/rules.ts` | Keep each wiring conflict's own code |
| `src/types/wiring.ts` | `power_budget_exceeded` added to `WiringConflictCode` |
| `src/modules/diagram-generator/{layout,wokwi,index}.ts` | `supported` defaults from the presence of a part id; capacitor pin map + footprints; shared entity decoder |
| `src/modules/simulation/velxio-project.ts` | Part↔part wires; capacitor mapping; electrolytic refinement + pin rename |
| `src/modules/instructions-generator/index.ts` | Decode entities in model-authored markdown/sections |
| `package.json` | `verify:firmware` script |
| `tsconfig.json` | Excludes `external/` |

Second pass (same day — pin-plan rules, power honesty, harness, line follower):

| Path | What it is / why it changed |
| --- | --- |
| `src/modules/code-generator/behaviours/line-follower.ts` | NEW behaviour module: differential-drive line follower (§2.14) |
| `src/modules/validator/rules.ts` | Three new pin-plan rules + `opensSerialPort` evidence helper (§2.11) |
| `src/types/validation.ts` | `duplicate_pin_assignment`, `analog_only_pin_driven`, `uart_pin_used_as_gpio` codes |
| `src/lib/bedrock/prompts.ts` | New codes in the model-review vocabulary |
| `src/modules/fixer/strategies.ts` | Fixer cases + `relocateAssignments` modes `analog-only`/`uart`; `duplicate_pin_assignment` drops the later claim |
| `src/modules/hardware-planner/power.ts` | `belongsOnLogicRail` window fix; logic-rail totals include logic-side loads; rail-aware capacitor note; regulator dissipation note (§2.12) |
| `src/modules/wiring-planner/index.ts` | Bulk capacitor lands on the rail that feeds the stall-prone loads (§2.12) |
| `src/modules/project-understanding/heuristics.ts` | `line_following` rule now emits `ir_sensors` quantities |
| `src/modules/code-generator/templates.ts` | Line-follower dispatch after access-control |
| `scripts/firmware-shim/Wire.h` | `Wire.begin(sda, scl, frequency)` overload (ESP32 remappable cores) |
| `scripts/compile-check.ts` | 5 new cases (13 total), per-case `extraChecks`, line-follower behaviour tag |
| `scripts/verify-offline-fallback.ts` | §6 pin-plan sabotage rounds; §7 power-honesty scenario |
| `scripts/lib/offline.ts` | NEW: shared offline bootstrap (DNS stub, env, `initialProject`) |
| `scripts/repro-safe.ts`, `scripts/compile-check.ts` | Use `scripts/lib/offline.ts` |
| `.github/workflows/ci.yml` | NEW: all four gates on push/PR |

---

## 5. The firmware compile harness (new capability — use it)

`npm run verify:firmware` runs thirteen prompts through the deterministic pipeline and type-checks
each generated sketch:

```
safe-keypad-servo (Nano, keypad+servo+OLED+buzzer+2 LEDs+door switch)   access-control  pass
safe-relay-buttons (Uno, 4 buttons+relay+LCD1602+passive buzzer)        access-control  pass
led-button-counter (Nano, 2 buttons + LED)                              generic         pass
dht-oled-monitor (Uno, DHT22 + SSD1306 + alarm LED)                     generic         pass
servo-sweep-nano (Nano, SG90 sweep + pause button)                      generic         pass
ultrasonic-alarm (Uno, HC-SR04 + passive buzzer + LED)                  generic         pass
neopixel-esp32 (ESP32, WS2812B strip + button)                          generic         pass
stepper-driver (Uno, 28BYJ-48 + ULN2003 + 2 buttons)                    generic         pass
esp32-oled-i2c (ESP32, DHT22 + SSD1306, Wire.begin(sda,scl))            generic         pass
relay-lock-keypad (Nano, keypad + relay, NO display, EEPROM)            access-control  pass
safe-no-eeprom (Nano, keypad + servo + OLED, NO EEPROM)                 access-control  pass
l298n-two-motor (Uno, 2 DC motors + L298N + battery)                    generic         pass
line-follower-l298n (Nano, 2 line sensors + L298N + button)             line-follower   pass
=== 13/13 sketches clean ===
```

Per case it also asserts: unique constants, `setup()`/`loop()` present, no placeholder text,
balanced braces, and every pin-map constant used — plus the case-specific `extraChecks` for the
degraded paths (remappable I²C, no-display lock, no-EEPROM lock, follow logic, motors-stopped-at
-boot).

It is **not** a real toolchain: `scripts/firmware-shim/` declares the same names as the AVR core
(plus `min`/`max`/`isnan` macros, `String`, `HardwareSerial`) and stubs 18 libraries
(`Servo`, `EEPROM`, `Wire`, `SPI`, `SoftwareSerial`, `Adafruit_GFX/SSD1306/Sensor/MPU6050/NeoPixel`,
`LiquidCrystal_I2C`, `DHT`, `AccelStepper`, `Stepper`, `WiFi`, `BluetoothSerial`, `BLEDevice`,
`Preferences`). It catches missing prototypes, redefinitions, undeclared identifiers and wrong
argument types — the exact failures the reported build had. Two real bugs were found this way and
both are fixed: `stepLock()` was called before it was declared (the Arduino IDE inserts prototypes,
PlatformIO and a plain compiler do not), and the I²C pin constants were declared but never used.

The harness suppresses Bedrock/Mongo DNS noise on all four console channels; if you add a case and
see no output at all, check the `NOISE` regex in `scripts/compile-check.ts`.

---

## 6. Current verification results

```
npx tsc --noEmit                     → clean
npm run verify:offline               → ✓ all checks passed (37 checks, incl. pin-plan defence §6
                                       and power-honesty §7 scenarios; see §2.11/§2.12)
npm run verify:firmware              → 13/13 sketches clean (all compile; §5 case list)
npx tsx scripts/seed-components.ts --dry-run
                                     → integrity: ok; schema: all definitions satisfy ComponentDefinitionSchema
npx tsx scripts/repro-safe.ts        → keypad in BOM; 14 pin assignments, no pin reuse, no duplicate
                                       target pins; wiring 24 connections / 0 conflicts;
                                       validation passed, 0 errors 0 warnings; fix applied 0 (nothing to fix);
                                       wokwi 9 parts / 24 connections / 0 skipped connections;
                                       velxio board arduino-nano, 8 components, 24 wires, 0 unsupported,
                                       no controller-skip warning;
                                       contract metrics [state, locked, door, attempts, angle],
                                       commands ['?' Refresh now, 'L' Lock now, 'S' Status now],
                                       software findings: none, passed: true
```

The battery variant of the user's own scenario (9 V PP3 + Nano + SG90, §2.12) — which FAILED
validation before the second pass — now validates clean with the servo on the 5 V rail, the bulk
capacitor wired to that rail, and the regulator-dissipation note present.

Before this branch the same prompt produced: no keypad (16 pushbuttons), a button-counter sketch,
`PIN_BUZZER_ACTIVE_5V_1_` (malformed), `power_budget_exceeded` + `dangling_reference`, a Velxio
project with rejected wires, and a dashboard advertising fields the firmware never printed.

---

## 7. Remaining work, in priority order

Everything listed on 2026-09-08 is done. What is left is genuinely new work:

### 7.1 ~~Velxio board fallback~~ — **DONE (2026-09-08, second commit)**

Both halves landed, verified by `npx tsc --noEmit`, `verify:offline`, `verify:firmware` and
the safe repro (`vlx boards: arduino-nano`, `vlx unsupported: 0`):

1. `src/modules/simulation/velxio-project.ts` gained `BOARD_KIND_BY_CATALOG_ID`
   (`esp32-devkit-v1` → `esp32`, `arduino-uno-r3` → `arduino-uno`, `arduino-nano` → `arduino-nano`),
   sitting next to the Wokwi-element table with a comment explaining why there are two: the element
   key only exists once the projection placed the board, the catalog `ref` always does. Resolution
   order is now *Wokwi part → diagram controller ref → `arduino-uno`*, and the `unsupported` entry
   names the controller, quotes the projection's skip reason, and states which board was substituted
   and what that costs (no wires to the MCU, firmware does not run).
   **If a new controller is added to the catalog, add it to both tables.**
2. `src/modules/diagram-generator/wokwi.ts` now `unshift`es a first-position warning when a skipped
   part is the controller — spelling out that the exported diagram has **no board**, so every wire to
   the MCU is dropped and an embedding simulator will substitute its own default.

### 7.2 ~~Validator rules for the pin-plan defects~~ — **DONE (2026-09-08, third commit)**

See §2.11. `duplicate_pin_assignment`, `analog_only_pin_driven` and `uart_pin_used_as_gpio` are in
the rule engine and the fixer, all auto-fixable, proven by the sabotage rounds in
`scripts/verify-offline-fallback.ts` §6. The I²C/SPI shared-bus exemption is the one subtlety — do
not "simplify" it away.

### 7.3 ~~Power honesty~~ — **DONE (2026-09-08, third commit)**

See §2.12 — and read it before touching `belongsOnLogicRail`: the documented §2.6 behaviour was
NOT actually implemented for battery builds until the third commit. If you change rail
classification again, re-run the §7 scenario in `verify-offline-fallback.ts` (it fails fast on
regression) AND check a battery build end-to-end, not just the USB repro.

### 7.4 ~~Harness + CI~~ — **DONE (2026-09-08, third commit)**

13 cases (§5), `.github/workflows/ci.yml` runs all four gates.

### 7.5 Still open

- **More behaviour modules.** `behaviours/` now has `access-control.ts` and `line-follower.ts`.
  The same pattern fits a PID temperature controller, an RFID (RC522) door, or an H-bridge robot
  with ultrasonic obstacle handling. One module per behaviour; detection must be structural and
  must bail (hand back to the generic template) whenever the pin plan contains anything the module
  will not drive. Do not grow `templates.ts`.
- **Wiring-level UART check.** `uart_pin_used_as_gpio` lives in the validator's pin section and is
  gated on the sketch text. A model-authored WIRING plan could still route a signal wire to D0/D1
  without a pin assignment; `wiring-planner/conflicts.ts` has no UART rule. Low priority — the
  pin-plan rule catches the build's actual failure mode.
- **Simulator-side line/IR sensors.** `ir-obstacle-sensor` is `simulator.supported: false`
  ("represent as a digital input source"). A Wokwi/Velxio representation (two toggleable digital
  inputs) would let the line-follower case run in the simulator; that is a catalog + exporter
  change with its own honesty rules, not a firmware change.

---

## 8. Dead ends and non-issues — do not chase these

- **"Dig in" cards render as one giant concatenated link.** Not a bug: it is a CSS grid of separate
  `<Link>` cards (`OverviewPanel.tsx` + `.overview__links`); copying rendered text concatenates it.
- **",," artifacts in the guide.** An artifact of how the user copied the page, not of the generator.
- **"171 min build" style heuristics.** Not used anywhere; do not reintroduce time-based guesses.
- **Surgically extending the 800-line generic template** with keypad branches everywhere. Tried
  early, abandoned: the behaviour-module dispatch is the design that works.
- **`wokwi-capacitor` "unverified"**, **`wokwi-neopixel` "unverified"**, **LDR "part id
  unverified"**. The first two were verified to exist; the LDR genuinely has no matching element.
  The corrected facts are now in the catalog with reasons.
- **Defaulting `simulator.supported` to `false`.** A catalog entry that names a part id is asserting
  the mapping; `layout.ts` now defaults from the presence of the id and only an explicit `false`
  overrides it.

### 8.1 Lessons from the second pass (do not re-learn these the hard way)

- **"A behaviour-matching brief" is not enough to select the right parts.** "two line sensors"
  selects ONE instance unless a `FEATURE_RULES` entry in
  `src/modules/project-understanding/heuristics.ts` emits the quantity (`ir_sensors`) — the
  hardware-planner rule already consumed it, nothing produced it. When a behaviour needs N of a
  part, check BOTH ends of the quantity pipeline.
- **Never write a negation in a harness prompt.** "There is no display" selects the OLED —
  `FEATURE_RULES` patterns are keyword-based (`/\bdisplay\b/`). Say "feedback is by LEDs and the
  buzzer only" instead.
- **The compile harness's `unique-constants` check scans every `const` declaration text-wide,
  including function locals.** Two `const uint32_t now = millis();` in different functions FAIL
  the check (and would trip a reviewer). Convention: function-local `now` is a plain
  `uint32_t now = millis();`, as in access-control.
- **A fix verified only on the USB-powered repro can silently not cover the battery case**
  (§2.12). When a power change is "verified", name the supply topology you verified with. The
  §7 power-honesty scenario now pins the battery case permanently.
- **Feature/negative detection asymmetry**: `needsPersistentStorage()` fires on ANY credential
  word (safe/lock/pin/code/access) + key input + lock, so a no-EEPROM lock build is reachable
  only by wording that avoids the whole credential vocabulary — see the `safe-no-eeprom` case
  comment for the exact word list.

---

## 9. Reference: the access-control firmware as built

States: `STATE_IDLE`, `STATE_GRANTED` (1.5 s), `STATE_OPEN` (relock on door close, or 8 s auto-relock
when there is no door switch), `STATE_DENIED` (1.5 s, red slow flash), `STATE_ALARM` (3 failures →
10 s lockout, red fast flash + pulsed 1200 Hz tone + countdown), `STATE_CHANGE_OLD` /
`STATE_CHANGE_NEW` / `STATE_CHANGE_SAVE` (hold `*` for 2 s from IDLE: verify current → enter new
(≥ `PIN_MIN_LENGTH`) → repeat → save).

Keypad: matrix scan, `#` submits, `*` clears, hold-`*` changes the PIN. Key release-waits are bounded
(3 s) and call `stepLock()` so the servo keeps moving while the scanner waits.

Persistence: EEPROM address 0 = magic `0xA7`, length byte, digits. Validated on load (magic, length
range, digit range) else falls back to `defaultPin()` (`"1234"` trimmed to the minimum length) and
warns. `EEPROM.begin(64)` / `commit()` are inside `#if defined(ESP32)`. Without `EEPROM.h` in the
library manifest the sketch uses a compiled-in PIN **and says so in its header notes**.

Servo: `LOCKED_ANGLE`/`UNLOCKED_ANGLE` parsed from the brief (default 0/90), `SERVO_STEP_DEGREES = 2`,
`SERVO_STEP_INTERVAL_MS = 12`, driven to LOCKED first thing in `setup()`. Both angle constants are
emitted even for the relay path (they act as logical markers there, with `LOCK_ACTIVE_LOW = true`).

Relay: `setLockTarget()` maps angle → level; `lockIsUnlocked()` reads the level back through
`LOCK_ACTIVE_LOW`.

Indicators: `driveLeds(LedMode red, LedMode green)` with `LED_OFF/ON/SLOW_FLASH/FAST_FLASH`; a single
LED becomes `statusLed` (mirrors red OR green); any further LEDs are `extraLeds` and mirror the
alarm line — that is what keeps every assigned pin driven.

Buzzer: passive → `tone()`/`noTone()` scheduled by `toneUntil`; active → `digitalWrite`.
`metadata.active !== true` means passive.

Display: OLED 4 rows (lock state / prompt / masked PIN / door+lock status) or LCD1602 2 rows (row 1
merges prompt and mask); `DISPLAY_ROWS` clamps `showLine()` so a 1602 never writes rows 2–3. Masked
PIN always renders from `enteredLength` and only ever shows `*`. Without a display the UI goes to
serial as `ui:<state>`.

I²C init is shared (`i2cBusInitLines()` in `managed-blocks.ts`): on a remappable core
(`profile.i2cRemappable`, currently ESP32) it emits `Wire.begin(PIN_…_SDA, PIN_…_SCL)`; on AVR
`Wire.begin()` takes no argument, so it emits a runtime guard that warns if the pin plan put the bus
anywhere other than the board's hard-wired A4/A5. That guard is also what makes the I²C pin
constants "used" for the harness check.

Telemetry (1 Hz, or on demand): `status:{"state":"…","locked":true,"door":"closed","attempts":0,"angle":90}`
(`angle` only for a servo lock). Console replies are `ok:…` / `warn:…` / `err:…`. Commands: `?` and
`S` force a frame, `L` forces lock. The dashboard contract is derived from this text, not from a
parallel heuristic — keep it that way.

---

## 10. Reference: the line-follower firmware as built

States: `STATE_STOPPED` (motors off, boot state), `STATE_RUNNING` (following),
`STATE_LINE_LOST` (both sensors off for longer than `LINE_LOST_GRACE_MS` — motors stopped, LEDs
fast-flash, reported with `warn:line lost - stopped`; recovers automatically when a sensor sees
the line again).

Steering: sensors straddle the line. `decideCommand(leftOnLine, rightOnLine)` returns LEFT when
only the left sensor sees the line, RIGHT when only the right does, FORWARD otherwise. Both off
inside the grace window holds the last steer command (gaps in the tape). Turning is a pivot: the
inner channel brakes, the outer runs at `SPEED_TURN`.

Polarity: `LINE_READS_HIGH` (derived from the catalog's `metadata.activeLevel`; the common
active-LOW reflectance module reads HIGH over black). Mixed-polarity sensor sets are impossible to
configure per-sensor in v1 — detection notes it in the sketch header.

Drive: `CHANNELS[]` from the pin plan (`IN1/IN2`, `IN3/IN4` pairs; `ENA`/`ENB` as PWM when
assigned, `-1` when the jumper is fitted). `setup()` calls `allMotorsStop()` before anything else.

UI: button edge (debounced by deadline) toggles the run; LED on while running, fast-flash when
lost; chirps scheduled by deadline (`toneUntil`/`stepChirps`) for passive or active buzzers.
Telemetry `status:{"state","left","right","command","speed"}` at 1 Hz; commands `?`/`S` (status
frame), `G` (go), `H` (halt), unknown → `err:unknown command`. The dashboard contract derives from
this text via `firmware-signals.ts` — the `incoming == 'G'` idiom is already accepted there.
