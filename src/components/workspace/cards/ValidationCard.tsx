'use client';

/**
 * VALIDATION card — the deterministic rule engine plus the model review, with
 * every issue, its target and whether the fixer can repair it automatically.
 */

import { useMemo, useState } from 'react';

import type { ValidationIssue } from '@/types/validation';

import { Badge, Card, Empty, Loader, Notice, SectionTitle, SeverityBadge } from '../ui';
import { formatTime, plural, type CardProps } from './types';

type SeverityFilter = 'all' | 'error' | 'warning' | 'info';
type OriginFilter = 'all' | 'rules' | 'model';

const SEVERITY_ICON: Record<ValidationIssue['severity'], string> = {
  error: '✕',
  warning: '!',
  info: 'i',
};

function targetLabel(issue: ValidationIssue): string | null {
  const target = issue.target;
  if (!target) return null;
  const parts: string[] = [target.artifact];
  if (target.componentInstanceId) parts.push(target.componentInstanceId);
  if (target.componentId) parts.push(target.componentId);
  if (target.pin) parts.push(`pin ${target.pin}`);
  if (target.connectionId) parts.push(target.connectionId);
  if (target.assignmentId) parts.push(target.assignmentId);
  if (target.filePath) parts.push(target.filePath);
  if (target.library) parts.push(target.library);
  if (target.sectionId) parts.push(`§${target.sectionId}`);
  return parts.join(' · ');
}

export function ValidationCard({ project, running, activity }: CardProps) {
  const validation = project?.validation ?? null;
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [origin, setOrigin] = useState<OriginFilter>('all');
  const [showChecks, setShowChecks] = useState(false);

  const issues = validation?.issues ?? [];
  const visible = useMemo(
    () =>
      issues.filter(
        (issue) => (severity === 'all' || issue.severity === severity) && (origin === 'all' || issue.origin === origin),
      ),
    [issues, origin, severity],
  );

  if (!validation) {
    return (
      <Card title="Validation" wide count="not run">
        {running ? (
          <Loader label="Running the deterministic rule engine and the model review" detail={activity} />
        ) : (
          <Empty>Validation has not run for this project.</Empty>
        )}
      </Card>
    );
  }

  const { summary } = validation;
  const review = validation.modelReview ?? null;
  const autoFixable = issues.filter((issue) => issue.autoFixable).length;

  return (
    <Card
      title="Validation"
      wide
      count={`iteration ${validation.iteration + 1}`}
      actions={
        <span className="row row--tight">
          <Badge tone={validation.passed ? 'ok' : 'err'}>{validation.passed ? 'passed' : 'failed'}</Badge>
          <button type="button" className="filter" onClick={() => setShowChecks((current) => !current)}>
            {showChecks ? 'hide checks' : `checks (${validation.checks.length})`}
          </button>
        </span>
      }
      footer={
        <span>
          {summary.checksPassed}/{summary.checksRun} checks passed · {validation.durationMs} ms ·{' '}
          {formatTime(validation.checkedAt)} · {review ? 'deterministic engine + model review' : 'deterministic engine only'}
        </span>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <Badge tone={summary.errors > 0 ? 'err' : 'ok'}>{plural(summary.errors, 'error')}</Badge>
        <Badge tone={summary.warnings > 0 ? 'warn' : 'neutral'}>{plural(summary.warnings, 'warning')}</Badge>
        <Badge>{plural(summary.info, 'info')}</Badge>
        <Badge tone={autoFixable > 0 ? 'info' : 'neutral'}>{plural(autoFixable, 'auto-fixable issue')}</Badge>
        {review ? (
          <Badge tone={review.verdict === 'approve' ? 'ok' : review.verdict === 'reject' ? 'err' : 'warn'}>
            model: {review.verdict} · {Math.round(review.confidence * 100)}%
          </Badge>
        ) : (
          <Badge tone="neutral">model review: not run</Badge>
        )}
      </div>

      {validation.engineError ? <Notice tone="warn" title="Validation degraded">{validation.engineError}</Notice> : null}

      {review && review.notes.length > 0 ? (
        <>
          <SectionTitle>Model review notes</SectionTitle>
          <ul className="list list--tight">
            {review.notes.map((note) => (
              <li key={note} className="small">
                {note}
              </li>
            ))}
          </ul>
          {review.model ? <p className="faint mono-sm">reviewed by {review.model}</p> : null}
        </>
      ) : null}

      {showChecks ? (
        <>
          <SectionTitle>Checks</SectionTitle>
          {validation.checks.map((check) => (
            <div className="check" key={check.id}>
              <span
                className={`check__icon ${
                  check.status === 'passed' ? 'check__icon--passed' : check.status === 'failed' ? 'check__icon--failed' : 'check__icon--skipped'
                }`}
              >
                {check.status === 'passed' ? '✓' : check.status === 'failed' ? '✕' : '–'}
              </span>
              <span>
                <span className="check__name">{check.name}</span> <span className="check__domain">{check.domain}</span>
              </span>
              <span className="faint mono-sm">{check.issueIds.length > 0 ? `${check.issueIds.length} issue(s)` : ''}</span>
              <span className="check__msg">{check.message}</span>
            </div>
          ))}
        </>
      ) : null}

      <SectionTitle>Issues</SectionTitle>
      <div className="filters">
        {(['all', 'error', 'warning', 'info'] as SeverityFilter[]).map((option) => (
          <button
            key={option}
            type="button"
            className={severity === option ? 'filter filter--active' : 'filter'}
            onClick={() => setSeverity(option)}
          >
            {option}
          </button>
        ))}
        <span style={{ width: 8 }} />
        {(['all', 'rules', 'model'] as OriginFilter[]).map((option) => (
          <button
            key={option}
            type="button"
            className={origin === option ? 'filter filter--active' : 'filter'}
            onClick={() => setOrigin(option)}
          >
            {option === 'all' ? 'any origin' : option}
          </button>
        ))}
        <span className="card__spacer" style={{ flex: 1 }} />
        <span className="faint mono-sm">{plural(visible.length, 'issue')} shown</span>
      </div>

      {visible.length === 0 ? (
        <Empty>{issues.length === 0 ? 'No issues — the design passed every check.' : 'No issues match these filters.'}</Empty>
      ) : (
        visible.map((issue) => (
          <div className="issue" key={issue.id}>
            <span className={`issue__sev issue__sev--${issue.severity}`}>{SEVERITY_ICON[issue.severity]}</span>
            <span>
              <span className="issue__msg">{issue.message}</span>
              <span className="issue__meta">
                <span>{issue.code}</span>
                <span>·</span>
                <span>{issue.domain}</span>
                <span>·</span>
                <SeverityBadge severity={issue.severity} />
                <span>·</span>
                <span>origin {issue.origin}</span>
                {issue.autoFixable ? <Badge tone="info">auto-fixable</Badge> : <Badge>manual</Badge>}
                {targetLabel(issue) ? <span>· {targetLabel(issue)}</span> : null}
              </span>
              {issue.details ? <span className="issue__hint">details: {issue.details}</span> : null}
              {issue.fixHint ? <span className="issue__hint">fix hint: {issue.fixHint}</span> : null}
            </span>
          </div>
        ))
      )}
    </Card>
  );
}
