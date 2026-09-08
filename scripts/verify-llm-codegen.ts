/**
 * AI-first codegen verification — the rooting gate, proven offline.
 *
 * The AI-first path (model authors the sketch logic, Wireup roots it to the
 * pin plan) cannot be exercised against real Bedrock in this environment, so
 * this harness substitutes canned providers that reproduce exactly the
 * failure classes the gate exists for, plus the happy path:
 *
 *   1. a good plan is assembled, kept as `model` output, and compiles;
 *   2. a hallucinated pin (declared by the model, unknown to the plan) is
 *      REJECTED and the deterministic template takes over;
 *   3. a model pin constant that uniquely matches a planned pin is aliased,
 *      never trusted;
 *   4. a re-declaration of a planned constant (even with a wrong value) is
 *      dropped — the managed block wins;
 *   5. a foreign `#include` is stripped;
 *   6. a contract-violating plan (its own setup() definition) is rejected;
 *   7. a provider that throws degrades to the deterministic path;
 *   8. raw pin literals in pin APIs are rewritten to the planned constants;
 *   9. without a provider the generator behaves exactly as before.
 *
 * Run:  npx tsx scripts/verify-llm-codegen.ts            (all suites)
 *       WIREUP_ENABLE_LLM_CODEGEN=false npx tsx scripts/verify-llm-codegen.ts --flag-off
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { generateCode } from '@/modules/code-generator';
import type { LlmSketchPlan, RootingContext } from '@/modules/code-generator/rooting';
import type { SketchPlanProvider, LlmSketchRequest } from '@/modules/code-generator/llm';
import { PIN_MAP_END, PIN_MAP_START, pinConstantMap } from '@/modules/code-generator/managed-blocks';
import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { LlmCallRecord } from '@/types/project';

/* ------------------------------------------------------------------------- */
/* Fixtures: a button + LED build on an Arduino Uno                           */
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
  inputHandling: ['debounced button read'],
  sensorLogic: [],
  actuatorLogic: ['digitalWrite the LED'],
  communication: null,
  safety: [],
  loopStrategy: 'non-blocking millis polling',
  files: [],
};

function baseInput(): Parameters<typeof generateCode>[0] {
  return {
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
    prompt: 'a pushbutton that toggles an LED, debounced, non-blocking',
  };
}

/** A plan the gate should accept: references planned constants only. */
const GOOD_PLAN: LlmSketchPlan = {
  constants: [
    { name: 'DEBOUNCE_MS', value: '40', comment: 'debounce window' },
    { name: 'BLINK_INTERVAL_MS', value: '500' },
  ],
  globals: 'bool ledState = false;\nbool lastReading = HIGH;\nunsigned long lastChangeMs = 0;\nunsigned long lastBlinkMs = 0;',
  setup: 'Serial.begin(115200);\npinMode(PIN_LED_1_A, OUTPUT);\npinMode(PIN_PUSHBUTTON_1_1, INPUT_PULLUP);\ndigitalWrite(5, LOW);',
  loop:
    'bool reading = digitalRead(PIN_PUSHBUTTON_1_1);\nif (reading == LOW && lastReading == HIGH && millis() - lastChangeMs > DEBOUNCE_MS) {\n  ledState = !ledState;\n  digitalWrite(PIN_LED_1_A, ledState ? HIGH : LOW);\n  lastChangeMs = millis();\n  Serial.print("led=");\n  Serial.println(ledState);\n}\nlastReading = reading;',
  functions: [{ name: 'ledIsOn', definition: 'bool ledIsOn() {\n  return ledState;\n}' }],
  notes: ['Simple debounced toggle.'],
};

function providerReturning(plan: LlmSketchPlan): SketchPlanProvider {
  return async () => ({ ok: true, plan, meta: { model: 'canned-good', durationMs: 1 } });
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

function pinBlockOf(content: string): string {
  const start = content.indexOf(PIN_MAP_START);
  const end = content.indexOf(PIN_MAP_END);
  return start === -1 || end === -1 ? '' : content.slice(start, end);
}

function entryOf(result: { files: { path: string; content: string; generatedBy: string }[] }): { path: string; content: string; generatedBy: string } | undefined {
  return result.files.find((file) => file.path === 'sketch.ino');
}

/** Re-rooting context identical to the one generateCode builds for this fixture. */
function rootingCtx(): RootingContext {
  return {
    projectName: 'Button LED Toggle',
    projectSummary: REQUIREMENTS.summary,
    controllerName: 'Arduino Uno R3',
    assignments: ASSIGNMENTS,
    libraries: SOFTWARE_PLAN.libraries,
    platformIsEsp32: false,
  };
}

function compileWithShim(content: string): { ok: boolean; error?: string } {
  const compiler = ['g++', 'clang++'].find((candidate) => {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!compiler) return { ok: false, error: 'no host C++ compiler on PATH' };
  const shimDir = path.join(process.cwd(), 'scripts', 'firmware-shim');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wireup-llm-codegen-'));
  const file = path.join(dir, 'sketch.ino');
  fs.writeFileSync(file, content);
  try {
    execFileSync(compiler, ['-std=gnu++17', '-fsyntax-only', '-x', 'c++', `-I${shimDir}`, file], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 800) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PLANNED = pinConstantMap(ASSIGNMENTS);

async function main(): Promise<void> {
  const flagOff = process.argv.includes('--flag-off');

  if (flagOff) {
    console.log('\n=== flag off: the provider must be ignored ===');
    let providerCalled = false;
    const result = await generateCode({
      ...baseInput(),
      llmProvider: async () => {
        providerCalled = true;
        return providerReturning(GOOD_PLAN)({} as LlmSketchRequest);
      },
    });
    check('provider never invoked', !providerCalled);
    check('sketch came from the template', entryOf(result)?.generatedBy === 'planner');
    summarize();
    return;
  }

  console.log('\n=== 1. happy path: a good plan is rooted and compiles ===');
  {
    const calls: LlmCallRecord[] = [];
    const result = await generateCode({ ...baseInput(), llmProvider: providerReturning(GOOD_PLAN), onLlmCall: (call) => calls.push(call) });
    const entry = entryOf(result);
    check('entry kept as model output', entry?.generatedBy === 'model');
    check('codegen call recorded ok', calls[0]?.op === 'codegen' && calls[0]?.status === 'ok' && calls[0]?.model === 'canned-good');
    check('managed pin block present and exact', pinBlockOf(entry?.content ?? '').includes('const int PIN_LED_1_A = 5;'));
    check('model logic present', (entry?.content ?? '').includes('ledIsOn'));
    check('model constant kept', (entry?.content ?? '').includes('const int DEBOUNCE_MS = 40;'));
    check('raw literal rewritten to the plan', (entry?.content ?? '').includes(`digitalWrite(${[...PLANNED.entries()].find(([, literal]) => literal === '5')?.[0] ?? 'PIN_LED_1_A'}, LOW);`));
    const withoutManagedBlocks = (entry?.content ?? '')
      .replace(pinBlockOf(entry?.content ?? ''), '')
      .replace((entry?.content ?? '').slice(entry?.content.indexOf('// >>> WIREUP INCLUDES') ?? 0, (entry?.content.indexOf('<<< WIREUP INCLUDES <<<') ?? 0) + 24), '');
    check('no include outside the managed block', /^#include/m.test(withoutManagedBlocks) === false);
    check('no pin-looking declaration outside the managed block', /const\s+int\s+\w*PIN\w*\s*=\s*\d+\s*;/.test((entry?.content ?? '').replace(pinBlockOf(entry?.content ?? ''), '')) === false);
    check('notes explain the rooting', result.notes.some((note) => note.includes('rooted to the pin plan')));
    const compile = compileWithShim(entry?.content ?? '');
    check('compiled against the firmware shim', compile.ok, compile.error ?? 'g++ -fsyntax-only clean');
  }

  console.log('\n=== 2. hallucinated pin: rejected, template takes over ===');
  {
    const badPlan: LlmSketchPlan = {
      ...GOOD_PLAN,
      constants: [{ name: 'RELAY_PIN', value: '8', comment: 'invented relay' }],
      loop: 'digitalRead(RELAY_PIN);',
    };
    const result = await generateCode({ ...baseInput(), llmProvider: providerReturning(badPlan) });
    const entry = entryOf(result);
    check('sketch fell back to the template', entry?.generatedBy === 'planner');
    check('note names the hallucinated pin', result.notes.some((note) => note.includes('RELAY_PIN')));
    check('no RELAY_PIN anywhere in the sketch', !(entry?.content ?? '').includes('RELAY_PIN'));
    check('template pin values are the plan values', pinBlockOf(entry?.content ?? '').includes('const int PIN_LED_1_A = 5;'));
  }

  console.log('\n=== 3. matchable pin constant: aliased, never trusted ===');
  {
    const aliased: LlmSketchPlan = {
      ...GOOD_PLAN,
      constants: [...GOOD_PLAN.constants, { name: 'BUTTON_PIN', value: '13' }],
      loop: `int button = digitalRead(BUTTON_PIN);\n${GOOD_PLAN.loop}`,
    };
    const result = await generateCode({ ...baseInput(), llmProvider: providerReturning(aliased) });
    const entry = entryOf(result);
    const buttonConstant = [...PLANNED.entries()].find(([name]) => name.includes('PUSHBUTTON'))?.[0] ?? 'PIN_PUSHBUTTON_1_1';
    check('still model output (nothing fatal)', entry?.generatedBy === 'model');
    check('aliased onto the planned constant', (entry?.content ?? '').includes(`const int BUTTON_PIN = ${buttonConstant};`));
    check('the model value 13 appears nowhere as the button pin', !new RegExp(`BUTTON_PIN\\s*=\\s*13`).test(entry?.content ?? ''));
  }

  console.log('\n=== 4. re-declared planned constant: dropped even with a wrong value ===');
  {
    const hijacked: LlmSketchPlan = {
      ...GOOD_PLAN,
      constants: [{ name: 'PIN_LED_1_A', value: '13' }],
    };
    const result = await generateCode({ ...baseInput(), llmProvider: providerReturning(hijacked) });
    const entry = entryOf(result);
    const pinBlock = pinBlockOf(entry?.content ?? '');
    check('still model output', entry?.generatedBy === 'model');
    check('exactly one declaration of PIN_LED_1_A', (entry?.content ?? '').match(/const int PIN_LED_1_A =/g)?.length === 1);
    check('the value is the plan value, not the model value', pinBlock.includes('const int PIN_LED_1_A = 5;'));
    check('drop was reported', result.notes.some((note) => note.includes('PIN_LED_1_A')));
  }

  console.log('\n=== 5. foreign include: stripped ===');
  {
    const withInclude: LlmSketchPlan = {
      ...GOOD_PLAN,
      setup: '#include <FastLED.h>\n' + GOOD_PLAN.setup,
    };
    const result = await generateCode({ ...baseInput(), llmProvider: providerReturning(withInclude) });
    const entry = entryOf(result);
    check('still model output', entry?.generatedBy === 'model');
    check('FastLED.h is gone', !(entry?.content ?? '').includes('FastLED'));
    check('stripping was reported', result.notes.some((note) => note.includes('FastLED')));
  }

  console.log('\n=== 6. contract violation (own setup definition): rejected ===');
  {
    const violating: LlmSketchPlan = {
      ...GOOD_PLAN,
      setup: 'void setup() {\n  Serial.begin(115200);\n}',
    };
    const result = await generateCode({ ...baseInput(), llmProvider: providerReturning(violating) });
    check('sketch fell back to the template', entryOf(result)?.generatedBy === 'planner');
    check('note explains the violation', result.notes.some((note) => note.includes('own setup()')));
  }

  console.log('\n=== 7. provider failure: deterministic path, honest note ===');
  {
    const failing: SketchPlanProvider = async () => ({ ok: false, error: 'model unavailable (canned)', code: 'EAI_AGAIN', meta: { model: 'canned-bad', durationMs: 1 } });
    const result = await generateCode({ ...baseInput(), llmProvider: failing });
    check('sketch from the template', entryOf(result)?.generatedBy === 'planner');
    check('note names the failure', result.notes.some((note) => note.includes('model unavailable')));
  }

  console.log('\n=== 8. throwing provider: degraded, never crashed ===');
  {
    const throwing: SketchPlanProvider = async () => {
      throw new Error('socket hangup (canned)');
    };
    const result = await generateCode({ ...baseInput(), llmProvider: throwing });
    check('sketch from the template', entryOf(result)?.generatedBy === 'planner');
    check('note names the throw', result.notes.some((note) => note.includes('socket hangup')));
  }

  console.log('\n=== 9. no provider: exactly the old behaviour ===');
  {
    const result = await generateCode(baseInput());
    check('sketch from the template', entryOf(result)?.generatedBy === 'planner');
    check('template pin values are the plan values', pinBlockOf(entryOf(result)?.content ?? '').includes('const int PIN_LED_1_A = 5;'));
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
