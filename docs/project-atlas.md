# Project Atlas: a stateful project compiler

Project Atlas is the domain-neutral layer underneath Wireup's hardware experience. It is not a claim that GPT-6 or Astra is running inside the product. It is the part we can build and test now: a persistent source snapshot, a provenance graph, measurable confidence/coverage, and a human-approved target projection.

## The model

```text
source(s)
  └─ clone + content hash
      └─ text units
          └─ facts / requirements / entities / metrics / risks
              └─ provenance graph (nodes + typed edges)
                  └─ quantification (counts, coverage, confidence, gaps)
                      └─ target adapter (Java today; more later)
                          └─ review → apply → persisted Atlas version
```

The canonical state lives in `ProjectState.atlas` and is persisted through the existing Mongo or in-memory repository. The API never accepts generated files from the browser during apply: it re-reads the persisted source snapshot, checks the Atlas version, regenerates the target plan, and only then records the applied projection.

### Data structures

- `AtlasSource` — origin, kind, content, content hash, character/line counts, capture time.
- `AtlasNode` — source, text unit, concept, entity, requirement, metric, assumption, risk, artifact or target; every node carries confidence, status and source IDs.
- `AtlasEdge` — typed relationship such as `contains`, `requires`, `supports`, `measures`, `derived_from` or `maps_to` with evidence and confidence.
- `AtlasMetric` — numeric value, unit, status and source IDs.
- `AtlasQuantification` — source size, graph size, claim count, measured-fact count, resolved/unresolved counts, risk count, coverage and confidence.
- `AtlasTransformPlan` — target language, explicit source-to-target mappings, generated files, gaps, line count, confidence and an approval requirement.

## Example: guitar profile → Java project

Input:

```text
Guitar profile
body: mahogany
neck: maple
strings: 6
scale length: 25.5 in
pickups: 2 humbuckers
tuning: standard E
```

Atlas records the source and turns it into a graph with typed observations and measurements. The Java adapter proposes a reviewable project containing:

```text
src/main/java/generated/GuitarProfile.java
src/main/java/generated/GuitarProfileParser.java
src/test/java/generated/GuitarProfileTest.java
pom.xml
README.md
atlas/graph.json
```

The README and graph preserve what was observed, how it was mapped, confidence for each mapping, and any unresolved gaps. Apply is a state transition, not an invisible overwrite.

## Research decisions

1. **GraphRAG's indexing shape** — chunk source documents into text units, extract entities/relationships/claims, preserve source references, then quantify the graph. Atlas adopts this shape in a small deterministic first pass rather than requiring an LLM for the basic path. See Microsoft's [GraphRAG architecture](https://microsoft.github.io/graphrag/index/architecture/) and [dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/).
2. **Provenance as a first-class graph** — W3C PROV-DM is domain-agnostic and models entities, activities, agents and derivations. Atlas uses source IDs and evidence-bearing edges so a target field can be traced back to a source fact. See [PROV-DM](https://www.w3.org/TR/prov-dm/).
3. **Resumable state and approvals** — agent results should expose continuation history and a resumable state when an approval interrupts execution. Atlas uses an explicit `version` plus `requiresApproval` and `apply` boundary rather than pretending a plan is already an output. See OpenAI's [Results and state guide](https://developers.openai.com/api/docs/guides/agents/results) and [human review guide](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals).
4. **Cloneable snapshots** — Git's object model separates content blobs, directory trees and commit snapshots. Atlas does not reimplement Git, but it borrows the useful invariant: source content is hashed and transformations create new versioned state. See [Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects).

GPT-6/Astra research is used as an interaction/orchestration reference only. Public system-card material is not enough to reproduce an internal model architecture, so Atlas does not wire to an unverified model ID.

## API

- `GET /api/projects/:id/atlas` — read the persisted Atlas state.
- `POST /api/projects/:id/atlas` with `{ mode: "analyze", source, target }` — clone, graph, quantify and persist a proposed plan.
- `POST /api/projects/:id/atlas` with `{ mode: "apply", baseVersion, target }` — re-read, re-plan, verify the version, and persist the approved target projection.

This makes the agent state inspectable, replayable and quantifiable before any future model or tool swarm is added.
