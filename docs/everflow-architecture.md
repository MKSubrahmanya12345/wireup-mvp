# Everflow — the project graph and the goal loop

Everflow is the layer that makes Wireup's agent *everflowing*: it is given the
basis of project completion — a graph of nodes, each with a **completion goal**
— and it keeps iterating until every goal is satisfied, parked behind a named
task, or explicitly waived. The human is part of the toolchain, reached
through **two separate channels** that are never merged into one chat.

```
                      ┌────────────────────────────────────────────┐
                      │            THE PROJECT GRAPH               │
                      │  intent · claims · assumptions · goals     │
                      │  decisions · artifacts · evidence · tasks  │
                      │  every node carries a completion goal      │
                      └───────▲──────────────────────────┬─────────┘
                              │ goals judged by CODE     │ per unmet goal the
                              │ (never by the model)     │ planner names a move
                              ▼                          ▼
      ┌─────────────────────────────────────┐   ┌─────────────────────────────┐
      │  HUMAN CHANNEL — two columns        │   │  CONTINUATION PASSES        │
      │                                     │   │  (bounded, idempotent,      │
      │  1 · AI NEEDS YOU                   │◄──┤   persisted, recorded)      │
      │     asks the agent filed. It can    │   └──────────────▲──────────────┘
      │     never close these alone; each   │                  │
      │     carries a default-on-expiry, so │                  │ rebuild = new revision
      │     the agent never blocks on you   │                  │ from an applied addition
      │                                     │                  │
      │  2 · YOU ADD TO AI                  │──────────────────┘
      │     information the agent cannot    │
      │     have. Registered as facts; a    │
      │     design change needs your        │
      │     explicit "apply"                │
      └─────────────────────────────────────┘
```

## Research base

Everflow composes patterns that were studied before building:

- **Goal mode** (Claude Code `/goal`, Codex, Hermes, OpenClaw): a completion
  condition plus a plan→act→test→review loop until it is met or the budget is
  exhausted. Measurable goals work; the loop ends on goal, budget or manual
  stop — never silently.
- **Humans as tools** (HumanLayer): human contact channels are integrated into
  the agent's toolchain as feedback sources, not just approval gates. A human
  ask carries a *request*, a *pause-until-outcome*, and a *response back into
  the loop* — with controls over what may be asked and what happens on timeout.
- **Durable interrupt/resume** (LangGraph `interrupt()` / `Command(resume=…)`):
  the agent pauses at named checkpoints and resumes when the outside world
  (a human) answers. Wireup's equivalent is the persisted task: the project
  record holds the ask, the server never waits in a call, and the next pass
  resumes from the stored state.
- **Durable goal objects** (Cursor goal-mode writeups): a goal is a contract,
  not a prompt — objective, completion criteria, lifecycle state, evidence
  trail, budgets. Prompt-based autonomy stops early; a recorded goal with a
  deterministic judge does not.
- **Goal decomposition**: intent → sub-goals with acceptance criteria → DAG.
  The graph is the decomposition; the evaluator walks it.
- **Humans as tools** applied to *information*, not just approval: the agent
  can also *consult documentation* (its research tool) and the human can feed
  it information it cannot have — both flow through the same persisted,
  cited, reviewable record.

## The graph

Types live in `src/types/everflow.ts`. Nodes:

| Kind | Source | Completion goal |
| --- | --- | --- |
| `intent` | the prompt / requirement goal | always active — the root |
| `claim` | a requirement the model asserts | requirement covered |
| `assumption` | a guess (intake skip, model assumption) | **human confirmed** — a guess is never silently a fact |
| `doubt` | an open intake question | doubt answered |
| `decision` | controller pick, library, frozen revision | evidence attached |
| `goal` | a behavioural promise, the validation verdict, the artifact set | behaviour proven / validation clean / artifacts exist |
| `evidence` | a passed validation check, a human answer | evidence attached |
| `task` | a human-channel task (owner `ai` or `human`) | task resolved |
| `artifact` | every workspace file (code, diagram, libraries, instructions) | artifact exists |

Edges carry the relation (`part_of`, `supports`, `produces`, `verified_by`,
`contradicts`, `derived_from`) so the UI and the evaluator can trace *why* a
node exists and *what* proves it.

**Materialisation** (`src/modules/everflow/materialize.ts`) is deterministic:
same project state, same graph — stable ids (`ev-intent`,
`ev-goal-behaviour-<id>`, `ev-art-<path-slug>`, …) so tasks, evidence and
selections survive re-materialisation. The graph is a *projection* of the
project; it is never the source of truth for the build.

## Goals and the evaluator

Every node declares its goal (`criterion` + `kind` + current `state`).
`evaluateEverflow` (`src/modules/everflow/evaluate.ts`) re-judges every node
**by code, against the project state** — the model never says a goal is met:

- `behaviour_proven` — satisfied when a `behavioral.<id>` validation check
  passed, or a linked human answer is positive (`isPositiveResponse`: the
  task's positive-options whitelist, else the default yes-set; anything else
  on a verify ask counts as *not yet*).
- `validation_clean` — no open blocking issues.
- `artifact_exists` — the workspace file is present.
- `human_confirmed` — a positive human answer exists; otherwise the node is
  `blocked_human`, and **if no open task works on it, it dangles**.
- `doubt_answered`, `evidence_attached`, `requirement_covered` — the
  mechanical twins.

A node is **dangling (`openEnd`)** when its goal is unmet *and* no task and no
next action works on it. `openEnd` is only reported for goal/claim/artifact/
assumption nodes (a doubt parked by design is not a bug); a project is
**`done`** only when every non-waived goal is satisfied and nothing dangles.
`completion` = satisfied / (total − waived); `blockedOnHuman` = no AI-actionable
work remains. The rendered **brief** (`evaluation.brief`) is the global project
document — goal, graph summary, dangling work, open asks — the context bundle
the UI's Everflow tab leads with.

## The planner and the passes

`planContinuation` (`src/modules/everflow/continuation.ts`) is pure: same
state + evaluation, same plan. Per pass it:

1. Files a **verify** ask (AI→human, boolean, `lookAt` = the simulator,
   default-on-expiry `defer`) for each unproven behaviour goal without an open
   task.
2. Consolidates unconfirmed assumptions into **one context ask**
   (default-on-expiry `assume` — the assumption stands and stays visible).
3. Files a **review** ask when blocking validation issues survived the fixer
   (default-on-expiry `halt`).
4. **Processes** human→AI additions: the agent claims them (`processed`);
   `idea`/`correction`/`resource` get a follow-up **choose** ask —
   *"Apply to the build?"* with the options `Apply — replan as a new
   revision` / `Note only, keep the current design`. Applying triggers a
   rebuild (new revision, `replanned_after_human_input`); noting registers the
   fact without touching the design. A plain `note` needs no follow-up.

Idempotency is a contract: a goal with an open task never gets a duplicate.
The task budget (`WIREUP_EVERFLOW_MAX_HUMAN_TASKS`) parks extras *without
filing* — visible, counted, described in the pass record.

`runEverflowPass` materialises, evaluates, **acts** (see below), plans,
persists (tasks + graph + evaluation + act-phase ledger + an `everflow_pass`
event) and reports whether it **progressed**.
`continueEverflow` runs passes until done, blocked-only-on-humans, or no
progress — bounded by `WIREUP_EVERFLOW_MAX_PASSES` so a looping state can never
spin the server. The first pass runs automatically when generation finalises
(orchestrator → dynamic `import('@/modules/everflow')`), so the loop starts
without any human prompting.

## The act phase — the loop's own engineering moves

The planner files asks; the **act phase does the work the loop can do
itself**. It runs inside every pass, after the evaluation and *before* the
planner — so a human is asked only for what the loop could not close by code.
Both runners (legacy and StateGraph) execute the identical phase; the graph
runner walks `materialize → evaluate → foldSteers → act → plan → idea →
research → persist`, and `pnpm verify:graph` asserts that path and the
runners' equivalence.

Three moves, in order (`src/modules/everflow/actions.ts`):

| Move | Fires when | What it runs | Guard |
| --- | --- | --- | --- |
| `revalidate` | the **design fingerprint** (prompt, requirements, components, hardware plan, pins, wiring, artifacts) drifted since the validation the loop last observed — a canvas sync, a ladder repair, an applied addition — or a finished design has no validation on record | the deterministic rule engine (`validateProject`, engine-only: the model review belongs to the build) | fingerprint; only finished designs (`completed*`) are ever acted on |
| `reprove` | behavioural promises are unproven (no passed `behavioral.<id>` check) **and** the firmware/spec fingerprint drifted | the behavioural evaluator — static proofs plus the host-shim emulator — merged into the validation via the same `behavioralFindings` helper the validator uses | fingerprint + `WIREUP_EVERFLOW_MAX_REPROOFS` |
| `repair` | blocking issues remain whose **issue signature** the loop has not already tried | the existing deterministic fixer (the idea ladder's `repairNode` mechanics: changeset applied, dependents re-derived, **revision frozen**, revalidated) | signature (an identical set is never retried) + `WIREUP_EVERFLOW_MAX_REPAIRS` + the revision cap |

The wiring this completed: the evaluator and materialiser judge
`behaviour_proven` goals from per-assertion `behavioral.<id>` validation
checks — which the validator never used to write (only issues plus one
aggregate check), so a promise the emulator had *already proven at build
time* could never satisfy its goal and always became a human verify ask. The
validator now emits those checks through the shared `behavioralFindings`
helper, and the act phase merges with the exact same function, so a mid-loop
emulator re-run writes precisely what the build-time validator would.

**Bookkeeping** (`state.everflow.actions`, optional so older documents stay
valid): the two fingerprints, the last repair signature, the two budget
counters and a capped history of `EverflowActionRecord`s — every move,
including skips and failures, is recorded and emitted as an `everflow_move`
event; a repair that changes the design freezes a revision like every other
design change (nothing is silent). The first pass *seeds* the fingerprints
from the state it finds: the pipeline's fresh validation is trusted as the
baseline, and a blocking-issue set the build's own fix loop just exhausted is
recorded as already-attempted — new evidence (drift) is what unlocks a loop
repair, never a blind retry.

Invariant check: goals are still judged **by code** (moves consume the
deterministic engine, evaluator and fixer — no model is ever asked whether a
goal is met); every move is **offline-complete** (engine-only, host-shim,
deterministic strategies); moves are **idempotent and bounded** (fingerprints
guard repeats, budgets backstop them); the agent still **never blocks on a
human** — acting first is what makes the asks that remain genuinely
human-shaped; and human input still changes design **only via explicit
apply** — the act phase repairs the agent's own work, never folds an
addition into the build.

`WIREUP_ENABLE_EVERFLOW_ACTIONS=false` restores the ask-only loop exactly.
Proofs: `pnpm verify:everflow` section 8 (seed/stability, drift →
revalidate, prove-by-code → no verify ask, fresh issue set → budgeted repair
with a frozen revision, flag off, every planner guard) and `pnpm
verify:graph` (the act node in the path + runner equivalence).

## The two columns — never one chat

| Column | Direction | What flows | Rule |
| --- | --- | --- | --- |
| **AI NEEDS YOU** | `ai_to_human` | asks the agent filed (verify / choose / test / review / context) | each has a default-on-expiry — the agent **never blocks** on a human; the record shows what will happen on timeout |
| **YOU ADD TO AI** | `human_to_ai` | notes, ideas, corrections, resources — information the agent cannot have | registered as facts on the next pass; **design changes require the human's explicit apply** — the agent never self-modifies the goal to please an input |

Both live on the project record (`state.humanTasks`), so the conversation
survives restarts and is inspectable in the run log.

## Intake — the doubt session (phase 0)

`POST /api/projects` with `mode: "everflow"` (the default) creates the project
in status **`intake`** and runs `startIntake`:

1. `deriveDeterministicDoubts` — no model needed: controller (blocking when no
   platform named; a veto when a weak hint exists), power (motor loads without
   a stated supply), how it will be driven, who it is for, what you own.
2. The LLM may add doubts it sees; `mergeIntakeDoubts` de-duplicates by topic
   and caps the session (≤ 6 doubts, ≤ 3 blocking).
3. The UI (the **doubt session**, rendered in place of the normal hub when
   status is `intake`) shows each doubt with its decider, consequence and
   proposed default. Answering stores the fact; **skipping stores an
   assumption** (`via: 'skipped'`) — labelled as a guess everywhere downstream.
4. The answers are folded into the prompt of *every* pipeline model stage via
   `effectivePrompt` (`orchestrator/pipeline.ts`) — the global project document
   that keeps the rest of the build honest.
5. `POST /api/projects/[id]/build` starts the pipeline; unanswered doubts
   become recorded assumptions and the run begins.

`mode: "direct"` (the "skip the doubt session" checkbox) is the one-shot path.

## API surface

| Route | Purpose |
| --- | --- |
| `POST /api/projects` `{ prompt, mode }` | create (`everflow` → intake, `direct` → build now) |
| `POST /api/projects/[id]/intake/answer` | answer (or skip) a doubt |
| `POST /api/projects/[id]/build` `{ rebuild? }` | start the build; `rebuild` = new revision from an applied addition |
| `GET /api/projects/[id]/everflow` | live materialised graph + evaluation + doubts + both channel columns |
| `POST /api/projects/[id]/everflow/respond` | answer an AI→human ask |
| `POST /api/projects/[id]/everflow/inject` | file a human→AI addition |
| `POST /api/projects/[id]/everflow/continue` | run another continuation pass on demand |

## Invariants (what must never regress)

- A goal is satisfied **by code or by a positive human answer** — never by the
  model's confidence.
- A guess is never a silent fact: skips become `assumption` nodes that dangle
  until confirmed.
- The agent never blocks on a human: every ask has a default-on-expiry, and
  the loop parks work instead of waiting.
- Passes are idempotent and bounded; re-running them files no duplicates.
- The graph is a projection: breaking it can never break the build, and the
  build's artifacts stay canonical.
- Adding information never silently changes the design: `apply` is the human's
  explicit act and produces a new, diff-able revision.

## The research tool — the agent checks the docs

The brief demands *tools for the AI to check web/documentation*. That is
`src/modules/everflow/research.ts`, with an honesty ladder:

1. **the component catalog** — live ground truth for anything the project
   actually selected (confidence 0.9);
2. **the bundled docs corpus** (`docs-corpus.ts`) — authored platform and
   library facts, each with a citable source (confidence 0.8). This is what
   makes the tool deterministic and offline: Raspberry Pi, Pi cameras (CSI vs
   USB), OpenCV-for-Python, the face detection→embed→match pipeline, thin
   web-registry services, ESP32, Arduino, HC-SR04, L298N, …;
3. **the live web** (opt-in per call, `WIREUP_ENABLE_WEB_DOCS`) — a snippet
   extracted from the cited page within `WIREUP_WEB_DOCS_TIMEOUT_MS`,
   confidence capped at 0.6 and **always flagged `needsHumanCheck`**.

Findings are *evidence with a citation*: each materialises as an `evidence`
node (`ev-research-…`) with a `verified_by` edge to the node it checked, and
appears in the node inspector with its facts and source link. They **inform —
they never satisfy a goal on their own**; only passed checks or positive human
answers do. When nothing matches (nonsense input included), the tool returns
"no source found" instead of guessing.

Two triggers: automatic (each pass, the planner researches up to two
low-confidence claims/decisions that no finding touches yet — offline sources
only) and manual (the *check the docs* / *+ the web* buttons in the inspector,
`POST /api/projects/:id/everflow/research`).

## Brief expansion — messy voice notes become the global project document

Users often dictate a brief as a voice transcription: typos, cut-off words, no
structure. Intake normalises it into `state.expandedBrief`:

- **with the model** — the intake call also expands: clean goal sentence,
  normalized platform, implied components with quantities (so "multiple corsm"
  becomes *cameras ×?*, "open cv" becomes *OpenCV*), must-do behaviours, the
  assumptions the expansion had to make, and what the brief genuinely leaves
  open;
- **without the model** — `deterministicExpansion` renders what the analyzer
  factually saw and lists what it could not resolve, so the document exists
  from the first poll.

The expanded brief is shown as a card in the doubt session ("the brief,
expanded"), is folded into `intakeContext` when the build starts (so every
pipeline stage sees it), and the doubt seeds know this class of project:
Pi generation (an agent decision with your veto), camera count when the brief
says "multiple" without a number, CSI vs USB cameras, the security policy for
unknown faces, and who may reach the website.

The catalog speaks this class too: `raspberry-pi-5` (with its default I2C /
UART / SPI pins and a 16 mA per-pin honesty note), `raspberry-pi-camera-module`
(CSI connector — no wiring) and `usb-webcam-generic` (USB — no wiring), plus a
Raspberry Pi pin profile. SBC/software code generation (Python services, the
web app itself) is the next build step; classification, doubt session,
research and graphing of these projects are in.

## The original brief, box by box

| From the project notes | Status |
| --- | --- |
| A global project document giving the AI context | ✅ expanded brief + intake answers, folded into every pipeline prompt (`effectivePrompt`) and rendered as the evaluation brief |
| MVP = prompt page → doubt session | ✅ landing → intake status → doubt session UI → build |
| Any project classifiable into a graph | ✅ materialisation; Pi/camera/web class added (platform + features + catalog + doubts) |
| Graph ↔ workspace files | ✅ artifacts materialise from files (node per file, `file.path`); file → node → evidence. Node → file deep-links are the remaining half |
| Graph → links | ✅ edges carry relation + note; `lookAt` links point humans to the simulator/quality/everflow views |
| Maintained via a "Human API" — humans as tools for the AI | ✅ two-directional channel; asks carry defaults-on-expiry so the AI never blocks |
| AI takes technical decisions, asks specific questions | ✅ deciders (`ai` / `ai_with_veto` / `human`) on every doubt; agent decisions are graph nodes |
| AI keeps generating & testing once the initial flow exists | ✅ continuation passes after finalise, per answer, per addition, on demand — bounded and idempotent; autonomous pipeline re-runs remain human-applied |
| Tools for the AI to check web / documentation | ✅ research tool (catalog → corpus → web), cited, never invented, per-node in the inspector |

## Verification

`pnpm verify:everflow` — offline, no Mongo/Bedrock/network — proves: the
doubt layer finds the right forks; materialisation is deterministic; goals are
judged by code and dangling nodes are flagged (including nonsense input); the
planner files the right asks, stays idempotent and respects the budget; a
positive answer satisfies, a negative one does not; injections are processed
with an explicit apply; the persisted pass loop converges on an in-memory
store; and a messy voice brief ("an project with open cv that runs on a
raspberry pi … multiple corsm") is classified, expanded, doubted on the right
forks, and researched with cited evidence — while nonsense gets no finding.
