'use client';

/**
 * AGENT card — the run itself: revisions (initial → fix → final), the exact
 * changeset each revision applied, the deterministic diff against the previous
 * revision, the stage timeline and every model call with its token usage.
 */

import { useMemo, useState } from 'react';

import type { AgentEvent } from '@/types/generation';
import type { ProjectRevision, RevisionSnapshot } from '@/types/project';

import { Badge, Card, Empty, Notice, SectionTitle, SeverityBadge } from '../ui';
import { formatTime, plural, type CardProps } from './types';

interface AgentCardProps extends CardProps {
  events: AgentEvent[];
}

interface DiffEntry {
  label: string;
  before: number | string;
  after: number | string;
  changed: boolean;
}

function diffSnapshots(before: RevisionSnapshot | undefined, after: RevisionSnapshot): DiffEntry[] {
  if (!before) {
    return [
      { label: 'components', before: 0, after: after.components.length, changed: true },
      { label: 'pin assignments', before: 0, after: after.pinAssignments.length, changed: true },
      { label: 'wires', before: 0, after: after.wiring?.connections.length ?? 0, changed: true },
      { label: 'firmware files', before: 0, after: after.code?.files.length ?? 0, changed: true },
      { label: 'libraries', before: 0, after: after.libraries?.libraries.length ?? 0, changed: true },
      { label: 'diagram parts', before: 0, after: after.diagram?.components.length ?? 0, changed: true },
      { label: 'instruction sections', before: 0, after: after.instructions?.sections.length ?? 0, changed: true },
    ];
  }

  const movedPins = after.pinAssignments.filter((assignment) => {
    const previous = before.pinAssignments.find((entry) => entry.id === assignment.id);
    return !previous || previous.pin !== assignment.pin || previous.targetPin !== assignment.targetPin;
  });
  const beforeWireKeys = new Set((before.wiring?.connections ?? []).map((connection) => `${connection.from.instanceId}.${connection.from.pin}<->${connection.to.instanceId}.${connection.to.pin}`));
  const newWires = (after.wiring?.connections ?? []).filter(
    (connection) => !beforeWireKeys.has(`${connection.from.instanceId}.${connection.from.pin}<->${connection.to.instanceId}.${connection.to.pin}`),
  );
  const changedFiles = (after.code?.files ?? []).filter((file) => {
    const previous = before.code?.files.find((entry) => entry.path === file.path);
    return !previous || previous.content !== file.content;
  });
  const instanceBefore = before.components.flatMap((selection) => selection.instances.map((instance) => instance.instanceId));
  const instanceAfter = after.components.flatMap((selection) => selection.instances.map((instance) => instance.instanceId));
  const addedInstances = instanceAfter.filter((instanceId) => !instanceBefore.includes(instanceId));
  const removedInstances = instanceBefore.filter((instanceId) => !instanceAfter.includes(instanceId));

  return [
    { label: 'component instances', before: instanceBefore.length, after: instanceAfter.length, changed: instanceBefore.length !== instanceAfter.length },
    { label: 'pin assignments', before: before.pinAssignments.length, after: after.pinAssignments.length, changed: before.pinAssignments.length !== after.pinAssignments.length },
    { label: 'pins moved / retargeted', before: '—', after: movedPins.length, changed: movedPins.length > 0 },
    { label: 'wires', before: before.wiring?.connections.length ?? 0, after: after.wiring?.connections.length ?? 0, changed: newWires.length > 0 },
    { label: 'firmware files touched', before: before.code?.files.length ?? 0, after: changedFiles.length, changed: changedFiles.length > 0 },
    { label: 'libraries', before: before.libraries?.libraries.length ?? 0, after: after.libraries?.libraries.length ?? 0, changed: (before.libraries?.libraries.length ?? 0) !== (after.libraries?.libraries.length ?? 0) },
    { label: 'diagram parts', before: before.diagram?.components.length ?? 0, after: after.diagram?.components.length ?? 0, changed: (before.diagram?.components.length ?? 0) !== (after.diagram?.components.length ?? 0) },
    { label: 'instruction sections', before: before.instructions?.sections.length ?? 0, after: after.instructions?.sections.length ?? 0, changed: (before.instructions?.sections.length ?? 0) !== (after.instructions?.sections.length ?? 0) },
    { label: 'instances added', before: '—', after: addedInstances.length, changed: addedInstances.length > 0 },
    { label: 'instances removed', before: '—', after: removedInstances.length, changed: removedInstances.length > 0 },
  ];
}

function StageTimeline({ events }: { events: AgentEvent[] }) {
  const rows = useMemo(() => {
    const byStage = new Map<string, { stage: string; startedAt?: string; endedAt?: string; durationMs: number; events: number; failed: boolean }>();
    for (const event of events) {
      const stage = event.stage ?? 'idle';
      const entry = byStage.get(stage) ?? { stage, durationMs: 0, events: 0, failed: false };
      entry.events += 1;
      if (!entry.startedAt) entry.startedAt = event.timestamp;
      entry.endedAt = event.timestamp;
      if (typeof event.durationMs === 'number') entry.durationMs += event.durationMs;
      if (event.status === 'failed') entry.failed = true;
      byStage.set(stage, entry);
    }
    return Array.from(byStage.values());
  }, [events]);

  if (rows.length === 0) return <Empty>No stage activity yet.</Empty>;

  return (
    <div className="table-wrap">
      <table className="table table--mono">
        <thead>
          <tr>
            <th>stage</th>
            <th className="num">events</th>
            <th className="num">work time</th>
            <th>started</th>
            <th>ended</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.stage}>
              <td>{row.stage}</td>
              <td className="num">{row.events}</td>
              <td className="num">{row.durationMs > 0 ? `${(row.durationMs / 1000).toFixed(1)}s` : '—'}</td>
              <td className="faint">{row.startedAt ? new Date(row.startedAt).toLocaleTimeString(undefined, { hour12: false }) : '—'}</td>
              <td className="faint">{row.endedAt ? new Date(row.endedAt).toLocaleTimeString(undefined, { hour12: false }) : '—'}</td>
              <td>
                <Badge tone={row.failed ? 'err' : 'ok'}>{row.failed ? 'failure' : 'ok'}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentCard({ project, events }: AgentCardProps) {
  const revisions = project?.revisions ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'revisions' | 'stages' | 'calls'>('revisions');

  const activeRevision: ProjectRevision | null = useMemo(() => {
    if (revisions.length === 0) return null;
    if (selected !== null) return revisions.find((revision) => revision.version === selected) ?? revisions[revisions.length - 1] ?? null;
    return revisions[revisions.length - 1] ?? null;
  }, [revisions, selected]);

  const previousSnapshot = useMemo(() => {
    if (!activeRevision) return undefined;
    return revisions.find((revision) => revision.version === activeRevision.version - 1)?.snapshot;
  }, [activeRevision, revisions]);

  const fixEvents = useMemo(
    () => events.filter((event) => event.type === 'fix_change_applied' || event.type === 'fix_change_rejected'),
    [events],
  );

  const calls = project?.llm.calls ?? [];
  const tokens = calls.reduce(
    (total, call) => ({
      input: total.input + (call.inputTokens ?? 0),
      output: total.output + (call.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );

  return (
    <Card
      title="Agent"
      wide
      count={`${plural(revisions.length, 'revision')} · ${plural(calls.length, 'model call')}`}
      actions={
        <span className="row row--tight">
          {(['revisions', 'stages', 'calls'] as const).map((option) => (
            <button key={option} type="button" className={tab === option ? 'filter filter--active' : 'filter'} onClick={() => setTab(option)}>
              {option}
            </button>
          ))}
        </span>
      }
      footer={
        <span>
          {project ? `iteration ${project.iteration.current}/${project.iteration.max}` : '—'} · model{' '}
          <span className="mono-sm">{project?.llm.model ?? 'not configured'}</span> · validation model{' '}
          <span className="mono-sm">{project?.llm.validationModel ?? 'not configured'}</span> · tokens {tokens.input} in /{' '}
          {tokens.output} out
        </span>
      }
    >
      {project?.error ? (
        <Notice tone="err" title={`Run failed during ${project.error.stage} (${project.error.code})`}>
          {project.error.message}
          {project.error.details ? <div className="mono-sm" style={{ marginTop: 4 }}>{project.error.details}</div> : null}
          {project.error.retryable ? <div className="small" style={{ marginTop: 4 }}>This failure was retryable.</div> : null}
        </Notice>
      ) : null}

      {tab === 'revisions' ? (
        revisions.length === 0 ? (
          <Empty>No revision has been frozen yet — v1 is created as soon as the initial build completes.</Empty>
        ) : (
          <>
            <div className="revisions">
              {revisions.map((revision) => (
                <button
                  key={revision.version}
                  type="button"
                  className={activeRevision?.version === revision.version ? 'revision revision--active' : 'revision'}
                  onClick={() => setSelected(revision.version)}
                >
                  <span className="revision__head">
                    v{revision.version}
                    {revision.validation ? (
                      <Badge tone={revision.validation.passed ? 'ok' : revision.validation.errors > 0 ? 'err' : 'warn'}>
                        {revision.validation.passed ? 'passed' : `${revision.validation.errors} err`}
                      </Badge>
                    ) : (
                      <Badge>not validated</Badge>
                    )}
                  </span>
                  <span className="revision__reason">{revision.reason.replace(/_/g, ' ')}</span>
                  <span className="revision__summary">{formatTime(revision.createdAt)}</span>
                </button>
              ))}
            </div>

            {activeRevision ? (
              <>
                <SectionTitle>
                  Revision v{activeRevision.version} — {activeRevision.reason.replace(/_/g, ' ')}
                </SectionTitle>
                <p className="small" style={{ marginTop: 0 }}>
                  {activeRevision.summary}
                </p>
                <div className="row row--tight" style={{ marginBottom: 8 }}>
                  <Badge tone={activeRevision.reason === 'initial_generation' ? 'neutral' : 'info'}>stage: {activeRevision.stage}</Badge>
                  <Badge>{formatTime(activeRevision.createdAt)}</Badge>
                  {activeRevision.validation ? (
                    <Badge tone={activeRevision.validation.passed ? 'ok' : 'err'}>
                      validation motivating this revision: {activeRevision.validation.passed ? 'passed' : `${activeRevision.validation.errors} error(s), ${activeRevision.validation.warnings} warning(s)`}
                    </Badge>
                  ) : null}
                  <Badge>{plural(activeRevision.addressedIssueIds.length, 'issue')} addressed</Badge>
                </div>

                {activeRevision.changes.length > 0 ? (
                  <>
                    <SectionTitle>Changeset ({activeRevision.changes.length})</SectionTitle>
                    {activeRevision.changes.map((change) => (
                      <div className="change" key={change.id}>
                        <span className="change__head">
                          <span className="change__op">{change.op}</span>
                          <Badge>{change.artifact}</Badge>
                          <Badge tone={change.origin === 'model' ? 'info' : 'neutral'}>{change.origin}</Badge>
                          {change.issueCode ? <Badge tone="warn">{change.issueCode}</Badge> : null}
                          <span className="faint mono-sm">{change.id}</span>
                        </span>
                        <span className="change__reason">{change.reason}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="small muted">No typed changes — this revision is the initial generation.</p>
                )}

                <SectionTitle>Diff against v{Math.max(1, activeRevision.version - 1)}</SectionTitle>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>artifact measure</th>
                        <th className="num">before</th>
                        <th className="num">after</th>
                        <th>changed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffSnapshots(previousSnapshot, activeRevision.snapshot).map((entry) => (
                        <tr key={entry.label}>
                          <td>{entry.label}</td>
                          <td className="num">{entry.before}</td>
                          <td className="num">{entry.after}</td>
                          <td>
                            <Badge tone={entry.changed ? 'warn' : 'neutral'}>{entry.changed ? 'yes' : 'no'}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {activeRevision.snapshot.code ? (
                  <>
                    <SectionTitle>Firmware in this revision</SectionTitle>
                    <ul className="list list--tight">
                      {activeRevision.snapshot.code.files.map((file) => (
                        <li key={file.path} className="small mono-sm">
                          {file.path} · {file.content.split('\n').length} lines · {file.generatedBy}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : null}

            <SectionTitle>Fix activity from the event log</SectionTitle>
            {fixEvents.length === 0 ? (
              <Empty>No fix changes have been attempted.</Empty>
            ) : (
              <>
                <div className="row row--tight" style={{ marginBottom: 6 }}>
                  <Badge tone="ok">
                    {plural(
                      fixEvents.filter((event) => event.type === 'fix_change_applied').length,
                      'change applied',
                      'changes applied',
                    )}
                  </Badge>
                  <Badge tone="warn">
                    {plural(
                      fixEvents.filter((event) => event.type === 'fix_change_rejected').length,
                      'change rejected',
                      'changes rejected',
                    )}
                  </Badge>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>seq</th>
                        <th>outcome</th>
                        <th>op</th>
                        <th>detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fixEvents.slice(-24).map((event) => {
                        const metadata = (event.metadata ?? {}) as Record<string, unknown>;
                        return (
                          <tr key={event.id}>
                            <td className="mono-sm faint">{event.seq}</td>
                            <td>
                              <Badge tone={event.type === 'fix_change_applied' ? 'ok' : 'warn'}>
                                {event.type === 'fix_change_applied' ? 'applied' : 'rejected'}
                              </Badge>
                            </td>
                            <td className="mono-sm">{String(metadata.op ?? '—')}</td>
                            <td className="small muted">{String(metadata.detail ?? metadata.reason ?? event.message)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )
      ) : null}

      {tab === 'stages' ? (
        <>
          <SectionTitle>Stage timeline (from the persisted event log)</SectionTitle>
          <StageTimeline events={events} />
        </>
      ) : null}

      {tab === 'calls' ? (
        <>
          <SectionTitle>Model calls</SectionTitle>
          {calls.length === 0 ? (
            <Empty>
              No model calls were made — Amazon Bedrock is not configured, so everything was produced deterministically.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table table--mono">
                <thead>
                  <tr>
                    <th>op</th>
                    <th>model</th>
                    <th>iteration</th>
                    <th>status</th>
                    <th className="num">duration</th>
                    <th className="num">tokens in</th>
                    <th className="num">tokens out</th>
                    <th>error</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => (
                    <tr key={call.id}>
                      <td>{call.op}</td>
                      <td className="call__model">{call.model}</td>
                      <td className="num">{call.iteration ?? '—'}</td>
                      <td>
                        <Badge tone={call.status === 'ok' ? 'ok' : 'err'}>{call.status}</Badge>
                      </td>
                      <td className="num">{call.durationMs !== undefined ? `${(call.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                      <td className="num">{call.inputTokens ?? '—'}</td>
                      <td className="num">{call.outputTokens ?? '—'}</td>
                      <td className="small muted" style={{ fontFamily: 'var(--sans)' }}>
                        {call.error ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {project?.validation?.issues ? (
            <>
              <SectionTitle>Issue origins in the latest validation</SectionTitle>
              <div className="row row--tight">
                <Badge tone="neutral">
                  rules:{' '}
                  {plural(
                    project.validation.issues.filter((issue) => issue.origin === 'rules').length,
                    'issue',
                  )}
                </Badge>
                <Badge tone="info">
                  model:{' '}
                  {plural(
                    project.validation.issues.filter((issue) => issue.origin === 'model').length,
                    'issue',
                  )}
                </Badge>
                {project.validation.issues.slice(0, 3).map((issue) => (
                  <span key={issue.id}>
                    <SeverityBadge severity={issue.severity} /> <span className="mono-sm faint">{issue.code}</span>
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
