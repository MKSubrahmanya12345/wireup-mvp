/**
 * POST /api/projects/[id]/simulation/sync
 *
 * The other direction of the canvas bridge: the /simulation page pulls the
 * current Velxio canvas over postMessage and posts it here, and this folds it
 * back into the project's `diagram.json`.
 *
 * Why this must be a server round-trip and not a client-side edit: the diagram
 * is the artifact everything else is derived from — the wiring guide, the
 * Wokwi export, the .vlx pushed to the canvas next time. If a canvas edit only
 * lived in the browser, reloading the page would silently revert it and the
 * downloaded zip would describe a circuit the user no longer has.
 *
 * A sync creates a REVISION, exactly like a fix pass does, so the pre-sync
 * diagram is never lost and the run log shows who changed what.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { getProjectState, saveProjectState, appendEvents } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { logger } from '@/lib/logging/logger';
import { applyCanvasToDiagram, CanvasSyncError, type VlxCanvasPayload } from '@/modules/simulation';
import { appendRevision, createRevision } from '@/modules/orchestrator/revisions';
import { isRunning } from '@/modules/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Deliberately permissive: this payload was produced by Velxio, not by Wireup,
 * and pinning its exact shape here would break the sync every time upstream
 * adds a field. Only what the sync actually reads is required; the rest passes
 * through untouched.
 */
const CanvasPayloadSchema = z.object({
  boards: z.array(z.object({ id: z.string() }).passthrough()),
  components: z
    .array(
      z
        .object({
          id: z.string(),
          metadataId: z.string(),
          x: z.number().optional(),
          y: z.number().optional(),
          properties: z.record(z.unknown()).optional(),
        })
        .passthrough(),
    )
    .max(500, 'A canvas with more than 500 components is not something this project produced.'),
  wires: z
    .array(
      z
        .object({
          id: z.string(),
          start: z.object({ componentId: z.string(), pinName: z.string() }).passthrough(),
          end: z.object({ componentId: z.string(), pinName: z.string() }).passthrough(),
        })
        .passthrough(),
    )
    .max(2000, 'A canvas with more than 2000 wires is not something this project produced.'),
  format: z.string().optional(),
  version: z.number().optional(),
  name: z.string().optional(),
  fileGroups: z.record(z.array(z.object({ name: z.string(), content: z.string() }).passthrough())).optional(),
  activeBoardId: z.string().nullable().optional(),
});

const BodySchema = z.object({ canvas: CanvasPayloadSchema });

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  try {
    const body = await readJson(request);
    const parsed = parseBody(BodySchema, body);

    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    // Writing the diagram out from under a running pipeline would be racing the
    // generator for the same field, and the generator would win.
    if (isRunning(project.id)) {
      return jsonError(409, {
        code: 'project_busy',
        message: 'This project is still being generated. Wait for the run to finish before syncing the canvas.',
      });
    }

    const diagram = project.artifacts.diagram;
    if (!diagram) {
      return jsonError(409, {
        code: 'diagram_not_ready',
        message: 'This project has no diagram.json to sync the canvas into.',
      });
    }

    const result = applyCanvasToDiagram(parsed.canvas as VlxCanvasPayload, diagram);

    // Freeze what the diagram looked like before the sync, then write.
    const version = project.revision + 1;
    const revision = createRevision({
      project,
      version,
      reason: 'targeted_fix',
      summary: `Velxio canvas sync — ${result.summary}`,
      stage: 'diagram',
    });
    const revisions = appendRevision(project, revision);

    const saved = await saveProjectState(project.id, {
      artifacts: { ...project.artifacts, diagram: result.diagram },
      revisions,
      revision: version,
    });

    await appendEvents(project.id, [
      {
        seq: (project.events[project.events.length - 1]?.seq ?? 0) + 1,
        id: createId(),
        type: 'canvas_sync_applied',
        status: 'completed',
        message: `Canvas synced into diagram.json — ${result.summary}`,
        timestamp: nowIso(),
        stage: 'diagram',
        metadata: { ...result.changes, unmapped: result.unmapped, revision: version },
      },
    ]);

    logger.info({ projectId: project.id, ...result.changes }, 'velxio canvas synced into diagram.json');

    return jsonOk({
      revision: version,
      summary: result.summary,
      changes: result.changes,
      unmapped: result.unmapped,
      diagram: saved?.artifacts.diagram ?? result.diagram,
    });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    if (error instanceof CanvasSyncError) {
      return jsonError(409, { code: 'canvas_sync_failed', message: error.message });
    }
    const mapped = fromUnknown(error, `POST /api/projects/${id}/simulation/sync`);
    return jsonError(mapped.status, mapped.error);
  }
}
