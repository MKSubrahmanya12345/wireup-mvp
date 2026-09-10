'use client';

/**
 * The project graph canvas — a deterministic layered SVG. Node fill = kind,
 * ring = goal state. Clicking a node opens the inspector; nothing here is
 * hardcoded per project.
 */

import { useMemo } from 'react';

import type { EverflowGraph, EverflowNodeKind } from '@/types/everflow';

import { layoutGraph } from './layout';

const KIND_LABEL: Record<EverflowNodeKind, string> = {
  intent: 'INTENT',
  claim: 'CLAIM',
  assumption: 'ASSUMPTION',
  decision: 'DECISION',
  goal: 'GOAL',
  doubt: 'DOUBT',
  evidence: 'EVIDENCE',
  task: 'TASK',
  artifact: 'ARTIFACT',
  subsystem: 'SUBSYSTEM',
  test_result: 'TEST',
  review: 'REVIEW',
};

export function GraphCanvas({
  graph,
  selectedId,
  onSelect,
  compact = false,
}: {
  graph: EverflowGraph;
  selectedId: string | null;
  onSelect?: (nodeId: string | null) => void;
  compact?: boolean;
}) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const scale = compact ? 0.85 : 1;

  return (
    <div className={`evf-canvas${compact ? ' evf-canvas--compact' : ''}`}>
      <div className="evf-canvas__legend" aria-hidden="true">
        <span className="evf-legend-item"><i className="evf-dot evf-dot--satisfied" />satisfied</span>
        <span className="evf-legend-item"><i className="evf-dot evf-dot--open" />open</span>
        <span className="evf-legend-item"><i className="evf-dot evf-dot--in-progress" />working</span>
        <span className="evf-legend-item"><i className="evf-dot evf-dot--blocked-human" />needs you</span>
      </div>
      <div className="evf-canvas__scroll">
        <svg
          width={Math.ceil(layout.width * scale)}
          height={Math.ceil(layout.height * scale)}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`Project graph: ${graph.nodes.length} nodes`}
        >
          <g transform={scale !== 1 ? `scale(${scale})` : undefined}>
            {layout.edges.map((edge) => (
              <path
                key={edge.edge.id}
                d={edge.path}
                className={`evf-edge evf-edge--${edge.kind}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.2}
                opacity={0.55}
              />
            ))}
            {layout.nodes.map(({ node, x, y, width, height }) => {
              const selected = node.id === selectedId;
              return (
                <g
                  key={node.id}
                  className={`evf-node evf-node--${node.kind}${selected ? ' is-selected' : ''}`}
                  transform={`translate(${x}, ${y})`}
                  onClick={() => onSelect?.(selected ? null : node.id)}
                  role="button"
                  aria-label={`${KIND_LABEL[node.kind]}: ${node.label}`}
                >
                  <rect width={width} height={height} rx={10} className={`evf-node__body evf-goal--${node.goal.state === 'satisfied' ? 'satisfied' : node.goal.state}`} />
                  <circle cx={14} cy={16} r={4.5} className={`evf-dot evf-dot--${node.goal.state === 'satisfied' ? 'satisfied' : node.goal.state === 'open' ? 'open' : node.goal.state === 'in_progress' ? 'in-progress' : 'blocked-human'}`} />
                  <text x={26} y={20} className="evf-node__kind">
                    {KIND_LABEL[node.kind]}
                    {node.kind === 'task' ? (node.owner === 'human' ? ' · YOU' : ' · AI') : ''}
                  </text>
                  <text x={12} y={38} className="evf-node__label">
                    {truncate(node.label, 28)}
                  </text>
                  <text x={12} y={50} className="evf-node__goal">
                    {truncate(goalWord(node.goal.state), 30)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function goalWord(state: string): string {
  switch (state) {
    case 'satisfied':
      return 'done';
    case 'blocked_human':
      return 'needs a human';
    case 'in_progress':
      return 'in flight';
    case 'waived':
      return 'waived';
    default:
      return 'open';
  }
}
