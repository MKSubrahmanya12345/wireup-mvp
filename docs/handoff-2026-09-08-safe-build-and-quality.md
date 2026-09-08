# Handoff — electronic-safe build, firmware behaviours, and quality fixes

**Branch:** `arena/01a07c4a-wireup-mvp` (branched from `acb3350` of `main`)
**Date:** 2026-09-08
**Status:** all three verification gates pass; working tree committed. Remaining work is listed in §7.

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
npm run verify:firmware               # NEW: generate 8 builds, compile-check every sketch
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
| `scripts/compile-check.ts` | `npm run verify:firmware`: 8 representative prompts → generate → static checks → `g++ -fsyntax-only` |
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

---

## 5. The firmware compile harness (new capability — use it)

`npm run verify:firmware` runs eight prompts through the deterministic pipeline and type-checks each
generated sketch:

```
safe-keypad-servo (Nano, keypad+servo+OLED+buzzer+2 LEDs+door switch)   access-control  pass
safe-relay-buttons (Uno, 4 buttons+relay+LCD1602+passive buzzer)        access-control  pass
led-button-counter (Nano, 2 buttons + LED)                              generic         pass
dht-oled-monitor (Uno, DHT22 + SSD1306 + alarm LED)                     generic         pass
servo-sweep-nano (Nano, SG90 sweep + pause button)                      generic         pass
ultrasonic-alarm (Uno, HC-SR04 + passive buzzer + LED)                  generic         pass
neopixel-esp32 (ESP32, WS2812B strip + button)                          generic         pass
stepper-driver (Uno, 28BYJ-48 + ULN2003 + 2 buttons)                    generic         pass
=== 8/8 sketches clean ===
```

Per case it also asserts: unique constants, `setup()`/`loop()` present, no placeholder text,
balanced braces, and every pin-map constant used.

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
npm run verify:offline               → ✓ all checks passed
npm run verify:firmware              → 8/8 sketches clean (all compile)
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

Before this branch the same prompt produced: no keypad (16 pushbuttons), a button-counter sketch,
`PIN_BUZZER_ACTIVE_5V_1_` (malformed), `power_budget_exceeded` + `dangling_reference`, a Velxio
project with rejected wires, and a dashboard advertising fields the firmware never printed.

---

## 7. Remaining work, in priority order

### 7.1 ~~Velxio board fallback~~ — **DONE (2026-09-08, second commit)**

Both halves landed, verified by `npx tsc --noEmit`, `verify:offline`, `verify:firmware` (8/8) and
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

### 7.2 Validator rules for the pin-plan defects (defence in depth)

The planner and fixer no longer *create* these, but a model-authored pin plan can still contain
them, and nothing currently reports them. Add to `src/modules/validator/rules.ts` (section 5,
"pins") + new codes in `src/types/validation.ts`:

- `duplicate_pin_assignment` — two assignments claiming the same `mcuInstanceId`+`pin` for
  different targets (severity `error`, auto-fixable: drop the later one, mirroring
  `uniqueCodeAssignments()`).
- `analog_only_pin_driven` — an assignment on an input-only ADC pin (Nano/Uno A6/A7) whose direction
  is `output` or whose protocol is not `adc` (severity `error`). The data is already there:
  `profile.pins[].capabilities` / `usablePins` in `mcu-profiles.ts`.
- Consider `uart_pin_used_as_gpio` for D0/D1 when the plan also opens `Serial` on them (the profile
  knows both facts).
- Remember: `AUTO_FIXABLE_CODES` in `rules.ts` decides whether the deterministic fixer will attempt
  it; a new code that is not fixable must still carry a `fixHint`.

### 7.3 Power: two honest improvements left

- **Bulk capacitor placement.** The wiring planner attaches the 1000 µF cap to a rail; the note says
  "across the motor supply". Verify which rail it lands on when the servo is (correctly) on the 5 V
  rail, and make the note match the actual connection — the user's report specifically called out
  "capacitor on wrong rail".
- **Linear-regulator dissipation.** When `supplyVoltage - logicVoltage > 3` and the logic rail load
  is significant, note that the on-board *linear* regulator burns the difference
  (9 V → 5 V at 500 mA ≈ 2 W) and recommend a buck converter or a 5 V supply for the servo.
  Note that the sustained-load sum is deliberately **not** converted between rails: a linear
  regulator passes current through, so `I_in ≈ I_out`. Only a switching regulator would need a
  power-based conversion — if you add one, add it there.

### 7.4 Extend the harness

- Add cases for: ESP32 + I²C OLED (exercises the new `Wire.begin(sda, scl)` path — `i2cRemappable`),
  a relay-only lock with no display, a build with **no** EEPROM library (asserts the graceful
  compiled-in-PIN degradation and its warning note), and a two-motor L298N build (exercises the
  supply rail).
- Wire `verify:firmware` into CI (it needs `g++`; the script already degrades to static checks only
  and says so when no compiler is present).

### 7.5 Not started, worth doing

- The access-control behaviour is the only member of `behaviours/`. The same dispatch pattern fits
  other recognisable structures: line follower, PID temperature controller, RFID door (RC522),
  robot with H-bridge + ultrasonic. Each should be its own module; do not grow `templates.ts`.
- `scripts/repro-safe.ts` and `scripts/compile-check.ts` duplicate ~40 lines of offline bootstrap
  (DNS stub, env vars, `initialProject`). Worth extracting to `scripts/lib/offline.ts`.

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
