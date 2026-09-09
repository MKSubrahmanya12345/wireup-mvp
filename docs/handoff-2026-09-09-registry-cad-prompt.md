# Kickoff prompt for the next chat

Copy everything below the line into a fresh session.

---

You are continuing a long-running workstream on the WireUp repo, branch
`arena/01a086c1-wireup-mvp`. Read `docs/handoff-2026-09-09-registry-cad-saga.md`
first — it is the full handoff and it is accurate as of commit `ae472d7`.

**The saga.** WireUp turns a plain-language description of a machine into a
build an engineer would sign off on. Two registries make that possible and they
are linked by a single shared component id (`ComponentDefinition.id ===
CadComponentSpec.id`):

- the **electrical registry** (`src/modules/components/*`) — pins, current,
  voltage, control signal, libraries, incompatibilities;
- the **CAD registry** (`cad-helper/*`) — real millimetre geometry and pin
  anchor positions.

My standing request is to research both sides from primary sources and expand
them with utmost perfection — DC motors, servos, fans, propellers, and every
other component — **incrementally, batch after batch**. This is ongoing work,
not a one-shot task. Currently at 86 components: all previewable, all anchors
matching, 1 reference / 22 preset / 63 derived.

**The principle that governs every decision here:** a registry that guesses
confidently is worse than a registry with holes. Every bug found so far has
been the same bug — the system produced a confident answer with no basis for
one (a matcher scoring 123 on a 100-point scale; alias "uno" matching inside
"unobtainium"; a 5 A motor handed a 2 A driver). So when you add any matcher,
fallback or defaulting rule, **test it against nonsense input, not just
plausible input**, and make sure that when it does not know, it says so.

**Hard constraint:** the admin panel and the 3D CAD helper are finished and
correct. Do not regress them. Extend around them.

**Before any commit, all of these must pass:**
`pnpm typecheck`, `pnpm verify:contracts` (28/28), `pnpm verify:cad-link`,
`pnpm verify:offline`, `pnpm verify:behavioral` (19/19), `pnpm build`.
There is no `pnpm lint`.

**Start here** (details and the full next-steps list are in §6 of the handoff):

1. Wire the ten new driver/motor ids into the `defaults.ts` candidate lists —
   they exist in the catalog but are unreachable through feature defaults.
2. Then begin the next expansion batch. I specifically want **fans and
   propellers** covered, plus BLDC motors and ESCs. Follow the per-batch method
   in §6: check the demand report for evidence, research from datasheets and
   vendor hookup guides, author registry entry + CAD spec sharing one id, add a
   contract if the part reveals a family with no fallback, add a firmware shim
   header if it declares a new library, run every gate, and write the commit
   message around the harm avoided rather than the diff.

Work in reasonably sized batches, commit each one on this branch, and tell me
plainly what you found — especially anything you had to reject or correct,
including in my own instructions or in the existing tests.
