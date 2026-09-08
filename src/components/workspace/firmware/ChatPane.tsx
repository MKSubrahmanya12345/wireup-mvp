'use client';

/**
 * The workbench chat pane.
 *
 * Renders the persisted transcript (from `project.chat`) plus optimistic
 * in-flight turns, and the composer. Every assistant message carries its
 * outcome; applied turns carry the diff and a jump target for the editor.
 */

import { useEffect, useRef, useState } from 'react';

import type { ChatMessage } from '@/types/project';

import { Badge } from '../ui';

const OUTCOME_LABEL: Record<NonNullable<ChatMessage['outcome']>, string> = {
  applied: 'applied',
  answer: 'answered',
  rejected: 'refused',
  failed: 'failed',
};

const OUTCOME_TONE: Record<NonNullable<ChatMessage['outcome']>, 'ok' | 'neutral' | 'warn' | 'err'> = {
  applied: 'ok',
  answer: 'neutral',
  rejected: 'warn',
  failed: 'err',
};

export function ChatPane({
  messages,
  busy,
  disabled,
  disabledReason,
  onSend,
  onViewDiff,
}: {
  messages: ChatMessage[];
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSend: (text: string) => void;
  onViewDiff: (message: ChatMessage) => void;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, busy]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy || disabled) return;
    setDraft('');
    onSend(text);
  };

  return (
    <div className="fwb-chat">
      <div className="fwb-chat__scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="fwb-chat__empty">
            <p className="small muted">Ask for changes in plain language — “add a second button that dims the LED”, “make the debounce faster”, “report battery voltage over serial”.</p>
            <p className="small muted">
              The model proposes a change; Wireup re-derives the pin map, type-checks the result and only then creates a revision. Proposed code that violates the plan is refused, not applied.
            </p>
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} onViewDiff={onViewDiff} />)
        )}
        {busy ? (
          <div className="fwb-chat__row fwb-chat__row--assistant">
            <div className="fwb-bubble fwb-bubble--assistant fwb-bubble--busy">
              <span className="fwb-typing" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              working — rooting, compiling…
            </div>
          </div>
        ) : null}
      </div>

      <div className="fwb-chat__composer">
        {disabled ? (
          <p className="small muted" style={{ margin: '0 0 6px' }}>
            {disabledReason ?? 'The chat is unavailable for this project right now.'}
          </p>
        ) : null}
        <div className="fwb-chat__inputrow">
          <textarea
            className="fwb-chat__input"
            placeholder={disabled ? 'chat unavailable' : 'describe the change…'}
            value={draft}
            rows={2}
            disabled={disabled || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button type="button" className="btn btn--primary fwb-chat__send" onClick={submit} disabled={disabled || busy || draft.trim().length === 0}>
            send
          </button>
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Enter sends · Shift+Enter breaks a line · changes become revisions with diffs
        </p>
      </div>
    </div>
  );
}

function MessageBubble({ message, onViewDiff }: { message: ChatMessage; onViewDiff: (message: ChatMessage) => void }) {
  const mine = message.role === 'user';
  return (
    <div className={`fwb-chat__row fwb-chat__row--${message.role}`}>
      <div className={`fwb-bubble fwb-bubble--${message.role}`}>
        <div className="fwb-bubble__text">{message.text}</div>
        {(message.outcome || message.diff || message.diagnostics) && (
          <div className="fwb-bubble__meta">
            {message.outcome ? (
              <Badge tone={OUTCOME_TONE[message.outcome]}>{OUTCOME_LABEL[message.outcome]}</Badge>
            ) : null}
            {message.revision ? <span className="small muted">v{message.revision}</span> : null}
            {message.diff ? (
              <>
                <span className={`fwb-diff__stat fwb-diff__stat--add`}>+{message.diff.added}</span>
                <span className={`fwb-diff__stat fwb-diff__stat--del`}>−{message.diff.removed}</span>
                <button type="button" className="btn btn--sm" onClick={() => onViewDiff(message)}>
                  view diff
                </button>
              </>
            ) : null}
          </div>
        )}
        {message.diagnostics && message.diagnostics.length > 0 ? (
          <ul className="fwb-problems fwb-problems--bubble">
            {message.diagnostics.slice(0, 6).map((diagnostic, index) => (
              <li key={index} className="fwb-problems__item fwb-problems__item--error">
                {diagnostic}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
