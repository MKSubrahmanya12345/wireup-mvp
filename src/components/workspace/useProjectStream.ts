'use client';

/**
 * Live project stream.
 *
 * Polls `/api/projects/[id]/events?after=<seq>` while the agent runs and
 * refetches the full project whenever a new revision lands or the run reaches a
 * terminal status. Polling backs off on transport errors and stops by itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentEvent } from '@/types/generation';
import type { ProjectState } from '@/types/project';

import { fetchEvents, fetchProject, isTerminal, mergeEvents } from './api';

const BASE_POLL_MS = 1100;
const MAX_POLL_MS = 8000;

export interface ProjectStream {
  project: ProjectState | null;
  events: AgentEvent[];
  status: ProjectState['status'];
  stage: ProjectState['stage'];
  revision: number;
  running: boolean;
  terminal: boolean;
  /** Last successful poll (epoch ms) — used to show the console is alive. */
  polledAt: number | null;
  lastEventAt: string | null;
  error: string | null;
  refresh: () => Promise<void>;
}

function maxSeq(events: AgentEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

export function useProjectStream(projectId: string, initial: ProjectState | null): ProjectStream {
  const [project, setProject] = useState<ProjectState | null>(initial);
  const [events, setEvents] = useState<AgentEvent[]>(initial?.events ?? []);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(
    initial && initial.events.length > 0 ? (initial.events[initial.events.length - 1]?.timestamp ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const seqRef = useRef<number>(maxSeq(initial?.events ?? []));
  const revisionRef = useRef<number>(initial?.revision ?? 1);
  const pollMsRef = useRef<number>(BASE_POLL_MS);
  const doneRef = useRef<boolean>(isTerminal(initial?.status));
  const eventsRef = useRef<AgentEvent[]>(initial?.events ?? []);

  const loadFullProject = useCallback(async (): Promise<void> => {
    const payload = await fetchProject(projectId);
    const next = payload.project;
    setProject(next);
    revisionRef.current = next.revision;
    eventsRef.current = mergeEvents(eventsRef.current, next.events);
    setEvents(eventsRef.current);
    seqRef.current = Math.max(seqRef.current, maxSeq(next.events));
    if (isTerminal(next.status)) doneRef.current = true;
  }, [projectId]);

  const tick = useCallback(async (): Promise<void> => {
    try {
      const payload = await fetchEvents(projectId, seqRef.current);
      seqRef.current = Math.max(seqRef.current, payload.latestSeq);
      setPolledAt(Date.now());
      setError(null);
      pollMsRef.current = BASE_POLL_MS;

      if (payload.events.length > 0) {
        eventsRef.current = mergeEvents(eventsRef.current, payload.events);
        setEvents(eventsRef.current);
        setLastEventAt(payload.events[payload.events.length - 1]?.timestamp ?? null);
      }

      const revisionMoved = payload.revision !== revisionRef.current;
      revisionRef.current = payload.revision;

      if (revisionMoved || payload.terminal) {
        await loadFullProject();
      } else {
        setProject((current) =>
          current
            ? { ...current, status: payload.status, stage: payload.stage, revision: payload.revision }
            : current,
        );
      }

      if (payload.terminal) doneRef.current = true;
    } catch (streamError) {
      const message = streamError instanceof Error ? streamError.message : String(streamError);
      setError(message);
      pollMsRef.current = Math.min(MAX_POLL_MS, Math.round(pollMsRef.current * 1.7));
      // A 404 means the project vanished (e.g. database reset) — stop polling.
      if (/does not exist/i.test(message)) doneRef.current = true;
    }
  }, [loadFullProject, projectId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async (): Promise<void> => {
      while (!cancelled && !doneRef.current) {
        await tick();
        if (cancelled || doneRef.current) break;
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, pollMsRef.current);
        });
      }
    };

    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick, reloadKey]);

  const refresh = useCallback(async (): Promise<void> => {
    doneRef.current = false;
    pollMsRef.current = BASE_POLL_MS;
    try {
      await loadFullProject();
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
    setReloadKey((key) => key + 1);
  }, [loadFullProject]);

  const status = project?.status ?? 'pending';
  const stage = project?.stage ?? 'idle';

  return {
    project,
    events,
    status,
    stage,
    revision: project?.revision ?? 1,
    running: !isTerminal(status),
    terminal: isTerminal(status),
    polledAt,
    lastEventAt,
    error,
    refresh,
  };
}
