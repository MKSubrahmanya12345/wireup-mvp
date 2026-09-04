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
4. [Module map](#module-map)
5. [Component catalog](#component-catalog)
6. [Artifacts](#artifacts)
7. [Validation and the targeted fix loop](#validation-and-the-targeted-fix-loop)
8. [Event log and live UI](#event-log-and-live-ui)
9. [HTTP API](#http-api)
10. [Data model](#data-model)
11. [Error handling and degraded operation](#error-handling-and-degraded-operation)
12. [Repository layout](#repository-layout)
13. [Design rules this codebase follows](#design-rules-this-codebase-follows)
14. [Known limitations](#known-limitations)

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
| `pnpm dev` | Next.js dev server |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm seed` | Idempotent catalog upsert. `-- --dry-run` validates only, `-- --reset` wipes the collection first, `-- --force` seeds despite integrity problems |
| `pnpm diagnose:bedrock` | Walks configuration → DNS → TLS → a real Bedrock `Converse` call and stops at the first failure with the exact thing to check. Exits 0 only when a round trip succeeds |
| `pnpm verify:offline` | Runs the real pipeline, validator and fixer with `*.amazonaws.com` DNS forced to fail, and asserts the project is still complete and the outage is reported honestly. Needs no credentials, no MongoDB and no network |

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
   ├─ code-generator        ── sketch.ino (+ extra files) with a pin-constant
   │                            block derived from the pin plan
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

Project status moves `pending → running → validating ⇄ fixing →
completed | completed_with_warnings | failed`, and the stage field tracks the
step currently executing (`understanding`, `catalog`, `generating`, `hardware`,
`pins`, `wiring`, `software`, `code`, `libraries`, `diagram`, `instructions`,
`validating`, `fixing`).

Revision **v1** is the initial generation; **v2+** are targeted fixes. Each
revision freezes a snapshot (components, pin assignments, wiring, code, diagram,
libraries, instructions) plus the changeset that produced it, so the UI can show
exact diffs instead of "something changed".

---

## Module map

| Path | Responsibility |
| --- | --- |
| `src/modules/project-understanding/` | Prompt → structured requirements. Heuristic extraction (quantities, features, platform hints) plus the model call; `formatAnalysisForPrompt` feeds the generation prompt |
| `src/modules/components/` | The component database: `catalog.ts` (bundled seed + integrity check), `schema.ts` (zod definition schema), `service.ts` (retrieval, strict matching, MCU profiles, catalog cache), `context.ts` (catalog text for prompts), `seed/*` (51 parts) |
| `src/modules/hardware-planner/` | Architecture, subsystems, signal flow, `compatibility.ts`, `power.ts` (rail/load budget), `defaults.ts`, plus `refreshHardwarePlan` for fix-driven re-planning |
| `src/modules/pin-planner/` | `mcu-profiles.ts` (pin capabilities, reserved/input-only/ADC/PWM pins) and assignment with rationale |
| `src/modules/wiring-planner/` | Connection graph generation, `conflicts.ts` detection, `extendWiringPlan` for fixes |
| `src/modules/software-planner/` | Firmware architecture: modules, control states, logic, communication command set, safety, loop strategy, file plan |
| `src/modules/code-generator/` | `templates.ts` (deterministic firmware skeleton) and `index.ts` (model output normalisation, pin-map/include marker blocks, entry point selection) |
| `src/modules/libraries-generator/` | `libraries.json` + per-manager install commands |
| `src/modules/diagram-generator/` | `layout.ts` (grid layout, pin anchors, wire routing), `index.ts` (`diagram.json`), `wokwi.ts` (projection to the Wokwi format with honest skip reporting) |
| `src/modules/instructions-generator/` | `instructions.md`, sections and bill of materials |
| `src/modules/validator/` | `rules.ts` (deterministic engine, the source of engineering truth), `llm.ts` (critical review that may add but never remove engine findings), `index.ts` |
| `src/modules/fixer/` | `strategies.ts` (deterministic change planning per issue code), `llm.ts` (model changeset), `codePatch.ts` (surgical firmware edits), `apply.ts` (apply + re-derive dependent artifacts), `index.ts` |
| `src/modules/orchestrator/` | `pipeline.ts` (stage execution with fallbacks), `revisions.ts` (freezing), `persistence.ts` (writes + event flushing), `context.ts`, `index.ts` (`runGeneration`, `startGeneration`, `isRunning`) |
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

51 parts are seeded, across 11 categories:

| Category | Parts |
| --- | --- |
| microcontroller (3) | `esp32-devkit-v1`, `arduino-uno-r3`, `arduino-nano` |
| motor (5) | `dc-motor-generic-6v`, `servo-motor-sg90`, `servo-motor-mg996r`, `stepper-28byj48-uln2003`, `stepper-motor-nema17` |
| motor_driver (4) | `l298n-motor-driver`, `l293d-motor-driver`, `tb6612fng-motor-driver`, `a4988-stepper-driver` |
| sensor (9) | `dht11-temperature-humidity`, `dht22-temperature-humidity`, `hc-sr04-ultrasonic`, `pir-sensor-hc-sr501`, `ir-obstacle-sensor`, `ldr-photoresistor`, `soil-moisture-sensor`, `mpu6050-imu`, `mq-2-gas-sensor` |
| communication (4) | `hc-05-bluetooth`, `hc-06-bluetooth`, `esp32-bluetooth-wifi-capability`, `esp8266-esp01-wifi` |
| actuator (6) | `led-5mm`, `rgb-led-common-cathode`, `buzzer-active-5v`, `buzzer-passive`, `relay-module-5v-1ch`, `neopixel-ws2812b-strip` |
| display (2) | `lcd-1602-i2c`, `oled-ssd1306-i2c` |
| input_device (2) | `pushbutton-6mm`, `potentiometer-10k` |
| power (9) | `battery-2s-lipo`, `battery-9v`, `battery-holder-4xaa`, `breadboard-power-module-mb102`, `regulator-lm7805`, `regulator-ams1117-3v3`, `buck-converter-lm2596`, `logic-level-shifter-4ch`, `diode-1n4007` |
| passive (5) | `resistor-220ohm`, `resistor-1kohm`, `resistor-10kohm`, `capacitor-100nf-ceramic`, `capacitor-1000uf-electrolytic` |
| prototyping (2) | `breadboard-830`, `jumper-wires-kit` |

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
| Diagram | `artifacts.diagram` → `diagram.json` | `version`/`format`, meta (title, platform, controller instance, simulator target, units, grid size), components with unique ids + layout box + pin anchors, connections with `from`/`to` refs, kind, signal, wire colour and optional routed path, rails, groups, layout size and stats. All references are validated against real instance/pin names |
| Instructions | `artifacts.instructions` → `instructions.md` | Ordered sections, bill of materials, estimated build time |

`diagram.json` is simulator-agnostic. `GET /api/projects/:id/diagram?target=wokwi`
projects it into the Wokwi format and reports exactly which parts/wires could not
be represented and why — no silent drops.

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
| `POST /api/projects` | Body `{ prompt (8–4000 chars), name? }` → `201 { project, started: true }`; generation runs in the background |
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
  call log.

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
src/app/api/                      HTTP routes
src/app/                          pages: /, /project/[id], error, not-found
src/components/                   PromptForm + workspace (console, cards,
                                  syntax highlighting, polling hook)
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
* **Strict TypeScript**, pnpm only, no authentication, no code execution or
  simulator runs — Wireup plans and generates, it does not flash hardware.

---

## Known limitations

* The agent does not compile or upload firmware, and does not execute Wokwi
  simulations; `diagram.json` and the Wokwi projection are produced for you to
  run.
* Model quality depends on the configured Bedrock model; with Bedrock disabled
  the deterministic path still produces a complete, internally consistent
  project, but the design is more conservative.
* The event log is polled (not streamed over a socket) by design, so the UI
  latency is bounded by the poll interval.
* Catalog coverage is finite by construction: a project needing a part that is
  not seeded will be reported as an uncovered requirement rather than invented.
