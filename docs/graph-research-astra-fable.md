# Graph research → Wireup's rebuild

**Date:** 2026-09-10 · **Status:** implemented (`src/modules/graph/`, `src/lib/models/`, `pnpm verify:graph`)

The initial graphing was buggy in boring, structural ways (§3). Before
rewriting it we studied what the two frontier models released this month do
about long-running agentic work, and how the graph-DSA literature manages
project state. This file is the research record, the bug list, and the map
from "what they do" to "what Wireup now does".

---

## 1. GPT-6 Astra (OpenAI, released Sep 3 2026)

Model id `gpt-6-astra`. $10 / $50 per M tokens, 1.05 M context, 128 K max
output, knowledge cutoff Apr 30 2026. Served on the OpenAI API, Azure/Foundry
**and Amazon Bedrock** — so Wireup's Bedrock transport can already reach it
by model id; a direct Responses-API client is only needed for the
WebSocket-only primitives. [1](https://openrouter.ai/openai/gpt-6-astra) [2](https://overchat.ai/ai-hub/gpt-6-astra)

What matters for Wireup is not the benchmark table (OSWorld 2.0 72.6 %,
ScreenSpot-Pro 92.7 %, Terminal-Bench 4.0 57.9 %, AutomationBench 41.4 %,
FrontierMath Tier 4 97.6 %) [3](https://analystuttam.substack.com/p/gpt-6-astra-complete-guide-use-cases-computer-use)
but the three **workflow primitives** Astra adds over GPT-5.6 Sol:

1. **Asynchronous tool calls.** The model issues a tool call, keeps working
   on independent steps, and the application attaches the late result to the
   original `call_id`. "Continue independent work while an async tool is
   pending" vs Sol's conventional tool-response coordination. [4](https://www.cometapi.com/gpt-6-astra-vs-gpt-5-6-sol/)
2. **Mid-turn steering over a Responses WebSocket.** A new instruction can be
   inserted *while the model is working*; completed work is preserved and the
   run continues instead of being discarded and rebuilt. [5](https://aireiter.com/blog/gpt-6-astra-api-review)
3. **`configuration_update`: change reasoning effort mid-conversation
   without rewriting the prompt prefix**, preserving cache reuse. Minimum
   effort is `low` — `none` no longer exists; `temperature` / `top_p` are
   removed for Astra tool calling (Responses API recommended/required).
   [4](https://www.cometapi.com/gpt-6-astra-vs-gpt-5-6-sol/) [6](https://dev.to/ai_made_tools/ai-dev-weekly-25-gpt-6-astra-arrives-kotlin-agents-reach-10-copilot-adds-enforced-permissions-41f7)

Caveats we kept: Astra is the first model OpenAI rates **Critical** for
cybersecurity, and its chain-of-thought is shorter and harder to monitor —
so Wireup keeps judging goals **by code, never by model confidence**, exactly
as before. [3](https://analystuttam.substack.com/p/gpt-6-astra-complete-guide-use-cases-computer-use)

---

## 2. Claude Fable 5.1 (Anthropic, released Sep 1 2026)

Model id `claude-fable-5-1`. $10 / $50 per M tokens with cache reads at a
quarter of the cost, 1 M context, 128 K max output, cutoff Jun 2026. On
Claude.ai / Code / Cowork, the Anthropic API, AWS, GCP and Azure (also via
Bedrock through the usual Claude-on-Bedrock path). [7](https://platform.claude.com/docs/en/models/fable-5-1/overview) [8](https://happycapy.ai/models/fable-5.1)

Primitives Wireup adopts:

1. **Adaptive thinking, always on, steered by one knob: `effort`** in
   `output_config` — `low | medium | high | xhigh | max`, default `high`.
   No thinking config, no `budget_tokens` (both 400 now). Effort scales
   reasoning depth, tool-call consolidation and verbosity; ~7× token/cost
   spread between `low` and `max` on identical input. [9](https://claudefable-5.ai/features/adaptive-thinking/) [10](https://mecanik.dev/en/posts/claude-fable-5-hybrid-reasoning-api/)
2. **Per-message effort (beta): change effort partway through a
   conversation without invalidating the prompt cache**; `max_tokens` caps
   thinking + response *combined*, so high-effort calls need headroom.
   [7](https://platform.claude.com/docs/en/models/fable-5-1/overview) [9](https://claudefable-5.ai/features/adaptive-thinking/)
3. **Readable progress updates between tool calls** (`display: "updates"`,
   beta), turn-scoped system messages, content provenance. Breaking changes:
   forced tool use errors; thinking blocks are tied to the producing model;
   editing earlier turns invalidates them. [7](https://platform.claude.com/docs/en/models/fable-5-1/overview)
4. Positioning: route the hardest work to Fable, keep high-volume simple
   traffic on a cheaper tier — "reserve Fable 5 for work that needs the
   ceiling". [11](https://vercel.com/ai-gateway/models/claude-fable-5)

Benchmarks that justify trusting it with the reviewer role: Terminal-Bench
4.0 55.8 %, OSWorld partial 77.9 % / strict 41.7 %, HLE 60.9 % (65.0 % with
tools), GDPval-AA v2 1853, CursorBench 73.4. [8](https://happycapy.ai/models/fable-5.1)

---

## 3. Project state management through graphing + DSA

The pattern is LangGraph's `StateGraph`, now the standard shape for stateful
agents: [12](https://devops.gheware.com/blog/posts/langgraph-stategraph-beginners-guide-2026.html) [13](https://www.datacamp.com/tutorial/langgraph-agents) [14](https://www.kalviumlabs.ai/blog/langgraph-in-production-stateful-multi-step-agents/)

| Primitive | Meaning | Wireup adoption |
| --- | --- | --- |
| **State** — one shared typed object | every node reads the full state, returns a *partial update* | `PassState` in `pass-graph.ts`; `ProjectState` stays the persisted shape |
| **Nodes** — functions that update state | `materialize → evaluate → plan → persist` | each is a graph node with a checkpoint after it |
| **Edges** — direct + **conditional** | routing by a function of state (`done? → end : plan`) | kernel-proven by the verifier; the production pass stays linear for legacy equivalence, with phase routing inside the idea node |
| **Cycles** — graphs, not DAGs, for loops | revisit nodes with updated state | the pass loop is a cycle with a bounded trip count (`maxPasses`) |
| **Reducers** — `replace` vs `append` | accumulating fields must not be silently overwritten | events/tasks/research append; graph/evaluation replace |
| **Checkpointing** — full state saved every step | pause/resume, time-travel, audit | `MemoryCheckpointer` + persisted `everflow` snapshot; history per pass |
| **Interrupts** — `interrupt_before=[…]` | human-in-the-loop as a compiled pause point | `interruptBefore: ['persist']` support; steer folded at node boundaries |
| **`update_state` + resume** | answer → merge → continue from the checkpoint | `respond`/`inject` → save → `continueEverflow` resumes the same graph |
| **Prune aggressively** | everything in state is serialized per checkpoint | reviewer input stays narrow; checkpoints hold pass deltas, not transcripts |

Graph-DSA foundations underneath: the project graph is a **DAG**
(directed, acyclic — Kahn's topological sort, longest-path layering), while
the *pass runner* is a cyclic graph over it. Visual layout follows the
Sugiyama pipeline — **layer assignment → crossing minimization (barycenter)
→ coordinate assignment** — instead of the old fixed-column stacking.
[15](https://www.geeksforgeeks.org/dsa/introduction-to-directed-acyclic-graph/)

---

## 4. What was actually buggy (the diagnosis)

**Everflow `layout.ts` (the "initial graphing"):**

- `LAYER_ORDER` predates the idea graph: `subsystem` / `test_result` /
  `review` fall through to layer 1, so a 47-node idea graph piles into the
  "context" column — one giant vertical stack, other columns centered in
  whitespace, spaghetti edges.
- Back-edges (`artifact → goal` produces, `evidence → goal` verified_by)
  are drawn with a left-to-right bezier that assumes `from.x < to.x`; when
  the source sits *right* of the target the curve doubles back over the
  nodes.
- Within-layer order is insertion order — no crossing minimization — and
  columns are vertically centered, so **adding one node shifts every node
  in the column**: the canvas jitters between polls (the "trivially stable"
  comment was false).
- No DAG validation anywhere: duplicate ids, slug collisions, edges to
  nowhere are silently dropped in `materialize.ts` (`seen` guard + `continue`
  with no report) and in the layout (`if (!from || !to) continue`).

**`materialize.ts`:**

- `slug()` truncates to 48 chars and edge ids are
  `edge-${slug(from)}-${kind}-${slug(to)}` — two long ids with a shared
  prefix collide and the second edge vanishes silently.
- `evaluate.ts` re-slugs behavioural ids with a *different* regex than
  `materialize.ts`, so a human "Yes, it works" can fail to match its goal
  node for long/odd assertion ids.
- Research evidence is attached *before* idea-graph nodes are merged, so
  research on a subsystem node is skipped (`target` not found yet) — order bug.

**`WiringGraph.tsx`:**

- Hardcoded `WIDTH 620 / LEFT_X 190 / RIGHT_X 430` — breaks on narrow
  screens, no responsiveness, no zoom.
- Controller guess is `connections[0].from` when the prop is missing; every
  non-controller endpoint goes right, so peripheral↔peripheral wires bow
  meaninglessly and overlap.
- Pins ordered by first-seen (no net grouping/sorting) → crossing wires;
  parallel wires between the same pair draw on top of each other (no lanes).
- The kind filter in `WiringPanel` filters the *list* but the graph ignores
  it — the picture and the list disagree.

---

## 5. What was built from the research

```
src/modules/graph/          the graph kernel (pure, offline, tested)
  types.ts                  shared view types + validation report
  dag.ts                    adjacency · cycle detection (DFS colours) ·
                            Kahn topo-sort (stable tie-break) · longest-path
                            layering · barycenter ordering · safe slug/edge ids
  layout.ts                 Sugiyama pipeline for EverflowGraph → placed
                            nodes/edges. All 12 kinds get real layers;
                            direction-aware paths; deterministic + stable.
  wiring.ts                 net-aware wiring layout: pin sorting by
                            (kind, signal), lane offsets for parallel wires,
                            peripheral↔peripheral lanes, responsive width.
  validate.ts               validateEverflowGraph(): dup ids · dangling
                            endpoints · self-loops · cycles · orphans.
  state-graph.ts            LangGraph-style StateGraph: reducers, conditional
                            edges, cycles, checkpointing, interrupts,
                            update_state/resume, history. Zero deps.
  steer-bus.ts              in-process per-project steer queue (Astra-style
                            steering folded at node/tool boundaries).
src/lib/models/             the model layer (Bedrock stays the default transport)
  detect.ts                 family detection (astra/fable/generic) + effort map
  router.ts                 route by model id: direct API when a key exists,
                            else Bedrock Converse with family-correct config
                            (Astra: no temp/top_p, min effort low; Fable:
                            output_config.effort, adaptive thinking).
  openai-astra.ts           Responses-API client: effort, async tools
                            (call_id attach), configuration_update, steer
                            folding at tool boundaries.
  anthropic-fable.ts        Messages client: output_config.effort,
                            per-message effort, generous max_tokens headroom.
src/modules/everflow/
  pass-graph.ts             the continuation pass expressed AS a StateGraph
                            (materialize → evaluate → foldSteers → plan →
                            idea → research → persist). Same pure functions,
                            same order as the legacy runner — plus a
                            checkpoint after every node and steer folding at
                            the foldSteers boundary. Flag:
                            WIREUP_ENABLE_GRAPH_PASS (default on; any error
                            falls back to the legacy path).
```

Model routing per the vendors' own guidance: expansion proposes at `medium`,
R2 decision-power at `low`, the fresh-context reviewer at `high`
(Fable's default; Astra likewise) — never `none`/`minimal` on Astra, never a
temperature on either new family. Swarm role overrides keep working and now
also accept `gpt-6-astra` / `claude-fable-5-1` ids.

Steering tiers (honest labels, in the UI + events):

- **Tier-1 (always):** persisted, folded at the next pass — unchanged.
- **Tier-1.5 (new, Astra only):** the steer bus is drained at every
  StateGraph node boundary *inside* the running pass, so a steer lands
  mid-pass at the next tool boundary instead of waiting for the next pass.
- **Tier-2 (Astra WebSocket, designed, not claimed):** true mid-token
  steering needs a Responses WebSocket the Next.js route layer cannot hold;
  the bus interface (`publishSteer` / `drainSteers`) is the seam it would
  plug into. Nothing advertises Tier-2 until it exists.

---

## 6. How to verify

```bash
pnpm verify:graph        # the graph gate: DAG utils, layout, wiring,
                         # StateGraph (reducers/checkpoint/interrupt/resume),
                         # model router, steer bus — all offline, exit 0
pnpm verify:everflow     # unchanged behaviour of the loop
pnpm verify:idea-graph   # unchanged behaviour of the decomposition
pnpm typecheck
```

Equivalence: `verify:graph` runs the legacy pass and the StateGraph pass
over the same synthetic state and asserts identical outcomes (node/edge
counts, evaluation totals, filed asks). If the graph pass ever throws in
production, `runEverflowPass` catches and runs the legacy path — the flag
can never break the build.
