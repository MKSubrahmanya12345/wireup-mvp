# Scope — the SPICE-flavored batch (active semiconductors)

**Branch:** `arena/01a0875b-wireup-mvp` · **Date:** 2026-09-10
**Status:** scoped, not implemented. Waiting on tier approval before any code.

This is the scoping you asked for before touching the parts that simulate
through Velxio's **circuit solver** rather than the part-behaviour registry the
previous two batches used.

---

## 1. What "SPICE-flavored" actually is (the discovery)

Velxio has **two** simulation layers, and batch 1/2 only used one:

| | Layer A: `PartSimulationRegistry` | Layer B: the SPICE solve |
| --- | --- | --- |
| What | Per-part JS behaviour (a servo turns, a DHT22 answers) | A real circuit solve — **ngspice compiled to WASM** (`NgSpiceWorkerAdapter` in prod, node adapter in tests) |
| Coverage | 75 registered ids | 77 netlist-mapped ids (`componentToSpice.ts` `MAPPERS`) |
| MCU coupling | Pins → part logic | Mixed-mode co-sim: MCU GPIOs become voltage sources on nets; ADC inputs read **solved net voltages** (`MixedModeScheduler` → `SpiceResolvedPinResolver`) |

The decisive quote is in `simulation/parts/ActiveParts.ts`:

> "Velxio always runs SPICE so every circuit is solved with real-world fidelity
> … These parts are intentionally **not** registered in `PartSimulationRegistry`
> … the generic self-managed rule in `SimulatorCanvas` already treats every
> SPICE-mapped component (via `isSpiceMapped()`) as authoritative-to-SPICE."

So a transistor or optocoupler "doing nothing" in the registry is **by design**:
it is solved as a circuit, and its pins feed the MCU through the resolver.
`MAPPERS` already contains real models: BJTs, MOSFETs, diodes, Zener, optos,
op-amps (with an `lm358Subckt`), regulators, batteries, the L293D (a behavioural
H-bridge: `OUT = u(EN−T)·u(IN−T)·V_motor`), power supply, signal generator.

Precedent for gating this: upstream's own `spice-model-coverage.test.ts` —
"a part that defers to the circuit must have a circuit to defer to."

## 2. A correction to batch 1 the scoping uncovered

Batch 1's gate counted runtime-definable tags with a literal
`customElements.define('…')` scan. Five element files
(`TransistorElements.ts`, `DiodeElements.ts`, `OpAmpElements.ts`,
`PowerElements.ts`, `LogicICElements.ts`) define theirs through a local
`def(tag, cls)` helper — **invisible to the regex**. All 36 "missing" elements
(BJTs, MOSFETs, diodes, Zener, photodiode, 74HC ICs, op-amps, regulators,
batteries, signal generator, power supply) are in fact defined, and **all 156
metadata ids are runtime-definable** in the pinned build.

The error was conservative — no catalog claim ever pointed at a dead part —
but the gate must still be fixed to see helper-based definitions, and the
"37 not runtime-definable" statements in the batch-1 handoff are superseded
by this document.

## 3. Claimability buckets (evidence per part)

**Tier S — SPICE-mapped + element defined → claimable**, with the note standard
changed to *"circuit-level model (netlist). No behavioural logic: a solved
voltage, not a datasheet."* Exact element pins verified in source:

| Family | Velxio ids | Element pins (from source) |
| --- | --- | --- |
| Optocouplers | `opto-4n25`, `opto-pc817` | `AN`, `CAT`, `COL`, `EMIT` |
| BJTs | `bjt-2n2222/2n3055/2n3906/bc547/bc557` | `C`(60,0), `B`(0,36), `E`(60,72) |
| MOSFETs | `mosfet-2n7000/irf540/irf9540/fqp27p06` | `D`, `G`, `S` |
| Diodes | `diode-1n4007/1n4148/1n5817/1n5819`, `zener-1n4733` | `A`, `C` |
| Regulators | `reg-7805/7812/7905/lm317` | `VIN`, `GND` (or `ADJ`), `VOUT` |
| Batteries | `battery-9v`, `battery-aa`, `battery-coin-cell` | `+`, `−` (U+2212!) |
| Op-amps | `opamp-ideal/lm358/lm741/lm324/tl072` | `IN+`, `IN−`, `OUT` |
| L293D | `motor-driver-l293d` | DIP-16, behavioural H-bridge in netlist |

**Dead on the canvas — stays unclaimed:**

- **`relay`** — element renders, appears in the documentation-only
  `ACTIVE_METADATA_IDS`, but has **no SPICE mapper and no registry behaviour**.
  Batch 1's relay-module note claimed the bare model is "switched by real coil
  current" — that overstated it. The note gets corrected as part of this batch.
- **Generic `diode`, `photodiode`** — no netlist mapper (`photodiode` is a
  registry hybrid; re-verify at implementation).
- **Bench instruments** (`power-supply`, `signal-generator` — same verdict as
  the IR remote: test equipment, not build hardware) and the **74HC logic ICs**
  (breadboard education, not project components).

## 4. Proposed Wireup batch

**Claims on existing entries (flip + honest note):**

| Catalog id | Velxio part | Note must say |
| --- | --- | --- |
| `diode-1n4007` | `wokwi-diode-1n4007` | forward drop + reverse blocking solved as a circuit; no power/thermal limits |
| `battery-9v` | `wokwi-battery-9v` | ideal-ish source with the element's internal resistance; capacity is not modelled — the 9 V won't "run out" |
| `regulator-lm7805` | `wokwi-reg-7805` | solved output rail; dropout and thermal shutdown are not modelled |

**New catalog entries (this is the real payload — Wireup has zero bare
semiconductors today, yet its own notes keep telling users to add them):**

| Proposed id | Velxio part | Why it earns its place |
| --- | --- | --- |
| `diode-1n4148` | `wokwi-diode-1n4148` | the small-signal/flyback diode every relay/solenoid note references |
| `diode-1n5819` | `wokwi-diode-1n5819` | Schottky: low-drop rectification, reverse-polarity protection |
| `transistor-2n2222` | `wokwi-bjt-2n2222` | the default "drive it with an NPN" part; complements `mosfet-module-irf520` |
| `mosfet-2n7000` | `wokwi-mosfet-2n7000` | logic-level NMOS — the one that actually switches from a 3.3 V/5 V GPIO |
| `mosfet-irf540` | `wokwi-mosfet-irf540` | power NMOS — with the honesty trap below |
| `optocoupler-pc817` | `velxio-opto-pc817` | isolation for the mains-side projects the relay entry targets; input side needs its series resistor (catalog `requiresSeriesResistor`) |

**Deliberately excluded, with reasons:** `battery-holder-4xAA` (the element is
a *single* 1.5 V cell — claiming the 6 V holder would fake its voltage),
PNP/fqp27p06 (niche; planner complexity — tier-2 candidate), op-amps (same),
L293D claim (its driver solves, but the attached DC motor has **no
electromechanical model** — a spinning nothing; defer until we decide how to
phrase that note), IRF9540 (PMOS power, same tier-2).

**The IRF540 honesty trap (must be in the entry):** it is *not* logic-level —
RDS(on) is specified at VGS = 10 V; a 3.3 V GPIO half-enhances it and it burns.
The entry carries `logicLevelGate: false` + a caution; the 2N7000/FQP27P06 are
the logic-level parts. This is exactly the "confident answer with no basis"
failure the registry exists to prevent — pre-empted at authoring time.

## 5. Machinery changes required (the actual cost)

1. **Gate definability fix** — scan `^def\('…'\)` helper definitions in
   `velxio-components/*.ts` in addition to `customElements.define`. Verify the
   new total is 156/156 metadata ids definable.
2. **`velxio-parts.ts` third tier** — `VELXIO_SPICE_METADATA_IDS` (the 77-id
   `MAPPERS` list, re-derived by the gate from `componentToSpice.ts` both
   directions, like the registry tier).
3. **`checkSimulatorClaims`** — accept tier S when the id is SPICE-mapped and
   its element is definable.
4. **Exporter mappings** (`METADATA_BY_WOKWI_TYPE`) for the seven new part
   types + the three claims; **pin maps** in `wokwi.ts`:
   `A/C→A/C`, `VIN→VIN`, `+5V→+`, diode `K→C`, PC817 `ANODE→AN`, `CATHODE→CAT`,
   `COLLECTOR→COL`, `EMITTER→EMIT`, BJT `C/B/E` 1:1, MOSFET `D/G/S` 1:1,
   regulator `IN→VIN`, `OUT→VOUT`. Battery minus is U+2212 — the exporter's
   polarity-refinement machinery already handles a U+2212 rename (the
   electrolytic capacitor precedent).
5. **e2e gate extension** — new parts project with wires (they have no
   behaviour to assert from the TS side; the claim standard for tier S is
   render + netlist mapping + honest note).
6. **Note corrections** — relay module note softened to the verified truth.
7. **No new shims** — bare semiconductors declare no libraries. Lighter than
   batches 1–2.

## 6. Effort and order

Roughly one batch-2-sized change: machinery (~7) → claims on existing (3) →
seven new entries with researched currents/packages (the long pole; same
datasheet-first discipline as always) → pin maps → gates → docs.

Gate list is unchanged: `verify:simulator` (extended), `verify:cad-link`
(derived tier covers new parts), `verify:contracts` (nonsense-input checks for
the new entries), `typecheck`, `verify:offline`, `verify:behavioral`, `build`.

## 7. Decision points before implementation

1. **Tier S standard approved?** `supported: true` for circuit-level-only parts
   with the mandatory "no behavioural logic" note.
2. **Scope:** the 3 claims + 7 new parts above, or trim/add (PNP, op-amp, L293D
   claim are the candidates)?
3. **`transistor-bc547` vs `2n2222`:** I propose one small-signal NPN (2N2222)
   to avoid two near-identical entries; say the word if you want both.

---

## 8. Execution record (same day — approved on all three decision points)

Decisions taken as proposed: tier-S standard adopted, the 3+7 scope shipped,
one small-signal NPN (2N2222).

**Machinery**
- Gate definability scan covers both registration styles
  (`customElements.define` + the local `def(tag, cls)` helper): 91 → **127**
  runtime-definable tags; all 156 metadata ids placeable, verified.
- `VELXIO_SPICE_METADATA_IDS` (77 ids) and `VELXIO_SPICE_RUNTIME_ONLY_IDS`
  (6 ids: ammeter/voltmeter bench instruments, `resistor-us`, the three
  `analog-*` boardless aliases) added; the gate re-derives the mapper set from
  `componentToSpice.ts` both directions. The first run failed exactly as
  designed — six mapper ids missing from my static tier — before I exempted the
  runtime-injected ones.
- `refinePart` now matches refinements against the **metadataId first**,
  instance id second: a hand-made instance id ("bat-1") must not skip a pin
  rename the part type itself calls for. Caught by the battery U+2212 check —
  the element's minus is a true minus, renamed in the .vlx (verified).
- `checkSimulatorClaims` accepts the SPICE tier; the relay note was corrected
  (the bare relay element neither registers behaviour nor maps to the netlist —
  it only draws).

**Catalog (105 parts, new `discrete` category)**
- Claims: `diode-1n4007`, `battery-9v`, `regulator-lm7805` (tier-S notes).
- New: `diode-1n4148`, `diode-1n5819` (power), `transistor-2n2222`,
  `mosfet-2n7000`, `mosfet-irf540`, `optocoupler-pc817` (discrete), each with
  the IRF540 gate-drive trap, the 2N7000 3.3 V marginality, the PC817 CTR rank
  budget and series-resistor requirement stated.
- Role map: `discrete → 'passive'` (the exhaustive `ROLE_BY_CATEGORY` record
  the typecheck caught — categories are load-bearing, not cosmetic).

**Numbers after the SPICE batch: 105 catalog parts · 54 simulator claims ·
54 exporter mappings · 10 board mappings · e2e 50 peripherals / 94 wires with
zero drops · CAD 105/105 previewable · contracts 28/28 · behavioral 19/19 ·
typecheck/build clean.**

The tier-S boundary now covers all three simulation styles in the vendored
build: behaviour-registered (75), netlist-mapped (77, six runtime-only), and
render-only wiring media. Everything else stays honestly unclaimed with reasons.
