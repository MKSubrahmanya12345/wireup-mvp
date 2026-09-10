/**
 * POST /api/projects/:id/everflow/respond
 *
 * Column one (AI → human): answer an ask the agent filed. The answer lands
 * as evidence on the graph and one continuation pass re-evaluates every goal.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { getProjectState } from '@/lib/mongodb/projects';
import { evaluateEverflow, materializeGraph, respondToHumanTask } from '@/modules/everflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BodySchema = z.object({
  taskId: z.string().min(1),
  value: z.string().trim().min(1).max(2000),
  note: z.string().trim().max(500).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    const parsed = parseBody(BodySchema, body);

    const result = await respondToHumanTask(id, parsed.taskId, parsed.value, parsed.note);
    if (!result) {
      return jsonError(409, { code: 'task_not_answerable', message: 'Unknown task, or it is not an open AI→human ask.' });
    }

    const state = result.state;
    const graph = materializeGraph(state);
    const evaluation = evaluateEverflow(state, graph, state.everflow?.pass ?? 0);

    return jsonOk({
      projectId: id,
      status: state.status,
      graph,
      evaluation,
      doubts: state.doubts,
      humanTasks: state.humanTasks,
    });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    const described = describeError(error);
    logger.warn({ error: described.message }, 'everflow respond failed');
    const mapped = fromUnknown(error, 'POST /api/projects/[id]/everflow/respond');
    return jsonError(mapped.status, mapped.error);
  }
}
