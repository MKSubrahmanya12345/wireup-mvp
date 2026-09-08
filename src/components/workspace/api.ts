/**
 * Client-side data layer for the workspace.
 *
 * Every call goes through the API envelope (`{ ok, data }` / `{ ok, error }`)
 * and relative URLs only, so the UI works behind any proxy/host.
 */

import type { AgentEvent } from '@/types/generation';
import type { ChatDiff, ChatMessage, ProjectState } from '@/types/project';

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

/* -------------------------------------------------------------------------- */
/* Simulation                                                                 */
/* -------------------------------------------------------------------------- */

export interface SoftwareFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file?: string;
  suggestion?: string;
}

export interface DeviceContract {
  projectName: string;
  controller: string;
  baud: number;
  telemetryPrefix: string;
  telemetryIntervalMs: number;
  metrics: { field: string; label: string; unit: string; kind: 'number' | 'string'; source: string }[];
  commands: { character: string; label: string; meaning: string; builtIn: boolean }[];
  transport: string;
  caveats: string[];
}

export interface SimulationPayload {
  projectId: string;
  projectName: string;
  slug: string;
  revision: number;
  status: ProjectState['status'];
  stage: ProjectState['stage'];
  config: { velxioUrl: string; websiteUrl: string; defaultView: 'simulation' | 'website' };
  velxio: {
    /** The whole .vlx, ready to push onto the canvas. */
    vlx: string;
    name: string;
    boardKind: string | null;
    parts: number;
    wires: number;
    files: string[];
    unsupported: string[];
    warnings: string[];
  } | null;
  software: {
    slug: string;
    devPort: number;
    contract: DeviceContract;
    files: { path: string; bytes: number }[];
    findings: SoftwareFinding[];
    passed: boolean;
    notes: string[];
    generatedAt: string;
    zipUrl: string;
  } | null;
  blocked: { velxio: string | null; software: string | null };
}

export async function fetchSimulation(id: string): Promise<SimulationPayload> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/simulation`, { cache: 'no-store' });
  return unwrap<SimulationPayload>(response);
}

export interface CanvasSyncPayload {
  revision: number;
  summary: string;
  changes: {
    partsFromCanvas: number;
    partsPreserved: number;
    wiresFromCanvas: number;
    wiresPreserved: number;
    wiresDropped: number;
  };
  unmapped: string[];
}

/** Fold a pulled Velxio canvas back into this project's diagram.json. */
export async function syncCanvas(id: string, canvas: unknown): Promise<CanvasSyncPayload> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/simulation/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvas }),
  });
  return unwrap<CanvasSyncPayload>(response);
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

/* -------------------------------------------------------------------------- */
/* Firmware workbench                                                         */
/* -------------------------------------------------------------------------- */


export interface FirmwareTurnPayload {
  /** The assistant reply (with outcome, diff, diagnostics). */
  message: ChatMessage;
  /** The fresh project state, when something was persisted (refused manual edits persist only the transcript). */
  project: ProjectState | null;
  /** Problems to render under the editor (manual saves). */
  diagnostics?: string[];
}

/** One conversational firmware edit turn (model proposes, Wireup roots + compiles). */
export async function sendFirmwareChat(id: string, message: string): Promise<FirmwareTurnPayload> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/firmware`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'chat', message }),
  });
  return unwrap<FirmwareTurnPayload>(response);
}

/** Save a hand edit from the editor. The server gates it (sync + compile) before a revision. */
export async function saveFirmwareFile(id: string, path: string, content: string): Promise<FirmwareTurnPayload> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/firmware`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'manual', path, content }),
  });
  return unwrap<FirmwareTurnPayload>(response);
}

