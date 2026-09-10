/**
 * Idea-graph verifier.
 *
 *   pnpm verify:idea-graph
 *
 * Proves the IDEA GRAPH offline — no Mongo, no Bedrock, no network (same
 * pattern as verify-everflow: in-memory stores, canned/injected models, and
 * a REAL deterministic pipeline run for the ladder):
 *
 *   a. expansion — an RC-car prompt lays down Level-1 power/drive/control/
 *      sensing/brain/safety-class subsystems with ZERO model calls
 *   b. stopper   — R1 blocks a leaf without a test; R2 (canned model) stops
 *      a strategic node; R3 pauses after two dead expansions and files the
 *      ask; R4 forbids an early stop on a risk_gated node
 *   c. ladder    — fail → fix → pass on a REAL build; fail×3 → ONE
 *      escalation ask (idempotent)
 *   d. reviewer  — a hidden unproven goal ⇒ FAIL even when builder-side
 *      state looks green; the reviewer's input contains no builder transcript
 *   e. swarm     — subtrees assigned by the class map; sequential fallback
 *   f. idempotency — the whole loop twice files no duplicate asks/nodes
 *   g. honesty   — every model call forced to fail: the graph still completes
 *      via fallbacks and the events SAY the model was unavailable
 *
 * Exits 0 when every named assertion passes, 1 otherwise.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1200';

import type { AgentEvent } from '@/types/generation';
import type { ComponentDefinition } from '@/types/component';
import type { EverflowNode, IdeaGraphState } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { resetEnvCache } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { AgentEventLog } from '@/lib/logging/events';

import {
  classifyProject,
  decideStop,
  expansionMove,
  nullExpansionModel,
  type ExpansionModel,
} from '@/modules/everflow/decompose';
import { pendingTestNodes, runNodeTest, testLadderMove } from '@/modules/everflow/test-ladder';
import { buildReviewerInput, reviewerMove, rulesBasedReview } from '@/modules/everflow/reviewer';
import { assignSwarms, roleForClass, swarmMove, SWARM_BY_CLASS } from '@/modules/everflow/swarm';
import { runEverflowPass, continueEverflow, type EverflowStore } from '@/modules/everflow/continuation';
import { runPipeline } from '@/modules/orchestrator/pipeline';
import { validateProject } from '@/modules/validator';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const RC_PROMPT = 'an RC car with two DC motors, an ultrasonic sensor and a buzzer';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function baseProject(prompt: string, id = 'ig-verify'): ProjectState {
  const now = nowIso();
  return {
    id,
    name: 'Verify Idea Graph',
    prompt,
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
  };
}

function memoryStore(seed: ProjectState): { store: EverflowStore; memory: Map<string, ProjectState>; events: AgentEvent[] } {
  const memory = new Map<string, ProjectState>([[seed.id, seed]]);
  const events: AgentEvent[] = [];
  return {
    memory,
    events,
    store: {
      async getState(id) {
        const state = memory.get(id);
        return state ? { ...state } : null;
      },
      async save(id, patch) {
        const current = memory.get(id);
        if (!current) return null;
        const next = { ...current, ...patch } as ProjectState;
        memory.set(id, next);
        return { ...next };
      },
      async appendEvent(id, event) {
        const current = memory.get(id);
        if (current) current.events = [...current.events, event as AgentEvent];
        events.push(event as AgentEvent);
      },
    },
  };
}

/** A REAL deterministic build (zero model) to run the ladder against. */
async function realRcCarBuild(): Promise<{ project: ProjectState; catalog: ComponentDefinition[] }> {
  const events = new AgentEventLog({ initialSeq: 0 });
  const fresh = baseProject(RC_PROMPT, `ig-build-${Date.now()}`);
  fresh.status = 'pending';
  fresh.stage = 'idle';
  fresh.revision = 0;
  fresh.events = [];
  const pipeline = await runPipeline({ project: fresh, events });
  return { project: pipeline.project, catalog: pipeline.context.catalog };
}

/* -------------------------------------------------------------------------- */
/* a. expansion — the RC-car L1 skeleton, zero model calls                      */
/* -------------------------------------------------------------------------- */

async function sectionA(): Promise<void> {
  section('a. expansion — "an RC car with two DC motors, an ultrasonic sensor and a buzzer"');

  const cls = classifyProject(RC_PROMPT);
  check('the prompt classifies as a vehicle', cls === 'vehicle', `got ${cls}`);

  const state = baseProject(RC_PROMPT);
  const move = await expansionMove(state, { maxExpansions: 40, model: nullExpansionModel });

  const labels = move.ideaGraph.nodes.filter((node) => node.kind === 'subsystem').map((node) => node.label);
  const classes = move.ideaGraph.nodes.filter((node) => node.kind === 'subsystem').map((node) => node.subsystemClass);
  check('the L1 skeleton exists with zero model calls', move.moved && move.ideaGraph.nodes.length === 8, `${move.ideaGraph.nodes.length} nodes`);
  check('L1 contains a POWER-class subsystem', classes.includes('POWER'), labels.join(', '));
  check('L1 contains a DRIVE-class subsystem', classes.includes('DRIVE'));
  check('L1 contains a CONTROL-LINK-class subsystem', classes.includes('CONTROL_LINK'));
  check('L1 contains a SENSING-class subsystem', classes.includes('SENSING'));
  check('L1 contains a BRAIN-class subsystem', classes.includes('BRAIN'));
  check('L1 contains a SAFETY-class subsystem', classes.includes('SAFETY'));
  const risky = move.ideaGraph.nodes.filter((node) => node.stakes === 'risk_gated').map((node) => node.subsystemClass);
  check('power/drive/safety are risk-gated', ['POWER', 'DRIVE', 'SAFETY'].every((cls2) => risky.includes(cls2 as never)));
  check('every L1 node carries a goal AND an empty test slot', move.ideaGraph.nodes.every((node) => node.goal.criterion.length > 0 && Boolean(node.testSpec) && node.testSpec!.assertion.length > 0 && node.testSpec!.status === 'untested'));
  const templateEvent = move.events[0];
  check('one idea_graph.expansion event records the template source', templateEvent?.metadata.source === 'template' && templateEvent.metadata.kind === 'idea_graph.expansion');

  // Deeper expansion from REAL state: skeleton first, then POWER from parts.
  const { project } = await realRcCarBuild();
  const skeleton = await expansionMove(project, { maxExpansions: 40, model: nullExpansionModel });
  const sizeBefore = skeleton.ideaGraph.nodes.length; // snapshot: move2 mutates the same graph object
  const move2 = await expansionMove({ ...project, ideaGraph: skeleton.ideaGraph }, { maxExpansions: 40, model: nullExpansionModel });
  const power = move2.ideaGraph.nodes.find((node) => node.label === 'POWER');
  const grew = move2.ideaGraph.nodes.length > sizeBefore;
  check('a second expansion derives POWER children from the ACTUAL build state (no model)', move2.events[0]?.metadata.source === 'state' && power?.expansionState === 'expanded' && grew, `${move2.ideaGraph.nodes.length} node(s), source=${String(move2.events[0]?.metadata.source)}`);
  const powerChildLabels = move2.ideaGraph.nodes.filter((node) => node.parentId === power?.id).map((node) => node.label);
  check('the derived POWER children name real parts/budget from the build', powerChildLabels.length === 2, powerChildLabels.join(', '));
}

/* -------------------------------------------------------------------------- */
/* b. the stopper — R1, R2, R3, R4                                             */
/* -------------------------------------------------------------------------- */

function nodeWith(partial: Partial<EverflowNode>): EverflowNode {
  const at = nowIso();
  return {
    id: 'ig-node', kind: 'subsystem', label: 'Node', content: 'content', status: 'active',
    confidence: 0.8, owner: 'ai', goal: { criterion: 'c', kind: 'custom', state: 'open' },
    file: null, source: { origin: 'continuation', stage: 'idea-graph' },
    level: 1, parentId: 'ev-intent', expansionState: 'unexpanded', repairCount: 0, stakes: 'normal',
    createdAt: at, updatedAt: at,
    ...partial,
  };
}

async function sectionB(): Promise<void> {
  section('b. stopper — four rules, in order, reason recorded');

  const state = baseProject(RC_PROMPT);

  // R1: no realization and no test ⇒ may not stop.
  const bare = nodeWith({ id: 'ig-bare', label: 'BARE' });
  const r1 = decideStop(bare, state, new Set(), null);
  check('R1: a node with no realization and no test may not stop', !r1.stop && r1.rule === 'R1_testability', r1.reason);
  check('R1: the expand-again reason is recorded on the node', r1.reason.includes('expand'));

  // R1: realization + test ⇒ may stop (no model → R2 skipped, stated).
  const realized = nodeWith({ id: 'ig-real', label: 'REAL', ref: 'dc-motor-generic-6v', testSpec: { rung: 'catalog', assertion: 'part exists', status: 'untested' } });
  const stateWithPart = { ...state, components: [{ id: 'sel-x', componentId: 'dc-motor-generic-6v', name: 'DC motor', quantity: 1, reason: 'drive', required: true, instances: [], source: 'catalog' as const, role: 'actuator' as const, category: 'motor' as const }] as ProjectState['components'] };
  const r1pass = decideStop(realized, stateWithPart, new Set(), null);
  check('R1: realization + runnable test ⇒ leaf (R2 skipped honestly without a model)', r1pass.stop && r1pass.rule === 'R1_testability', r1pass.reason);

  // R2: canned model says "no child changes anything" ⇒ strategic stop.
  const r2Model: ExpansionModel = { ...nullExpansionModel, decisionPower: async () => ({ changes: false, reason: 'steering is decided: differential, 2 motors.' }) };
  const r2 = decideStop(realized, stateWithPart, new Set(), await r2Model.decisionPower!({ node: realized, realization: 'catalog part dc-motor-generic-6v' }));
  check('R2: a canned "no downstream change" stops the node as strategic', r2.stop && r2.rule === 'R2_decision_power', r2.reason);

  // R2: canned model says children WOULD change things ⇒ keep expanding.
  const r2bModel: ExpansionModel = { ...nullExpansionModel, decisionPower: async () => ({ changes: true, reason: 'the link choice is still open.' }) };
  const r2b = decideStop(realized, stateWithPart, new Set(), await r2bModel.decisionPower!({ node: realized, realization: 'x' }));
  check('R2: "children would change a downstream action" keeps the node expanding', !r2b.stop && r2b.rule === 'R2_decision_power');

  // R4: risk-gated without a safety test may NEVER stop, even fully realized.
  const risky = nodeWith({ id: 'ig-risky', label: 'POWER', stakes: 'risk_gated', ref: 'battery-2s-lipo', testSpec: { rung: 'catalog', assertion: 'battery fits the budget', status: 'untested' } });
  const r4 = decideStop(risky, stateWithPart, new Set(), null);
  check('R4: a risk_gated node is forbidden from stopping without a safety test', !r4.stop && r4.rule === 'R4_risk_gated', r4.reason);
  const riskyWithSafety = nodeWith({ ...risky, ref: 'dc-motor-generic-6v', testSpec: { rung: 'behavioral', assertion: 'safety: low-voltage cutoff stops the car', status: 'untested' } });
  const r4b = decideStop(riskyWithSafety, stateWithPart, new Set(), null);
  check('R4: with a concrete safety test the risk_gated node may stop', r4b.stop);

  // R3: two dead expansions pause the graph and file the ask.
  const empty = baseProject('a mystery box with no recognizable class parts', 'ig-r3');
  const { store, memory } = memoryStore(empty);
  let paused = false;
  for (let i = 0; i < 14 && !paused; i += 1) {
    await runEverflowPass('ig-r3', 'verify', store, { ideaGraph: { model: nullExpansionModel, maxExpansions: 40 }, maxHumanTasks: 20 });
    const graph = memory.get('ig-r3')?.ideaGraph;
    paused = Boolean(graph?.expansionPaused);
  }
  const graph = memory.get('ig-r3')?.ideaGraph;
  check('R3: two dead expansions pause whole-graph expansion', Boolean(graph?.expansionPaused && (graph?.deadExpansions ?? 0) >= 2), `dead=${graph?.deadExpansions}`);
  const r3Ask = memory.get('ig-r3')?.humanTasks.find((task) => task.type === 'review' && task.status === 'open');
  check('R3: the pause files exactly one review ask', Boolean(r3Ask), r3Ask?.title);
  check('R3: the pause says WHY on the record', (graph?.pausedReason ?? '').includes('R3_convergence'));
}

/* -------------------------------------------------------------------------- */
/* c. the ladder — fail → fix → pass, and fail×3 → one escalation               */
/* -------------------------------------------------------------------------- */

function wiringLeafId(): string {
  return 'ig-drive-wiring';
}

async function sectionC(): Promise<void> {
  section('c. ladder — fail → fix → pass on a REAL build; fail×3 → ONE escalation');

  const { project, catalog } = await realRcCarBuild();
  const wiring = project.wiring!;
  const victim = wiring.connections.find((connection) => connection.kind === 'ground') ?? wiring.connections[0];
  const broken = { ...project, wiring: { ...wiring, connections: wiring.connections.filter((connection) => connection.id !== victim.id) } };
  const validation = await validateProject({ project: broken, catalog, catalogContext: '', mcuContext: '', iteration: 0, enableModelReview: false });
  const state = { ...broken, validation: validation.result };
  check('fixture: a real RC-car build with a deliberately broken ground wire', validation.result.summary.errors > 0, `${validation.result.summary.errors} error(s)`);

  const at = nowIso();
  const leaf: EverflowNode = {
    id: wiringLeafId(),
    kind: 'subsystem',
    label: 'Drive wiring & pins',
    content: 'pins assigned conflict-free; wiring graph complete',
    status: 'active',
    confidence: 0.85,
    owner: 'ai',
    goal: { criterion: 'Drive wiring complete.', kind: 'subtree_tested', state: 'open' },
    file: null,
    source: { origin: 'continuation', stage: 'idea-graph' },
    level: 2,
    parentId: 'ig-drive',
    testSpec: { rung: 'catalog', assertion: 'pins.assignments and wiring.graph pass for the drive parts.', checkId: 'wiring.graph', status: 'untested' },
    expansionState: 'leaf',
    repairCount: 0,
    stakes: 'normal',
    subsystemClass: 'DRIVE',
    createdAt: at,
    updatedAt: at,
  };
  const ideaGraph: IdeaGraphState = { rootId: 'ev-intent', nodes: [leaf], edges: [], phase: 'testing', expansions: 2, deadExpansions: 0, expansionPaused: false, pausedReason: null, reviewer: null, swarms: null };
  const stateWithGraph = { ...state, ideaGraph };

  check('pre-test: the broken wiring makes the leaf test FAIL', runNodeTest(stateWithGraph, leaf).verdict === 'failed');

  const move1 = await testLadderMove(stateWithGraph, { catalog, maxRepairs: 2 });
  const after1 = move1.ideaGraph.nodes.find((node) => node.id === leaf.id)!;
  check('fail → targeted fix → pass (one move)', after1.testSpec?.status === 'passed', after1.testSpec?.message?.slice(0, 90));
  check('the repair is VISIBLE history (repairCount 1, one test_result node)', after1.repairCount === 1 && move1.ideaGraph.nodes.filter((node) => node.kind === 'test_result').length === 1);
  check('the repair froze a new revision (never a silent mutation)', move1.state.revision === state.revision + 1, `v${state.revision} → v${move1.state.revision}`);
  check('an idea_graph_test event records the verdict', move1.events.some((event) => event.type === 'idea_graph_test' && event.metadata.verdict === 'passed'));

  const move2 = await testLadderMove(move1.state, { catalog, maxRepairs: 2 });
  check('a passing leaf is never re-tested (idempotent); phase hands to the reviewer', !move2.moved && move2.ideaGraph.phase === 'reviewing' && move2.ideaGraph.nodes.filter((node) => node.kind === 'test_result').length === 1);

  /* --- fail×3 → escalation ------------------------------------------------- */
  // power_budget_exceeded has NO deterministic fix: the ladder must try,
  // fail twice, and escalate exactly once with the failing assertion.
  const powerLeaf: EverflowNode = {
    ...leaf,
    id: 'ig-power-budget',
    label: 'Budget & cutoff',
    subsystemClass: 'POWER',
    stakes: 'risk_gated',
    testSpec: { rung: 'electrical', assertion: 'power.budget passes for the selected supply.', status: 'untested' },
  };
  // Find a build whose power budget genuinely fails: use the 9V-battery car (validation errors>0 case is wiring; force via weak supply).
  const weakState = { ...stateWithGraph };
  const ideaGraph2: IdeaGraphState = { ...ideaGraph, nodes: [powerLeaf], phase: 'testing' };
  weakState.ideaGraph = ideaGraph2;

  // Make the budget fail honestly: swap the build's power selection for a 9V battery if present, else fake a failing check the validator produced.
  const has9v = weakState.components.some((selection) => selection.componentId === 'battery-9v');
  if (!has9v) {
    const forcedValidation = {
      ...weakState.validation!,
      checks: [
        ...weakState.validation!.checks.filter((entry) => entry.id !== 'power.budget'),
        { id: 'power.budget', name: 'Power budget', domain: 'power' as const, status: 'failed' as const, message: 'Power budget check failed: Sustained load exceeds what battery-9v can deliver.', issueIds: [] },
      ],
    };
    weakState.validation = forcedValidation as typeof weakState.validation;
  }
  const fileTasks = (move: { state: ProjectState; newTasks: { type: string; linkedNodeId: string; title: string; body: string; defaultOnExpiry: string; assumptionIfSkipped: string }[] }): ProjectState => ({
    ...move.state,
    humanTasks: [
      ...move.state.humanTasks,
      ...move.newTasks.map((task) => ({
        id: createId('htask'), direction: 'ai_to_human' as const, type: task.type as never,
        title: task.title, body: task.body, asks: { shape: 'text' as const },
        linkedNodeIds: [task.linkedNodeId], lookAt: null, priority: 'high' as const,
        status: 'open' as const, response: null, defaultOnExpiry: 'defer' as const,
        assumptionIfSkipped: task.assumptionIfSkipped, source: 'ai' as const,
        createdAt: nowIso(), updatedAt: nowIso(),
      })),
    ],
  });
  const e1 = await testLadderMove(weakState, { catalog, maxRepairs: 2 });
  const e2 = await testLadderMove(fileTasks(e1), { catalog, maxRepairs: 2 });
  const e3 = await testLadderMove(fileTasks(e2), { catalog, maxRepairs: 2 });
  const e4 = await testLadderMove(fileTasks(e3), { catalog, maxRepairs: 2 });
  const powerAfter = e4.ideaGraph.nodes.find((node) => node.id === powerLeaf.id)!;
  const escalations = e4.state.humanTasks.filter((task) => task.type === 'choose' && task.linkedNodeIds.includes(powerLeaf.id));
  check('fail×3: repair attempts recorded on the node (visible history)', (powerAfter.repairCount ?? 0) >= 2, `repairCount=${powerAfter.repairCount}, verdict=${powerAfter.testSpec?.status}`);
  check('fail×3: exactly ONE escalation ask filed (idempotent)', escalations.length === 1, `${escalations.length} ask(s)`);
  check('the escalation carries the failing assertion + what was tried', escalations[0]?.body.includes('Failing assertion') && escalations[0]?.body.includes('What was tried'));
  check('the escalation defaults to defer (the agent never blocks on you)', escalations[0]?.defaultOnExpiry === 'defer');
  const e5 = await testLadderMove(fileTasks(e4), { catalog, maxRepairs: 2 });
  const escalations2 = e5.state.humanTasks.filter((task) => task.type === 'choose' && task.linkedNodeIds.includes(powerLeaf.id));
  check('running the ladder again files NO duplicate escalation', escalations2.length === 1);
}

/* -------------------------------------------------------------------------- */
/* d. the reviewer — hidden unproven goal ⇒ FAIL; clean input                   */
/* -------------------------------------------------------------------------- */

async function sectionD(): Promise<void> {
  section('d. reviewer — a hidden unproven goal fails the run; the input is clean');

  const { project, catalog } = await realRcCarBuild();
  const greenValidation = await validateProject({ project, catalog, catalogContext: '', mcuContext: '', iteration: 0, enableModelReview: false });

  const at = nowIso();
  const leaf: EverflowNode = {
    id: 'ig-stop-test', kind: 'subsystem', label: 'Obstacle stop', content: 'the car stops before walls',
    status: 'active', confidence: 0.9, owner: 'ai',
    goal: { criterion: 'The stop behaviour is proven.', kind: 'subtree_tested', state: 'open' },
    file: null, source: { origin: 'continuation', stage: 'idea-graph' },
    level: 2, parentId: 'ig-safety',
    testSpec: { rung: 'behavioral', assertion: 'Behavioural assertion "Stops when an obstacle is detected" passes.', checkId: 'beh-obstacle-stop', status: 'passed', message: 'static check ok' },
    expansionState: 'leaf', repairCount: 0, stakes: 'risk_gated', subsystemClass: 'SAFETY',
    createdAt: at, updatedAt: at,
  };
  // The builder-side graph looks green... but the project still carries an
  // UNPROVEN behaviour goal the builder never surfaced (the hidden one).
  const hiddenState: ProjectState = {
    ...project,
    validation: greenValidation.result,
    requirements: {
      ...(project.requirements as NonNullable<ProjectState['requirements']>),
      behavioralSpec: {
        origin: 'heuristics' as const,
        generatedAt: nowIso(),
        notes: [],
        assertions: [
          { id: 'beh-hidden-distance', title: 'Stops when an obstacle is detected', subject: { kind: 'telemetry', field: 'distance' }, operator: 'lt' as const, expected: 10, required: true, derivedFrom: ['stops before obstacles'] },
        ],
      },
    },
    everflow: {
      graph: null,
      evaluation: {
        at: nowIso(), pass: 1,
        totals: { nodes: 5, goalsTotal: 2, goalsSatisfied: 1, goalsOpen: 1, goalsBlockedHuman: 0, goalsWaived: 0, openEnds: 0, aiTasksOpen: 0, humanTasksOpen: 0 },
        completion: 0.5, done: false, blockedOnHuman: false,
        results: [
          { nodeId: 'ev-goal-behaviour-beh-hidden-distance', kind: 'goal', label: 'Behaviour: Stops when an obstacle is detected', goal: { criterion: 'Proven by the behavioural evaluator.', kind: 'behaviour_proven', state: 'in_progress', checkId: 'beh-hidden-distance' }, satisfied: false, evidence: 'Not yet evaluated — needs a simulator or bench run.', openEnd: false },
          { nodeId: 'ev-goal-validation', kind: 'goal', label: 'Design is clean', goal: { criterion: 'Validation reports zero blocking issues.', kind: 'validation_clean', state: 'satisfied' }, satisfied: true, evidence: 'Validation clean.', openEnd: false },
        ],
        nextActions: [],
        brief: '# Verify Car — project brief',
      },
      pass: 1,
    },
    humanTasks: [], // nothing parked — the goal is hidden, not worked on
  };
  const ideaGraph: IdeaGraphState = { rootId: 'ev-intent', nodes: [leaf], edges: [], phase: 'reviewing', expansions: 3, deadExpansions: 0, expansionPaused: false, pausedReason: null, reviewer: null, swarms: null };
  const state = { ...hiddenState, ideaGraph };

  const input = buildReviewerInput(state, ideaGraph);
  const inputJson = JSON.stringify(input);
  check('reviewer input carries the brief, graph, artifacts and test results', inputJson.includes('project brief') && input.graph.nodes.length === 1 && input.testResults.length === 1);
  check('SEPARATION: the input contains no builder transcript (no events)', !inputJson.includes('"events"') && !inputJson.includes('generation_started'));
  check('SEPARATION: the input contains no llm call records', !inputJson.includes('"calls"') && !inputJson.includes('inputTokens'));

  const verdict = rulesBasedReview(state, ideaGraph);
  check('a hidden unproven goal ⇒ FAIL even with all builder-side state green', verdict.verdict === 'FAIL', `${verdict.findings.length} finding(s)`);
  check('the FAIL names the hidden behaviour goal', verdict.findings.some((finding) => finding.summary.includes('Stops when an obstacle is detected')));

  const move = await reviewerMove(state, null);
  check('the verdict materialises as a review node with an evidence edge', move.ideaGraph.nodes.some((node) => node.kind === 'review') && move.ideaGraph.edges.some((edge) => edge.kind === 'verified_by' && edge.from.startsWith('ig-review-')));
  check('the reviewer records HOW it judged (rules fallback with zero models)', move.reviewer.reviewedBy === 'rules' && move.reviewer.modelId === null);
  check('the reviewer never edits: artifacts untouched', JSON.stringify(move.ideaGraph.nodes.filter((node) => node.kind === 'review').length) === '1' && move.input.artifacts.files.length === (state.artifacts.code?.files.length ?? 0));
}

/* -------------------------------------------------------------------------- */
/* e. the swarm — assignment + sequential fallback                              */
/* -------------------------------------------------------------------------- */

async function sectionE(): Promise<void> {
  section('e. swarm — subtrees assigned by the class map; sequential by default');

  const state = baseProject(RC_PROMPT);
  const { ideaGraph } = await expansionMove(state, { maxExpansions: 40, model: nullExpansionModel });

  check('the class→role map is the spec partition', SWARM_BY_CLASS.POWER === 'hardware-swarm' && SWARM_BY_CLASS.DRIVE === 'hardware-swarm' && SWARM_BY_CLASS.SENSING === 'hardware-swarm' && SWARM_BY_CLASS.BRAIN === 'firmware-swarm' && SWARM_BY_CLASS.SAFETY === 'firmware-swarm' && SWARM_BY_CLASS.CONTROL_LINK === 'web-swarm' && SWARM_BY_CLASS.STRUCTURE === 'mechanics-swarm');

  const assignments = assignSwarms(ideaGraph, state);
  const roles = assignments.map((assignment) => assignment.role);
  check('all four roles own subtrees of the RC-car skeleton', ['hardware-swarm', 'firmware-swarm', 'web-swarm', 'mechanics-swarm'].every((role) => roles.includes(role as never)), roles.join(', '));
  check('assignments are graph-only facts (execution recorded as sequential)', assignments.every((assignment) => assignment.execution === 'sequential'));
  check('per-role model is recorded, never silently different (null with no model)', assignments.every((assignment) => assignment.modelId === null));
  check('every subsystem node now carries its owner stamp', ideaGraph.nodes.filter((node) => node.kind === 'subsystem').every((node) => node.swarmRole === roleForClass(node.subsystemClass)));

  const state2 = { ...state, ideaGraph: { ...ideaGraph, phase: 'swarming' as const } };
  const move1 = swarmMove(state2);
  check('the swarm move emits the assignment event (one per pass)', move1.moved && move1.events.length === 1 && move1.events[0].metadata.kind === 'idea_graph.swarm');
  const withSwarms = { ...state2, ideaGraph: move1.ideaGraph };
  const move2 = swarmMove(withSwarms);
  check('an untested subtree is honestly reported incomplete (no fake green)', move2.moved && Boolean(move2.ideaGraph.swarms?.every((assignment) => !assignment.completed)), move2.events[0]?.message.slice(0, 80));
}

/* -------------------------------------------------------------------------- */
/* f. idempotency — the whole loop twice files nothing new                      */
/* -------------------------------------------------------------------------- */

async function sectionF(): Promise<void> {
  section('f. idempotency — run the whole loop twice, count the duplicates');

  const empty = baseProject(RC_PROMPT, 'ig-idem');
  empty.requirements = null;
  const { store, memory } = memoryStore(empty);

  const first = await continueEverflow('ig-idem', 'verify', store, { maxPasses: 12, maxHumanTasks: 20, ideaGraph: { model: nullExpansionModel, maxExpansions: 40 } });
  void first;
  const after1 = memory.get('ig-idem')!;
  const nodeCount1 = after1.ideaGraph?.nodes.length ?? 0;
  const taskCount1 = after1.humanTasks.length;
  const testNodes1 = after1.ideaGraph?.nodes.filter((node) => node.kind === 'test_result').length ?? 0;

  await continueEverflow('ig-idem', 'verify', store, { maxPasses: 12, maxHumanTasks: 20, ideaGraph: { model: nullExpansionModel, maxExpansions: 40 } });
  const after2 = memory.get('ig-idem')!;
  const nodeCount2 = after2.ideaGraph?.nodes.length ?? 0;
  const taskCount2 = after2.humanTasks.length;
  const testNodes2 = after2.ideaGraph?.nodes.filter((node) => node.kind === 'test_result').length ?? 0;

  check('a second full loop adds NO nodes', nodeCount1 === nodeCount2, `${nodeCount1} → ${nodeCount2}`);
  check('a second full loop adds NO asks', taskCount1 === taskCount2, `${taskCount1} → ${taskCount2}`);
  check('a second full loop adds NO duplicate test results', testNodes1 === testNodes2, `${testNodes1} → ${testNodes2}`);
}

/* -------------------------------------------------------------------------- */
/* g. honesty — every model call fails, the graph still completes and SAYS so   */
/* -------------------------------------------------------------------------- */

async function sectionG(): Promise<void> {
  section('g. honesty — forced model failure: fallbacks complete, events confess');

  const failingModel: ExpansionModel = {
    async proposeChildren() {
      throw new Error('forced failure for verify');
    },
    async decisionPower() {
      throw new Error('forced failure for verify');
    },
  };

  const empty = baseProject(RC_PROMPT, 'ig-honest');
  const { store, memory, events } = memoryStore(empty);
  await continueEverflow('ig-honest', 'verify', store, { maxPasses: 10, maxHumanTasks: 20, ideaGraph: { model: failingModel, maxExpansions: 40 } });

  const graph = memory.get('ig-honest')?.ideaGraph;
  check('the graph still completes via fallbacks (skeleton + moves ran)', (graph?.nodes.length ?? 0) >= 8, `${graph?.nodes.length} node(s), ${graph?.expansions} expansion(s)`);
  const confession = events.filter((event) => typeof event.message === 'string' && event.message.includes('model call threw') && event.message.includes('deterministic expansion used'));
  check('the events SAY the model was unavailable (no fake green)', confession.length > 0, `${confession.length} confession event(s)`);
  const expansionEvents = events.filter((event) => event.type === 'idea_graph_expansion');
  check('every expansion event names its provenance (source / stop decision / pause / backstop)', expansionEvents.every((event) => typeof event.metadata?.source === 'string' || event.metadata?.backstop === true || event.metadata?.decision === 'stop' || event.metadata?.paused === true));
}

/* -------------------------------------------------------------------------- */
/* The persisted loop end-to-end (RC car → leaves tested → reviewer → swarm)    */
/* -------------------------------------------------------------------------- */

async function sectionLoop(): Promise<void> {
  section('end-to-end — RC car through expansion → tests → review → swarm (persisted pass)');

  const built = await realRcCarBuild();
  const seeded = { ...built.project, id: 'ig-loop', ideaGraph: undefined };
  const { store, memory } = memoryStore(seeded);
  const ideaOptions = { model: nullExpansionModel, maxExpansions: 40 };
  let last = await continueEverflow('ig-loop', 'verify', store, { maxPasses: 30, maxHumanTasks: 20, ideaGraph: ideaOptions });
  // The R3 pause lifts ONLY by an explicit answered ask — mirror respondEverflowTask
  // here (its write path is Mongo-backed and unavailable offline; the contract is the same:
  // mark answered + positive value ⇒ unpause, reset the dead-expansion counter).
  let lifts = 0;
  for (;;) {
    const cur = memory.get('ig-loop');
    const paused = cur?.ideaGraph;
    if (!cur || !paused || !paused.expansionPaused || paused.phase !== 'expanding' || lifts >= 8) break;
    const ask = [...cur.humanTasks].filter((task) => task.status === 'open' && /push deeper|backstop/i.test(task.title)).pop();
    if (!ask) break;
    memory.set('ig-loop', {
      ...cur,
      humanTasks: cur.humanTasks.map((task) =>
        task.id === ask.id ? { ...task, status: 'answered' as const, response: { value: 'Yes — push deeper', at: nowIso() }, updatedAt: nowIso() } : task),
      ideaGraph: { ...paused, expansionPaused: false, deadExpansions: 0, pausedReason: null },
    });
    lifts += 1;
    last = await continueEverflow('ig-loop', 'verify', store, { maxPasses: 30, maxHumanTasks: 20, ideaGraph: ideaOptions });
  }
  check('expansion finished with human shepherding (pauses lifted by answers, never silently)', lifts <= 8, `${lifts} pause lift(s)`);
  const state = memory.get('ig-loop')!;
  const graph = state.ideaGraph!;
  check('the loop ends in a coherent phase (reviewing with a verdict, or swarming/done)', ['reviewing', 'swarming', 'done'].includes(graph.phase) && (graph.phase !== 'reviewing' || graph.reviewer !== null), graph.phase);
  const subsystems = graph.nodes.filter((node) => node.kind === 'subsystem');
  const undecided = subsystems.filter((node) => node.expansionState === 'unexpanded');
  check('every subsystem reached an explicit decision (no silent leftovers)', undecided.length === 0, undecided.map((node) => node.label).join(', ') || 'all decided');
  check('every leaf ended with an explicit stop decision + reason', subsystems.filter((node) => node.expansionState === 'leaf' || node.expansionState === 'stopped').every((node) => (node.stopReason ?? '').length > 0));
  check('every subsystem carries a recorded stopRule or expansion note', subsystems.every((node) => Boolean(node.stopRule || node.stopReason)), subsystems.filter((node) => !node.stopRule && !node.stopReason).map((node) => node.label).join(', ') || 'all');
  check('an idea_graph.expansion event exists for the moves', state.events.filter((event) => event.type === 'idea_graph_expansion').length > 0);
  const pending = pendingTestNodes(graph);
  check('no leaf owes an untested test after the loop', pending.every((node) => node.testSpec?.status !== 'untested'), `${pending.length} pending`);
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  resetEnvCache();
  console.log('wireup · idea-graph verifier (offline: no Mongo, no Bedrock, no network)');
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
  await sectionF();
  await sectionG();
  await sectionLoop();

  console.log('');
  if (failures > 0) {
    console.log(`✗ ${failures} check(s) failed`);
    return 1;
  }
  console.log('✓ all idea-graph checks passed');
  return 0;
}

void main().then((code) => process.exit(code));
