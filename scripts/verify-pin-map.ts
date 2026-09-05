/**
 * Single-source-of-truth verifier.
 *
 *   pnpm tsx scripts/verify-pin-map.ts
 *
 * Reproduces the exact failure a reviewer reported: the pin planner decided
 *
 *     Pushbutton → D4,  LED → D7,  OLED SDA → A4,  OLED SCL → A5
 *
 * while the model-authored firmware said
 *
 *     const int BUTTON_PIN = 2;
 *     const int LED_PIN = 3;
 *
 * i.e. the firmware made a SECOND pin decision after the planner had already
 * made the first. The fixed architecture must:
 *
 *   1. freeze the plan into one ResolvedPinMap shared by firmware + diagram;
 *   2. re-point hand-written constants at the map;
 *   3. rewrite raw pin literals at call sites to the map's PIN_* constants;
 *   4. reject a sketch that references pins the map does not contain;
 *   5. validate firmware ↔ map ↔ diagram agreement so drift is an error,
 *      never a silent ship.
 *
 * Needs no Bedrock and no MongoDB. Exits 0 when every check passes.
 */

import type { ComponentSelection } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';
import type { ProjectRequirements, ProjectState, SoftwarePlan } from '@/types/project';
import type { ValidationIssue } from '@/types/validation';

import { SEED_COMPONENTS } from '@/modules/components/catalog';
import { generateCode, auditFirmwareAgainstPinMap, pinAuditErrors } from '@/modules/code-generator';
import { buildResolvedPinMap, formatResolvedPinMapForPrompt } from '@/modules/pin-planner/resolved-map';
import { planDeterministicChanges } from '@/modules/fixer/strategies';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/* ------------------------------------------------------------------------- */
/* Fixtures: an Uno with a pushbutton, an LED and an OLED — planner ROWS.     */
/* ------------------------------------------------------------------------- */

function makeAssignment(pin: string, pinNumber: number, instanceId: string, componentId: string, targetPin: string, direction: 'input' | 'output', protocol: PinAssignment['protocol'], signal: PinAssignment['signal']): PinAssignment {
  return {
    id: `assign-test-${instanceId}-${targetPin}`,
    mcuInstanceId: 'arduino-uno-r3-1',
    mcuComponentId: 'arduino-uno-r3',
    pin,
    pinNumber,
    targetInstanceId: instanceId,
    targetComponentId: componentId,
    targetPin,
    purpose: `${componentId} ${targetPin}`,
    signal,
    direction,
    protocol,
    required: true,
    rationale: 'planner pick',
    source: 'planner',
  };
}

const ASSIGNMENTS: PinAssignment[] = [
  makeAssignment('A4', 18, 'oled-ssd1306-i2c-1', 'oled-ssd1306-i2c', 'SDA', 'output', 'i2c', 'i2c'),
  makeAssignment('A5', 19, 'oled-ssd1306-i2c-1', 'oled-ssd1306-i2c', 'SCL', 'output', 'i2c', 'i2c'),
  makeAssignment('D4', 4, 'pushbutton-6mm-1', 'pushbutton-6mm', '1', 'input', 'gpio', 'digital'),
  makeAssignment('D7', 7, 'led-5mm-1', 'led-5mm', 'A', 'output', 'gpio', 'digital'),
];

function selections(): ComponentSelection[] {
  const pick = (componentId: string, role: ComponentSelection['role'], category: ComponentSelection['category']) => {
    const definition = SEED_COMPONENTS.find((entry) => entry.id === componentId);
    if (!definition) throw new Error(`missing seed ${componentId}`);
    return {
      id: `sel-${componentId}`,
      componentId,
      name: definition.name,
      category,
      quantity: 1,
      role,
      reason: 'test fixture',
      required: true,
      source: 'planner' as const,
      instances: [{ instanceId: `${componentId}-1`, componentId, index: 1, name: definition.name, category }],
    };
  };
  return [
    pick('arduino-uno-r3', 'controller', 'microcontroller'),
    pick('pushbutton-6mm', 'input', 'input_device'),
    pick('led-5mm', 'actuator', 'actuator'),
    pick('oled-ssd1306-i2c', 'display', 'display'),
  ];
}

const REQUIREMENTS: ProjectRequirements = {
  goal: 'Count button presses on an OLED',
  summary: 'Pushbutton increments a counter shown on an SSD1306 OLED; an LED blinks on every press.',
  requirements: ['count presses', 'show the count on the OLED', 'blink the LED on each press'],
  inputs: ['pushbutton'],
  outputs: ['OLED display', 'LED'],
  behaviors: ['count increments on release', 'LED blinks per press'],
  constraints: [],
  platformRequirements: [],
  communicationRequirements: [],
  powerRequirements: [],
  quantities: {},  features: ['button_input', 'display'],
  assumptions: [],
  ambiguities: [],
};

const SOFTWARE_PLAN: SoftwarePlan = {
  architecture: 'Debounced button drives a counter rendered on the OLED.',
  language: 'arduino-cpp',
  framework: 'Arduino',
  modules: [],
  libraries: [
    { name: 'Adafruit SSD1306', import: 'Adafruit_SSD1306.h', purpose: 'OLED driver', manager: 'arduino', builtIn: false },
    { name: 'Adafruit GFX Library', import: 'Adafruit_GFX.h', purpose: 'GFX primitives', manager: 'arduino', builtIn: false },
    { name: 'Wire', import: 'Wire.h', purpose: 'I2C bus', manager: 'arduino', builtIn: true },
  ],
  controlStates: [],
  inputHandling: ['button debounce'],
  sensorLogic: [],
  actuatorLogic: ['LED blink'],
  communication: null,
  safety: ['none'],
  loopStrategy: 'non-blocking',
  files: [{ path: 'sketch.ino', purpose: 'entry point' }],
};

/* The code_pin_mismatch strategy branch only reads issue text, so the project
 * fixture can stay minimal — it just has to typecheck as a ProjectState. */
function minimalProject(): ProjectState {
  const now = new Date().toISOString();
  return {
    id: 'project-fix-route-test',
    name: 'Fix routing test',
    prompt: 'Count button presses on an OLED',
    status: 'completed',
    stage: 'completed',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    error: null,
    requirements: REQUIREMENTS,
    components: selections(),
    hardwarePlan: null,
    pinAssignments: ASSIGNMENTS,
    wiring: null,
    softwarePlan: SOFTWARE_PLAN,
    artifacts: { code: null, diagram: null, libraries: null, instructions: null },
    validation: null,
    revisions: [],
    events: [],
    iteration: { current: 1, max: 3 },
    llm: { calls: [] },
    revision: 1,
  };
}

/*
 * The buggy model sketch from the report: the pin-map block is present and
 * correct, but the model's own constants contradict it — a second decision.
 */
const BUGGY_MODEL_SKETCH = `/*
 * Button counter on Arduino Uno with SSD1306 OLED.
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// Pin map generated by the Wireup pin planner for Arduino Uno R3.
// These constants are authoritative
const int PIN_PUSHBUTTON_6MM_1_1 = 4;
const int PIN_LED_5MM_1_A = 7;
const int PIN_OLED_SSD1306_I2C_1_SDA = A4;
const int PIN_OLED_SSD1306_I2C_1_SCL = A5;

// App pins (model-chosen — WRONG, contradicts the map)
const int BUTTON_PIN = 2;
const int LED_PIN = 3;

#define OLED_ADDRESS 0x3C
Adafruit_SSD1306 display(128, 64, &Wire, -1);
long pressCount = 0;
bool lastReading = HIGH;

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  Wire.begin();
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
  display.clearDisplay();
  display.display();
}

void loop() {
  bool reading = digitalRead(BUTTON_PIN);
  if (reading == LOW && lastReading == HIGH) {
    pressCount++;
    digitalWrite(LED_PIN, HIGH);
    delay(50);
    digitalWrite(3, LOW);        // raw literal form of the same wrong pin
    display.clearDisplay();
    display.setTextSize(2);
    display.setCursor(0, 0);
    display.print(pressCount);
    display.display();
  }
  lastReading = reading;
}
`;

/** Same sketch but with a pin that exists NOWHERE in the plan (D12 unused). */
const HALLUCINATED_PIN_SKETCH = BUGGY_MODEL_SKETCH.replace('pinMode(LED_PIN, OUTPUT);', 'pinMode(LED_PIN, OUTPUT);\n  pinMode(12, OUTPUT);\n  digitalWrite(12, HIGH);');

function runGenerator(modelCode: unknown) {
  const pinMap = buildResolvedPinMap({
    assignments: ASSIGNMENTS,
    controller: { componentId: 'arduino-uno-r3', instanceId: 'arduino-uno-r3-1', name: 'Arduino Uno R3' },
  });
  return generateCode({
    projectName: 'Button counter',
    projectSummary: REQUIREMENTS.summary,
    requirements: REQUIREMENTS,
    selections: selections(),
    catalog: SEED_COMPONENTS,
    pinMap,
    serialLinks: [],
    i2cBuses: [
      { id: 'i2c0', sdaPin: 'A4', sclPin: 'A5', devices: [{ instanceId: 'oled-ssd1306-i2c-1', componentId: 'oled-ssd1306-i2c', address: '0x3C' }] },
    ],
    softwarePlan: SOFTWARE_PLAN,
    controllerName: 'Arduino Uno R3',
    revision: 1,
    modelCode,
  });
}

function entryContent(artifact: ReturnType<typeof generateCode>): string {
  return artifact.files.find((file) => file.path === 'sketch.ino')?.content ?? '';
}

function main(): number {
  console.log('wireup · pin-map single-source-of-truth verifier\n');

  /* --- 0. The map is one object with the feedback's JSON shape ----------- */
  console.log('0. the resolved pin map has the authoritative shape');
  const pinMap = buildResolvedPinMap({
    assignments: ASSIGNMENTS,
    controller: { componentId: 'arduino-uno-r3', instanceId: 'arduino-uno-r3-1', name: 'Arduino Uno R3' },
  });
  check('byTarget: pushbutton-6mm-1:1 → D4', pinMap.byTarget['PUSHBUTTON-6MM-1:1'] === 'D4', JSON.stringify(pinMap.byTarget));
  check('byTarget: led-5mm-1:A → D7', pinMap.byTarget['LED-5MM-1:A'] === 'D7');
  check('byTarget: OLED SDA → A4, SCL → A5', pinMap.byTarget['OLED-SSD1306-I2C-1:SDA'] === 'A4' && pinMap.byTarget['OLED-SSD1306-I2C-1:SCL'] === 'A5');
  const rendered = formatResolvedPinMapForPrompt(pinMap);
  check('prompt rendering exists and names the constants', /PIN_PUSHBUTTON_6MM_1_1 = 4/.test(rendered) && /"led-5mm-1:A": "D7"/.test(rendered));

  /* --- 1. Buggy model sketch: wrong constants are re-pointed ------------- */
  console.log('\n1. model firmware that contradicts the map is corrected, not trusted');
  const corrected = runGenerator({ entryPoint: 'sketch.ino', files: [{ path: 'sketch.ino', language: 'arduino', purpose: 'model', content: BUGGY_MODEL_SKETCH }] });
  const correctedSource = entryContent(corrected);

  check('BUTTON_PIN re-pointed to 4 (planner), not 2 (model)', /const int BUTTON_PIN = 4;/.test(correctedSource), /BUTTON_PIN = \d/.exec(correctedSource)?.[0] ?? 'missing');
  check('LED_PIN re-pointed to 7 (planner), not 3 (model)', /const int LED_PIN = 7;/.test(correctedSource), /LED_PIN = \d/.exec(correctedSource)?.[0] ?? 'missing');
  check('entry point is still the model sketch', corrected.files[0]?.generatedBy === 'model', corrected.files[0]?.generatedBy ?? '?');

  /* --- 2. Raw call-site literals are canonicalised to map constants ------ */
  console.log('\n2. raw pin literals at call sites become map constants');
  check('digitalWrite(3, LOW) rewritten to the LED constant', !/digitalWrite\(\s*3\s*,/.test(correctedSource), /digitalWrite\([^)]*LOW\)/.exec(correctedSource)?.[0] ?? 'none');
  check('the rewritten literal is PIN_LED_5MM_1_A', /digitalWrite\(\s*PIN_LED_5MM_1_A\s*,\s*LOW\)/.test(correctedSource));

  /* --- 3. Bus pins driven by hand are hard violations --------------------- */
  console.log('\n3. hand-driven shared-bus pins are hard violations');
  const busOnly = BUGGY_MODEL_SKETCH.replace('const int BUTTON_PIN = 2;', 'const int BUTTON_PIN = 4;')
    .replace('const int LED_PIN = 3;', 'const int LED_PIN = 7;')
    .replace('digitalWrite(3, LOW);', 'digitalWrite(LED_PIN, LOW);')
    .replace('Wire.begin();', 'pinMode(A4, OUTPUT); // model drives the I2C bus pin by hand — forbidden\n  Wire.begin();');
  const busAudit = auditFirmwareAgainstPinMap(busOnly, pinMap);
  check('pinMode(A4, OUTPUT) is a bus_pin_driven violation (SDA belongs to Wire)', busAudit.violations.some((entry) => entry.kind === 'bus_pin_driven' && entry.api === 'pinmode' && entry.token === 'A4'), busAudit.violations.map((entry) => `${entry.kind}:${entry.api}(${entry.token})`).join(', ') || 'none');
  const busRejected = runGenerator({ entryPoint: 'sketch.ino', files: [{ path: 'sketch.ino', language: 'arduino', purpose: 'model', content: busOnly }] });
  check('a sketch that drives a bus pin is rejected for the safe template', busRejected.files[0]?.generatedBy === 'planner', busRejected.files[0]?.generatedBy ?? '?');
  check('the shipped template has Wire.begin() and no SDA pinMode', /Wire\.begin\(\)/.test(entryContent(busRejected)) && !/pinMode\(\s*PIN_OLED_SSD1306_I2C_1_SDA/.test(entryContent(busRejected)));

  /* --- 4. A pin the map does not contain rejects the model sketch -------- */
  console.log('\n4. firmware with a hallucinated pin is rejected wholesale');
  const rejected = runGenerator({ entryPoint: 'sketch.ino', files: [{ path: 'sketch.ino', language: 'arduino', purpose: 'model', content: HALLUCINATED_PIN_SKETCH }] });
  const rejectedSource = entryContent(rejected);
  check('entry point falls back to the deterministic planner sketch', rejected.files[0]?.generatedBy === 'planner', rejected.files[0]?.generatedBy ?? '?');
  check('fallback contains no trace of pin 12', !/\b12\b\s*,\s*OUTPUT/.test(rejectedSource) && !/digitalWrite\(\s*12\s*,/.test(rejectedSource));
  check('the rejection is explained in the notes', rejected.notes.some((note) => /outside the resolved pin map/.test(note)), rejected.notes[rejected.notes.length - 1]?.slice(0, 120) ?? 'no note');
  const rejectedAudit = auditFirmwareAgainstPinMap(rejectedSource, pinMap);
  check('the shipped fallback passes the audit clean', pinAuditErrors(rejectedAudit).length === 0, pinAuditErrors(rejectedAudit).map((v) => v.message)[0] ?? '');

  /* --- 5. The deterministic template itself is audit-clean --------------- */
  console.log('\n5. the template generated straight from the map passes the gate');
  const deterministic = runGenerator(undefined);
  const detSource = entryContent(deterministic);
  const detAudit = auditFirmwareAgainstPinMap(detSource, pinMap);
  check('no violations in the deterministic sketch', pinAuditErrors(detAudit).length === 0, pinAuditErrors(detAudit).map((v) => v.message).join(' | '));
  check('deterministic sketch uses the map constants', detSource.includes('PIN_PUSHBUTTON_6MM_1_1') && detSource.includes('PIN_LED_5MM_1_A'));
  check('every audit rewrite target exists (no dangling rewrites possible)', detAudit.violations.length === 0);

  /* --- 6. Identifier aliases are traced, wrong ones are caught ------------ */
  console.log('\n6. hand aliases that disagree with the map are caught');
  const aliasOk = BUGGY_MODEL_SKETCH.replace('const int BUTTON_PIN = 2;', 'const int BUTTON_PIN = 4;')
    .replace('const int LED_PIN = 3;', 'const byte BTN_LED = 7;')
    .replace(/LED_PIN/g, 'BTN_LED')
    .replace('digitalWrite(3, LOW);', 'digitalWrite(BTN_LED, LOW);');
  const aliasOkAudit = auditFirmwareAgainstPinMap(aliasOk, pinMap);
  check('an alias with the planner value passes (BTN_LED = 7 → LED on D7)', pinAuditErrors(aliasOkAudit).length === 0, pinAuditErrors(aliasOkAudit).map((v) => v.message)[0] ?? 'clean');

  const aliasWrong = aliasOk.replace('const byte BTN_LED = 7;', 'const byte BTN_LED = 9;');
  const aliasWrongAudit = auditFirmwareAgainstPinMap(aliasWrong, pinMap);
  check(
    'an alias with a foreign value is a violation (BTN_LED = 9, nothing is on D9)',
    aliasWrongAudit.violations.some((violation) => violation.kind === 'unknown_pin_constant' && violation.token === 'BTN_LED'),
    aliasWrongAudit.violations.map((violation) => `${violation.token}:${violation.kind}`).join(', ') || 'none',
  );
  const aliasRejected = runGenerator({ entryPoint: 'sketch.ino', files: [{ path: 'sketch.ino', language: 'arduino', purpose: 'model', content: aliasWrong }] });
  check('the generator rejects that sketch for the template', aliasRejected.files[0]?.generatedBy === 'planner', aliasRejected.files[0]?.generatedBy ?? '?');

  /* --- 7. The fixer rebuilds firmware for untrusted-pin issues ------------ */
  console.log('\n7. the fixer rebuilds firmware when the firmware made its own pin decision');
  const project = minimalProject();
  const fixerPlan = (sketch: string) => {
    const audit = auditFirmwareAgainstPinMap(sketch, pinMap);
    if (pinAuditErrors(audit).length === 0) return { reruns: new Set<string>(), handled: 0 };
    // Build the validation issue exactly the way validator/rules.ts does, then
    // ask the fixer what it would do with it.
    const violation = pinAuditErrors(audit)[0]!;
    const issue: ValidationIssue = {
      id: 'issue-fix-route',
      code: 'code_pin_mismatch',
      severity: 'error',
      domain: 'code',
      message: `sketch.ino:${violation.line} ${violation.message}`,
      target: { artifact: 'code', filePath: 'sketch.ino' },
      autoFixable: true,
      origin: 'rules',
    };
    const outcome = planDeterministicChanges({ project, issues: [issue], catalog: SEED_COMPONENTS, iteration: 2 });
    const reruns = new Set(outcome.changes.filter((change) => change.op === 'rerun_stage').map((change) => change.stage ?? ''));
    return { reruns, handled: outcome.handledIssueIds.length };
  };

  const hallucinatedRoute = fixerPlan(HALLUCINATED_PIN_SKETCH);
  check('a hallucinated pin routes to a firmware rebuild (not an in-place patch)', hallucinatedRoute.reruns.has('code') && hallucinatedRoute.handled === 1, `reruns: ${[...hallucinatedRoute.reruns].join(', ') || 'none'}`);
  const busRoute = fixerPlan(busOnly);
  check('a hand-driven bus pin routes to a firmware rebuild', busRoute.reruns.has('code') && busRoute.handled === 1, `reruns: ${[...busRoute.reruns].join(', ') || 'none'}`);
  const aliasRoute = fixerPlan(aliasWrong);
  check('a wrong hand alias routes to a firmware rebuild', aliasRoute.reruns.has('code') && aliasRoute.handled === 1, `reruns: ${[...aliasRoute.reruns].join(', ') || 'none'}`);

  // A wrong PIN-plan constant that the sync pass can re-point stays on the
  // cheap in-place path — no rebuild needed.
  const rePointIssue: ValidationIssue = {
    id: 'issue-repoint',
    code: 'code_pin_mismatch',
    severity: 'error',
    domain: 'code',
    message: 'sketch.ino declares LED_PIN = 3 but the pin plan wires that peripheral to 7.',
    target: { artifact: 'code', filePath: 'sketch.ino' },
    autoFixable: true,
    origin: 'rules',
  };
  const rePointOutcome = planDeterministicChanges({ project, issues: [rePointIssue], catalog: SEED_COMPONENTS, iteration: 2 });
  const rePointReruns = rePointOutcome.changes.filter((change) => change.op === 'rerun_stage');
  check('a re-pointable constant does NOT trigger a rebuild', rePointReruns.length === 0 && rePointOutcome.handledIssueIds.length === 1, `reruns: ${rePointReruns.map((change) => change.stage).join(', ') || 'none'}`);

  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✕ ${failures} check(s) failed`}`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
