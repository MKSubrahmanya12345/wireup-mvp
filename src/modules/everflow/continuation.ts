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
import type { EverflowEvaluation, EverflowGraph, HumanTask } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { evaluateEverflow } from './evaluate';
import { materializeGraph } from './materialize';
import { planAutoResearch, researchNode } from './research';
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
    if (task.type === 'idea' || task.type === 'correction' || task.type === 'resource') {
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

/**
 * Run one continuation pass against the store. Safe to call repeatedly; each
 * pass is small and idempotent, so the loop below stops as soon as it makes
 * no progress.
 */
export async function runEverflowPass(projectId: string, trigger: string, store: EverflowStore, maxHumanTasks?: number): Promise<EverflowPassResult | null> {
  const state = await store.getState(projectId);
  if (!state) return null;

  const pass = state.everflow?.pass ?? 0;
  let graph = materializeGraph(state);
  let evaluation = evaluateEverflow(state, graph, pass + 1);
  const plan = planContinuation(state, graph, evaluation, maxHumanTasks);

  // The agent checks its low-confidence claims/decisions against the docs —
  // offline sources (catalog + corpus); the live web stays a deliberate act.
  const findings: ResearchFinding[] = [];
  for (const pick of planAutoResearch(state, graph, 2)) {
    const finding = await researchNode({ state, node: pick.node });
    if (finding) findings.push(finding);
  }
  const research = findings.length > 0 ? [...state.research, ...findings] : state.research;

  const humanTasks = [...state.humanTasks, ...plan.newTasks, ...plan.followUps].map((task) =>
    plan.processedInjections.includes(task.id) ? { ...task, status: 'processed' as const, updatedAt: nowIso() } : task,
  );

  let next: ProjectState = {
    ...state,
    humanTasks,
    research,
    everflow: { graph, evaluation, pass: pass + 1 },
  };
  if (findings.length > 0) {
    // Re-project: the new evidence nodes join the graph and the brief.
    graph = materializeGraph(next);
    evaluation = evaluateEverflow(next, graph, pass + 1);
    next = { ...next, everflow: { graph, evaluation, pass: pass + 1 } };
  }

  const saved = await store.save(projectId, {
    humanTasks,
    ...(findings.length > 0 ? { research } : {}),
    everflow: next.everflow,
  });
  const finalState = saved ?? next;

  const progressed = plan.newTasks.length + plan.followUps.length + plan.processedInjections.length + findings.length > 0;
  const pct = Math.round(evaluation.completion * 100);

  await store.appendEvent(projectId, {
    id: createId('evt'),
    type: 'everflow_pass',
    status: 'info',
    message:
      evaluation.done
        ? `Everflow pass ${pass + 1} (${trigger}): every goal satisfied — the project is complete.`
        : `Everflow pass ${pass + 1} (${trigger}): ${pct}% complete, ${evaluation.totals.openEnds} dangling, ${plan.newTasks.length + plan.followUps.length} ask(s) filed${findings.length > 0 ? `, ${findings.length} doc check(s) recorded` : ''}.`,
    timestamp: nowIso(),
    stage: 'completed',
    metadata: {
      trigger,
      pass: pass + 1,
      completion: pct,
      done: evaluation.done,
      blockedOnHuman: evaluation.blockedOnHuman,
      openEnds: evaluation.totals.openEnds,
      tasksFiled: plan.newTasks.length + plan.followUps.length,
      docsChecked: findings.length,
      injectionsProcessed: plan.processedInjections.length,
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
  options: { maxPasses?: number; maxHumanTasks?: number } = {},
): Promise<EverflowPassResult | null> {
  const maxPasses = options.maxPasses ?? 3;
  let last: EverflowPassResult | null = null;
  for (let i = 0; i < maxPasses; i += 1) {
    const result = await runEverflowPass(projectId, trigger, store, options.maxHumanTasks);
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
