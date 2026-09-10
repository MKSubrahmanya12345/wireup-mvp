# Ideation — the Idea Graph: recursive expansion, swarm execution, human API

**Status:** research / ideation only — nothing here is built.
**Question answered:** "a person prompts *RC car* — how must the system work, end to end?"
**References:** GPT-6 Astra (OpenAI, 2026-09-03, available on AWS Bedrock), the existing
Everflow layer (`docs/everflow-architecture.md`), the self-learning-graph direction
(`docs/self-learning-graph-architecture.md`).

---

## Part 0 — What already exists (so we don't rebuild it)

The repo is much closer to the concept than "prompt → artifacts". Everflow already has:

| Your concept | Already in the repo |
| --- | --- |
| Graph of the idea | `src/types/everflow.ts` — intent / claim / assumption / doubt / decision / goal / evidence / task / artifact nodes, typed edges, every node carries a **completion goal** |
| Goals judged honestly | `evaluate.ts` — **code judges goals, never the model**; dangling work is flagged; `done` = every non-waived goal satisfied |
| Human as a tool | Two persisted channels: **AI NEEDS YOU** (asks with default-on-expiry → the agent never blocks) and **YOU ADD TO AI** (notes/ideas/corrections; design changes need explicit human `apply`) |
| Main document | `evaluation.brief` — the global project document, plus `expandedBrief` from intake; folded into every stage prompt (`effectivePrompt`) |
| Agent checks docs | `research.ts` honesty ladder: catalog (0.9) → authored corpus (0.8, cited) → live web (0.6, flagged needsHumanCheck) |
| Bounded autonomy | Idempotent continuation passes, `WIREUP_EVERFLOW_MAX_PASSES`, task budget, no silent self-modification |
| Iterate-till-pass | validate → fix → re-validate loop, targeted patches, every version a frozen revision |

**What does NOT exist yet** (the actual build): recursive *level-wise expansion* of the
graph, an *intelligent stopper*, per-node *test specs with iterate-until-pass*, a
*fresh-context reviewer agent*, *swarm execution over subtrees*, a *mechanics branch*,
and the *two-drawer UI*. Astra's mid-turn steering / async tools as the transport for the
right drawer. Everything below designs those.

---

## Part 1 — The flow today: "RC car" through the current system

So the delta is precise, here is what literally happens now:

```
POST /api/projects { prompt: "an RC car with two DC motors and an ultrasonic
obstacle sensor", mode: "everflow" }
│
├─ 0. INTAKE (status: intake)                    everflow/intake.ts
│    deterministic doubts first:
│      • controller      — blocking (no platform named) → Uno? ESP32?
│      • power           — motor loads, no supply stated → battery?
│      • drive method    — phone? website? autonomous?
│    LLM may add doubts; merged, ≤6 total, ≤3 blocking.
│    Answers fold into effectivePrompt. Skips become assumption nodes
│    (labelled guesses everywhere downstream). POST /build starts the run.
│
├─ 1–12. PIPELINE (status: running, one event per stage)   orchestrator/pipeline.ts
│     understanding → catalog (parts matched, nothing invented)
│       → hardware (Uno/Nano/ESP32 + motors + L298N + HC-SR04 + battery;
│                  power budget + compatibility reasoning)
│       → pins (pin map, conflict-free) → wiring (graph)
│       → software (modules, command set, safety states)
│       → code (sketch.ino, pin constants derived from pin map;
│                LLM codegen under the rooting gate)
│       → libraries → diagram (diagram.json, Wokwi-adaptable)
│       → instructions (step-by-step build guide)
│
├─ 13. VALIDATE → FIX LOOP                       status: validating
│     deterministic rule engine + (optional) model review
│     targeted fixes only — never a regenerate; max WIREUP_MAX_FIX_ITERATIONS
│
└─ 14. EVERFLOW TAKES OVER                       status: done?
     graph materialised from the project, goals judged by code,
     continuation passes: file verify-asks for unproven behaviours,
     consolidate assumptions into one context ask,
     process human additions (apply ⇒ new revision),
     research tool cites catalog/corpus/web as evidence.
     Simultaneously: /simulation page + Velxio canvas (:5174) +
     generated dashboard (:5175) with the serial relay, and the
     firmware workbench for chat-time patching.
```

The point of restating it: **the executor half of your vision exists and is
battle-tested.** What you are really adding is a *brain in front of the executor* —
a recursive decomposition layer that turns "RC car" into a deep, tested graph BEFORE
and DURING execution, plus swarm roles and the drawer UI.

---

## Part 2 — The proposed flow: "RC car" through the Idea Graph

### Phase A — Intent → Level 1 (the idea skeleton)

The prompt becomes `L0 intent`. One expansion call (Astra, high effort) produces
**Level 1 subsystems** — not parts, *responsibilities*. For an RC car:

```
L0  RC car — "drive it from a browser/phone, it avoids walls, runs on batteries"
├── L1 POWER        supply, regulation, budget, cutoff
├── L1 DRIVE        motors, driver, gearing/mounting  ← mechanics lives here
├── L1 STEERING     differential vs servo — a real decision node
├── L1 CONTROL LINK how commands get in (BT? website-serial? ESP32 WiFi?)
├── L1 SENSING      obstacle detection + any telemetry
├── L1 BRAIN        controller choice (constrains everything else)
├── L1 STRUCTURE    chassis, weight budget, wire routing  ← CAD branch exists (tools/cad)
└── L1 SAFETY       low-voltage cutoff, runaway stop, kill switch
```

Each L1 node carries: a **goal** ("a power chain that drives 2×6 V motors from a
battery for ≥ 20 min"), an **owner** (`ai` / `ai_with_veto` / `human` — intake
deciders already have this vocabulary), and an empty **test slot**.

### Phase B — Recursive expansion with the intelligent stopper

Each node may spawn Level 2 children; those may spawn Level 3. Expansion is a
*move* the planner names, exactly like Everflow's continuation passes — persisted,
idempotent, one event per expansion so the UI watches the tree grow.

**The stopper (the part you insisted must be intelligent, not a number).**
A node is a *leaf* when it is **done, not when it is small**. Four stop rules,
evaluated per node per pass, in order:

1. **Testability floor (hard stop).** Expand until every leaf has BOTH
   (a) a concrete realization the system can act on — a catalog part, a file
   artifact, or a named decision with evidence — AND (b) a *test it can run*.
   A leaf without a runnable test is never "done"; it is `under-specified` and
   expands again. This is the primary stopper: **depth is a consequence of
   testability, not a target.**
2. **Decision-power test (saturation stop).** Before expanding, one cheap
   model call asks: *"would any child of this node change a downstream action
   (part, pin, wire, line of code, test)?"* If no child changes anything, the
   node is *strategic* — it stops. This kills infinite recursion on nodes like
   "STEERING" once "differential, 2 motors" is decided.
3. **Convergence stop.** If the last expansion produced no new edges into
   artifacts/tests/decisions (only restatements — measurable via the same
   dedup/overlap machinery intake uses), the node stops and the duplication is
   recorded. Two dead expansions anywhere ⇒ whole-graph expansion pause and a
   review ask.
4. **Risk-gated depth (anti-stop).** The inverse rule: some nodes are *not
   allowed* to stop early even though they look done — power paths, RF/antenna
   placement, mechanical interference, anything with irreversible real-world
   cost. These carry `minDepth` semantics derived from stakes (the
   self-learning-graph doc's "named real-world stakes"), not from numbers.

Budgets (tokens, passes, cost) remain as **backstops** — they trip the loop and
file an ask, they are never the normal way the graph finishes. Mirroring the
existing invariant: the loop ends on goal, budget or human — never silently.

**Worked example — DRIVE expands:**

```
DRIVE (L1)
├── motors: 2 × dc-motor-generic-6v        test: catalog ✓ + stall current ≤ budget
├── driver: l298n-motor-driver             test: pin map clean; driver ≥ motor current
│     ├── pin wiring            test: no conflicts, PWM pins confirmed
│     └── back-EMF protection   test: diode present (risk-gated: may not stop early)
└── mounting: geometry note + CAD stub     test: instructions.md mentions it;
                                             weight ≤ chassis budget
CONTROL LINK (L1) — decision node
├── option A: HC-05 + Serial commands      test: parser compiles; sim relay round-trip
├── option B: ESP32 WiFi + onboard site   test: QEMU boots; host-forward reachable
└── decide → human veto (choose ask, default = A)  ← evidence attached to the decision
```

### Phase C — Per-node tests, iterate till pass (your "each part has a test")

Every leaf gets a test spec chosen from an escalating **test ladder** — cheapest
test that can actually falsify the node:

| Rung | Test | Runs where | Already exists? |
| --- | --- | --- | --- |
| 1 | catalog: part exists, pins available | deterministic | ✅ validator |
| 2 | electrical: budget, voltage domains | deterministic | ✅ validator |
| 3 | compile: sketch compiles vs pin map | firmware shim | ✅ `compile-check.ts`, workbench gate |
| 4 | behavioral: assert telemetry/commands in the emulated board | avr8js/QEMU sim | ✅ `verify-behavioral.ts` machinery |
| 5 | rooting: generated code didn't escape the grounded plan | codegen gate | ✅ `verify-llm-codegen` |
| 6 | human/simulator verify ask: "does this behave right?" | left drawer | ✅ verify asks, default-on-expiry |

Failure ⇒ **targeted fix of that node only** (the fixer already patches, never
regenerates), re-run the test, and after N failed repairs on the same node ⇒
**escalate**: fresh-context reviewer (Phase D), and if it also fails ⇒ left-drawer
ask with a proposed resolution and default-on-expiry. Iteration history is
recorded per node — a node that passed after 3 repairs is visibly different from
one that passed first try (calibration, per the self-learning-graph doc).

### Phase D — Fresh-context validation (the reviewer)

After the graph reaches all-leaves-tested, a **reviewer agent** runs with a
deliberately clean context: it receives ONLY the brief, the graph, the artifacts
and the test results — never the builder's reasoning, never the pipeline chat.
Its job: *"given only this, would this build work? is any goal unproven, any
test self-serving, any assumption hiding?"* Verdicts: `PASS` / `FAIL (+patch
proposal)` / `ESCALATE (+question for the human)`. Its findings materialise as
evidence nodes with `verified_by` edges — same honesty rules as everything else
(the reviewer can cite the research tool, and "no source found" is an allowed
answer).

Two enforced separations: **reviewer model ≠ builder model** (the per-role
`BEDROCK_VALIDATION_MODEL_ID` override already exists — use it), and the reviewer
never edits; it proposes, the executor applies, the human `apply`s design changes.

### Phase E — Execution swarm over the frozen graph

Now the graph is the contract. The existing pipeline stages become **build
moves** owned by specialist agents working their subtrees, coordinated by the
Everflow planner (it already names one move per unmet goal):

- **hardware-swarm**: selection, power budget, pin map, wiring (subtree: POWER,
  DRIVE, SENSING)
- **firmware-swarm**: sketch, libraries, behavioral tests (subtree: BRAIN, SAFETY)
- **mechanics-swarm**: chassis notes, CAD generation (subtree: STRUCTURE — the
  `tools/cad` + `cad-helper` surface is the seed)
- **web-swarm**: the dashboard half (CONTROL LINK) — command set derived from the
  firmware source, as today

Swarm discipline (all invariants the repo already believes in):
- agents communicate **only through the graph** — no agent-to-agent chat; a
  finished subtree is a goal satisfied by code, visible to everyone;
- cross-subtree conflicts (two agents want pin 9) are decided by the pin planner
  rules, never by negotiation;
- every agent's writes are targeted patches; every version is a frozen revision;
- the goal loop (materialize → evaluate → plan one move → run it) keeps cycling
  until `done`, blocked-on-human, or no-progress — bounded, as today.

### Phase F — The two drawers (Human API surface)

```
┌─ LEFT DRAWER: "AI needs you" ──────────────┐  ┌─ RIGHT DRAWER: "You, mid-thought" ┐
│ questions AND tasks, typed:                │  │ type-or-talk anything, anytime:   │
│  • verify  — "watch the sim: does the      │  │  • note      → fact, next pass    │
│    car stop at the wall?"                  │  │  • idea      → choose-ask follows │
│  • choose  — "HC-05 or ESP32-WiFi link?"   │  │  • correction→ choose-ask follows │
│  • review  — "validation survived, halt?"  │  │  • resource  → cited evidence     │
│  • context — assumption confirmations      │  │  • STEER      → interruptible     │
│ each carries default-on-expiry, so the     │  │    reasoning: the current pass    │
│ swarm NEVER blocks on you (existing rule)  │  │    is redirected at the next move │
└────────────────────────────────────────────┘  └───────────────────────────────────┘
```

The left drawer is the existing `humanTasks` channel — it needs UI, not design.
The right drawer's `STEER` is the one genuinely new primitive: **interruptible
reasoning**. Two implementation tiers:

- **Tier 1 (works today, model-agnostic):** the injection lands as a persisted
  human→AI addition; the running pass finishes its current move; the planner
  folds the steering into the next pass (a `Command(resume)`-style durable
  interrupt — the LangGraph pattern Everflow already cites).
- **Tier 2 (Astra-native):** mid-turn steering over the WebSocket — the human's
  message redirects the model *inside* the current move; async tool calls let a
  left-drawer ask literally be a tool call that resolves when the human answers.
  Wireup already speaks Bedrock; `BEDROCK_MODEL_ID=gpt-6-astra` (+ the role
  overrides) is a config change, and the 1.1M context comfortably holds the
  whole graph + brief + artifacts as "the document".

One Astra caveat worth designing around: its recurrent-depth reasoning is
*opaque and hard to monitor*. The graph + event log then double as the
**externalised chain of thought** — the repo's "what you watch on screen is
exactly what the backend did" stops being a nice demo property and becomes the
safety property that makes an opaque-CoT model acceptable here.

---

## Part 3 — The one-paragraph version of the algo

> Prompt → intent node → intake doubts (deterministic forks first) → one
> expansion call lays down Level-1 responsibilities with goals → loop
> {pick the highest-value unexpanded node, expand one level, attach a test to
> every new leaf, run the cheapest test that can falsify, targeted-fix on fail,
> escalate to a fresh-context reviewer after repeated fails} → stop expanding
> when every leaf is testable and no expansion changes a downstream decision
> (budgets are backstops, not stoppers) → reviewer with clean context validates
> the whole graph → the executor swarms the frozen graph through the existing
> pipeline stages → goals are judged by code, humans are reached through the
> left drawer (never blocking, defaults on expiry) and can steer mid-reasoning
> from the right drawer → done means every non-waived goal satisfied and
> nothing dangling.

## Part 4 — What I'd actually build, in order (when you say go)

1. **Expansion move + stopper** in Everflow (`decompose.ts`): node children,
   test-slot field, the four stop rules, one persisted event per expansion.
   Deterministic fallback: a hand-written L1 template per project class
   (vehicle / home / instrument), so it degrades exactly like every other stage.
2. **Test ladder wiring**: reuse `verify-behavioral` + workbench compile gate as
   per-node tests instead of only global checks; add the per-node repair counter
   and escalation.
3. **Reviewer agent**: clean-context call via `BEDROCK_VALIDATION_MODEL_ID`,
   verdicts as evidence nodes. No edit rights.
4. **Left drawer UI** over existing `humanTasks`; **right drawer** Tier-1 first
   (persisted steering), Tier-2 when the Astra key is in.
5. **Swarm split**: role-based subtrees with per-role model overrides; graph-only
   communication. This is the last piece — the loop must be trustworthy solo
   before it's trustworthy in company.

## Part 5 — Open questions (genuinely undecided)

- **Mechanics depth**: is STRUCTURE a first-class branch with CAD artifacts and
  its own tests (weight, clearance), or a notes-and-instructions leaf for MVP?
  The CAD tooling exists but is not wired into the everflow graph.
- **Cost posture**: Astra at $10/$50 per M tokens as the sole brain, or Astra for
  intent/expansion/review + cheap models for per-node test runs? (The env
  already supports per-role models — this is a product decision, not a tech one.)
- **Expansion latency vs the live UI**: level-by-level streaming is great theatre
  for a hackathon but each level costs a frontier-model call. Pre-expand Level 1
  during intake (while the human answers doubts) to hide the latency?
- **Stop-rule 2 (decision-power test)** spends a model call to save model calls —
  right on big graphs, wasteful on small ones. Maybe only apply it from Level 2
  down, and let leaf tests do the stopping at Level 1.
- **Drone variant** (you mentioned it): same graph, but POWER and STRUCTURE
  become risk-gated hard (battery fire, propeller), CONTROL LINK splits into
  link + flight-controller (BLDC/ESC catalog parts exist), and SENSING gains
  MPU6050 attitude. The catalog already has ESCs, BLDC motors, propellers — the
  graph design carries over unchanged; only the stakes differ.
