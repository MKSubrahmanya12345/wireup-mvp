# The build prompt — paste this into your coding agent

Two ways to use this file:

- **The one-shot prompt** (below) — paste the whole fenced block into a fresh
  agent session. It codes everything in dependency order and leaves you a test
  checklist.
- **The phased fallback** (end of this file) — five smaller prompts if the
  agent's context is limited or you want to test between phases (recommended:
  you said you test between agent runs — phases map to that).

---

## The one-shot prompt (copy everything inside the fence)

```text
You are building a feature called the IDEA GRAPH inside the existing Wireup
repository (a prompt→wired-hardware platform). Research first, then build.
The user does not write code — you write all of it, and they test by running
commands and clicking the UI, so every feature you ship must be observable
from a terminal command or a browser click. Never claim anything works that
you have not run. Print the exact command and its real output.

════════════════════════════════════════════════════════════════════
0. READ BEFORE CODING (in this order, do not skip)
════════════════════════════════════════════════════════════════════
1. docs/idea-graph-swarm-ideation.md      — the feature spec you are implementing
2. docs/everflow-architecture.md          — the layer you are extending
3. src/types/everflow.ts                  — graph node/edge types
4. src/modules/everflow/evaluate.ts       — how goals are judged
5. src/modules/everflow/continuation.ts   — the pass planner you will extend
6. src/modules/orchestrator/pipeline.ts   — the build stages
7. README.md sections: "Validation and the targeted fix loop",
   "Everflow", "Design rules this codebase follows"

════════════════════════════════════════════════════════════════════
1. THE INVARIANTS (violating any of these = the work is rejected)
════════════════════════════════════════════════════════════════════
- Goals are judged BY CODE against project state, never by model confidence.
- The graph is a projection. Breaking the graph can never break the build.
- Every model call has a deterministic fallback; the system completes and
  reports honestly with zero credentials, zero network.
- The agent NEVER blocks on a human: every ask carries default-on-expiry.
- Passes and expansions are idempotent and bounded (backstop budgets trip
  an ask; they are never the normal way work finishes).
- A guess is never a silent fact (assumptions stay visible until confirmed).
- No silent self-modification: human inputs change design only via the
  human's explicit apply, which creates a new frozen revision.
- Every state change emits an event so the UI can watch it live.
- Existing behavior must not regress: `pnpm typecheck`, `pnpm build`,
  verify:offline, verify:everflow, verify:llm-codegen, verify:workbench,
  verify:behavioral, verify:simulator must all still pass.

════════════════════════════════════════════════════════════════════
2. WHAT TO BUILD (in this order; commit after each numbered part)
════════════════════════════════════════════════════════════════════

PART 1 — Types + env flags (foundation)
- Extend src/types/everflow.ts: nodes gain `level`, `parentId`,
  `testSpec` (ladder rung + assertion + status), `expansionState`
  ('unexpanded' | 'expanded' | 'leaf' | 'stopped'), `repairCount`,
  `stakes` ('normal' | 'risk_gated'). New node kinds: `subsystem`,
  `test_result`, `review`.
- New env vars (validated in src/lib/validation/env.ts, documented in
  .env.example): WIREUP_ENABLE_IDEA_GRAPH (default true),
  WIREUP_IDEA_GRAPH_MAX_EXPANSIONS (backstop, default 40),
  WIREUP_IDEA_GRAPH_MAX_NODE_REPAIRS (default 2),
  WIREUP_ENABLE_MID_TURN_STEER (default false).
- Acceptance: `pnpm typecheck` passes.

PART 2 — Expansion + the intelligent stopper  (src/modules/everflow/decompose.ts)
- An `expandNode` move: takes one node, asks the model for ONE level of
  children (subsystems with a goal each). Deterministic fallback: a
  hand-written Level-1 template per project class (vehicle, home,/
  instrument, robot) so expansion works with no model at all.
- The stopper — four rules, evaluated in order, each with a recorded
  reason on the node:
    R1 testability floor: a node may only become a leaf when it has a
       concrete realization (catalog part / artifact / decided decision
       with evidence) AND an attached test it can actually run. Not
       both ⇒ it expands again.
    R2 decision-power: one cheap model call — "would any child change a
       downstream action (part, pin, wire, code, test)?" If no ⇒ stop
       as strategic. With no model: skip R2 (R1/R3 still apply).
    R3 convergence: an expansion that adds no new edges into
       artifacts/tests/decisions counts as dead; two dead expansions
       anywhere pauses expansion and files a review ask.
    R4 risk-gated: nodes tagged stakes='risk_gated' (power chains,
       actuators on humans/props, radio) are FORBIDDEN from stopping
       before they contain a concrete safety test.
- Each expansion emits an event ("idea_graph.expansion") with the node,
   level, children, stop decision + reason.
- Expansion runs as a continuation move inside the existing pass loop —
   idempotent, bounded by WIREUP_IDEA_GRAPH_MAX_EXPANSIONS (which, when
   hit, files an ask and says so out loud).
- Acceptance: unit-verified in the verify script (Part 6).

PART 3 — Per-node test ladder + repair/escalation  (src/modules/everflow/test-ladder.ts)
- Six rungs, cheapest-first: catalog → electrical → compile → behavioral
  → rooting → human-verify. Reuse the EXISTING machinery (validator,
  compile-check shim, behavioral assertions, codegen rooting gate) — do
  not reinvent them; wire them per-node instead of only globally.
- Every leaf node runs its test after the build produces it. Fail ⇒
  targeted fix of that node only (existing fixer) ⇒ re-test.
  repairCount increments per repair; when repairCount exceeds
  WIREUP_IDEA_GRAPH_MAX_NODE_REPAIRS ⇒ escalate: file a left-drawer ask
  (choose, default-on-expiry 'defer') containing the failing assertion,
  what was tried, and a proposed resolution.
- Each run/verdict emits "idea_graph.test" events and materialises a
  test_result node with a verified_by edge. Iteration history persists
  on the node (a node repaired twice and passing is visibly different
  from a first-try pass).
- Acceptance: verify script (Part 6) covers: pass-first-try, fail→fix→
  pass, fail×3→escalation ask filed once (idempotent).

PART 4 — Fresh-context reviewer  (src/modules/everflow/reviewer.ts)
- Runs after all leaves are tested. Input: brief + graph + artifacts +
  test results ONLY — never builder reasoning or pipeline transcripts.
- Uses BEDROCK_VALIDATION_MODEL_ID (falls back to the main model).
  Deterministic fallback: a rules-based review that checks the same
  list (unproven goals, dangling nodes, tests skipped, assumptions
  unconfirmed) and returns findings without a model.
- Verdict: PASS / FAIL(+patch proposal) / ESCALATE(+human question).
  Findings materialise as review nodes with evidence edges. The
  reviewer NEVER edits — proposals go through the existing fixer/apply
  paths.
- Acceptance: verify script proves reviewer output appears as nodes,
  and that a graph with a hidden unproven goal gets FAIL even when all
  builder-side state looks green.

PART 5 — Swarm execution over the frozen graph  (src/modules/everflow/swarm.ts)
- After the reviewer passes, assign subtrees to role agents:
  hardware-swarm (POWER/DRIVE/SENSING), firmware-swarm (BRAIN/SAFETY),
  web-swarm (CONTROL LINK/dashboard), mechanics-swarm (STRUCTURE — may
  be notes+instructions only for MVP; gate CAD behind a flag).
- Roles are planning labels + per-role model overrides
  (BEDROCK_VALIDATION_MODEL_ID / BEDROCK_FIXER_MODEL_ID pattern; add
  WIREUP_SWARM_ROLE_MODEL_<ROLE> optional overrides). With one model
  configured, roles run sequentially under the same pass loop — the
  value is the subtree ownership and per-node tests, not parallelism.
  Parallelism (Promise.all over independent subtrees) is allowed only
  where the existing store tolerates concurrent stage writes; if in
  doubt, sequential.
- HARD RULE: agents communicate ONLY through the graph (satisfied
  goals, test_result nodes, decisions). No direct messaging. Cross-
  subtree conflicts (e.g. pin disputes) are decided by the existing
  deterministic planners, never by model negotiation.
- Each subtree completion emits events and updates the graph; the UI
  shows which swarm owns which subtree (color/label is fine).
- Acceptance: verify script proves role assignment, graph-only
  communication (no hidden channels), and sequential fallback.

PART 6 — The verify script  (scripts/verify-idea-graph.ts + `pnpm verify:idea-graph`)
- Offline, no Mongo, no Bedrock, no network — same pattern as
  scripts/verify-everflow.ts (in-memory store, canned model responses).
- Must prove, as named assertions with printed output:
  a) expansion: RC-car prompt → L1 contains power/drive/control/sensing/
     brain/safety-class nodes; deterministic fallback produces them
     with zero model calls;
  b) stopper: R1 blocks a leaf without a test; R2 (with canned model)
     stops a strategic node; R3 pauses after two dead expansions and
     files the ask; R4 forbids early stop on a risk_gated node;
  c) ladder: fail→fix→pass and fail×3→single escalation ask;
  d) reviewer: hidden unproven goal ⇒ FAIL; reviewer separation holds
     (assert the reviewer input payload contains no builder transcript);
  e) swarm: subtrees assigned, sequential fallback works;
  f) idempotency: running the whole loop twice files no duplicate
     tasks/nodes;
  g) honesty: with every model call forced to fail, the graph still
     completes via fallbacks and the events SAY the model was
     unavailable — no fake green.
- Acceptance: `pnpm verify:idea-graph` exits 0 with all assertions
  printed; every existing verify script still exits 0.

PART 7 — The two drawers (UI on the project page)
- LEFT DRAWER "AI needs you": render the existing humanTasks channel
  (verify / choose / review / context asks) as a slide-in drawer on the
  left, wired to the existing /everflow/respond endpoint. Each ask shows
  its type, consequence, default-on-expiry, and its node link.
- RIGHT DRAWER "You, mid-thought": a slide-in drawer on the right wired
  to /everflow/inject — textarea + type selector (note / idea /
  correction / resource / steer). Submission shows what will happen
  ("processed on the next pass" / "needs your apply").
- Both drawers must work while the pipeline is running (the event poll
  already streams — do not add a second polling loop).
- When WIREUP_ENABLE_MID_TURN_STEER=true AND the configured model is
  gpt-6-astra, 'steer' submissions may be delivered mid-turn via the
  steering API; otherwise (default) they follow the Tier-1 persisted
  path. Guard this so it can never break the default path.
- Acceptance (click-path, print it for the user): create project →
  drawers open/close → answer an ask in the left drawer → event log
  shows the response → submit a note in the right drawer → next pass
  claims it → injecting "add a horn" produces a choose-ask back in the
  left drawer.

════════════════════════════════════════════════════════════════════
3. QUALITY GATES (run ALL of these; paste real output)
════════════════════════════════════════════════════════════════════
pnpm typecheck
pnpm build
pnpm verify:offline
pnpm verify:everflow
pnpm verify:idea-graph        (new)
pnpm verify:llm-codegen
pnpm verify:workbench
pnpm verify:behavioral
pnpm verify:simulator

Finish by writing a SHORT report to docs/idea-graph-build-report.md:
what you built, file list, the acceptance click-path for the user,
known limitations stated plainly (never "should work").

Style: follow the repo's existing conventions exactly — comments
explain WHY, names are concrete, no cleverness, honest degradation,
no invented hardware, no hidden magic.
```

---

## The phased fallback (paste one phase per agent run, test between runs)

**Phase 1 — Foundation + expansion:** Parts 1 + 2 + 6(a, b, f, g) from the one-shot prompt. *You test:* `pnpm typecheck`, `pnpm verify:idea-graph`.

**Phase 2 — Tests that bite:** Part 3 + 6(c). *You test:* `pnpm verify:idea-graph` now shows repair/escalation assertions.

**Phase 3 — The reviewer:** Part 4 + 6(d). *You test:* `pnpm verify:idea-graph`.

**Phase 4 — The swarm:** Part 5 + 6(e). *You test:* `pnpm verify:idea-graph` + all old verify scripts.

**Phase 5 — The drawers:** Part 7 + full quality-gate section. *You test:* the click-path — this is the phase where you actually watch it live in the browser.

---

## Your test checklist (after the agent says "done" — no code knowledge needed)

1. `pnpm typecheck` → ends without "error".
2. `pnpm build` → "Compiled successfully" (or equivalent).
3. `pnpm verify:idea-graph` → every named assertion prints `ok`/`pass` and exit code is 0. **Read the names** — they read like the feature list: stopper rules, repair escalation, reviewer separation, swarm assignment, offline honesty.
4. Every old script the agent lists in its quality gates also exits 0 — if ANY fails, the work is not done; tell the agent which one and paste the output.
5. `pnpm dev` → open the app → prompt **"an RC car with two DC motors, an ultrasonic sensor and a buzzer"** → answer the intake questions → build → watch the event log: you should SEE expansion events (L1 subsystems appearing level by level, each with a stop reason), test events per node, one reviewer verdict near the end, and swarm labels on subtrees.
6. The drawers: left shows asks with defaults listed; answer one and watch the event log react. Right: type "add a horn to the car" → within a pass or two the left drawer should ask you "Apply to the build?" — that's the no-silent-self-modification rule working in front of you.
7. The honesty check: tell the agent to run the demo with Bedrock credentials removed — everything must still complete, with events saying the model was unavailable. If it goes fake-green anywhere, reject.

**Red flags that mean "reject the run":** verify scripts "temporarily disabled", a test renamed to make it pass, "should work" anywhere in the report, acceptance criteria marked done without printed output, or the old verify scripts no longer listed.
