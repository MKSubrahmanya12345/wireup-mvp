'use client';

/**
 * RIGHT PANE + shell — the VS Code style project workspace.
 *
 * Layout: the live agent console on the left, staged result cards on the right,
 * in the canonical order PROJECT → COMPONENTS → WIRING → CODE → DIAGRAM →
 * INSTRUCTIONS → VALIDATION → AGENT. Cards render as soon as their artifact
 * exists (staged delivery) and show a loader tied to the real current stage
 * while they do not.
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';

import type { AgentEvent } from '@/types/generation';
import type { GenerationStage, ProjectState } from '@/types/project';

import { useProjectStream } from './useProjectStream';
import { Notice, StatusBadge } from './ui';
import { AgentConsole } from './AgentConsole';
import { AgentCard } from './cards/AgentCard';
import { CodeCard } from './cards/CodeCard';
import { ComponentsCard } from './cards/ComponentsCard';
import { DiagramCard } from './cards/DiagramCard';
import { InstructionsCard } from './cards/InstructionsCard';
import { ProjectCard } from './cards/ProjectCard';
import { ValidationCard } from './cards/ValidationCard';
import { WiringCard } from './cards/WiringCard';
import { relativeTime } from './cards/types';

const STAGE_ORDER: { stage: GenerationStage; label: string }[] = [
  { stage: 'understanding', label: 'understanding' },
  { stage: 'catalog', label: 'catalog' },
  { stage: 'generating', label: 'generation' },
  { stage: 'hardware', label: 'hardware' },
  { stage: 'pins', label: 'pins' },
  { stage: 'wiring', label: 'wiring' },
  { stage: 'software', label: 'software' },
  { stage: 'code', label: 'code' },
  { stage: 'libraries', label: 'libraries' },
  { stage: 'diagram', label: 'diagram' },
  { stage: 'instructions', label: 'instructions' },
  { stage: 'validating', label: 'validation' },
  { stage: 'fixing', label: 'fix' },
];

/** Stages each result card is waiting on — used for its loader detail line. */
const CARD_STAGES: Record<string, GenerationStage[]> = {
  project: ['understanding', 'generating'],
  components: ['catalog', 'generating', 'hardware'],
  wiring: ['hardware', 'pins', 'wiring'],
  code: ['software', 'code'],
  diagram: ['diagram'],
  instructions: ['instructions'],
  validation: ['validating'],
  agent: ['fixing'],
};

function useActivityHint(events: AgentEvent[]) {
  return useCallback(
    (stages: GenerationStage[]): string | undefined => {
      let hint: string | undefined;
      for (const event of events) {
        if (!event.stage || !stages.includes(event.stage)) continue;
        if (event.status === 'failed') {
          hint = `failed: ${event.message}`;
          continue;
        }
        hint = event.message;
      }
      return hint;
    },
    [events],
  );
}

export function ProjectWorkspace({ initial }: { initial: ProjectState }) {
  const { project, events, stage, revision, terminal, polledAt, lastEventAt, error, refresh } = useProjectStream(initial.id, initial);
  const hint = useActivityHint(events);
  const [manual, setManual] = useState(0);

  const running = !terminal;

  const onRefresh = () => {
    refresh();
    setManual((current) => current + 1);
  };

  const currentStageIndex = useMemo(() => {
    const index = STAGE_ORDER.findIndex((entry) => entry.stage === stage);
    return index < 0 ? STAGE_ORDER.length - 1 : index;
  }, [stage]);

  const cardPropsBase = { project, running };

  return (
    <div>
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">⌁</span>
          <span className="topbar__title">Wireup</span>
        </Link>

        <span className="topbar__meta">
          <strong>{project?.name}</strong>
          <span className="faint mono-sm">{project?.id}</span>
        </span>

        <span className="topbar__spacer" />

        <span className="topbar__meta">
          <StatusBadge status={project?.status ?? 'pending'} />
          <span>v{revision ?? 0}</span>
          <span className="faint mono-sm">
            iteration {project?.iteration.current ?? 0}/{project?.iteration.max ?? 0}
          </span>
          <span className="faint mono-sm">
            {lastEventAt
              ? `last event ${relativeTime(lastEventAt)}`
              : project?.updatedAt
                ? `updated ${relativeTime(project.updatedAt)}`
                : ''}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh} disabled={terminal}>
            {terminal ? 'run finished' : manual > 0 ? 'polling…' : 'refresh now'}
          </button>
          <Link href="/" className="btn btn--ghost btn--sm">
            new project
          </Link>
        </span>
      </header>

      <div className="workspace">
        <AgentConsole events={events} running={running} stage={stage} pollError={error} polledAt={polledAt} />

        <div className="pane pane--detail">
          <div className="pane__head">
            <strong>results</strong>
            <span className="card__spacer" style={{ flex: 1 }} />
            <span>
              {events.length} events · {terminal ? 'complete' : 'streaming'}
            </span>
          </div>

          <div className="pane__head pane__head--chips">
            {STAGE_ORDER.map((entry, index) => (
              <span
                key={entry.stage}
                className={`chip ${index === currentStageIndex ? 'chip--dark' : ''}`}
                style={{ opacity: index <= currentStageIndex ? 1 : 0.4 }}
                title={index < currentStageIndex ? `${entry.stage}: done` : index === currentStageIndex ? `${entry.stage}: current` : `${entry.stage}: pending`}
              >
                {entry.label}
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <span className="faint mono-sm">
              {polledAt ? `polled ${new Date(polledAt).toLocaleTimeString(undefined, { hour12: false })}` : 'connecting…'}
            </span>
          </div>

          <div className="pane__body">
            {project?.error ? (
              <Notice tone="err" title={`Generation failed at stage "${project.error.stage}" (${project.error.code})`}>
                <div className="notice__body">{project.error.message}</div>
                {project.error.details ? <pre className="console__raw">{project.error.details}</pre> : null}
                {project.error.retryable ? (
                  <div className="small" style={{ marginTop: 4 }}>
                    The failure was retryable — resubmit the same prompt to start a fresh project.
                  </div>
                ) : null}
              </Notice>
            ) : null}

            <div className="detail__grid">
              <ProjectCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.project)} />
              <ComponentsCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.components)} />
              <WiringCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.wiring)} />
              <CodeCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.code)} />
              <DiagramCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.diagram)} />
              <InstructionsCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.instructions)} />
              <ValidationCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.validation)} />
              <AgentCard {...cardPropsBase} stage={stage} activity={hint(CARD_STAGES.agent)} events={events} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
