# Handoff — the firmware workbench (Cursor-for-firmware) + the host compile gate

**Branch:** `arena/01a08252-wireup-mvp`
**Date:** 2026-09-09
**Status:** typecheck clean; `verify:workbench` 30/30, `verify:llm-codegen` 32/32, `verify:offline`, `verify:firmware` 9/9, `verify:behavioral` 19/19 all pass; `next build` clean. Committed on this branch.

---

## 1. What this is

The `/project/[id]/firmware` page is now a workbench in the Cursor sense:

- **Chat** — iterate on the firmware in plain language. The model proposes a
  rooted sketch plan; Wireup re-derives the managed blocks, type-checks the
  result against the host compiler, and only then freezes a revision with a
  unified diff. Refusals (rooting violations, compile errors) never touch the
  firmware.
- **Editor** — hand edits in the file itself (transparent textarea over the
  live syntax highlighter, line numbers, error/warning gutter marks). Save
  runs the same gates: deterministic pin/include sync repairs drift, the
  compiler vetoes broken saves, applied saves become revisions.
- **Diff** — every applied change (chat or manual) carries a persisted unified
  diff rendered in the workbench; "view diff" on any message replays it.
- **Problems** — compiler diagnostics parse into a problems strip with
  jump-to-line, both under the editor and inside chat bubbles.

On the backend this lands roadmap item 3: the pipeline itself now compiles.

## 2. New pieces

| Piece | Path | Notes |
| --- | --- | --- |
| Host compile gate | `src/modules/firmware-compiler/index.ts` | `g++/clang++ -fsyntax-only` against `scripts/firmware-shim`; gcc diagnostics parsed to `{file,line,column,severity,message}`; probe cached 60 s; `WIREUP_ENABLE_FIRMWARE_COMPILE` (default on); honest `skippedReason` when unavailable. |
| Validator hook | `src/modules/validator/index.ts` §1c | Every compile error → `firmware_compile_error` issue quoting the diagnostic (feeds the LLM fixer via `details`/`fixHint`); `code.compile` check reported as skipped when the gate can't run. |
| Fixer routing | `src/modules/fixer/strategies.ts` | Explicit `firmware_compile_error` case: NO deterministic rebuild (it would discard model/human work) — the LLM fixer gets the diagnostic; offline it stays unresolved with that reason. |
| Workbench brain | `src/modules/firmware-chat/index.ts` | `runFirmwareChatTurn` + `applyManualFirmwareEdit`. Persistence-free (takes a `ProjectState`, returns the next one) so it runs offline; gates: rooting → deterministic sync → compile (with ONE diagnostics-informed repair round for chat) → diff → revision (`reason: 'firmware_edit'`). |
| Conversational provider | `src/modules/code-generator/llm.ts` | `bedrockSketchEditProvider()` — answer-vs-revise decision, full updated plan on revise, compiler diagnostics on the repair round. Same `codegen` model role. |
| Line diff | `src/lib/diff/lines.ts` | LCS with prefix/suffix trim + `collapseContext` for display; the persisted `ChatDiff` is capped at 600 lines with a `truncated` flag. |
| API | `src/app/api/projects/[id]/firmware/route.ts` | `POST {mode:'chat', message}` / `POST {mode:'manual', path, content}`; guards on running/missing firmware; persists chat + artifacts + revision; records `codegen` LLM calls. |
| Types | `src/types/project.ts` | `ChatMessage`/`ChatOutcome`/`ChatDiff(Line)`; `ProjectState.chat`; revision reason `'firmware_edit'`. Persisted via `chat: Mixed` on the mongoose document (old documents default to `[]`). |
| UI | `src/components/workspace/firmware/{ChatPane,CodeEditor,DiffView}.tsx`, rewritten `panels/FirmwarePanel.tsx`, `src/app/wireup-styles.css` (`fwb-*`) | Two-column workbench (chat ⇄ editor), stacks under 1020 px; libraries tab kept. |
| Client API | `src/components/workspace/api.ts` | `sendFirmwareChat`, `saveFirmwareFile`. |

## 3. The gates, in order (chat revise path)

1. **Rooting** — model plan → `rootLlmSketch`; hallucinated pins / foreign
   includes / contract breaches ⇒ rejected, reply explains, nothing changes.
2. **Deterministic sync** — managed includes + pin map re-derived from the
   plan, stray pin constants re-pointed, firmware hygiene. On rooted content
   these are no-ops; they exist for the manual path.
3. **Compile** — host type-check. On failure: one repair round where the
   provider re-plans with the gcc diagnostics injected. Still failing ⇒
   refused with the diagnostics quoted.
4. **Freeze** — new revision (`firmware_edit`) whose `validation` block holds
   the compile verdict; `ChatDiff` computed against the previous content and
   stored on the assistant message.

Manual saves are the same minus the model: sync repairs (a hand-edited pin
value CANNOT override the plan — the managed block is re-derived and the
repair is reported), then the compile gate vetoes broken saves (your edited
text stays in the editor).

## 4. How to prove it

```bash
npm install --no-audit --no-fund
npx tsc --noEmit
npm run verify:workbench    # 30 checks: gate + chat turns + manual saves + validator surfacing
npm run verify:llm-codegen  # 32 checks: rooting gate (unchanged, still green)
npm run verify:offline && npm run verify:firmware && npm run verify:behavioral
npm run build               # the new route + UI compile
```

`verify:workbench` covers: compile gate (clean pass, invented identifier with
line/col, flag-off honest skip), chat revise (applied as v2 `firmware_edit`
with diff + exact managed block), answer-only turn, rooting refusal (RELAY_PIN
hallucination keeps firmware untouched), compile-fail → repair round (asserts
the provider received the gcc diagnostic), manual saves (pin drift repaired +
reported, broken save refused with diagnostics, identical no-op), and the
validator emitting `firmware_compile_error`.

With Bedrock configured the chat is live; without it the turn answers honestly
and the editor/compile path still works.

## 5. Found and fixed on the way

`stripForAnalysis` (moved into `quality.ts` last branch) had a transcription
bug: the block-comment skip advanced by 2, jumping over the `*/` terminator
and swallowing the rest of the file — brace balance was silently wrong on
sketches with a file-header comment (i.e. all of them; the count came out 0
for a whole-file comment). A hand-edit test exposed it. Fixed to the original
`i += 1`; all harnesses re-run green.

## 6. Known limits / next steps

- The chat is one round-trip per turn (no streaming); latency = the Bedrock
  call. The composer shows a busy indicator.
- Only the entry sketch is editable by hand (extra model files are read-only).
- Compile gate is a host type-check against the shim, not a target build
  (no avr-gcc/ESP-IDF) — it catches undeclared identifiers, wrong argument
  types and missing prototypes, not target-specific issues. Swapping in a
  real `arduino-cli` compile is the next upgrade of the same seam.
- Chat turns don't append to the project event log yet (they have their own
  persisted transcript); the run-log page still shows pipeline events only.
