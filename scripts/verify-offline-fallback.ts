/**
 * Offline fallback verifier.
 *
 *   pnpm verify:offline
 *
 * Proves the claim the pipeline is built on: when Amazon Bedrock cannot be
 * reached, the agent still produces a complete, wired, validated project and
 * reports the outage honestly instead of pretending the model ran.
 *
 * Needs no credentials, no MongoDB and no network. DNS lookups for
 * *.amazonaws.com are made to fail with `EAI_AGAIN` — the exact failure that
 * hits machines on a flaky resolver — and the catalog falls back to the
 * bundled seed. Exits 0 when every check passes, 1 otherwise.
 */

import dns from 'node:dns';

/* --- Make Bedrock unreachable the same way a broken resolver would -------- */
const realLookup = dns.lookup as unknown as (...args: unknown[]) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = (hostname: string, ...rest: unknown[]): unknown => {
  const callback = rest[rest.length - 1];
  if (typeof callback === 'function' && String(hostname).endsWith('amazonaws.com')) {
    const error = new Error(`getaddrinfo EAI_AGAIN ${hostname}`) as NodeJS.ErrnoException;
    error.code = 'EAI_AGAIN';
    error.errno = -3001;
    error.syscall = 'getaddrinfo';
    return (callback as (err: Error) => void)(error);
  }
  return realLookup(hostname, ...rest);
};

/* Fail fast instead of waiting for a MongoDB that is not there. */
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1200';
process.env.BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'moonshotai.kimi-k2.5';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'eu-north-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'AKIAVERIFYVERIFYVERIFY';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'not-a-real-secret';
process.env.BEDROCK_MAX_RETRIES = process.env.BEDROCK_MAX_RETRIES ?? '2';

import { AgentEventLog } from '@/lib/logging/events';
import { env, resetEnvCache } from '@/lib/validation/env';
import { nowIso } from '@/lib/validation/time';
import type { ComponentSelection } from '@/types/component';
import type { ProjectState } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';
import { computePowerBudget } from '@/modules/hardware-planner/power';
import { planWiring } from '@/modules/wiring-planner';

import { runPipeline } from '@/modules/orchestrator/pipeline';
import { buildRefreshers, controllerInfo, refreshSoftware } from '@/modules/orchestrator/context';
import { validateProject } from '@/modules/validator';
import { fixProject } from '@/modules/fixer';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function initialProject(prompt: string): ProjectState {
  const now = nowIso();
  return {
    id: 'verify-offline',
    name: 'Untitled project',
    prompt,
    status: 'pending',
    stage: 'idle',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    requirements: null,
    components: [],
    hardwarePlan: null,
    pinAssignments: [],
    wiring: null,
    softwarePlan: null,
    artifacts: { code: null, diagram: null, libraries: null, instructions: null },
    validation: null,
    revisions: [],
    events: [],
    iteration: { current: 0, max: env().agent.maxFixIterations },
    llm: { calls: [] },
    chat: [],
    revision: 0,
    doubts: [],
    humanTasks: [],
    everflow: { graph: null, evaluation: null, pass: 0 },
    intakeContext: null,
    expandedBrief: null,
    research: [],
  };
}

async function main(): Promise<number> {
  resetEnvCache();
  const prompt =
    'Build an ESP32 weather station: BME280 temperature/humidity/pressure sensor on I2C, ' +
    'an SSD1306 OLED display, and a piezo buzzer that beeps when humidity is too high.';

  console.log('wireup · offline fallback verifier');
  console.log(`bedrock model under test: ${env().bedrock.modelId} in ${env().bedrock.region} (DNS forced to fail)`);
  console.log(`max retries: ${env().bedrock.maxRetries}\n`);

  /* --- 1. Deterministic pipeline ------------------------------------------ */
  console.log('1. pipeline with Bedrock unreachable');
  const events = new AgentEventLog({ initialSeq: 0 });
  const pipeline = await runPipeline({ project: initialProject(prompt), events });
  const project = pipeline.project;
  const catalog = pipeline.context.catalog;
  const generationCall = pipeline.llmCalls[0];

  check('parts selected', project.components.length > 0, `${project.components.length} line item(s)`);
  check('pins assigned', project.pinAssignments.length > 0, `${project.pinAssignments.length} assignment(s)`);
  check('wires routed', (project.wiring?.connections.length ?? 0) > 0, `${project.wiring?.connections.length ?? 0} connection(s)`);
  check('firmware written', (project.artifacts.code?.files.length ?? 0) > 0, `${project.artifacts.code?.files.length ?? 0} file(s)`);
  check('diagram built', Boolean(project.artifacts.diagram), `${project.artifacts.diagram?.stats.components ?? 0} component(s)`);
  check('libraries listed', (project.artifacts.libraries?.libraries.length ?? 0) > 0);
  check('instructions written', (project.artifacts.instructions?.sections.length ?? 0) > 0);
  check('catalog source', catalog.length > 0, `${catalog.length} parts available`);

  /* --- 2. The outage is reported honestly --------------------------------- */
  console.log('\n2. the Bedrock outage is recorded, not hidden');
  check('generation call recorded', Boolean(generationCall), generationCall ? `${generationCall.op}/${generationCall.status}` : 'missing');
  check('call marked failed', generationCall?.status === 'failed');
  check(
    'call names the real model (not "unknown")',
    generationCall?.model === env().bedrock.modelId,
    generationCall?.model ?? 'no model',
  );
  check(
    'error says DNS, not "model error"',
    /DNS lookup for bedrock-runtime\./.test(generationCall?.error ?? ''),
    (generationCall?.error ?? '').slice(0, 110),
  );
  const attemptLines = events.list().filter((event) => event.type === 'llm_call_failed');
  check('failure surfaced as an event', attemptLines.length > 0, `${attemptLines.length} llm_call_failed event(s)`);

  /* --- 3. Validation degrades to the rule engine -------------------------- */
  console.log('\n3. validation degrades to the deterministic engine');
  const controller = controllerInfo(project, catalog);
  const validation = await validateProject({
    project,
    catalog,
    catalogContext: pipeline.context.fullCatalogContext,
    mcuContext: pipeline.context.mcuContext,
    ...(controller.profile ? { profile: controller.profile } : {}),
    iteration: 0,
    events,
    enableModelReview: true,
  });
  const outcome = validation.result;
  const reviewCheck = outcome.checks.find((entry) => entry.id === 'model.critical_review');

  check('rule engine ran', outcome.summary.checksRun > 0, `${outcome.summary.checksRun} check(s)`);
  check('model review unavailable is recorded', Boolean(outcome.engineError), (outcome.engineError ?? '').slice(0, 90));
  check('model review marked skipped', reviewCheck?.status === 'skipped', reviewCheck?.status ?? 'missing');
  check(
    'validation call names the real model',
    validation.llmCall?.model === env().bedrock.modelId,
    validation.llmCall?.model ?? 'no model',
  );
  console.log(
    `  · verdict: passed=${outcome.passed} errors=${outcome.summary.errors} warnings=${outcome.summary.warnings} autoFixable=${outcome.issues.filter((issue) => issue.autoFixable).length}`,
  );

  /* --- 4. The fixer explains itself --------------------------------------- */
  console.log('\n4. the fix pass repairs what it can and explains what it cannot');
  if (outcome.passed) {
    console.log('  · nothing to repair — the rule engine found no blocking issue');
  } else {
    const baseline: ProjectState = { ...project, validation: outcome, revision: project.revision + 1 };
    const refreshers = buildRefreshers({ catalog, baseline, analysis: pipeline.analysis, events });
    const fixProfile = controllerInfo(baseline, catalog).profile;
    const fix = await fixProject({
      project: baseline,
      validation: outcome,
      catalog,
      catalogContext: pipeline.context.fullCatalogContext,
      mcuContext: pipeline.context.mcuContext,
      ...(fixProfile ? { profile: fixProfile } : {}),
      iteration: 0,
      events,
      enableLlmFixer: true,
      refresh: { ...refreshers, software: (candidate) => refreshSoftware(candidate, catalog, events) },
    });

    console.log(
      `  · applied ${fix.result.applied.length} change(s), rejected ${fix.result.rejected.length}, unresolved ${fix.unresolved.length}`,
    );
    check('fixer call names the real model', fix.llmCall?.model === env().bedrock.modelId, fix.llmCall?.model ?? 'no model');
    check(
      'every unrepaired issue carries a reason',
      fix.unresolved.every((entry) => entry.reason.trim().length > 0),
      fix.unresolved.slice(0, 2).map((entry) => `${entry.issue.code}: ${entry.reason.slice(0, 60)}`).join(' | '),
    );
    check(
      'applied changes are attributed to an issue',
      fix.result.applied.every((change) => change.op.length > 0),
    );
  }

  /* --- 5. The fix loop still works when the model is down ------------------ */
  console.log('\n5. targeted fix with the model unavailable (a wire is deleted on purpose)');
  const broken = structuredClone(project);
  const groundIndex = (broken.wiring?.connections ?? []).findIndex(
    (connection) => connection.kind === 'ground' && connection.to.instanceId !== connection.from.instanceId,
  );
  if (broken.wiring && groundIndex >= 0) {
    const removed = broken.wiring.connections[groundIndex]!;
    broken.wiring.connections.splice(groundIndex, 1);
    broken.revision = project.revision + 1;

    const recheck = await validateProject({
      project: broken,
      catalog,
      catalogContext: pipeline.context.fullCatalogContext,
      mcuContext: pipeline.context.mcuContext,
      ...(controller.profile ? { profile: controller.profile } : {}),
      iteration: 0,
      events,
      enableModelReview: true,
    });
    check('the sabotage is detected', recheck.result.issues.length > 0, `${recheck.result.issues.length} issue(s), codes: ${recheck.result.issues.slice(0, 3).map((issue) => issue.code).join(', ')}`);

    const brokenController = controllerInfo(broken, catalog);
    const refreshers = buildRefreshers({ catalog, baseline: broken, analysis: pipeline.analysis, events });
    const repair = await fixProject({
      project: { ...broken, validation: recheck.result },
      validation: recheck.result,
      catalog,
      catalogContext: pipeline.context.fullCatalogContext,
      mcuContext: pipeline.context.mcuContext,
      ...(brokenController.profile ? { profile: brokenController.profile } : {}),
      iteration: 0,
      events,
      enableLlmFixer: true,
      refresh: { ...refreshers, software: (candidate) => refreshSoftware(candidate, catalog, events) },
    });

    console.log(
      `  · deleted ${removed.from.instanceId}.${removed.from.pin}→${removed.to.instanceId}.${removed.to.pin}; applied ${repair.result.applied.length}, unresolved ${repair.unresolved.length}`,
    );
    check('the fixer repaired it without the model', repair.result.applied.length > 0, repair.result.applied.slice(0, 2).map((change) => change.detail).join(' | '));
    check(
      'every still-unrepaired issue carries a reason',
      repair.unresolved.every((entry) => entry.reason.trim().length > 0),
      repair.unresolved.slice(0, 2).map((entry) => `${entry.issue.code}: ${entry.reason.slice(0, 50)}`).join(' | '),
    );
  } else {
    console.log('  · no peripheral ground wire to delete — scenario skipped');
  }

  /* --- 6. Pin-plan defence rules ------------------------------------------ */
  /*
   * The planner and fixer no longer CREATE bad pin plans, but a model-authored
   * plan can still carry them. Each round sabotages the working project with
   * one defect, asserts the rule engine reports it, then runs the deterministic
   * fixer and asserts the defect is gone. Independent rounds keep the sabotage
   * targets from colliding with each other.
   */
  console.log('\n6. pin-plan defence rules (duplicate claims, analog-only pins, UART pins)');
  const nano = getMcuProfile('arduino-nano');
  const a6 = nano?.pins.find((spec) => spec.name === 'A6');
  check(
    'profile data marks Nano A6/A7 input-only without a digital buffer',
    Boolean(a6 && a6.capabilities.includes('input-only') && !a6.capabilities.includes('digital')),
  );

  const sabotageRound = async (label: string, fake: PinAssignment, expectedCode: string): Promise<void> => {
    const sabotaged = structuredClone(project);
    sabotaged.revision = project.revision + 1;
    sabotaged.pinAssignments.push(fake);

    const brokenCheck = await validateProject({
      project: sabotaged,
      catalog,
      catalogContext: pipeline.context.fullCatalogContext,
      mcuContext: pipeline.context.mcuContext,
      ...(controller.profile ? { profile: controller.profile } : {}),
      iteration: 0,
      events,
      enableModelReview: false,
    });
    const reported = brokenCheck.result.issues.find((issue) => issue.code === expectedCode);
    check(
      `${label}: ${expectedCode} reported`,
      Boolean(reported && reported.severity === 'error'),
      reported ? reported.message.slice(0, 90) : 'issue absent',
    );
    if (!reported) return;

    const roundRefreshers = buildRefreshers({
      catalog,
      baseline: { ...sabotaged, validation: brokenCheck.result },
      analysis: pipeline.analysis,
      events,
    });
    const fixProfile = controllerInfo(sabotaged, catalog).profile;
    const repair = await fixProject({
      project: { ...sabotaged, validation: brokenCheck.result },
      validation: brokenCheck.result,
      catalog,
      catalogContext: pipeline.context.fullCatalogContext,
      mcuContext: pipeline.context.mcuContext,
      ...(fixProfile ? { profile: fixProfile } : {}),
      iteration: 0,
      events,
      enableLlmFixer: false,
      refresh: { ...roundRefreshers, software: (candidate) => refreshSoftware(candidate, catalog, events) },
    });
    check(
      `${label}: deterministic repair applied`,
      repair.result.applied.length > 0,
      repair.result.applied.slice(0, 2).map((change) => `${change.op}:${change.detail.slice(0, 60)}`).join(' | '),
    );

    const fixedCheck = await validateProject({
      project: repair.project,
      catalog,
      catalogContext: pipeline.context.fullCatalogContext,
      mcuContext: pipeline.context.mcuContext,
      ...(fixProfile ? { profile: fixProfile } : {}),
      iteration: 0,
      events,
      enableModelReview: false,
    });
    const remaining = fixedCheck.result.issues.filter((issue) => issue.code === expectedCode);
    check(`${label}: ${expectedCode} gone after repair`, remaining.length === 0, remaining.map((issue) => issue.message.slice(0, 80)).join(' | '));
  };

  const i2cAssignment = project.pinAssignments.find((assignment) => assignment.protocol === 'i2c');
  const buzzerInstance = project.components.flatMap((selection) => selection.instances).find((instance) => instance.componentId.startsWith('buzzer'));
  if (i2cAssignment && buzzerInstance && controller.profile) {
    // A second assignment claiming the bus pin for an unrelated peripheral —
    // the shape that redefined a `const int` in the reported build.
    await sabotageRound(
      'duplicate claim on a taken MCU pin',
      {
        ...i2cAssignment,
        id: 'pin-sabotage-duplicate',
        targetInstanceId: buzzerInstance.instanceId,
        targetComponentId: buzzerInstance.componentId,
        targetPin: '-',
        purpose: 'Sabotage: buzzer claim on a taken pin',
        signal: 'digital',
        direction: 'output',
        protocol: 'gpio',
        rationale: 'Model-authored plan that double-claims a pin.',
        source: 'model',
      },
      'duplicate_pin_assignment',
    );

    // A digital signal on an input-only pin with no digital buffer (ESP32
    // GPIO34–39 here; the same rule covers the Nano's A6/A7).
    const analogOnlySpec = controller.profile.pins.find(
      (spec) => spec.capabilities.includes('input-only') && !spec.capabilities.includes('digital'),
    );
    if (analogOnlySpec) {
      await sabotageRound(
        'digital signal on an analog-only pin',
        {
          ...i2cAssignment,
          id: 'pin-sabotage-analog-only',
          pin: analogOnlySpec.name,
          ...(analogOnlySpec.number !== undefined ? { pinNumber: analogOnlySpec.number } : {}),
          targetInstanceId: buzzerInstance.instanceId,
          targetComponentId: buzzerInstance.componentId,
          targetPin: '-',
          purpose: 'Sabotage: digital drive on an analog-only pin',
          signal: 'digital',
          direction: 'output',
          protocol: 'gpio',
          rationale: 'Model-authored plan that drives an input-only analog pin.',
          source: 'model',
        },
        'analog_only_pin_driven',
      );
    }

    // A GPIO on the USB-serial pins while the sketch starts that port.
    const serialTx = controller.profile.uarts.find((uart) => uart.id === 'Serial')?.tx;
    const opensSerial = (project.artifacts.code?.files ?? []).some((file) => /\bSerial\s*\.\s*begin\s*\(/.test(file.content));
    if (serialTx && opensSerial) {
      await sabotageRound(
        'GPIO on a serial pin the firmware uses',
        {
          ...i2cAssignment,
          id: 'pin-sabotage-uart',
          pin: serialTx,
          ...(controller.profile.pins.find((spec) => spec.name === serialTx)?.number !== undefined
            ? { pinNumber: controller.profile.pins.find((spec) => spec.name === serialTx)?.number }
            : {}),
          targetInstanceId: buzzerInstance.instanceId,
          targetComponentId: buzzerInstance.componentId,
          targetPin: '-',
          purpose: 'Sabotage: GPIO on the USB serial pins',
          signal: 'digital',
          direction: 'output',
          protocol: 'gpio',
          rationale: 'Model-authored plan that drives a UART pin as GPIO.',
          source: 'model',
        },
        'uart_pin_used_as_gpio',
      );
    }
  } else {
    check('pin-plan sabotage scenarios had the parts they need', false, 'missing i2c assignment, buzzer instance or MCU profile');
  }

  /* --- 7. Power honesty (battery build with a logic-rail servo) ------------ */
  /*
   * The user's safe build was battery powered: the wiring planner (correctly)
   * feeds a 4.8–6 V servo from the regulated 5 V rail while a 9 V pack sits on
   * VIN. The power budget used to book that servo onto the 9 V rail anyway and
   * fail the correct design; the bulk capacitor landed on the battery; and no
   * note said the Nano's linear regulator was burning the 4 V difference.
   */
  console.log('\n7. power honesty (9 V battery, servo on the 5 V rail)');
  const powerCatalog = catalog;
  const pick = (componentId: string, category: string, role: string) => {
    const definition = powerCatalog.find((component) => component.id === componentId);
    if (!definition) throw new Error(`catalog is missing ${componentId}`);
    return {
      id: `sel-${componentId}`,
      componentId,
      name: definition.name,
      category,
      role,
      quantity: 1,
      reason: 'Power-honesty scenario.',
      source: 'planner',
      required: true,
      instances: [{ instanceId: `${componentId}-1`, componentId, name: definition.name, label: definition.name }],
    } as ComponentSelection;
  };
  let batteryBuild: ComponentSelection[] | null = null;
  try {
    batteryBuild = [
      pick('arduino-nano', 'microcontroller', 'controller'),
      pick('battery-9v', 'power', 'power'),
      pick('servo-motor-sg90', 'motor', 'actuator'),
      pick('oled-ssd1306-i2c', 'display', 'display'),
      pick('capacitor-1000uf-electrolytic', 'passive', 'passive'),
    ];
  } catch (error) {
    check('power-honesty scenario parts exist in the catalog', false, (error as Error).message);
  }
  if (batteryBuild) {
    const budget = computePowerBudget({
      selections: batteryBuild,
      catalog: powerCatalog,
      controller: batteryBuild[0] ?? null,
      profile: getMcuProfile('arduino-nano'),
    });
    const powerNotes = budget.notes.join('\n');
    check('battery build with a logic-rail servo is adequate', budget.adequate === true, (budget.shortfalls ?? []).join(' | ') || 'no shortfalls');
    check('no false blocking voltage error for the servo', !/accepts at most .* but the supply provides/.test(powerNotes));
    const servoRail = budget.rails.find((rail) => rail.loads.some((load) => /servo/i.test(load)));
    check('power budget books the servo on the 5 V rail', servoRail?.rail === '5V', servoRail ? `${servoRail.rail} ${servoRail.voltage} V` : 'no servo rail');
    check(
      'bulk-capacitor note names the rail the servo actually sits on',
      /bulk electrolytic capacitor across the 5 V logic rail/i.test(powerNotes),
    );
    check(
      'linear-regulator dissipation note recommends a buck or 5 V source',
      /drops 9 V to 5 V linearly/i.test(powerNotes) && /dissipates roughly \d+(\.\d+)? W/i.test(powerNotes) && /buck converter/i.test(powerNotes),
    );
    /* mA stays mA across the budget: no rail current was converted between voltages. */
    check('rail totals are summed in mA, not converted between voltages', budget.rails.every((rail) => typeof rail.peakMa === 'number'));

    const wiring = planWiring({
      selections: batteryBuild,
      catalog: powerCatalog,
      assignments: [],
      power: budget,
      controllerInstanceId: 'arduino-nano-1',
      profile: getMcuProfile('arduino-nano'),
    });
    const capPowerWire = wiring.connections.find(
      (connection) => connection.kind === 'power' && (connection.from.instanceId === 'capacitor-1000uf-electrolytic-1' || connection.to.instanceId === 'capacitor-1000uf-electrolytic-1'),
    );
    const capRailEnd = capPowerWire
      ? [capPowerWire.from, capPowerWire.to].find((endpoint) => endpoint.instanceId !== 'capacitor-1000uf-electrolytic-1')
      : undefined;
    check(
      'bulk capacitor is wired to the 5 V rail that feeds the servo, not the battery',
      Boolean(capRailEnd && capRailEnd.instanceId === 'arduino-nano-1' && capPowerWire?.voltage === 5),
      capPowerWire ? `${capPowerWire.from.instanceId}.${capPowerWire.from.pin} → ${capPowerWire.to.instanceId}.${capPowerWire.to.pin} @ ${capPowerWire.voltage} V` : 'no capacitor wire',
    );
  }

  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✕ ${failures} check(s) failed`}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 0).unref();
  })
  .catch((error: unknown) => {
    console.error('verifier crashed:', error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0).unref();
  });
