/**
 * Project repository — the only place that reads/writes project documents.
 *
 * Every persistence call returns the freshly serialised `ProjectState`, so the
 * orchestrator never has to guess what is on disk.
 */

import type { Types } from 'mongoose';

import { getProjectModel, type ProjectDocument } from '@/models/Project';
import type { AgentEvent } from '@/types/generation';
import type { ExpandedBrief, EverflowState, HumanTask, ProjectDoubt, ResearchFinding } from '@/types/everflow';
import type { ChatMessage, ProjectArtifacts, ProjectState, ProjectStatus } from '@/types/project';

import { createLogger, describeError } from '@/lib/logging/logger';
import { connectMongo } from '@/lib/mongodb/client';
import { env } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import {
  memoryAppendEvents,
  memoryCreateProject,
  memoryDeleteProject,
  memoryGetProject,
  memoryListProjects,
  memorySaveProject,
} from '@/lib/store/memory';

const logger = createLogger('mongodb:projects');

/** True when the process should serve projects from the in-memory store. */
function useMemoryStore(): boolean {
  return env().store.mode === 'memory';
}

export type ProjectPatch = Partial<Omit<ProjectDocument, '_id' | 'createdAt' | 'updatedAt'>>;

type RawProject = Partial<ProjectDocument> & { _id?: Types.ObjectId | string };

const EMPTY_ARTIFACTS: ProjectArtifacts = {
  code: null,
  diagram: null,
  libraries: null,
  instructions: null,
};

const EMPTY_EVERFLOW: EverflowState = { graph: null, evaluation: null, pass: 0 };

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Convert a Mongo document into the API/frontend DTO. */
export function serializeProject(raw: RawProject): ProjectState {
  const id = typeof raw._id === 'string' ? raw._id : (raw._id?.toString() ?? 'unknown');

  return {
    id,
    name: raw.name ?? 'Untitled project',
    prompt: raw.prompt ?? '',
    status: (raw.status ?? 'pending') as ProjectStatus,
    stage: raw.stage ?? 'idle',
    createdAt: iso(raw.createdAt) ?? nowIso(),
    updatedAt: iso(raw.updatedAt) ?? nowIso(),
    completedAt: iso(raw.completedAt),
    error: raw.error ?? null,
    requirements: raw.requirements ?? null,
    components: Array.isArray(raw.components) ? raw.components : [],
    hardwarePlan: raw.hardwarePlan ?? null,
    pinAssignments: Array.isArray(raw.pinAssignments) ? raw.pinAssignments : [],
    wiring: raw.wiring ?? null,
    softwarePlan: raw.softwarePlan ?? null,
    artifacts: { ...EMPTY_ARTIFACTS, ...(raw.artifacts ?? {}) },
    validation: raw.validation ?? null,
    revisions: Array.isArray(raw.revisions) ? raw.revisions : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    iteration: raw.iteration ?? { current: 0, max: env().agent.maxFixIterations },
    llm: {
      model: raw.llm?.model,
      validationModel: raw.llm?.validationModel,
      calls: Array.isArray(raw.llm?.calls) ? (raw.llm?.calls ?? []) : [],
    },
    chat: Array.isArray(raw.chat) ? (raw.chat as ChatMessage[]) : [],
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    doubts: Array.isArray(raw.doubts) ? (raw.doubts as ProjectDoubt[]) : [],
    humanTasks: Array.isArray(raw.humanTasks) ? (raw.humanTasks as HumanTask[]) : [],
    everflow: { ...EMPTY_EVERFLOW, ...(raw.everflow ?? {}) },
    intakeContext: typeof raw.intakeContext === 'string' ? raw.intakeContext : null,
    expandedBrief: (raw.expandedBrief as ExpandedBrief | null) ?? null,
    research: Array.isArray(raw.research) ? (raw.research as ResearchFinding[]) : [],
    ideaGraph: (raw.ideaGraph as ProjectState['ideaGraph']) ?? null,
  };
}

export interface CreateProjectInput {
  prompt: string;
  name?: string;
  maxIterations?: number;
  /** Replaces the default "generation queued" first event message (used by the in-memory store to state its mode). */
  notice?: string;
  /** Extra metadata on the first event (e.g. `{ store: 'memory' }`). */
  eventMetadata?: Record<string, unknown>;
}

/**
 * Create a brand new project document. Nothing is ever reused or cached: each
 * call inserts a fresh document with its own event log starting at seq 1.
 */
export async function createProjectRecord(input: CreateProjectInput): Promise<ProjectState> {
  const firstEvent: AgentEvent = {
    seq: 1,
    id: createId('evt'),
    type: 'project_created',
    status: 'completed',
    message: input.notice ?? 'Project created — generation queued',
    timestamp: nowIso(),
    stage: 'idle',
    metadata: { promptLength: input.prompt.length, ...(input.eventMetadata ?? {}) },
  };

  if (useMemoryStore()) {
    const memoryNotice =
      input.notice
        ?? 'Project created on the IN-MEMORY store — MONGODB_URI is not configured, so this project lives in this process only and is lost when the server restarts. Set MONGODB_URI in .env for persistent storage.';
    const doc = memoryCreateProject({
      prompt: input.prompt,
      name: input.name ?? 'Untitled project',
      status: 'pending',
      stage: 'idle',
      error: null,
      requirements: null,
      components: [],
      hardwarePlan: null,
      pinAssignments: [],
      wiring: null,
      softwarePlan: null,
      artifacts: EMPTY_ARTIFACTS,
      validation: null,
      revisions: [],
      events: [{ ...firstEvent, message: memoryNotice, metadata: { promptLength: input.prompt.length, store: 'memory' } }],
      iteration: { current: 0, max: input.maxIterations ?? env().agent.maxFixIterations },
      llm: { calls: [] },
      revision: 0,
      doubts: [],
      humanTasks: [],
      everflow: EMPTY_EVERFLOW,
      intakeContext: null,
      expandedBrief: null,
      research: [],
    });
    logger.info('project created (in-memory store)', { id: doc._id });
    return serializeProject(doc as RawProject);
  }

  await connectMongo();
  const Project = getProjectModel();

  const doc = await Project.create({
    prompt: input.prompt,
    name: input.name ?? 'Untitled project',
    status: 'pending',
    stage: 'idle',
    error: null,
    requirements: null,
    components: [],
    hardwarePlan: null,
    pinAssignments: [],
    wiring: null,
    softwarePlan: null,
    artifacts: EMPTY_ARTIFACTS,
    validation: null,
    revisions: [],
    events: [firstEvent],
    iteration: { current: 0, max: input.maxIterations ?? env().agent.maxFixIterations },
    llm: { calls: [] },
    revision: 0,
    doubts: [],
    humanTasks: [],
    everflow: EMPTY_EVERFLOW,
    intakeContext: null,
    expandedBrief: null,
    research: [],
  } satisfies Partial<ProjectDocument>);

  logger.info('project created', { id: doc._id.toString() });
  return serializeProject(doc.toObject() as RawProject);
}

export async function getProjectState(id: string): Promise<ProjectState | null> {
  if (useMemoryStore()) {
    const raw = memoryGetProject(id);
    return raw ? serializeProject(raw as RawProject) : null;
  }
  await connectMongo();
  const Project = getProjectModel();
  const raw = (await Project.findById(id).lean()) as RawProject | null;
  if (!raw) return null;
  return serializeProject(raw);
}

export async function listProjectStates(limit = 25): Promise<ProjectState[]> {
  if (useMemoryStore()) {
    return memoryListProjects(limit).map((raw) => serializeProject(raw as RawProject));
  }
  await connectMongo();
  const Project = getProjectModel();
  const docs = (await Project.find({}).sort({ createdAt: -1 }).limit(limit).lean()) as RawProject[];
  return docs.map(serializeProject);
}

export async function saveProjectState(id: string, patch: ProjectPatch): Promise<ProjectState | null> {
  if (useMemoryStore()) {
    const raw = memorySaveProject(id, patch as Record<string, unknown>);
    return raw ? serializeProject(raw as RawProject) : null;
  }
  await connectMongo();
  const Project = getProjectModel();
  try {
    const raw = (await Project.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean()) as RawProject | null;
    if (!raw) return null;
    return serializeProject(raw);
  } catch (error) {
    const described = describeError(error);
    logger.error('save failed', { id, error: described.message });
    throw error;
  }
}

/** Append events while enforcing the per-project cap. */
export async function appendEvents(id: string, events: AgentEvent[], cap?: number): Promise<void> {
  if (events.length === 0) return;
  if (useMemoryStore()) {
    memoryAppendEvents(id, events, cap ?? env().agent.maxEvents);
    return;
  }
  await connectMongo();
  const Project = getProjectModel();
  const maxEvents = cap ?? env().agent.maxEvents;

  await Project.updateOne(
    { _id: id },
    {
      $push: { events: { $each: events as unknown[], $slice: -maxEvents } },
      $set: { updatedAt: new Date() },
    },
  );
}

export async function recordLlmCall(
  id: string,
  call: ProjectState['llm']['calls'][number],
): Promise<void> {
  if (useMemoryStore()) {
    const raw = memoryGetProject(id);
    const existing = Array.isArray((raw?.llm as { calls?: unknown[] } | undefined)?.calls)
      ? ((raw!.llm as { calls: unknown[] }).calls as unknown[])
      : [];
    memorySaveProject(id, { llm: { ...(raw?.llm as object | undefined), calls: [...existing, call] } });
    return;
  }
  await connectMongo();
  const Project = getProjectModel();
  await Project.updateOne(
    { _id: id },
    { $push: { 'llm.calls': call as unknown }, $set: { updatedAt: new Date() } },
  );
}

export async function markProjectFailed(
  id: string,
  error: NonNullable<ProjectState['error']>,
): Promise<ProjectState | null> {
  return saveProjectState(id, { status: 'failed', stage: 'failed', error, completedAt: new Date() });
}

/** Projects that died mid-run (process restart) so the UI can explain them. */
export async function findStalledProjects(maxAgeMs = 10 * 60_000): Promise<ProjectState[]> {
  if (useMemoryStore()) {
    const cutoff = Date.now() - maxAgeMs;
    return memoryListProjects(50)
      .filter((raw) => ['pending', 'running', 'validating', 'fixing'].includes(String(raw.status)) && raw.updatedAt.getTime() < cutoff)
      .map((raw) => serializeProject(raw as RawProject));
  }
  await connectMongo();
  const Project = getProjectModel();
  const cutoff = new Date(Date.now() - maxAgeMs);
  const docs = (await Project.find({
    status: { $in: ['pending', 'running', 'validating', 'fixing'] },
    updatedAt: { $lt: cutoff },
  })
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean()) as RawProject[];
  return docs.map(serializeProject);
}

/**
 * Lightweight polling read for the agent console: only the event log plus the
 * few fields the UI needs to decide whether to keep polling.
 */
export async function getProjectEvents(
  id: string,
  after = 0,
): Promise<{
  events: AgentEvent[];
  latestSeq: number;
  status: ProjectStatus;
  stage: ProjectState['stage'];
  revision: number;
  /** Last write, used to detect runs whose owning process disappeared. */
  updatedAt: string;
} | null> {
  if (useMemoryStore()) {
    const raw = memoryGetProject(id);
    if (!raw) return null;
    const events = Array.isArray(raw.events) ? raw.events : [];
    const latestSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
    return {
      events: after > 0 ? events.filter((event) => event.seq > after) : events,
      latestSeq,
      status: raw.status as ProjectStatus,
      stage: raw.stage as ProjectState['stage'],
      revision: typeof raw.revision === 'number' ? raw.revision : 1,
      updatedAt: raw.updatedAt.toISOString(),
    };
  }
  await connectMongo();
  const Project = getProjectModel();
  const raw = (await Project.findById(id)
    .select({ events: 1, status: 1, stage: 1, revision: 1, updatedAt: 1 })
    .lean()) as Pick<ProjectDocument, 'events' | 'status' | 'stage' | 'revision' | 'updatedAt'> | null;
  if (!raw) return null;

  const events = Array.isArray(raw.events) ? raw.events : [];
  const latestSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  return {
    events: after > 0 ? events.filter((event) => event.seq > after) : events,
    latestSeq,
    status: raw.status,
    stage: raw.stage,
    revision: raw.revision ?? 1,
    updatedAt: iso(raw.updatedAt) ?? nowIso(),
  };
}

export async function deleteProject(id: string): Promise<boolean> {
  if (useMemoryStore()) {
    return memoryDeleteProject(id);
  }
  await connectMongo();
  const Project = getProjectModel();
  const result = await Project.deleteOne({ _id: id });
  return result.deletedCount === 1;
}
