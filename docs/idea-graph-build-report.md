# Idea Graph — build report

**Repo:** wireup-mvp · **Branch:** `arena/01a08ba6-wireup-mvp` · **Date:** 2026-09-10
**Toolchain:** Node v22.22.3 · pnpm 9.15.4 · Next.js 15.5.25 · TypeScript (strict, `tsc --noEmit` clean)

The IDEA GRAPH is implemented per `docs/agent-build-prompt.md` and
`docs/idea-graph-swarm-ideation.md`: the prompt becomes an intent, the intent
grows into a tested decomposition graph (expansion → stop rules → per-node test
ladder → fresh-context reviewer → swarm execution), and a two-drawer UI gives
the human a channel in both directions. Every model call has a deterministic
fallback; every state change emits an event; nothing blocks on a human; no
state changes silently.

## 1. What was built (one commit per part)

| Part | Commit | What it does |
|---|---|---|
| 1. Types, env, materialize | `ad389ad` | `EverflowNode`/`IdeaGraphState`/task types, `WIREUP_IDEA_GRAPH_*` + `WIREUP_ENABLE_MID_TURN_STEER` env, graph materialised live from state (projection, never a copy) |
| 2. Decompose, stopper, continuation | `bf21622` | intent → L1 skeleton (deterministic), `decideStop` R1–R4 with recorded reasons, `expansionMove`, R3 convergence pause + backstop budget, pass runner `runEverflowPass` / bounded `continueEverflow` |
| 3. Per-node test ladder | `4eecb5f` | 6-rung ladder (catalog → electrical → compile → rooting → behavioral → human-verify), targeted repair per node, visible repair history, revision on every fix, ONE escalation ask after budget, never a silent mutation |
| 4. Fresh-context reviewer | `bd7a5fe` | reviewer input = brief + graph + artifacts + test results ONLY (no builder transcript, no llm calls — asserted), rules fallback with zero models, findings become evidence nodes, reviewer never edits |
| 5. Swarm execution | `1bbe142` | class→role partition (hardware/firmware/web/mechanics), owner stamps on subtrees, per-role model override, verifies each role THROUGH THE GRAPH ONLY — reports incomplete honestly instead of fake green |
| 6. Offline verifier | `49539b3` | `pnpm verify:idea-graph` — sections a–g + persisted end-to-end loop; caught a real bug on its first runs (children were edges to nowhere — see §4) |
| 7. The two drawers | `eda5142` + `4065ea8` | LEFT "AI needs you" / RIGHT "You, mid-thought", gated `steer`, live click-path proven (§3) |

Files added or materially changed by the idea-graph work:

```
src/types/everflow.ts                              (idea-graph types, expanded in parts 1–5)
src/lib/validation/env.ts                          (idea-graph + mid-turn-steer env)
src/modules/everflow/materialize.ts                (state → graph projection)
src/modules/everflow/decompose.ts                  (skeleton, expansion, R1–R4 stopper)
src/modules/everflow/test-ladder.ts                (rungs, repair, escalation)
src/modules/everflow/reviewer.ts                   (fresh-context review)
src/modules/everflow/swarm.ts                      (roles, assignment, graph-only verification)
src/modules/everflow/continuation.ts               (pass runner, bounded loop, injection claims)
src/modules/everflow/index.ts                      (channel fns, midTurnSteerEnabled)
src/modules/orchestrator/index.ts                  (finalise → bounded continuation loop)
src/modules/orchestrator/pipeline.ts               (idea-move hook, non-fatal)
src/app/api/projects/[id]/everflow/route.ts        (GET graph + capabilities)
src/app/api/projects/[id]/everflow/inject/route.ts (steer gate)
src/components/workspace/HumanDrawers.tsx          (both drawers)
src/components/workspace/ProjectHub.tsx            (drawer buttons, same live poll)
src/components/workspace/api.ts                    (respond/inject client helpers)
src/app/globals.css                                (drawer styles)
scripts/verify-idea-graph.ts                       (the offline verifier)
```

## 2. Quality gates — all nine, real output

Every command below was run on this branch, this environment, with no MongoDB,
no Bedrock credentials and no network (the app degrades to in-memory stores and
deterministic fallbacks, and says so in its events).

```
$ pnpm typecheck
# exits 0 — no output (tsc --noEmit, strict)

$ pnpm build
 ✓ Compiled successfully in 5.6s

$ pnpm verify:offline
✓ all checks passed

$ pnpm verify:everflow
✓ all everflow checks passed

$ pnpm verify:idea-graph
✓ all idea-graph checks passed        # exit 0 — full assertion list below

$ pnpm verify:llm-codegen
✓ 32 check(s) passed

$ pnpm verify:workbench
✓ 30 check(s) passed

$ pnpm verify:behavioral
=== 19/19 behavioural checks passed ===

$ pnpm verify:simulator
ok · 54 simulator claims, 54 part mappings and 10 board mappings all verified against the vendored Velxio build
```

`pnpm verify:idea-graph` prints its whole feature list (abridged to assertion
names; the run above passes every one):

- **a. expansion** — classifies the RC-car prompt (`vehicle`), lays the 8-node
  L1 skeleton (POWER, DRIVE, STEERING, CONTROL LINK, SENSING, BRAIN, STRUCTURE,
  SAFETY) with zero model calls; risk-gates power/drive/safety; every node
  carries a goal + empty test slot; a second expansion derives POWER children
  from the ACTUAL build state (`2S LiPo battery pack (7.4 V)`, `Budget & cutoff`).
- **b. stopper** — R1 forbids stopping without realization+test; R2 honours
  "no downstream change" as a strategic stop and keeps expanding when children
  WOULD change downstream actions; R4 forbids risk-gated nodes from stopping
  without a safety test, allows it with one; R3 pauses after two dead
  expansions and files exactly one review ask, with the reason on the record.
- **c. ladder** — on a real RC-car build with a deliberately broken ground
  wire: test FAILs → targeted fix (3 changes) → pass in one move; the repair
  is visible history (repairCount 1, one `test_result` node, revision v1→v2);
  a failing-forever leaf gets repairCount=2, verdict failed, exactly ONE
  escalation ask (idempotent on re-run) carrying the failing assertion and
  what was tried, defaulting to defer.
- **d. reviewer** — input carries brief/graph/artifacts/test results and
  provably NO builder events and NO llm-call records; a hidden unproven goal
  fails the run even with all builder-side state green; the verdict
  materialises as a review node with an evidence edge; the reviewer records
  how it judged (`rules` fallback) and never edits artifacts.
- **e. swarm** — the class→role map matches the spec partition; all four roles
  own subtrees of the skeleton; assignments are graph-only facts (execution
  recorded `sequential`); per-role model recorded (null with no model); an
  untested subtree is reported incomplete, never fake green.
- **f. idempotency** — a second full loop adds NO nodes, NO asks, NO duplicate
  test results.
- **g. honesty** — with the model forced to fail, fallbacks still complete the
  graph and the events confess (`model call threw … deterministic expansion
  used`); every expansion event names its provenance (source / stop decision /
  pause / backstop).
- **end-to-end** — a real deterministic build runs the persisted pass loop:
  expansion finishes with human shepherding (R3 pauses lifted only by explicit
  answers — 8 lifts), ends in phase `reviewing`, every subsystem reaches an
  explicit decision, every leaf has a stop reason, no untested test left owing.

## 3. The drawers — live click-path (real transcript)

Server: production build (`pnpm start`), same offline environment. Commands
and responses as they happened; project `memproj_3f89908f9277450d`.

**Create + intake + build** (answers via the same endpoints the intake screen
uses; two doubts skipped → recorded assumptions):

```
POST /api/projects {"prompt":"an RC car with two DC motors, an ultrasonic sensor and a buzzer","mode":"everflow"}
→ project memproj_3f89908f9277450d, status intake
POST /build {}   → completed_with_errors (rev 2, 65+ events)
```

The build's finalise now runs the bounded continuation loop, and the event log
shows the graph growing by itself:

```
64 [expansion] Idea graph: "vehicle" skeleton laid down — 8 Level-1 subsystem(s)
               (POWER, DRIVE, STEERING, CONTROL LINK, SENSING, BRAIN, STRUCTURE, SAFETY),
               each with a goal and an empty test slot.
66 [expansion] Idea graph: "POWER" expanded to level 2 — 9 V alkaline battery (PP3), Budget & cutoff.
```

**Answer an ask in the left drawer** (`POST /everflow/respond`, the drawer's
"Yes, it works" button):

```
{"taskId":"htask_29da169efaed4f77","value":"Yes, it works"} → {"ok":true}
event 68: You answered "Confirm: Behaviour: A stepper/motor build has no press counter": Yes, it works.
```

**Inject a note and an idea** (`POST /everflow/inject`, the right drawer):

```
{"type":"note","text":"The motors are TT gearboxes rated 3-6V — keep the supply at 5V."} → {"ok":true}
{"type":"idea","text":"add a horn to the car"}                                          → {"ok":true}
```

The note is claimed by the next pass (`status: processed`), and the idea comes
back as the acceptance demands — a CHOOSE ask in the left drawer, never a
silent change:

```
[choose] Apply "add a horn to the car" to the build?
[note]   The motors are TT gearboxes rated 3-6V — keep the supply at 5V. → processed
[idea]   add a horn to the car                                          → processed
```

**Steer with the gate off (the default) is refused honestly:**

```
POST inject {"type":"steer","text":"prefer WiFi over Bluetooth"}
→ 409 {"code":"steer_disabled","message":"Mid-turn steering is off (needs
   WIREUP_ENABLE_MID_TURN_STEER=true and model gpt-6-astra). Send it as a note
   instead — it lands on the graph the same way and is read on the next pass."}
```

**With the gate on** (server restarted with `WIREUP_ENABLE_MID_TURN_STEER=true
BEDROCK_MODEL_ID=gpt-6-astra`, fresh project): `GET /everflow` reports
`{"capabilities":{"midTurnSteer":true}}` and the same injection returns
`{"ok":true}` with the event

```
Steer registered: prefer WiFi over Bluetooth for the link — the current move
finishes first; the planner folds it in at the next pass.
```

(the delivery is Tier-1 even when enabled — persisted + folded at the next
pass; the event says exactly that, never more).

**The R3 pause lifts only by an answer** — answering "Yes — push deeper" on
`Expansion is repeating itself — should I push deeper anyway?` resumed
expansion on the live project:

```
69 [expansion] Idea graph: "DRIVE" expanded to level 2 — Active buzzer (5 V), DC gear motor (6 V), L298N dual H-bridge motor driver…
72 [expansion] Idea graph: "STEERING" expanded to level 2 — Steering decision.
75 [expansion] Idea graph: "CONTROL LINK" expanded to level 2 — Command set.
76 Convergence rule (R3): two dead expansions — expansion paused and a review ask filed.
```

The graph then holds 47 projected nodes with POWER/DRIVE/STEERING/CONTROL LINK
expanded; it pauses again honestly because the state-derived children are
finite — it will not invent work to look busy.

**In the browser:** open the project page → the topbar shows
`needs you (N)` (it pulses while asks are open) and `mid-thought`. Left drawer:
type chips VERIFY/CHOOSE/REVIEW/CONTEXT, the ask body, its graph node id, and
the printed default ("You don't have to answer: …"). Right drawer:
note/idea/correction/resource/steer chips with a per-type "what will happen"
line, your additions with their claim status, and the steer chip disabled with
the honest reason when the gate is off. Both drawers read the same live
project the event log uses — there is exactly one polling loop in the hub.

## 4. The verifier caught a real bug

`pnpm verify:idea-graph` did not pass by construction — on its first runs it
exposed a genuine defect in `expansionMove`: deterministic/model children were
built into a local array and their `part_of` edges pushed into the graph, but
the nodes were never appended to `ideaGraph.nodes` — the graph grew edges to
nowhere (node count frozen at 8 while events claimed children). Fixed in
`decompose.ts` (`ideaGraph.nodes.push(...childNodes)`) and now asserted
twice: section A ("a second expansion derives POWER children from the ACTUAL
build state — 10 node(s)") and the end-to-end loop (12 pending tests after
expansion, 0 after the ladder).

## 5. Limitations (plain, not "should work")

- **No MongoDB in this environment.** The app auto-falls back to an in-memory
  store (the log says `project created (in-memory store)`). Projects do not
  survive a server restart. With a real `MONGODB_URI` the same code paths
  persist to Mongo; that path is the one production uses but it is not
  exercised here.
- **No Bedrock credentials → zero model calls ran.** Everything you see above
  is the deterministic layer. The model-driven paths (LLM child proposals,
  R2 decision power, model review, LLM fixer) are covered by the offline
  verifiers using stubs, and the event log names the fallback every time —
  but no real model has judged anything in this session.
- **Steer is Tier-1 only.** Even with `WIREUP_ENABLE_MID_TURN_STEER=true` and
  `gpt-6-astra`, steering is persisted and folded in at the next pass; nothing
  interrupts a model mid-move. The spec's Tier-2 (true mid-turn over async
  tool calls) is designed for but not implemented.
- **Expansion converges fast offline.** Deterministic children come from the
  real build state, so after the parts-driven level the graph honestly reports
  convergence (R3) and pauses. A real model would propose deeper, more varied
  subtrees; the depth here is a property of having no model, not a cap.
- **The RC-car demo files two odd-looking verify asks** ("press counter").
  They are real behavioral assertions from the deterministic spec builder and
  are filed as human-verify rungs. They read oddly but they are honest asks
  with printed defaults.
- **The demo build ends `completed_with_errors`** (power budget exceeded on
  the PP3-battery default). That is the validator telling the truth about the
  skipped power doubt — the review ask "2 blocking issue(s) survived the fix
  loop" is the same fact surfaced to you.
- **Drawer behaviour while the pipeline runs** is covered by the shared poller
  and the persisted endpoints; I drove the click-path over HTTP, not with a
  browser driver. The buttons render server-side (verified in the HTML) and
  the interactions hit the endpoints shown above — the visual pass is yours.

## 6. Run it yourself

```
pnpm install
pnpm build && pnpm start          # or: pnpm dev
# open http://localhost:3000 , prompt: "an RC car with two DC motors, an
# ultrasonic sensor and a buzzer" , answer the intake doubts, build.
# topbar: "needs you" (left drawer) · "mid-thought" (right drawer)
# Everflow tab has "run another pass".

pnpm verify:idea-graph            # the idea-graph gate (exit 0)
# optional:
WIREUP_ENABLE_MID_TURN_STEER=true BEDROCK_MODEL_ID=gpt-6-astra pnpm start
# → steer submissions accepted (Tier-1 persisted delivery)
```
