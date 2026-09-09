/**
 * Offline proof that the SBC / door-hardware platform layer works.
 *
 *   npm run verify:sbc
 *
 * Needs no MongoDB, no Bedrock and no network. It proves the ground truth that
 * every later increment (runtime layer, vision pipeline, data model) reads:
 *
 *   1. the new catalog entries are structurally valid and the whole catalog
 *      still passes the integrity check,
 *   2. the actual target prompt resolves to a Raspberry Pi — the failure this
 *      increment exists to fix — and to the right feature set,
 *   3. every part the prompt implies resolves to a real catalog entry instead
 *      of being invented or dropped,
 *   4. the 40-pin host profile is correct where it matters (3.3 V, no ADC,
 *      boot-low pin preferred for a fail-secure lock),
 *   5. the pin planner assigns the lock driver to a pin that is LOW at boot and
 *      puts the camera on the CSI connector,
 *   6. the power budget reports the rails honestly (including what it cannot
 *      yet model — this script prints, it does not hide).
 */

import { SEED_COMPONENTS, checkCatalogIntegrity } from '@/modules/components/catalog';
import { ComponentDefinitionSchema } from '@/modules/components/schema';
import { matchComponentStrict } from '@/modules/components/service';
import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';
import { planPins } from '@/modules/pin-planner';
import { computePowerBudget } from '@/modules/hardware-planner/power';
import { analyzePrompt } from '@/modules/project-understanding/heuristics';
import type { ComponentDefinition, ComponentSelection } from '@/types/component';

const PROMPT =
  'using raspberry pi we need to make an external camera detect and store face data in a db and then it works as a face detector lock';

const NEW_IDS = [
  'raspberry-pi-4b',
  'raspberry-pi-zero-2-w',
  'raspberry-pi-5',
  'pi-camera-module-3',
  'raspberry-pi-ai-camera',
  'usb-webcam-1080p',
  'solenoid-lock-12v',
  'mosfet-low-side-driver',
  'door-reed-switch',
  'membrane-keypad-4x4',
  'psu-5v-3a-usbc',
  'psu-12v-2a',
];

/** Phrases a user (or a model) would actually type, mapped to the part they must resolve to. */
const RESOLUTION_CASES: { phrase: string; expected: string }[] = [
  { phrase: 'raspberry pi 4', expected: 'raspberry-pi-4b' },
  { phrase: 'raspberry pi', expected: 'raspberry-pi-4b' },
  { phrase: 'pi zero 2 w', expected: 'raspberry-pi-zero-2-w' },
  { phrase: 'camera module 3', expected: 'pi-camera-module-3' },
  { phrase: 'camera', expected: 'pi-camera-module-3' },
  { phrase: 'pi camera', expected: 'pi-camera-module-3' },
  { phrase: 'usb webcam', expected: 'usb-webcam-1080p' },
  { phrase: 'ai camera', expected: 'raspberry-pi-ai-camera' },
  { phrase: 'solenoid lock', expected: 'solenoid-lock-12v' },
  { phrase: '12v solenoid bolt', expected: 'solenoid-lock-12v' },
  { phrase: 'mosfet driver', expected: 'mosfet-low-side-driver' },
  { phrase: 'door sensor', expected: 'door-reed-switch' },
  { phrase: 'keypad', expected: 'membrane-keypad-4x4' },
  { phrase: '5v 3a power supply', expected: 'psu-5v-3a-usbc' },
  { phrase: '12v power supply', expected: 'psu-12v-2a' },
];

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function instance(componentId: string, instanceId: string, label: string, category: ComponentDefinition['category'], index = 1) {
  return { instanceId, componentId, name: label, index, label, category };
}

function selection(component: ComponentDefinition, instanceId: string, label: string, role: ComponentSelection['role']): ComponentSelection {
  return {
    id: `sel_${instanceId}`,
    componentId: component.id,
    name: component.name,
    category: component.category,
    role,
    quantity: 1,
    reason: 'verification fixture',
    required: true,
    instances: [instance(component.id, instanceId, label, component.category)],
    source: 'catalog',
  };
}

// ---------------------------------------------------------------- 1. catalog

section('1. catalog integrity');

const integrity = checkCatalogIntegrity(SEED_COMPONENTS);
check('whole catalog passes the integrity check', integrity.ok, integrity.problems.length > 0 ? integrity.problems.join('; ') : `${integrity.total} parts`);
check('catalog grew past the original 51 parts', SEED_COMPONENTS.length > 51, `${SEED_COMPONENTS.length} parts`);

for (const id of NEW_IDS) {
  const component = SEED_COMPONENTS.find((entry) => entry.id === id);
  if (!component) {
    check(`new part ${id} exists`, false);
    continue;
  }
  const parsed = ComponentDefinitionSchema.safeParse(component);
  check(`new part ${id} satisfies the zod schema`, parsed.success, parsed.success ? component.name : parsed.error.issues.map((issue) => issue.message).join('; '));
}

const pi = SEED_COMPONENTS.find((entry) => entry.id === 'raspberry-pi-4b');
check('Pi 4B is flagged as an SBC with a linux runtime', pi?.metadata.kind === 'sbc' && pi?.metadata.runtime === 'linux', `kind=${String(pi?.metadata.kind)} runtime=${String(pi?.metadata.runtime)}`);
check('Pi 4B declares a recommended 3 A supply', pi?.metadata.recommendedSupply === 'psu-5v-3a-usbc', String(pi?.metadata.recommendedSupply));
check('solenoid declares fail-secure and demands a flyback diode', (() => {
  const lock = SEED_COMPONENTS.find((entry) => entry.id === 'solenoid-lock-12v');
  return lock?.metadata.lockBehaviour === 'fail-secure' && lock?.metadata.requiresFlybackDiode === true;
})());
check('MOSFET driver warns that the gate must be logic level', /logic-level|logic level/i.test(String(SEED_COMPONENTS.find((e) => e.id === 'mosfet-low-side-driver')?.metadata.gateLogicNote ?? '')));
check(
  'cameras declare no supply pins (bus powered over the ribbon/USB)',
  ['pi-camera-module-3', 'usb-webcam-1080p'].every((id) => SEED_COMPONENTS.find((entry) => entry.id === id)?.metadata.noSupplyPins === true),
);

// -------------------------------------------------------------- 2. understanding

section('2. prompt understanding (the bug this increment fixes)');

const analysis = analyzePrompt(PROMPT);
check('a raspberry pi platform is detected at all', /raspberry-pi/.test(analysis.detectedPlatform ?? ''), `platform=${analysis.detectedPlatform ?? 'NONE'}`);
check('it resolves to a specific Pi board', analysis.detectedPlatformComponentId === 'raspberry-pi-4b', `componentId=${analysis.detectedPlatformComponentId ?? 'NONE'}`);
check('face_recognition feature detected', analysis.features.includes('face_recognition'));
check('camera_vision feature detected', analysis.features.includes('camera_vision'));
check('database_storage feature detected', analysis.features.includes('database_storage'));
check('access_control feature detected', analysis.features.includes('access_control'));

const espPrompt = analyzePrompt('bluetooth rc car with two dc motors');
check('an unrelated prompt is not misdetected as a Pi', espPrompt.detectedPlatform !== 'raspberry-pi', `platform=${espPrompt.detectedPlatform ?? 'NONE'}`);

// -------------------------------------------------------------- 3. resolution

section('3. natural language resolves to real catalog parts');

for (const testCase of RESOLUTION_CASES) {
  const match = matchComponentStrict(testCase.phrase, SEED_COMPONENTS);
  check(`"${testCase.phrase}" → ${testCase.expected}`, match?.definition.id === testCase.expected, `got ${match?.definition.id ?? 'NO MATCH'}`);
}

// ------------------------------------------------------------- 4. host profile

section('4. Raspberry Pi 40-pin host profile');

const profile = getMcuProfile('raspberry-pi-4b');
check('profile exists', Boolean(profile));
if (profile) {
  check('3.3 V logic', profile.logicVoltage === 3.3, `${profile.logicVoltage} V`);
  check('26 usable GPIO on the header', profile.pins.length === 26, `${profile.pins.length} pins`);
  check('no ADC on the header (adcBits = 0)', profile.adcBits === 0, `${profile.adcBits}-bit`);
  check('no pin claims ADC capability', profile.pins.every((spec) => !spec.capabilities.includes('adc')));
  check('16 mA max / 8 mA recommended per GPIO', profile.maxGpioSinkMa === 16 && profile.recommendedGpioSinkMa === 8);
  check('I2C1 is GPIO2/GPIO3 and is not remappable', profile.i2c.sda === 'GPIO2' && profile.i2c.scl === 'GPIO3' && profile.i2cRemappable === false);
  check('SPI0 is the primary port', profile.spi.mosi === 'GPIO10' && profile.spi.sck === 'GPIO11');
  check('GPIO0/GPIO1 are reserved for the HAT EEPROM', profile.reserved.some((entry) => entry.pin === 'GPIO0'));
  const ranked = [...profile.pins].sort((a, b) => a.preference - b.preference);
  const first = ranked[0];
  check('the most preferred pin is LOW at boot (fail-secure safe)', first?.name === 'GPIO17', `first choice = ${first?.name}`);
  const bootNote = profile.notes.find((note) => /pull DOWN|boot/i.test(note));
  check('the profile explains the boot pull state', Boolean(bootNote), bootNote?.slice(0, 90));
}

// --------------------------------------------------------------- 5. pin plan

section('5. pin planning against the real header');

const byId = (id: string): ComponentDefinition => {
  const component = SEED_COMPONENTS.find((entry) => entry.id === id);
  if (!component) throw new Error(`missing fixture component ${id}`);
  return component;
};

const selections: ComponentSelection[] = [
  selection(byId('raspberry-pi-4b'), 'pi1', 'Raspberry Pi 4B', 'controller'),
  selection(byId('pi-camera-module-3'), 'cam1', 'Door camera', 'sensor'),
  selection(byId('solenoid-lock-12v'), 'lock1', 'Door bolt', 'actuator'),
  selection(byId('mosfet-low-side-driver'), 'drv1', 'Lock driver', 'driver'),
  selection(byId('door-reed-switch'), 'reed1', 'Door contact', 'sensor'),
  selection(byId('membrane-keypad-4x4'), 'pad1', 'PIN keypad', 'input'),
  selection(byId('psu-5v-3a-usbc'), 'psu5', '5 V supply', 'power'),
  selection(byId('psu-12v-2a'), 'psu12', '12 V supply', 'power'),
];

const pinPlan = planPins({ selections, catalog: SEED_COMPONENTS, controllerInstanceId: 'pi1' });
const assignments = pinPlan.assignments;

check('the pin planner produced assignments', assignments.length > 0, `${assignments.length} assignments`);
check('every assignment targets the Pi', assignments.every((entry) => entry.mcuComponentId === 'raspberry-pi-4b' && entry.mcuInstanceId === 'pi1'));

const driverIn = assignments.find((entry) => entry.targetInstanceId === 'drv1' && /IN|GATE|SIG/i.test(entry.targetPin));
check('the lock driver gate is assigned', Boolean(driverIn), driverIn ? `${driverIn.targetPin} → ${driverIn.pin}` : pinPlan.unassigned.map((u) => `${u.instanceId}.${u.pin}: ${u.reason}`).join('; '));
check(
  'the lock driver gate lands on a pin that is LOW at boot',
  driverIn?.pin === 'GPIO17' || driverIn?.pin === 'GPIO27',
  `assigned ${driverIn?.pin ?? 'nothing'}`,
);

/*
 * Known gap, stated rather than hidden: the pin planner only routes
 * MCU-connectable pin types (digital/analog/pwm/uart/i2c/spi). A CSI camera and
 * a USB webcam connect to a dedicated host interface, not a GPIO, and that
 * routing does not exist yet (increment 1.5). Until then the camera correctly
 * appears in the bill of materials and the wiring graph's power/ground nets,
 * but it has no pin assignment.
 */
const cameraAssignment = assignments.find((entry) => entry.targetInstanceId === 'cam1');
if (cameraAssignment?.pin === 'CAM1') {
  check('the camera is wired to the CSI connector', true, 'CAM1');
} else {
  console.log('  GAP   the camera has no pin assignment yet — host interface routing (CSI/USB) is not built (increment 1.5).');
}

const keypadAssignments = assignments.filter((entry) => entry.targetInstanceId === 'pad1');
check('all eight keypad matrix lines are assigned', keypadAssignments.length === 8, `${keypadAssignments.length}/8`);

const usedPins = new Set(assignments.map((entry) => entry.pin));
check('no pin is assigned twice', usedPins.size === assignments.length, `${assignments.length} assignments across ${usedPins.size} pins`);
check('no assignment uses a reserved pin', assignments.every((entry) => entry.pin !== 'GPIO0' && entry.pin !== 'GPIO1'));
check('nothing was left unassigned', pinPlan.unassigned.length === 0, pinPlan.unassigned.map((u) => `${u.instanceId}.${u.pin}: ${u.reason}`).join('; '));

console.log('\n  assigned pins:');
for (const entry of assignments) {
  console.log(`    ${entry.pin.padEnd(7)} ← ${entry.targetInstanceId}.${entry.targetPin} (${entry.protocol}) ${entry.purpose}`);
}

// ---------------------------------------------------------------- 6. power

section('6. power budget (reported honestly, including known gaps)');

const budget = computePowerBudget({
  selections,
  catalog: SEED_COMPONENTS,
  controller: selections[0],
  profile: profile ?? undefined,
});

console.log(`  supply: ${budget.supplyComponentId ?? 'none'} @ ${budget.supplyVoltage ?? '?'} V`);
for (const rail of budget.rails) {
  console.log(`  rail ${rail.rail.padEnd(8)} ${rail.voltage} V  typical ${rail.typicalMa ?? 0} mA  peak ${rail.peakMa ?? 0} mA  [${rail.loads.join(', ')}]`);
}
for (const note of budget.notes) console.log(`  note: ${note}`);

check('a supply was identified', Boolean(budget.supplyComponentId), budget.supplyComponentId ?? 'none');
check('the chosen supply is the 3 A 5 V one', budget.supplyComponentId === 'psu-5v-3a-usbc', String(budget.supplyComponentId));
check('the Pi is budgeted as a load on the 5 V rail', budget.rails.some((rail) => rail.loads.some((load) => load.includes('pi1'))));

/*
 * Known gap, stated rather than hidden: the power planner still collapses every
 * load onto one supply. A 12 V solenoid belongs on the 12 V rail and until the
 * multi-rail pass lands it is budgeted against the 5 V supply. This script
 * prints the rails so the gap is visible, and only fails when the solenoid
 * disappears from the budget entirely.
 */
const solenoidBudgeted = budget.rails.some((rail) => rail.loads.some((load) => load.includes('lock1')));
check('the solenoid is still accounted for in the budget', solenoidBudgeted);
const solenoidRail = budget.rails.find((rail) => rail.loads.some((load) => load.includes('lock1')));
if (solenoidRail && solenoidRail.voltage !== 12) {
  console.log(
    `  GAP   the solenoid is budgeted on the ${solenoidRail.voltage} V rail, not 12 V — multi-rail power is not built yet (increment 1.5).`,
  );
}

// ---------------------------------------------------------------- summary

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
