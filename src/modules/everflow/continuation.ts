/**
 * Everflow — the continuation loop (the "everflowing" agent).
 *
 * After the pipeline finalises — and after every human-channel event — a
 * continuation pass runs:
 *
 *   1. materialise  — project state → graph (deterministic projection)
 *   2. evaluate     — every node's goal is judged by code; dangling nodes
 *                     are flagged as open ends
 *   3. plan         — for every unmet goal the agent names its next move:
 *                        • file an ai→human task (it can never close this
 *                          goal alone), or
 *                        • process a human→ai addition (register the fact,
 *                          file a "apply to the build?" ask — never a silent
 *                          self-modification), or
 *                        • record that the work is already in flight
 *   4. persist      — graph + evaluation + tasks land on the project doc and
 *                     the event log explains the pass
 *
 * The agent iterates until `done` (every goal satisfied, nothing dangling) or
 * `blockedOnHuman` (only human-owned work remains). Budgets bound the loop;
 * human tasks carry a default-on-expiry, so the agent never waits on a human.
 */

import type { AgentEvent } from '@/types/generation';
import type { EverflowEvaluation, EverflowGraph, HumanTask, IdeaGraphState } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { env } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { evaluateEverflow } from './evaluate';
import { materializeGraph } from './materialize';
import { planAutoResearch, researchNode } from './research';
import { expansionMove, type ExpansionModel } from './decompose';
import { testLadderMove } from './test-ladder';
import { reviewerMove, type ReviewerInput } from './reviewer';
import { swarmMove } from './swarm';
import { getCatalog } from '@/modules/components';
import type { ResearchFinding } from '@/types/everflow';

/* ------------------------------------------------------------------------- */
/* Store — the only persistence seam (tests pass an in-memory implementation) */
/* ------------------------------------------------------------------------- */

export interface EverflowStore {
  getState(id: string): Promise<ProjectState | null>;
  save(id: string, patch: Record<string, unknown>): Promise<ProjectState | null>;
  appendEvent(id: string, event: Omit<AgentEvent, 'seq'> & { seq?: number }): Promise<void>;
}

function eventSeq(state: ProjectState | null): number {
  return state?.events.reduce((max, event) => Math.max(max, event.seq), 0) ?? 0;
}

/* ------------------------------------------------------------------------- */
/* Planner — pure, deterministic, offline-testable                            */
/* ------------------------------------------------------------------------- */

export interface PlanResult {
  /** ai→human tasks to file this pass. */
  newTasks: HumanTask[];
  /** human→ai task ids the agent now claims (status → `processed`). */
  processedInjections: string[];
  /** follow-up asks filed for processed additions. */
  followUps: HumanTask[];
  description: string[];
}

export const EVERFLOW_DEFAULT_MAX_HUMAN_TASKS = 12;

function makeTask(partial: Omit<HumanTask, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'response'>, at: string): HumanTask {
  return {
    id: createId('htask'),
    status: 'open',
    response: null,
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}

/**
 * Decide what the agent does on this pass. Pure: same state/evaluation in,
 * same plan out. Idempotent per open task — a goal with an open task linked
 * never gets a duplicate filed.
 */
export function planContinuation(state: ProjectState, graph: EverflowGraph, evaluation: EverflowEvaluation, maxHumanTasks = EVERFLOW_DEFAULT_MAX_HUMAN_TASKS): PlanResult {
  const at = nowIso();
  const result: PlanResult = { newTasks: [], processedInjections: [], followUps: [], description: [] };

  if (evaluation.done) {
    result.description.push('All goals satisfied and nothing dangling — the project is done.');
    return result;
  }

  const openAiTasks = state.humanTasks.filter((task) => task.direction === 'ai_to_human' && task.status === 'open');
  const linkedBy = (nodeId: string): HumanTask | undefined =>
    openAiTasks.find((task) => task.linkedNodeIds.includes(nodeId));

  const fileTask = (task: HumanTask): void => {
    if (state.humanTasks.length + result.newTasks.length + result.followUps.length >= maxHumanTasks) {
      result.description.push(`Task budget (${maxHumanTasks}) reached — "${task.title}" stays parked without a filed ask.`);
      return;
    }
    result.newTasks.push(task);
    result.description.push(`Filed AI→human ${task.type} ask: "${task.title}".`);
  };

  /* 1. Behavioural goals the evaluator could not prove → human verification. */
  for (const outcome of evaluation.results) {
    const node = graph.nodes.find((candidate) => candidate.id === outcome.nodeId);
    if (!node || node.kind !== 'goal' || node.goal.kind !== 'behaviour_proven') continue;
    if (outcome.satisfied) continue;
    if (linkedBy(node.id)) continue;
    fileTask(
      makeTask(
        {
          direction: 'ai_to_human',
          type: 'verify',
          title: `Confirm: ${node.label}`,
          body: `The evaluator cannot prove this from the source alone. Run the project in the simulator (or on the bench) and tell me whether it holds.`,
          asks: { shape: 'boolean', options: ['Yes, it works', 'No, it does not'], positiveOptions: ['Yes, it works'] },
          linkedNodeIds: [node.id],
          lookAt: { kind: 'sim', ref: `/project/${state.id}/simulation`, label: 'Open the simulator' },
          priority: 'medium',
          defaultOnExpiry: 'defer',
          assumptionIfSkipped: `Unverified: ${node.content} — assumed on paper only.`,
          source: 'ai',
        },
        at,
      ),
    );
  }

  /* 2. Unconfirmed assumptions → one consolidated confirmation ask. */
  const openAssumptions = evaluation.results.filter((outcome) => outcome.kind === 'assumption' && !outcome.satisfied);
  if (openAssumptions.length > 0 && !state.humanTasks.some((task) => task.status === 'open' && task.direction === 'ai_to_human' && task.type === 'context' && task.linkedNodeIds.some((id) => id.startsWith('ev-assume-')))) {
    const linked = openAssumptions.slice(0, 3).map((outcome) => outcome.nodeId);
    fileTask(
      makeTask(
        {
          direction: 'ai_to_human',
          type: 'context',
          title: `Confirm or correct ${openAssumptions.length} assumption(s)`,
          body: openAssumptions.slice(0, 3).map((outcome) => `• ${graph.nodes.find((node) => node.id === outcome.nodeId)?.content}`).join('\n') + (openAssumptions.length > 3 ? `\n• …and ${openAssumptions.length - 3} more` : ''),
          asks: { shape: 'text', positiveOptions: ['Confirmed, as-is', 'Confirmed'] },
          linkedNodeIds: linked,
          lookAt: { kind: 'project', ref: `/project/${state.id}/everflow`, label: 'See the graph' },
          priority: 'high',
          defaultOnExpiry: 'assume',
          assumptionIfSkipped: 'Assumptions stand as recorded; revisit them from the Everflow tab.',
          source: 'ai',
        },
        at,
      ),
    );
  }

  /* 3. Blocking validation issues the fixer could not repair → review ask. */
  const validationErrors = state.validation?.summary.errors ?? 0;
  if (validationErrors > 0 && !state.humanTasks.some((task) => task.status === 'open' && task.direction === 'ai_to_human' && task.type === 'review')) {
    fileTask(
      makeTask(
        {
          direction: 'ai_to_human',
          type: 'review',
          title: `${validationErrors} blocking issue(s) survived the fix loop`,
          body: 'I repaired what I could deterministically; the rest needs a design call. Look at the issues and tell me which to accept, drop or change.',
          asks: { shape: 'text', positiveOptions: ['Accept as-is', 'Accepted'] },
          linkedNodeIds: ['ev-goal-validation'],
          lookAt: { kind: 'quality', ref: `/project/${state.id}/quality`, label: 'Open Check & fix' },
          priority: 'high',
          defaultOnExpiry: 'halt',
          assumptionIfSkipped: 'Design call pending — the project stays flagged completed_with_errors.',
          source: 'ai',
        },
        at,
      ),
    );
  }

  /* 4. Human → AI additions waiting for the agent. */
  for (const task of state.humanTasks) {
    if (task.direction !== 'human_to_ai' || task.status !== 'open') continue;
    result.processedInjections.push(task.id);
    result.description.push(`Registered your addition: "${task.title}".`);
    if (task.type === 'idea' || task.type === 'correction' || task.type === 'resource' || task.type === 'steer') {
      const apply = makeTask(
        {
          direction: 'ai_to_human',
          type: 'choose',
          title: `Apply “${task.title.slice(0, 60)}” to the build?`,
          body: `You added: ${task.response?.value ?? task.body}\n\nApplying it re-runs the pipeline as a new revision (your current design is preserved as a diff).`,
          asks: { shape: 'choice', options: ['Apply — replan as a new revision', 'Note only, keep the current design'] },
          linkedNodeIds: [task.linkedNodeIds[0] ?? 'ev-intent'],
          lookAt: { kind: 'project', ref: `/project/${state.id}/everflow`, label: 'See the addition' },
          priority: 'high',
          defaultOnExpiry: 'defer',
          assumptionIfSkipped: 'Held as a note; nothing was changed in the design.',
          source: 'ai',
        },
        at,
      );
      result.followUps.push(apply);
      result.description.push(`Filed follow-up: apply “${task.title.slice(0, 40)}” to the build?`);
    }
  }

  return result;
}

/* ------------------------------------------------------------------------- */
/* Pass runner                                                                */
/* ------------------------------------------------------------------------- */

export interface EverflowPassResult {
  state: ProjectState;
  graph: EverflowGraph;
  evaluation: EverflowEvaluation;
  plan: PlanResult;
  /** False when no further pass would change anything. */
  progressed: boolean;
}

export interface EverflowPassOptions {
  maxHumanTasks?: number;
  /**
   * Idea-graph move wiring (runs when WIREUP_ENABLE_IDEA_GRAPH, default on).
   * Tests inject a canned model here; production lazily wires Bedrock only
   * when a model id is configured — so offline runs never touch the SDK.
   */
  ideaGraph?: {
    enabled?: boolean;
    model?: ExpansionModel;
    maxExpansions?: number;
    /** Injected fresh-context reviewer (tests); production wires Bedrock lazily. */
    reviewerModel?: { review(input: ReviewerInput): Promise<{ verdict: string; findings: unknown[]; question?: string } | null | 'unavailable'> } | null;
  };
}

/** Lazily wire the Bedrock-backed model (this keeps the AWS SDK out of offline runs). */
async function productionExpansionModel(): Promise<ExpansionModel | null> {
  if (!env().bedrock.modelId) return null;
  try {
    const { bedrockExpansionModel } = await import('./expansion-model');
    return bedrockExpansionModel();
  } catch {
    return null;
  }
}

/**
 * Run one continuation pass against the store. Safe to call repeatedly; each
 * pass is small and idempotent, so the loop below stops as soon as it makes
 * no progress. When the idea graph is enabled, the pass also carries ONE
 * idea-graph move (skeleton / expansion / stop decision) — same persistence,
 * same events, same bounded budget.
 */
export async function runEverflowPass(projectId: string, trigger: string, store: EverflowStore, maxHumanTasksOrOptions: number | EverflowPassOptions = EVERFLOW_DEFAULT_MAX_HUMAN_TASKS): Promise<EverflowPassResult | null> {
  const options: EverflowPassOptions = typeof maxHumanTasksOrOptions === 'number' ? { maxHumanTasks: maxHumanTasksOrOptions } : maxHumanTasksOrOptions;
  const maxHumanTasks = options.maxHumanTasks ?? EVERFLOW_DEFAULT_MAX_HUMAN_TASKS;
  const state = await store.getState(projectId);
  if (!state) return null;

  const pass = state.everflow?.pass ?? 0;
  let graph = materializeGraph(state);
  let evaluation = evaluateEverflow(state, graph, pass + 1);
  const plan = planContinuation(state, graph, evaluation, maxHumanTasks);

  /* --- the idea-graph move (one per pass, flag-gated) ---------------------- */
  let ideaGraph: IdeaGraphState | null = state.ideaGraph ?? null;
  /** Raw move events (seq assigned once, in order, below). */
  const rawIdeaEvents: { type: AgentEvent['type']; status: AgentEvent['status']; message: string; metadata: Record<string, unknown> }[] = [];
  /** The same events, sequenced and ready to append to the store. */
  const ideaEvents: (AgentEvent & { seq?: number })[] = [];
  let ideaTasks: HumanTask[] = [];
  let ideaMoved = false;
  /** The ladder may repair artifacts — the pass then persists THAT state. */
  let passState: ProjectState = state;
  const ideaEnabled = options.ideaGraph?.enabled ?? env().agent.ideaGraphEnabled;
  if (ideaEnabled) {
    const at = nowIso();
    const model = options.ideaGraph?.model ?? (await productionExpansionModel());
    const makeIdeaTask = (task: {
      type: 'review' | 'verify' | 'choose';
      title: string;
      body: string;
      linkedNodeId: string;
      defaultOnExpiry: 'defer' | 'assume' | 'halt';
      assumptionIfSkipped: string;
      shape: 'text' | 'boolean' | 'choice';
      options?: string[];
      positiveOptions?: string[];
    }): HumanTask =>
      makeTask(
        {
          direction: 'ai_to_human',
          type: task.type,
          title: task.title,
          body: task.body,
          asks: { shape: task.shape, ...(task.options ? { options: task.options } : {}), ...(task.positiveOptions ? { positiveOptions: task.positiveOptions } : {}) },
          linkedNodeIds: [task.linkedNodeId],
          lookAt: { kind: 'project', ref: `/project/${projectId}/everflow`, label: 'See the idea graph' },
          priority: task.type === 'choose' ? 'high' : 'medium',
          defaultOnExpiry: task.defaultOnExpiry,
          assumptionIfSkipped: task.assumptionIfSkipped,
          source: 'ai',
        },
        at,
      );

    const move = await expansionMove(state, {
      maxExpansions: options.ideaGraph?.maxExpansions ?? env().agent.ideaGraphMaxExpansions,
      ...(model ? { model } : {}),
    });
    if (move.moved) {
      ideaMoved = true;
      ideaGraph = move.ideaGraph;
      rawIdeaEvents.push(...move.events);
      ideaTasks.push(...move.newTasks.map((task) => makeIdeaTask({ ...task, shape: 'text', positiveOptions: ['Accepted as-is', 'Accepted'] })));
    }

    /* Phase hand-over: once the graph finished expanding, the ladder tests
     * every leaf (repair within budget, escalate the stubborn ones). */
    if (ideaGraph && ideaGraph.phase === 'testing') {
      try {
        const catalog = (await getCatalog()).components;
        const ladder = await testLadderMove(state, { catalog, maxRepairs: env().agent.ideaGraphMaxNodeRepairs });
        if (ladder.moved) {
          ideaGraph = ladder.ideaGraph;
          passState = ladder.state;
          ideaMoved = true;
          rawIdeaEvents.push(...ladder.events);
          ideaTasks.push(
            ...ladder.newTasks.map((task) =>
              makeIdeaTask({
                ...task,
                positiveOptions: task.type === 'verify' ? ['Yes, it works'] : ['Accept as a documented limitation'],
              }),
            ),
          );
        }
      } catch (error) {
        // The ladder is best-effort inside the pass; a catalog outage must
        // never fail the whole continuation pass — and is never faked.
        rawIdeaEvents.push({
          type: 'idea_graph_test',
          status: 'failed',
          message: `Ladder could not run (${error instanceof Error ? error.message : 'unknown'}) — the graph stays as-is; nothing was faked.`,
          metadata: { kind: 'idea_graph.test', error: true },
        });
        ideaMoved = true;
      }
    }

    /* Phase hand-over: the reviewer passed → the swarm owns the subtrees
     * (sequential, graph-only communication). */
    if (ideaGraph && ideaGraph.phase === 'swarming') {
      try {
        const swarm = swarmMove(passState);
        if (swarm.moved) {
          ideaGraph = swarm.ideaGraph;
          ideaMoved = true;
          rawIdeaEvents.push(...swarm.events);
        }
      } catch (error) {
        rawIdeaEvents.push({
          type: 'idea_graph_swarm',
          status: 'info',
          message: `Swarm move failed (${error instanceof Error ? error.message : 'unknown'}) — assignments unchanged.`,
          metadata: { kind: 'idea_graph.swarm', error: true },
        });
        ideaMoved = true;
      }
    }

    /* Phase hand-over: every leaf tested and no verdict yet → the
     * fresh-context reviewer runs ONCE (it never edits). */
    if (ideaGraph && ideaGraph.phase === 'reviewing' && !ideaGraph.reviewer) {
      try {
        const review = await reviewerMove(passState, options.ideaGraph?.reviewerModel ?? null);
        ideaGraph = review.ideaGraph;
        ideaMoved = true;
        rawIdeaEvents.push(...review.events);
        ideaTasks.push(...review.newTasks.map((task) => makeIdeaTask({ ...task, shape: 'text', positiveOptions: ['Accepted as-is', 'Accepted'] })));
      } catch (error) {
        rawIdeaEvents.push({
          type: 'idea_graph_review',
          status: 'failed',
          message: `Reviewer could not run (${error instanceof Error ? error.message : 'unknown'}) — no verdict was invented.`,
          metadata: { kind: 'idea_graph.review', error: true },
        });
        ideaMoved = true;
      }
    }

    if (ideaMoved) {
      const baseSeq = state.events.reduce((max, event) => Math.max(max, event.seq), 0);
      rawIdeaEvents.forEach((event, index) => {
        ideaEvents.push({
          seq: baseSeq + 1 + index,
          id: createId('evt'),
          type: event.type,
          status: event.status,
          message: event.message,
          timestamp: at,
          stage: 'completed',
          metadata: event.metadata,
        });
      });
    }
  }

  // The agent checks its low-confidence claims/decisions against the docs —
  // offline sources (catalog + corpus); the live web stays a deliberate act.
  const findings: ResearchFinding[] = [];
  for (const pick of planAutoResearch(passState, graph, 2)) {
    const finding = await researchNode({ state: passState, node: pick.node });
    if (finding) findings.push(finding);
  }
  const research = findings.length > 0 ? [...passState.research, ...findings] : passState.research;

  const humanTasks = [...passState.humanTasks, ...plan.newTasks, ...plan.followUps, ...ideaTasks].map((task) =>
    plan.processedInjections.includes(task.id) ? { ...task, status: 'processed' as const, updatedAt: nowIso() } : task,
  );

  let next: ProjectState = {
    ...passState,
    humanTasks,
    research,
    everflow: { graph, evaluation, pass: pass + 1 },
    ...(ideaMoved && ideaGraph ? { ideaGraph } : {}),
  };
  if (findings.length > 0 || ideaMoved) {
    // Re-project: new evidence/idea nodes join the graph and the brief.
    graph = materializeGraph(next);
    evaluation = evaluateEverflow(next, graph, pass + 1);
    next = { ...next, everflow: { graph, evaluation, pass: pass + 1 } };
  }

  const saved = await store.save(projectId, {
    ...next,
    humanTasks,
    ...(findings.length > 0 ? { research } : {}),
    everflow: next.everflow,
    ...(ideaMoved && ideaGraph ? { ideaGraph } : {}),
  });
  const finalState = saved ?? next;

  for (const event of ideaEvents) {
    await store.appendEvent(projectId, event);
  }

  const progressed = plan.newTasks.length + plan.followUps.length + plan.processedInjections.length + findings.length + (ideaMoved ? 1 : 0) > 0;
  const pct = Math.round(evaluation.completion * 100);

  await store.appendEvent(projectId, {
    id: createId('evt'),
    type: 'everflow_pass',
    status: 'info',
    message:
      evaluation.done
        ? `Everflow pass ${pass + 1} (${trigger}): every goal satisfied — the project is complete.`
        : `Everflow pass ${pass + 1} (${trigger}): ${pct}% complete, ${evaluation.totals.openEnds} dangling, ${plan.newTasks.length + plan.followUps.length + ideaTasks.length} ask(s) filed${ideaMoved ? ', idea graph advanced' : ''}${findings.length > 0 ? `, ${findings.length} doc check(s) recorded` : ''}.`,
    timestamp: nowIso(),
    stage: 'completed',
    metadata: {
      trigger,
      pass: pass + 1,
      completion: pct,
      done: evaluation.done,
      blockedOnHuman: evaluation.blockedOnHuman,
      openEnds: evaluation.totals.openEnds,
      tasksFiled: plan.newTasks.length + plan.followUps.length + ideaTasks.length,
      docsChecked: findings.length,
      injectionsProcessed: plan.processedInjections.length,
      ideaGraphMoved: ideaMoved,
      ...(ideaGraph ? { ideaGraphExpansions: ideaGraph.expansions, ideaGraphPhase: ideaGraph.phase } : {}),
    },
  });

  return { state: finalState, graph, evaluation, plan, progressed };
}

/**
 * Iterate passes until the project is done, blocked only on humans, or no
 * pass makes progress. Bounded by `maxPasses` so a looping state can never
 * spin the server.
 */
export async function continueEverflow(
  projectId: string,
  trigger: string,
  store: EverflowStore,
  options: { maxPasses?: number; maxHumanTasks?: number; ideaGraph?: EverflowPassOptions['ideaGraph'] } = {},
): Promise<EverflowPassResult | null> {
  const maxPasses = options.maxPasses ?? 3;
  let last: EverflowPassResult | null = null;
  for (let i = 0; i < maxPasses; i += 1) {
    const result = await runEverflowPass(projectId, trigger, store, {
      maxHumanTasks: options.maxHumanTasks,
      ...(options.ideaGraph ? { ideaGraph: options.ideaGraph } : {}),
    });
    if (!result) break;
    last = result;
    if (result.evaluation.done) break;
    if (!result.progressed) break;
    if (result.evaluation.blockedOnHuman && result.plan.newTasks.length === 0 && result.plan.followUps.length === 0) break;
  }
  return last;
}

/** MongoDB-backed store (the only production implementation). */
export function mongoEverflowStore(): EverflowStore {
  return {
    async getState(id) {
      return getProjectState(id);
    },
    async save(id, patch) {
      return saveProjectState(id, patch);
    },
    async appendEvent(id, event) {
      if (!('seq' in event && event.seq)) {
        const current = await getProjectState(id);
        event = { ...event, seq: eventSeq(current) + 1 };
      }
      await appendEvents(id, [event as AgentEvent]);
    },
  };
}
