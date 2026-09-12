/**
 * Quantity-delivery + coverage-honesty verifier.
 *
 *   pnpm verify:quantities
 *
 * This is the regression test for a specific, reproducible failure: a prompt
 * for a line-following robot ("It should follow a black line on white floor",
 * "Build a line following robot…") produced a design with NO sensors, NO
 * follow logic, and a validation report that said everything was fine.
 *
 * Two independent things were wrong and both are locked down here:
 *
 *   1. Requirement coverage was circular. It matched the brief against a
 *      corpus that included the generated file's own header — which restates
 *      the brief — and the generated build guide, which is written *from* the
 *      brief. The agent quoted the requirement back at itself and scored 5/5.
 *   2. Nothing counted parts. "3 IR sensors" was recorded in `quantities` and
 *      then never checked against the bill of materials, so delivering zero
 *      was indistinguishable from delivering three.
 *
 * What this script proves:
 *
 *   1. comments are stripped before any text-matching pass reads the firmware;
 *   2. a requirement covered ONLY by the file header is now uncovered;
 *   3. the line-following phrasings that used to miss are detected;
 *   4. a stated quantity the design omits is reported, with a severity;
 *   5. end to end: the originally-broken prompt now builds sensors and follow
 *      logic, and validates clean;
 *   6. end to end: an under-delivered build is caught and the fixer repairs it
 *      to the stated count — and does not stop one part short.
 *
 * Needs no credentials, no MongoDB and no network. Exits 0 / 1.
 */

/* Run offline: force Bedrock lookups to fail fast so the deterministic path is used. */
import { applyOfflineEnv, initialProject, installOfflineDns } from './lib/offline';

installOfflineDns();
applyOfflineEnv({ accessKeyId: 'AKIAQUANTITYCHECK' });

const NOISE = /amazonaws\.com|EAI_AGAIN|Bedrock|MONGODB_URI|ECONNREFUSED|serverSelectionTimeoutMS/;
for (const channel of ['log', 'warn', 'error', 'debug'] as const) {
  const original = console[channel].bind(console);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console[channel] = (...args: any[]): void => {
    if (NOISE.test(args.map((entry) => String(entry)).join(' '))) return;
    original(...args);
  };
}

import type { ComponentDefinition, ComponentSelection } from '@/types/component';

import { AgentEventLog } from '@/lib/logging/events';

import { stripCodeComments } from '@/modules/code-generator/comments';
import { analyzeCoverage, normalizeRequirements, understandPrompt } from '@/modules/project-understanding';
import { buildRefreshers, refreshSoftware } from '@/modules/orchestrator/context';
import { runPipeline } from '@/modules/orchestrator/pipeline';
import { fixProject } from '@/modules/fixer';
import { evaluateQuantityDelivery, shortfallSeverity } from '@/modules/validator/quantities';
import { validateProject } from '@/modules/validator';

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

/* The exact header the sketch builder writes at the top of every file. */
const HEADER = `/*
 * Build a line following robot with two DC motors, an L298N driver, 3 IR sensors
 * Behaviours:
 *   - It should follow a black line on white floor
 */
// >>> WIREUP PIN MAP >>>
const int PIN_IR_OBSTACLE_SENSOR_1_OUT = 4;
void loop() { setMotor(1); }
`;

/* 1. Comment stripping ----------------------------------------------------- */
heading('1. firmware comments are stripped before text matching');
{
  const stripped = stripCodeComments(HEADER);
  check(!stripped.includes('black line'), 'the header that echoes the brief is removed');
  check(!stripped.includes('It should follow'), 'behaviour restatement is removed');
  check(stripped.includes('PIN_IR_OBSTACLE_SENSOR_1_OUT'), 'real code survives stripping');
  check(stripped.includes('setMotor(1)'), 'function bodies survive stripping');

  const literals = stripCodeComments('const char *u = "http://x//y"; // note\nconst char c = \'/\';\n');
  check(literals.includes('"http://x//y"'), 'a `//` inside a string literal is not a comment');
  check(literals.includes("c = '/'"), "a `/` inside a char literal is not a comment");
  check(HEADER.split('\n').length === stripped.split('\n').length, 'line numbering is preserved');
}

/* 2. Coverage is no longer satisfied by the header -------------------------- */
heading('2. a requirement covered only by the header is uncovered');
{
  const analysis = understandPrompt('Build a line following robot with 3 IR sensors.', new AgentEventLog());
  const requirements = normalizeRequirements({}, {
    prompt: 'Build a line following robot with 3 IR sensors.',
    analysis: analysis.analysis,
    draft: analysis.requirementsDraft,
  });
  const statement = { ...requirements, requirements: ['It should follow a black line on white floor'] };

  const withHeader = analyzeCoverage({ requirements: statement, searchCorpus: HEADER });
  const designOnly = analyzeCoverage({ requirements: statement, searchCorpus: stripCodeComments(HEADER) });

  check(withHeader.uncovered.length === 0, 'sanity: including the header did cover it (the old bug)');
  check(
    designOnly.uncovered.length === 1,
    'with the header stripped the requirement is reported uncovered',
    `uncovered=${JSON.stringify(designOnly.uncovered)}`,
  );
}

/* 3. Feature detection for the phrasings that used to miss ------------------ */
heading('3. line-following phrasings are detected');
{
  const phrasings = [
    'Build a line following robot with 3 IR sensors',
    'Build a line follower robot with 3 IR sensors',
    'a robot that can follow the black line',
    'line tracking sensor car',
  ];
  for (const phrasing of phrasings) {
    const analysis = understandPrompt(phrasing, new AgentEventLog());
    check(
      analysis.requirementsDraft.features.includes('line_following'),
      `"${phrasing}" detects line_following`,
      `features=${JSON.stringify(analysis.requirementsDraft.features)}`,
    );
  }

  const negative = understandPrompt('Build an IoT temperature monitor with a DHT22 and ESP32', new AgentEventLog());
  check(
    !negative.requirementsDraft.features.includes('line_following'),
    'an unrelated brief does not gain a line_following feature',
  );

  /* The gerund case must also populate the quantity key, or the sensors never
   * get selected even once the feature is recognised. */
  const gerund = understandPrompt('Build a line following robot with 3 IR sensors', new AgentEventLog());
  check(
    gerund.requirementsDraft.quantities?.ir_sensors === 3,
    'the gerund phrasing populates the ir_sensors quantity',
    `quantities=${JSON.stringify(gerund.requirementsDraft.quantities)}`,
  );
}

/* 4. Shortfall reporting ---------------------------------------------------- */
heading('4. stated quantities are counted, not assumed');
{
  const catalog = [
    { id: 'hc-sr04-ultrasonic', name: 'HC-SR04', category: 'sensor' },
    { id: 'dc-motor-generic-6v', name: 'DC motor', category: 'motor', motorRequirements: { motorType: 'dc' } },
  ] as unknown as ComponentDefinition[];

  const requirements = {
    quantities: { ultrasonic_sensors: 4, sensors: 4 },
    features: ['distance'],
  } as never;

  const none = evaluateQuantityDelivery({ requirements, selections: [], catalog });
  check(none.length === 1, 'a missing family is reported');
  check(none[0]?.missing === 4, 'the shortfall is the full stated count', `missing=${none[0]?.missing}`);
  check(shortfallSeverity(none[0]!) === 'error', 'a total miss of a stated count is blocking');
  check(none[0]?.suggestedComponentId === 'hc-sr04-ultrasonic', 'the brief\'s own feature names a repair part');

  const partial = evaluateQuantityDelivery({
    requirements,
    selections: [{ componentId: 'hc-sr04-ultrasonic', quantity: 3 }] as never,
    catalog,
  });
  check(partial[0]?.missing === 1, 'a partial shortfall reports only the gap');
  check(shortfallSeverity(partial[0]!) === 'warning', 'being short by one is a warning, not a blocker');

  const complete = evaluateQuantityDelivery({
    requirements,
    selections: [{ componentId: 'hc-sr04-ultrasonic', quantity: 4 }] as never,
    catalog,
  });
  check(complete.length === 0, 'a correctly delivered quantity reports nothing');

  const uncounted = evaluateQuantityDelivery({
    requirements: { quantities: {}, features: [] } as never,
    selections: [],
    catalog,
  });
  check(uncounted.length === 0, 'a brief that counted nothing is left to the other rules');
}

/* 5-6. End to end ----------------------------------------------------------- */
async function build(prompt: string) {
  const events = new AgentEventLog();
  const pipeline = await runPipeline({ project: initialProject('verify-quantities', prompt), events });
  return { ...pipeline, events };
}

async function main(): Promise<void> {
  /* 5. The originally-broken prompt ---------------------------------------- */
  heading('5. end to end: the brief that used to build a sensor-less robot');
  {
    const prompt =
      'Build a line following robot with two DC motors, an L298N driver, 3 IR sensors and an Arduino Uno. It should follow a black line on white floor.';
    const built = await build(prompt);
    const sensors = built.project.components.filter((selection) => selection.category === 'sensor');

    check(sensors.length > 0, 'the design contains at least one sensor', `sensors=${sensors.length}`);
    check(
      sensors.reduce((sum, selection) => sum + selection.quantity, 0) >= 3,
      'all three requested sensors are selected',
      `count=${sensors.reduce((sum, s) => sum + s.quantity, 0)}`,
    );

    const sketch = built.project.artifacts.code?.files?.[0]?.content ?? '';
    check(/steer|LINE|lost|LOST/i.test(sketch), 'the firmware contains follow logic, not an empty skeleton');
    check(
      /digitalRead\(\s*SENSOR_PINS/.test(sketch) || /digitalRead\(\s*PIN_/i.test(sketch),
      'the firmware actually reads the sensor pins',
      `sketch has ${(sketch.match(/digitalRead\(/g) ?? []).length} digitalRead call(s)`,
    );
    check(/lineSeen/.test(sketch), 'the samples feed line state rather than being discarded');

    const outcome = await validateProject({
      project: built.project,
      catalog: built.context.catalog,
      catalogContext: built.context.fullCatalogContext,
      mcuContext: built.context.mcuContext,
      iteration: 0,
      events: built.events,
      enableModelReview: false,
    });
    check(outcome.result.passed, 'and it validates clean', JSON.stringify(outcome.result.summary));
  }

  /* 6. Under-delivery is caught and repaired -------------------------------- */
  heading('6. end to end: an under-delivered build is caught and repaired');
  {
    const prompt = 'Build a parking sensor with 4 ultrasonic sensors and an Arduino Mega.';
    const built = await build(prompt);
    const catalog = built.context.catalog;

    const countSensors = (selections: ComponentSelection[]): number =>
      selections
        .filter((selection) => selection.category === 'sensor')
        .reduce((sum, selection) => sum + selection.quantity, 0);

    const before = countSensors(built.project.components);

    const first = await validateProject({
      project: built.project,
      catalog,
      catalogContext: built.context.fullCatalogContext,
      mcuContext: built.context.mcuContext,
      iteration: 0,
      events: built.events,
      enableModelReview: false,
    });

    const shortfall = first.result.issues.filter((issue) => issue.code === 'quantity_shortfall');
    check(shortfall.length === 1, 'the validator reports the shortfall', `issues=${first.result.issues.map((i) => i.code)}`);
    check(
      shortfall[0]?.severity === 'error',
      'the shortfall blocks the run rather than passing silently',
      `severity=${shortfall[0]?.severity}`,
    );

    const fix = await fixProject({
      project: built.project,
      validation: first.result,
      catalog,
      catalogContext: built.context.fullCatalogContext,
      mcuContext: built.context.mcuContext,
      iteration: 0,
      events: built.events,
      enableLlmFixer: false,
      refresh: {
        ...buildRefreshers({ catalog, baseline: built.project, analysis: built.analysis, events: built.events }),
        software: (candidate) => refreshSoftware(candidate, catalog, built.events),
      },
    });

    const after = countSensors(fix.project.components);
    check(after > before, 'the fixer adds the missing hardware', `${before} -> ${after}`);
    check(
      after === 4,
      'the repair reaches the stated count, not one short',
      `delivered=${after} of 4 (add_component treats quantity as a target, not a delta)`,
    );

    const second = await validateProject({
      project: fix.project,
      catalog,
      catalogContext: built.context.fullCatalogContext,
      mcuContext: built.context.mcuContext,
      iteration: 1,
      events: built.events,
      enableModelReview: false,
    });
    check(
      second.result.issues.filter((issue) => issue.code === 'quantity_shortfall').length === 0,
      'the shortfall is gone after the repair',
      `remaining=${second.result.issues.map((i) => i.code)}`,
    );
  }

  /* Result ----------------------------------------------------------------- */
  console.log('');
  for (const entry of failures) console.log(`  FAIL  ${entry}`);
  console.log(`\n${passes.length} passed, ${failures.length} failed`);

  if (failures.length > 0) {
    console.log('\n✗ quantity delivery regression');
    process.exit(1);
  }
  console.log('✓ the validator counts parts and the brief is honoured');
}

void main().catch((error) => {
  console.error('\nverifier crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
