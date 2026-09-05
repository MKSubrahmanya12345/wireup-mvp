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
import type { ProjectState } from '@/types/project';

import { runPipeline } from '@/modules/orchestrator/pipeline';
import { buildRefreshers, controllerInfo, refreshSoftware, resolvedPinMapFor } from '@/modules/orchestrator/context';
import { auditFirmwareAgainstPinMap, pinAuditErrors } from '@/modules/code-generator';
import { getMcuProfile, usablePins } from '@/modules/pin-planner/mcu-profiles';
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
    revision: 0,
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

  /* The firmware call (CALL 2) is a separate op in the same run — in an
   * offline environment it must fail honestly too, and the deterministic
   * sketch must carry the project instead. */
  const firmwareCall = pipeline.llmCalls.find((call) => call.op === 'firmware');
  check('firmware call recorded as its own op', Boolean(firmwareCall), firmwareCall ? `${firmwareCall.op}/${firmwareCall.status}` : 'missing');
  check(
    'firmware call failed honestly and the deterministic sketch shipped',
    firmwareCall?.status === 'failed' && (project.artifacts.code?.files.length ?? 0) > 0,
    firmwareCall?.error?.slice(0, 80) ?? '',
  );

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

  /* --- 6. The pin map is the single source of truth ------------------------ */
  console.log('\n6. firmware, diagram and the pin plan are projections of one resolved pin map');
  const pinMap = resolvedPinMapFor(project, catalog);
  check('pin map froze every planner row', pinMap.bindings.length === project.pinAssignments.length, `${pinMap.bindings.length} binding(s)`);

  const codeText = (project.artifacts.code?.files ?? [])
    .filter((file) => /\.(ino|cpp|c|h|hpp)$/i.test(file.path))
    .map((file) => file.content)
    .join('\n');
  const firmwareAudit = codeText ? auditFirmwareAgainstPinMap(codeText, pinMap) : { violations: [], rewrites: [], ambiguous: [], content: '' };
  check(
    'firmware references only pins from the resolved map',
    pinAuditErrors(firmwareAudit).length === 0,
    pinAuditErrors(firmwareAudit).map((violation) => violation.message).join(' | ') || 'no violations',
  );

  const diagram = project.artifacts.diagram;
  const driftedBindings = pinMap.bindings.filter((binding) => {
    const component = diagram?.components.find((candidate) => candidate.id === binding.instanceId);
    const pin = component?.pins.find((candidate) => candidate.name.toLowerCase() === binding.targetPin.toLowerCase());
    // Integrated/absent parts are allowed to skip annotation; a present pin must agree.
    return pin !== undefined && pin.assignedTo !== undefined && pin.assignedTo !== binding.mcuPin;
  });
  check('every diagram binding equals the resolved pin map', driftedBindings.length === 0, driftedBindings.map((binding) => `${binding.key}→?`).join(', ') || 'no drift');

  /* Sabotage: move ONE assignment and prove the cross-checks catch firmware
   * and diagram disagreeing with the plan — reconciliation must be detected,
   * never hand-reconciled. */
  const drifted = structuredClone(project);
  const movable = drifted.pinAssignments.find((assignment) => assignment.protocol === 'gpio' || assignment.protocol === 'adc');
  const driftProfile = getMcuProfile(drifted.pinAssignments[0]?.mcuComponentId ?? '');
  if (movable && driftProfile) {
    const used = new Set(drifted.pinAssignments.map((assignment) => assignment.pin));
    const target = usablePins(driftProfile, { exclude: used, direction: movable.direction, allowStrapping: true })[0];
    if (target && target.name !== movable.pin) {
      const from = movable.pin;
      movable.pin = target.name;
      movable.pinNumber = target.number;
      drifted.revision = project.revision + 1;

      const driftCheck = await validateProject({
        project: drifted,
        catalog,
        catalogContext: pipeline.context.fullCatalogContext,
        mcuContext: pipeline.context.mcuContext,
        ...(controller.profile ? { profile: controller.profile } : {}),
        iteration: 0,
        events,
        enableModelReview: false,
      });
      const codes = new Set(driftCheck.result.issues.map((issue) => issue.code));
      check(
        `moving ${movable.targetInstanceId}.${movable.targetPin} ${from} → ${target.name} trips firmware check`,
        codes.has('code_pin_mismatch'),
        [...codes].slice(0, 6).join(', '),
      );
      check('the same move trips the diagram check', codes.has('diagram_out_of_sync'));
    } else {
      console.log('  · no free GPIO to move — sabotage scenario skipped');
    }
  } else {
    console.log('  · no movable GPIO assignment — sabotage scenario skipped');
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
