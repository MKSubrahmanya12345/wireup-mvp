/**
 * Client-side data layer for the workspace.
 *
 * Every call goes through the API envelope (`{ ok, data }` / `{ ok, error }`)
 * and relative URLs only, so the UI works behind any proxy/host.
 */

import type { AgentEvent } from '@/types/generation';
import type { ProjectState } from '@/types/project';

export interface ApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: string; retryable?: boolean };
}

export interface EventsPayload {
  events: AgentEvent[];
  latestSeq: number;
  status: ProjectState['status'];
  stage: ProjectState['stage'];
  revision: number;
  running: boolean;
  terminal: boolean;
}

export interface ProjectPayload {
  project: ProjectState;
  running: boolean;
}

export interface DiagramPayload {
  target: 'wireup' | 'wokwi';
  projectId: string;
  revision: number;
  diagram: unknown;
  skippedParts?: { id: string; ref: string; reason: string }[];
  skippedConnections?: { id: string; reason: string }[];
  warnings?: string[];
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: string;

  constructor(message: string, code = 'api_error', status = 0, details?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok || payload.data === undefined) {
    const message = payload?.error?.message ?? `Request failed with status ${response.status}.`;
    throw new ApiError(message, payload?.error?.code ?? 'api_error', response.status, payload?.error?.details);
  }
  return payload.data;
}

export async function fetchProject(id: string): Promise<ProjectPayload> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { cache: 'no-store' });
  return unwrap<ProjectPayload>(response);
}

export async function fetchEvents(id: string, after: number): Promise<EventsPayload> {
  const query = after > 0 ? `?after=${encodeURIComponent(String(after))}` : '';
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/events${query}`, { cache: 'no-store' });
  return unwrap<EventsPayload>(response);
}

export async function fetchDiagram(id: string, target: 'wireup' | 'wokwi'): Promise<DiagramPayload> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/diagram?target=${target}`, { cache: 'no-store' });
  return unwrap<DiagramPayload>(response);
}

export const TERMINAL_STATUSES: ProjectState['status'][] = [
  'completed',
  'completed_with_warnings',
  'completed_with_errors',
  'failed',
];

export function isTerminal(status: ProjectState['status'] | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.includes(status);
}

/** Merge a poll batch into the log, de-duplicating by `seq`. */
export function mergeEvents(existing: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((event) => event.seq));
  const fresh = incoming.filter((event) => !seen.has(event.seq));
  if (fresh.length === 0) return existing;
  return [...existing, ...fresh].sort((a, b) => a.seq - b.seq);
}
