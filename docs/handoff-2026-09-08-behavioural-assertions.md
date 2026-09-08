# Handoff — behavioural assertions + emulator-as-test in the fixer loop

**Branch:** `arena/01a081a2-wireup-mvp` (branched from `6693e57` of `main`)
**Date:** 2026-09-08
**Status:** typecheck clean, `verify:firmware` 9/9, `verify:offline` passes, `verify:behavioral` 19/19. Not yet committed at time of writing.

This document records the behavioural-assertion layer built on top of the code-generation fixes
and how to prove it works. Read `docs/handoff-2026-09-08-safe-build-and-quality.md` first for the
environment facts (no Mongo/Bedrock, `npm install` before anything, `g++` present, offline only).

---

## 1. What was built

The fixer loop previously stopped at "it compiles / passes structural validation". Three bugs had
already shipped through that bar:

1. **Dead factory PIN** — a 6-digit brief generated `PIN_MIN_LENGTH = 4` and factory default `"1234"`.
2. **Inverted reset** — a "second button resets the counter" brief ran `pressCount++` on every button.
3. **Miscounted stepper** — a stepper build was mis-detected as a button counter and grew a `pressCount`.

The fix: a checkable assertion layer plus a host-side Arduino emulator used as the test in the loop.

| Piece | Path | What it does |
| --- | --- | --- |
| Types | `src/types/behavioral.ts` | `BehavioralAssertion` (subject/operator/expected/tolerance/scenario), `BehavioralSpec`, `BehavioralCheck`, `BehavioralReport`, `FirmwareTrace`. |
| Derivation | `src/modules/behaviour-evaluator/derive.ts` | Turns the prompt into assertions at decomposition time (same tier as `requirements`/`behaviors`). Reuses the generator's own detectors (`pinLengthFromText`, `wantsCountingBrief`, `wantsResetBrief`) so spec and firmware can't drift. |
| Emulator | `scripts/firmware-shim-runtime/` | An instrumented Arduino core: virtual `millis()`, real pin levels, servo angles, serial capture. Sketches compile with `g++` and **execute** on the host; they emit a `FirmwareTrace`. |
| Emitter | `src/modules/behaviour-evaluator/emitter.ts` | Materialises the artifact, compiles against the runtime shim, plays scripted inputs, runs, parses the trace. |
| Evaluator | `src/modules/behaviour-evaluator/evaluate.ts` | Static proofs (PIN lengths, reset branch, press-counter absence) + runtime checks (telemetry fields after scripted button presses). |
| Validator hook | `src/modules/validator/index.ts` | Runs `evaluateBehavioral` between the rule engine and the Bedrock review; converts failed assertions into `behavioral_assertion_failed` issues. |
| Fixer hook | `src/modules/fixer/strategies.ts` | `behavioral_assertion_failed` case: numeric constants → targeted `patch_code_file` (regex); logic failures → `rerun_stage code` with `force: true`. |
| Forced re-derive | `src/modules/fixer/apply.ts`, `src/modules/orchestrator/context.ts` | `RerunStageChange.force` skips the cheap pin re-sync and regenerates the sketch from the deterministic template. |
| Harness | `scripts/verify-behavioral.ts` | Proves derivation, passing firmware, the three injected bugs being caught, and fixer routing. |

## 2. How the loop now reads

```
validateProject
  ├─ rule engine (structure)          … existing
  ├─ behavioural evaluation           … NEW — static proofs + g++ compile/run + telemetry scan
  └─ Bedrock review (additive)        … existing

fixProject
  └─ planForIssue('behavioral_assertion_failed')
       ├─ pin-min/max-length, default-pin-covers-min → regex patch
       └─ logic failures → rerun_stage code (force) → full deterministic regeneration

orchestrator: validate → fix → re-simulate (the next validate pass re-runs the emulator)
```

Failures are routed as structured input — the issue's `details`/`fixHint` is literally
`assertion X failed: expected Y, got Z`, which the fixer parses back apart (`parseBehavioralFailure`).

## 3. Derived assertions (today)

- **PIN** (brief matches `pin|passcode|password|pass ?code|access code`):
  `pin-min-length`, `pin-max-length`, `default-pin-covers-min`.
- **Counter + reset** (`wantsCountingBrief` ∧ `wantsResetBrief`):
  `counter-has-reset` (static), `counter-resets-to-zero` (runtime: increment ×2 then reset → count 0).
- **Motor/stepper that is not a counter** (`stepper|nema|28byj|a4988|…`, ¬ counting):
  `press-counter-absent` (static), `telemetry-count-absent` (runtime).

The model may add assertions through the generation payload (`requirements.behavioralSpec`),
merged via `normalizeAssertionPayload` / `mergeBehavioralSpecs`.

## 4. Emulator mechanics (read before changing)

- Sketches are C++ (`sketch.ino` + `config.h`). The emitter prepends `#include "Arduino.h"` to the
  `.ino` (mirroring `arduino-cli`), compiles `core.cpp` + the sketch with `g++ -std=gnu++17`, and runs
  the binary with `WIREUP_SCENARIO` / `WIREUP_TRACE_OUT` / `WIREUP_SIM_MS` env vars.
- `scripts/firmware-shim-runtime/` overrides `Arduino.h`/`Servo.h`/`EEPROM.h`; the remaining headers
  are copies of the syntax-only `scripts/firmware-shim/` stubs. **Keep `#undef min`/`#undef max` in
  `core.cpp`** — the Arduino macros break `<algorithm>`.
- Input defaults to `HIGH`; a button press is `LOW` (INPUT_PULLUP). `digitalRead` on a written output
  pin returns the last written level (the toggle-`!digitalRead` idiom depends on this).
- No compiler, or a non-C++ sketch (Micropython) → `runtimeError`; runtime checks are reported
  `skipped` and static checks still run. Validation never throws.

## 5. Proof

```bash
npm run typecheck
npm run verify:firmware      # 9/9 sketches clean (codegen fixes)
npm run verify:offline       # validate → fix loop, Bedrock forced to fail
npm run verify:behavioral    # 19/19 — derivation, passing firmware, 3 injected bugs caught, fixer routing
```

`verify:behavioral` §3 deliberately re-injects the three historical bugs and asserts the evaluator
flags each one (dead PIN → `4`; inverted reset → runtime count `3`; stepper → `pressCount` present).

## 6. Deliberately out of scope

- Sensor-plant simulation (`analogRead` returns 0; no DHT/ultrasonic waveform) — threshold alarms are
  not behaviourally asserted yet, only structurally.
- Keypad matrix driving at runtime — alarm-on-three-wrong-PINs is not yet scripted.
- Surfacing `BehavioralReport` in the UI beyond the validation issues/card that already render.
- `deriveGoal()` still truncates multi-sentence prompts; behavioural derivation reads the full prompt
  + heuristic phrases, so it is unaffected today.
