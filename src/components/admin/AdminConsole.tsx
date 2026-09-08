'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { CadComponentSpec } from 'cad-helper';
import { COMPONENT_PRESETS } from 'cad-helper';
import { CadPreviewCanvas } from '@/components/admin/CadPreviewCanvas';

type ViewId = 'overview' | 'graph' | 'doubts' | 'stakes' | 'cad-helper' | 'repositories' | 'activity';
type NodeStatus = 'complete' | 'active' | 'queued' | 'blocked';
type NodeKind = 'intent' | 'reasoning' | 'human' | 'evidence' | 'output';

type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  detail: string;
  owner: 'AI' | 'YOU';
  status: NodeStatus;
  position: { left: number; top: number };
};

type Doubt = {
  id: string;
  tag: string;
  question: string;
  context: string;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
};

const initialNodes: GraphNode[] = [
  {
    id: 'intent',
    kind: 'intent',
    label: 'Answer paper reviewers',
    detail: 'Create a point-by-point response that protects the claim and earns trust.',
    owner: 'YOU',
    status: 'complete',
    position: { left: 7, top: 39 },
  },
  {
    id: 'extract',
    kind: 'reasoning',
    label: 'Extract reviewer claims',
    detail: 'Separate requests, objections, evidence gaps and hidden assumptions.',
    owner: 'AI',
    status: 'complete',
    position: { left: 29, top: 18 },
  },
  {
    id: 'stakes',
    kind: 'evidence',
    label: 'Map real-world stakes',
    detail: 'What changes if this claim is accepted, misunderstood or ignored?',
    owner: 'AI',
    status: 'active',
    position: { left: 29, top: 61 },
  },
  {
    id: 'doubts',
    kind: 'reasoning',
    label: 'Resolve open doubts',
    detail: 'Keep asking until the answer is supported, scoped and honestly uncertain.',
    owner: 'AI',
    status: 'active',
    position: { left: 53, top: 18 },
  },
  {
    id: 'draft',
    kind: 'human',
    label: 'Draft response sections',
    detail: 'AI proposes. You choose the wording and add lived research context.',
    owner: 'YOU',
    status: 'queued',
    position: { left: 53, top: 61 },
  },
  {
    id: 'verify',
    kind: 'evidence',
    label: 'Evidence + countercheck',
    detail: 'Test the response against sources, reviewer intent and known failure modes.',
    owner: 'AI',
    status: 'queued',
    position: { left: 76, top: 39 },
  },
  {
    id: 'publish',
    kind: 'output',
    label: 'Submit with confidence',
    detail: 'A human-approved answer with a traceable decision history.',
    owner: 'YOU',
    status: 'queued',
    position: { left: 89, top: 39 },
  },
];

const initialDoubts: Doubt[] = [
  {
    id: 'doubt-1',
    tag: 'CLAIM SCOPE',
    question: 'Does reviewer 2 mean the method is invalid, or only that the boundary is underspecified?',
    context: 'Connected to “Extract reviewer claims” · 2 sources attached',
    priority: 'high',
    confidence: 62,
  },
  {
    id: 'doubt-2',
    tag: 'EVIDENCE',
    question: 'Which result actually supports the causal language in paragraph 4?',
    context: 'Connected to “Map real-world stakes” · needs your reading',
    priority: 'high',
    confidence: 48,
  },
  {
    id: 'doubt-3',
    tag: 'HUMAN CONTEXT',
    question: 'What would a practitioner do differently if this finding is true?',
    context: 'Connected to “Draft response sections” · no grounded answer yet',
    priority: 'medium',
    confidence: 35,
  },
  {
    id: 'doubt-4',
    tag: 'TERMINOLOGY',
    question: 'Are “robustness” and “reliability” being used as interchangeable terms here?',
    context: 'Connected to “Evidence + countercheck” · glossary candidate',
    priority: 'low',
    confidence: 71,
  },
];

const initialStakes = [
  {
    id: 'stake-1',
    name: 'Reader trust',
    summary: 'A reviewer should be able to see exactly what changed and why the claim still holds.',
    confidence: 88,
    evidence: ['response structure', 'scope note', 'reviewer 2'],
    color: 'violet',
  },
  {
    id: 'stake-2',
    name: 'Scientific integrity',
    summary: 'Do not turn a plausible interpretation into a stronger causal statement than the data supports.',
    confidence: 79,
    evidence: ['experiment 03', 'methods section', 'open doubt #2'],
    color: 'orange',
  },
  {
    id: 'stake-3',
    name: 'Practical consequence',
    summary: 'Make the real-world decision this work informs visible, including who bears the cost of being wrong.',
    confidence: 64,
    evidence: ['field note', 'stakeholder map'],
    color: 'blue',
  },
];

const navGroups: { label: string; items: { id: ViewId; label: string; icon: string; count?: string }[] }[] = [
  {
    label: 'Workspace',
    items: [
      { id: 'overview', label: 'Mission control', icon: 'grid' },
      { id: 'graph', label: 'Decision graph', icon: 'nodes' },
      { id: 'doubts', label: 'Doubt stack', icon: 'question', count: '07' },
      { id: 'stakes', label: 'Real-world stakes', icon: 'target' },
    ],
  },
  {
    label: 'Feature repos',
    items: [
      { id: 'cad-helper', label: 'cad-helper', icon: 'cube' },
      { id: 'repositories', label: 'All repositories', icon: 'folder' },
    ],
  },
  {
    label: 'Observe',
    items: [
      { id: 'activity', label: 'Activity log', icon: 'pulse' },
    ],
  },
];

const iconPaths: Record<string, string[]> = {
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  nodes: ['M6 6h4v4H6z', 'M14 14h4v4h-4z', 'M14 4h4v4h-4z', 'M6 16h4v4H6z', 'M10 8h4', 'M8 10v6', 'M14 8v6'],
  question: ['M9.2 9a3 3 0 1 1 5.4 1.8c-.9 1.1-2.6 1.3-2.6 3', 'M12 17h.01', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  cube: ['m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3z', 'm4.3 7.7 7.7 4.4 7.7-4.4', 'M12 12.1V21'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11z'],
  pulse: ['M3 12h4l2-7 4 14 2-7h6'],
  arrow: ['M5 12h13', 'm13 6 6 6-6 6'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['m5 12 4 4L19 6'],
  spark: ['m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3z'],
};

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths = iconPaths[name] ?? iconPaths.grid;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((path, index) => <path key={`${name}-${index}`} d={path} />)}
    </svg>
  );
}

function StatusDot({ status }: { status: NodeStatus | 'live' | 'ok' }) {
  return <span className={`control-status-dot control-status-dot--${status}`} aria-hidden="true" />;
}

function SectionHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return (
    <div className="control-section-heading">
      {eyebrow ? <div className="control-eyebrow">{eyebrow}</div> : null}
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

function MetricCard({ label, value, detail, trend, tone }: { label: string; value: string; detail: string; trend: string; tone: string }) {
  return (
    <div className={`control-metric control-metric--${tone}`}>
      <div className="control-metric__top"><span>{label}</span><span className="control-metric__trend">{trend}</span></div>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function GraphCanvas({ nodes, selectedId, onSelect, compact = false }: { nodes: GraphNode[]; selectedId: string; onSelect: (id: string) => void; compact?: boolean }) {
  return (
    <div className={`control-graph-canvas${compact ? ' control-graph-canvas--compact' : ''}`}>
      <div className="control-graph-canvas__legend">
        <span><i className="control-legend-dot control-legend-dot--ai" /> AI reasoning</span>
        <span><i className="control-legend-dot control-legend-dot--human" /> Human gate</span>
        <span><i className="control-legend-dot control-legend-dot--evidence" /> Evidence</span>
      </div>
      <svg className="control-graph-canvas__lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M16 50 C22 50 23 27 31 27" />
        <path d="M16 50 C22 50 24 70 31 70" />
        <path d="M39 27 C47 27 48 27 55 27" />
        <path d="M39 70 C47 70 48 70 55 70" />
        <path d="M63 27 C71 27 71 50 78 50" />
        <path d="M63 70 C71 70 71 50 78 50" />
        <path d="M84 50 C87 50 88 50 90 50" />
        <circle cx="31" cy="27" r="1.1" /><circle cx="55" cy="27" r="1.1" /><circle cx="78" cy="50" r="1.1" />
      </svg>
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          className={`control-graph-node control-graph-node--${node.kind}${node.id === selectedId ? ' is-selected' : ''}`}
          style={{ left: `${node.position.left}%`, top: `${node.position.top}%` }}
          onClick={() => onSelect(node.id)}
        >
          <span className="control-graph-node__kind"><StatusDot status={node.status} />{node.owner === 'YOU' ? 'HUMAN GATE' : node.kind.toUpperCase()}</span>
          <strong>{node.label}</strong>
          {!compact ? <small>{node.detail}</small> : null}
          <span className="control-graph-node__arrow"><Icon name="arrow" size={13} /></span>
        </button>
      ))}
    </div>
  );
}

function DoubtStack({ doubts, resolved, onResolve, onOpen }: { doubts: Doubt[]; resolved: string[]; onResolve: (id: string) => void; onOpen: () => void }) {
  const visible = doubts.filter((doubt) => !resolved.includes(doubt.id)).slice(0, 3);
  return (
    <section className="control-card control-doubt-card">
      <div className="control-card__heading">
        <div>
          <div className="control-card__eyebrow"><span className="control-live-pulse" /> NEVER-ENDING STACK</div>
          <h2>Doubts to resolve</h2>
        </div>
        <span className="control-count-pill">{doubts.length - resolved.length} open</span>
      </div>
      <p className="control-card__intro">The agent does not paper over uncertainty. Every answer makes the graph more grounded.</p>
      <div className="control-doubt-list">
        {visible.map((doubt) => (
          <div className="control-doubt" key={doubt.id}>
            <div className="control-doubt__top"><span className={`control-priority control-priority--${doubt.priority}`}>{doubt.priority}</span><span>{doubt.tag}</span></div>
            <button type="button" className="control-doubt__question" onClick={onOpen}>{doubt.question}</button>
            <div className="control-doubt__meta"><span>{doubt.context}</span><span>{doubt.confidence}% sure</span></div>
            <div className="control-confidence"><span style={{ width: `${doubt.confidence}%` }} /></div>
            <div className="control-doubt__actions">
              <button type="button" className="control-text-button" onClick={onOpen}>Inspect <Icon name="arrow" size={12} /></button>
              <button type="button" className="control-resolve-button" onClick={() => onResolve(doubt.id)}><Icon name="check" size={12} /> Mark resolved</button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="control-card__footer-link" onClick={onOpen}>Open full doubt stack <Icon name="arrow" size={13} /></button>
    </section>
  );
}

function StakeMiniCard({ stake }: { stake: (typeof initialStakes)[number] }) {
  return (
    <div className={`control-stake-mini control-stake-mini--${stake.color}`}>
      <div className="control-stake-mini__top"><span className="control-stake-icon"><Icon name="target" size={14} /></span><span>{stake.confidence}% grounded</span></div>
      <strong>{stake.name}</strong>
      <p>{stake.summary}</p>
      <div className="control-chip-row">{stake.evidence.map((item) => <span key={item}>{item}</span>)}</div>
    </div>
  );
}

function PromptComposer({ onSubmit, compact = false }: { onSubmit: (prompt: string) => void; compact?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <form className={`control-composer${compact ? ' control-composer--compact' : ''}`} onSubmit={(event) => { event.preventDefault(); if (value.trim()) { onSubmit(value.trim()); setValue(''); } }}>
      <span className="control-composer__spark"><Icon name="spark" size={16} /></span>
      <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={compact ? 'Add a step to this graph…' : 'Tell the system what you want to achieve…'} aria-label="New objective" />
      <span className="control-composer__hint">{compact ? 'Enter' : '⌘ ↵'}</span>
      <button type="submit" aria-label="Create objective"><Icon name="arrow" size={15} /></button>
    </form>
  );
}

function OverviewView({ nodes, selectedId, setSelectedId, doubts, resolved, onResolve, openView, addNode, onToast }: ViewProps) {
  return (
    <>
      <div className="control-hero-row">
        <SectionHeading eyebrow="CONTROL PLANE / 01" title="Mission control" description="A human-directed operating system for messy, high-stakes work." />
        <div className="control-hero-status"><StatusDot status="live" /><div><strong>Learning loop active</strong><span>Last update 2 min ago · 4 decisions recorded</span></div></div>
      </div>
      <PromptComposer onSubmit={(prompt) => addNode(prompt)} />
      <div className="control-metrics">
        <MetricCard label="Grounded concepts" value="12" detail="+3 this session" trend="↑ 33%" tone="violet" />
        <MetricCard label="Open doubts" value={String(doubts.length - resolved.length).padStart(2, '0')} detail="2 need your input" trend="attention" tone="orange" />
        <MetricCard label="Graph coverage" value="87%" detail="of current objective" trend="↑ 12%" tone="blue" />
        <MetricCard label="Human gates" value="04" detail="2 awaiting review" trend="active" tone="green" />
      </div>
      <div className="control-overview-grid">
        <section className="control-card control-graph-card">
          <div className="control-card__heading">
            <div><div className="control-card__eyebrow">LIVE OBJECTIVE / PAPER-RESPONSE-01</div><h2>Answer paper reviewers</h2></div>
            <button type="button" className="control-icon-button" onClick={() => openView('graph')} aria-label="Open graph"><Icon name="nodes" size={16} /></button>
          </div>
          <div className="control-graph-summary"><span><StatusDot status="active" /> AI is mapping consequences</span><span>7 nodes · 6 edges · v0.4</span></div>
          <GraphCanvas nodes={nodes} selectedId={selectedId} onSelect={setSelectedId} compact />
          <div className="control-graph-card__footer"><span><span className="control-avatar control-avatar--you">Y</span> Next gate: you review the claim boundary</span><button type="button" className="control-text-button" onClick={() => openView('graph')}>Edit graph <Icon name="arrow" size={12} /></button></div>
        </section>
        <DoubtStack doubts={doubts} resolved={resolved} onResolve={onResolve} onOpen={() => openView('doubts')} />
      </div>
      <div className="control-lower-grid">
        <section className="control-card">
          <div className="control-card__heading"><div><div className="control-card__eyebrow">MEMORY / NAMED POINTS</div><h2>Real-world stakes</h2></div><button type="button" className="control-text-button" onClick={() => openView('stakes')}>View all <Icon name="arrow" size={12} /></button></div>
          <div className="control-stakes-mini-grid">{initialStakes.map((stake) => <StakeMiniCard key={stake.id} stake={stake} />)}</div>
        </section>
        <section className="control-card control-learning-card">
          <div className="control-card__eyebrow">LEARNING TRACE / RECENT</div><h2>What changed in the model of this work?</h2>
          <div className="control-learning-item"><span className="control-learning-icon control-learning-icon--violet"><Icon name="spark" size={14} /></span><div><strong>Scope is a first-class decision</strong><p>The agent learned that “valid” and “generalizable” are different claims here.</p></div><span>2m</span></div>
          <div className="control-learning-item"><span className="control-learning-icon control-learning-icon--orange"><Icon name="question" size={14} /></span><div><strong>One doubt became a task</strong><p>Find a citation for causal language in paragraph 4.</p></div><span>8m</span></div>
          <button type="button" className="control-card__footer-link" onClick={() => openView('activity')}>See full activity log <Icon name="arrow" size={13} /></button>
        </section>
      </div>
      {onToast ? <span className="control-toast">{onToast}</span> : null}
    </>
  );
}

type ViewProps = {
  nodes: GraphNode[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  doubts: Doubt[];
  resolved: string[];
  onResolve: (id: string) => void;
  openView: (view: ViewId) => void;
  addNode: (label: string) => void;
  onToast?: string;
};

function GraphView({ nodes, selectedId, setSelectedId, addNode }: Pick<ViewProps, 'nodes' | 'selectedId' | 'setSelectedId' | 'addNode'>) {
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0];
  return (
    <>
      <div className="control-hero-row"><SectionHeading eyebrow="WORKSPACE / DECISION GRAPH" title="Editable decision graph" description="The AI proposes a durable path. You can move, rename or stop any step before it becomes action." /><button type="button" className="control-primary-button" onClick={() => addNode('New human-reviewed step')}><Icon name="plus" size={15} /> Add step</button></div>
      <div className="control-graph-layout">
        <section className="control-card control-graph-card control-graph-card--full"><div className="control-card__heading"><div><div className="control-card__eyebrow">DSA / DIRECTED STATE GRAPH · VERSION 0.4</div><h2>Answer paper reviewers</h2></div><span className="control-version-pill">autosaved 2m ago</span></div><div className="control-graph-summary"><span><StatusDot status="active" /> 3 AI steps · 3 human gates · 1 output</span><span>Click any node to inspect</span></div><GraphCanvas nodes={nodes} selectedId={selectedId} onSelect={setSelectedId} /></section>
        <aside className="control-card control-inspector"><div className="control-card__eyebrow">NODE INSPECTOR</div><div className="control-inspector__title"><span className={`control-inspector__icon control-inspector__icon--${selected.kind}`}><Icon name={selected.owner === 'YOU' ? 'target' : 'spark'} size={17} /></span><div><span>{selected.owner === 'YOU' ? 'Human gate' : 'AI reasoning'}</span><h2>{selected.label}</h2></div></div><label className="control-field-label">Purpose</label><p className="control-inspector__detail">{selected.detail}</p><label className="control-field-label">State</label><div className="control-state-select"><StatusDot status={selected.status} /><select value={selected.status} onChange={() => undefined} aria-label="Node state"><option value="complete">Complete</option><option value="active">In progress</option><option value="queued">Queued</option><option value="blocked">Blocked by doubt</option></select></div><div className="control-inspector__divider" /><div className="control-inspector__row"><span>Evidence attached</span><strong>{selected.kind === 'evidence' ? '03' : '01'}</strong></div><div className="control-inspector__row"><span>Open doubts</span><strong className="is-orange">{selected.id === 'doubts' ? '04' : '01'}</strong></div><button type="button" className="control-secondary-button">Edit node details <Icon name="arrow" size={13} /></button></aside>
      </div>
      <div className="control-graph-note"><span className="control-note-icon"><Icon name="spark" size={14} /></span><div><strong>Why a graph, not a chat history?</strong><p>Every claim, doubt, action and human decision becomes a named state that can be revisited. The graph is the memory.</p></div><span className="control-note-code">state → evidence → action</span></div>
      <PromptComposer onSubmit={addNode} compact />
    </>
  );
}

function DoubtsView({ doubts, resolved, onResolve }: { doubts: Doubt[]; resolved: string[]; onResolve: (id: string) => void }) {
  const open = doubts.filter((doubt) => !resolved.includes(doubt.id));
  const closed = doubts.filter((doubt) => resolved.includes(doubt.id));
  return (
    <>
      <div className="control-hero-row"><SectionHeading eyebrow="WORKSPACE / UNCERTAINTY" title="Doubt stack" description="A queue that only closes when the answer is supported, scoped and useful to the person doing the work." /><div className="control-uncertainty-badge"><span className="control-live-pulse" /> No false certainty</div></div>
      <div className="control-doubt-layout"><section className="control-card control-doubt-main"><div className="control-card__heading"><div><div className="control-card__eyebrow">{open.length} OPEN DOUBTS · SORTED BY CONSEQUENCE</div><h2>What the system still needs to know</h2></div><span className="control-count-pill control-count-pill--orange">human input requested</span></div>{open.map((doubt, index) => <DoubtRow key={doubt.id} doubt={doubt} index={index} onResolve={onResolve} />)}{open.length === 0 ? <div className="control-empty-state"><Icon name="check" size={24} /><strong>Nothing is being hidden.</strong><span>New doubts appear as the graph changes.</span></div> : null}</section><aside className="control-card control-doubt-principles"><div className="control-card__eyebrow">STACK RULES</div><h2>Uncertainty is a feature.</h2><p>The assistant keeps a doubt alive when it could change the plan, the claim or the human action.</p><div className="control-rule"><span>01</span><div><strong>Ask before acting</strong><small>Do not convert an assumption into a task.</small></div></div><div className="control-rule"><span>02</span><div><strong>Show the consequence</strong><small>Every doubt names what could go wrong.</small></div></div><div className="control-rule"><span>03</span><div><strong>Learn from the answer</strong><small>Human input updates the stake card and graph.</small></div></div><div className="control-confidence-key"><span>Confidence is not truth</span><div><i style={{ width: '42%' }} /> </div><small>calibrated against evidence and outcomes</small></div></aside></div><section className="control-card control-resolved-card"><div className="control-card__eyebrow">RESOLVED / RETAINED IN MEMORY</div><h2>Closed doubts still matter</h2>{closed.length ? closed.map((doubt) => <div className="control-resolved-row" key={doubt.id}><span className="control-resolved-check"><Icon name="check" size={13} /></span><span>{doubt.question}</span><small>answer linked to graph</small></div>) : <p>No doubts have been closed in this session. That is okay.</p>}</section>
    </>
  );
}

function DoubtRow({ doubt, index, onResolve }: { doubt: Doubt; index: number; onResolve: (id: string) => void }) {
  return <div className="control-doubt-row"><div className="control-doubt-row__index">0{index + 1}</div><div className="control-doubt-row__body"><div className="control-doubt__top"><span className={`control-priority control-priority--${doubt.priority}`}>{doubt.priority} consequence</span><span>{doubt.tag}</span></div><h3>{doubt.question}</h3><p>{doubt.context}</p><div className="control-doubt-row__bar"><span>Current confidence</span><div className="control-confidence"><span style={{ width: `${doubt.confidence}%` }} /></div><strong>{doubt.confidence}%</strong></div></div><div className="control-doubt-row__actions"><button type="button" className="control-secondary-button">Add evidence</button><button type="button" className="control-primary-button" onClick={() => onResolve(doubt.id)}><Icon name="check" size={13} /> Resolve</button></div></div>;
}

function StakesView() {
  return (
    <>
      <div className="control-hero-row"><SectionHeading eyebrow="MEMORY / REAL-WORLD CONTEXT" title="Real-world stakes" description="Short, named cards that keep the system oriented toward what changes for real people when a decision is wrong." /><button type="button" className="control-primary-button"><Icon name="plus" size={15} /> Add stake</button></div>
      <div className="control-stakes-layout"><section className="control-card control-stakes-main"><div className="control-card__heading"><div><div className="control-card__eyebrow">ACTIVE MEMORY · 03 NAMED POINTS</div><h2>The context this work cannot forget</h2></div><span className="control-version-pill">last distilled today</span></div>{initialStakes.map((stake, index) => <div className={`control-stake-row control-stake-row--${stake.color}`} key={stake.id}><div className="control-stake-row__number">0{index + 1}</div><div className="control-stake-row__content"><div className="control-stake-row__title"><h3>{stake.name}</h3><span>{stake.confidence}% grounded</span></div><p>{stake.summary}</p><div className="control-chip-row">{stake.evidence.map((item) => <span key={item}>{item}</span>)}</div></div><button type="button" className="control-icon-button" aria-label={`Edit ${stake.name}`}><Icon name="arrow" size={15} /></button></div>)}</section><aside className="control-card control-memory-contract"><div className="control-card__eyebrow">MEMORY CONTRACT</div><h2>Useful, not infinite.</h2><p>The system stores a small, named model of the world instead of replaying every conversation. Each card must change how a future decision is made.</p><div className="control-contract-list"><div><span className="control-contract-mark control-contract-mark--violet"><Icon name="check" size={12} /></span><span>Named in plain language</span></div><div><span className="control-contract-mark control-contract-mark--orange"><Icon name="check" size={12} /></span><span>Linked to evidence and doubt</span></div><div><span className="control-contract-mark control-contract-mark--blue"><Icon name="check" size={12} /></span><span>Human can edit or delete</span></div><div><span className="control-contract-mark control-contract-mark--green"><Icon name="check" size={12} /></span><span>Reviewed before high-stakes action</span></div></div><button type="button" className="control-secondary-button control-secondary-button--wide">Open memory changelog <Icon name="arrow" size={13} /></button></aside></div>
    </>
  );
}

function CadHelperView() {
  const presetKeys = Object.keys(COMPONENT_PRESETS);
  const [selectedKey, setSelectedKey] = useState(presetKeys[0] ?? 'hc-sr04-ultrasonic');
  const [spec, setSpec] = useState<CadComponentSpec>(COMPONENT_PRESETS[selectedKey]);
  const [wireframe, setWireframe] = useState(false);
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const selectPreset = (key: string) => { setSelectedKey(key); setSpec(JSON.parse(JSON.stringify(COMPONENT_PRESETS[key]))); setNotice(''); };
  const parseDatasheet = async () => { if (!rawText.trim()) return; setBusy(true); try { const response = await fetch('/api/admin/cad/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawText }) }); const data = await response.json(); if (data.ok && data.spec) { setSpec(data.spec); setNotice('Datasheet geometry extracted. Review the anchors before exporting.'); } else setNotice(data.error ?? 'Could not parse this datasheet.'); } catch { setNotice('Parser unavailable in this environment.'); } finally { setBusy(false); } };
  const generateBundle = async () => { setBusy(true); try { const response = await fetch('/api/admin/cad/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) }); const data = await response.json(); setNotice(data.ok ? `Bundle ready · ${data.stlByteLength ?? 0} byte STL · seed definition generated.` : data.error ?? 'Bundle generation failed.'); } catch { setNotice('Bundle service unavailable.'); } finally { setBusy(false); } };
  const deployBundle = async () => { setBusy(true); try { const response = await fetch('/api/admin/cad/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) }); const data = await response.json(); setNotice(data.ok ? data.result?.message ?? 'Catalog sync complete.' : data.error ?? 'Catalog sync failed.'); } catch { setNotice('Catalog sync unavailable.'); } finally { setBusy(false); } };
  return <><div className="control-hero-row"><SectionHeading eyebrow="FEATURE REPO / CAD-HELPER" title="CAD helper" description="Datasheet → parametric geometry → catalog-ready assets. This feature repo is wired into the control plane." /><div className="control-repo-status"><StatusDot status="ok" /><span>repo connected</span><code>cad-helper@0.1.0</code></div></div><div className="control-repo-strip"><span className="control-repo-mark"><Icon name="cube" size={16} /></span><div><strong>MKSubrahmanya12345/cad-helper</strong><span>separate feature surface · trusted by wireup-core</span></div><span className="control-repo-path">/cad-helper</span><span className="control-repo-sync"><StatusDot status="ok" /> synced</span></div><div className="control-cad-layout"><section className="control-card control-cad-intake"><div className="control-card__eyebrow">01 / INTAKE</div><h2>Choose a component</h2><label className="control-field-label">High-accuracy preset</label><select className="control-select" value={selectedKey} onChange={(event) => selectPreset(event.target.value)}>{presetKeys.map((key) => <option key={key} value={key}>{COMPONENT_PRESETS[key].name}</option>)}</select><div className="control-cad-or">or paste a datasheet excerpt</div><textarea className="control-textarea" value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder="Dimensions: 45 x 20 x 1.6 mm… Pin 1: VCC…" rows={5} /><button type="button" className="control-secondary-button control-secondary-button--wide" onClick={parseDatasheet} disabled={busy || !rawText.trim()}>{busy ? 'Extracting…' : 'Parse datasheet'} <Icon name="arrow" size={13} /></button><div className="control-cad-specs"><div><span>catalog id</span><code>{spec.id}</code></div><div><span>dimensions</span><code>{spec.dimensions.widthMm} × {spec.dimensions.lengthMm} × {spec.dimensions.heightMm} mm</code></div><div><span>pin anchors</span><code>{spec.pins.length} mapped</code></div></div></section><section className="control-card control-cad-preview"><div className="control-card__heading"><div><div className="control-card__eyebrow">02 / PREVIEW</div><h2>Parametric model</h2></div><button type="button" className="control-secondary-button" onClick={() => setWireframe(!wireframe)}>{wireframe ? 'Solid view' : 'Wireframe'} <Icon name="cube" size={13} /></button></div><CadPreviewCanvas spec={spec} wireframe={wireframe} showPins /><div className="control-cad-actions"><button type="button" className="control-primary-button" onClick={generateBundle} disabled={busy}><Icon name="spark" size={14} /> {busy ? 'Building…' : 'Generate bundle'}</button><button type="button" className="control-secondary-button" onClick={deployBundle} disabled={busy}>Deploy to catalog</button></div>{notice ? <div className="control-inline-notice"><StatusDot status="ok" />{notice}</div> : null}</section></div></>;
}

function RepositoriesView({ openView }: { openView: (view: ViewId) => void }) {
  const repos = [
    { id: 'wireup-core', name: 'wireup-core', description: 'Orchestration, prompts, project memory and the human approval loop.', path: '/src/modules', status: 'active', version: '0.1.0', color: 'violet', action: 'overview' as ViewId },
    { id: 'cad-helper', name: 'cad-helper', description: 'Datasheet parser, parametric geometry, STL/GLB bundle and catalog sync.', path: '/cad-helper', status: 'connected', version: '0.1.0', color: 'orange', action: 'cad-helper' as ViewId },
    { id: 'agent-memory', name: 'agent-memory', description: 'Named stakes, doubt resolution and evidence-linked state history.', path: 'planned / feature repo', status: 'designing', version: '—', color: 'blue', action: 'stakes' as ViewId },
    { id: 'eval-harness', name: 'eval-harness', description: 'Outcome tests, confidence calibration and human-gate regression checks.', path: 'planned / feature repo', status: 'designing', version: '—', color: 'green', action: 'activity' as ViewId },
  ];
  return <><div className="control-hero-row"><SectionHeading eyebrow="SYSTEM / FEATURE SURFACES" title="Repositories" description="Each capability stays independently testable. The control plane shows how they connect without hiding ownership." /><button type="button" className="control-primary-button"><Icon name="plus" size={15} /> Connect repo</button></div><div className="control-repo-callout"><span className="control-repo-callout__icon"><Icon name="nodes" size={17} /></span><div><strong>One main repo. Clear feature boundaries.</strong><p>Wireup is the shell; feature repos can evolve, ship and be evaluated without turning the assistant into one opaque codebase.</p></div><span className="control-repo-callout__code">main → feature surfaces</span></div><div className="control-repo-grid">{repos.map((repo) => <article className="control-repo-card" key={repo.id}><div className="control-repo-card__top"><span className={`control-repo-card__icon control-repo-card__icon--${repo.color}`}><Icon name={repo.id === 'cad-helper' ? 'cube' : 'folder'} size={18} /></span><span className={`control-repo-state control-repo-state--${repo.status}`}>{repo.status}</span></div><h2>{repo.name}</h2><p>{repo.description}</p><div className="control-repo-card__meta"><code>{repo.path}</code><span>v{repo.version}</span></div><button type="button" className="control-text-button" onClick={() => openView(repo.action)}>Open surface <Icon name="arrow" size={12} /></button></article>)}</div></>;
}

function ActivityView() {
  const events = [
    { time: '2 min ago', kind: 'LEARNED', title: 'Scope became a named stake', detail: 'Linked “reader trust” to reviewer 2 and updated the graph edge.', tone: 'violet' },
    { time: '8 min ago', kind: 'HUMAN INPUT', title: 'You added a field note', detail: '“Practitioners use this as a screening heuristic, not a diagnosis.”', tone: 'orange' },
    { time: '14 min ago', kind: 'GRAPH', title: 'AI branched an evidence check', detail: 'Created a new task from the causal-language doubt.', tone: 'blue' },
    { time: '21 min ago', kind: 'SYSTEM', title: 'Objective initialized', detail: 'Answer paper reviewers · 7 nodes · 4 doubts · 3 stakes.', tone: 'green' },
  ];
  return <><div className="control-hero-row"><SectionHeading eyebrow="OBSERVE / PROVENANCE" title="Activity log" description="A readable record of what the assistant proposed, what you changed and what the system learned." /><div className="control-repo-status"><StatusDot status="ok" /><span>event stream healthy</span></div></div><div className="control-activity-layout"><section className="control-card control-activity-card"><div className="control-card__heading"><div><div className="control-card__eyebrow">TODAY · 4 EVENTS</div><h2>Decision history</h2></div><button type="button" className="control-secondary-button">Export JSON <Icon name="arrow" size={13} /></button></div><div className="control-timeline">{events.map((event) => <div className="control-timeline-item" key={event.time}><div className={`control-timeline-icon control-timeline-icon--${event.tone}`}><Icon name={event.kind === 'HUMAN INPUT' ? 'target' : event.kind === 'GRAPH' ? 'nodes' : 'spark'} size={14} /></div><div className="control-timeline-body"><div><span className="control-card__eyebrow">{event.kind}</span><time>{event.time}</time></div><h3>{event.title}</h3><p>{event.detail}</p></div></div>)}</div></section><aside className="control-card control-observability"><div className="control-card__eyebrow">SYSTEM SIGNALS</div><h2>Trust primitives</h2><div className="control-signal-row"><span>Provenance coverage</span><strong>100%</strong><div><i style={{ width: '100%' }} /></div></div><div className="control-signal-row"><span>Human gate compliance</span><strong>100%</strong><div><i style={{ width: '100%' }} /></div></div><div className="control-signal-row"><span>Confidence calibration</span><strong>78%</strong><div><i style={{ width: '78%' }} /></div></div><div className="control-signal-row"><span>Open-loop actions</span><strong className="is-orange">00</strong><div><i style={{ width: '3%' }} /></div></div><div className="control-observability-note"><Icon name="check" size={14} /><span>No autonomous external action is enabled for this workspace.</span></div></aside></div></>;
}

export function AdminConsole() {
  const [activeView, setActiveView] = useState<ViewId>('overview');
  const [nodes, setNodes] = useState<GraphNode[]>(initialNodes);
  const [selectedId, setSelectedId] = useState(initialNodes[0].id);
  const [doubts, setDoubts] = useState<Doubt[]>(initialDoubts);
  const [resolved, setResolved] = useState<string[]>([]);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') as ViewId | null;
    if (view && ['overview', 'graph', 'doubts', 'stakes', 'cad-helper', 'repositories', 'activity'].includes(view)) setActiveView(view);
    const onPopState = () => { const next = new URLSearchParams(window.location.search).get('view') as ViewId | null; if (next) setActiveView(next); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openView = (view: ViewId) => {
    setActiveView(view);
    window.history.pushState({}, '', `/admin?view=${view}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const showToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600); };
  const addNode = (label: string) => {
    const nextId = `step-${nodes.length + 1}`;
    const newNode: GraphNode = { id: nextId, kind: 'human', label: label.length > 34 ? `${label.slice(0, 34)}…` : label, detail: 'Newly proposed step. Add evidence or make this a human gate.', owner: 'YOU', status: 'queued', position: { left: 40 + (nodes.length % 2) * 22, top: 83 } };
    setNodes((current) => [...current, newNode]); setSelectedId(nextId); showToast('New graph step added — review before it runs.');
  };
  const resolveDoubt = (id: string) => { setResolved((current) => [...current, id]); showToast('Doubt resolved and retained in the learning trace.'); };
  const pageTitle = useMemo(() => navGroups.flatMap((group) => group.items).find((item) => item.id === activeView)?.label ?? 'Mission control', [activeView]);

  return <div className="control-shell"><aside className="control-sidebar"><div className="control-brand"><span className="control-brand__mark"><span /><span /><span /></span><div><strong>WIREUP</strong><small>control plane</small></div></div><div className="control-workspace-switch"><span className="control-workspace-switch__avatar">R</span><div><strong>Research workspace</strong><span>private · local</span></div><span className="control-workspace-switch__chevron">⌄</span></div><nav className="control-nav" aria-label="Admin navigation">{navGroups.map((group) => <div className="control-nav__group" key={group.label}><div className="control-nav__label">{group.label}</div>{group.items.map((item) => <button type="button" key={item.id} className={`control-nav__item${activeView === item.id ? ' is-active' : ''}`} onClick={() => openView(item.id)}><Icon name={item.icon} size={16} /><span>{item.label}</span>{item.count ? <em>{item.count}</em> : null}</button>)}</div>)}</nav><div className="control-sidebar__bottom"><div className="control-loop-card"><div className="control-loop-card__top"><span className="control-live-pulse" /><span>SELF-LEARNING LOOP</span></div><strong>Human directed</strong><small>Autonomy level 02 / 05</small><div className="control-loop-meter"><i /><i /><i /><i /><i /></div></div><button type="button" className="control-user"><span className="control-user__avatar">RS</span><span><strong>Researcher</strong><small>workspace owner</small></span><span className="control-user__dots">•••</span></button></div></aside><main className="control-main"><header className="control-topbar"><div className="control-breadcrumb"><span>ADMIN</span><Icon name="arrow" size={12} /><strong>{pageTitle}</strong></div><div className="control-topbar__actions"><span className="control-topbar__clock"><StatusDot status="ok" /> All systems nominal</span><button type="button" className="control-topbar__icon" aria-label="Search"><span>⌕</span></button><button type="button" className="control-topbar__icon" aria-label="Notifications"><span>◌</span><i /></button><span className="control-topbar__divider" /><button type="button" className="control-help">?</button></div></header><div className="control-content">{activeView === 'overview' ? <OverviewView nodes={nodes} selectedId={selectedId} setSelectedId={setSelectedId} doubts={doubts} resolved={resolved} onResolve={resolveDoubt} openView={openView} addNode={addNode} onToast={toast} /> : null}{activeView === 'graph' ? <GraphView nodes={nodes} selectedId={selectedId} setSelectedId={setSelectedId} addNode={addNode} /> : null}{activeView === 'doubts' ? <DoubtsView doubts={doubts} resolved={resolved} onResolve={resolveDoubt} /> : null}{activeView === 'stakes' ? <StakesView /> : null}{activeView === 'cad-helper' ? <CadHelperView /> : null}{activeView === 'repositories' ? <RepositoriesView openView={openView} /> : null}{activeView === 'activity' ? <ActivityView /> : null}</div></main></div>;
}
