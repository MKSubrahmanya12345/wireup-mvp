/**
 * Scratch reproduction harness for the "electronic safe" report.
 * Runs the deterministic pipeline offline and dumps the artifacts.
 */
import dns from 'node:dns';
import fs from 'node:fs';

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
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'AKIAREPROREPROREPRO';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'not-a-real-secret';
process.env.BEDROCK_MAX_RETRIES = '1';

import { AgentEventLog } from '@/lib/logging/events';
import { nowIso } from '@/lib/validation/time';
import type { ProjectState } from '@/types/project';
import { runPipeline } from '@/modules/orchestrator/pipeline';
import { buildRefreshers, controllerInfo, refreshSoftware } from '@/modules/orchestrator/context';
import { validateProject } from '@/modules/validator';
import { fixProject } from '@/modules/fixer';
import { toWokwiDiagram } from '@/modules/diagram-generator/wokwi';
import { generateVelxioProject } from '@/modules/simulation/velxio-project';
import { buildSimulationBundle } from '@/modules/simulation';

const PROMPT = `The goal is a realistic working safe, not a basic keypad demo.

Components:
Arduino Nano
4x4 matrix keypad
SG90 servo for the physical lock
SSD1306 128x64 I2C OLED
Red LED
Green LED
Passive buzzer
Push button for the safe door
Optional EEPROM for persistent password storage

Behavior:
On startup, OLED displays SAFE LOCKED / ENTER PIN:
User enters a 4-6 digit PIN using the keypad. # = submit, * = clear. Display entered digits as ****.
Correct PIN: OLED displays ACCESS GRANTED, green LED on, servo rotates to unlock, short confirmation tone, OLED displays OPEN.
Incorrect PIN: ACCESS DENIED, red LED flashes, error tone, return to PIN entry.
After 3 consecutive incorrect attempts: alarm, red LED flashes rapidly, OLED displays ALARM, keypad locked for 10 seconds.
When the door button indicates the door is closed: servo returns to locked position, OLED displays SAFE LOCKED.
Password-change mode: holding * for several seconds, require current PIN, request new PIN, store in EEPROM.
Make the servo movement smooth. Produce a valid diagram.json and sketch.ino. Use only components supported by Wokwi.`;

function initialProject(prompt: string): ProjectState {
  const now = nowIso();
  return {
    id: 'repro-safe',
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
    revision: 0,
  };
}

async function main() {
  const events = new AgentEventLog({ initialSeq: 0 });
  const pipeline = await runPipeline({ project: initialProject(PROMPT), events });
  let project = pipeline.project;
  const catalog = pipeline.context.catalog;

  console.log('\n=== COMPONENTS ===');
  for (const selection of project.components) {
    console.log(`  ${selection.componentId.padEnd(34)} x${String(selection.quantity).padEnd(3)} role=${selection.role} category=${selection.category}`);
  }

  console.log('\n=== PIN ASSIGNMENTS ===');
  for (const a of project.pinAssignments) {
    console.log(`  ${a.pin.padEnd(5)} -> ${a.targetInstanceId}.${a.targetPin}`.padEnd(48) + `${a.direction}/${a.protocol} [${a.source}] ${a.rationale.slice(0, 60)}`);
  }

  const byPin = new Map<string, number>();
  for (const a of project.pinAssignments) byPin.set(a.pin, (byPin.get(a.pin) ?? 0) + 1);
  console.log('\n  pin reuse:', [...byPin.entries()].filter(([, n]) => n > 1).map(([p, n]) => `${p}x${n}`).join(' ') || 'none');

  const byTarget = new Map<string, number>();
  for (const a of project.pinAssignments) {
    const k = `${a.targetInstanceId}.${a.targetPin}`;
    byTarget.set(k, (byTarget.get(k) ?? 0) + 1);
  }
  console.log('  duplicate target pins:', [...byTarget.entries()].filter(([, n]) => n > 1).map(([p, n]) => `${p}x${n}`).join(' ') || 'none');

  console.log('\n=== WIRING ===', project.wiring?.connections.length ?? 0, 'connections,', project.wiring?.conflicts.length ?? 0, 'conflicts');
  for (const c of (project.wiring?.conflicts ?? []).slice(0, 20)) console.log('  conflict:', JSON.stringify(c).slice(0, 160));

  console.log('\n=== CODE ===');
  const entry = project.artifacts.code?.files.find((f) => f.path === project.artifacts.code?.entryPoint);
  console.log('  files:', project.artifacts.code?.files.map((f) => `${f.path}(${f.content.length}b,${f.generatedBy})`).join(', '));
  console.log('  includes block:');
  const inc = /\/\/ >>> WIREUP INCLUDES >>>[\s\S]*?\/\/ <<< WIREUP INCLUDES <<</.exec(entry?.content ?? '');
  console.log((inc?.[0] ?? '  (none)').split('\n').map((l) => `    ${l}`).join('\n'));

  console.log('\n=== DIAGRAM/WOKWI ===');
  const diagram = project.artifacts.diagram;
  if (diagram) {
    const proj = toWokwiDiagram(diagram);
    console.log('  diagram components:', diagram.components.length, 'wokwi parts:', proj.diagram.parts.length, 'wokwi connections:', proj.diagram.connections.length);
    console.log('  board parts:', proj.diagram.parts.filter((p) => /arduino|esp32|pico/.test(p.type)).map((p) => `${p.id}:${p.type}`).join(', ') || 'NONE');
    console.log('  skipped parts:', proj.skippedParts.map((s) => `${s.id}(${s.reason.slice(0, 60)})`).join('\n                '));
    console.log('  skipped connections:', proj.skippedConnections.length, proj.skippedConnections.slice(0, 4).map((s) => s.reason.slice(0, 90)).join(' | '));

    const vlx = generateVelxioProject({
      projectName: project.name,
      diagram,
      files: (project.artifacts.code?.files ?? []).map((f) => ({ path: f.path, content: f.content })),
      ...(project.artifacts.code?.entryPoint ? { entryPoint: project.artifacts.code.entryPoint } : {}),
      libraries: (project.artifacts.libraries?.libraries ?? []).map((l) => l.name),
      exportedAt: '2026-01-01T00:00:00.000Z',
    });
    console.log('  vlx board:', vlx.project.boards[0]?.boardKind, 'components:', vlx.project.components.length, 'wires:', vlx.project.wires.length);
    console.log('  vlx unsupported:', vlx.unsupported.length, vlx.unsupported.slice(0, 6).map((u) => u.slice(0, 100)).join('\n                     '));
  }

  console.log('\n=== VALIDATION ===');
  const controller = controllerInfo(project, catalog);
  const validation = await validateProject({
    project,
    catalog,
    catalogContext: pipeline.context.fullCatalogContext,
    mcuContext: pipeline.context.mcuContext,
    ...(controller.profile ? { profile: controller.profile } : {}),
    iteration: 0,
    events,
    enableModelReview: false,
  });
  console.log('  passed:', validation.result.passed, 'errors:', validation.result.summary.errors, 'warnings:', validation.result.summary.warnings);
  for (const issue of validation.result.issues.slice(0, 40)) {
    console.log(`   [${issue.severity}] ${issue.code}: ${issue.message.slice(0, 130)}`);
  }

  console.log('\n=== FIX (deterministic only) ===');
  const baseline: ProjectState = { ...project, validation: validation.result, revision: project.revision + 1 };
  const refreshers = buildRefreshers({ catalog, baseline, analysis: pipeline.analysis, events });
  const fixProfile = controllerInfo(baseline, catalog).profile;
  const fix = await fixProject({
    project: baseline,
    validation: validation.result,
    catalog,
    catalogContext: pipeline.context.fullCatalogContext,
    mcuContext: pipeline.context.mcuContext,
    ...(fixProfile ? { profile: fixProfile } : {}),
    iteration: 0,
    events,
    enableLlmFixer: false,
    refresh: { ...refreshers, software: (candidate) => refreshSoftware(candidate, catalog, events) },
  });
  project = fix.project;
  console.log('  applied:', fix.result.applied.length, 'rejected:', fix.result.rejected.length, 'unresolved:', fix.unresolved.length);
  const byPin2 = new Map<string, number>();
  for (const a of project.pinAssignments) byPin2.set(a.pin, (byPin2.get(a.pin) ?? 0) + 1);
  console.log('  pin reuse after fix:', [...byPin2.entries()].filter(([, n]) => n > 1).map(([p, n]) => `${p}x${n}`).join(' ') || 'none');
  for (const r of fix.result.rejected.slice(0, 10)) console.log('   rejected:', JSON.stringify(r).slice(0, 150));

  const sketch = project.artifacts.code?.files.find((f) => f.path.endsWith('.ino'))?.content ?? '';
  const outDir = process.env.REPRO_OUT ?? '/tmp/wireup-artifacts';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/sketch.ino`, sketch);
  fs.writeFileSync(
    `${outDir}/diagram.json`,
    JSON.stringify(project.artifacts.diagram ? toWokwiDiagram(project.artifacts.diagram) : null, null, 2),
  );
  fs.writeFileSync(`${outDir}/power.json`, JSON.stringify(project.hardwarePlan?.power ?? null, null, 2));
  fs.writeFileSync(`${outDir}/validation.json`, JSON.stringify(validation.result, null, 2));
  if (project.artifacts.diagram) {
    const vlxOut = generateVelxioProject({
      projectName: project.name,
      diagram: project.artifacts.diagram,
      files: (project.artifacts.code?.files ?? []).map((f) => ({ path: f.path, content: f.content })),
      ...(project.artifacts.code?.entryPoint ? { entryPoint: project.artifacts.code.entryPoint } : {}),
      libraries: (project.artifacts.libraries?.libraries ?? []).map((l) => l.name),
      exportedAt: '2026-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(`${outDir}/velxio-project.json`, JSON.stringify(vlxOut.project, null, 2));
    fs.writeFileSync(`${outDir}/velxio-unsupported.txt`, vlxOut.unsupported.join('\n'));
  }
  const bundle = buildSimulationBundle(project);
  fs.writeFileSync(
    `${outDir}/contract.json`,
    JSON.stringify(
      {
        contract: bundle.software?.contract ?? null,
        findings: bundle.software?.findings ?? [],
        passed: bundle.software?.passed ?? null,
        velxioBoards: bundle.velxio?.project.boards ?? null,
        velxioUnsupported: bundle.velxio?.unsupported ?? [],
      },
      null,
      2,
    ),
  );
  console.log('\n=== SIMULATION BUNDLE ===');
  console.log('  contract metrics:', (bundle.software?.contract.metrics ?? []).map((m) => m.field).join(', ') || 'none');
  console.log('  contract commands:', (bundle.software?.contract.commands ?? []).map((c) => `'${c.character}' ${c.label}`).join(', ') || 'none');
  console.log('  software findings:', (bundle.software?.findings ?? []).map((f) => `${f.severity}:${f.code}`).join(', ') || 'none', 'passed:', bundle.software?.passed);
  for (const finding of (bundle.software?.findings ?? []).slice(0, 8)) console.log(`   [${finding.severity}] ${finding.code}: ${finding.message.slice(0, 130)}`);
  console.log('  vlx boards:', (bundle.velxio?.project.boards ?? []).map((b) => `${b.boardKind}`).join(', ') || 'NONE');
  console.log('  vlx unsupported:', (bundle.velxio?.unsupported ?? []).length);
  for (const item of (bundle.velxio?.unsupported ?? []).slice(0, 8)) console.log(`   - ${item.slice(0, 130)}`);

  console.log(`\n  artifacts written to ${outDir}`);

  console.log('\n=== SKETCH (first 120 lines) ===');
  console.log(sketch.split('\n').slice(0, 120).map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join('\n'));
  console.log('\n=== SKETCH (tail) ===');
  console.log(sketch.split('\n').slice(-60).join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
