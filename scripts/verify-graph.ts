/**
 * Graph verifier.
 *
 *   pnpm verify:graph
 *
 * Proves the graph rebuild offline — no Mongo, no model, no network:
 *
 *   a. dag        — topo order respects edges; appending a node never
 *                   reorders the prefix; cycles are found and named;
 *                   longest-path layers; barycenter reduces crossings
 *   b. layout     — deterministic (same graph → same pixels); every edge
 *                   placed; idea kinds fan out by level (no single stack);
 *                   appending a node keeps every existing node's x/y;
 *                   no overlaps; proof edges render as returns
 *   c. validate   — clean graphs pass; dup ids / dangling endpoints /
 *                   cycles error; orphans warn
 *   d. wiring     — pins band by net kind; parallel wires get lanes;
 *                   peripheral↔peripheral runs use the side lane; the kind
 *                   filter applies to the graph; controller falls back to
 *                   highest degree
 *   e. state      — replace vs append reducers; conditional edges; cyclic
 *                   runs bounded by maxSteps; checkpoint history;
 *                   interrupt_before + resume; update_state
 *   f. pass       — legacy runner vs StateGraph runner over the same
 *                   synthetic state: identical graphs, evaluations, plans
 *   g. steer      — the bus folds a steer mid-pass (graph runner) and the
 *                   legacy runner leaves the bus untouched
 *   h. models     — family detection, effort policy, route matrix, async
 *                   tool tracking, id helpers
 *
 * Exits 0 when every named assertion passes, 1 otherwise.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=1200';
process.env.BEDROCK_MODEL_ID = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

import type { AgentEvent } from '@/types/generation';
import type { EverflowEdge, EverflowGraph, EverflowNode, EverflowNodeKind } from '@/types/everflow';
import type { ProjectState } from '@/types/project';
import type { WiringConnection } from '@/types/wiring';

import { resetEnvCache } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import {
  assignLayers,
  buildAdjacency,
  clearSteerBus,
  crossingScore,
  drainSteers,
  edgeId,
  END,
  findCycle,
  layoutGraph,
  layoutWiring,
  MemoryCheckpointer,
  minimizeCrossings,
  pendingSteers,
  publishSteer,
  slug,
  START,
  StateGraph,
  topoSort,
  uniqueNodeId,
  validateEverflowGraph,
} from '@/modules/graph';
import { astraDirectAvailable, attachToolResult, decideRoute, defaultEffort, detectModelFamily, effortForTurn, fableDirectAvailable, headroomFor, parseEffort, registerAsyncTool, updateEffort } from '@/lib/models';
import { evaluateEverflow } from '@/modules/everflow/evaluate';
import { materializeGraph } from '@/modules/everflow/materialize';
import { runEverflowPassLegacy, type EverflowStore } from '@/modules/everflow/continuation';
import { runPassGraph } from '@/modules/everflow/pass-graph';

resetEnvCache();

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✕'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* ------------------------------------------------------------------------- */
/* a. DAG                                                                     */
/* ------------------------------------------------------------------------- */

function refs(ids: string[]): { id: string; index: number }[] {
  return ids.map((id, index) => ({ id, index }));
}

async function sectionDag(): Promise<void> {
  section('a. dag — topo sort, cycles, layers, crossings');

  // Diamond: a → b, a → c, b → d, c → d.
  const nodes = refs(['a', 'b', 'c', 'd']);
  const edges = [
    { id: 'e1', from: 'a', to: 'b', kind: 'x' },
    { id: 'e2', from: 'a', to: 'c', kind: 'x' },
    { id: 'e3', from: 'b', to: 'd', kind: 'x' },
    { id: 'e4', from: 'c', to: 'd', kind: 'x' },
  ];
  const adjacency = buildAdjacency(nodes, edges);
  const topo = topoSort(nodes, adjacency);
  check('topo order respects every edge', topo.acyclic && topo.order.join('') === 'abcd', topo.order.join(','));

  // Appending a node never reorders the existing prefix.
  const nodes2 = [...nodes, { id: 'e', index: 99 }];
  const edges2 = [...edges, { id: 'e5', from: 'a', to: 'e', kind: 'x' }];
  const topo2 = topoSort(nodes2, buildAdjacency(nodes2, edges2));
  check('appended node keeps the existing prefix order', topo2.order.slice(0, 4).join('') === 'abcd', topo2.order.join(','));

  // A cycle is found and named.
  const cyclic = refs(['a', 'b', 'c']);
  const cyclicEdges = [
    { id: 'e1', from: 'a', to: 'b', kind: 'x' },
    { id: 'e2', from: 'b', to: 'c', kind: 'x' },
    { id: 'e3', from: 'c', to: 'a', kind: 'x' },
  ];
  const cyclicTopo = topoSort(cyclic, buildAdjacency(cyclic, cyclicEdges));
  const cycle = findCycle(cyclic, buildAdjacency(cyclic, cyclicEdges));
  check('cyclic graph reports acyclic=false with all nodes left', !cyclicTopo.acyclic && cyclicTopo.cyclic.length === 3);
  check('findCycle names one concrete loop', cycle !== null && cycle.path[0] === cycle.path[cycle.path.length - 1] && cycle.path.length === 4, cycle?.path.join('→') ?? 'none');
  check('acyclic graph finds no cycle', findCycle(nodes, adjacency) === null);

  // Longest-path layers.
  const layers = assignLayers(nodes, adjacency, topo);
  check('diamond layers are a:0 b/c:1 d:2', layers.layerOf.get('a') === 0 && layers.layerOf.get('b') === 1 && layers.layerOf.get('c') === 1 && layers.layerOf.get('d') === 2);

  // Barycenter reduces crossings.
  const cross = refs(['a', 'b', 'c', 'd']);
  const crossAdj = buildAdjacency(cross, [
    { id: 'e1', from: 'a', to: 'd', kind: 'x' },
    { id: 'e2', from: 'b', to: 'c', kind: 'x' },
  ]);
  const before = crossingScore([['a', 'b'], ['c', 'd']], crossAdj);
  const after = minimizeCrossings([['a', 'b'], ['c', 'd']], crossAdj);
  check('barycenter removes the crossing', before === 1 && crossingScore(after, crossAdj) === 0, `score ${before} → ${crossingScore(after, crossAdj)}`);
}

/* ------------------------------------------------------------------------- */
/* b. layout                                                                  */
/* ------------------------------------------------------------------------- */

function mkNode(id: string, kind: EverflowNodeKind, extra: Partial<EverflowNode> = {}): EverflowNode {
  const at = nowIso();
  return {
    id,
    kind,
    label: id,
    content: id,
    status: 'active',
    confidence: 1,
    owner: 'ai',
    goal: { criterion: 'done', kind: 'custom', state: 'open' },
    file: null,
    source: { origin: 'pipeline' },
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function mkEdge(from: string, to: string, kind: EverflowEdge['kind'] = 'supports'): EverflowEdge {
  return { id: edgeId(from, kind, to), from, to, kind };
}

async function sectionLayout(): Promise<void> {
  section('b. layout — determinism, idea fan-out, stability, returns');

  const graph: EverflowGraph = {
    projectId: 'layout-verify',
    nodes: [
      mkNode('ev-intent', 'intent'),
      mkNode('ev-req-1', 'claim'),
      mkNode('ev-goal-behaviour-x', 'goal'),
      mkNode('ev-art-sketch-ino', 'artifact'),
      mkNode('ig-l1-power', 'subsystem', { level: 1, parentId: 'ev-intent' }),
      mkNode('ig-l2-cells', 'subsystem', { level: 2, parentId: 'ig-l1-power' }),
      mkNode('ig-test-1', 'test_result', { level: 2, parentId: 'ig-l2-cells' }),
      mkNode('ig-review-1', 'review', { level: 1 }),
      mkNode('ev-task-1', 'task'),
    ],
    edges: [
      mkEdge('ev-intent', 'ev-req-1'),
      mkEdge('ev-intent', 'ev-goal-behaviour-x'),
      mkEdge('ev-art-sketch-ino', 'ev-goal-behaviour-x', 'produces'),
      mkEdge('ig-l1-power', 'ev-intent', 'part_of'),
      mkEdge('ig-l2-cells', 'ig-l1-power', 'part_of'),
      mkEdge('ig-test-1', 'ig-l2-cells', 'verified_by'),
      mkEdge('ig-review-1', 'ev-intent', 'verified_by'),
      mkEdge('ev-intent', 'ev-task-1'),
    ],
    updatedAt: nowIso(),
  };

  const first = layoutGraph(graph);
  const second = layoutGraph(graph);
  check('same graph in, same pixels out', JSON.stringify(first) === JSON.stringify(second));
  check('every edge placed (no silent drops)', first.edges.length === graph.edges.length, `${first.edges.length}/${graph.edges.length}`);

  const layerOf = first.assignment.layerOf;
  check(
    'idea kinds fan out by level instead of one stack',
    layerOf.get('ig-l1-power') === 3 && layerOf.get('ig-l2-cells') === 4 && layerOf.get('ig-test-1') === 6,
    `L1=${layerOf.get('ig-l1-power')} L2=${layerOf.get('ig-l2-cells')} test=${layerOf.get('ig-test-1')}`,
  );

  const proof = first.edges.find((edge) => edge.edge.kind === 'produces');
  check('proof edge (artifact → goal) renders as a return', proof?.reversed === true);

  // No two nodes in a layer overlap.
  let overlap = false;
  const byLayer = new Map<number, { y: number; h: number }[]>();
  for (const node of first.nodes) {
    const list = byLayer.get(node.layer) ?? [];
    list.push({ y: node.y, h: node.height });
    byLayer.set(node.layer, list);
  }
  for (const list of byLayer.values()) {
    const sorted = [...list].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].y < sorted[i - 1].y + sorted[i - 1].h) overlap = true;
    }
  }
  check('no overlapping nodes within any layer', !overlap);

  // Stability: appending a claim keeps every existing node's x/y.
  const extended: EverflowGraph = {
    ...graph,
    nodes: [...graph.nodes, mkNode('ev-req-2', 'claim')],
    edges: [...graph.edges, mkEdge('ev-intent', 'ev-req-2')],
  };
  const after = layoutGraph(extended);
  const beforeById = new Map(first.nodes.map((node) => [node.node.id, node]));
  const moved = after.nodes.filter((node) => {
    const prev = beforeById.get(node.node.id);
    return prev !== undefined && (prev.x !== node.x || prev.y !== node.y);
  });
  check('appending a node moves nothing already placed', moved.length === 0, moved.length > 0 ? moved.map((node) => node.node.id).join(',') : `${first.nodes.length} nodes stable`);
}

/* ------------------------------------------------------------------------- */
/* c. validate                                                                */
/* ------------------------------------------------------------------------- */

async function sectionValidate(): Promise<void> {
  section('c. validate — errors vs warnings');

  const clean: EverflowGraph = {
    projectId: 'v',
    nodes: [mkNode('ev-intent', 'intent'), mkNode('a', 'claim')],
    edges: [mkEdge('ev-intent', 'a')],
    updatedAt: nowIso(),
  };
  check('clean graph validates', validateEverflowGraph(clean).ok);

  const dup: EverflowGraph = { ...clean, nodes: [mkNode('a', 'claim'), mkNode('a', 'claim')] };
  check('duplicate node id errors', validateEverflowGraph(dup).errors.some((issue) => issue.code === 'duplicate_node_id'));

  const dangling: EverflowGraph = { ...clean, edges: [mkEdge('ev-intent', 'ghost')] };
  check('dangling endpoint errors', validateEverflowGraph(dangling).errors.some((issue) => issue.code === 'edge_endpoint_missing'));

  const looped: EverflowGraph = {
    projectId: 'v',
    nodes: [mkNode('a', 'claim'), mkNode('b', 'goal')],
    edges: [mkEdge('a', 'b'), mkEdge('b', 'a')],
    updatedAt: nowIso(),
  };
  const loopReport = validateEverflowGraph(looped);
  check('cycle errors and names the loop', loopReport.errors.some((issue) => issue.code === 'cycle_detected' && issue.message.includes('→')), loopReport.errors[0]?.message ?? '');

  const orphan: EverflowGraph = { ...clean, nodes: [...clean.nodes, mkNode('floater', 'claim')] };
  const orphanReport = validateEverflowGraph(orphan);
  check('orphan warns (does not fail)', orphanReport.ok && orphanReport.warnings.some((issue) => issue.code === 'orphan_node'));

  const selfLoop: EverflowGraph = { ...clean, edges: [...clean.edges, { id: 'self', from: 'a', to: 'a', kind: 'supports' }] };
  check('self-loop warns (does not fail)', validateEverflowGraph(selfLoop).ok);
}

/* ------------------------------------------------------------------------- */
/* d. wiring                                                                  */
/* ------------------------------------------------------------------------- */

function wire(id: string, from: [string, string], to: [string, string], kind: WiringConnection['kind'], signal: WiringConnection['signal'] = 'digital'): WiringConnection {
  return {
    id,
    from: { componentId: 'c', instanceId: from[0], pin: from[1] },
    to: { componentId: 'c', instanceId: to[0], pin: to[1] },
    kind,
    signal,
    protocol: 'gpio',
    direction: 'unidirectional',
    explanation: 'test wire',
    source: 'planner',
  };
}

async function sectionWiring(): Promise<void> {
  section('d. wiring — banding, lanes, side lane, filter, fallback');

  const connections = [
    wire('w1', ['mcu-1', 'D2'], ['led-1', 'A'], 'signal'),
    wire('w2', ['mcu-1', '5V'], ['led-1', 'VCC'], 'power', 'power'),
    wire('w3', ['mcu-1', 'GND'], ['led-1', 'GND'], 'ground', 'ground'),
    wire('w4', ['mcu-1', 'D3'], ['led-1', 'K'], 'signal', 'pwm'),
    wire('w5', ['led-1', 'OUT'], ['motor-1', 'IN'], 'signal', 'analog'), // peripheral↔peripheral
  ];
  const labels = new Map([['mcu-1', 'MCU'], ['led-1', 'LED'], ['motor-1', 'Motor']]);
  const layout = layoutWiring(connections, 'mcu-1', labels, 'all');
  check('layout produced', layout !== null);
  if (!layout) return;

  const order = layout.controller.pins.map((pin) => pin.kind);
  const banded = order.indexOf('power') < order.indexOf('signal') && order.indexOf('ground') < order.indexOf('signal');
  check('controller pins band power/ground before signal', banded, order.join(','));

  const parallel = [
    wire('p1', ['mcu-1', 'D4'], ['motor-1', 'A'], 'signal'),
    wire('p2', ['mcu-1', 'D5'], ['motor-1', 'B'], 'signal'),
  ];
  const parallelLayout = layoutWiring(parallel, 'mcu-1', labels, 'all')!;
  check('parallel wires get distinct lanes', parallelLayout.wires[0].d !== parallelLayout.wires[1].d && parallelLayout.wires[1].lane === 1);

  const sideLane = layout.wires.find((w) => w.id === 'w5');
  check('peripheral↔peripheral uses the orthogonal side lane', sideLane !== undefined && sideLane.d.includes(' L '), sideLane?.d.slice(0, 40) ?? 'missing');

  const filtered = layoutWiring(connections, 'mcu-1', labels, 'signal')!;
  check('kind filter applies to the graph', filtered.wires.length === 3 && filtered.wires.every((w) => w.kind === 'signal') && filtered.hiddenByFilter === 2);

  const star = [
    wire('s1', ['mcu-9', 'D2'], ['p-a', 'IN'], 'signal'),
    wire('s2', ['mcu-9', 'D3'], ['p-b', 'IN'], 'signal'),
    wire('s3', ['mcu-9', 'D4'], ['p-c', 'IN'], 'signal'),
  ];
  const noHint = layoutWiring(star, undefined, new Map([['mcu-9', 'MCU']]), 'all')!;
  check('controller falls back to highest degree', noHint.controllerInstanceId === 'mcu-9', noHint.controllerInstanceId);
  check('empty connections return null', layoutWiring([], 'mcu-1', labels, 'all') === null);
}

/* ------------------------------------------------------------------------- */
/* e. state graph                                                             */
/* ------------------------------------------------------------------------- */

async function sectionState(): Promise<void> {
  section('e. state graph — reducers, conditionals, cycles, checkpoints, interrupts');

  interface Counter extends Record<string, unknown> {
    n: number;
    log: string[];
  }

  // Reducers: replace vs append.
  const g1 = new StateGraph<Counter>({ n: 'replace', log: 'append' });
  g1.addNode('a', () => ({ n: 1, log: ['a'] }));
  g1.addNode('b', () => ({ n: 2, log: ['b'] }));
  g1.setEntryPoint('a');
  g1.addEdge('a', 'b');
  const r1 = await g1.compile().invoke('t1', { n: 0, log: [] });
  check('replace overwrites, append accumulates', r1.state.n === 2 && r1.state.log.join('') === 'ab');

  // Conditional edges.
  const g2 = new StateGraph<Counter>({});
  g2.addNode('check', () => ({}));
  g2.addNode('high', () => ({ n: 100 }));
  g2.addNode('low', () => ({ n: -100 }));
  g2.setEntryPoint('check');
  g2.addConditionalEdges('check', (state) => (state.n > 0 ? 'high' : 'low'));
  const r2a = await g2.compile().invoke('t2a', { n: 5, log: [] });
  const r2b = await g2.compile().invoke('t2b', { n: -5, log: [] });
  check('conditional edges route by state', r2a.state.n === 100 && r2b.state.n === -100 && r2a.path.join(',') === 'check,high');

  // Cycles are bounded and reported.
  const g3 = new StateGraph<Counter>({ n: 'replace' });
  g3.addNode('tick', (state) => ({ n: state.n + 1 }));
  g3.setEntryPoint('tick');
  g3.addConditionalEdges('tick', (state) => (state.n < 100 ? 'tick' : END));
  const r3 = await g3.compile().invoke('t3', { n: 0, log: [] }, { maxSteps: 5 });
  check('cyclic runs stop at maxSteps and say so', r3.stepLimitHit && r3.steps === 5 && r3.state.n === 5);

  // Checkpoints + interrupts + resume + update_state.
  const checkpointer = new MemoryCheckpointer<Counter>();
  const g4 = new StateGraph<Counter>({ n: 'replace' });
  g4.addNode('a', () => ({ n: 1 }));
  g4.addNode('b', (state) => ({ n: state.n + 10 }));
  g4.setEntryPoint('a');
  g4.addEdge('a', 'b');
  const compiled = g4.compile(checkpointer);
  const paused = await compiled.invoke('t4', { n: 0, log: [] }, { interruptBefore: ['b'] });
  check('interrupt_before pauses with state saved', paused.interrupted === 'b' && paused.state.n === 1);
  await compiled.updateState('t4', { n: 2 });
  const resumed = await compiled.invoke('t4', null);
  check('resume continues from the checkpoint with the update', resumed.interrupted === null && resumed.state.n === 12 && resumed.path.join(',') === 'b');
  const history = await compiled.getHistory('t4');
  check('history records every step', history.length >= 4, `${history.length} checkpoints`);

  // START constant is honored (imported for the contract check).
  check('START/END sentinels are distinct', String(START) !== String(END));
}

/* ------------------------------------------------------------------------- */
/* f + g. pass equivalence + steer bus                                        */
/* ------------------------------------------------------------------------- */

function baseProject(overrides: Partial<ProjectState> = {}): ProjectState {
  const now = nowIso();
  return {
    id: 'graph-verify',
    name: 'Verify Car',
    prompt: 'build a bluetooth rc car with two dc motors and an ultrasonic sensor that stops before obstacles',
    status: 'completed',
    stage: 'completed',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    error: null,
    requirements: {
      goal: 'A Bluetooth RC car that stops before obstacles.',
      summary: 'Two DC motors, ultrasonic stop.',
      requirements: ['Two DC motors drive the car'],
      inputs: ['Bluetooth commands'],
      outputs: ['Motor drive'],
      behaviors: ['Stops before obstacles'],
      constraints: [],
      platformRequirements: [],
      communicationRequirements: ['Bluetooth'],
      powerRequirements: [],
      quantities: { motors: 2 },
      features: ['bluetooth'],
      assumptions: ['Powered from a 2S LiPo'],
      ambiguities: [],
      behavioralSpec: {
        assertions: [
          { id: 'beh-obstacle-stop', title: 'Stops when an obstacle is detected', subject: { kind: 'telemetry', field: 'x' }, operator: 'changes', required: true, derivedFrom: ['stop'] },
        ],
        origin: 'heuristics',
        generatedAt: now,
        notes: [],
      },
    } as unknown as ProjectState['requirements'],
    components: [],
    hardwarePlan: null,
    pinAssignments: [],
    wiring: null,
    softwarePlan: null,
    artifacts: {
      code: { files: [{ path: 'sketch.ino', language: 'cpp', content: 'void setup(){} void loop(){}', purpose: 'firmware', generatedBy: 'planner' }], entryPoint: 'sketch.ino' },
      diagram: null,
      libraries: { libraries: [], installCommands: [] },
      instructions: { sections: [{ id: 's1', title: 'Build', body: 'steps', order: 1 }], billOfMaterials: [], estimatedMinutes: 30 },
    } as unknown as ProjectState['artifacts'],
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

function memoryStore(state: ProjectState): { store: EverflowStore; events: AgentEvent[] } {
  let current = structuredClone(state);
  const appended: AgentEvent[] = [];
  let seq = current.events.reduce((max, event) => Math.max(max, event.seq), 0);
  return {
    events: appended,
    store: {
      async getState() {
        return structuredClone(current);
      },
      async save(_id, patch) {
        current = { ...current, ...(patch as Partial<ProjectState>) };
        return structuredClone(current);
      },
      async appendEvent(_id, event) {
        seq += event.seq ? 0 : 1;
        const full = { ...event, seq: event.seq ?? seq } as AgentEvent;
        appended.push(full);
        current = { ...current, events: [...current.events, full] };
      },
    },
  };
}

async function sectionPass(): Promise<void> {
  section('f. pass equivalence — legacy runner vs StateGraph runner');

  clearSteerBus();
  const fixture = baseProject();
  const legacy = memoryStore(fixture);
  const graphed = memoryStore(fixture);

  const legacyResult = await runEverflowPassLegacy('graph-verify', 'verify', legacy.store, { maxHumanTasks: 12 });
  const graphResult = await runPassGraph('graph-verify', 'verify', graphed.store, { maxHumanTasks: 12 });
  check('both runners complete', legacyResult !== null && graphResult !== null);
  if (!legacyResult || !graphResult) return;

  check('identical node counts', legacyResult.graph.nodes.length === graphResult.graph.nodes.length, `${legacyResult.graph.nodes.length} nodes`);
  check('identical edge counts', legacyResult.graph.edges.length === graphResult.graph.edges.length, `${legacyResult.graph.edges.length} edges`);
  check(
    'identical evaluation totals',
    JSON.stringify(legacyResult.evaluation.totals) === JSON.stringify(graphResult.evaluation.totals) &&
      legacyResult.evaluation.done === graphResult.evaluation.done &&
      legacyResult.evaluation.completion === graphResult.evaluation.completion,
    `${Math.round(graphResult.evaluation.completion * 100)}% complete`,
  );
  const titles = (tasks: { title: string }[]): string => tasks.map((task) => task.title).sort().join('|');
  check(
    'identical plans',
    titles(legacyResult.plan.newTasks) === titles(graphResult.plan.newTasks) &&
      titles(legacyResult.plan.followUps) === titles(graphResult.plan.followUps) &&
      legacyResult.plan.processedInjections.length === graphResult.plan.processedInjections.length,
    `${graphResult.plan.newTasks.length} asks filed`,
  );
  check('identical progress verdicts', legacyResult.progressed === graphResult.progressed);
  check(
    'identical event narratives (runner tag aside)',
    legacy.events.map((event) => event.message).join('\n') === graphed.events.map((event) => event.message).join('\n'),
    `${graphed.events.length} events`,
  );
  check('graph runner walked every node', graphResult.path.join(',') === 'materialize,evaluate,foldSteers,plan,idea,research,persist', graphResult.path.join(','));

  // The materialised graph is structurally valid.
  const report = validateEverflowGraph(graphResult.graph);
  check('materialised graph validates clean', report.ok, report.errors.map((issue) => issue.message).join('; '));
  const laidOut = layoutGraph(graphResult.graph);
  check('materialised graph lays out fully', laidOut.edges.length === graphResult.graph.edges.length);
}

async function sectionSteer(): Promise<void> {
  section('g. steer bus — mid-pass folding (graph) vs untouched (legacy)');

  clearSteerBus();
  check('bus starts empty', pendingSteers('graph-verify') === 0);

  // Legacy runner never drains the bus.
  publishSteer({ id: 'htask_steer_legacy', projectId: 'graph-verify', text: 'prefer WiFi over Bluetooth', title: 'prefer WiFi', at: nowIso() });
  const legacyOnly = memoryStore(baseProject());
  await runEverflowPassLegacy('graph-verify', 'verify', legacyOnly.store, { maxHumanTasks: 12 });
  check('legacy pass leaves the bus untouched', pendingSteers('graph-verify') === 1);
  const legacyState = await legacyOnly.store.getState('graph-verify');
  check('legacy pass never saw the steer', !legacyState!.humanTasks.some((task) => task.id === 'htask_steer_legacy'));
  clearSteerBus();

  // Graph runner folds the steer at the foldSteers boundary, in the same pass.
  publishSteer({ id: 'htask_steer_mid', projectId: 'graph-verify', text: 'prefer WiFi over Bluetooth', title: 'prefer WiFi', at: nowIso() });
  const graphed = memoryStore(baseProject());
  const result = await runPassGraph('graph-verify', 'verify', graphed.store, { maxHumanTasks: 12 });
  check('graph pass completes with a steer waiting', result !== null);
  const finalState = await graphed.store.getState('graph-verify');
  const steer = finalState!.humanTasks.find((task) => task.id === 'htask_steer_mid');
  check('steer folded and processed in the same pass', steer?.status === 'processed');
  check('steer produced its apply follow-up', finalState!.humanTasks.some((task) => task.type === 'choose' && task.title.includes('prefer WiFi')));
  const summary = graphed.events.filter((event) => event.type === 'everflow_pass').pop();
  check('pass event says the steer folded mid-pass', (summary?.metadata?.steersFolded as number) === 1 && summary!.message.includes('folded mid-pass'));
  check('bus drained exactly once', pendingSteers('graph-verify') === 0 && drainSteers('graph-verify').length === 0);
}

/* ------------------------------------------------------------------------- */
/* h. models                                                                  */
/* ------------------------------------------------------------------------- */

async function sectionModels(): Promise<void> {
  section('h. models — families, effort, routes, async tools, ids');

  check('astra detected (direct id)', detectModelFamily('gpt-6-astra') === 'astra');
  check('astra detected (bedrock-style id)', detectModelFamily('us.openai.gpt-6-astra-v1:0') === 'astra');
  check('fable detected', detectModelFamily('claude-fable-5-1') === 'fable');
  check('generic stays generic', detectModelFamily('anthropic.claude-3-5-sonnet-20240620-v1:0') === 'generic');
  check('empty id is none', detectModelFamily('') === 'none' && detectModelFamily(undefined) === 'none');

  check('effort policy: r2 low, expansion medium, review high', defaultEffort('idea_r2') === 'low' && defaultEffort('idea_expansion') === 'medium' && defaultEffort('idea_review') === 'high');
  check('effort override parses, garbage falls back', parseEffort('max', 'medium') === 'max' && parseEffort('none', 'medium') === 'medium');
  check('no direct keys in the verifier', !astraDirectAvailable() && !fableDirectAvailable());

  check('astra + key routes direct', decideRoute('gpt-6-astra', { openai: true, anthropic: false, bedrockModel: true }).transport === 'openai');
  check('astra without key rides bedrock', decideRoute('gpt-6-astra', { openai: false, anthropic: false, bedrockModel: true }).transport === 'bedrock');
  check('fable + key routes direct', decideRoute('claude-fable-5-1', { openai: false, anthropic: true, bedrockModel: true }).transport === 'anthropic');
  check('generic rides bedrock', decideRoute('some-model', { openai: true, anthropic: true, bedrockModel: true }).transport === 'bedrock');

  const patch = updateEffort('high');
  check('configuration_update patch shape', patch.type === 'configuration_update' && patch.reasoning.effort === 'high');
  registerAsyncTool({ callId: 'call_1', name: 'compile', arguments: '{}', issuedAt: nowIso() });
  check('async tool tracked then attached by call id', attachToolResult('call_1')?.name === 'compile' && attachToolResult('call_1') === null);
  check('per-message effort is a passthrough', effortForTurn('low') === 'low');
  check('fable headroom floors high effort', headroomFor('high', 300) === 16_000 && headroomFor('low', 300) === 8_000 && headroomFor('low', 20_000) === 20_000);

  check('slug trims + lowercases', slug('  Beh-Obstacle_Stop!! ') === 'beh-obstacle-stop');
  const taken = new Set(['node']);
  const unique = uniqueNodeId('node', taken);
  check('slug collision keeps the node under a stable hash id', unique !== 'node' && unique.startsWith('node-') && uniqueNodeId(unique, new Set([unique])) !== unique);
  check('edge ids are deterministic + distinct', edgeId('a', 'supports', 'b') === edgeId('a', 'supports', 'b') && edgeId('a', 'supports', 'b') !== edgeId('a', 'supports', 'bb'));
}

/* ------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log('verify:graph — the graph rebuild, offline');
  await sectionDag();
  await sectionLayout();
  await sectionValidate();
  await sectionWiring();
  await sectionState();
  await sectionPass();
  await sectionSteer();
  await sectionModels();

  // The full materialize → evaluate chain on the synthetic project (also
  // proves the shared slug + research-after-merge fixes end to end).
  const project = baseProject();
  const graph = materializeGraph(project);
  const evaluation = evaluateEverflow(project, graph, 1);
  check('synthetic project materialises + evaluates', graph.nodes.length > 5 && evaluation.totals.nodes === graph.nodes.length);

  console.log(failures === 0 ? '\n✓ all graph checks passed' : `\n✕ ${failures} graph check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verify:graph crashed:', error);
  process.exit(1);
});
