/**
 * POST /api/projects/:id/everflow/research
 *
 * The agent's docs/web check tool, on demand: research one graph node
 * against the catalog, the bundled docs corpus, and (opt-in per call) the
 * live web. The finding is persisted as cited evidence on the project and
 * the graph is re-materialised so the new evidence node shows up.
 *
 * Honest by construction: when no source matches, the route says
 * "no source found" — it never invents a fact.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { evaluateEverflow, materializeGraph, researchNode } from '@/modules/everflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BodySchema = z.object({
  /** Graph node to research (claim/decision/etc.). Required. */
  nodeId: z.string().trim().min(3).max(120),
  /** Force a live web pull (flagged for human review). */
  useWeb: z.boolean().default(false),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    const parsed = parseBody(BodySchema, body);

    const state = await getProjectState(id);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });

    const graph = materializeGraph(state);
    const node = graph.nodes.find((candidate) => candidate.id === parsed.nodeId);
    if (!node) return jsonError(404, { code: 'node_not_found', message: `No graph node with id "${parsed.nodeId}".` });

    const finding = await researchNode({ state, node, useWeb: parsed.useWeb });

    if (!finding) {
      return jsonOk({
        projectId: id,
        nodeId: parsed.nodeId,
        found: false,
        message: 'No catalog, corpus or web source matched this node yet — the agent will not guess.',
        graph,
        evaluation: evaluateEverflow(state, graph, state.everflow?.pass ?? 0),
        doubts: state.doubts,
        humanTasks: state.humanTasks,
        brief: state.everflow?.evaluation?.brief ?? null,
      });
    }

    const research = [...state.research, finding];
    const next = { ...state, research };
    const freshGraph = materializeGraph(next);
    const evaluation = evaluateEverflow(next, freshGraph, (state.everflow?.pass ?? 0) + 1);
    await saveProjectState(id, { research, everflow: { graph: freshGraph, evaluation, pass: (state.everflow?.pass ?? 0) + 1 } });
    await appendEvents(id, [
      {
        seq: state.events.reduce((max, candidate) => Math.max(max, candidate.seq), 0) + 1,
        id: createId('evt'),
        type: 'research_completed',
        status: 'info',
        message: `Checked the ${finding.source === 'web' ? 'web' : finding.source} for “${node.label}” — ${finding.facts.length} fact(s) recorded${finding.needsHumanCheck ? ' (needs your check)' : ''}.`,
        timestamp: nowIso(),
        stage: 'completed',
        metadata: { nodeId: parsed.nodeId, source: finding.source, title: finding.title, url: finding.url, facts: finding.facts.length, needsHumanCheck: finding.needsHumanCheck },
      },
    ]);

    logger.info({ projectId: id, nodeId: parsed.nodeId, source: finding.source }, 'research finding recorded');

    return jsonOk({
      projectId: id,
      nodeId: parsed.nodeId,
      found: true,
      finding,
      graph: freshGraph,
      evaluation,
      doubts: state.doubts,
      humanTasks: state.humanTasks,
      brief: evaluation.brief,
    });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    const described = describeError(error);
    logger.warn({ error: described.message }, 'research failed');
    const mapped = fromUnknown(error, 'POST /api/projects/:id/everflow/research');
    return jsonError(mapped.status, mapped.error);
  }
}
