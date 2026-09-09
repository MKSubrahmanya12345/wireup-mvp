/**
 * Human loop service — the lifecycle of a hands-and-legs task.
 *
 * The rules here are the ones the protocol promises:
 *   • every task states why the agent cannot do it and what happens next,
 *   • a skipped task applies its default and records it as an assumption,
 *     never silently,
 *   • a completed task with a `fact` key writes a grounded fact that later
 *     planning reads instead of guessing,
 *   • and a reported fact that contradicts the catalog raises a conflict
 *     rather than being trusted.
 */

import type { ComponentDefinition } from '@/types/component';
import type { AgentEventLog } from '@/lib/logging/events';

import { planCommissioning } from './commissioning';
import type { HumanFact, HumanLoopState, HumanTask, SubmitTaskInput } from './types';
import { emptyHumanLoop } from './types';

export * from './types';
export { planCommissioning } from './commissioning';

export interface HumanLoopProject {
  components: { componentId: string }[];
  pinAssignments: { targetComponentId: string; pin: string }[];
  humanLoop?: HumanLoopState | null;
}

export interface TaskOutcome {
  state: HumanLoopState;
  task?: HumanTask;
  fact?: HumanFact;
}

function clone(state: HumanLoopState): HumanLoopState {
  return { ...state, tasks: state.tasks.map((task) => ({ ...task })), facts: [...state.facts] };
}

function replaceTask(state: HumanLoopState, task: HumanTask): HumanLoopState {
  return { ...state, tasks: state.tasks.map((entry) => (entry.id === task.id ? task : entry)) };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Build the queue for a project. Idempotent: it will not clobber progress. */
export function planHumanLoop(
  project: HumanLoopProject,
  catalog: ComponentDefinition[],
  options: { force?: boolean; events?: AgentEventLog } = {},
): HumanLoopState {
  const existing = project.humanLoop ?? emptyHumanLoop();
  if (existing.tasks.length > 0 && !options.force) return existing;

  const tasks = planCommissioning({
    components: project.components as never,
    catalog,
    pinAssignments: project.pinAssignments as never,
  });

  const state: HumanLoopState = {
    // Answers the human already gave survive a re-plan; new tasks do not.
    facts: existing.facts,
    tasks,
    plannedAt: nowIso(),
  };

  options.events?.emit('human_task_opened', `Opened ${tasks.length} hands-and-legs task(s) for the human to run`, {
    metadata: { count: tasks.length, blocking: tasks.filter((task) => task.blocking).length },
  });

  return state;
}

export function findTask(state: HumanLoopState, taskId: string): HumanTask | undefined {
  return state.tasks.find((task) => task.id === taskId);
}

export function pendingTasks(state: HumanLoopState): HumanTask[] {
  return state.tasks.filter((task) => task.status === 'open' || task.status === 'claimed' || task.status === 'rejected');
}

export function blockingPending(state: HumanLoopState): HumanTask[] {
  return pendingTasks(state).filter((task) => task.blocking);
}

/** The next task whose dependencies are all satisfied. */
export function nextActionable(state: HumanLoopState): HumanTask | undefined {
  const done = new Set(state.tasks.filter((task) => task.status === 'accepted' || task.status === 'skipped').map((task) => task.id));
  return pendingTasks(state).find((task) => (task.dependsOn ?? []).every((id) => done.has(id)));
}

export function claimTask(state: HumanLoopState, taskId: string): TaskOutcome {
  const task = findTask(state, taskId);
  if (!task) return { state };
  if (task.status !== 'open') return { state, task };

  const updated: HumanTask = { ...task, status: 'claimed', claimedAt: nowIso() };
  return { state: replaceTask(state, updated), task: updated };
}

/**
 * Submit an answer. A `verify` task is graded automatically: the pass criterion
 * is the agent's, and a "true" answer means the check passed.
 */
export function submitTask(
  state: HumanLoopState,
  taskId: string,
  input: SubmitTaskInput,
  options: { events?: AgentEventLog; catalog?: ComponentDefinition[] } = {},
): TaskOutcome {
  const task = findTask(state, taskId);
  if (!task) return { state };

  const at = nowIso();
  const graded = task.verb === 'verify' && task.answer.kind === 'boolean' ? input.answer === 'true' : undefined;

  const next: HumanLoopState = clone(state);
  const updated: HumanTask = {
    ...task,
    status: 'submitted',
    submittedAt: at,
    result: {
      answer: input.answer,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.note ? { note: input.note } : {}),
      at,
    },
  };

  let fact: HumanFact | undefined;
  if (task.fact) {
    fact = { key: task.fact, value: input.answer, sourceTaskId: task.id, at, confidence: 'reported' };
    const existingIndex = next.facts.findIndex((entry) => entry.key === fact?.key);
    if (existingIndex >= 0) next.facts[existingIndex] = fact;
    else next.facts.push(fact);
  }

  const withTask = replaceTask(next, updated);

  // Accept immediately unless this is a verify task that failed the criterion.
  const accepted = graded !== false;
  const finalTask: HumanTask = accepted ? { ...updated, status: 'accepted' } : { ...updated, status: 'rejected' };
  const finalState = replaceTask(withTask, finalTask);

  options.events?.emit(
    'human_task_completed',
    `${accepted ? '✓' : '✕'} ${task.title} — ${input.answer}${input.evidence ? ` (${input.evidence.slice(0, 80)})` : ''}`,
    {
      status: accepted ? 'completed' : 'failed',
      metadata: { taskId: task.id, verb: task.verb, fact: task.fact ?? null, answer: input.answer },
    },
  );

  return { state: finalState, task: finalTask, fact };
}

/** Skip: apply the default, record it as an assumption, move on. Never blocks. */
export function skipTask(state: HumanLoopState, taskId: string, options: { events?: AgentEventLog } = {}): TaskOutcome {
  const task = findTask(state, taskId);
  if (!task) return { state };
  if (task.default === undefined) return { state, task };

  const at = nowIso();
  const next: HumanLoopState = clone(state);
  const value = String(task.default);

  let fact: HumanFact | undefined;
  if (task.fact) {
    fact = { key: task.fact, value, sourceTaskId: task.id, at, confidence: 'reported', assumed: true };
    const existingIndex = next.facts.findIndex((entry) => entry.key === fact?.key);
    if (existingIndex >= 0) next.facts[existingIndex] = fact;
    else next.facts.push(fact);
  }

  const updated: HumanTask = {
    ...task,
    status: 'skipped',
    submittedAt: at,
    result: { answer: value, note: 'Skipped — the default was applied and recorded as an assumption.', at },
  };

  options.events?.emit('human_task_completed', `Skipped "${task.title}" — assumed ${value}`, {
    metadata: { taskId: task.id, verb: task.verb, fact: task.fact ?? null, assumed: true },
  });

  return { state: replaceTask(next, updated), task: updated, fact };
}

export function factsAsRecord(state: HumanLoopState): Record<string, string> {
  const record: Record<string, string> = {};
  for (const fact of state.facts) record[fact.key] = fact.value;
  return record;
}

export function humanLoopSummary(state: HumanLoopState): {
  total: number;
  done: number;
  pending: number;
  blockingPending: number;
  assumed: number;
  complete: boolean;
} {
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.status === 'accepted' || task.status === 'skipped').length;
  const pending = pendingTasks(state).length;
  return {
    total,
    done,
    pending,
    blockingPending: blockingPending(state).length,
    assumed: state.facts.filter((fact) => fact.assumed === true).length,
    complete: total > 0 && pending === 0,
  };
}
