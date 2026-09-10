/**
 * POST /api/projects/:id/everflow/inject
 *
 * Column two (human → AI): add something the agent cannot know — an idea, a
 * correction, a resource you own, a note. It is registered as a fact on the
 * graph; for anything that could change the design the agent files a
 * follow-up ask instead of modifying the project silently.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { getProjectState } from '@/lib/mongodb/projects';
import { createHumanInjection, evaluateEverflow, materializeGraph } from '@/modules/everflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BodySchema = z.object({
  type: z.enum(['note', 'idea', 'correction', 'resource']),
  text: z.string().trim().min(3).max(2000),
  title: z.string().trim().max(120).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    const parsed = parseBody(BodySchema, body);

    const state = await getProjectState(id);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });
    if (state.status === 'intake') {
      return jsonError(409, { code: 'not_in_intake', message: 'Answer the doubt session first; additions are accepted once the build exists.' });
    }

    const result = await createHumanInjection(id, parsed);
    if (!result) {
      return jsonError(500, { code: 'injection_failed', message: 'The addition could not be registered.' });
    }

    const fresh = result.state;
    const graph = materializeGraph(fresh);
    const evaluation = evaluateEverflow(fresh, graph, fresh.everflow?.pass ?? 0);

    return jsonOk({
      projectId: id,
      status: fresh.status,
      graph,
      evaluation,
      doubts: fresh.doubts,
      humanTasks: fresh.humanTasks,
    });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    const described = describeError(error);
    logger.warn({ error: described.message }, 'everflow inject failed');
    const mapped = fromUnknown(error, 'POST /api/projects/[id]/everflow/inject');
    return jsonError(mapped.status, mapped.error);
  }
}
