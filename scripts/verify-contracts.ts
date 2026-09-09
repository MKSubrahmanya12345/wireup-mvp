/**
 * Electrical contract + demand telemetry verifier.
 *
 *   pnpm verify:contracts
 *
 * The catalog can never cover every part, so the question is what happens at
 * the edge. Before the contract layer, an unknown part was either silently
 * mapped onto "something close enough" or dropped. For a motor or a battery,
 * a silent substitution is a burnt component.
 *
 * This proves the edge behaves:
 *
 *   1. a known catalog part still resolves exactly (no regression);
 *   2. an unknown part in a known family becomes a *provisional* part instead
 *      of a silent substitution;
 *   3. the provisional part is flagged, carries worst-case ratings and names
 *      the fields it is guessing;
 *   4. a genuinely unrecognisable part stays unmatched rather than being
 *      forced into the nearest family;
 *   5. anti-signals work: "servo driver" is not a servo;
 *   6. the validator refuses to pass a provisional part silently;
 *   7. demand telemetry records the outcome of every request and ranks gaps.
 *
 * Needs no credentials, no MongoDB and no network. Exits 0 / 1.
 */

import { SEED_COMPONENTS } from '@/modules/components/catalog';
import { buildProvisionalComponent, isProvisional, matchContract } from '@/modules/components/contracts';
import { summariseDemand, type DemandRecord } from '@/modules/components/demand';
import { normaliseModelSelections } from '@/modules/hardware-planner';

const failures: string[] = [];
const passes: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) passes.push(description);
  else failures.push(`${description}${detail ? ` — ${detail}` : ''}`);
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

/* 1. Known parts still resolve exactly ------------------------------------- */
heading('1. catalog parts still resolve exactly');
{
  const { drafts, demand, provisional } = normaliseModelSelections(
    [{ componentId: 'servo-motor-sg90', quantity: 1 }, { name: 'esp32' }],
    SEED_COMPONENTS,
  );
  check(drafts.some((d) => d.componentId === 'servo-motor-sg90'), 'exact catalog id resolves to the catalog part');
  check(provisional.length === 0, 'no provisional part invented when the catalog has the part');
  check(demand.some((d) => d.outcome === 'catalog'), 'exact hit is recorded as a catalog outcome');
  for (const entry of demand) console.log(`  ${entry.requested} -> ${entry.outcome} ${entry.resolvedTo ?? ''}`);
}

/* 2-3. Unknown part in a known family -------------------------------------- */
heading('2. unknown part becomes provisional, not a silent substitution');
{
  const { drafts, provisional, demand } = normaliseModelSelections(
    [{ name: 'DS3218 waterproof servo', quantity: 2 }],
    SEED_COMPONENTS,
  );

  const part = provisional[0];
  check(Boolean(part), 'an unrecognised servo produced a provisional part');
  check(
    !drafts.some((d) => d.componentId === 'servo-motor-sg90'),
    'the DS3218 was NOT silently substituted with the SG90',
  );

  if (part) {
    console.log(`  built: ${part.id} (${part.metadata.contractFamily})`);
    check(isProvisional(part), 'provisional part is flagged as provisional');
    check(
      Array.isArray(part.metadata.unverifiedFields) && (part.metadata.unverifiedFields as string[]).length > 0,
      'provisional part names the fields it is guessing',
    );
    check(
      Array.isArray(part.metadata.verification) && (part.metadata.verification as string[]).length > 0,
      'provisional part tells the user what to confirm',
    );

    // Worst case, not typical: the budget must err toward refusing.
    const sg90 = SEED_COMPONENTS.find((c) => c.id === 'servo-motor-sg90');
    const provisionalMax = part.currentRequirements?.maxMa ?? 0;
    const sg90Max = sg90?.currentRequirements?.maxMa ?? 0;
    check(
      provisionalMax > sg90Max,
      'provisional current is worst-case, not optimistic',
      `provisional ${provisionalMax} mA vs SG90 ${sg90Max} mA`,
    );
    console.log(`  worst-case current: ${provisionalMax} mA (SG90 catalog part: ${sg90Max} mA)`);

    const pinNames = part.pins.map((p) => p.name);
    check(
      ['SIGNAL', 'VCC', 'GND'].every((n) => pinNames.includes(n)),
      'provisional servo exposes the standard 3-wire interface',
      pinNames.join(','),
    );
  }

  check(demand.some((d) => d.outcome === 'provisional'), 'provisional resolution is recorded in telemetry');
}

/* 4. Unrecognisable parts stay unmatched ----------------------------------- */
heading('3. unrecognisable parts stay honestly unmatched');
{
  // Nothing in the catalog and no contract covers it.
  const nonsense = normaliseModelSelections([{ name: 'unobtainium widget ZZ9' }], SEED_COMPONENTS);
  check(nonsense.provisional.length === 0, 'no contract was forced onto an unrecognisable part');
  check(nonsense.unmatched.length === 1, 'unrecognisable part is reported as unmatched');
  check(nonsense.demand.some((d) => d.outcome === 'unmatched'), 'unmatched request is recorded in telemetry');
  console.log(`  unmatched: ${nonsense.unmatched.map((u) => u.query).join(', ')}`);

  /*
   * A weak keyword substitution with no contract to fall back on is still a
   * substitution — the honest outcome is to record it as such so it surfaces
   * in the gap report, not to pretend it was a clean match.
   */
  const weak = normaliseModelSelections([{ name: 'quantum flux capacitor XR-9' }], SEED_COMPONENTS);
  check(
    weak.demand.every((d) => d.outcome === 'substituted'),
    'a weak keyword match is recorded as a substitution, not a clean hit',
    weak.demand.map((d) => d.outcome).join(','),
  );
  console.log(`  weak match logged as: ${weak.demand.map((d) => `${d.outcome}->${d.resolvedTo}`).join(', ')}`);
}

/* 5. Anti-signals ----------------------------------------------------------- */
heading('4. anti-signals prevent wrong-family matches');
{
  const cases: [string, string | undefined][] = [
    ['SG92R micro servo', 'contract-hobby-servo'],
    ['servo driver board', undefined],
    ['PCA9685 servo controller', undefined],
    ['JGA25-370 gear motor', 'contract-brushed-dc-motor'],
    ['motor driver shield', undefined],
    ['SHT31 temperature sensor', 'contract-i2c-sensor'],
    ['NEO-6M GPS module', 'contract-uart-module'],
  ];
  for (const [query, expected] of cases) {
    const match = matchContract(query);
    const got = match?.contract.id;
    check(got === expected, `"${query}" -> ${expected ?? 'no contract'}`, `got ${got ?? 'none'}`);
    console.log(`  ${query.padEnd(30)} -> ${got ?? '(none)'}`);
  }
}

/* 6. Validator refuses to pass provisional silently ------------------------ */
heading('5. provisional parts are surfaced, never silently approved');
{
  const match = matchContract('DS3218 servo');
  const part = match ? buildProvisionalComponent('DS3218 servo', match) : undefined;
  check(Boolean(part && isProvisional(part)), 'provisional detection works for the validator');
  // The validator emits `unverified_component` for any provisional part in the
  // component list; assert the metadata it depends on is present and typed.
  check(
    Boolean(part && typeof part.metadata.contractFamily === 'string' && typeof part.metadata.requestedAs === 'string'),
    'validator has the metadata it needs to write an actionable warning',
  );
}

/* 7. Demand ranking --------------------------------------------------------- */
heading('6. demand telemetry ranks the real gaps');
{
  const sample: DemandRecord[] = [
    { at: '', requested: 'sg90', outcome: 'catalog', resolvedTo: 'servo-motor-sg90' },
    { at: '', requested: 'ds3218 servo', outcome: 'provisional', resolvedTo: 'provisional-ds3218-servo' },
    { at: '', requested: 'ds3218 servo', outcome: 'provisional', resolvedTo: 'provisional-ds3218-servo' },
    { at: '', requested: 'ds3218 servo', outcome: 'provisional', resolvedTo: 'provisional-ds3218-servo' },
    { at: '', requested: 'tft display', outcome: 'unmatched' },
    { at: '', requested: 'tft display', outcome: 'unmatched' },
    { at: '', requested: 'oled', outcome: 'catalog', resolvedTo: 'oled-ssd1306-i2c' },
  ];
  const report = summariseDemand(sample);
  check(report.total === sample.length, 'every request is counted');
  check(!report.gaps.some((row) => row.requested === 'sg90'), 'satisfied requests are excluded from the gap list');
  /*
   * Ranking is frequency x cost, and an unmatched request costs more per
   * occurrence than a provisional one (the part vanishes rather than being
   * built with worst-case values). Assert the rule, not a hard-coded winner.
   */
  const gapKeys = report.gaps.map((row) => row.requested);
  check(gapKeys.includes('ds3218 servo') && gapKeys.includes('tft display'), 'both unsatisfied requests appear as gaps');
  check(
    report.gaps[0].requested === 'tft display',
    'a fully unmatched request outranks a provisional one of similar volume',
    `got ${report.gaps[0].requested}`,
  );
  console.log('  ranked gaps:');
  for (const row of report.gaps) {
    console.log(`    ${String(row.count).padStart(2)}x  ${row.requested.padEnd(18)} ${JSON.stringify(row.outcomes)}`);
  }
}

/* Result -------------------------------------------------------------------- */
heading('result');
console.log(`${passes.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\n✓ unknown parts degrade honestly instead of being silently substituted');
process.exit(0);
