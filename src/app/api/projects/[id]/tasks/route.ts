/**
 * /api/projects/[id]/tasks — the hands-and-legs queue.
 *
 *   GET  the queue, the facts it has grounded, and a summary
 *   POST { action: 'plan', force?: true } — derive the queue from the hardware plan
 *
 * The human side of the protocol lives at ./[taskId] (claim / submit / skip).
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { getCatalog } from '@/modules/components/service';
import { humanLoopSummary, nextActionable, planHumanLoop } from '@/modules/human-loop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function respond(project: NonNullable<Awaited<ReturnType<typeof getProjectState>>>) {
  const loop = project.humanLoop;
  return jsonOk({
    tasks: loop.tasks,
    facts: loop.facts,
    summary: humanLoopSummary(loop),
    next: nextActionable(loop)?.id ?? null,
  });
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id?.trim()) return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });

  try {
    const project = await getProjectState(id.trim());
    if (!project) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    return respond(project);
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}/tasks`);
    return jsonError(mapped.status, mapped.error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id?.trim()) return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });

  let body: { action?: string; force?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body is a plain "make me a plan".
  }

  if (body.action !== undefined && body.action !== 'plan') {
    return jsonError(400, { code: 'bad_request', message: `Unsupported action "${body.action}". Use action: "plan".` });
  }

  try {
    const project = await getProjectState(id.trim());
    if (!project) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });

    const catalog = await getCatalog();
    const humanLoop = planHumanLoop(project, catalog.components, { force: body.force === true });

    const saved = await saveProjectState(id.trim(), { humanLoop });
    if (!saved) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });

    return respond(saved);
  } catch (error) {
    const mapped = fromUnknown(error, `POST /api/projects/${id}/tasks`);
    return jsonError(mapped.status, mapped.error);
  }
}
