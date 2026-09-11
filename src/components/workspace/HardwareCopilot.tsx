'use client';

/**
 * A Cursor-like hardware surface: describe a change, inspect the coordinated
 * plan, then explicitly apply it. The server owns the real changeset and
 * re-checks the base revision before it writes anything.
 */

import { useState } from 'react';

import { applyHardwareEdit, planHardwareEdit } from './api';
import { useHub } from './hub-context';
import { Badge, Card, Empty } from './ui';
import type { HardwareEditPlan } from '@/modules/hardware-copilot';

const SUGGESTIONS = ['add a second button that dims the LED', 'replace the ultrasonic sensor with a PIR sensor', 'switch from Uno to ESP32'];

export function HardwareCopilot() {
  const { project, running, refresh } = useHub();
  const [draft, setDraft] = useState('');
  const [plan, setPlan] = useState<HardwareEditPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;

  const unavailable = running || project.status === 'intake' || project.components.length === 0;

  const planEdit = async (message: string): Promise<void> => {
    const text = message.trim();
    if (!text || unavailable || busy) return;
    setBusy(true);
    setApplied(false);
    setError(null);
    try {
      const response = await planHardwareEdit(project.id, text);
      setPlan(response.plan);
      setDraft(text);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    if (!plan || plan.status !== 'ready' || !draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await applyHardwareEdit(project.id, draft, plan.baseRevision);
      if (response.applied) {
        setPlan(response.plan);
        setApplied(true);
        await refresh();
      } else {
        setPlan(response.plan);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Hardware copilot"
      wide
      count="plan · diff · apply"
      actions={<Badge tone={running ? 'warn' : 'info'}>{running ? 'locked while building' : 'review before apply'}</Badge>}
    >
      <div className="copilot__intro">
        <div>
          <p className="copilot__eyebrow">workspace agent / hardware edits</p>
          <h3 className="copilot__title">Change the build like you change code.</h3>
          <p className="copilot__copy">
            Ask for a part or board change in plain language. Wireup stages the BOM, pins, wiring, firmware and guide as one reviewable diff — nothing lands until you approve it.
          </p>
        </div>
        <div className="copilot__loop" aria-label="Copilot workflow">
          <span>intent</span><i>→</i><span>plan</span><i>→</i><span>verify</span><i>→</i><span>apply</span>
        </div>
      </div>

      <div className="copilot__composer">
        <textarea
          className="copilot__input"
          value={draft}
          disabled={unavailable || busy}
          rows={2}
          placeholder={unavailable ? 'The hardware copilot unlocks after the first build.' : 'e.g. add a second button that dims the LED'}
          aria-label="Describe a hardware change"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void planEdit(draft);
            }
          }}
        />
        <button type="button" className="btn btn--primary copilot__send" disabled={unavailable || busy || draft.trim().length < 3} onClick={() => void planEdit(draft)}>
          {busy ? 'thinking…' : 'plan change'}
        </button>
      </div>
      <p className="copilot__hint">Enter plans · Shift+Enter adds detail · review the diff before applying</p>

      {!plan ? (
        <div className="copilot__suggestions">
          <span className="small muted">Try a safe edit</span>
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} type="button" className="copilot__suggestion" disabled={unavailable || busy} onClick={() => void planEdit(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : (
        <PlanReview plan={plan} applied={applied} busy={busy} onApply={() => void apply()} onDismiss={() => { setPlan(null); setApplied(false); }} />
      )}

      {error ? <p className="copilot__error" role="alert">{error}</p> : null}
    </Card>
  );
}

function PlanReview({
  plan,
  applied,
  busy,
  onApply,
  onDismiss,
}: {
  plan: HardwareEditPlan;
  applied: boolean;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const preview = plan.preview;
  const ready = plan.status === 'ready' && Boolean(preview);

  return (
    <div className={`copilot__review${plan.status !== 'ready' ? ' copilot__review--question' : ''}`}>
      <div className="copilot__review-head">
        <div>
          <span className="copilot__review-kicker">{applied ? 'applied / verified' : plan.status === 'ready' ? 'proposed change' : 'needs your choice'}</span>
          <h4>{plan.title}</h4>
          <p>{plan.summary}</p>
        </div>
        <Badge tone={applied ? 'ok' : plan.status === 'ready' ? 'warn' : 'info'}>{applied ? 'revision created' : plan.status.replace('_', ' ')}</Badge>
      </div>

      <p className="copilot__rationale">{plan.rationale}</p>

      {plan.steps.length > 0 ? (
        <div className="copilot__steps">
          {plan.steps.map((step, index) => (
            <div key={`${step.label}-${index}`} className={`copilot__step copilot__step--${step.tone}`}>
              <span className="copilot__step-number">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{step.label}</strong><small>{step.detail}</small></span>
            </div>
          ))}
        </div>
      ) : null}

      {preview ? <DiffSummary preview={preview} /> : null}

      {plan.suggestions && plan.suggestions.length > 0 ? (
        <div className="copilot__choices">
          {plan.suggestions.map((suggestion) => <span key={suggestion} className="chip">{suggestion}</span>)}
        </div>
      ) : null}

      <div className="copilot__review-actions">
        {ready && !applied ? (
          <button type="button" className="btn btn--primary" disabled={busy} onClick={onApply}>{busy ? 'applying…' : 'apply reviewed change'}</button>
        ) : null}
        <button type="button" className="btn" disabled={busy} onClick={onDismiss}>{applied ? 'plan another change' : 'discard plan'}</button>
        {preview && preview.rejected.length > 0 ? <span className="copilot__warning">{preview.rejected.length} stage(s) need attention; validation will call them out.</span> : null}
      </div>
    </div>
  );
}

function DiffSummary({ preview }: { preview: NonNullable<HardwareEditPlan['preview']> }) {
  return (
    <div className="copilot__diff" aria-label="Hardware edit preview">
      <div className="copilot__diff-head">
        <span>reviewable diff</span>
        <span>before → after</span>
      </div>
      {preview.parts.length > 0 ? (
        <div className="copilot__part-diffs">
          {preview.parts.map((part, index) => (
            <div key={`${part.detail}-${index}`} className={`copilot__part-diff copilot__part-diff--${part.kind}`}>
              <span>{part.kind === 'added' ? '+' : part.kind === 'removed' ? '−' : '~'}</span>
              <span>{part.before ?? '—'}</span><i>→</i><strong>{part.after ?? '—'}</strong>
            </div>
          ))}
        </div>
      ) : <Empty>No BOM rows changed; the request may already match this build.</Empty>}
      <div className="copilot__metrics">
        <span><strong>{preview.pins.before} → {preview.pins.after}</strong><small>pins</small></span>
        <span><strong>{preview.wires.before} → {preview.wires.after}</strong><small>wires</small></span>
        <span><strong>{preview.firmware.changed ? 'changed' : 'unchanged'}</strong><small>firmware</small></span>
        <span><strong>{preview.applied}</strong><small>gated steps</small></span>
      </div>
    </div>
  );
}
