# Wireup

**Prompt → wired hardware project.**

Wireup is an agentic engineering platform for embedded hardware. You describe a
project in plain language ("a Bluetooth RC car with two DC motors and an
ultrasonic obstacle sensor"), and an agent pipeline turns that prompt into a
complete, validated, simulator-ready build:

* real components selected **only** from a seeded catalog (the model may not
  invent hardware),
* a hardware plan with power budget and compatibility reasoning,
* a pin map and a wiring graph,
* `sketch.ino` firmware whose pin constants are generated from the pin map,
* `libraries.json`, `diagram.json` (machine readable, Wokwi-adaptable) and a
  step-by-step `instructions.md`,
* deterministic + model validation, and a **targeted** fix loop that patches the
  existing project (never regenerates it), with every version frozen as a
  revision.

Everything is persisted in MongoDB, including a per-project event log that the
UI polls, so what you watch on screen is exactly what the backend did.

---

## Contents

1. [Quickstart](#quickstart)
2. [Configuration](#configuration)
3. [How a project is built](#how-a-project-is-built)
4. [Everflow — the project graph and goal loop](#everflow--the-project-graph-and-goal-loop)
5. [Module map](#module-map)
6. [Component catalog](#component-catalog)
7. [Artifacts](#artifacts)
8. [Validation and the targeted fix loop](#validation-and-the-targeted-fix-loop)
9. [Event log and live UI](#event-log-and-live-ui)
10. [HTTP API](#http-api)
11. [Data model](#data-model)
12. [Error handling and degraded operation](#error-handling-and-degraded-operation)
13. [Repository layout](#repository-layout)
14. [Design rules this codebase follows](#design-rules-this-codebase-follows)
15. [Known limitations](#known-limitations)

---

## Quickstart

Requires Node ≥ 20.11, [pnpm](https://pnpm.io) ≥ 9 and a reachable MongoDB.

```bash
pnpm install                 # install dependencies
cp .env.example .env         # then fill in MONGODB_URI + Bedrock settings
pnpm diagnose:bedrock        # env → DNS → TLS → a real Converse call, in that order
pnpm seed                    # write the component catalog into MongoDB
pnpm dev                     # http://localhost:3000
```

Other scripts:

| Script | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server on **Turbopack** — the fastest dev loop; use it unless you hit a Turbopack-specific problem |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm seed` | Idempotent catalog upsert. `-- --dry-run` validates only, `-- --reset` wipes the collection first, `-- --force` seeds despite integrity problems |
| `pnpm dev:webpack` | Same dev server on the classic webpack pass. Slower to compile (watcher also covers `external/`) — kept as the fallback for Turbopack-specific problems |
| `pnpm diagnose:bedrock` | Walks configuration → DNS → TLS → a real Bedrock `Converse` call and stops at the first failure with the exact thing to check. Exits 0 only when a round trip succeeds |
| `pnpm verify:offline` | Runs the real pipeline, validator and fixer with `*.amazonaws.com` DNS forced to fail, and asserts the project is still complete and the outage is reported honestly. Needs no credentials, no MongoDB and no network |
| `pnpm verify:llm-codegen` | Proves the AI-first codegen rooting gate offline with canned model plans (good, hallucinated pin, aliased pin, hijacked constant, foreign include, contract breach, provider failure); the happy-path sketch is compiled against the firmware shim. `WIREUP_ENABLE_LLM_CODEGEN=false … --flag-off` also proves the flag disables the stage |
| `pnpm verify:workbench` | Proves the firmware workbench loop offline: the compile gate, chat turns (applied with revision + diff, answer-only, rooting refusal, compile-fail repair round), manual saves (pin-drift repair, broken-save refusal), and the validator surfacing `firmware_compile_error` |
| `pnpm verify:simulator` | Proves the registry ↔ Velxio simulator link offline: every catalog `supported: true` claim maps to a part the vendored Velxio build actually renders and simulates, every exporter board kind is a real `BoardKind`, the simulation-registry table matches the vendored source, and a synthetic board + all 53 supported peripherals project end-to-end with zero dropped parts or wires. Needs no credentials, no MongoDB and no network |
| `pnpm export:cad-catalog` | Writes `external/velxio/frontend/public/cad-catalog.json` — the CAD spec (dimensions, body style, every pin's millimetre anchor) for all 108 catalog parts, keyed by the same key the Velxio exporter places them under |
| `pnpm export:cad-models` | Writes the 3D assets for every catalog key into `external/velxio/frontend/public/models3d/<key>/`: a GLB (named pin-anchor nodes) plus printable `.stl` and `.ascii.stl` exports and a `spec.json`. Idempotent, and a reviewed asset is never overwritten |
| `pnpm verify:cad-link` | Proves the registry ↔ CAD link: all 108 catalog parts resolve to a spec, every catalog pin has a matching CAD anchor, and the tier counts the admin studio shows match the files on disk |
| `pnpm verify:cad-sim-link` | Proves the two halves agree: every catalog part is allocated to exactly one tier (simulated or CAD bench), the key spaces are disjoint, every catalog key is asset-complete (GLB + STL + spec), pin anchors sit inside their own generated mesh, and a board + every CAD-bench part + a simulated partner projects end-to-end with **zero dropped wires** |

`WIREUP_AUTOSEED_COMPONENTS=true` (the default) also seeds the catalog on first
use if the collection is empty, so the app is runnable before you ever call
`pnpm seed`. If MongoDB is unreachable, the bundled catalog is used as an
in-process fallback and `/api/health` reports the degradation.

> There is no authentication and nothing is cached: **every submission creates a
> brand new project document**, even for an identical prompt.

---

## Configuration

Everything comes from the environment — no credential, model id or tunable is
hardcoded. `.env.example` documents each variable; the validated shape lives in
`src/lib/validation/env.ts`.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI`, `MONGODB_DB` | Database connection and name (default db `wireup`) |
| `AWS_REGION` | Bedrock region |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Optional static credentials; otherwise the AWS SDK default credential chain is used (IAM role, profile, …) |
| `BEDROCK_MODEL_ID` | Model for generation (base model id or inference-profile ARN) |
| `BEDROCK_VALIDATION_MODEL_ID`, `BEDROCK_FIXER_MODEL_ID` | Optional per-role overrides, otherwise the main model is reused |
| `BEDROCK_MAX_TOKENS`, `BEDROCK_TEMPERATURE`, `BEDROCK_TOP_P`, `BEDROCK_TIMEOUT_MS`, `BEDROCK_MAX_RETRIES` | Inference configuration for the shared client |
| `WIREUP_MAX_FIX_ITERATIONS` | Cap on validate → fix → re-validate loops (default 3) |
| `WIREUP_ENABLE_LLM_FIXER` | Allow the model to propose a changeset when deterministic fixes are not enough |
| `WIREUP_ENABLE_LLM_VALIDATION` | Run the critical model review in addition to the rule engine |
| `WIREUP_ENABLE_LLM_CODEGEN` | AI-first firmware authoring: the model writes the sketch logic against the grounded pin plan and the rooting gate keeps the managed blocks authoritative (default on; inert without Bedrock; falls back to the deterministic template on any violation) |
| `WIREUP_ENABLE_FIRMWARE_COMPILE` | Host compile gate: the sketch is type-checked against the stub Arduino core (g++/clang++) before a revision is frozen — generation, fixes and workbench edits all pass through it. Skipped honestly when no compiler is on PATH |
| `WIREUP_AUTOSEED_COMPONENTS` | Seed the catalog into MongoDB when the collection is empty |
| `WIREUP_MAX_REVISIONS`, `WIREUP_MAX_EVENTS` | Storage caps per project document |
| `WIREUP_LOG_LEVEL` | Structured server log verbosity |

---

## How a project is built

```
USER PROMPT
   │
   ├─ project-understanding ── goal, inputs/outputs, behaviours, constraints,
   │                            quantities, features, assumptions, ambiguities
   ├─ components (catalog)  ── retrieval + strict matching against the seeded
   │                            database; unknown parts are rejected, not invented
   ├─ hardware-planner      ── architecture blocks, subsystems, signal flow,
   │                            compatibility checks, power budget, risks
   ├─ pin-planner           ── MCU-profile aware pin map (capabilities,
   │                            reservations, conflicts)
   ├─ wiring-planner        ── connection graph: power, ground, signal edges,
   │                            wire colours, explanations, conflict report
   ├─ software-planner      ── modules, control states, sensor/actuator logic,
   │                            communication command set, safety, loop strategy
   ├─ code-generator        ── sketch.ino (+ extra files). AI-first: the model
   │                            authors the behavioural logic against the
   │                            grounded pin plan, and the rooting gate
   │                            assembles it with machine-managed include +
   │                            pin-map blocks; violations (invented pins,
   │                            foreign includes) fall back to the
   │                            deterministic template
   ├─ libraries-generator   ── libraries.json + install commands
   ├─ diagram-generator     ── diagram.json (layout, pin anchors, routed wires)
   ├─ instructions-generator── instructions.md + bill of materials
   │
   ├─ validator ──────────── deterministic rule engine (+ optional model review)
   │        │  issues with stable codes, targets and fix hints
   │        ▼
   └─ fixer ──────────────── typed changeset applied to the EXISTING project,
            │                dependent artifacts re-derived, revision frozen
            └── loop until passed or WIREUP_MAX_FIX_ITERATIONS is reached
```

Project status moves `intake → pending → running → validating ⇄ fixing →
completed | completed_with_warnings | failed`, and the stage field tracks the
step currently executing (`understanding`, `catalog`, `generating`, `hardware`,
`pins`, `wiring`, `software`, `code`, `libraries`, `diagram`, `instructions`,
`validating`, `fixing`).

Before the pipeline there is **phase 0 — the doubt session** (`intake` status,
default for `POST /api/projects`): the agent sketches the smallest useful
graph and lists the questions that actually matter — each with a *decider*
(you / the agent / the agent with your veto), a consequence and a proposed
default. Answers are folded into the prompt of every pipeline model stage; a
skipped doubt becomes a recorded **assumption**, never a silent guess
(`mode: "direct"` skips the session for one-shot builds).

After finalisation the project enters the **everflow loop** (below) — the
agent keeps iterating on the graph until its goals are met or parked behind
asks you can answer.

Revision **v1** is the initial generation; **v2+** are targeted fixes. Each
revision freezes a snapshot (components, pin assignments, wiring, code, diagram,
libraries, instructions) plus the changeset that produced it, so the UI can show
exact diffs instead of "something changed".

---

## Everflow — the project graph and goal loop

The layer that makes the agent *everflowing*: the project is a graph of nodes
— intent, claims, assumptions, decisions, goals, artifacts, evidence, tasks —
and **every node carries a completion goal**. After every pass, code (not the
model) judges each goal; a goal that is unmet with no task working on it is
**dangling** and is reported, not hidden. The agent is `done` only when every
non-waived goal is satisfied and nothing dangles.

The human is a tool in the loop, reached through **two columns that are never
merged**:

1. **AI needs you** — asks the agent filed (verify a behaviour in the
   simulator, confirm an assumption, choose how to apply your idea). Each ask
   has a *default-on-expiry*, so the agent never blocks on you.
2. **You add to AI** — information the agent cannot have (ideas, corrections,
   parts you own, where the device lives). Registered as facts on the next
   pass; a design change needs your explicit *apply*, which rebuilds the
   project as a new, diff-able revision.

The live view is the **Everflow tab** of the project hub: the graph canvas
(every node's goal state at a glance, click a node for its evidence), the
two-column human channel, and the completion ribbon with the rendered project
brief. The first pass runs automatically when generation finalises; more
passes run on demand (`POST …/everflow/continue`) and are bounded by
`WIREUP_EVERFLOW_MAX_PASSES`.

Messy briefs (often dictated) are expanded at intake into a global project
document — clean goal, platform, implied components with quantities,
behaviours, assumptions and open questions — shown in the doubt session and
folded into the build. The agent also has a **research tool**: per node it
checks the component catalog, a bundled docs corpus (cited) and, optionally,
the live web (flagged for your review), recording findings as cited evidence.
It never invents — no source, no finding.

Full design, invariants and the verification harness:
[`docs/everflow-architecture.md`](docs/everflow-architecture.md) · `pnpm verify:everflow`.

---

## Module map

| Path | Responsibility |
| --- | --- |
| `src/modules/project-understanding/` | Prompt → structured requirements. Heuristic extraction (quantities, features, platform hints) plus the model call; `formatAnalysisForPrompt` feeds the generation prompt |
| `src/modules/components/` | The component database: `catalog.ts` (bundled seed + integrity check), `schema.ts` (zod definition schema), `service.ts` (retrieval, strict matching, MCU profiles, catalog cache), `context.ts` (catalog text for prompts), `seed/*` (108 parts) |
| `src/modules/hardware-planner/` | Architecture, subsystems, signal flow, `compatibility.ts`, `power.ts` (rail/load budget), `defaults.ts`, plus `refreshHardwarePlan` for fix-driven re-planning |
| `src/modules/pin-planner/` | `mcu-profiles.ts` (pin capabilities, reserved/input-only/ADC/PWM pins) and assignment with rationale |
| `src/modules/wiring-planner/` | Connection graph generation, `conflicts.ts` detection, `extendWiringPlan` for fixes |
| `src/modules/software-planner/` | Firmware architecture: modules, control states, logic, communication command set, safety, loop strategy, file plan |
| `src/modules/code-generator/` | `templates.ts` (deterministic firmware skeleton) and `index.ts` (model output normalisation, pin-map/include marker blocks, entry point selection) |
| `src/modules/libraries-generator/` | `libraries.json` + per-manager install commands |
| `src/modules/diagram-generator/` | `layout.ts` (grid layout, pin anchors, wire routing), `index.ts` (`diagram.json`), `wokwi.ts` (projection to the Wokwi format with honest skip reporting) |
| `src/modules/simulation/` | `velxio-key.ts` (the single source of truth for which key a catalog part occupies in the simulator, and which parts have no element at all), `velxio-project.ts` (`.vlx` generator: board, simulated parts, `cad-bench-<catalogId>` CAD bench parts and their wires), `vlx-sync.ts` (canvas → diagram reverse sync), `velxio-parts.ts` (the checked `supported: true` claim table) |
| `src/modules/instructions-generator/` | `instructions.md`, sections and bill of materials |
| `src/modules/validator/` | `rules.ts` (deterministic engine, the source of engineering truth), `llm.ts` (critical review that may add but never remove engine findings), `index.ts` |
| `src/modules/fixer/` | `strategies.ts` (deterministic change planning per issue code), `llm.ts` (model changeset), `codePatch.ts` (surgical firmware edits), `apply.ts` (apply + re-derive dependent artifacts), `index.ts` |
| `src/modules/orchestrator/` | `pipeline.ts` (stage execution with fallbacks), `revisions.ts` (freezing), `persistence.ts` (writes + event flushing), `context.ts`, `index.ts` (`runGeneration`, `startGeneration`, `isRunning`) |
| `src/modules/everflow/` | `intake.ts` (doubt session: deterministic seeds + LLM merge + context), `materialize.ts` (state → graph, stable ids), `evaluate.ts` (deterministic goal judge + dangling detection + brief), `continuation.ts` (planner + bounded pass runner), `index.ts` (orchestrated entry points) |
| `src/lib/bedrock/` | Single reusable client: `client.ts` (`converse`, model resolution, retries, timeouts, token usage, `describeBedrockConfig`), `structured.ts` (JSON extraction + zod parse + repair), `prompts.ts`, `operations.ts` (the only place prompts are built) |
| `src/lib/mongodb/` | `client.ts` (connection + typed connection errors), `projects.ts` (state, events, LLM calls, stalled-project recovery), `components.ts` (catalog reads/upserts with seed fallback) |
| `src/lib/logging/` | `logger.ts` (structured logs, `describeError`), `events.ts` (agent event log with sequence cursor and sinks) |
| `src/lib/validation/` | `env.ts`, `schema.ts` (zod schemas for every artifact), `json.ts`, `ids.ts`, `time.ts` |
| `src/types/` | The canonical type registry (`component`, `wiring`, `validation`, `diagram`, `project`, `generation`) |
| `src/app/api/` | HTTP surface (see below) |
| `src/app/`, `src/components/` | The two pages and the workspace UI |

---

## Component catalog

The catalog is the ground truth for hardware. The model receives a formatted
excerpt of it and its selections are matched **strictly** against it; a part that
is not in the catalog is rejected (and the fixer replaces it with the closest
real match) rather than passed through.

105 parts are seeded, across 13 categories:

| Category | Parts |
| --- | --- |
| microcontroller (4) | `esp32-devkit-v1`, `arduino-uno-r3`, `arduino-nano`, `arduino-mega` |
| motor (16) | `dc-motor-generic-6v`, `servo-motor-sg90`, `servo-motor-mg996r`, `stepper-28byj48-uln2003`, `stepper-motor-nema17`, `servo-motor-mg90s`, `servo-continuous-fs90r`, `n20-gear-motor-encoder`, `fan-5v-40mm`, `fan-12v-4pin-pwm`, `blower-fan-5v-radial`, `bldc-motor-2205-2300kv`, `bldc-motor-2212-1000kv`, `vibration-motor-coin-3v`, `water-pump-5v-submersible`, `peristaltic-pump-12v` |
| motor_driver (12) | `l298n-motor-driver`, `l293d-motor-driver`, `tb6612fng-motor-driver`, `a4988-stepper-driver`, `drv8833-motor-driver`, `bts7960-motor-driver`, `drv8825-stepper-driver`, `tmc2209-stepper-driver`, `uln2003-darlington-array`, `mosfet-module-irf520`, `pca9685-servo-driver`, `esc-30a-bldc` |
| other (2) | `propeller-5045-tri-blade`, `propeller-ep-1045-two-blade` |
| actuator (11) | `linear-actuator-12v-100mm`, `solenoid-12v-push-pull`, `solenoid-valve-12v-water`, `led-5mm`, `rgb-led-common-cathode`, `buzzer-active-5v`, `buzzer-passive`, `relay-module-5v-1ch`, `neopixel-ws2812b-strip`, `led-ring-ws2812-8`, `led-matrix-ws2812-8x8` |
| sensor (19) | `dht11-temperature-humidity`, `dht22-temperature-humidity`, `hc-sr04-ultrasonic`, `pir-sensor-hc-sr501`, `ir-obstacle-sensor`, `ldr-photoresistor`, `soil-moisture-sensor`, `mpu6050-imu`, `bme280-environmental`, `ds18b20-temperature`, `bh1750-light-sensor`, `ina219-current-sensor`, `ir-receiver-tsop38238`, `load-cell-hx711`, `mq-2-gas-sensor`, `ntc-thermistor-module`, `tilt-sensor-module`, `gps-neo6m-module`, `rtc-ds3231-module` |
| communication (4) | `hc-05-bluetooth`, `hc-06-bluetooth`, `esp32-bluetooth-wifi-capability`, `esp8266-esp01-wifi` |
| power (11) | `battery-2s-lipo`, `battery-9v`, `battery-holder-4xaa`, `breadboard-power-module-mb102`, `regulator-lm7805`, `regulator-ams1117-3v3`, `buck-converter-lm2596`, `logic-level-shifter-4ch`, `diode-1n4007`, `diode-1n4148`, `diode-1n5819` |
| passive (5) | `resistor-220ohm`, `resistor-1kohm`, `resistor-10kohm`, `capacitor-100nf-ceramic`, `capacitor-1000uf-electrolytic` |
| input_device (9) | `pushbutton-6mm`, `keypad-4x4-membrane`, `potentiometer-10k`, `slide-potentiometer-10k`, `dip-switch-8`, `rotary-encoder-ky040`, `toggle-switch-spdt`, `limit-switch-microswitch`, `joystick-module-2axis` |
| prototyping (2) | `breadboard-830`, `jumper-wires-kit` |
| display (6) | `lcd-1602-i2c`, `oled-ssd1306-i2c`, `lcd-2004-i2c`, `seven-segment-1digit`, `led-bar-graph-10`, `tft-ili9341-28` |
| discrete (4) | `transistor-2n2222`, `mosfet-2n7000`, `mosfet-irf540`, `optocoupler-pc817` |

Each definition carries pins (name, type, direction, required, electrical
ratings), power/ground pin lists, voltage and current ranges, library
requirements, simulator hints and metadata. **Values are only stated where they
are actually known** — the seed helper derives `pinTypes`, `powerPins` and
`groundPins` from the pin list so an entry cannot disagree with itself, and
`checkCatalogIntegrity()` (run by `pnpm seed`) fails on duplicate ids, unnamed
pins, duplicate pin names or electrical parts with no power/ground pin.

Extend the catalog by adding an entry to a `src/modules/components/seed/*.ts`
file (or by inserting into MongoDB) and re-running `pnpm seed` — every planner
reads through the same service, so new parts become available everywhere at
once.

---

## Artifacts

| Artifact | Shape | Notes |
| --- | --- | --- |
| Firmware | `artifacts.code.files[]` with `path`, `language`, `content`, `purpose`, `generatedBy` (`model` \| `planner` \| `fixer`) | Entry point is `sketch.ino`. Contains a marked pin block (`// >>> WIREUP PIN MAP >>> … <<<`) with `PIN_<INSTANCE_ID>_<PIN_NAME>` constants and a marked include block, both re-derived from the pin plan so code and wiring can never drift apart |
| Libraries | `artifacts.libraries` → `libraries.json` | Library name, import header, manager, version, purpose, `builtIn` flag, plus ready-to-run install commands |
| Diagram graph | `artifacts.diagram` → `wireup-diagram.json` | Internal simulator-agnostic graph: components with unique ids + pin anchors, connections, rails, groups, layout and stats. This is not a Wokwi file. |
| Wokwi diagram | `GET /api/projects/:id/diagram?target=wokwi` → `diagram.json` | Actual Wokwi contract: `version: 1`, `author`, `editor: "wokwi"`, `parts[]` (`type`, `id`, `top`, `left`, `attrs`) and tuple `connections[]`. No Wireup-only fields are emitted. |
| Instructions | `artifacts.instructions` → `instructions.md` | Ordered sections, bill of materials, estimated build time |

The internal graph is simulator-agnostic; it is deliberately not named or downloaded as
Wokwi `diagram.json`. `GET /api/projects/:id/diagram?target=wokwi` projects it into the
real Wokwi format and reports exactly which parts/wires could not be represented and why —
no silent drops. Wokwi output is always generated by the deterministic adapter, never by
asking the model to invent a second diagram schema.

### Every catalog part is carried — simulated or CAD-only

A Wokwi `diagram.json` can only contain parts the target simulator really has. The Velxio
target goes further: a part the emulator has no element for is **not dropped**. It is placed
on the canvas and the 3D bench as a **CAD bench part** — its real body and its real
millimetre pin anchors, drawn from `external/velxio/frontend/public/cad-catalog.json`, with
its wires routed exactly as planned — and it is labelled as what it is: a physical part
whose electronics are not simulated. It is never substituted with a lookalike element,
because that would wire the firmware to pins the real part does not have.

`GET /api/projects/:id/diagram?target=wokwi` reports both sets separately: `cadBench[]`
(kept, CAD-only) and `skippedParts[]` (genuinely absent, e.g. a custom board type the
standalone Wokwi format cannot name), and the `/simulation` page says the same thing on
screen. The `.vlx` the canvas receives carries the tier in the id (`cad-bench-<catalogId>`)
so the canvas, the 3D scene and the reverse sync all agree without a lookup table.

---

## Validation and the targeted fix loop

**Validation** runs a deterministic rule engine first — it owns engineering truth
— and optionally a critical model review that may confirm, extend or refute
findings but can never delete an engine issue. Output: `passed`, per-check
results, and issues with a stable `code`, `severity`, `domain`, `message`,
optional `target` (artifact / instance / pin / connection / file / library /
section), `fixHint`, `autoFixable` and `origin` (`rules` | `model`). If
validation itself cannot run (Bedrock failure, malformed model output), the
reason is recorded in `engineError` and the engine results are still returned.

35 issue codes drive the fixer, e.g. `gpio_conflict`, `reserved_pin_used`,
`input_only_pin_driven`, `motor_on_mcu_pin`, `unknown_pin`, `floating_required_pin`,
`missing_ground`, `invalid_voltage`, `power_budget_exceeded`, `code_pin_mismatch`,
`code_unbalanced_braces`, `library_missing`, `diagram_out_of_sync`,
`requirement_uncovered`, `duplicate_instance_id`, `model_review`.

**Fixing is surgical.** The fixer plans a typed changeset (18 operations, e.g.
`set_pin_assignment`, `add_connection`, `replace_component`, `patch_code_file`,
`add_library`, `patch_instructions`, `rerun_stage`), applies it to the existing
project, and re-derives only the dependent artifacts in a fixed order
(pins → wiring → code → libraries → diagram → instructions). Firmware is edited
through anchored patches (marker blocks, `find_replace`, include insertion) —
never rewritten from scratch. Every change is recorded with its id, artifact,
reason, origin and the issue it addresses; rejected changes are recorded too.
The result is frozen as a new revision, and the loop repeats until validation
passes or the iteration cap is reached (then the project completes with
warnings, or fails if errors remain).

---

## Event log and live UI

Every meaningful step is appended to a persisted event log with a monotonically
increasing `seq` per project: `type`, `status` (`started` | `completed` |
`failed` | `info`), human-readable `message`, `timestamp`, `stage`, `durationMs`
and structured `metadata`. Events are batched to MongoDB (~700 ms flush) and
capped by `WIREUP_MAX_EVENTS`.

**Page 1 — `/`**: a minimal prompt form. Submitting creates the project
(`POST /api/projects`), starts generation in the background and navigates to
`/project/[id]`. Three example prompts are provided as one-click fills.

**Page 2 — `/project/[id]`**: a VS Code style workspace.

* **Left pane — agent console**: one line per persisted event (sequence number,
  clock time, type, stage, duration, expandable raw metadata), a text filter,
  follow-tail autoscroll that stops interfering once you scroll up, and the real
  poll timestamp.
* **Right pane — result cards**, in order: `PROJECT`, `COMPONENTS`, `WIRING`,
  `CODE`, `DIAGRAM`, `INSTRUCTIONS`, `VALIDATION`, `AGENT`. Cards appear as soon
  as their artifact exists (staged delivery); before that they show a loader
  whose label and detail line come from the stage actually running.
  * `WIRING` renders an SVG graph **derived from the wiring structure** (nodes
    and edges computed from the connection list, coloured by wire/kind, with
    filters, conflict table and net list) — nothing is hardcoded per project.
  * `CODE` has file tabs, hand-written tokenisers for Arduino/C++, JSON and
    Markdown, real line numbers, copy and download, plus a `libraries.json` view.
  * `DIAGRAM` renders the layout from `diagram.json` and can project to Wokwi.
  * `AGENT` shows revisions v1 → vN, each changeset, a computed diff against the
    previous revision, the stage timeline and every model call with token usage.

The client polls `GET /api/projects/:id/events?after=<seq>` on a self-scheduling
timer (1.1 s baseline, exponential backoff to 8 s on errors) and refetches the
full project when the revision changes or the run reaches a terminal status.
Polling stops at `completed`, `completed_with_warnings` or `failed`.

---

## HTTP API

All routes are Node runtime, `force-dynamic`, and return an envelope:
`{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, message, details?, retryable? } }`.

| Method & path | Response |
| --- | --- |
| `POST /api/projects` | Body `{ prompt (8–4000 chars), name?, mode: "everflow"\|"direct" }` → `201 { project, started, intake? }`; `everflow` (default) opens the doubt session, `direct` runs generation in the background |
| `POST /api/projects/:id/intake/answer` | Body `{ answer: { doubtId, value?, via }, answers?: […] }` → `{ project, openDoubts }`; `via: "skipped"` records an assumption; `409` outside intake |
| `POST /api/projects/:id/build` | Body `{ rebuild? }` → starts the build (unanswered doubts become assumptions); `rebuild` on a finished project files a new revision (`replanned_after_human_input`); `409` while running |
| `GET /api/projects/:id/everflow` | Live materialised graph + goal evaluation + doubts + both human-channel columns + the project brief |
| `POST /api/projects/:id/everflow/respond` | Body `{ taskId, value, note? }` → answer an AI→human ask; `409` when the ask is already closed |
| `POST /api/projects/:id/everflow/inject` | Body `{ type: note\|idea\|correction\|resource, text, title? }` → file a human→AI addition |
| `POST /api/projects/:id/everflow/continue` | Run another continuation pass now (bounded, idempotent) |
| `GET /api/projects?limit=N` | `{ projects: […summaries], count }` |
| `GET /api/projects/:id` | `{ project, running }`; `404 not_found` when unknown |
| `GET /api/projects/:id/events?after=SEQ` | `{ events, latestSeq, status, stage, revision, running, terminal }` |
| `GET /api/projects/:id/diagram?target=wireup\|wokwi` | wireup: `{ diagram }`; wokwi: `{ diagram, skippedParts, skippedConnections, warnings }`; `409 diagram_not_ready` before the diagram exists |
| `GET /api/health` | `{ ok, status: ready\|degraded, mongo, catalog, bedrock, agent, notes }`; `503` when degraded |

---

## Data model

Two Mongoose models (`src/models/`):

* **`components`** — catalog definitions keyed by `id` (upserted by the seed
  script).
* **`projects`** — one document per submission holding requirements, component
  selections, hardware plan, pin assignments, wiring, software plan, all four
  artifacts, the latest validation result, the revision history (each with a
  snapshot and its changeset), the event log, iteration counters and the model
  call log — plus the everflow state: the doubt session (`doubts`,
  `intakeContext`), the two-directional human channel (`humanTasks`) and the
  last materialised graph + evaluation (`everflow`).

`src/lib/mongodb/projects.ts` exposes `createProjectRecord`, `getProjectState`,
`listProjectStates`, `getProjectEvents(id, after)`, `saveProjectState`,
`appendEvents`, `recordLlmCall`, `markProjectFailed`, `findStalledProjects` and
`deleteProject`.

Generation runs inside the server process that accepted the request, so a
restart or crash can orphan a half-built project. `src/modules/orchestrator/recovery.ts`
handles that: on the next project or event read, a project that is non-terminal,
has no in-process owner and has not been written to for 15 s is marked `failed`
with a retryable `run_interrupted` error, and a real event is appended so the
console explains why it stopped. The UI therefore never polls forever.
`findStalledProjects()` is available for a bulk sweep.

---

## Error handling and degraded operation

* **Bedrock** — every stage has a deterministic fallback. If the model is not
  configured, times out, is throttled or returns malformed JSON, the failure is
  logged as an event, recorded in the project notes / LLM call log, and the
  pipeline continues from the catalog and planners. Structured output is
  extracted leniently (fenced blocks, leading prose) and validated with zod;
  unparseable output degrades to the deterministic path rather than throwing.
* **Bedrock unreachable** — `classifyError` walks the whole `cause` chain, so a
  wrapped transport failure (`ERR_HTTP2_STREAM_CANCEL` caused by
  `getaddrinfo EAI_AGAIN …`) is reported as `code: EAI_AGAIN`, marked retryable
  and retried `BEDROCK_MAX_RETRIES` times with backoff. The message names the
  host that could not be reached and says plainly that credentials and model
  access were never evaluated. Run `pnpm diagnose:bedrock` to find out which
  layer broke.
* **Half-broken DNS (IPv6 `EAI_AGAIN`)** — Windows behind a VPN, WSL with a
  generated `/etc/resolv.conf` and Docker's embedded resolver often answer the
  A (IPv4) query but fail the AAAA (IPv6) one. Node's default `verbatim` order
  turns that into a hard, retry-immune `EAI_AGAIN` against a perfectly healthy
  endpoint. Wireup therefore defaults to `WIREUP_DNS_RESULT_ORDER=ipv4first`
  and applies it before the first socket is opened, so the workaround survives
  a new terminal and covers `next dev` as well as the scripts. Set `verbatim`
  to restore Node's default or `ipv6first` where IPv6 is the healthy path; an
  explicit `NODE_OPTIONS=--dns-result-order=…` always wins. `pnpm
  diagnose:bedrock` prints the active order and flags an AAAA-only failure as
  harmless.
* **Output cut off by the token budget** — Bedrock signals a completion clipped
  by `maxTokens` with `stopReason: "max_tokens"`. The text is a valid *prefix*,
  so it can never parse, and retrying with the same budget reproduces it byte
  for byte. The structured caller detects that specific stop reason, doubles the
  budget up to `BEDROCK_MAX_TOKENS_CEILING`, and tells the model it was cut off
  rather than malformed. At the ceiling it stops instead of burning further
  calls and reports `output_truncated` naming the budget to raise.
* **Unresolved blocking issues** — a run that finishes with blocking validation
  errors ends as `completed_with_errors` (a red badge and a `failed` final
  event), not `completed_with_warnings`. Every issue the fixer could not repair
  is emitted as a `not repaired — <reason>` console event.
* **MongoDB** — connection failures raise a typed `MongoConnectionError`, are
  mapped to `503`/`retryable` API errors, and catalog reads fall back to the
  bundled seed.
* **Malformed model output** — zod schemas gate every artifact; validation raises
  `schema_violation` and the fixer repairs the specific field instead of
  rebuilding the project.
* **Runaway loops** — `WIREUP_MAX_FIX_ITERATIONS`, `WIREUP_MAX_REVISIONS`,
  `WIREUP_MAX_EVENTS` and a per-round cap on model-proposed changes (12) bound
  the work; hitting the cap completes with warnings or fails loudly.
* **Interrupted runs** — a project left non-terminal by a server restart/crash is
  recovered on the next read (`run_interrupted`, retryable) with an explanatory
  console event, instead of polling forever.
* **Frontend** — polling errors surface in the console header and back off;
  route errors render `src/app/error.tsx` with a pointer to `/api/health`;
  unknown ids render `not-found.tsx`.

---

## Repository layout

```
scripts/seed-components.ts        catalog seeder (validates before writing)
src/types/                        canonical types (component, wiring, diagram,
                                  validation, project, generation)
src/lib/validation/               env + zod schemas + json/id/time helpers
src/lib/logging/                  structured logger + agent event log
src/lib/mongodb/                  connection, project store, catalog store
src/lib/bedrock/                  reusable client, structured output, prompts
src/lib/http.ts                   API envelope helpers
src/models/                       Mongoose schemas
src/modules/                      the pipeline (one directory per module)
                                  + everflow/ (graph, goals, intake, passes)
src/app/api/                      HTTP routes
src/app/                          pages: /, /project/[id] (+everflow, parts,
                                  wiring, diagram, simulation, firmware, guide,
                                  quality, log), error, not-found
src/components/                   PromptForm + workspace (console, cards,
                                  syntax highlighting, polling hook)
                                  + everflow/ (graph canvas, doubt session,
                                  two-column human channel)
```

---

## Design rules this codebase follows

* **The catalog is the only source of hardware.** Unknown parts are rejected and
  replaced, never passed through.
* **Fixes patch, they do not regenerate.** Revisions preserve every previous
  version; artifacts are never silently overwritten.
* **No fake precision.** Unknown electrical values stay absent; the Wokwi
  projection lists what it could not represent; validation reports what it could
  not check.
* **No fake progress.** Loaders and the console reflect real stages, real events
  and real durations.
* **No caching of results.** Each prompt creates a new project document.
* **Derived, not hardcoded.** The wiring graph, diagram layout, pin constants and
  bill of materials are all computed from the structured plan.
* **Module separation.** Each pipeline concern lives in its own module with a
  narrow interface; prompts are built only in `src/lib/bedrock/operations.ts`.
* **Goals are judged by code.** A goal is satisfied by a passed check or a
  positive human answer — never by model confidence. Dangling nodes (unmet
  goal, no task) are reported, not hidden, and the agent never blocks on a
  human: every ask carries a default-on-expiry.
* **Strict TypeScript**, pnpm only, no authentication, no code execution or
  simulator runs — Wireup plans and generates, it does not flash hardware.

---

## Known limitations

* The agent does not compile or upload firmware, and does not execute Wokwi
  simulations; `diagram.json` and the Wokwi projection are produced for you to
  run.
* Parts the pinned Velxio build has no element for are carried as **CAD bench
  parts** — real shape, real pin anchors, wires drawn, no electrical model. They
  are reported as such on the canvas, in the 3D view and on `/simulation`; they
  are never swapped for a lookalike that would simulate but would not match the
  real part.
* Model quality depends on the configured Bedrock model; with Bedrock disabled
  the deterministic path still produces a complete, internally consistent
  project, but the design is more conservative. On the firmware stage the
  model authors only the behavioural logic of the sketch — pin constants,
  includes and bus setup are re-derived from the plan on every generation,
  and a plan that violates the rooting contract (invented pins, foreign
  includes, broken structure) is rejected in favour of the deterministic
  template. The firmware workbench chat needs Bedrock; the editor, the
  compile gate and manual saves work without it. On the firmware stage the model
  authors only the behavioural logic of the sketch — pin constants, includes
  and bus setup are re-derived from the plan on every generation, and a plan
  that violates the rooting contract (invented pins, foreign includes, broken
  structure) is rejected in favour of the deterministic template.
* The event log is polled (not streamed over a socket) by design, so the UI
  latency is bounded by the poll interval.
* Everflow's loop is offline-complete: intake, materialisation, goal
  evaluation and the planner all run with no model and no network. The LLM
  only *adds* doubts at intake and powers the pipeline the loop iterates on;
  with Bedrock disabled the loop still converges (and still asks humans for
  what it cannot prove).
* Catalog coverage is finite by construction: a project needing a part that is
  not seeded will be reported as an uncovered requirement rather than invented.
l be reported as an uncovered requirement rather than invented.
