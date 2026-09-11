'use client';

/**
 * Project Atlas — the domain-neutral "clone → read → graph → quantify →
 * transform" surface. It intentionally feels like an agent workspace, but the
 * server owns the snapshot and the generated files so the human can reject or
 * steer before anything is treated as a project output.
 */

import { useState } from 'react';

import type { AtlasTargetSpec, ProjectAtlasState } from '@/types/project-atlas';
import { analyzeProjectAtlas, applyProjectAtlas } from './api';
import { useHub } from './hub-context';
import { Badge, Card, DownloadButton, Empty } from './ui';

const DEFAULT_SOURCE = `Guitar profile
body: mahogany
neck: maple
fretboard: rosewood
strings: 6
scale length: 25.5 in
pickups: 2 humbuckers
tuning: standard E
finish: sunburst`;

export function ProjectAtlas() {
  const { project, running, refresh } = useHub();
  const [source, setSource] = useState(project?.atlas?.sources[0]?.content ?? DEFAULT_SOURCE);
  const [title, setTitle] = useState(project?.atlas?.sources[0]?.title ?? 'Guitar profile');
  const [language, setLanguage] = useState(project?.atlas?.transform?.target.language ?? 'java');
  const [packageName, setPackageName] = useState(project?.atlas?.transform?.target.packageName ?? 'generated');
  const [atlas, setAtlas] = useState<ProjectAtlasState | null>(project?.atlas ?? null);
  const [busy, setBusy] = useState(false);
  const [showPlan, setShowPlan] = useState(true);
  const [applied, setApplied] = useState(project?.atlas?.transform?.status === 'applied');
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;

  const target: AtlasTargetSpec = { language, packageName };
  const plan = atlas?.transform ?? null;
  const canRun = !running && source.trim().length >= 8 && !busy;

  const analyze = async (): Promise<void> => {
    if (!canRun) return;
    setBusy(true);
    setApplied(false);
    setShowPlan(true);
    setError(null);
    try {
      const result = await analyzeProjectAtlas(project.id, { title, kind: 'profile', content: source }, target);
      setAtlas(result.atlas);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    if (!atlas || !plan || plan.status !== 'ready' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyProjectAtlas(project.id, atlas.version, target);
      setAtlas(result.atlas);
      setApplied(Boolean(result.applied));
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Project Atlas"
      wide
      count="clone · graph · quantify · transform"
      actions={<Badge tone={applied ? 'ok' : running ? 'warn' : 'info'}>{applied ? 'projection applied' : running ? 'locked while building' : 'human review boundary'}</Badge>}
    >
      <div className="atlas__intro">
        <div>
          <p className="atlas__eyebrow">state compiler / source intelligence</p>
          <h3 className="atlas__title">Give the agent a source. Keep the map.</h3>
          <p className="atlas__copy">
            Atlas clones the source, reads it into evidence-backed nodes and edges, counts what is known, then proposes a typed target project. Unknowns stay visible instead of becoming confident fiction.
          </p>
        </div>
        <div className="atlas__loop" aria-label="Project Atlas workflow">
          <span>source</span><i>→</i><span>graph</span><i>→</i><span>numbers</span><i>→</i><span>target</span>
        </div>
      </div>

      <div className="atlas__composer">
        <div className="atlas__source-head">
          <label className="atlas__label" htmlFor="atlas-title">source label</label>
          <input id="atlas-title" className="atlas__title-input" value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <textarea
          className="atlas__input"
          value={source}
          disabled={busy}
          rows={7}
          aria-label="Source profile or document"
          onChange={(event) => setSource(event.target.value)}
          placeholder={DEFAULT_SOURCE}
        />
        <div className="atlas__target-row">
          <label className="atlas__label" htmlFor="atlas-language">target language</label>
          <select id="atlas-language" className="atlas__select" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value)}>
            <option value="java">Java project</option>
            <option value="typescript">TypeScript adapter (roadmap)</option>
            <option value="python">Python adapter (roadmap)</option>
            <option value="json-schema">JSON Schema adapter (roadmap)</option>
          </select>
          <label className="atlas__label" htmlFor="atlas-package">package</label>
          <input id="atlas-package" className="atlas__package" value={packageName} disabled={busy} onChange={(event) => setPackageName(event.target.value)} />
          {project.prompt ? <button type="button" className="btn btn--sm" disabled={busy} onClick={() => { setSource(project.prompt); setTitle('Current project brief'); }}>use project brief</button> : null}
          <button type="button" className="btn btn--primary atlas__button" disabled={!canRun} onClick={() => void analyze()}>
            {busy ? 'mapping…' : 'clone · read · graph'}
          </button>
        </div>
      </div>
      <p className="atlas__hint">The source is snapshotted server-side. Apply re-reads that snapshot and never trusts generated files from the browser.</p>

      {atlas ? <AtlasReadout atlas={atlas} /> : <Empty>Run Atlas on a profile, specification, code excerpt or any structured note to create the first measurable project state.</Empty>}

      {plan && showPlan ? (
        <AtlasTransformReview
          plan={plan}
          applied={applied || plan.status === 'applied'}
          busy={busy}
          onApply={() => void apply()}
          onDismiss={() => setShowPlan(false)}
        />
      ) : null}

      {atlas?.transform && !showPlan ? (
        <button type="button" className="btn btn--sm atlas__reopen" onClick={() => setShowPlan(true)}>show transformation plan</button>
      ) : null}
      {error ? <p className="atlas__error" role="alert">{error}</p> : null}
    </Card>
  );
}

function AtlasReadout({ atlas }: { atlas: ProjectAtlasState }) {
  const q = atlas.quantification;
  const graphNodes = atlas.nodes.filter((node) => node.kind !== 'source' && node.kind !== 'text_unit').slice(0, 12);
  const graphEdges = atlas.edges.filter((edge) => edge.kind !== 'contains').slice(0, 10);

  return (
    <div className="atlas__readout">
      <div className="atlas__metrics" aria-label="Project Atlas measurements">
        <Metric value={q.sourceCount} label="sources" />
        <Metric value={q.nodeCount} label="nodes" />
        <Metric value={q.edgeCount} label="edges" />
        <Metric value={q.metricCount} label="measured facts" />
        <Metric value={`${Math.round(q.coverage * 100)}%`} label="coverage" />
        <Metric value={`${Math.round(q.confidence * 100)}%`} label="confidence" />
      </div>

      <div className="atlas__graph-grid">
        <div className="atlas__graph-card">
          <div className="atlas__section-head"><span>evidence graph</span><span>v{atlas.version}</span></div>
          {graphNodes.length > 0 ? (
            <div className="atlas__nodes">
              {graphNodes.map((node) => (
                <div key={node.id} className={`atlas__node atlas__node--${node.status}`}>
                  <span className="atlas__node-kind">{node.kind.replace('_', ' ')}</span>
                  <strong>{node.label}</strong>
                  <small>{node.value !== undefined ? `${node.value}${node.unit ? ` ${node.unit}` : ''}` : node.description}</small>
                </div>
              ))}
            </div>
          ) : <Empty>No nodes extracted yet.</Empty>}
        </div>
        <div className="atlas__graph-card">
          <div className="atlas__section-head"><span>relationships</span><span>{atlas.metrics.length} quantified</span></div>
          {graphEdges.length > 0 ? (
            <div className="atlas__edges">
              {graphEdges.map((edge) => {
                const from = atlas.nodes.find((node) => node.id === edge.from)?.label ?? edge.from;
                const to = atlas.nodes.find((node) => node.id === edge.to)?.label ?? edge.to;
                return <div key={edge.id} className="atlas__edge"><strong>{from}</strong><i>{edge.kind.replace('_', ' ')}</i><strong>{to}</strong><small>{Math.round(edge.confidence * 100)}% evidence</small></div>;
              })}
            </div>
          ) : <Empty>No relationships extracted yet.</Empty>}
        </div>
      </div>
    </div>
  );
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return <span className="atlas__metric"><strong>{value}</strong><small>{label}</small></span>;
}

function AtlasTransformReview({
  plan,
  applied,
  busy,
  onApply,
  onDismiss,
}: {
  plan: NonNullable<ProjectAtlasState['transform']>;
  applied: boolean;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const download = JSON.stringify({ target: plan.target, files: plan.files }, null, 2);
  const ready = plan.status === 'ready' && plan.files.length > 0;

  return (
    <div className={`atlas__review${plan.status !== 'ready' && plan.status !== 'applied' ? ' atlas__review--question' : ''}`}>
      <div className="atlas__review-head">
        <div>
          <span className="atlas__review-kicker">{applied ? 'applied / persisted' : plan.status === 'ready' ? 'proposed target project' : 'adapter status'}</span>
          <h4>{plan.title}</h4>
          <p>{plan.summary}</p>
        </div>
        <Badge tone={applied ? 'ok' : plan.status === 'ready' ? 'warn' : 'info'}>{applied ? 'state saved' : plan.status.replace('_', ' ')}</Badge>
      </div>
      <p className="atlas__rationale">{plan.rationale}</p>

      {plan.steps.length > 0 ? (
        <div className="atlas__steps">
          {plan.steps.map((step, index) => (
            <div key={step.id} className={`atlas__step atlas__step--${step.status}`}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </div>
          ))}
        </div>
      ) : null}

      {plan.files.length > 0 ? (
        <div className="atlas__files">
          <div className="atlas__section-head"><span>generated project files</span><span>{plan.metrics.generatedLines} lines</span></div>
          {plan.files.map((file) => <div key={file.path} className="atlas__file"><code>{file.path}</code><span>{file.purpose}</span></div>)}
        </div>
      ) : null}

      {plan.mappings.length > 0 ? (
        <div className="atlas__mapping">
          <div className="atlas__section-head"><span>source → target mappings</span><span>{plan.metrics.mappedFacts} / {plan.metrics.inputFacts}</span></div>
          {plan.mappings.slice(0, 8).map((mapping) => <div key={`${mapping.sourceNodeId}-${mapping.targetPath}`} className="atlas__mapping-row"><span>{mapping.sourceLabel}</span><i>→</i><code>{mapping.targetPath}: {mapping.targetType}</code><small>{Math.round(mapping.confidence * 100)}%</small></div>)}
        </div>
      ) : null}

      {plan.gaps.length > 0 ? (
        <div className="atlas__gaps"><strong>human-visible gaps</strong>{plan.gaps.map((gap) => <span key={gap}>• {gap}</span>)}</div>
      ) : null}

      <div className="atlas__review-actions">
        {ready && !applied ? <button type="button" className="btn btn--primary" disabled={busy} onClick={onApply}>{busy ? 'persisting…' : 'apply reviewed projection'}</button> : null}
        {plan.files.length > 0 ? <DownloadButton filename="atlas-java-project.json" content={download} label="download source bundle" mime="application/json" /> : null}
        <button type="button" className="btn" disabled={busy} onClick={onDismiss}>{applied ? 'hide plan' : 'discard view'}</button>
      </div>
    </div>
  );
}
