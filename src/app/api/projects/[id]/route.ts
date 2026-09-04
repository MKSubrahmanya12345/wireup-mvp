/**
 * GET /api/projects/[id] — the full project state (all artifacts, revisions,
 * validation results and the event log) for the workspace UI.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectState } from '@/lib/mongodb/projects';
import { isRunning } from '@/modules/orchestrator';
import { recoverStalledProject } from '@/modules/orchestrator/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  try {
    let project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    // A run whose owning process disappeared (restart/crash) must not leave the
    // UI polling forever: explain it and move the project to a terminal state.
    const recovered = await recoverStalledProject(project);
    if (recovered) project = recovered;

    return jsonOk({ project, running: isRunning(project.id) });
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}`);
    return jsonError(mapped.status, mapped.error);
  }
}
