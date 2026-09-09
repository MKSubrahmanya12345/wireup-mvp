/**
 * Offline proof of the hands-and-legs protocol.
 *
 *   npm run verify:human
 *
 * No MongoDB, no Bedrock, no network. It proves the promises the protocol
 * makes in `docs/pi-face-lock/HANDS-AND-LEGS.md`:
 *
 *   1. a finished hardware plan turns into an ordered queue of things only a
 *      human can do,
 *   2. every task says why the agent cannot do it and what the answer is for,
 *   3. every task has a default, so silence can never deadlock the build,
 *   4. submit / skip / grade transitions behave, and facts are grounded,
 *   5. a failed verify is rejected rather than quietly accepted.
 */

import { SEED_COMPONENTS } from '@/modules/components/catalog';
import {
  blockingPending,
  claimTask,
  factsAsRecord,
  humanLoopSummary,
  nextActionable,
  planCommissioning,
  skipTask,
  submitTask,
} from '@/modules/human-loop';
import { emptyHumanLoop, type HumanLoopState } from '@/modules/human-loop/types';
import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const byId = (id: string): ComponentDefinition => {
  const component = SEED_COMPONENTS.find((entry) => entry.id === id);
  if (!component) throw new Error(`missing fixture component ${id}`);
  return component;
};

function selection(component: ComponentDefinition, instanceId: string): ComponentSelection {
  return {
    id: `sel_${instanceId}`,
    componentId: component.id,
    name: component.name,
    category: component.category,
    role: 'other',
    quantity: 1,
    reason: 'verification fixture',
    required: true,
    instances: [{ instanceId, componentId: component.id, name: component.name, index: 1, category: component.category }],
    source: 'catalog',
  };
}

const assignments: PinAssignment[] = [
  {
    id: 'pa1',
    mcuInstanceId: 'pi1',
    mcuComponentId: 'raspberry-pi-4b',
    pin: 'GPIO17',
    pinNumber: 17,
    targetInstanceId: 'drv1',
    targetComponentId: 'mosfet-low-side-driver',
    targetPin: 'IN',
    purpose: 'Lock driver gate',
    signal: 'digital',
    direction: 'output',
    protocol: 'gpio',
    required: true,
    rationale: 'GPIO17 idles low at boot, so the bolt cannot fire during startup',
    source: 'planner',
  },
];

const lockProject = {
  components: [
    selection(byId('raspberry-pi-4b'), 'pi1'),
    selection(byId('pi-camera-module-3'), 'cam1'),
    selection(byId('solenoid-lock-12v'), 'lock1'),
    selection(byId('mosfet-low-side-driver'), 'drv1'),
    selection(byId('door-reed-switch'), 'reed1'),
    selection(byId('membrane-keypad-4x4'), 'pad1'),
    selection(byId('psu-5v-3a-usbc'), 'psu5'),
    selection(byId('psu-12v-2a'), 'psu12'),
  ],
  catalog: SEED_COMPONENTS,
  pinAssignments: assignments,
};

// ------------------------------------------------------------------- planning

section('1. a hardware plan becomes a human queue');

const tasks = planCommissioning(lockProject);
check('the planner produced tasks', tasks.length > 0, `${tasks.length} tasks`);
check('tasks are ordered', tasks.every((task, index) => task.order === index + 1));
check('ids are unique', new Set(tasks.map((task) => task.id)).size === tasks.length);

const titles = tasks.map((task) => task.title);
const has = (needle: RegExp): boolean => titles.some((title) => needle.test(title));

check('it asks which Pi/camera variant', has(/which pi and camera/i));
check('it asks about sole egress before anything destructive', has(/only way in or out/i));
check('it covers OS bring-up', has(/flash .*raspberry pi os/i));
check('it probes the camera sensor', has(/confirm the camera is detected/i));
check('it bench-tests the solenoid before the Pi is involved', has(/bench-test the solenoid/i));
check('it demands a common ground', tasks.some((task) => (task.steps ?? []).some((step) => /common ground/i.test(step))));
check('it demands the flyback diode be anti-parallel', tasks.some((task) => (task.steps ?? []).some((step) => /ANTI-PARALLEL/i.test(step))));
check('it measures the gate voltage', has(/gate voltage/i));
check('it covers enrollment', has(/enroll each person/i));
check('it tests photo spoofing', has(/hold up a photo/i));
check('it tests that a stranger is refused', has(/unknown person is refused/i));
check('it asks about power loss', has(/pull the power/i));
check('it asks about mains safety', has(/mains supplies are enclosed/i));
check('it tests the PIN fallback', has(/PIN fallback/i));

// ------------------------------------------------------------ protocol rules

section('2. every task obeys the protocol');

check('every task explains why the agent cannot do it', tasks.every((task) => task.why.trim().length > 20));
check('every task says what the answer is for', tasks.every((task) => task.thenWhat.trim().length > 20));
const withoutDefault = tasks.filter((task) => task.default === undefined);
check('every task has a default (silence cannot deadlock)', withoutDefault.length === 0, withoutDefault.map((t) => t.id).join(', '));
check(
  'every action task gives an exact command or explicit steps',
  tasks.filter((task) => task.verb === 'do').every((task) => Boolean(task.command) || (task.steps ?? []).length > 0),
  tasks.filter((task) => task.verb === 'do' && !task.command && (task.steps ?? []).length === 0).map((task) => task.id).join(', '),
);
check('measurement tasks name a unit', tasks.filter((task) => task.answer.kind === 'measurement').every((task) => Boolean(task.answer.unit)));
check('verify tasks state a pass criterion', tasks.filter((task) => task.verb === 'verify').every((task) => Boolean(task.answer.passWhen || task.answer.expect)));
check('high-risk tasks carry a hazard line', tasks.filter((task) => task.risk === 'high').every((task) => Boolean(task.hazard)));
check(
  'destructive tasks come after the decision tasks',
  (() => {
    const firstHighRisk = tasks.findIndex((task) => task.risk === 'high');
    const lastDecision = tasks.map((task) => task.verb).lastIndexOf('ask');
    return firstHighRisk === -1 || lastDecision === -1 || firstHighRisk > lastDecision;
  })(),
);

section('3. blocking vs advisory');
const blocking = blockingPending({ ...emptyHumanLoop(), tasks });
check('the decisions and the reachability gate block the build', blocking.length === 3, `${blocking.length} blocking: ${blocking.map((t) => t.id).join(', ')}`);
check('the first two blocking tasks are design decisions', blocking[0]?.verb === 'ask' && blocking[1]?.verb === 'ask');
check('nothing can proceed until the board is reachable', blocking.some((task) => task.fact === 'host.reachable'));

// --------------------------------------------------------------- lifecycle

section('4. lifecycle: claim, submit, ground a fact');

let state: HumanLoopState = { ...emptyHumanLoop(), tasks, plannedAt: new Date().toISOString() };
const first = tasks[0]!;

check('the next actionable task is the first one', nextActionable(state)?.id === first.id);

state = claimTask(state, first.id).state;
check('claiming moves open → claimed', state.tasks.find((task) => task.id === first.id)?.status === 'claimed');

const submitted = submitTask(state, first.id, { answer: 'pi4+cam3', note: 'going with the default' });
state = submitted.state;
check('submitting moves to accepted', state.tasks.find((task) => task.id === first.id)?.status === 'accepted');
check('the answer grounds a fact', submitted.fact?.key === 'hw.variant' && submitted.fact?.value === 'pi4+cam3', `${submitted.fact?.key}=${submitted.fact?.value}`);
check('the fact is not marked assumed', submitted.fact?.assumed !== true);
check('the fact is queryable as a record', factsAsRecord(state)['hw.variant'] === 'pi4+cam3', JSON.stringify(factsAsRecord(state)));
check('the next actionable task advanced', nextActionable(state)?.id === tasks[1]?.id, `${nextActionable(state)?.id}`);

section('5. skip applies the default and records the assumption');

const verifyTask = tasks.find((task) => task.verb === 'verify' && task.answer.kind === 'boolean')!;
const skipped = skipTask(state, verifyTask.id);
state = skipped.state;
check('skipping marks the task skipped', state.tasks.find((task) => task.id === verifyTask.id)?.status === 'skipped');
check('the default is recorded', skipped.fact?.value === String(verifyTask.default), `${skipped.fact?.key}=${skipped.fact?.value}`);
check('the fact is flagged assumed', skipped.fact?.assumed === true);
check('the summary counts assumptions', humanLoopSummary(state).assumed === 1, `${humanLoopSummary(state).assumed}`);

section('6. a failed verify is rejected, not accepted');

const second = tasks.find((task) => task.verb === 'verify' && task.answer.kind === 'boolean' && task.id !== verifyTask.id)!;
const failed = submitTask(state, second.id, { answer: 'false', evidence: 'bolt did not move' });
check('a "false" verify is graded as rejected', failed.task?.status === 'rejected', String(failed.task?.status));
check('a rejection is still pending work', blockingPending(failed.state).some((task) => task.id === second.id) || failed.state.tasks.find((t) => t.id === second.id)?.status === 'rejected');

const passed = submitTask(state, second.id, { answer: 'true', evidence: 'bolt retracted' });
check('a "true" verify is graded as accepted', passed.task?.status === 'accepted', String(passed.task?.status));

section('7. summary');
const finalState = passed.state;
const summary = humanLoopSummary(finalState);
console.log(`  ${summary.done}/${summary.total} done, ${summary.pending} pending, ${summary.blockingPending} blocking, ${summary.assumed} assumed`);
check('done counts both accepted and skipped', summary.done === 3, String(summary.done));
check('the queue is not reported complete while work remains', summary.complete === false);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
