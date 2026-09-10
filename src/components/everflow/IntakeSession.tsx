'use client';

/**
 * THE DOUBT SESSION — phase 0 between the prompt and the pipeline.
 *
 * Left: the growing graph skeleton. Right: the doubt queue. Every question has
 * a decider (you / the agent / the agent with your veto), a consequence and a
 * proposed default. Answering makes facts; skipping records ASSUMPTIONS — a
 * guess the project will keep visible and revisit, never a silent one.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ProjectDoubt } from '@/types/everflow';

import { answerDoubt, buildProject, fetchEverflow, type EverflowPayload } from '@/components/workspace/api';
import { useHub } from '@/components/workspace/hub-context';
import { GraphCanvas } from './GraphCanvas';

function DeciderChip({ decider }: { decider: ProjectDoubt['decider'] }) {
  if (decider === 'human') return <span className="evf-chip evf-chip--you">YOU DECIDE</span>;
  if (decider === 'ai_with_veto') return <span className="evf-chip evf-chip--veto">AGENT DECIDES · FLAG IF WRONG</span>;
  return <span className="evf-chip evf-chip--ai">AGENT DECIDES</span>;
}

function DoubtCard({
  projectId,
  doubt,
  onAnswered,
  busy,
}: {
  projectId: string;
  doubt: ProjectDoubt;
  onAnswered: () => void;
  busy: boolean;
}) {
  const [custom, setCustom] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const send = useCallback(
    async (value: string | null, via: 'human' | 'skipped') => {
      setSubmitting(true);
      try {
        await answerDoubt(projectId, { doubtId: doubt.id, value: value ?? undefined, via });
        onAnswered();
      } catch {
        setSubmitting(false);
      }
    },
    [projectId, doubt, onAnswered],
  );

  const answered = doubt.status !== 'open';

  return (
    <article className={`evf-doubt${answered ? ' evf-doubt--answered' : ''}${doubt.blocking ? ' evf-doubt--blocking' : ''}`}>
      <header className="evf-doubt__head">
        <DeciderChip decider={doubt.decider} />
        {doubt.blocking ? <span className="evf-doubt__flag">gates the build</span> : <span className="evf-doubt__flag evf-doubt__flag--soft">skippable → assumption</span>}
        <span className="evf-doubt__conf" title="Agent confidence in its default">{Math.round(doubt.confidence * 100)}% sure</span>
      </header>
      <h3 className="evf-doubt__question">{doubt.question}</h3>
      <p className="evf-doubt__why">{doubt.consequence}</p>

      {answered ? (
        <p className="evf-doubt__resolved">
          {doubt.answer?.via === 'skipped' ? 'Recorded as assumption: ' : 'Answered: '}
          <strong>{doubt.answer?.value}</strong>
        </p>
      ) : (
        <div className="evf-doubt__actions">
          {doubt.options.map((option) => (
            <button key={option} type="button" className="evf-opt" disabled={submitting || busy} onClick={() => send(option, 'human')}>
              {option}
            </button>
          ))}
          {doubt.options.length === 0 && (
            <input
              className="evf-input"
              placeholder="Type your answer…"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && custom.trim()) void send(custom.trim(), 'human');
              }}
            />
          )}
          {doubt.options.length > 0 && (
            <input
              className="evf-input"
              placeholder="…or type your own"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && custom.trim()) void send(custom.trim(), 'human');
              }}
            />
          )}
          <div className="evf-doubt__foot">
            {custom.trim() ? (
              <button type="button" className="btn btn--sm" disabled={submitting || busy} onClick={() => send(custom.trim(), 'human')}>
                Use this answer
              </button>
            ) : null}
            {doubt.proposedDefault ? (
              <button type="button" className="btn btn--ghost btn--sm" disabled={submitting || busy} onClick={() => send(null, 'skipped')} title="Accept the default as a recorded assumption">
                skip → assume “{doubt.proposedDefault}”
              </button>
            ) : (
              <button type="button" className="btn btn--ghost btn--sm" disabled={submitting || busy} onClick={() => send(null, 'skipped')}>
                skip for now
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

export function IntakeSession() {
  const { project, refresh } = useHub();
  const onProjectChanged = refresh;
  const [everflow, setEverflow] = useState<EverflowPayload | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = project?.id ?? '';

  const refreshSession = useCallback(async () => {
    if (projectId) {
      try {
        const payload = await fetchEverflow(projectId);
        setEverflow(payload);
      } catch {
        /* the graph column is decorative during intake; the doubts are canonical */
      }
    }
    await onProjectChanged();
  }, [projectId, onProjectChanged]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  if (!project) return null;

  const doubts = project.doubts;
  const open = doubts.filter((doubt) => doubt.status === 'open');
  const answered = doubts.length - open.length;

  const build = useCallback(async () => {
    setBuilding(true);
    setError(null);
    try {
      await buildProject(project.id);
      await onProjectChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The build could not be started.');
      setBuilding(false);
    }
  }, [project.id, onProjectChanged]);

  return (
    <section className="evf-intake" aria-label="Doubt session">
      <div className="evf-intake__head">
        <div>
          <p className="evf-eyebrow">doubt session · before we build</p>
          <h2 className="evf-title">
            {doubts.length === 0 ? 'Reading your brief…' : 'Let’s settle the forks first'}
          </h2>
          <p className="evf-sub">
            {doubts.length === 0
              ? 'The agent is sketching the project graph and pulling out the questions worth asking. This takes a few seconds.'
              : `The agent already knows the technical answers — it will record them as decisions. These ${open.length} question(s) need you. Skipping one records an assumption, not a silent guess.`}
          </p>
        </div>
        <div className="evf-intake__meta">
          <span className="evf-progress">
            <span className="evf-progress__bar" style={{ width: `${doubts.length === 0 ? 0 : Math.round((answered / doubts.length) * 100)}%` }} />
          </span>
          <span className="evf-progress__label">
            {answered}/{doubts.length} settled
          </span>
        </div>
      </div>

      {project.expandedBrief ? (
        <div className="evf-brief" aria-label="The brief, expanded">
          <div className="evf-brief__head">
            <h3 className="evf-col-title">The brief, expanded</h3>
            <span className="evf-chip">{project.expandedBrief.source === 'llm' ? 'agent expanded' : 'parsed (no model yet)'}</span>
          </div>
          <p className="evf-brief__goal">{project.expandedBrief.structured.goal}</p>
          <dl className="evf-brief__grid">
            <div>
              <dt>Platform</dt>
              <dd>{project.expandedBrief.structured.platform ?? 'unknown — see the questions'}</dd>
            </div>
            {project.expandedBrief.structured.components.length > 0 ? (
              <div>
                <dt>Components</dt>
                <dd>
                  {project.expandedBrief.structured.components.map((component) => (
                    <span key={`${component.name}-${component.quantity}`} className="evf-brief__chip">
                      {component.name} ×{component.quantity}
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
            {project.expandedBrief.structured.behaviours.length > 0 ? (
              <div>
                <dt>Must behave</dt>
                <dd>{project.expandedBrief.structured.behaviours.join(' · ')}</dd>
              </div>
            ) : null}
            {project.expandedBrief.structured.assumptions.length > 0 ? (
              <div>
                <dt>Assumed</dt>
                <dd>{project.expandedBrief.structured.assumptions.join(' · ')}</dd>
              </div>
            ) : null}
            {project.expandedBrief.structured.openQuestions.length > 0 ? (
              <div>
                <dt>Still open</dt>
                <dd>{project.expandedBrief.structured.openQuestions.join(' · ')}</dd>
              </div>
            ) : null}
          </dl>
          <p className="evf-brief__note">Wrong anywhere? Answer the matching question, or add a correction on the right — it folds into the build.</p>
        </div>
      ) : null}

      <div className="evf-intake__grid">
        <aside className="evf-intake__graph" aria-label="Project graph skeleton">
          <h3 className="evf-col-title">The graph, growing</h3>
          {everflow ? (
            <GraphSkeleton graph={everflow.graph} />
          ) : (
            <p className="evf-muted">The skeleton appears here as the agent parses the brief.</p>
          )}
        </aside>

        <div className="evf-intake__doubts" aria-label="Doubts to settle">
          {doubts.length === 0 ? (
            <div className="evf-doubt evf-doubt--loading">
              <span className="dot dot--live" />
              <span>Parsing the brief — looking for real forks, not small talk…</span>
            </div>
          ) : (
            open.map((doubt) => <DoubtCard key={doubt.id} projectId={project.id} doubt={doubt} onAnswered={() => void refreshSession()} busy={building} />)
          )}
          {doubts.length > 0 && open.length === 0 && (
            <div className="evf-doubt evf-doubt--done">
              <span>✓</span>
              <span>Every doubt settled. Hit build — the agent takes it from here and keeps iterating on the graph.</span>
            </div>
          )}
        </div>
      </div>

      <footer className="evf-intake__foot">
        {error ? <span className="evf-error">{error}</span> : open.length > 0 ? (
          <span className="evf-muted">{open.length} unsettled — the build will record them as assumptions you can revisit.</span>
        ) : (
          <span className="evf-muted">All settled.</span>
        )}
        <button type="button" className="btn btn--primary" disabled={building || doubts.length === 0} onClick={() => void build()}>
          {building ? 'Starting the agent…' : 'Build the project →'}
        </button>
      </footer>
    </section>
  );
}

function GraphSkeleton({ graph }: { graph: EverflowPayload['graph'] }) {
  const [selected, setSelected] = useState<string | null>(null);
  return <GraphCanvas graph={graph} selectedId={selected} onSelect={setSelected} compact />;
}
