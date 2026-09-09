'use client';

/**
 * HANDS & LEGS — where the human and the agent actually meet.
 *
 * The agent cannot plug in a ribbon cable, read a terminal or measure a door
 * frame. Everything it cannot do itself lands here as a task with a reason
 * (`why`), a promise about what the answer is for (`thenWhat`), an exact
 * command, and a default so nothing deadlocks on silence.
 *
 * Answers come back as facts that later planning reads instead of guessing.
 */

import { useMemo, useState } from 'react';

import { TASK_GROUP_LABELS, type HumanTask } from '@/modules/human-loop/types';
import { Badge, Card, CopyButton, Empty, Notice, SectionTitle } from '../ui';
import { actOnTask, planTasks } from '../api';
import { useHub } from '../hub-context';

const VERB_LABEL: Record<HumanTask['verb'], string> = {
  ask: 'decide',
  do: 'do',
  observe: 'look',
  verify: 'check',
};

const VERB_TONE: Record<HumanTask['verb'], 'info' | 'ok' | 'warn' | 'neutral'> = {
  ask: 'info',
  do: 'neutral',
  observe: 'info',
  verify: 'ok',
};

const STATUS_TONE: Record<HumanTask['status'], 'ok' | 'warn' | 'err' | 'neutral'> = {
  open: 'neutral',
  claimed: 'warn',
  submitted: 'warn',
  accepted: 'ok',
  rejected: 'err',
  skipped: 'neutral',
};

export function HandsLegsPanel() {
  const { project, refresh, details } = useHub();
  const loop = project?.humanLoop ?? { tasks: [], facts: [] };
  const projectId = project?.id ?? '';

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, string>>({});

  const groups = useMemo(() => {
    const map = new Map<string, HumanTask[]>();
    for (const task of loop.tasks) {
      const bucket = map.get(task.group) ?? [];
      bucket.push(task);
      map.set(task.group, bucket);
    }
    return [...map.entries()];
  }, [loop.tasks]);

  const summary = useMemo(() => {
    const total = loop.tasks.length;
    const done = loop.tasks.filter((task) => task.status === 'accepted' || task.status === 'skipped').length;
    const pending = loop.tasks.filter((task) => task.status === 'open' || task.status === 'claimed' || task.status === 'rejected').length;
    return { total, done, pending, blocking: loop.tasks.filter((task) => task.blocking && task.status !== 'accepted' && task.status !== 'skipped').length };
  }, [loop.tasks]);

  async function run(key: string, action: () => Promise<unknown>) {
    if (!projectId) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  if (loop.tasks.length === 0) {
    return (
      <Card title="Hands & legs" wide count="nothing queued">
        {error ? <Notice tone="err">{error}</Notice> : null}
        <p className="muted">
          The agent has hands for everything it can compute — the catalog, the pin map, the power budget, the firmware.
          Everything else (plug it in, read the screen, measure the door, decide what matters) is yours.
        </p>
        <p className="muted">
          Generate the commissioning queue once the hardware plan is settled: it turns the plan into an ordered list of
          physical actions, each with the command to run and the fact it grounds.
        </p>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy !== null || !projectId}
          onClick={() => run('plan', () => planTasks(projectId))}
        >
          {busy === 'plan' ? 'Planning…' : 'Build the commissioning queue'}
        </button>
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Hands & legs"
        wide
        count={`${summary.done}/${summary.total} done`}
        footer={
          <span className="muted">
            Answers are stored as facts. Skip applies the default and records it as an assumption — it never blocks the build.
          </span>
        }
      >
        <div className="row row--tight">
          <Badge tone={summary.pending === 0 ? 'ok' : 'warn'}>
            {summary.pending === 0 ? 'nothing waiting on you' : `${summary.pending} waiting on you`}
          </Badge>
          {summary.blocking > 0 ? <Badge tone="err">{summary.blocking} blocking</Badge> : null}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy !== null}
            onClick={() => run('replan', () => planTasks(projectId, true))}
          >
            {busy === 'replan' ? 'Re-planning…' : 'Re-plan (keeps answers)'}
          </button>
        </div>
        {error ? <Notice tone="err">{error}</Notice> : null}
      </Card>

      {groups.map(([group, tasks]) => (
        <Card key={group} title={TASK_GROUP_LABELS[group] ?? group} count={`${tasks.filter((t) => t.status === 'accepted' || t.status === 'skipped').length}/${tasks.length}`}>
          <div className="list list--tight">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                projectId={projectId}
                busy={busy}
                details={details}
                answer={answers[task.id] ?? ''}
                evidence={evidence[task.id] ?? ''}
                onAnswer={(value) => setAnswers((prev) => ({ ...prev, [task.id]: value }))}
                onEvidence={(value) => setEvidence((prev) => ({ ...prev, [task.id]: value }))}
                onRun={run}
              />
            ))}
          </div>
        </Card>
      ))}

      {loop.facts.length > 0 ? (
        <Card title="Facts grounded by your answers" count={String(loop.facts.length)}>
          <table className="table">
            <thead>
              <tr>
                <th>Fact</th>
                <th>Value</th>
                {details ? <th>Source</th> : null}
              </tr>
            </thead>
            <tbody>
              {loop.facts.map((fact) => (
                <tr key={fact.key}>
                  <td>
                    <code>{fact.key}</code>
                    {fact.assumed ? <Badge tone="warn">assumed</Badge> : null}
                  </td>
                  <td>{fact.value}</td>
                  {details ? <td className="muted">{fact.sourceTaskId}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}

function TaskRow({
  task,
  projectId,
  busy,
  details,
  answer,
  evidence,
  onAnswer,
  onEvidence,
  onRun,
}: {
  task: HumanTask;
  projectId: string;
  busy: string | null;
  details: boolean;
  answer: string;
  evidence: string;
  onAnswer: (value: string) => void;
  onEvidence: (value: string) => void;
  onRun: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const done = task.status === 'accepted' || task.status === 'skipped';
  const active = !done;

  return (
    <div className={`task${done ? ' task--done' : ''}`}>
      <div className="task__head">
        <span className="task__order">{task.order}</span>
        <Badge tone={VERB_TONE[task.verb]}>{VERB_LABEL[task.verb]}</Badge>
        <strong className="task__title">{task.title}</strong>
        <Badge tone={STATUS_TONE[task.status]}>{task.status}</Badge>
        {task.blocking && active ? <Badge tone="err">blocking</Badge> : null}
        {task.risk === 'high' ? <Badge tone="err">high risk</Badge> : null}
        {task.risk === 'caution' ? <Badge tone="warn">caution</Badge> : null}
      </div>

      <div className="task__meta">
        <div>
          <span className="task__label">Why I can&apos;t do this</span>
          <span>{task.why}</span>
        </div>
        <div>
          <span className="task__label">What I&apos;ll do with it</span>
          <span>{task.thenWhat}</span>
        </div>
      </div>

      {task.steps && task.steps.length > 0 ? (
        <ol className="task__steps">
          {task.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : null}

      {task.command ? (
        <div className="task__command">
          <code>{task.command}</code>
          <CopyButton text={task.command} />
        </div>
      ) : null}

      {task.hazard ? <Notice tone={task.risk === 'high' ? 'err' : 'warn'}>{task.hazard}</Notice> : null}
      {task.answer.expect ? (
        <p className="task__expect">
          Expect: <span>{task.answer.expect}</span>
        </p>
      ) : null}

      {done ? (
        <div className="task__result">
          <SectionTitle>Answer</SectionTitle>
          <code>{task.result?.answer}</code>
          {task.result?.evidence ? <pre className="task__evidence">{task.result.evidence}</pre> : null}
          {details && task.fact ? <span className="muted">grounds fact {task.fact}</span> : null}
        </div>
      ) : (
        <div className="task__form">
          {task.answer.kind === 'choice' ? (
            <div className="task__choices">
              {task.answer.options?.map((option) => (
                <label key={option.value} className={`task__choice${answer === option.value ? ' task__choice--on' : ''}`}>
                  <input type="radio" name={`task-${task.id}`} value={option.value} checked={answer === option.value} onChange={() => onAnswer(option.value)} />
                  <span>
                    <strong>{option.label}</strong>
                    {option.note ? <em>{option.note}</em> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : task.answer.kind === 'boolean' ? (
            <div className="task__row">
              <button type="button" className={`btn btn--sm${answer === 'true' ? ' btn--primary' : ''}`} onClick={() => onAnswer('true')}>
                Yes
              </button>
              <button type="button" className={`btn btn--sm${answer === 'false' ? ' btn--primary' : ''}`} onClick={() => onAnswer('false')}>
                No
              </button>
            </div>
          ) : (
            <input
              className="task__input"
              type={task.answer.kind === 'measurement' || task.answer.kind === 'number' ? 'text' : 'text'}
              inputMode={task.answer.kind === 'measurement' || task.answer.kind === 'number' ? 'decimal' : 'text'}
              placeholder={task.answer.placeholder ?? (task.answer.unit ? `value in ${task.answer.unit}` : 'your answer')}
              value={answer}
              onChange={(event) => onAnswer(event.target.value)}
            />
          )}

          {task.answer.kind === 'terminal' || task.answer.kind === 'photo' || task.answer.kind === 'measurement' ? (
            <textarea
              className="task__input"
              rows={3}
              placeholder={task.answer.kind === 'terminal' ? 'paste the terminal output' : task.answer.kind === 'photo' ? 'describe what you see' : 'evidence or notes'}
              value={evidence}
              onChange={(event) => onEvidence(event.target.value)}
            />
          ) : null}

          <div className="task__row">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy !== null || answer.length === 0}
              onClick={() => onRun(`submit-${task.id}`, () => actOnTask(projectId, task.id, 'submit', { answer, ...(evidence ? { evidence } : {}) }))}
            >
              {busy === `submit-${task.id}` ? 'Saving…' : 'Submit'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy !== null || task.default === undefined}
              onClick={() => onRun(`skip-${task.id}`, () => actOnTask(projectId, task.id, 'skip'))}
            >
              Skip{task.default !== undefined ? ` (assume ${String(task.default)})` : ''}
            </button>
            {task.status === 'open' ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy !== null}
                onClick={() => onRun(`claim-${task.id}`, () => actOnTask(projectId, task.id, 'claim'))}
              >
                I&apos;m on it
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
