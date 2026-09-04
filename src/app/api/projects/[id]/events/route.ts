/**
 * GET /api/projects/[id]/events?after=<seq>
 *
 * The polling endpoint behind the live agent console. `after` is the highest
 * event seq the client already has, so each poll only ships new lines. The
 * response also carries status/stage/revision so the client knows when the run
 * finished and must refetch the full project.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectEvents } from '@/lib/mongodb/projects';
import { isRunning } from '@/modules/orchestrator';
import { recoverStalledProject } from '@/modules/orchestrator/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed']);

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  const rawAfter = request.nextUrl.searchParams.get('after') ?? '0';
  const parsedAfter = Number.parseInt(rawAfter, 10);
  const after = Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;

  try {
    let result = await getProjectEvents(id.trim(), after);
    if (!result) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    // Recover runs whose owning process disappeared, then re-read so the
    // recovery event itself reaches the console on this same poll.
    const recovered = await recoverStalledProject({
      id: id.trim(),
      status: result.status,
      stage: result.stage,
      events: result.events,
      updatedAt: result.updatedAt,
      latestSeq: result.latestSeq,
    });
    if (recovered) {
      const refreshed = await getProjectEvents(id.trim(), after);
      if (refreshed) result = refreshed;
    }

    return jsonOk({
      events: result.events,
      latestSeq: result.latestSeq,
      status: result.status,
      stage: result.stage,
      revision: result.revision,
      running: isRunning(id.trim()),
      terminal: TERMINAL_STATUSES.has(result.status),
    });
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}/events`);
    return jsonError(mapped.status, mapped.error);
  }
}
