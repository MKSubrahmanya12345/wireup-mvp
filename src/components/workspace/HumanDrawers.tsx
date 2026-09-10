'use client';

/**
 * THE TWO DRAWERS — the Human API surface (idea graph, part 7).
 *
 * LEFT — "AI needs you": every open ai→human ask (verify / choose / test /
 * review / context). Each shows its type, what it changes, its node link and
 * its default-on-expiry — the agent never blocks on you, so the default is
 * always printed before you answer. Answers go through /everflow/respond.
 *
 * RIGHT — "You, mid-thought": inject note / idea / correction / resource /
 * steer through /everflow/inject. For anything that could change the design
 * the agent answers with a CHOOSE ask in the left drawer (never a silent
 * edit). 'steer' is the one gated primitive: the server only accepts it when
 * WIREUP_ENABLE_MID_TURN_STEER=true AND the configured model is gpt-6-astra —
 * the drawer asks the server once and says honestly what is available.
 *
 * Both drawers read the same live project from HubContext (the single event
 * poll — deliberately no second polling loop) and refresh it after actions.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HumanTask } from '@/types/everflow';

import { fetchEverflow, injectEverflowThought, respondEverflowAsk } from './api';
import { useHub } from './hub-context';

export type DrawerSide = 'left' | 'right';

const ASK_CHIP: Partial<Record<HumanTask['type'], string>> = {
  verify: 'VERIFY',
  choose: 'CHOOSE',
  test: 'TEST IT',
  review: 'REVIEW',
  context: 'CONTEXT',
};

const DEFAULT_LABEL: Record<HumanTask['defaultOnExpiry'], string> = {
  assume: 'if you skip it, the recorded assumption applies',
  defer: 'if you skip it, the agent defers and keeps working',
  halt: 'if you skip it, this line of work halts (rare — gated work only)',
};

/* -------------------------------------------------------------------------- */
/* Left drawer — AI needs you                                                 */
/* -------------------------------------------------------------------------- */

function NeedsYouDrawer({ onClose }: { onClose: () => void }) {
  const { project, refresh } = useHub();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [answeredIds, setAnsweredIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const asks = useMemo(
    () => (project?.humanTasks ?? []).filter((task) => task.direction === 'ai_to_human' && task.status === 'open'),
    [project],
  );

  const answer = useCallback(
    async (task: HumanTask, value: string) => {
      if (!project || !value.trim()) return;
      setBusyId(task.id);
      setError(null);
      try {
        await respondEverflowAsk(project.id, task.id, value.trim());
        setAnsweredIds((current) => [...current, task.id]);
        await refresh(); // the same poller the event log uses — it reacts visibly
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The answer could not be delivered.');
      } finally {
        setBusyId(null);
      }
    },
    [project, refresh],
  );

  return (
    <>
      <header className="drawer__head">
        <span className="drawer__title">AI needs you</span>
        <span className="drawer__count">{asks.length} open</span>
        <span className="drawer__spacer" />
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close drawer">✕</button>
      </header>

      <div className="drawer__body">
        {answeredIds.length > 0 ? (
          <p className="ask__done">
            ✓ {answeredIds.length} answer(s) sent — watch the run log react on the next pass.
          </p>
        ) : null}
        {error ? <p className="drawer__error">{error}</p> : null}

        {asks.length === 0 ? (
          <p className="drawer__empty">
            Nothing needs you right now. Asks appear here the moment the agent files one — and it
            never blocks on you: every ask carries a printed default.
          </p>
        ) : (
          asks.map((task) => {
            const options = task.asks.options?.length
              ? task.asks.options
              : task.asks.shape === 'boolean'
                ? ['Yes', 'No']
                : [];
            const busy = busyId === task.id;
            return (
              <article key={task.id} className={`ask${task.priority === 'high' ? ' ask--high' : ''}`}>
                <div className="ask__top">
                  <span className={`ask__chip ask__chip--${task.type}`}>{ASK_CHIP[task.type] ?? task.type.toUpperCase()}</span>
                  {task.priority === 'high' ? <span className="ask__flag">gates work</span> : null}
                  {task.linkedNodeIds[0] ? <span className="ask__node mono-sm">{task.linkedNodeIds[0]}</span> : null}
                </div>

                <h3 className="ask__title">{task.title}</h3>
                {task.body ? <p className="ask__body">{task.body}</p> : null}

                {task.lookAt ? (
                  <p className="ask__look">
                    look at:{' '}
                    {task.lookAt.ref.startsWith('/') ? (
                      <a href={task.lookAt.ref} target="_blank" rel="noreferrer">{task.lookAt.label}</a>
                    ) : (
                      <span className="mono-sm">{task.lookAt.ref}</span>
                    )}
                  </p>
                ) : null}

                <p className="ask__default">
                  You don't have to answer: {task.assumptionIfSkipped ?? DEFAULT_LABEL[task.defaultOnExpiry]}
                </p>

                {options.length > 0 ? (
                  <div className="ask__actions">
                    {options.map((option) => (
                      <button key={option} type="button" className="ask__opt" disabled={busy} onClick={() => answer(task, option)}>
                        {option}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="ask__free">
                    <input
                      className="ask__input"
                      value={drafts[task.id] ?? ''}
                      placeholder={task.asks.shape === 'measurement' ? 'e.g. 7.4' : 'Type your answer'}
                      onChange={(event) => setDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void answer(task, drafts[task.id] ?? '');
                      }}
                    />
                    <button type="button" className="btn btn--sm" disabled={busy || !(drafts[task.id] ?? '').trim()} onClick={() => void answer(task, drafts[task.id] ?? '')}>
                      send
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      <footer className="drawer__foot">answers POST /everflow/respond · an answer is evidence on the graph, never a silent edit</footer>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Right drawer — You, mid-thought                                            */
/* -------------------------------------------------------------------------- */

type InjectType = 'note' | 'idea' | 'correction' | 'resource' | 'steer';

const INJECT_TYPES: { id: InjectType; label: string; hint: string }[] = [
  { id: 'note', label: 'note', hint: 'A fact the agent cannot know. Registered on the graph; read on the next pass.' },
  { id: 'idea', label: 'idea', hint: 'The agent registers it, then ASKS you whether to apply it to the build — nothing changes silently.' },
  { id: 'correction', label: 'correction', hint: 'Same as an idea: registered, then a CHOOSE ask comes back before anything is applied.' },
  { id: 'resource', label: 'resource', hint: 'Something you own (part, datasheet, link). Registered, then the apply-question.' },
  { id: 'steer', label: 'steer', hint: 'Redirect the reasoning: the current move finishes, the next pass folds this in.' },
];

function MidThoughtDrawer({ onClose }: { onClose: () => void }) {
  const { project, refresh } = useHub();
  const [type, setType] = useState<InjectType>('note');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [okLine, setOkLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Asked the server ONCE per drawer-open (a fetch, not a polling loop). */
  const [steerOk, setSteerOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setSteerOk(null);
    fetchEverflow(project.id)
      .then((payload) => {
        if (!cancelled) setSteerOk(payload.capabilities?.midTurnSteer === true);
      })
      .catch(() => {
        if (!cancelled) setSteerOk(false); // unknown ⇒ steer stays off; nothing else is affected
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const mine = useMemo(
    () => (project?.humanTasks ?? []).filter((task) => task.direction === 'human_to_ai').slice(-6).reverse(),
    [project],
  );

  const active = INJECT_TYPES.find((entry) => entry.id === type)!;
  const steerBlocked = type === 'steer' && steerOk !== true;

  const send = useCallback(async () => {
    if (!project || text.trim().length < 3 || steerBlocked) return;
    setBusy(true);
    setError(null);
    setOkLine(null);
    try {
      await injectEverflowThought(project.id, { type, text: text.trim() });
      setOkLine(
        type === 'note'
          ? 'Registered — the next pass reads it.'
          : type === 'steer'
            ? 'Steer registered — the current move finishes; the planner folds it in at the next pass.'
            : 'Registered — expect a CHOOSE ask in the left drawer before anything is applied.',
      );
      setText('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The addition could not be registered.');
    } finally {
      setBusy(false);
    }
  }, [project, text, type, steerBlocked, refresh]);

  return (
    <>
      <header className="drawer__head">
        <span className="drawer__title">You, mid-thought</span>
        <span className="drawer__spacer" />
        <button type="button" className="drawer__close" onClick={onClose} aria-label="Close drawer">✕</button>
      </header>

      <div className="drawer__body">
        <div className="inj__types" role="tablist" aria-label="Addition type">
          {INJECT_TYPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={type === entry.id}
              className={`inj__type${type === entry.id ? ' inj__type--on' : ''}`}
              onClick={() => {
                setType(entry.id);
                setOkLine(null);
                setError(null);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {steerBlocked && type === 'steer' ? (
          <p className="inj__steer-off">
            Mid-turn steering is off here (needs WIREUP_ENABLE_MID_TURN_STEER=true and model
            gpt-6-astra). Pick a type above — a note lands on the graph the same way and is read on
            the next pass.
          </p>
        ) : (
          <p className="inj__hint">{active.hint}</p>
        )}

        <textarea
          className="inj__textarea"
          value={text}
          maxLength={2000}
          placeholder={type === 'steer' ? 'e.g. prefer the ESP32-C6 over the Uno — WiFi instead of Bluetooth' : 'e.g. add a horn to the car'}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="inj__send">
          <span className="inj__count mono-sm">{text.trim().length}/2000</span>
          <span className="drawer__spacer" />
          <button type="button" className="btn btn--sm" disabled={busy || text.trim().length < 3 || steerBlocked} onClick={() => void send()}>
            {busy ? 'registering…' : 'register'}
          </button>
        </div>

        {okLine ? <p className="inj__ok">✓ {okLine}</p> : null}
        {error ? <p className="drawer__error">{error}</p> : null}

        {mine.length > 0 ? (
          <section className="inj__history">
            <h4 className="inj__history-title">your additions</h4>
            {mine.map((task) => (
              <p key={task.id} className="inj__entry">
                <span className={`inj__chip inj__chip--${task.type}`}>{task.type}</span>
                <span className="inj__entry-text">{task.title}</span>
                <span className={`inj__status inj__status--${task.status}`}>{task.status}</span>
              </p>
            ))}
          </section>
        ) : null}
      </div>

      <footer className="drawer__foot">POST /everflow/inject · registered as a fact — design changes only ever come back to you as an ask</footer>
    </>
  );
}

/* -------------------------------------------------------------------------- */

export function HumanDrawers({ side, open, onClose }: { side: DrawerSide; open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <aside className={`drawer drawer--${side}`} aria-label={side === 'left' ? 'AI needs you' : 'You, mid-thought'}>
      {side === 'left' ? <NeedsYouDrawer onClose={onClose} /> : <MidThoughtDrawer onClose={onClose} />}
    </aside>
  );
}

export function DrawerVeil({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <button type="button" className="drawer-veil" aria-label="Close drawers" onClick={onClose} />;
}
