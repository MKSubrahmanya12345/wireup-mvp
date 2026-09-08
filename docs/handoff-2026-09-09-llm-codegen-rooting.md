# Handoff — AI-first firmware authoring with a rooting gate

**Branch:** `arena/01a08252-wireup-mvp` (branched from `e2a044b` of `main`)
**Date:** 2026-09-09
**Status:** typecheck clean; `verify:offline`, `verify:firmware` (9/9), `verify:behavioral` (19/19) all pass; new `verify:llm-codegen` passes 32/32 (+2 with `--flag-off`). Committed on this branch.

---

## 1. The problem

The firmware generator was a template dispatcher: `generateSketch()` chose between the access-control
behaviour module (~1,100 lines), a counter mode, and a generic skeleton. Any brief outside those shapes
got a conservative generic sketch — the "template ceiling". The model's only path into the sketch was
`modelPayload.code` from the CALL-1 whole-project spec, which is produced *before* pin planning, so its
pin constants were guesses that `syncPinConstants` had to repair after the fact.

The goal: **AI-first firmware, but rooted.** The model writes behaviour; Wireup keeps ownership of the
hardware context. Certain things stay fixed — the include list, the pin constants, the I2C bus setup —
unless the *plan itself* changes, in which case they are re-derived by the deterministic planners and
the model's logic is re-verified against the new context. The model can never write a pin, an include,
or a peripheral that the plan does not contain.

## 2. What was built

| Piece | Path | What it does |
| --- | --- | --- |
| Rooting gate | `src/modules/code-generator/rooting.ts` | Pure, deterministic assembly + audit of model-authored sketches (below). |
| LLM codegen stage | `src/modules/code-generator/llm.ts` | Grounded prompt builder (SKETCH_PERSONA + exact pin table + BOM + software plan + JSON contract), tolerant zod schema for the plan, the Bedrock provider (`op: 'codegen'`), and the injectable `SketchPlanProvider` type. |
| Shared static analysis | `src/modules/code-generator/quality.ts` | `stripForAnalysis` / `braceBalance` / `assessCodeQuality` / `looksLikePinConstant` / `normalizeConstantName` moved out of `index.ts` (re-exported from `index.ts` for the validator/fixer imports). |
| Generator integration | `src/modules/code-generator/index.ts` | `generateCode` is now **async** and AI-first: provider → root → audit; on any rejection it falls through to the CALL-1 `modelCode` path, then the deterministic template. Emits `llm_call_started/completed/failed` events with `op: 'codegen'` and reports every repair/warning as artifact notes. |
| Pipeline | `src/modules/orchestrator/pipeline.ts` | Passes `prompt` + the Bedrock provider + `onLlmCall` (records into the project's `llm.calls`), persists the llm patch at the code stage. |
| Fixer path | `src/modules/orchestrator/context.ts`, `src/modules/fixer/apply.ts`, `src/modules/fixer/index.ts` | The `code` refresher is async and uses the same AI-first path on `rerun_stage code` (including forced behavioural regenerations). `applyChanges` is async; refresher results may be promises. |
| Env | `src/lib/validation/env.ts`, `.env.example` | `WIREUP_ENABLE_LLM_CODEGEN` (default **true** — inert without Bedrock), `BEDROCK_CODEGEN_MODEL_ID` per-role override. |
| Bedrock | `src/lib/bedrock/client.ts`, `src/types/project.ts` | New op `'codegen'` in `BedrockOp` and `LlmCallRecord.op`; `resolveModel` resolves the override. |
| Harness | `scripts/verify-llm-codegen.ts` (+ `pnpm verify:llm-codegen`) | Canned providers prove every rooting rule offline; happy-path sketch is compiled against `scripts/firmware-shim` with `g++ -fsyntax-only`. |

## 3. The rooting contract (what stays fixed, and when it may change)

The model returns a **plan**, not a file: `{ constants, globals, setup, loop, functions, notes }` where
`setup`/`loop` are bodies (no braces of their own). `rootLlmSketch` then assembles the sketch:

```
banner comment
managed includes block        ← buildIncludesBlock(libraries, esp32)   — Wireup's
managed pin map block         ← buildPinMapBlock(assignments, profile) — Wireup's
model constants               ← reconciled (below)
model globals                 ← sanitised
void setup() { Serial.begin + I2C bus init (deterministic) + model body }
void loop()  { model body }
model helper functions        ← sanitised
```

Sanitisation applied to every model section (`sanitizeModelSection`):

1. **`#include` lines are stripped** — the managed block is the only include source.
2. **Pin declarations are reconciled** (`reconcileConstants`, same logic in-section):
   - name equals a planned constant → dropped (the managed block already declares it — value wins even
     if the model wrote a different number);
   - pin-looking name that uniquely matches one assignment → **aliased**
     (`const int BUTTON_PIN = PIN_PUSHBUTTON_1_1;`), so the model's own references keep working without
     owning the value;
   - pin-looking name that matches nothing → **fatal**: hallucinated pin, sketch rejected.
3. **Raw pin literals rewritten**: `digitalWrite(5, …)` becomes `digitalWrite(PIN_LED_1_A, …)` when 5 is
   a planned literal (ambiguous or unplanned numbers are left with a `[verify]` note; `LED_BUILTIN` is
   allowed).
4. **Structure**: missing `Serial.begin` is inserted; the deterministic I2C bus init lines
   (`i2cBusInitLines` — remapped `Wire.begin(SDA, SCL)` on ESP32-class boards) are prepended; brace
   imbalance is repaired by appending closers, or rejected when over-closed; a section that defines its
   own `setup()`/`loop()` is rejected.

`auditRootedSketch` re-checks the **assembled file** independently: quality gate, managed pin block
byte-exact against `pinConstantMap(assignments)`, no pin-looking declaration outside the managed block,
no include outside the managed block that the plan or toolchain doesn't provide, no raw unknown pin
literals. Verdict `rooted` or `rejected` — rejected means the deterministic template is used and the
reasons land in the event log and artifact notes.

The "unless it restricts future context" property: the managed blocks are a pure function of the current
plan state. A later fix that moves a pin (or the future follow-up-edit pipeline) re-derives the blocks
and re-runs the sync/audit passes over the existing sketch — the model's logic is re-verified against
whatever the new context is, never the other way around.

## 4. Order of preference for the sketch source

1. **Rooted model plan** (`WIREUP_ENABLE_LLM_CODEGEN=true` + provider + prompt present) — `generatedBy: 'model'`.
2. **CALL-1 `modelCode`** (legacy whole-file path, unchanged, incl. quality gate + brace repair).
3. **Deterministic template** — the artifact always exists.

Every path then runs the same deterministic passes: `ensureIncludesBlock` → `ensureLibraryIncludes` →
`ensurePinMap` → `syncPinConstants` → `applyFirmwareHygiene`.

## 5. How to prove it (offline, no Mongo / no Bedrock / no network)

```bash
npm install --no-audit --no-fund        # ~20 s; use --prefer-online if the registry 404s a fresh version
npx tsc --noEmit
npm run verify:llm-codegen              # 32 checks: rooting rules + g++ compile of the rooted sketch
WIREUP_ENABLE_LLM_CODEGEN=false npm run verify:llm-codegen -- --flag-off   # flag provably disables the stage
npm run verify:offline                  # deterministic fallback intact end-to-end
npm run verify:firmware                 # 9/9 template sketches still compile
npm run verify:behavioral               # 19/19 behavioural assertions intact
```

`verify:llm-codegen` covers: good plan (kept as model output, managed block exact, raw literal
rewritten, compiles), hallucinated `RELAY_PIN` (rejected → template, name absent from sketch), matchable
`BUTTON_PIN` (aliased to the planned constant), hijacked `PIN_LED_1_A = 13` (dropped, plan value 5
wins), foreign `#include <FastLED.h>` (stripped), contract-violating plan (rejected), failing provider
(honest note, template), throwing provider (degrades, never crashes), and no provider (byte-identical
old behaviour).

With real Bedrock configured, the only change users should notice: the run log shows a `codegen`
llm-call event, and sketches for briefs outside the template shapes are now genuinely model-authored —
with every repair visible as `[rooted] …` / `[verify] …` / `[model] …` lines in the artifact notes.

## 6. Deliberately left undone (next steps)

- **Real compilation inside the pipeline loop** (the "3" of the roadmap): the rooting gate is static; a
  g++/`arduino-cli` gate would catch undeclared identifiers the audit cannot see. The harness already
  proves the shim path works on rooted sketches, so wiring it into the validator is the natural next
  branch.
- **Behavioural assertions in the codegen prompt**: `deriveBehavioralSpec(prompt, analysis)` could be
  rendered into the prompt so the model writes against the exact checks it will be held to (the persona
  already references the contract).
- **Fixer-path `onLlmCall` plumbing**: codegen calls inside `rerun_stage code` are visible in the event
  log but are not appended to the project's `llm.calls` array (only the pipeline path is).
- **`reviewProject`-style grounded re-check** of the model plan before assembly is possible but was
  judged redundant: the rooting gate is deterministic and stricter than a model review.
