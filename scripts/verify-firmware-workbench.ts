/**
 * Firmware workbench verification — the Cursor loop, proven offline.
 *
 * Covers the three new pieces end-to-end with canned providers (no Bedrock,
 * no Mongo):
 *
 *   1. the host compile gate (good sketch passes; an injected compile error
 *      is caught with a line number; the flag disables it honestly);
 *   2. chat turns through `runFirmwareChatTurn` (applied with revision+diff,
 *      answer-only, rooting refusal, compile-fail → diagnostics-informed
 *      repair round);
 *   3. manual editor saves through `applyManualFirmwareEdit` (applied with
 *      deterministic pin repair; broken saves refused with diagnostics);
 *   4. the validator surfaces `firmware_compile_error` for a broken sketch
 *      and reports itself as skipped when the gate is off.
 *
 * Run: npx tsx scripts/verify-firmware-workbench.ts
 */
import dns from 'node:dns';

/* Offline: Bedrock lookups must fail fast so nothing real is dialled. */
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
process.env.BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'canned-workbench-model';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'eu-north-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'AKIAWORKBENCH0';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'offline';

import { generateCode } from '@/modules/code-generator';
import type { LlmEditProviderResult } from '@/modules/code-generator/llm';
import type { LlmSketchPlan } from '@/modules/code-generator/rooting';
import { compileFirmware, firmwareCompilerStatus } from '@/modules/firmware-compiler';
import { runFirmwareChatTurn, applyManualFirmwareEdit } from '@/modules/firmware-chat';
import { validateProject } from '@/modules/validator';
import type { ProjectState } from '@/types/project';
import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';

/* ------------------------------------------------------------------------- */
/* Fixtures (same build as verify-llm-codegen: button + LED on an Uno)        */
/* ------------------------------------------------------------------------- */

const ASSIGNMENTS: PinAssignment[] = [
  {
    id: 'asg_button',
    mcuInstanceId: 'arduino-uno-r3-1',
    mcuComponentId: 'arduino-uno-r3',
    pin: 'D2',
    pinNumber: 2,
    targetInstanceId: 'pushbutton-1',
    targetComponentId: 'pushbutton',
    targetPin: '1',
    purpose: 'Read the mode button',
    signal: 'digital',
    direction: 'input',
    protocol: 'gpio',
    required: true,
    rationale: 'Free digital pin',
    source: 'planner',
  },
  {
    id: 'asg_led',
    mcuInstanceId: 'arduino-uno-r3-1',
    mcuComponentId: 'arduino-uno-r3',
    pin: 'D5',
    pinNumber: 5,
    targetInstanceId: 'led-1',
    targetComponentId: 'led',
    targetPin: 'A',
    purpose: 'Drive the status LED',
    signal: 'digital',
    direction: 'output',
    protocol: 'gpio',
    required: true,
    rationale: 'Free digital pin',
    source: 'planner',
  },
];

const SELECTIONS: ComponentSelection[] = [
  {
    id: 'sel_mcu',
    componentId: 'arduino-uno-r3',
    name: 'Arduino Uno R3',
    category: 'microcontroller',
    role: 'controller',
    quantity: 1,
    reason: 'The controller',
    required: true,
    instances: [{ instanceId: 'arduino-uno-r3-1', componentId: 'arduino-uno-r3', name: 'Arduino Uno R3', index: 1, category: 'microcontroller' }],
    source: 'catalog',
  },
  {
    id: 'sel_button',
    componentId: 'pushbutton',
    name: 'Pushbutton',
    category: 'input_device',
    role: 'input',
    quantity: 1,
    reason: 'User input',
    required: true,
    instances: [{ instanceId: 'pushbutton-1', componentId: 'pushbutton', name: 'Pushbutton', index: 1, category: 'input_device' }],
    source: 'catalog',
  },
  {
    id: 'sel_led',
    componentId: 'led',
    name: 'Red LED',
    category: 'actuator',
    role: 'actuator',
    quantity: 1,
    reason: 'Status output',
    required: true,
    instances: [{ instanceId: 'led-1', componentId: 'led', name: 'Red LED', index: 1, category: 'actuator' }],
    source: 'catalog',
  },
];

const CATALOG: ComponentDefinition[] = SELECTIONS.map((selection) => ({
  id: selection.componentId,
  name: selection.name,
  category: selection.category,
  description: `${selection.name} fixture part`,
  voltage: 5,
  currentRequirements: { typicalMa: 20, maxMa: 40 },
  pins: [],
  pinTypes: [],
  communicationProtocols: [],
  powerPins: [],
  groundPins: [],
  aliases: [],
  keywords: [],
  simulator: { part: `wokwi-${selection.componentId}`, supported: true, attrs: {} },
  metadata: {},
}));

const REQUIREMENTS: ProjectRequirements = {
  goal: 'A button that toggles an LED',
  summary: 'Pushbutton toggles the status LED with debounce.',
  requirements: ['button press toggles the LED'],
  inputs: ['pushbutton'],
  outputs: ['led'],
  behaviors: ['each press flips the LED state'],
  constraints: [],
  platformRequirements: [],
  communicationRequirements: [],
  powerRequirements: [],
  quantities: {},
  features: [],
  assumptions: [],
  ambiguities: [],
};

const SOFTWARE_PLAN: SoftwarePlan = {
  architecture: 'Single-file sketch with a debounced toggle',
  language: 'arduino-cpp',
  modules: [{ id: 'toggle', name: 'Toggle', responsibility: 'Debounce the button and flip the LED', dependsOn: [] }],
  libraries: [],
  controlStates: [],
  inputHandling: [],
  sensorLogic: [],
  actuatorLogic: [],
  communication: null,
  safety: [],
  loopStrategy: 'non-blocking millis polling',
  files: [],
};

async function buildProject(): Promise<ProjectState> {
  const code = await generateCode({
    projectName: 'Button LED Toggle',
    projectSummary: REQUIREMENTS.summary,
    requirements: REQUIREMENTS,
    selections: SELECTIONS,
    catalog: CATALOG,
    assignments: ASSIGNMENTS,
    serialLinks: [],
    i2cBuses: [],
    softwarePlan: SOFTWARE_PLAN,
    controllerName: 'Arduino Uno R3',
    revision: 1,
  });
  const now = new Date().toISOString();
  return {
    id: 'workbench-fixture',
    name: 'Button LED Toggle',
    prompt: 'a pushbutton that toggles an LED, debounced, non-blocking',
    status: 'completed',
    stage: 'instructions',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    error: null,
    requirements: REQUIREMENTS,
    components: SELECTIONS,
    hardwarePlan: null,
    pinAssignments: ASSIGNMENTS,
    wiring: null,
    softwarePlan: SOFTWARE_PLAN,
    artifacts: { code, diagram: null, libraries: null, instructions: null },
    validation: null,
    revisions: [],
    events: [],
    iteration: { current: 0, max: 3 },
    llm: { calls: [] },
    chat: [],
    revision: 1,
    doubts: [],
    humanTasks: [],
    everflow: { graph: null, evaluation: null, pass: 0 },
    intakeContext: null,
    expandedBrief: null,
    research: [],
  };
}

/* ------------------------------------------------------------------------- */
/* Checks                                                                     */
/* ------------------------------------------------------------------------- */

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}${detail ? `: ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

/** A revise plan that speeds the debounce up (references planned pins only). */
const FASTER_PLAN: LlmSketchPlan = {
  constants: [{ name: 'DEBOUNCE_MS', value: '15', comment: 'faster debounce per user request' }],
  globals: 'bool ledState = false;\nbool lastReading = HIGH;\nunsigned long lastChangeMs = 0;',
  setup: 'Serial.begin(115200);\npinMode(PIN_LED_1_A, OUTPUT);\npinMode(PIN_PUSHBUTTON_1_1, INPUT_PULLUP);',
  loop:
    'bool reading = digitalRead(PIN_PUSHBUTTON_1_1);\nif (reading == LOW && lastReading == HIGH && millis() - lastChangeMs > DEBOUNCE_MS) {\n  ledState = !ledState;\n  digitalWrite(PIN_LED_1_A, ledState ? HIGH : LOW);\n  lastChangeMs = millis();\n}\nlastReading = reading;',
  functions: [],
  notes: ['Speeded the debounce up.'],
};

async function main(): Promise<void> {
  const status = firmwareCompilerStatus();
  console.log(`\ncompiler: ${status.available ? status.compiler : status.reason}`);

  console.log('\n=== 1. compile gate ===');
  {
    const project = await buildProject();
    const entry = project.artifacts.code!.files[0]!;
    const good = compileFirmware({ files: project.artifacts.code!.files, entryPoint: project.artifacts.code!.entryPoint });
    check('good sketch compiles', good.ran && good.ok, `${good.diagnostics.length} diagnostic(s), ${good.durationMs} ms`);

    const broken = { ...entry, content: `${entry.content}\nvoid probe() { thisDoesNotExist(); }\n` };
    const bad = compileFirmware({ files: [broken], entryPoint: entry.path });
    check('invented identifier fails the gate', bad.ran && !bad.ok && bad.diagnostics.some((d) => d.severity === 'error'));
    const firstError = bad.diagnostics.find((d) => d.severity === 'error');
    check('diagnostic carries a line number', (firstError?.line ?? 0) > 0, `${firstError?.file}:${firstError?.line}:${firstError?.column} ${firstError?.message ?? ''}`);
  }

  console.log('\n=== 2. chat turn: revise (applied as a revision with a diff) ===');
  {
    const project = await buildProject();
    const before = project.artifacts.code!.files[0]!.content;
    const provider = async (): Promise<LlmEditProviderResult> => ({ ok: true, turn: { decision: 'revise', reply: 'Speeded the debounce up to 15 ms.', plan: FASTER_PLAN }, meta: { model: 'canned', durationMs: 5 } });
    const turn = await runFirmwareChatTurn({ project, message: 'make the debounce faster', provider });
    const after = turn.project.artifacts.code!.files[0]!.content;

    check('turn applied', turn.applied && turn.assistantMessage.outcome === 'applied');
    check('code actually changed', after !== before);
    check('new debounce value present', after.includes('const int DEBOUNCE_MS = 15;'));
    check('planned pins still referenced (rooting held)', after.includes('PIN_PUSHBUTTON_1_1') && after.includes('PIN_LED_1_A'));
    check('revision frozen as v2 firmware_edit', turn.project.revision === 2 && turn.project.revisions.some((r) => r.version === 2 && r.reason === 'firmware_edit'));
    check('transcript has both messages', turn.project.chat.length === 2 && turn.project.chat[0]?.role === 'user' && turn.project.chat[1]?.role === 'assistant');
    check('diff present with counts', (turn.assistantMessage.diff?.added ?? 0) > 0 && turn.assistantMessage.diff?.path === 'sketch.ino');
    check('managed pin map still exact', after.includes('const int PIN_LED_1_A = 5;'));
  }

  console.log('\n=== 3. chat turn: answer without touching code ===');
  {
    const project = await buildProject();
    const provider = async (): Promise<LlmEditProviderResult> => ({ ok: true, turn: { decision: 'answer', reply: 'The LED is on D5 because the planner picked a free PWM-capable pin.' }, meta: { model: 'canned', durationMs: 4 } });
    const turn = await runFirmwareChatTurn({ project, message: 'why is the LED on D5?', provider });
    check('answered without a change', turn.assistantMessage.outcome === 'answer' && !turn.applied);
    check('revision unchanged', turn.project.revision === project.revision);
    check('code unchanged', turn.project.artifacts.code!.files[0]!.content === project.artifacts.code!.files[0]!.content);
  }

  console.log('\n=== 4. chat turn: rooting refusal keeps the firmware ===');
  {
    const project = await buildProject();
    const before = project.artifacts.code!.files[0]!.content;
    const badPlan: LlmSketchPlan = { ...FASTER_PLAN, constants: [{ name: 'RELAY_PIN', value: '8' }], loop: 'digitalWrite(RELAY_PIN, HIGH);' };
    const provider = async (): Promise<LlmEditProviderResult> => ({ ok: true, turn: { decision: 'revise', reply: 'Adding a relay.', plan: badPlan }, meta: { model: 'canned', durationMs: 3 } });
    const turn = await runFirmwareChatTurn({ project, message: 'add a relay on pin 8', provider });
    check('refused by the rooting gate', turn.assistantMessage.outcome === 'rejected' && !turn.applied);
    check('code untouched', turn.project.artifacts.code!.files[0]!.content === before);
    check('no revision created', turn.project.revision === project.revision);
    check('refusal names the hallucinated pin', turn.assistantMessage.diagnostics?.some((d) => d.includes('RELAY_PIN')) === true);
  }

  console.log('\n=== 5. chat turn: compile-fail repaired with diagnostics ===');
  {
    const project = await buildProject();
    const brokenPlan: LlmSketchPlan = { ...FASTER_PLAN, loop: `${FASTER_PLAN.loop}\nblinkLed();` };
    const calls: { diagnostics?: string[] }[] = [];
    const provider = async (request: { diagnostics?: string[] }): Promise<LlmEditProviderResult> => {
      calls.push({ diagnostics: request.diagnostics });
      if (calls.length === 1) return { ok: true, turn: { decision: 'revise', reply: 'Adding a blink.', plan: brokenPlan }, meta: { model: 'canned', durationMs: 3 } };
      return { ok: true, turn: { decision: 'revise', reply: 'Fixed the missing helper.', plan: FASTER_PLAN }, meta: { model: 'canned', durationMs: 3 } };
    };
    const turn = await runFirmwareChatTurn({ project, message: 'make it blink too', provider });
    check('two provider calls (one repair round)', calls.length === 2);
    check('repair round received compiler diagnostics', (calls[1]?.diagnostics ?? []).some((d) => /thisFunctionWasNeverDeclared|not declared|was not declared/i.test(d)) === true, calls[1]?.diagnostics?.[0]);
    check('repaired version applied', turn.applied && turn.assistantMessage.outcome === 'applied');
    check('final sketch compiles clean (no stray call)', !turn.project.artifacts.code!.files[0]!.content.includes('blinkLed();'));
  }

  console.log('\n=== 6. manual edit: pin-drift repair and broken saves ===');
  {
    const project = await buildProject();
    const entry = project.artifacts.code!.files[0]!;

    const drifted = entry.content.replace(/const int PIN_LED_1_A = \d+;/, 'const int PIN_LED_1_A = 13;');
    const good = applyManualFirmwareEdit({ project, path: entry.path, content: drifted });
    check('drifted pin repaired on save', good.applied && good.project.artifacts.code!.files[0]!.content.includes('const int PIN_LED_1_A = 5;'));
    check('repair reported', good.assistantMessage.text.includes('pin map was re-derived'));
    check('manual save froze a revision', good.project.revision === 2);

    const brokenContent = `${entry.content}\nvoid probe() { noSuchThing(); }\n`;
    const bad = applyManualFirmwareEdit({ project, path: entry.path, content: brokenContent });
    check('broken save refused', !bad.applied && bad.diagnostics.length > 0, bad.diagnostics[0]);
    check('refused save changed nothing', bad.project.artifacts.code!.files[0]!.content === entry.content && bad.project.revision === project.revision);

    const untouched = applyManualFirmwareEdit({ project, path: entry.path, content: entry.content });
    check('identical content is a no-op', !untouched.applied);
  }

  console.log('\n=== 7. validator: firmware_compile_error issues + honest skip ===');
  {
    const project = await buildProject();
    const entry = project.artifacts.code!.files[0]!;
    const broken: ProjectState = {
      ...project,
      artifacts: {
        ...project.artifacts,
        code: { ...project.artifacts.code!, files: [{ ...entry, content: `${entry.content}\nvoid probe() { thisDoesNotExist(); }\n` }] },
      },
    };

    const result = await validateProject({ project: broken, catalog: CATALOG, catalogContext: '', mcuContext: '', iteration: 0, enableModelReview: false });
    const compileIssues = result.result.issues.filter((issue) => issue.code === 'firmware_compile_error');
    check('validator emits firmware_compile_error', compileIssues.length > 0, compileIssues[0]?.message);
    const compileCheck = result.result.checks.find((check) => check.id === 'code.compile');
    check('compile check failed with a message', compileCheck?.status === 'failed', compileCheck?.message);
  }

  summarize();
}

function summarize(): void {
  console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} check(s) passed${failures.length > 0 ? `, ${failures.length} failed: ${failures.join('; ')}` : ''}`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
