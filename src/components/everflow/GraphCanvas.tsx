'use client';

/**
 * The project graph canvas — a Sugiyama-layered SVG over the graph kernel.
 * Node fill = kind, dot = goal state. Clicking (or Enter/Space on) a node
 * opens the inspector; the toolbar zooms, the canvas drag-pans, and the
 * wheel zooms around the cursor. Nothing here is hardcoded per project.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { EverflowEdgeKind, EverflowGraph, EverflowNodeKind } from '@/types/everflow';

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

const EDGE_COLOR: Record<EverflowEdgeKind, string> = {
  supports: '#6b7280',
  depends_on: '#b45309',
  contradicts: '#dc2626',
  produces: '#7c3aed',
  verified_by: '#2563eb',
  part_of: '#16a34a',
  located_in: '#0d9488',
  answered_by: '#ea580c',
};

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  const [view, setView] = useState<View>({ x: 0, y: 0, w: layout.width, h: layout.height });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef({ active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  // Reset the viewport when the graph itself changes size (new layout).
  useEffect(() => {
    setView({ x: 0, y: 0, w: layout.width, h: layout.height });
  }, [layout.width, layout.height]);

  const zoom = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      setView((prev) => {
        const w = Math.min(layout.width * 2, Math.max(120, prev.w * factor));
        const h = Math.min(layout.height * 2, Math.max(90, prev.h * factor));
        // Zoom around the cursor when given, else the viewport centre.
        const px = cx === undefined ? 0.5 : cx;
        const py = cy === undefined ? 0.5 : cy;
        return { w, h, x: prev.x + (prev.w - w) * px, y: prev.y + (prev.h - h) * py };
      });
    },
    [layout.width, layout.height],
  );

  const reset = useCallback(() => {
    setView({ x: 0, y: 0, w: layout.width, h: layout.height });
  }, [layout.width, layout.height]);

  // Native wheel listener (React's onWheel is passive at the root — this one
  // can preventDefault so page scroll doesn't fight canvas zoom).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cx = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      const cy = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
      zoom(event.deltaY > 0 ? 1.15 : 1 / 1.15, cx, cy);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoom]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      dragRef.current = { active: true, moved: false, sx: event.clientX, sy: event.clientY, ox: view.x, oy: view.y };
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [view.x, view.y],
  );
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag.active || !svgRef.current) return;
      const dx = event.clientX - drag.sx;
      const dy = event.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const rect = svgRef.current.getBoundingClientRect();
      const scaleX = rect.width > 0 ? view.w / rect.width : 1;
      const scaleY = rect.height > 0 ? view.h / rect.height : 1;
      setView((prev) => ({ ...prev, x: drag.ox - dx * scaleX, y: drag.oy - dy * scaleY }));
    },
    [view.w, view.h],
  );
  const onPointerUp = useCallback(() => {
    dragRef.current.active = false;
  }, []);

  const activate = useCallback(
    (nodeId: string) => {
      if (dragRef.current.moved) return; // a drag-pan, not a selection
      onSelect?.(selectedId === nodeId ? null : nodeId);
    },
    [onSelect, selectedId],
  );

  if (graph.nodes.length === 0) {
    return (
      <div className={`evf-canvas${compact ? ' evf-canvas--compact' : ''}`}>
        <p className="evf-muted">The graph is empty — it materialises from the project state on the next pass.</p>
      </div>
    );
  }

  return (
    <div className={`evf-canvas${compact ? ' evf-canvas--compact' : ''}`}>
      <div className="evf-canvas__legend" aria-hidden="true">
        <span className="evf-legend-item"><i className="evf-dot evf-dot--satisfied" />satisfied</span>
        <span className="evf-legend-item"><i className="evf-dot evf-dot--open" />open</span>
        <span className="evf-legend-item"><i className="evf-dot evf-dot--in-progress" />working</span>
        <span className="evf-legend-item"><i className="evf-dot evf-dot--blocked-human" />needs you</span>
        <span className="evf-canvas__counts">
          {graph.nodes.length} nodes · {layout.edges.length} edges · {layout.layers} layers
        </span>
      </div>
      <div className="evf-canvas__toolbar" role="toolbar" aria-label="Graph view">
        <button type="button" className="evf-zoom-btn" onClick={() => zoom(1 / 1.25)} aria-label="Zoom in">+</button>
        <button type="button" className="evf-zoom-btn" onClick={() => zoom(1.25)} aria-label="Zoom out">−</button>
        <button type="button" className="evf-zoom-btn evf-zoom-btn--wide" onClick={reset}>fit</button>
        <span className="evf-canvas__hint">drag to pan · scroll to zoom</span>
      </div>
      <div className="evf-canvas__scroll">
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          role="img"
          aria-label={`Project graph: ${graph.nodes.length} nodes in ${layout.layers} layers`}
          className="evf-canvas__svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <defs>
            {(Object.keys(EDGE_COLOR) as EverflowEdgeKind[]).map((kind) => (
              <marker key={kind} id={`evf-arrow-${kind}`} viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" fill={EDGE_COLOR[kind]} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => (
            <path
              key={edge.edge.id}
              d={edge.path}
              className={`evf-edge evf-edge--${edge.kind}${edge.reversed ? ' evf-edge--reversed' : ''}`}
              fill="none"
              strokeWidth={1.2}
              opacity={0.75}
              markerEnd={`url(#evf-arrow-${edge.kind})`}
            >
              <title>{`${edge.edge.from} —${edge.kind}→ ${edge.edge.to}${edge.edge.note ? `: ${edge.edge.note}` : ''}`}</title>
            </path>
          ))}
          {layout.nodes.map(({ node, x, y, width, height }) => {
            const selected = node.id === selectedId;
            return (
              <g
                key={node.id}
                className={`evf-node evf-node--${node.kind}${selected ? ' is-selected' : ''}`}
                transform={`translate(${x}, ${y})`}
                onClick={() => activate(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate(node.id);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`${KIND_LABEL[node.kind]}: ${node.label} — ${goalWord(node.goal.state)}`}
              >
                <title>{`${node.label}\n${node.goal.criterion}`}</title>
                <rect width={width} height={height} rx={10} className={`evf-node__body evf-goal--${node.goal.state === 'satisfied' ? 'satisfied' : node.goal.state}`} />
                <circle cx={14} cy={16} r={4.5} className={`evf-dot evf-dot--${node.goal.state === 'satisfied' ? 'satisfied' : node.goal.state === 'open' ? 'open' : node.goal.state === 'in_progress' ? 'in-progress' : 'blocked-human'}`} />
                <text x={26} y={20} className="evf-node__kind">
                  {KIND_LABEL[node.kind]}
                  {node.kind === 'task' ? (node.owner === 'human' ? ' · YOU' : ' · AI') : ''}
                  {node.swarmRole ? ` · ${node.swarmRole.replace('-swarm', '').toUpperCase()}` : ''}
                </text>
                <text x={12} y={38} className="evf-node__label">
                  {truncate(node.label, 28)}
                </text>
                <text x={12} y={50} className="evf-node__goal">
                  {truncate(nodeLine(node), 30)}
                </text>
              </g>
            );
          })}
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

function nodeLine(node: { goal: { state: string }; testSpec?: { rung: string; status: string } | null }): string {
  if (node.testSpec) return `${node.testSpec.rung}: ${node.testSpec.status.replace('_', ' ')}`;
  return goalWord(node.goal.state);
}
