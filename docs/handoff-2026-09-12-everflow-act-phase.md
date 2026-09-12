# Handoff — the Everflow act phase (the loop's own engineering moves)

**Branch:** `arena/01a09392-wireup-mvp`
**Date:** 2026-09-12
**Status:** typecheck clean; `verify:everflow` (incl. the new section 8), `verify:graph` (act path + runner equivalence), `verify:idea-graph`, `verify:behavioral` 19/19, `verify:workbench` 30/30, `verify:offline`, `verify:llm-codegen` 32/32 all pass; `next build` clean. Committed on this branch.

---

## 1. What this is

Everflow could **judge** every goal by code and **name** its next action
(`run_fix`, `verify_sim`) — but it could not **execute** anything. A pass
could file human asks, advance the idea graph and read docs; the engineering
loop (validate ⇄ fix) was locked inside the build and could never be
re-entered. Three consequences were visible in the code:

1. A canvas sync froze a revision but **never revalidated** — the loop then
   judged a stale design.
2. The evaluator and materialiser judge `behaviour_proven` goals from
   per-assertion `behavioral.<id>` validation **checks** — which the validator
   never wrote (only *issues* with those ids, plus one aggregate check). A
   promise the emulator had **already proven at build time** could never
   satisfy its goal by code, so the planner always filed a human *verify* ask
   for it.
3. When blocking issues survived the build's fix loop, the only move was a
   human *review* ask — even when the issues were fresh, deterministic and
   fixable (the loop never tried).

The **act phase** fixes all three: inside every continuation pass, *after*
the evaluation and *before* the planner files asks, the loop runs its own
bounded engineering moves. Humans get asked only for what the loop could not
close itself. This is "Everflow in the loop": the goal loop now drives the
engineering, not just the conversation.

```
materialize → evaluate → foldSteers → ACT → plan → idea → research → persist
                                      │
                                      ├─ revalidate  (design drift → rule engine)
                                      ├─ reprove     (unproven promises → behavioural evaluator)
                                      └─ repair      (fresh blocking issues → deterministic fixer, revision frozen)
```

Both runners execute the identical phase (legacy straight-line and the
StateGraph pass); `verify:graph` asserts the node path and the equivalence.

## 2. New pieces

| Piece | Path | Notes |
| --- | --- | --- |
| Act phase | `src/modules/everflow/actions.ts` | `designFingerprint` / `behaviorFingerprint` / `repairSignature` (stable-stringify + sha256), `ensureActionState` (seeding), `planActions` (pure move planner), `runEverflowActions` (executor; never throws — a failed move is a `failed` record), `mergeBehavioralReport`, `unprovenPromises`. |
| Shared findings | `src/modules/behaviour-evaluator/findings.ts` | `behavioralFindings(report)` — the ONE vocabulary: aggregate check, per-assertion `behavioral.<id>` checks, `behavioral_assertion_failed` issues. Used by the validator and by the act-phase merge, so a mid-loop re-run writes exactly what the build-time validator would. |
| Validator wiring fix | `src/modules/validator/index.ts` §1b | Now emits the per-assertion checks through `behavioralFindings` — the broken wire behind consequence 2. |
| Pass summary | `src/modules/everflow/pass-summary.ts` | One `everflow_pass` message/metadata builder shared by both runners (parity by construction; `steersFolded` kept). |
| Runner integration | `continuation.ts`, `pass-graph.ts` | Act runs between evaluate/foldSteers and plan; move events ride inside the working state's event log so idea moves sequence strictly after them and the single save persists them exactly once; act changes re-materialise + re-evaluate before planning; `progressed` counts changed moves; `everflow.actions` persists on the pass. |
| Types | `src/types/everflow.ts` | `EverflowMoveKind`, `EverflowActionRecord`, `EverflowActionState`; `EverflowState.actions?` (optional — pre-act-phase documents stay valid). `src/types/generation.ts`: `everflow_move` event type. |
| Env | `src/lib/validation/env.ts`, `.env.example` | `WIREUP_ENABLE_EVERFLOW_ACTIONS` (default on), `WIREUP_EVERFLOW_MAX_REPAIRS` (2), `WIREUP_EVERFLOW_MAX_REPROOFS` (3). |
| API | `src/app/api/projects/[id]/everflow/route.ts` | GET now returns `actions` (bookkeeping + ledger). |
| UI | `EverflowPanel.tsx`, `wireup-styles.css` (`evf-moves`), `workspace/api.ts` | "Loop moves — what the agent did itself before asking you": outcome-chipped ledger with revision refs and budget counters, under the completion ribbon. |
| Proof | `scripts/verify-everflow.ts` §8, `scripts/verify-graph.ts` | Section 8: seed/stability, drift → revalidate, prove-by-code → no verify ask, fresh issue set → budgeted repair with frozen revision, budget backstop, flag off, every planner guard. verify:graph: the `act` node in the path + unchanged equivalence checks. |
| Docs | README (Everflow section, env table, module map, limitations), `docs/everflow-architecture.md` ("The act phase") | |

## 3. The moves, their guards and their honesty

Order per pass: **revalidate → reprove → repair**. `planActions` decides from
the state at pass start; the executor re-checks every guard against its
working state (an earlier move may have done the work — the skip is
recorded, never silent).

- **revalidate** — fires when the design fingerprint (prompt, requirements,
  components, hardware plan, pins, wiring, artifacts) ≠ the fingerprint at
  the last validation the loop observed, or a finished design has no
  validation. Runs `validateProject` **engine-only** (the model review
  belongs to the build, not to the loop's cheap re-check — said out loud in
  the record). Status flips honestly inside the `completed*` family.
- **reprove** — fires when behavioural promises are unproven (no passed
  `behavioral.<id>` check) AND the firmware/spec fingerprint drifted. Runs
  `evaluateBehavioral` (static proofs + host-shim emulator) and merges via
  `mergeBehavioralReport`. A promise proven here satisfies its goal **by
  code** — the planner files no verify ask for it. Budget:
  `WIREUP_EVERFLOW_MAX_REPROOFS`.
- **repair** — fires when blocking issues remain whose signature
  (sorted per-issue `issueSignature` set) the loop has not already tried.
  Runs the existing deterministic fixer (idea-ladder `repairNode`
  mechanics: `fixProject` with refreshers, `enableLlmFixer: false` — the
  model fixer already ran in the build; retrying it here would spend tokens
  on the same wall), freezes a `targeted_fix` revision summarised
  "Everflow act-phase repair", then revalidates engine-only. Budget:
  `WIREUP_EVERFLOW_MAX_REPAIRS`; blocked by the revision cap; an applied-0
  pass records the signature and never retries it — the human review ask
  (planner rule 3) owns it from there.

**Seeding** (`ensureActionState`): the first pass trusts the pipeline's
fresh validation as the baseline — fingerprints recorded as already-observed
— and records a blocking-issue set the build's fix loop just exhausted as
already-attempted. So the loop never blindly retries what the pipeline
proved unfixable moments ago; **new evidence** (drift from a canvas sync, a
reproof, an applied addition, a ladder repair) is what unlocks a move.

**Never act on a live build:** moves only run on `completed*` statuses.

## 4. How to prove it

```bash
pnpm verify:everflow   # section 8 is the act phase, end to end, offline
pnpm verify:graph      # f: the act node in the path + legacy ≡ graph parity
```

Section 8's headline checks, verbatim from the run:

- `the promise is now proven BY CODE (per-assertion check passed)` —
  `Proven by the static evaluator: expected 6, observed 6.`
- `no human verify ask was filed for what the loop proved itself — 0 ask(s)`
- `a fresh blocking issue set triggers the loop's own fix pass — changed:
  Loop fix pass applied 2 change(s) — revision v2 frozen; revalidated with
  12 blocking issue(s) left.`
- `the budget backstop stops a second loop repair (the asks own the rest)`
- `with WIREUP_ENABLE_EVERFLOW_ACTIONS=false the loop only asks`

In the UI: build any project, open the **Everflow** tab → "Loop moves"
ledger; edit the circuit on the **/simulation** canvas, sync it, run another
pass — the revalidate move appears with the fresh engine verdict. Every move
also lands in the run log as an `everflow_move` event.

## 5. Found and fixed on the way

- **The `behavioral.<id>` broken wire** (consequence 2 above): readers in
  `evaluate.ts`/`materialize.ts` expected per-assertion checks no writer ever
  produced. Fixed at the source (validator §1b via `behavioralFindings`),
  which makes build-time proof satisfy goals immediately — the act-phase
  reproof then only matters after drift. `verify:everflow` §6's fixture
  already spoke this vocabulary, confirming it was the intended contract.
- **`steersFolded` metadata** was dropped when the pass-event builders were
  unified — caught by `verify:graph` §g, restored in `pass-summary.ts`.
- **Event sequencing across moves:** idea moves sequence from
  `state.events`, so act events are folded into the working state's log
  before the idea move runs — no seq collisions, one persistence, identical
  narratives in both runners.

## 6. Known limits / next steps

- The act phase **re-checks**; it does not re-plan. A repair that needs new
  parts or a new pin strategy beyond the deterministic fixer's vocabulary
  still ends in the human review ask (by design — that is the escalation).
- Revalidation is engine-only. If model review should also re-run mid-loop,
  it needs its own budget/cost gate (`BEDROCK` spend per pass), not a flag
  flip.
- `reprove` uses the host-shim emulator: sketches leaning on unstubbed APIs
  fall back to static proofs and say so (`static only` in the record). The
  deeper fix is the headless simulator runner (gap-analysis priority 1) —
  the act phase is the seam it should plug into: a `simulate` move with the
  same fingerprint/budget/record discipline.
- The ledger is capped at 20 records per project; older moves survive only
  as `everflow_move` events in the (capped) event log.
- Cross-pass learning (which move kinds pay off per project class) is not
  recorded anywhere yet — that belongs to the self-learning graph direction.
