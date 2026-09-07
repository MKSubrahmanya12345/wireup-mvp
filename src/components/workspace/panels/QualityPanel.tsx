'use client';

/**
 * CHECK & FIX — the honest verdict on the build. Leads with passed / what's
 * wrong; the individual checks, issue codes, origins and the model review are
 * only revealed under "details".
 */

import { useMemo, useState } from 'react';

import { Badge, Card, Empty, Loader, Notice, SectionTitle, SeverityBadge } from '../ui';
import { plural } from '@/lib/project-presentation';
import { useHub } from '../hub-context';

const SEVERITY_ICON: Record<'error' | 'warning' | 'info', string> = {
  error: '✕',
  warning: '!',
  info: 'i',
};

export function QualityPanel() {
  const { project, running, details } = useHub();
  const validation = project?.validation ?? null;
  const [showAll, setShowAll] = useState(false);

  const issues = validation?.issues ?? [];
  const shown = showAll ? issues : issues.slice(0, 20);

  if (!validation) {
    return (
      <Card title="Check & fix" wide count="not run">
        {running ? (
          <Loader label="Checking the build and fixing what's wrong" />
        ) : (
          <Empty>Validation hasn't run for this build.</Empty>
        )}
      </Card>
    );
  }

  const { summary, modelReview } = validation;
  const autoFixable = issues.filter((issue) => issue.autoFixable).length;
  const errors = summary.errors;
  const verdictText = validation.passed
    ? errors === 0
      ? "This build passed every check."
      : "This build is good to go."
    : errors > 0
      ? `${plural(errors, 'issue')} need${errors === 1 ? 's' : ''} fixing.`
      : 'A few warnings to look at.';

  return (
    <Card
      title="Check & fix"
      wide
      count={validation.passed ? 'passed' : `${errors} issue${errors === 1 ? '' : 's'}`}
      actions={
        <span className="row row--tight">
          <Badge tone={validation.passed ? 'ok' : 'err'}>{validation.passed ? 'passed' : 'action needed'}</Badge>
        </span>
      }
      footer={
        <span>
          {plural(summary.errors, 'error')} · {plural(summary.warnings, 'warning')} · {plural(summary.info, 'info')}
          {details ? ` · ${summary.checksPassed}/${summary.checksRun} checks passed` : ''}
        </span>
      }
    >
      <div className="quality__verdict">
        <span className={`quality__verdict-icon ${validation.passed ? 'quality__verdict-icon--ok' : 'quality__verdict-icon--bad'}`}>{validation.passed ? '✓' : '!'}</span>
        <span className="quality__verdict-text">{verdictText}</span>
        {autoFixable > 0 ? <span className="quality__verdict-sub">{plural(autoFixable, 'issue')} can be fixed automatically.</span> : null}
      </div>

      {validation.engineError ? <Notice tone="warn" title="Validation was incomplete">{validation.engineError}</Notice> : null}

      <SectionTitle>Issues</SectionTitle>
      {issues.length === 0 ? (
        <Empty>No issues — the design passed every check.</Empty>
      ) : shown.length === 0 ? (
        <Empty>Nothing to show.</Empty>
      ) : (
        shown.map((issue) => (
          <div className="issue" key={issue.id}>
            <span className={`issue__sev issue__sev--${issue.severity}`}>{SEVERITY_ICON[issue.severity]}</span>
            <span>
              <span className="issue__msg">{issue.message}</span>
              {issue.fixHint ? <span className="issue__hint">Fix: {issue.fixHint}</span> : null}
              {details ? (
                <span className="issue__meta">
                  <SeverityBadge severity={issue.severity} />
                  <span>{issue.code}</span>
                  <span>·</span>
                  <span>origin {issue.origin}</span>
                  {issue.autoFixable ? <Badge tone="info">auto-fixable</Badge> : <Badge>manual</Badge>}
                  {issue.domain ? <span>· {issue.domain}</span> : null}
                </span>
              ) : null}
            </span>
          </div>
        ))
      )}

      {issues.length > shown.length ? (
        <button type="button" className="btn btn--sm" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>
          show all {issues.length} issues
        </button>
      ) : null}
      {showAll ? (
        <button type="button" className="btn btn--sm" style={{ marginTop: 8 }} onClick={() => setShowAll(false)}>
          show fewer
        </button>
      ) : null}

      {details ? (
        <>
          <SectionTitle>Checks</SectionTitle>
          {validation.checks.map((check) => (
            <div className="check" key={check.id}>
              <span className={`check__icon ${check.status === 'passed' ? 'check__icon--passed' : check.status === 'failed' ? 'check__icon--failed' : 'check__icon--skipped'}`}>
                {check.status === 'passed' ? '✓' : check.status === 'failed' ? '✕' : '–'}
              </span>
              <span>
                <span className="check__name">{check.name}</span> <span className="check__domain">{check.domain}</span>
              </span>
              <span className="check__msg">{check.message}</span>
            </div>
          ))}
        </>
      ) : null}

      {modelReview && modelReview.notes.length > 0 && details ? (
        <>
          <SectionTitle>Model review</SectionTitle>
          <ul className="list list--tight">
            {modelReview.notes.map((note) => (
              <li key={note} className="small">
                {note}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
