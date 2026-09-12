'use client';

/**
 * THE EVERFLOW VIEW — the project graph as a working document.
 *
 *   left   — the graph (every node has a completion goal; the ring says where
 *            its goal stands)
 *   right  — the human channel, two columns:
 *              1. AI NEEDS YOU   — asks the agent filed: it can never close
 *                                   these goals alone, and it never blocks on
 *                                   you (each has a recorded default-on-expiry)
 *              2. YOU ADD TO AI  — the reverse direction: information the
 *                                   agent cannot have. Registered as facts;
 *                                   design changes need your explicit apply.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HumanTask, ResearchFinding } from '@/types/everflow';

import { useHub } from '@/components/workspace/hub-context';

import {
  buildProject,
  continueEverflowPass,
  createEverflowInjection,
  fetchEverflow,
  researchEverflowNode,
  respondToEverflowTask,
  type EverflowPayload,
} from '@/components/workspace/api';

import { GraphCanvas } from './GraphCanvas';

const TERMINAL = new Set(['completed', 'completed_with_warnings', 'completed_with_errors']);

function statusLine(evaluation: EverflowPayload['evaluation']): { text: string; tone: 'done' | 'wait' | 'work' } {
  if (evaluation.done) return { text: 'Complete — every goal satisfied, nothing dangling.', tone: 'done' };
  if (evaluation.blockedOnHuman) {
    const asks = evaluation.totals.aiTasksOpen;
    return { text: `Waiting on you — ${asks} ask(s) in the left channel. The agent keeps the record; it does not wait in silence.`, tone: 'wait' };
  }
  const ends = evaluation.totals.openEnds;
  return { text: `In flight — ${Math.round(evaluation.completion * 100)}% of goals satisfied, ${ends} goal(s) still without a task working on them.`, tone: 'work' };
}

/* -------------------------------------------------------------------------- */
/* Column one — AI → human                                                    */
/* -------------------------------------------------------------------------- */

function TaskAskCard({ task, projectId, onDone, onApply }: { task: HumanTask; projectId: string; onDone: () => void; onApply: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const answered = task.status !== 'open';

  const send = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        await respondToEverflowTask(projectId, task.id, value);
        if (task.type === 'choose' && /^apply/i.test(value)) {
          await buildProject(projectId, { rebuild: true });
          onApply();
          return;
        }
        onDone();
      } finally {
        setBusy(false);
      }
    },
    [projectId, task.id, onDone, onApply, task.type],
  );

  const boolean = task.asks.shape === 'boolean';
  const choice = task.asks.shape === 'choice';

  return (
    <article className={`evf-ask${answered ? ' evf-ask--answered' : ''}`} data-type={task.type}>
      <header className="evf-ask__head">
        <span className="evf-ask__type">{task.type.toUpperCase()}</span>
        <span className={`evf-ask__prio evf-ask__prio--${task.priority}`}>{task.priority}</span>
        {task.lookAt ? (
          <Link className="evf-ask__look" href={task.lookAt.ref}>
            {task.lookAt.label} →
          </Link>
        ) : null}
      </header>
      <h4 className="evf-ask__title">{task.title}</h4>
      <p className="evf-ask__body">{task.body}</p>

      {answered && task.response ? (
        <p className="evf-ask__resolved">
          You said: <strong>{task.response.value}</strong>
        </p>
      ) : boolean ? (
        <div className="evf-ask__actions">
          {(task.asks.options ?? ['Yes, it works', 'No, it does not']).map((option, index) => (
            <button key={option} type="button" className={index === 0 ? 'btn btn--sm btn--primary' : 'btn btn--sm'} disabled={busy} onClick={() => void send(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : choice ? (
        <div className="evf-ask__actions">
          {(task.asks.options ?? []).map((option) => (
            <button key={option} type="button" className="btn btn--sm" disabled={busy} onClick={() => void send(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div className="evf-ask__actions evf-ask__actions--text">
          <input className="evf-input" placeholder="Your answer…" value={text} onChange={(event) => setText(event.target.value)} />
          <button type="button" className="btn btn--sm btn--primary" disabled={busy || text.trim().length === 0} onClick={() => void send(text.trim())}>
            Send
          </button>
        </div>
      )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Column two — human → AI                                                    */
/* -------------------------------------------------------------------------- */

function InjectionColumn({ projectId, tasks, onDone }: { projectId: string; tasks: HumanTask[]; onDone: () => void }) {
  const [type, setType] = useState<HumanTask['type'] & ('note' | 'idea' | 'correction' | 'resource')>('idea');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async () => {
    if (text.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await createEverflowInjection(projectId, { type, text: text.trim() });
      setText('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The addition could not be sent.');
    } finally {
      setBusy(false);
    }
  }, [projectId, type, text, onDone]);

  return (
    <div className="evf-add">
      <div className="evf-add__composer">
        <div className="evf-add__types" role="group" aria-label="What you are adding">
          {(['idea', 'correction', 'resource', 'note'] as const).map((option) => (
            <button key={option} type="button" className={`evf-add__type${type === option ? ' is-active' : ''}`} onClick={() => setType(option)}>
              {option}
            </button>
          ))}
        </div>
        <textarea
          className="evf-add__text"
          rows={3}
          placeholder={
            type === 'idea'
              ? 'An idea the agent has not had yet — a feature, a different approach…'
              : type === 'correction'
                ? 'Something in the design that is wrong or should be different…'
                : type === 'resource'
                  ? 'Parts, tools or hardware you already own…'
                  : 'Context the agent cannot know — where it lives, who uses it…'
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {error ? <p className="evf-error">{error}</p> : null}
        <div className="evf-add__foot">
          <span className="evf-muted">Registered as a fact on the graph. Design changes need your explicit “apply”.</span>
          <button type="button" className="btn btn--sm btn--primary" disabled={busy || text.trim().length < 3} onClick={() => void send()}>
            Send to the agent
          </button>
        </div>
      </div>

      <ul className="evf-add__list" aria-label="Your additions">
        {tasks.length === 0 ? (
          <li className="evf-muted">Nothing yet. This column is yours — the agent reads it before every pass.</li>
        ) : (
          tasks.map((task) => (
            <li key={task.id} className={`evf-add__item${task.status === 'open' ? '' : ' evf-add__item--processed'}`}>
              <span className={`evf-add__status evf-add__status--${task.status}`}>{task.status === 'open' ? 'awaiting the agent' : task.status === 'processed' ? 'agent: registered' : task.status}</span>
              <span className="evf-add__title">{task.title}</span>
              <span className="evf-add__body">{task.response?.value ?? task.body}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Research — the agent's docs/web check tool, per node                        */
/* -------------------------------------------------------------------------- */

function NodeResearch({
  projectId,
  nodeId,
  kind,
  onDone,
}: {
  projectId: string;
  nodeId: string;
  kind: string;
  onDone: () => void;
}) {
  const { project } = useHub();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const findings = useMemo(
    () => (project?.research ?? []).filter((finding) => finding.nodeId === nodeId),
    [project?.research, nodeId],
  );

  const research = useCallback(
    async (useWeb: boolean) => {
      setBusy(true);
      setMessage(null);
      try {
        const payload = await researchEverflowNode(projectId, nodeId, useWeb);
        if (!payload.found) {
          setMessage(payload.message ?? 'No source found yet.');
        } else {
          setMessage(null);
        }
        onDone();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'The check could not run.');
      } finally {
        setBusy(false);
      }
    },
    [projectId, nodeId, onDone],
  );

  const canResearch = kind === 'claim' || kind === 'decision' || kind === 'goal' || kind === 'assumption';

  return (
    <div className="evf-research">
      <header className="evf-research__head">
        <span className="evf-col-title">Documentation check</span>
        {canResearch ? (
          <span className="evf-research__actions">
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void research(false)}>
              {busy ? 'Checking…' : 'check the docs'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} title="Also pull a snippet from the cited page (flagged for your review)" onClick={() => void research(true)}>
              + the web
            </button>
          </span>
        ) : null}
      </header>

      {message ? <p className="evf-research__none">{message}</p> : null}
      {findings.length === 0 && !message ? (
        <p className="evf-research__none">
          {canResearch ? 'The agent checks this against the catalog, the docs corpus, and the web — findings appear here with a citation.' : 'Research applies to claims, decisions, goals and assumptions.'}
        </p>
      ) : null}

      <div className="evf-research__list">
        {findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} />
        ))}
      </div>
    </div>
  );
}

function FindingCard({ finding }: { finding: ResearchFinding }) {
  return (
    <details className="evf-finding" open={finding.needsHumanCheck}>
      <summary>
        <span className={`evf-finding__src evf-finding__src--${finding.source}`}>{finding.source}</span>
        <span className="evf-finding__title">{finding.title}</span>
        {finding.needsHumanCheck ? <span className="evf-chip evf-chip--veto">needs your check</span> : null}
        <span className="evf-finding__conf">{Math.round(finding.confidence * 100)}%</span>
      </summary>
      <ul>
        {finding.facts.map((fact, index) => (
          <li key={index}>{fact}</li>
        ))}
      </ul>
      {finding.url ? (
        <a className="evf-finding__url" href={finding.url} target="_blank" rel="noreferrer">
          source →
        </a>
      ) : null}
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

export function EverflowPanel() {
  const { project, refresh } = useHub();
  const projectId = project?.id ?? '';
  const onProjectChanged = refresh;
  const [payload, setPayload] = useState<EverflowPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGraph = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await fetchEverflow(projectId);
      setPayload(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The graph could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const runPass = useCallback(async () => {
    setWorking(true);
    try {
      await continueEverflowPass(projectId);
      await loadGraph();
      await onProjectChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The pass could not run.');
    } finally {
      setWorking(false);
    }
  }, [projectId, loadGraph, onProjectChanged]);

  const evaluation = payload?.evaluation ?? null;
  const line = evaluation ? statusLine(evaluation) : null;
  const actions = payload?.actions ?? null;
  const moves = useMemo(() => [...(actions?.history ?? [])].reverse(), [actions]);
  const aiAsks = useMemo(() => payload?.humanTasks.filter((task) => task.direction === 'ai_to_human') ?? [], [payload]);
  const injections = useMemo(() => payload?.humanTasks.filter((task) => task.direction === 'human_to_ai') ?? [], [payload]);
  const openAsks = aiAsks.filter((task) => task.status === 'open');
  const doneAsks = aiAsks.filter((task) => task.status !== 'open');
  const selectedNode = payload && selected ? payload.graph.nodes.find((node) => node.id === selected) : null;
  const selectedResult = payload && selected ? payload.evaluation.results.find((result) => result.nodeId === selected) : null;
  const terminal = project ? TERMINAL.has(payload?.status ?? project.status) : false;

  if (!project) return null;

  return (
    <section className="evf-panel" aria-label="Everflow — project graph and human channel">
      {line ? (
        <div className={`evf-ribbon evf-ribbon--${line.tone}`}>
          <div className="evf-ribbon__progress" aria-hidden="true">
            <span style={{ width: `${Math.round((evaluation?.completion ?? 0) * 100)}%` }} />
          </div>
          <div className="evf-ribbon__row">
            <strong>{Math.round((evaluation?.completion ?? 0) * 100)}%</strong>
            <span>{line.text}</span>
            <span className="evf-ribbon__meta">
              pass {payload?.evaluation.pass ?? 0} · {payload?.graph.nodes.length ?? 0} nodes · {evaluation?.totals.openEnds ?? 0} dangling
            </span>
          </div>
        </div>
      ) : null}

      {actions && moves.length > 0 ? (
        <details className="evf-moves">
          <summary>
            Loop moves — what the agent did itself before asking you
            <span className="evf-moves__count">{moves.length}</span>
            <span className="evf-muted">
              repairs {actions.repairsUsed} · reproofs {actions.reproofsUsed}
            </span>
          </summary>
          <ul className="evf-moves__list">
            {moves.map((move) => (
              <li key={move.id} className={`evf-move evf-move--${move.outcome}`}>
                <span className="evf-chip">{move.move}</span>
                <span className={`evf-chip evf-chip--${move.outcome}`}>{move.outcome.replace('_', ' ')}</span>
                <span className="evf-move__summary">{move.summary}</span>
                {move.revision ? <code className="evf-move__rev">v{move.revision}</code> : null}
                <span className="evf-muted">pass {move.pass}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="evf-grid">
        <div className="evf-col evf-col--graph">
          <div className="evf-col__head">
            <h3 className="evf-col-title">The project graph</h3>
              <div className="evf-col__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={working} onClick={() => void runPass()}>
                {working ? 'Working…' : 'run another pass'}
              </button>
              {terminal ? <span className="evf-muted">rebuild happens via “apply” on an addition</span> : null}
            </div>
          </div>
          {payload ? (
            <GraphCanvas graph={payload.graph} selectedId={selected} onSelect={setSelected} />
          ) : (
            <p className="evf-muted">Materialising the graph…</p>
          )}
          {selectedNode ? (
            <div className="evf-inspector">
              <header>
                <span className="evf-chip">{selectedNode.kind.toUpperCase()}</span>
                {selectedNode.owner === 'human' ? <span className="evf-chip evf-chip--you">owned by you</span> : selectedNode.owner === 'ai' ? <span className="evf-chip evf-chip--ai">owned by the agent</span> : null}
                {selectedNode.file ? <code className="evf-inspector__file">{selectedNode.file.path}</code> : null}
              </header>
              <h4>{selectedNode.label}</h4>
              <p>{selectedNode.content}</p>
              <dl>
                <dt>goal</dt>
                <dd>{selectedNode.goal.criterion}</dd>
                <dt>verdict</dt>
                <dd>
                  {selectedResult ? `${selectedResult.goal.state} — ${selectedResult.evidence}` : '—'}
                </dd>
                <dt>source</dt>
                <dd>
                  {selectedNode.source.origin}
                  {selectedNode.source.stage ? ` · ${selectedNode.source.stage}` : ''}
                  {selectedNode.source.revision ? ` · v${selectedNode.source.revision}` : ''}
                </dd>
              </dl>
              <NodeResearch projectId={projectId} nodeId={selectedNode.id} kind={selectedNode.kind} onDone={() => { void loadGraph(); void onProjectChanged(); }} />
            </div>
          ) : null}
        </div>

        <div className="evf-col evf-col--channel">
          <div className="evf-channel">
            <section className="evf-chan" aria-label="AI needs you">
              <h3 className="evf-chan__title">
                AI needs you <span className="evf-chan__count">{openAsks.length}</span>
              </h3>
              {openAsks.length === 0 ? (
                <p className="evf-muted">Nothing is parked on you. The agent is working what it can, alone.</p>
              ) : (
                openAsks.map((task) => (
                  <TaskAskCard
                    key={task.id}
                    task={task}
                    projectId={projectId}
                    onDone={() => { void loadGraph(); void onProjectChanged(); }}
                    onApply={() => { void loadGraph(); void onProjectChanged(); }}
                  />
                ))
              )}
              {doneAsks.length > 0 ? (
                <details className="evf-chan__history">
                  <summary>Earlier answers ({doneAsks.length})</summary>
                  {doneAsks.map((task) => (
                    <div key={task.id} className="evf-chan__history-item">
                      <span>{task.title}</span>
                      <strong>{task.response?.value}</strong>
                    </div>
                  ))}
                </details>
              ) : null}
            </section>

            <section className="evf-chan evf-chan--add" aria-label="You add to AI">
              <h3 className="evf-chan__title">
                You add to AI <span className="evf-chan__count">{injections.filter((task) => task.status === 'open').length}</span>
              </h3>
              <InjectionColumn projectId={projectId} tasks={injections} onDone={() => { void loadGraph(); void onProjectChanged(); }} />
            </section>
          </div>
        </div>
      </div>

      {error ? <p className="evf-error">{error}</p> : null}
    </section>
  );
}
