# Wireup self-learning graph architecture

**Status:** product direction + first control-plane slice  
**Owner:** human operator remains accountable for consequential work

## What we are building

Wireup is not a chat window that remembers a transcript. It is a human-directed
system for turning an outcome into an inspectable, editable decision graph:

```text
objective → interpretation → doubts → evidence → human gate → action → outcome
             ↘ named real-world stake ↗                 ↘ learning event
```

The graph is the durable unit of work. A conversation is only one way to edit
it. Every node should answer four questions:

1. **What is this?** A claim, task, doubt, evidence item, decision, or outcome.
2. **Why is it here?** Which objective, stake, or upstream node caused it?
3. **How sure are we?** Confidence is a calibrated signal, never a declaration
   of truth.
4. **Who can change it?** AI can propose; a human owns high-consequence gates.

The `/admin` control plane now exposes this model as an editable prototype. It
contains a live decision graph, a never-ending doubt stack, named real-world
stakes, a feature-repository view, and a provenance activity log. The existing
`cad-helper` repository is surfaced as a real feature surface rather than being
buried inside one large admin screen.

## Initial data model

The first backend implementation should use append-only events plus materialized
views. MongoDB is already present in this repository, so this can be introduced
without adding a new infrastructure dependency.

```ts
type GraphNode = {
  id: string;
  objectiveId: string;
  kind: 'intent' | 'claim' | 'doubt' | 'evidence' | 'task' | 'decision' | 'outcome';
  label: string;
  content: string;
  status: 'proposed' | 'active' | 'blocked' | 'human_review' | 'complete' | 'rejected';
  confidence: number | null;
  owner: 'ai' | 'human';
  provenance: ProvenanceRef[];
  createdAt: string;
  updatedAt: string;
};

type GraphEdge = {
  from: string;
  to: string;
  kind: 'supports' | 'depends_on' | 'contradicts' | 'branches_to' | 'produces' | 'learned_from';
};

type Doubt = {
  id: string;
  nodeId: string;
  question: string;
  consequence: string;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'answered' | 'deferred';
  answerNodeId?: string;
};

type StakeCard = {
  id: string;
  name: string;
  shortDescription: string;
  affectedPeople: string[];
  evidenceNodeIds: string[];
  confidence: number;
  reviewAfter?: string;
};
```

A `StakeCard` is deliberately short and named. It should not become a hidden
vector database of everything the model has seen. A memory is useful only when
it changes a later plan, routes a doubt, or changes the required human gate.

## The learning loop

1. **Parse the objective.** Extract the desired outcome, constraints, actors,
   irreversible actions and unknowns.
2. **Propose the smallest useful graph.** Start with a workflow, not an
   autonomous agent. Add branching only when the state requires it.
3. **Generate doubts before confidence.** Ask what could invalidate the plan,
   what evidence is missing, and whose context is absent.
4. **Route work.** AI handles retrieval, decomposition, comparison and draft
   generation. The human handles lived context, value judgments and approval of
   consequential actions.
5. **Record outcomes.** A completed task is not automatically a successful
   lesson. Capture what happened, whether the prediction was right, and what
   changed in the world.
6. **Distill.** Update or create a named stake, reusable constraint, skill or
   evaluation case. Keep the source events and the reason for the distillation.
7. **Evaluate before increasing autonomy.** Promote autonomy per node and per
   tool, never globally. A model being good at drafting does not make it safe
   to publish, spend, delete, or operate hardware.

## Guardrails for the "ultron" ambition

The goal can be ambitious while the implementation stays legible. The first
safety boundary is **no silent self-modification**. The system may propose a
new rule, prompt, tool, memory card or graph topology, but it must create a
reviewable change event and pass an evaluation set before promotion.

Minimum gates:

- explicit objective and success test before execution;
- least-privilege tool access and isolated execution for code or external
  actions;
- a human approval node for irreversible, high-impact or externally visible
  work;
- source/provenance links for claims and memory updates;
- bounded budgets for time, tools, tokens and retries;
- confidence calibration tracked against outcomes, not self-reported certainty;
- replayable event history and rollback for graph, prompt and memory changes;
- red-team cases for prompt injection, data leakage, goal drift and over-trust;
- a visible stop switch and a policy that keeps the human accountable.

This is intentionally closer to a **co-adaptive operating system** than a claim
of a fully autonomous general intelligence. Capability can increase as the
evidence supports it.

## Research basis

The architecture follows a few practical findings rather than assuming that a
more complex agent is automatically better:

- Anthropic's guidance distinguishes predictable workflows from agents that
  dynamically choose their next tool or step, and recommends starting with the
  simplest composable system that works.
- The Model Context Protocol is a useful boundary for connecting the reasoning
  layer to external tools and data without writing one-off connectors into the
  core graph.
- NIST's AI Risk Management Framework and its Generative AI Profile emphasize
  govern, map, measure and manage, including human oversight, provenance,
  confabulation and information integrity.

References:

- [Anthropic — Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic — Model Context Protocol](https://www.anthropic.com/news/model-context-protocol)
- [NIST — AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)

## Build sequence

### Slice 1 — present in the admin prototype

- Admin shell and feature repository navigation.
- Editable graph interaction with human-gate and AI-reasoning states.
- Doubt stack with explicit open/resolved states.
- Named real-world stakes cards.
- Activity/provenance surface.
- `cad-helper` as a separately surfaced repository capability.

### Slice 2 — make the prototype durable

- Persist graph nodes, edges, doubts, stake cards and events in MongoDB.
- Add API routes for graph patch operations with optimistic concurrency.
- Add evidence ingestion with file/source hashes and permission scopes.
- Replace demo counts with materialized project/workspace queries.

### Slice 3 — evaluation before autonomy

- Build task fixtures from real work, beginning with paper-review responses and
  hardware builds.
- Score outcome quality, doubt recall, calibration, provenance completeness,
  human correction rate and time-to-useful-action.
- Add replay: run a new planner against the same event history and compare
  graph diffs before promoting a change.

### Slice 4 — bounded execution

- Connect tools through allowlisted adapters.
- Add approval policies per tool and stake severity.
- Run code and CAD generation in sandboxes.
- Introduce scheduled learning/distillation only after replay and rollback are
  reliable.
