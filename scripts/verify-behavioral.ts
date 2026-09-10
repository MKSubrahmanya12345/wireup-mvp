/**
 * Behavioural verification harness — the assertion layer + emulator-as-test.
 *
 * Proves four things about the behavioural loop:
 *
 *   1. Decomposition derives the right assertions from the prompt.
 *   2. The deterministic pipeline generates firmware that satisfies them
 *      (evaluated statically AND by compiling + running the sketch against the
 *      instrumented host core).
 *   3. The three historical code-generation bugs are caught: a dead factory
 *      PIN, an inverted reset button, and a stepper miscounted as presses.
 *   4. A failure routes back into the fixer as structured input
 *      ("expected X, got Y") and plans a targeted patch, not a full rebuild.
 *
 * Usage: npx tsx scripts/verify-behavioral.ts [--keep]
 */
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

/* Run offline: force Bedrock lookups to fail fast so the deterministic path is used. */
const realLookup = dns.lookup as unknown as (...args: unknown[]) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = (hostname: string, ...rest: unknown[]): unknown => {
  const callback = rest[rest.length - 1];
  if (typeof callback === 'function' && String(hostname).endsWith('amazonaws.com')) {
    const error = new Error(`getaddrinfo EAI_AGAIN ${hostname}`) as NodeJS.ErrnoException;
    error.code = 'EAI_AGAIN';
    return (callback as (err: Error) => void)(error);
  }
  return realLookup(hostname, ...rest);
};

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=800';
process.env.BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'moonshotai.kimi-k2.5';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'eu-north-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'AKIABEHAVIOURAL0';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'not-a-real-secret';
process.env.BEDROCK_MAX_RETRIES = '1';

const NOISE = /amazonaws\.com|EAI_AGAIN|Bedrock|MONGODB_URI|ECONNREFUSED|serverSelectionTimeoutMS/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNoise = (args: any[]): boolean => NOISE.test(inspect(args));
for (const channel of ['log', 'warn', 'error', 'debug'] as const) {
  const original = console[channel].bind(console);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console[channel] = (...args: any[]): void => {
    if (isNoise(args)) return;
    original(...args);
  };
}

import { AgentEventLog } from '@/lib/logging/events';
import { nowIso } from '@/lib/validation/time';
import type { ProjectState } from '@/types/project';
import type { ValidationIssue } from '@/types/validation';
import { runPipeline } from '@/modules/orchestrator/pipeline';
import { evaluateBehavioral } from '@/modules/behaviour-evaluator';
import { planDeterministicChanges } from '@/modules/fixer/strategies';

interface Case {
  name: string;
  prompt: string;
}

const CASES: Case[] = [
  {
    name: 'safe-keypad-servo-6pin',
    prompt: `Arduino Nano electronic safe with a 6 digit PIN, a 4x4 matrix keypad, a micro servo
bolt, a green LED and a red LED. Remember the PIN after a power cycle.`,
  },
  {
    name: 'led-button-counter',
    prompt: `Arduino Nano with two pushbuttons and one LED: press the first button to increase a
counter shown on the serial monitor, press the second to reset it, and blink the LED once per press.`,
  },
  {
    name: 'stepper-driver',
    prompt: `Arduino Uno with a 28BYJ-48 stepper on its ULN2003 driver board: rotate 500 steps
clockwise when a pushbutton is pressed, 500 steps counter-clockwise when the second is pressed,
and show the position on the serial monitor.`,
  },
];

function initialProject(id: string, prompt: string): ProjectState {
  const now = nowIso();
  return {
    id,
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
    iteration: { current: 0, max: 3 },
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

function patchEntry(project: ProjectState, transform: (content: string) => string): ProjectState {
  const code = project.artifacts.code;
  if (!code) return project;
  const entryPath = code.entryPoint;
  const files = code.files.map((file) =>
    file.path === entryPath ? { ...file, content: transform(file.content), generatedBy: 'fixer' as const } : file,
  );
  return { ...project, artifacts: { ...project.artifacts, code: { ...code, files } } };
}

const summary: { ok: boolean; detail: string }[] = [];
function record(ok: boolean, detail: string): void {
  summary.push({ ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${detail}`);
}

async function main() {
  const keep = process.argv.includes('--keep');
  const outDir = keep ? path.join(os.tmpdir(), 'wireup-behavioural') : fs.mkdtempSync(path.join(os.tmpdir(), 'wireup-bh-'));

  const cases = new Map<string, ProjectState>();

  /* ---- 1. Decomposition derives the right assertions ---------------------- */
  console.log('\n1. Assertion derivation');
  for (const entry of CASES) {
    const events = new AgentEventLog({ initialSeq: 0 });
    const pipeline = await runPipeline({ project: initialProject(entry.name, entry.prompt), events });
    const project = pipeline.project;
    cases.set(entry.name, project);

    const spec = project.requirements?.behavioralSpec;
    if (!spec) {
      record(false, `${entry.name}: no behavioural spec was derived`);
      continue;
    }
    const ids = spec.assertions.map((assertion) => assertion.id).join(', ');
    record(true, `${entry.name}: ${spec.assertions.length} assertion(s) → ${ids}`);
  }

  /* ---- 2. Generated firmware satisfies its spec --------------------------- */
  console.log('\n2. Generated firmware vs its assertions');
  for (const entry of CASES) {
    const project = cases.get(entry.name);
    if (!project?.artifacts.code) continue;
    const report = evaluateBehavioral({
      requirements: project.requirements!,
      code: project.artifacts.code,
      pinAssignments: project.pinAssignments,
      selections: project.components,
    });
    for (const check of report.checks) {
      record(
        check.status === 'passed',
        `${entry.name}: ${check.assertionId} [${check.mode}] → ${check.status}${check.reason ? ` (${check.reason})` : ''}`,
      );
    }
    if (report.runtimeError) console.log(`         note: emulator could not run — ${report.runtimeError}`);
  }

  /* ---- 3. The three historical bugs are caught ---------------------------- */
  console.log('\n3. Bug injection (each mutation must fail the right assertion)');

  /* 3a. Dead factory PIN: 6-digit brief ships PIN_MIN/MAX = 4 and fallback "1234". */
  const safe = cases.get('safe-keypad-servo-6pin');
  if (safe?.artifacts.code) {
    const buggy = patchEntry(safe, (content) =>
      content
        .replace(/PIN_MIN_LENGTH\s*=\s*\d+/, 'PIN_MIN_LENGTH = 4')
        .replace(/PIN_MAX_LENGTH\s*=\s*\d+/, 'PIN_MAX_LENGTH = 4')
        .replace(/(const\s+char\s*\*\s*fallback\s*=\s*")[0-9]*(")/, '$11234$2'),
    );
    const report = evaluateBehavioral({
      requirements: safe.requirements!,
      code: buggy.artifacts.code!,
      pinAssignments: safe.pinAssignments,
      selections: safe.components,
    });
    for (const assertionId of ['pin-min-length', 'pin-max-length', 'default-pin-covers-min']) {
      const check = report.checks.find((candidate) => candidate.assertionId === assertionId);
      record(check?.status === 'failed', `dead factory PIN: ${assertionId} flagged (${check?.actual ?? 'missing'})`);
    }
  }

  /* 3b. Inverted reset: the reset button increments instead of zeroing. */
  const counter = cases.get('led-button-counter');
  if (counter?.artifacts.code) {
    const buggy = patchEntry(counter, (content) =>
      content.replace(
        /(\n\s*)pressCount = 0;\s*\n\s*displayDirty = true;\s*\n\s*Serial\.println\("count=0"\);/,
        '$1pressCount++;\n$1displayDirty = true;\n$1Serial.print("count=");\n$1Serial.println(pressCount);',
      ),
    );
    const report = evaluateBehavioral({
      requirements: counter.requirements!,
      code: buggy.artifacts.code!,
      pinAssignments: counter.pinAssignments,
      selections: counter.components,
    });
    const resetCheck = report.checks.find((candidate) => candidate.assertionId === 'counter-has-reset');
    const runtimeCheck = report.checks.find((candidate) => candidate.assertionId === 'counter-resets-to-zero');
    record(resetCheck?.status === 'failed', `inverted reset (static): counter-has-reset flagged (${resetCheck?.actual ?? 'missing'})`);
    record(runtimeCheck?.status === 'failed', `inverted reset (runtime): counter-resets-to-zero flagged (${runtimeCheck?.actual ?? 'missing'})`);
  }

  /* 3c. Miscounted stepper: a stepper build grows a press counter. */
  const stepper = cases.get('stepper-driver');
  if (stepper?.artifacts.code) {
    const buggy = patchEntry(stepper, (content) =>
      content
        .replace(/(uint8_t\s+speedPercent\s*=\s*\d+;)/, '$1\nlong pressCount = 0;')
        .replace(
          'controlLink.print(speedPercent);',
          'controlLink.print(speedPercent);\n  controlLink.print(",\\"count\\":");\n  controlLink.print(pressCount);',
        ),
    );
    const report = evaluateBehavioral({
      requirements: stepper.requirements!,
      code: buggy.artifacts.code!,
      pinAssignments: stepper.pinAssignments,
      selections: stepper.components,
    });
    const staticCheck = report.checks.find((candidate) => candidate.assertionId === 'press-counter-absent');
    const runtimeCheck = report.checks.find((candidate) => candidate.assertionId === 'telemetry-count-absent');
    record(staticCheck?.status === 'failed', `miscounted stepper (static): press-counter-absent flagged (${staticCheck?.actual ?? 'missing'})`);
    record(runtimeCheck?.status === 'failed', `miscounted stepper (runtime): telemetry-count-absent flagged (${runtimeCheck?.actual ?? 'missing'})`);
  }

  /* ---- 4. The fixer routes the failure to a targeted patch ----------------- */
  console.log('\n4. Fixer receives structured input and plans a targeted patch');
  if (safe?.artifacts.code) {
    const buggy = patchEntry(safe, (content) => content.replace(/PIN_MIN_LENGTH\s*=\s*\d+/, 'PIN_MIN_LENGTH = 4'));
    const issue: ValidationIssue = {
      id: 'behavioral.pin-min-length',
      code: 'behavioral_assertion_failed',
      severity: 'error',
      domain: 'behavior',
      message: 'Behavioural assertion failed: PIN_MIN_LENGTH is 6 (as requested) (static)',
      details: 'assertion pin-min-length failed: expected 6, got 4',
      fixHint: 'expected 6, got 4',
      target: { artifact: 'code' },
      autoFixable: true,
      origin: 'rules',
    };
    const outcome = planDeterministicChanges({
      project: buggy,
      issues: [issue],
      catalog: [],
      iteration: 0,
    });
    const patch = outcome.changes.find((change) => change.op === 'patch_code_file');
    record(
      Boolean(patch) && patch!.op === 'patch_code_file' && (patch as { replace?: string }).replace === '$16',
      `fixer planned a targeted PIN_MIN_LENGTH patch (not a rebuild): ${outcome.notes.join('; ')}`,
    );
  }

  if (counter?.artifacts.code) {
    const issue: ValidationIssue = {
      id: 'behavioral.counter-resets-to-zero',
      code: 'behavioral_assertion_failed',
      severity: 'error',
      domain: 'behavior',
      message: 'Behavioural assertion failed: after reset the count is 0 (runtime)',
      details: 'assertion counter-resets-to-zero failed: expected 0, got 3',
      fixHint: 'expected 0, got 3',
      target: { artifact: 'code' },
      autoFixable: true,
      origin: 'rules',
    };
    const outcome = planDeterministicChanges({ project: counter, issues: [issue], catalog: [], iteration: 0 });
    const forced = outcome.changes.find((change) => change.op === 'rerun_stage');
    record(
      Boolean(forced) && forced!.op === 'rerun_stage' && (forced as { stage?: string }).stage === 'code' && (forced as { force?: boolean }).force === true,
      `logic-level failure routes to a forced code regeneration: ${outcome.notes.join('; ')}`,
    );
  }

  /* ---- Verdict ------------------------------------------------------------ */
  const failed = summary.filter((entry) => !entry.ok);
  console.log(`\n=== ${summary.length - failed.length}/${summary.length} behavioural checks passed ===`);
  if (keep) console.log(`  sources kept in ${outDir}`);
  else fs.rmSync(outDir, { recursive: true, force: true });
  if (failed.length > 0) {
    console.log(`  failing: ${failed.map((entry) => entry.detail).join(' | ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
