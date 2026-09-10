/**
 * Everflow — the continuation pass expressed AS a StateGraph.
 *
 * Nodes: materialize → evaluate → foldSteers → plan → idea → research →
 * persist. Every node calls the SAME pure helpers as the legacy runner, in
 * the same order, so the two runners are behaviour-identical (the graph
 * verifier asserts equivalence over a synthetic state). What the graph adds:
 *
 *   - a checkpoint after every node (per-pass thread: pause/resume/audit),
 *   - steer folding at a node boundary INSIDE the pass (Tier-1.5): a steer
 *     published while the pass runs lands in the same pass instead of
 *     waiting for the next one,
 *   - `interruptBefore` support for future human-gated persists.
 *
 * Reducers: `snapshot`/`graph`/`evaluation`/`plan` REPLACE (current
 * values); `ideaEvents`/`ideaTasks`/`findings`/`foldedSteers` APPEND
 * (accumulators — never silently overwritten across nodes).
 */

import type { AgentEvent } from '@/types/generation';
import type { EverflowEvaluation, EverflowGraph, HumanTask, IdeaGraphState, ResearchFinding } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { drainSteers, MemoryCheckpointer, StateGraph, type Checkpointer } from '@/modules/graph';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { evaluateEverflow } from './evaluate';
import { runIdeaMoves, type IdeaMovesOptions } from './idea-moves';
import { materializeGraph } from './materialize';
import { EVERFLOW_DEFAULT_MAX_HUMAN_TASKS, planContinuation, type PlanResult } from './planner';
import { planAutoResearch, researchNode } from './research';

/** Persistence seam (structurally identical to `EverflowStore` — no import to avoid a cycle). */
export interface PassStore {
  getState(id: string): Promise<ProjectState | null>;
  save(id: string, patch: Record<string, unknown>): Promise<ProjectState | null>;
  appendEvent(id: string, event: Omit<AgentEvent, 'seq'> & { seq?: number }): Promise<void>;
}

export interface PassGraphOptions {
  maxHumanTasks?: number;
  ideaGraph?: IdeaMovesOptions & { enabled?: boolean };
  interruptBefore?: string[];
  checkpointer?: Checkpointer<PassState>;
}

export interface PassState extends Record<string, unknown> {
  projectId: string;
  trigger: string;
  pass: number;
  maxHumanTasks: number;
  snapshot: ProjectState;
  graph: EverflowGraph | null;
  evaluation: EverflowEvaluation | null;
  plan: PlanResult | null;
  ideaGraph: IdeaGraphState | null;
  ideaMoved: boolean;
  ideaEvents: (AgentEvent & { seq?: number })[];
  ideaTasks: HumanTask[];
  findings: ResearchFinding[];
  foldedSteers: string[];
  ideaOptions: IdeaMovesOptions;
}

export interface PassGraphResult {
  state: ProjectState;
  graph: EverflowGraph;
  evaluation: EverflowEvaluation;
  plan: PlanResult;
  progressed: boolean;
  /** Node path the graph walked (for the verifier + the pass event). */
  path: string[];
}

function emptyPlan(): PlanResult {
  return { newTasks: [], processedInjections: [], followUps: [], description: [] };
}

function foldSteerUpdate(state: PassState): Partial<PassState> {
  const steers = drainSteers(state.projectId);
  if (steers.length === 0) return {};
  const seen = new Set(state.snapshot.humanTasks.map((task) => task.id));
  const fresh = steers.filter((steer) => !seen.has(steer.id));
  if (fresh.length === 0) return {};
  // Reconstruct the exact task shape `createHumanInjection` persisted
  // (the bus carries a copy for prompt delivery; the id dedups).
  const tasks: HumanTask[] = fresh.map((steer) => ({
    id: steer.id,
    direction: 'human_to_ai',
    type: 'steer',
    title: steer.title,
    body: steer.text,
    asks: { shape: 'text' },
    linkedNodeIds: ['ev-intent'],
    lookAt: null,
    priority: 'high',
    status: 'open',
    response: { value: steer.text, at: steer.at },
    defaultOnExpiry: 'defer',
    assumptionIfSkipped: null,
    source: 'human',
    createdAt: steer.at,
    updatedAt: steer.at,
  }));
  return {
    snapshot: { ...state.snapshot, humanTasks: [...state.snapshot.humanTasks, ...tasks] },
    foldedSteers: fresh.map((steer) => steer.id),
  };
}

/** The pass as a graph. `store`/`pass`/`trigger` bind the persist node. */
export function buildPassGraph(store: PassStore, pass: number, trigger: string, projectId: string): StateGraph<PassState> {
  const graph = new StateGraph<PassState>({
    snapshot: 'replace',
    graph: 'replace',
    evaluation: 'replace',
    plan: 'replace',
    ideaGraph: 'replace',
    ideaMoved: 'replace',
    ideaEvents: 'append',
    ideaTasks: 'append',
    findings: 'append',
    foldedSteers: 'append',
  });

  graph.addNode('materialize', (state) => ({ graph: materializeGraph(state.snapshot) }));
  graph.addNode('evaluate', (state) => ({
    evaluation: evaluateEverflow(state.snapshot, state.graph!, state.pass + 1),
  }));
  graph.addNode('foldSteers', foldSteerUpdate);
  graph.addNode('plan', (state) => ({
    plan: state.evaluation && state.graph ? planContinuation(state.snapshot, state.graph, state.evaluation, state.maxHumanTasks) : emptyPlan(),
  }));
  graph.addNode('idea', async (state) => {
    const outcome = await runIdeaMoves(state.snapshot, state.projectId, state.ideaOptions);
    return {
      snapshot: outcome.passState,
      ideaGraph: outcome.ideaGraph,
      ideaMoved: outcome.moved,
      ideaEvents: outcome.sequencedEvents,
      ideaTasks: outcome.newTasks,
    };
  });
  graph.addNode('research', async (state) => {
    const findings: ResearchFinding[] = [];
    if (state.graph) {
      for (const pick of planAutoResearch(state.snapshot, state.graph, 2)) {
        const finding = await researchNode({ state: state.snapshot, node: pick.node });
        if (finding) findings.push(finding);
      }
    }
    if (findings.length === 0) return {};
    return {
      snapshot: { ...state.snapshot, research: [...state.snapshot.research, ...findings] },
      findings,
    };
  });
  graph.addNode('persist', async (state) => {
    const plan = state.plan ?? emptyPlan();
    const humanTasks = [...state.snapshot.humanTasks, ...plan.newTasks, ...plan.followUps, ...state.ideaTasks].map((task) =>
      plan.processedInjections.includes(task.id) ? { ...task, status: 'processed' as const, updatedAt: nowIso() } : task,
    );
    let graphNow = state.graph!;
    let evaluationNow = state.evaluation!;
    let next: ProjectState = {
      ...state.snapshot,
      humanTasks,
      everflow: { graph: graphNow, evaluation: evaluationNow, pass: pass + 1 },
      ...(state.ideaMoved && state.ideaGraph ? { ideaGraph: state.ideaGraph } : {}),
    };
    if (state.findings.length > 0 || state.ideaMoved) {
      // Re-project: new evidence/idea nodes join the graph and the brief.
      graphNow = materializeGraph(next);
      evaluationNow = evaluateEverflow(next, graphNow, pass + 1);
      next = { ...next, everflow: { graph: graphNow, evaluation: evaluationNow, pass: pass + 1 } };
    }
    const saved = await store.save(projectId, {
      ...next,
      humanTasks,
      ...(state.findings.length > 0 ? { research: next.research } : {}),
      everflow: next.everflow,
      ...(state.ideaMoved && state.ideaGraph ? { ideaGraph: state.ideaGraph } : {}),
    });
    for (const event of state.ideaEvents) {
      await store.appendEvent(projectId, event);
    }
    const progressed =
      plan.newTasks.length + plan.followUps.length + plan.processedInjections.length + state.findings.length + (state.ideaMoved ? 1 : 0) > 0;
    const pct = Math.round(evaluationNow.completion * 100);
    await store.appendEvent(projectId, {
      id: createId('evt'),
      type: 'everflow_pass',
      status: 'info',
      message: evaluationNow.done
        ? `Everflow pass ${pass + 1} (${trigger}): every goal satisfied — the project is complete.`
        : `Everflow pass ${pass + 1} (${trigger}): ${pct}% complete, ${evaluationNow.totals.openEnds} dangling, ${plan.newTasks.length + plan.followUps.length + state.ideaTasks.length} ask(s) filed${state.ideaMoved ? ', idea graph advanced' : ''}${state.findings.length > 0 ? `, ${state.findings.length} doc check(s) recorded` : ''}${state.foldedSteers.length > 0 ? `, ${state.foldedSteers.length} steer(s) folded mid-pass` : ''}.`,
      timestamp: nowIso(),
      stage: 'completed',
      metadata: {
        trigger,
        pass: pass + 1,
        completion: pct,
        done: evaluationNow.done,
        blockedOnHuman: evaluationNow.blockedOnHuman,
        openEnds: evaluationNow.totals.openEnds,
        tasksFiled: plan.newTasks.length + plan.followUps.length + state.ideaTasks.length,
        docsChecked: state.findings.length,
        injectionsProcessed: plan.processedInjections.length,
        ideaGraphMoved: state.ideaMoved,
        steersFolded: state.foldedSteers.length,
        runner: 'graph',
        ...(state.ideaGraph ? { ideaGraphExpansions: state.ideaGraph.expansions, ideaGraphPhase: state.ideaGraph.phase } : {}),
      },
    });
    const finalState = saved ?? next;
    return { snapshot: finalState, graph: graphNow, evaluation: evaluationNow };
  });

  graph.setEntryPoint('materialize');
  graph.addEdge('materialize', 'evaluate');
  graph.addEdge('evaluate', 'foldSteers');
  graph.addEdge('foldSteers', 'plan');
  graph.addEdge('plan', 'idea');
  graph.addEdge('idea', 'research');
  graph.addEdge('research', 'persist');

  return graph;
}

export async function runPassGraph(
  projectId: string,
  trigger: string,
  store: PassStore,
  options: PassGraphOptions = {},
): Promise<PassGraphResult | null> {
  const snapshot = await store.getState(projectId);
  if (!snapshot) return null;
  const pass = snapshot.everflow?.pass ?? 0;

  const compiled = buildPassGraph(store, pass, trigger, projectId).compile(options.checkpointer ?? new MemoryCheckpointer<PassState>());
  const threadId = `pass-${createId('evt')}`;
  const initial: PassState = {
    projectId,
    trigger,
    pass,
    maxHumanTasks: options.maxHumanTasks ?? EVERFLOW_DEFAULT_MAX_HUMAN_TASKS,
    snapshot,
    graph: null,
    evaluation: null,
    plan: null,
    ideaGraph: snapshot.ideaGraph ?? null,
    ideaMoved: false,
    ideaEvents: [],
    ideaTasks: [],
    findings: [],
    foldedSteers: [],
    ideaOptions: {
      ...(options.ideaGraph?.enabled !== undefined ? { enabled: options.ideaGraph.enabled } : {}),
      ...(options.ideaGraph?.model ? { model: options.ideaGraph.model } : {}),
      ...(options.ideaGraph?.maxExpansions !== undefined ? { maxExpansions: options.ideaGraph.maxExpansions } : {}),
      ...(options.ideaGraph?.reviewerModel !== undefined ? { reviewerModel: options.ideaGraph.reviewerModel } : {}),
    },
  };

  const result = await compiled.invoke(threadId, initial, {
    ...(options.interruptBefore ? { interruptBefore: options.interruptBefore } : {}),
  });
  if (result.interrupted) {
    // A compiled pause point fired: the state is checkpointed; the caller
    // resumes with the same thread. The pass runner never sets interrupts
    // today — this branch exists for the verifier + future gates.
    throw new Error(`Pass interrupted before "${result.interrupted}" (thread ${threadId}).`);
  }
  const final = result.state;
  const plan = final.plan ?? emptyPlan();
  const progressed =
    plan.newTasks.length + plan.followUps.length + plan.processedInjections.length + final.findings.length + (final.ideaMoved ? 1 : 0) > 0;
  return { state: final.snapshot, graph: final.graph!, evaluation: final.evaluation!, plan, progressed, path: result.path };
}
