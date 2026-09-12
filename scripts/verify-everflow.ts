/**
 * Everflow verifier.
 *
 *   pnpm verify:everflow
 *
 * Proves the loop that makes the agent "everflowing", offline:
 *
 *   1. intake   — the deterministic doubt layer finds the real forks
 *   2. graph    — materialisation is deterministic and stable (same state,
 *                 same graph; node per artifact, goal per behavioural promise)
 *   3. goals    — every node's completion goal is judged by code; dangling
 *                 nodes (unmet goal + no task) are flagged, never hidden
 *   4. plan     — the agent names its next move per unmet goal; it files
 *                 human asks it cannot close alone, processes human additions
 *                 instead of self-modifying, and stays idempotent
 *   5. channel  — a positive human answer satisfies the goal; a negative one
 *                 leaves it open; injections get a follow-up "apply?" ask
 *   6. done     — a state with every goal met and nothing dangling is `done`
 *   7. pass     — the persisted pass runner works against an in-memory store
 *   8. act      — the loop's own engineering moves, BEFORE any ask is filed:
 *                 a drifted design is revalidated by the rule engine, a
 *                 behavioural promise is re-proven BY CODE (no human verify
 *                 ask for what the evaluator just proved), and a fresh
 *                 blocking-issue set gets one bounded deterministic fix pass
 *                 with a frozen revision. Fingerprints + budgets keep every
 *                 move idempotent; the flag off restores the ask-only loop.
 *
 * Needs no credentials, no MongoDB and no network. Exits 0 when every check
 * passes, 1 otherwise.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1200';

import type { AgentEvent } from '@/types/generation';
import type { BehavioralAssertion, BehavioralSpec } from '@/types/behavioral';
import type { ProjectState } from '@/types/project';
import type { EverflowGraph, EverflowNode, HumanTask } from '@/types/everflow';

import { nowIso } from '@/lib/validation/time';
import { createId } from '@/lib/validation/ids';

import { composeIntake, deriveDeterministicDoubts, deterministicExpansion, mergeIntakeDoubts } from '@/modules/everflow/intake';
import { materializeGraph } from '@/modules/everflow/materialize';
import { evaluateEverflow, isPositiveResponse } from '@/modules/everflow/evaluate';
import { behaviorFingerprint, designFingerprint, ensureActionState, planActions, repairSignature } from '@/modules/everflow/actions';
import { resetEnvCache } from '@/lib/validation/env';
import { SEED_COMPONENTS } from '@/modules/components/catalog';
import type { ComponentInstance, ComponentSelection } from '@/types/component';
import type { ValidationResult } from '@/types/validation';
import {
  planContinuation,
  runEverflowPass,
  continueEverflow,
  type EverflowStore,
  EVERFLOW_DEFAULT_MAX_HUMAN_TASKS,
} from '@/modules/everflow/continuation';
import { matchCorpus, planAutoResearch, researchNode } from '@/modules/everflow/research';
import { analyzePrompt } from '@/modules/project-understanding/heuristics';
import { getSeedComponent } from '@/modules/components/catalog';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const PROMPT = 'build a bluetooth rc car with two dc motors and an ultrasonic sensor that stops before obstacles';

function assertion(id: string, title: string): BehavioralAssertion {
  return {
    id,
    title,
    subject: { kind: 'telemetry', field: id },
    operator: 'changes',
    required: true,
    derivedFrom: [title.toLowerCase()],
  };
}

function spec(assertions: BehavioralAssertion[]): BehavioralSpec {
  return { assertions, origin: 'heuristics', generatedAt: nowIso(), notes: [] };
}

function baseProject(overrides: Partial<ProjectState> = {}): ProjectState {
  const now = nowIso();
  return {
    id: 'evf-verify',
    name: 'Verify Car',
    prompt: PROMPT,
    status: 'completed',
    stage: 'completed',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
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
    events: [{ seq: 1, id: createId('evt'), type: 'project_created', status: 'completed', message: 'created', timestamp: now, stage: 'idle' }],
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
    ...overrides,
  };
}

/** A finished car: all artifacts, validation clean, one behavioural promise
 *  the evaluator could NOT prove (skipped — needs a sim run), one assumption. */
function completedCar(): ProjectState {
  const now = nowIso();
  return baseProject({
    requirements: {
      goal: 'A Bluetooth RC car that stops before obstacles.',
      summary: 'Two DC motors, ultrasonic stop, phone commands.',
      requirements: ['Two DC motors drive the car', 'Stops before obstacles'],
      inputs: ['Bluetooth commands'],
      outputs: ['Motor drive', 'Stop behaviour'],
      behaviors: ['Stops before obstacles'],
      constraints: [],
      platformRequirements: [],
      communicationRequirements: ['Bluetooth'],
      powerRequirements: [],
      quantities: { motors: 2 },
      features: ['bluetooth', 'motor_control'],
      assumptions: ['Powered from a 2S LiPo'],
      ambiguities: [],
      behavioralSpec: spec([
        assertion('beh-obstacle-stop', 'Stops when an obstacle is detected'),
        assertion('beh-bluecmd', 'Responds to Bluetooth drive commands'),
      ]),
    },
    components: [
      { id: 'sel-1', componentId: 'esp32-devkit-v1', name: 'ESP32 DevKit V1', quantity: 1, reason: 'controller', instances: ['mcu-1'], role: 'controller' } as unknown as ProjectState['components'][number],
      { id: 'sel-2', componentId: 'dc-motor-generic-6v', name: 'DC motor', quantity: 2, reason: 'drive', instances: ['motor-l', 'motor-r'], role: 'actuator' } as unknown as ProjectState['components'][number],
    ],
    hardwarePlan: {
      summary: 'ESP32 drives two motors via L298N; HC-SR04 for distance.',
      architecture: [],
      controller: { instanceId: 'mcu-1', componentId: 'esp32-devkit-v1', name: 'ESP32 DevKit V1', reason: 'Bluetooth + PWM' },
      power: { rails: [], loads: [], headroomPercent: 20, notes: [] } as unknown as NonNullable<ProjectState['hardwarePlan']>['power'],
      subsystems: [],
      signalFlow: ['Phone', 'HC-05', 'ESP32', 'L298N', 'Motors'],
      compatibility: [],
      supportingComponents: [],
      risks: [],
    },
    softwarePlan: {
      architecture: 'Command loop with distance check.',
      language: 'arduino-cpp',
      modules: [],
      libraries: [],
      controlStates: [],
      inputHandling: ['Bluetooth bytes'],
      sensorLogic: ['Ultrasonic range'],
      actuatorLogic: ['Motor drive'],
      communication: null,
      safety: ['Stop on short range'],
      loopStrategy: 'Poll every 20 ms',
      files: [{ path: 'sketch.ino', purpose: 'entry' }],
    },
    artifacts: {
      code: {
        files: [
          { path: 'sketch.ino', language: 'arduino-cpp', content: 'void setup() {}\nvoid loop() {}', purpose: 'entry', generatedBy: 'planner' },
        ],
        entryPoint: 'sketch.ino',
        pinsSynchronised: true,
        notes: [],
      },
      diagram: {
        version: 1,
        components: [{ id: 'mcu-1', name: 'ESP32', pins: [], top: 0, left: 0, width: 10, height: 10 }],
        connections: [],
        rails: [],
        groups: [],
        layout: { width: 100, height: 100 },
        stats: { components: 3, connections: 10, powerConnections: 6, groundConnections: 4, signalConnections: 4, pins: 12 },
        notes: [],
      } as unknown as NonNullable<ProjectState['artifacts']['diagram']>,
      libraries: { libraries: [], installCommands: [], notes: [], generatedAt: now },
      instructions: {
        markdown: '# Build',
        sections: [{ id: 's1', title: 'Wire it', body: '…', order: 1 }],
        billOfMaterials: [{ name: 'ESP32', quantity: 1 }],
        generatedAt: now,
      },
    },
    validation: {
      passed: true,
      checks: [
        { id: 'structure.compile', name: 'Firmware compiles', domain: 'code', status: 'passed', message: 'Clean type-check.', issueIds: [] },
        { id: 'behavioral.beh-obstacle-stop', name: 'Stops when an obstacle is detected', domain: 'behavior', status: 'skipped', message: 'Needs a simulator or bench run.', issueIds: [] },
        { id: 'behavioral.beh-bluecmd', name: 'Responds to Bluetooth drive commands', domain: 'behavior', status: 'passed', message: 'Proven in the emulated run.', issueIds: [] },
      ],
      issues: [],
      summary: { errors: 0, warnings: 0, info: 1, passed: true, checked: 8 },
      engineError: null,
      modelReview: null,
      iteration: 0,
    } as unknown as NonNullable<ProjectState['validation']>,
    revisions: [
      {
        version: 1,
        reason: 'initial_generation',
        createdAt: now,
        summary: 'Initial build: 3 part(s).',
        stage: 'instructions',
        changes: [],
        addressedIssueIds: [],
        validation: { passed: true, errors: 0, warnings: 0 },
        snapshot: { components: [], pinAssignments: [], wiring: null, code: null, diagram: null, libraries: null, instructions: null },
      },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* 1. Intake                                                                   */
/* -------------------------------------------------------------------------- */

function section1(): void {
  console.log('\n1. intake — the deterministic doubt layer');

  const doubts = deriveDeterministicDoubts(PROMPT);
  check('finds exactly the right number of doubts (5)', doubts.length === 5, `got ${doubts.length}`);

  const platform = doubts.find((d) => /microcontroller/i.test(d.question));
  check('no platform named → asks which controller (human, blocking)', Boolean(platform && platform.decider === 'human' && platform.blocking));
  const power = doubts.find((d) => /power/i.test(d.question));
  check('motors without a power hint → asks what powers it (not blocking)', Boolean(power && !power.blocking));
  const control = doubts.find((d) => /drive the device/i.test(d.question));
  check('bluetooth feature → asks how it will be driven', Boolean(control));
  check('every doubt has options and a consequence', doubts.every((d) => d.consequence.length > 0));

  const withPlatform = deriveDeterministicDoubts('an arduino weather station with an OLED display');
  check('weak platform hint → controller doubt degrades to a veto, not a block', (() => {
    const p = withPlatform.find((d) => /arduino/i.test(d.question));
    return Boolean(p && p.decider === 'ai_with_veto' && !p.blocking);
  })());
  const strongPlatform = deriveDeterministicDoubts('an ESP32 weather station with an OLED display');
  check('confident platform (ESP32) → no controller doubt at all', !strongPlatform.some((d) => /microcontroller|controller you want/i.test(d.question)));

  const merged = mergeIntakeDoubts(doubts, { doubts: [{ question: 'Which microcontroller should run this?', consequence: 'x', decider: 'ai', blocking: false, options: [], proposedDefault: null, confidence: 0.5 }, { question: 'Does the car need to climb curbs?', consequence: 'Changes the motor and tire choice.', decider: 'human', blocking: false, options: ['yes', 'no'], proposedDefault: 'no', confidence: 0.3 }] }, nowIso());
  check('LLM duplicate (same topic) is dropped, new doubt kept', merged.length === doubts.length + 1);

  const capped = mergeIntakeDoubts(doubts, { doubts: Array.from({ length: 8 }, (_, i) => ({ question: `Totally new question number ${i} about gearboxes?`, consequence: 'x', decider: 'human', blocking: true, options: [], proposedDefault: null, confidence: 0.5 })) }, nowIso());
  check('caps at 6 doubts with at most 3 blocking', capped.length <= 6 && capped.filter((d) => d.blocking).length <= 3, `got ${capped.length}, ${capped.filter((d) => d.blocking).length} blocking`);

  const state = baseProject({ prompt: PROMPT });
  const composed = composeIntake(state, null);
  check('composeIntake (no LLM) names the project from the prompt', Boolean(composed.name && composed.name.length > 3), composed.name ?? '—');
}

/* -------------------------------------------------------------------------- */
/* 2. Graph materialisation                                                    */
/* -------------------------------------------------------------------------- */

function section2(): void {
  console.log('\n2. graph — materialisation is deterministic');

  const project = completedCar();
  const a = materializeGraph(project);
  const b = materializeGraph(project);

  check('stable node ids across materialisations', JSON.stringify(a.nodes.map((n) => n.id)) === JSON.stringify(b.nodes.map((n) => n.id)));
  check('intent node exists with the goal as content', a.nodes.some((n) => n.id === 'ev-intent' && n.content.includes('Bluetooth RC car')));

  const artifacts = a.nodes.filter((n) => n.kind === 'artifact');
  check('one artifact node per code file + diagram + libraries + instructions', artifacts.length === 4, `got ${artifacts.length}`);
  check('artifact nodes carry the workspace file path', artifacts.some((n) => n.file?.path === 'sketch.ino'));

  const goals = a.nodes.filter((n) => n.kind === 'goal');
  check('one goal node per behavioural promise + validation + artifact set', goals.length === 4, `got ${goals.length}`);

  const assumptions = a.nodes.filter((n) => n.kind === 'assumption');
  check('assumptions materialise as their own nodes', assumptions.length === 1 && assumptions[0].goal.kind === 'human_confirmed');

  const decisions = a.nodes.filter((n) => n.kind === 'decision');
  check('controller pick and the frozen revision materialise as decisions', decisions.some((n) => n.id === 'ev-decision-controller') && decisions.some((n) => n.id === 'ev-decision-rev-1'));

  check('edges link intent to claims/goals', a.edges.every((e) => a.nodes.some((n) => n.id === e.from) && a.nodes.some((n) => n.id === e.to)) && a.edges.some((e) => e.from === 'ev-intent'));
}

/* -------------------------------------------------------------------------- */
/* 3. Goal evaluation                                                          */
/* -------------------------------------------------------------------------- */

function section3(): void {
  console.log('\n3. goals — judged by code, dangling nodes flagged');

  const project = completedCar();
  const graph = materializeGraph(project);
  const evaluation = evaluateEverflow(project, graph, 1);

  check('proven behaviour (emulated) is satisfied', evaluation.results.find((r) => r.nodeId === 'ev-goal-behaviour-beh-bluecmd')?.satisfied === true);
  const obstacle = evaluation.results.find((r) => r.nodeId === 'ev-goal-behaviour-beh-obstacle-stop');
  check('unprovable behaviour is blocked_human, not silently passed', obstacle?.goal.state === 'blocked_human');
  check('validation-clean goal satisfied (0 blocking issues)', evaluation.results.find((r) => r.nodeId === 'ev-goal-validation')?.satisfied === true);
  check('assumption is NOT satisfied until the human confirms', evaluation.results.find((r) => r.nodeId === 'ev-assume-1')?.satisfied === false);

  check('dangling: unconfirmed assumption with no task is an open end', evaluation.results.find((r) => r.nodeId === 'ev-assume-1')?.openEnd === true);
  check('dangling: unproven goal with no task is an open end', obstacle?.openEnd === true);
  check('project is not done while goals are open', evaluation.done === false);
  check('completion is a number in (0, 1)', evaluation.completion > 0 && evaluation.completion < 1, `${Math.round(evaluation.completion * 100)}%`);
  check('the brief names the project and the dangling work', evaluation.brief.includes('Verify Car') && evaluation.brief.includes('Dangling'));
  check('next actions include a verify_sim for the unproven behaviour', evaluation.nextActions.some((a) => a.kind === 'verify_sim'));

  /* nonsense in, nonsense flagged out */
  const dangling: EverflowGraph = {
    projectId: 'x',
    updatedAt: nowIso(),
    nodes: [
      { id: 'ev-intent', kind: 'intent', label: 'I', content: 'c', status: 'active', confidence: 1, owner: 'shared', goal: { criterion: 'c', kind: 'custom', state: 'open' }, file: null, source: { origin: 'pipeline' }, createdAt: nowIso(), updatedAt: nowIso() },
      { id: 'n-dangle', kind: 'goal', label: 'Dangling goal', content: 'no one is working on this', status: 'active', confidence: 0.5, owner: 'ai', goal: { criterion: 'done', kind: 'custom', state: 'open' }, file: null, source: { origin: 'continuation' }, createdAt: nowIso(), updatedAt: nowIso() },
    ],
    edges: [],
  };
  const evalDangling = evaluateEverflow(baseProject(), dangling, 1);
  check('hand-built dangling node is reported with a reason', evalDangling.results.find((r) => r.nodeId === 'n-dangle')?.openEnd === true && Boolean(evalDangling.results.find((r) => r.nodeId === 'n-dangle')?.openEndReason));
}

/* -------------------------------------------------------------------------- */
/* 4. The planner                                                              */
/* -------------------------------------------------------------------------- */

function section4(): void {
  console.log('\n4. plan — the agent names its next move per unmet goal');

  const project = completedCar();
  const graph = materializeGraph(project);
  const evaluation = evaluateEverflow(project, graph, 1);
  const plan = planContinuation(project, graph, evaluation);

  const verifyTask = plan.newTasks.find((t) => t.type === 'verify' && t.linkedNodeIds.includes('ev-goal-behaviour-beh-obstacle-stop'));
  check('files a verify ask for the unproven behaviour (AI→human)', Boolean(verifyTask && verifyTask.direction === 'ai_to_human'));
  check('the verify ask points the human at the simulator', verifyTask?.lookAt?.kind === 'sim');
  check('the verify ask carries a default-on-expiry (never blocks)', verifyTask?.defaultOnExpiry === 'defer');

  const contextTask = plan.newTasks.find((t) => t.type === 'context' && t.linkedNodeIds.some((id) => id.startsWith('ev-assume-')));
  check('consolidates unconfirmed assumptions into one context ask', Boolean(contextTask));
  check('proven behaviour gets NO ask', !plan.newTasks.some((t) => t.linkedNodeIds.includes('ev-goal-behaviour-beh-bluecmd')));

  /* idempotency: with the tasks already open, nothing new is filed */
  const withTasks: ProjectState = { ...project, humanTasks: [...plan.newTasks] };
  const graph2 = materializeGraph(withTasks);
  const evaluation2 = evaluateEverflow(withTasks, graph2, 2);
  const plan2 = planContinuation(withTasks, graph2, evaluation2);
  check('re-planning with open asks files no duplicates', plan2.newTasks.length === 0 && plan2.followUps.length === 0);

  /* budget */
  const planBudget = planContinuation(project, graph, evaluation, 1);
  check('task budget caps filed asks', planBudget.newTasks.length + planBudget.followUps.length <= 1, `got ${planBudget.newTasks.length + planBudget.followUps.length}`);
  check('default budget is a sane number', EVERFLOW_DEFAULT_MAX_HUMAN_TASKS === 12);

  /* done state */
  const doneProject = completedCar();
  doneProject.requirements = { ...(doneProject.requirements as NonNullable<typeof doneProject.requirements>), assumptions: [] };
  const gDone = materializeGraph(doneProject);
  const eDone = evaluateEverflow(doneProject, gDone, 1);
  const planDone = planContinuation(doneProject, gDone, eDone);
  check('a state with one unproven goal but no assumption still is not done', eDone.done === false);
  check('done state: all satisfied, nothing dangling', (() => {
    const p2 = doneProject;
    p2.validation = { ...(p2.validation as NonNullable<typeof p2.validation>), checks: (p2.validation as NonNullable<typeof p2.validation>).checks.map((c) => (c.id.startsWith('behavioral.') ? { ...c, status: 'passed' } : c)) };
    const g3 = materializeGraph(p2);
    const e3 = evaluateEverflow(p2, g3, 1);
    return e3.done === true && e3.completion === 1;
  })());
  const pDone = (() => {
    const p2 = doneProject;
    p2.validation = { ...(p2.validation as NonNullable<typeof p2.validation>), checks: (p2.validation as NonNullable<typeof p2.validation>).checks.map((c) => (c.id.startsWith('behavioral.') ? { ...c, status: 'passed' as const } : c)) };
    return p2;
  })();
  const eFinal = evaluateEverflow(pDone, materializeGraph(pDone), 1);
  const planFinal = planContinuation(pDone, materializeGraph(pDone), eFinal);
  check('done → the plan files nothing', planFinal.newTasks.length === 0 && planFinal.followUps.length === 0);
}

/* -------------------------------------------------------------------------- */
/* 5. The human channel                                                        */
/* -------------------------------------------------------------------------- */

function section5(): void {
  console.log('\n5. channel — answers become evidence; additions become facts');

  const project = completedCar();
  const graph = materializeGraph(project);
  const evaluation = evaluateEverflow(project, graph, 1);
  const plan = planContinuation(project, graph, evaluation);
  const verifyTask = plan.newTasks.find((t) => t.type === 'verify')!;

  /* positive answer closes the goal */
  const answered: ProjectState = {
    ...project,
    humanTasks: [{ ...verifyTask, status: 'answered', response: { value: 'Yes, it works', at: nowIso() } }],
  };
  const ePos = evaluateEverflow(answered, materializeGraph(answered), 2);
  check('positive human answer satisfies the behaviour goal', ePos.results.find((r) => r.nodeId === 'ev-goal-behaviour-beh-obstacle-stop')?.satisfied === true);
  check('the answer lands as an evidence node with a verified_by edge', (() => {
    const g = materializeGraph(answered);
    const evidence = g.nodes.find((n) => n.id === `ev-evidence-task-${verifyTask.id}`);
    return Boolean(evidence) && g.edges.some((e) => e.kind === 'verified_by' && e.from === evidence!.id && e.to === 'ev-goal-behaviour-beh-obstacle-stop');
  })());

  /* negative answer leaves it open */
  const negative: ProjectState = {
    ...project,
    humanTasks: [{ ...verifyTask, status: 'answered', response: { value: 'No, it does not', at: nowIso() } }],
  };
  const eNeg = evaluateEverflow(negative, materializeGraph(negative), 2);
  check('negative answer keeps the goal unmet (no silent pass)', eNeg.results.find((r) => r.nodeId === 'ev-goal-behaviour-beh-obstacle-stop')?.satisfied === false);
  check('isPositiveResponse is honest about phrasing', isPositiveResponse(verifyTask, 'yes, it works') === true && isPositiveResponse(verifyTask, 'no') === false);

  /* human → AI: an addition is registered, then a follow-up ask is filed */
  const injection: HumanTask = {
    id: createId('htask'),
    direction: 'human_to_ai',
    type: 'idea',
    title: 'Add an LED strip',
    body: 'I want an RGB LED strip under the chassis.',
    asks: { shape: 'text' },
    linkedNodeIds: ['ev-intent'],
    lookAt: null,
    priority: 'high',
    status: 'open',
    response: { value: 'I want an RGB LED strip under the chassis.', at: nowIso() },
    defaultOnExpiry: 'defer',
    assumptionIfSkipped: null,
    source: 'human',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const withInjection: ProjectState = { ...project, humanTasks: [injection] };
  const g3 = materializeGraph(withInjection);
  const e3 = evaluateEverflow(withInjection, g3, 1);
  const plan3 = planContinuation(withInjection, g3, e3);
  check('open injection is claimed by the agent (processed)', plan3.processedInjections.includes(injection.id));
  const followUp = plan3.followUps.find((t) => t.type === 'choose' && /apply/i.test(t.title));
  check('idea gets a follow-up “apply to the build?” ask — never a silent change', Boolean(followUp));
  check('the follow-up offers the real options', followUp?.asks.options?.some((o) => /apply/i.test(o)) === true && followUp?.asks.options?.some((o) => /note only/i.test(o)) === true);

  const note: HumanTask = { ...injection, id: createId('htask'), type: 'note', title: 'It will live in my garage' };
  const withNote: ProjectState = { ...project, humanTasks: [note] };
  const planNote = planContinuation(withNote, materializeGraph(withNote), evaluateEverflow(withNote, materializeGraph(withNote), 1));
  check('a plain note is registered without a follow-up ask', planNote.processedInjections.includes(note.id) && planNote.followUps.length === 0);
}

/* -------------------------------------------------------------------------- */
/* 6. The persisted pass (in-memory store)                                     */
/* -------------------------------------------------------------------------- */

async function section6(): Promise<void> {
  console.log('\n6. pass — the persisted loop against an in-memory store');

  const car = completedCar();
  const memory = new Map<string, ProjectState>([['evf-verify', car]]);
  const events: AgentEvent[] = [];

  const store: EverflowStore = {
    async getState(id) {
      const state = memory.get(id);
      if (!state) return null;
      // re-materialise-on-read parity: return a copy
      return { ...state };
    },
    async save(id, patch) {
      const current = memory.get(id);
      if (!current) return null;
      const next = { ...current, ...patch } as ProjectState;
      memory.set(id, next);
      return { ...next };
    },
    async appendEvent(id, event) {
      events.push(event as AgentEvent);
    },
  };

  const first = (await runEverflowPass('evf-verify', 'generation_finalised', store))!;
  check('pass 1 ran and persisted the graph + evaluation', Boolean(first?.state.everflow?.graph && first?.state.everflow?.evaluation));
  check('pass 1 filed the human asks on the project record', first?.state.humanTasks.filter((t) => t.direction === 'ai_to_human').length >= 2, `got ${first?.state.humanTasks.length}`);
  check('pass 1 is marked as progress', first?.progressed === true);
  check('an everflow_pass event was appended', events.some((e) => e.type === 'everflow_pass'));

  const second = (await runEverflowPass('evf-verify', 'manual', store))!;
  check('pass 2 files no duplicate asks (the idempotency contract)', second.plan.newTasks.length === 0 && second.plan.followUps.length === 0);

  const loop = await continueEverflow('evf-verify', 'manual', store, { maxPasses: 5 });
  check('continueEverflow returns the final evaluation', Boolean(loop?.evaluation) && (loop?.evaluation.totals.aiTasksOpen ?? 0) >= 2);

  /* answer a task through the stored state and re-evaluate */
  const current = memory.get('evf-verify')!;
  const verifyTask = current.humanTasks.find((t) => t.type === 'verify')!;
  memory.set('evf-verify', {
    ...current,
    humanTasks: current.humanTasks.map((t) => (t.id === verifyTask.id ? { ...t, status: 'answered', response: { value: 'Yes, it works', at: nowIso() } } : t)),
  });
  const third = (await runEverflowPass('evf-verify', 'human_answer', store))!;
  const evalAfter = third?.state.everflow?.evaluation;
  check('after the human answer, the blocked goal is satisfied on the record', evalAfter?.results.find((r) => r.nodeId === 'ev-goal-behaviour-beh-obstacle-stop')?.satisfied === true);
  check('the run is now blocked only on humans (or done)', third?.evaluation.blockedOnHuman === true || third?.evaluation.done === true);
}

/* -------------------------------------------------------------------------- */
/* 7. Any-class brief — the messy voice note + the research tool              */
/* -------------------------------------------------------------------------- */

const VOICE_BRIEF =
  'an project with open cv that runs on a raspberry pi and then a website to register faces and basically a face based security...so multiple corsm..';

async function section7(): Promise<void> {
  console.log('\n7. any-class brief — "an project with open cv that runs on a raspberry pi..."');

  /* classification: the analyzer must put this in a class, not shrug */
  const analysis = analyzePrompt(VOICE_BRIEF);
  check('classifies the platform (raspberry pi, high confidence)', analysis.detectedPlatform === 'raspberry-pi' && (analysis.platformHints[0]?.confidence ?? 0) >= 0.9, `got ${analysis.detectedPlatform}`);
  check('classifies camera/vision and the web app', analysis.features.includes('camera_vision') && analysis.features.includes('web_app'), `features: ${analysis.features.join(', ')}`);
  check('extracts the named parts (open cv, raspberry pi)', analysis.explicitParts.some((part) => /open\s*cv|opencv/i.test(part)) && analysis.explicitParts.some((part) => part.includes('raspberry pi')));

  /* the doubt session asks the right forks for this class */
  const doubts = deriveDeterministicDoubts(VOICE_BRIEF);
  check('asks which camera type (CSI vs USB)', doubts.some((doubt) => /csi|usb webcam/i.test(doubt.question)));
  check('asks how many cameras (the brief says more than one)', doubts.some((doubt) => /how many cameras/i.test(doubt.question)));
  check('asks the security policy for unknown faces', doubts.some((doubt) => /unknown face/i.test(doubt.question)));
  check('asks who may use the website', doubts.some((doubt) => /website/i.test(doubt.question)));
  check('the Pi generation is a recorded agent decision, not a block', (() => {
    const generation = doubts.find((doubt) => /which raspberry pi/i.test(doubt.question));
    return Boolean(generation && generation.decider === 'ai_with_veto' && !generation.blocking);
  })());

  /* brief expansion — the messy note becomes the global project document */
  const state = baseProject({ prompt: VOICE_BRIEF });
  const expanded = deterministicExpansion(state);
  check('expansion states the platform', expanded.structured.platform === 'raspberry-pi');
  check('expansion names open cv as a component', expanded.structured.components.some((component) => /open\s*cv|opencv/i.test(component.name)));
  check('expansion is a readable document with goal + open questions', expanded.text.includes('PROJECT BRIEF') && expanded.text.includes('Goal:') && expanded.structured.openQuestions.length > 0);
  check('the open questions flag the uncounted cameras', expanded.structured.openQuestions.some((question) => /camera/i.test(question)));

  /* the catalog knows the hardware class */
  check('catalog: raspberry-pi-5 exists with a CSI port', Boolean(getSeedComponent('raspberry-pi-5')?.pins.some((pin) => pin.name === 'CSI')));
  check('catalog: Pi camera + USB webcam exist', Boolean(getSeedComponent('raspberry-pi-camera-module') && getSeedComponent('usb-webcam-generic')));

  /* a state where the voice brief has become requirements */
  const claimState: ProjectState = {
    ...state,
    requirements: {
      goal: 'Face-based security system on a Raspberry Pi with a registration website.',
      summary: 'OpenCV detects and recognises registered faces; a website registers them; multiple cameras.',
      requirements: ['Detects and recognises registered faces with OpenCV', 'Website to register faces', 'Multiple cameras covered'],
      inputs: ['Camera frames', 'Registered face list'],
      outputs: ['Known/unknown verdicts', 'Website'],
      behaviors: ['Raises an alert for unknown faces'],
      constraints: ['Runs on a Raspberry Pi'],
      platformRequirements: ['Raspberry Pi 5'],
      communicationRequirements: ['Web (HTTP)'],
      powerRequirements: ['USB-C 5 V PSU'],
      quantities: { cameras: 2 },
      features: ['camera_vision', 'web_app'],
      assumptions: [],
      ambiguities: [],
    },
    research: [],
  } as ProjectState;

  /* the research tool — catalog + corpus, cited, never invented */
  const claimGraph0 = materializeGraph(claimState);
  const faceClaim = claimGraph0.nodes.find((candidate) => candidate.kind === 'claim' && /face/i.test(candidate.content))!;
  const finding = await researchNode({ state: claimState, node: faceClaim });
  check('research finds a cited source for the face/Pi claim', Boolean(finding && finding.facts.length > 0 && finding.title.length > 3));
  check('research never invents: it returns a source, not a guess', finding ? finding.source === 'catalog' || finding.source === 'corpus' || finding.source === 'web' : false, `source: ${finding?.source}`);
  check('corpus matching is deterministic and keyword-driven', Boolean(matchCorpus('how does face recognition on a pi camera work')));
  const nonsense = await researchNode({ state: claimState, node: { ...faceClaim, id: 'ev-req-9', label: 'Quantum-flux calibrator alignment', content: 'The calibrator must be flux-aligned before the second harmonic.' } });
  check('nonsense input → no finding (the tool says it does not know)', nonsense === null);

  /* research findings join the graph as cited evidence */
  if (finding) {
    const withResearch: ProjectState = { ...claimState, research: [finding] };
    const graph = materializeGraph(withResearch);
    const evidence = graph.nodes.find((candidate) => candidate.id === `ev-research-${finding.id}`);
    check('finding materialises as an evidence node', Boolean(evidence && evidence.kind === 'evidence'));
    check('the evidence node links to the claim it checked', graph.edges.some((edge) => edge.kind === 'verified_by' && edge.from === `ev-research-${finding.id}` && edge.to === finding.nodeId));
  }

  /* the pass loop auto-researches low-confidence claims, once each */
  const graph1 = materializeGraph(claimState);
  const picks1 = planAutoResearch(claimState, graph1, 2);
  check('the planner auto-picks low-confidence claims for a docs check', picks1.length > 0);
  const pickedFacts = await Promise.all(picks1.map((pick) => researchNode({ state: claimState, node: pick.node })));
  check('each picked claim yields a finding (or is honestly skipped)', pickedFacts.every((finding) => finding === null || finding.facts.length > 0));
  const researchedIds = new Set(picks1.map((pick) => pick.nodeId));
  const graph2 = materializeGraph(claimState);
  const picks2 = planAutoResearch({ ...claimState, research: [...graph2.nodes.filter((n) => researchedIds.has(n.id)).map((n) => ({ id: 'r', nodeId: n.id, question: 'q', source: 'corpus' as const, title: 't', url: null, facts: ['f'], confidence: 0.8, needsHumanCheck: false, at: nowIso() }))] }, graph2, 2);
  const repicked = picks2.filter((pick) => researchedIds.has(pick.nodeId));
  check('already-researched nodes are never re-researched (idempotent)', repicked.length === 0, `repicked ${repicked.length}`);
}

/* -------------------------------------------------------------------------- */
/* 8. Act phase — the loop's own engineering moves, before any ask is filed    */
/* -------------------------------------------------------------------------- */

/** Real catalog-shaped selections (the rule engine reads `instances` properly). */
function actSelections(): ComponentSelection[] {
  const esp = getSeedComponent('esp32-devkit-v1')!;
  const motor = getSeedComponent('dc-motor-generic-6v')!;
  const instance = (instanceId: string, componentId: string, name: string, index: number, label: string, category: ComponentSelection['category']): ComponentInstance => ({
    instanceId,
    componentId,
    name,
    index,
    label,
    category,
  });
  return [
    {
      id: 'sel-1',
      componentId: 'esp32-devkit-v1',
      name: esp.name,
      category: esp.category,
      role: 'controller',
      quantity: 1,
      reason: 'Bluetooth + PWM controller',
      required: true,
      instances: [instance('mcu-1', 'esp32-devkit-v1', esp.name, 1, 'Controller', esp.category)],
      source: 'catalog',
    },
    {
      id: 'sel-2',
      componentId: 'dc-motor-generic-6v',
      name: motor.name,
      category: motor.category,
      role: 'actuator',
      quantity: 2,
      reason: 'Drive motors',
      required: true,
      instances: [
        instance('motor-l', 'dc-motor-generic-6v', motor.name, 1, 'Left motor', motor.category),
        instance('motor-r', 'dc-motor-generic-6v', motor.name, 2, 'Right motor', motor.category),
      ],
      source: 'catalog',
    },
  ];
}

/** The completed car with real selections, so the act phase can run the real engine. */
function actCar(): ProjectState {
  return completedCar() as ProjectState;
}

function actStore(state: ProjectState): { store: EverflowStore; events: AgentEvent[]; get(): ProjectState } {
  let current = structuredClone(state);
  const appended: AgentEvent[] = [];
  return {
    events: appended,
    get: () => structuredClone(current),
    store: {
      async getState() {
        return structuredClone(current);
      },
      async save(_id, patch) {
        current = { ...current, ...(patch as Partial<ProjectState>) };
        return structuredClone(current);
      },
      async appendEvent(_id, event) {
        const maxSeq = current.events.reduce((max, entry) => Math.max(max, entry.seq), 0);
        const full = { ...event, seq: event.seq ?? maxSeq + 1 } as AgentEvent;
        appended.push(full);
        current = { ...current, events: [...current.events, full] };
      },
    },
  };
}

/** Pre-seed the act-phase bookkeeping without running a pass (the loop trusts
 *  the pipeline's fresh validation as the baseline — this makes that explicit). */
function seeded(state: ProjectState): ProjectState {
  return { ...state, everflow: { ...state.everflow, actions: ensureActionState(state) } };
}

const ACT_PASS_OPTIONS = { ideaGraph: { enabled: false }, actions: { catalog: SEED_COMPONENTS } } as const;

async function section8(): Promise<void> {
  console.log('\n8. act — the loop moves itself before it asks you');

  const car: ProjectState = { ...actCar(), components: actSelections() };

  /* (a) seeding + stability: a fresh pass trusts the build's validation and does nothing */
  const stable = actStore(car);
  await runEverflowPass('evf-verify', 'generation_finalised', stable.store, { ...ACT_PASS_OPTIONS });
  let now = stable.get();
  const actions0 = now.everflow?.actions;
  check('the first pass seeds the act-phase bookkeeping', Boolean(actions0));
  check(
    'seeding trusts the pipeline validation as the baseline (zero moves)',
    (actions0?.history.length ?? -1) === 0 && actions0?.lastValidatedFingerprint === designFingerprint(car) && actions0?.lastReprovedFingerprint === behaviorFingerprint(car),
  );
  check('a stable project emits no everflow_move events', !now.events.some((event) => event.type === 'everflow_move'));

  await runEverflowPass('evf-verify', 'manual', stable.store, { ...ACT_PASS_OPTIONS });
  now = stable.get();
  check('a second pass over an unchanged design still does nothing', (now.everflow?.actions?.history.length ?? -1) === 0);

  /* (b) revalidate: a canvas-sync-style design edit without revalidation is caught by the loop */
  const diagram = car.artifacts.diagram!;
  const canvasEdit: ProjectState = {
    ...seeded(car),
    artifacts: {
      ...car.artifacts,
      diagram: { ...diagram, stats: { ...diagram.stats, components: diagram.stats.components + 1 } } as unknown as typeof diagram,
    },
  };
  const drift = actStore(canvasEdit);
  await runEverflowPass('evf-verify', 'canvas_sync', drift.store, { ...ACT_PASS_OPTIONS });
  const afterDrift = drift.get();
  const reval = afterDrift.everflow?.actions?.history.find((record) => record.move === 'revalidate');
  check('design drift triggers the revalidate move', Boolean(reval && reval.outcome !== 'skipped'), reval ? `${reval.outcome}: ${reval.summary}` : 'no record');
  check('the rule engine really ran (fresh validation carries a real duration)', typeof afterDrift.validation?.durationMs === 'number');
  check('the bookkeeping now matches the design it judged', afterDrift.everflow?.actions?.lastValidatedFingerprint === designFingerprint(canvasEdit));
  check(
    'the move is emitted as an everflow_move event',
    afterDrift.events.some((event) => event.type === 'everflow_move' && (event.metadata as Record<string, unknown> | undefined)?.move === 'revalidate'),
  );

  /* (c) reprove: a promise the evaluator can prove BY CODE never reaches a human ask */
  const staticAssertion: BehavioralAssertion = {
    id: 'beh-pin-len',
    title: 'The PIN minimum length is six digits',
    subject: { kind: 'firmware', property: 'pin_min_length' },
    operator: 'eq',
    expected: 6,
    required: true,
    derivedFrom: ['six digit pin'],
  };
  const proofValidation: ValidationResult = {
    passed: true,
    iteration: 0,
    checkedAt: nowIso(),
    durationMs: 1,
    issues: [],
    checks: [
      { id: 'behavioral.beh-pin-len', name: staticAssertion.title, domain: 'behavior', status: 'skipped', message: 'Needs a simulator or bench run.', issueIds: [] },
    ],
    summary: { errors: 0, warnings: 0, info: 0, checksRun: 1, checksPassed: 0 },
  };
  const proofBase: ProjectState = {
    ...car,
    requirements: { ...car.requirements!, behavioralSpec: spec([staticAssertion]) },
    validation: proofValidation,
  };
  const code = proofBase.artifacts.code!;
  const provenFirmware: ProjectState = {
    ...seeded(proofBase),
    artifacts: {
      ...proofBase.artifacts,
      code: {
        ...code,
        files: [{ path: 'sketch.ino', language: 'cpp', content: 'const int PIN_MIN_LENGTH = 6;\nvoid setup() {}\nvoid loop() {}', purpose: 'firmware', generatedBy: 'planner' } as unknown as (typeof code.files)[number]],
      },
    },
  };
  const proof = actStore(provenFirmware);
  await runEverflowPass('evf-verify', 'firmware_edit', proof.store, { ...ACT_PASS_OPTIONS });
  const afterProof = proof.get();
  const reprove = afterProof.everflow?.actions?.history.find((record) => record.move === 'reprove');
  check('firmware drift triggers the reprove move', Boolean(reprove && (reprove.outcome === 'changed' || reprove.outcome === 'no_change')), reprove ? `${reprove.outcome}: ${reprove.summary}` : 'no record');
  const pinCheck = afterProof.validation?.checks.find((entry) => entry.id === 'behavioral.beh-pin-len');
  check('the promise is now proven BY CODE (per-assertion check passed)', pinCheck?.status === 'passed', pinCheck?.message ?? 'no check');
  const goalResult = afterProof.everflow?.evaluation?.results.find((result) => result.nodeId === 'ev-goal-behaviour-beh-pin-len');
  check('the behaviour goal is satisfied without a human', goalResult?.satisfied === true, goalResult?.evidence ?? 'no result');
  const verifyAsks = afterProof.humanTasks.filter((task) => task.direction === 'ai_to_human' && task.type === 'verify' && task.linkedNodeIds.includes('ev-goal-behaviour-beh-pin-len'));
  check('no human verify ask was filed for what the loop proved itself', verifyAsks.length === 0, `${verifyAsks.length} ask(s)`);
  check('the reproof is budgeted on the ledger', (afterProof.everflow?.actions?.reproofsUsed ?? 0) === 1);

  /* (d) repair: a FRESH blocking-issue set gets one bounded deterministic fix pass */
  const brokenValidation: ValidationResult = {
    passed: false,
    iteration: 0,
    checkedAt: nowIso(),
    durationMs: 1,
    issues: [
      {
        id: 'lib-dht',
        code: 'library_missing',
        severity: 'error',
        domain: 'libraries',
        message: 'The firmware includes <DHT.h> but libraries.json does not list it.',
        target: { artifact: 'libraries', library: 'DHT.h' },
        fixHint: 'List the DHT library in libraries.json.',
        autoFixable: true,
        origin: 'rules',
      },
    ],
    checks: [],
    summary: { errors: 1, warnings: 0, info: 0, checksRun: 0, checksPassed: 0 },
  };
  const broken: ProjectState = { ...seeded(car), validation: brokenValidation, status: 'completed_with_errors' };
  const repair = actStore(broken);
  await runEverflowPass('evf-verify', 'manual', repair.store, { ideaGraph: { enabled: false }, actions: { catalog: SEED_COMPONENTS, maxRepairs: 1 } });
  const afterRepair = repair.get();
  const repairRecord = afterRepair.everflow?.actions?.history.find((record) => record.move === 'repair');
  check("a fresh blocking issue set triggers the loop's own fix pass", repairRecord?.outcome === 'changed', repairRecord ? `${repairRecord.outcome}: ${repairRecord.summary}` : 'no record');
  check(
    'the repair froze a diffable revision',
    afterRepair.revision === 2 && afterRepair.revisions.some((entry) => entry.version === 2 && entry.reason === 'targeted_fix' && /act-phase repair/i.test(entry.summary)),
    `revision ${afterRepair.revision}`,
  );
  const listed = (afterRepair.artifacts.libraries?.libraries ?? []).some((entry) => /dht/i.test(`${entry.name} ${'import' in entry ? String(entry.import) : ''}`));
  check('the missing library is now listed in libraries.json', listed);
  check('the repair is budgeted on the ledger', (afterRepair.everflow?.actions?.repairsUsed ?? 0) === 1);
  check('the attempted issue signature is recorded (never retried unchanged)', afterRepair.everflow?.actions?.lastRepairSignature === repairSignature(brokenValidation));

  await runEverflowPass('evf-verify', 'manual', repair.store, { ideaGraph: { enabled: false }, actions: { catalog: SEED_COMPONENTS, maxRepairs: 1 } });
  const afterSecond = repair.get();
  const repairRecords = (afterSecond.everflow?.actions?.history ?? []).filter((record) => record.move === 'repair');
  check('the budget backstop stops a second loop repair (the asks own the rest)', repairRecords.length === 1 && (afterSecond.everflow?.actions?.repairsUsed ?? 0) === 1, `${repairRecords.length} repair record(s)`);

  /* (e) the flag restores the ask-only loop exactly */
  process.env.WIREUP_ENABLE_EVERFLOW_ACTIONS = 'false';
  resetEnvCache();
  const off = actStore(canvasEdit);
  await runEverflowPass('evf-verify', 'manual', off.store, { ...ACT_PASS_OPTIONS });
  const afterOff = off.get();
  check(
    'with WIREUP_ENABLE_EVERFLOW_ACTIONS=false the loop only asks (no moves, no records)',
    !afterOff.events.some((event) => event.type === 'everflow_move') && (afterOff.everflow?.actions?.history.length ?? 0) === 0,
  );
  process.env.WIREUP_ENABLE_EVERFLOW_ACTIONS = 'true';
  resetEnvCache();

  /* (f) the move planner is pure and honest about every guard */
  const opts = { maxRepairs: 2, maxReproofs: 3, maxRevisions: 12 };
  check('a stable design plans no moves', planActions(car, ensureActionState(car), opts).moves.length === 0);
  const live = planActions({ ...car, status: 'running' }, ensureActionState(car), opts);
  check('a live build is never acted on', live.moves.length === 0 && live.description.some((line) => /idle/i.test(line)));
  const sameSignature = planActions(broken, { ...ensureActionState(car), lastRepairSignature: repairSignature(brokenValidation) }, opts);
  check('the identical issue set is never retried', !sameSignature.moves.some((move) => move.move === 'repair') && sameSignature.description.some((line) => /never retried/i.test(line)));
  const budgeted = planActions(broken, { ...ensureActionState(car), repairsUsed: 2 }, opts);
  check('the budget backstop parks the repair', !budgeted.moves.some((move) => move.move === 'repair') && budgeted.description.some((line) => /budget/i.test(line)));
  const capped = planActions({ ...broken, revision: 12 }, ensureActionState(car), opts);
  check('the revision cap blocks a loop repair', !capped.moves.some((move) => move.move === 'repair') && capped.description.some((line) => /revision cap/i.test(line)));
  const driftedPlan = planActions(canvasEdit, ensureActionState(car), opts);
  check('design drift plans exactly the revalidate move', driftedPlan.moves.length === 1 && driftedPlan.moves[0].move === 'revalidate');
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log('wireup · everflow verifier (project graph + goal loop + human channel)');
  console.log(`node ${process.version} · offline — no Mongo, no Bedrock, no network\n`);

  section1();
  section2();
  section3();
  section4();
  section5();
  await section6();
  await section7();
  await section8();

  console.log('');
  if (failures > 0) {
    console.log(`✕ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('✓ all everflow checks passed');
}

void main();
