/**
 * GET /api/projects/[id]/diagram?target=wireup|wokwi
 *
 * `wireup` (default) returns the canonical machine-readable diagram.
 * `wokwi`   projects it into the Wokwi `diagram.json` shape, reporting exactly
 *           which parts/wires could not be represented instead of guessing.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectState } from '@/lib/mongodb/projects';
import { toWokwiDiagram } from '@/modules/diagram-generator/wokwi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const target = (request.nextUrl.searchParams.get('target') ?? 'wireup').toLowerCase();

  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }
  if (target !== 'wireup' && target !== 'wokwi') {
    return jsonError(400, {
      code: 'bad_request',
      message: `Unknown diagram target "${target}". Supported targets: wireup, wokwi.`,
    });
  }

  try {
    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    const diagram = project.artifacts.diagram;
    if (!diagram) {
      return jsonError(409, {
        code: 'diagram_not_ready',
        message: 'diagram.json has not been generated yet for this project.',
        details: `Current stage: ${project.stage}, status: ${project.status}.`,
      });
    }

    if (target === 'wokwi') {
      const projection = toWokwiDiagram(diagram);
      return jsonOk({
        target: 'wokwi',
        projectId: project.id,
        revision: project.revision,
        diagram: projection.diagram,
        skippedParts: projection.skippedParts,
        skippedConnections: projection.skippedConnections,
        warnings: projection.warnings,
      });
    }

    return jsonOk({ target: 'wireup', projectId: project.id, revision: project.revision, diagram });
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}/diagram`);
    return jsonError(mapped.status, mapped.error);
  }
}
