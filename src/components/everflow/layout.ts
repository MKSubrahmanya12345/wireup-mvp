/**
 * Deterministic layered layout for the project graph. Same graph in, same
 * pixels out — the canvas is a projection, so the layout can be pure and is
 * trivially stable between polls.
 *
 * Layers (left → right): intent · claims/assumptions/doubts · goals ·
 * artifacts · decisions · evidence · tasks.
 */

import type { EverflowEdge, EverflowGraph, EverflowNode, EverflowNodeKind } from '@/types/everflow';

export interface PlacedNode {
  node: EverflowNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  edge: EverflowEdge;
  path: string;
  kind: EverflowEdge['kind'];
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

const LAYER_ORDER: EverflowNodeKind[] = ['intent', 'claim', 'goal', 'artifact', 'decision', 'evidence', 'task', 'doubt', 'assumption'];

const COLUMN_WIDTH = 190;
const COLUMN_GAP = 70;
const NODE_WIDTH = 172;
const NODE_HEIGHT = 58;
const VERTICAL_GAP = 18;
const PADDING = 24;

function layerFor(kind: EverflowNodeKind): number {
  // claims, assumptions and doubts share the "context" column
  if (kind === 'claim' || kind === 'assumption' || kind === 'doubt') return 1;
  const index = LAYER_ORDER.indexOf(kind);
  return index < 0 ? 1 : index;
}

export function layoutGraph(graph: EverflowGraph): GraphLayout {
  const byLayer = new Map<number, EverflowNode[]>();
  for (const node of graph.nodes) {
    const layer = layerFor(node.kind);
    const list = byLayer.get(layer) ?? [];
    list.push(node);
    byLayer.set(layer, list);
  }

  // Sort within a layer for visual stability: goals before artifacts inside a
  // column is handled by the fixed layer order already; keep id order within.
  const columns = [...byLayer.entries()].sort((a, b) => a[0] - b[0]);
  const columnX = (index: number): number => PADDING + index * (COLUMN_WIDTH + COLUMN_GAP);

  let maxRows = 1;
  for (const [, nodes] of columns) maxRows = Math.max(maxRows, nodes.length);

  const totalWidth = PADDING * 2 + Math.max(1, columns.length) * COLUMN_WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP;
  const totalHeight = PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * VERTICAL_GAP;

  const placed = new Map<string, PlacedNode>();
  columns.forEach(([, nodes], columnIndex) => {
    const columnHeight = nodes.length * NODE_HEIGHT + (nodes.length - 1) * VERTICAL_GAP;
    const offsetY = PADDING + Math.max(0, (totalHeight - PADDING * 2 - columnHeight) / 2);
    nodes.forEach((node, row) => {
      placed.set(node.id, {
        node,
        x: columnX(columnIndex),
        y: offsetY + row * (NODE_HEIGHT + VERTICAL_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  });

  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.4);
    edges.push({
      edge,
      kind: edge.kind,
      path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    });
  }

  return {
    nodes: [...placed.values()],
    edges,
    width: totalWidth,
    height: totalHeight,
  };
}
