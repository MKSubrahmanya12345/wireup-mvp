/**
 * GET /api/projects/[id]/simulation
 *
 * Everything the /simulation page needs in one call: the Velxio project to
 * push onto the canvas, a description of the generated dashboard (its
 * contract, its file list, its static findings) and, when a half cannot be
 * produced, the reason in plain language.
 *
 * The dashboard SOURCES are not returned here — they are several dozen
 * kilobytes the page never renders. `/simulation/software.zip` serves them.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectState } from '@/lib/mongodb/projects';
import { buildSimulationBundle } from '@/modules/simulation';
import { simulationConfig } from '@/lib/simulation/config';

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
    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    const bundle = buildSimulationBundle(project);

    return jsonOk({
      projectId: bundle.projectId,
      projectName: bundle.projectName,
      slug: bundle.slug,
      revision: bundle.revision,
      status: project.status,
      stage: project.stage,
      config: simulationConfig(),
      velxio: bundle.velxio
        ? {
            // The full .vlx JSON: the page pushes this straight onto the canvas.
            vlx: bundle.velxio.json,
            name: bundle.velxio.project.name,
            boardKind: bundle.velxio.project.boards[0]?.boardKind ?? null,
            parts: bundle.velxio.project.components.length,
            wires: bundle.velxio.project.wires.length,
            files: bundle.velxio.project.fileGroups['group-1']?.map((file) => file.name) ?? [],
            unsupported: bundle.velxio.unsupported,
            warnings: bundle.velxio.warnings,
          }
        : null,
      software: bundle.software
        ? {
            slug: bundle.software.slug,
            devPort: bundle.software.devPort,
            contract: bundle.software.contract,
            files: bundle.software.files.map((file) => ({ path: file.path, bytes: file.content.length })),
            findings: bundle.software.findings,
            passed: bundle.software.passed,
            notes: bundle.software.notes,
            generatedAt: bundle.software.generatedAt,
            zipUrl: `/api/projects/${project.id}/simulation/software.zip`,
          }
        : null,
      blocked: bundle.blocked,
    });
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}/simulation`);
    return jsonError(mapped.status, mapped.error);
  }
}
