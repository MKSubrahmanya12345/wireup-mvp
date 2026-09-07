# Frontend output audit — `/project/[id]` workspace

> **Status:** addressed by the output restructure. The workspace was rebuilt from a
> single dump-the-internals page into a **guided, multi-page hub** (see
> `src/components/workspace/ProjectHub.tsx` + `src/components/workspace/panels/`).
> It leads with a plain-language status ribbon and a six-step build progress bar,
> splits the deliverables into focused tabs (Overview → Parts & BOM → Wiring & Pins →
> Diagram & Simulator → Firmware → Build guide → Check & fix), pushes the raw run log
> to its own `/project/[id]/log` page, and hides internal ids / provenance / raw JSON /
> coordinate tables behind a "details" toggle. This file documents the *original*
> problems that motivated that change.

**Goal:** find where the output page buries, repeats or leaks internals, so a *normal*
user gets the finished hardware project instead of a developer dashboard.

**Core diagnosis:** the workspace is a debug/ops dashboard wearing a consumer shell. It
optimises for *"show everything the agent did"* rather than *"here is your finished
hardware project."* Three root flaws:

1. **Information overload** — every internal artifact, provenance tag, timestamp and
   metric is rendered at full weight at once.
2. **No hierarchy / no answer** — nothing is *the* result. The actual deliverables are
   buried mid-page among planning internals. There is no one-line "what you got" and no
   "what to do next."
3. **Redundancy** — the same fact appears in 3–4 places, and the left console largely
   duplicates the Agent card.

---

## What a normal user actually wants

From a prompt → project tool they want, roughly in order:

1. Project name + one-line "what was built from your prompt."
2. Bill of materials (parts + quantity) — *Components*.
3. The wiring picture — *Wiring*.
4. The firmware — *Code*.
5. Step-by-step *Instructions*.
6. Validation verdict: "passed / here is what's wrong" — *Validation*.

## What they do **not** need (presently exposed)

LLM call records + token counts · model names · per-event durations · revision diffs &
changesets · source/origin provenance (model / planner / fixer / rules) · internal ids ·
raw JSON dumps · layout pixel coordinates · char / line counts · "polled at" · "fix pass
x/y" · stage chips · the metadata JSON in the console.

---

## Page 1 — `/` (landing)

Review: `src/app/page.tsx`, `src/components/PromptForm.tsx`

Good: single input, no clutter.

Flaws (minor):

- Eyebrow `Prompt → components → wiring → firmware → validation → fix` is pipeline jargon
  (fine, but not user value).
- Subtitle is long + technical ("`diagram.json`", "validates and patches only what is broken").
- Note: *"Every submission creates a brand new project — nothing is cached or reused. No
  account required."* — "nothing cached/reused" is implementation detail; may even alarm users.
- `maxLength={MAX_LENGTH + 200}` on the textarea but validation caps at `MAX_LENGTH`
  (trivial, inconsistent by 200 chars).

---

## Page 2 — `/project/[id]` workspace

### Shell / topbar
`ProjectWorkspace.tsx`

- Shows `project.name`, raw `project.id` (UUID), `StatusBadge`, `v{revision}`,
  `iteration x/y`, `last event …`/`updated …`, refresh button, "new project". Overloaded
  with status + iteration + timestamps; the raw id is useless to a user.
- **Redundant:** status repeats in ProjectCard; revision/iteration repeat in ProjectCard +
  AgentCard.

### Left pane — AgentConsole
`AgentConsole.tsx`

- Renders **every** event: seq, status icon, message, `(durationMs)`, clock, type, stage, and
  a metadata summary with a raw `JSON.stringify(...)` expander. This is the single biggest
  source of "junk." A normal user doesn't need per-event metadata or raw JSON.
- **Duplicates** the Agent card's stage timeline.
- Footer repeats `stage: X` (also in chips) and `polled HH:MM:SS` (also in pane head).
- Filter + follow are power-user tools; harmless but signal "dev tooling."

### Stage chips bar
`ProjectWorkspace.tsx` (`STAGE_ORDER`)

- 13 internal stage names (understanding, catalog, generation, hardware, pins, wiring,
  software, code, libraries, diagram, instructions, validation, fix). Internal pipeline
  jargon; a user doesn't track "pins" vs "software" vs "wiring."
- **Redundant** with console stage + every card loader.
- Footer `polled HH:MM:SS` (third place).

### ProjectCard
`cards/ProjectCard.tsx`

- ~15 stacked sections: status, stage, fix pass, platform, id, name, goal, summary, original
  prompt, requirements + features + quantities, inputs/outputs/behaviors/constraints/
  platform/communication/power, assumptions, ambiguities, hardware architecture table,
  subsystems, signal flow, power budget + rails + notes, risks, compatibility checks.
- This is the **whole internal hardware plan**. A user wants the *summary* and the BOM
  (which lives in Components/Instructions), not the planner's full reasoning.
- Internal leakage: raw `id`, revision, "Quantities read from the prompt", "Assumptions made",
  "Compatibility checks" (with reasons), power rails (typ/peak mA), controller "reason".
- **Redundant** status.

### ComponentsCard
`cards/ComponentsCard.tsx`

- BOM is deliverable-relevant. Leaks: `componentId`, `matched from "…"`, `source`
  (catalog/planner/model), per-instance `instanceId`, plus a full pin-assignment table
  (peripheral→mcu, dir, signal, purpose) that duplicates the Wiring graph/list.
- `source` provenance + "matched from" are internal.

### WiringCard
`cards/WiringCard.tsx`

- Useful (the picture), but:
  - The per-wire list **duplicates** the graph; each row adds kind/signal/voltage badges
    + `source` (fixer/planner) + explanation. `source` is internal.
  - Shows nets + conflicts tables (advanced). "Conflicts detected" language may alarm.
  - Footer: signal/power/ground counts + `generated …` timestamp.
  - "show all N wires" has **no way to collapse back**.
  - Legend footer: *"graph is derived from wiring.connections — never hardcoded"* =
    implementation commentary.

### CodeCard
`cards/CodeCard.tsx`

- Core is right. Leaks: `generated by model/planner/fixer` badges, `pin map
  synchronised: yes/no`, `entry point`, char count, `N lines · N chars`.
- Libraries view: a good table plus a **redundant** raw `libraries.json` JSON dump.
- Footer: install-command count + `generatedAt`.

### DiagramCard
`cards/DiagramCard.tsx`

- Canvas is good. Then it dumps: a "Parts" table with `x`/`y`/`pins` (layout coordinates),
  rails, groups, raw JSON, Wokwi projection with warnings + skipped-parts lists, and a
  footer of format/version/revision/width×height/grid/simulator target.
- A user wants the picture + the `diagram.json` to load into Wokwi. They don't need the
  parts coordinate table or the internal-graph JSON dump.
- Tab labels are jargon: internal format is called "wireup graph"; the file you actually load
  is "wokwi".

### InstructionsCard
`cards/InstructionsCard.tsx`

- Core (build guide) is right, but tabs add `instructions.md` (raw), `sections (N)` and
  `bom (N)`. Raw markdown + sections **duplicate** the rendered tab; `sections` shows
  "N characters" per section — useless metric.
- Footer: build time, char count, `generatedAt`.

### ValidationCard
`cards/ValidationCard.tsx`

- Plausible as a result, but leak-heavy: checks (with issue ids), issues (code/domain/
  origin/auto-fixable/target/details/fix hint), model review verdict + confidence.
- `origin rules/model`, "deterministic engine + model review", `durationMs`, "iteration",
  model name, and confidence % are internal.
- **Redundant** error notice (also in workspace and AgentCard).

### AgentCard
`cards/AgentCard.tsx`

- **Pure developer dashboard**: revisions, changesets, diff table (before/after, added/
  removed instances), stage timeline with durations, model-call table with token in/out,
  iteration, model names, validation-model name, `tokens X in / Y out`.
- This is where the most junk lives, and it calls itself "Agent." A normal user does not
  care about LLM call records.

---

## Cross-cutting patterns (the "heavy" feel)

- **Monospace + uppercase micro-labels everywhere** (badges, section titles, card titles) →
  terminal aesthetic, not product aesthetic.
- **Micro-badge explosion**: wire rows, part heads, issue meta, revision heads carry 3–6 tiny
  uppercase pills each.
- **Footers full of metrics** on every card: createdAt / generatedAt / char / line / token
  counts / durations.
- **Redundancy**: status (topbar+Project+Agent), stage (console+chips+loaders),
  revision/iteration (topbar+Project+Agent), error (workspace notice+Agent), event timeline
  (console+Agent "stages").
- **Everything open/expanded** — no "collapse all", no "simple vs advanced" toggle, so the
  page is a long stack of ~8 dense cards.
- **No single summary block**, **no "export project" (zip)**, and **no "what to do next"**
  call-to-action.
- **Implementation commentary in UI copy**: "never hardcoded", "the model cannot invent
  hardware", "derived from wiring.connections", "deterministic engine".

## Minor / concrete issues worth fixing

- WiringCard "show all N wires" can't collapse back to the top 40.
- InstructionsCard `sections` tab shows char counts per section (meaningless).
- AgentCard "Diff against v…" label: for the initial v1 it reads "Diff against v1" but shows
  the from-zero diff (should be "initial generation").
- DiagramCard `Kvish` label is a cryptic helper name; "wireup graph" tab name is jargon.
- ValidationCard / workspace / AgentCard each render the same `project.error` notice.
