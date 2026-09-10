/**
 * Everflow canvas layout — now a thin shim over the graph kernel.
 *
 * `src/modules/graph/layout.ts` runs the real Sugiyama pipeline (layer
 * assignment → barycenter crossing minimization → top-anchored coordinates)
 * for ALL node kinds, including the idea-graph subtree the old fixed-column
 * layout piled into a single stack. This module keeps the old import path
 * working; the placed-node/edge shapes are supersets of the old ones.
 */

export type { GraphLayout, PlacedEdge, PlacedNode } from '@/modules/graph/layout';
export { layoutGraph } from '@/modules/graph/layout';
