/**
 * POST /api/projects/[id]/copilot
 *
 * Cursor-inspired hardware editing surface:
 *   { mode: 'plan',  message }                  → preview only
 *   { mode: 'apply', message, baseRevision }   → re-plan, apply, verify
 *
 * The browser never posts a changeset for the server to trust. Apply repeats
 * the intent against the current revision, which keeps the review gate safe
 * when another tab or agent has changed the project in the meantime.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { formatCatalogContext, formatMcuContext, getCatalog } from '@/modules/components';
import { analyzePrompt } from '@/modules/project-understanding/heuristics';
import { buildRefreshers, controllerInfo } from '@/modules/orchestrator/context';
import { isRunning } from '@/modules/orchestrator';
import { applyChanges, type ApplyOutput } from '@/modules/fixer/apply';
import { appendRevision, createRevision } from '@/modules/orchestrator/revisions';
import { validateProject } from '@/modules/validator';
import { diffLines } from '@/lib/diff/lines';
import {
  buildHardwareEditPlan,
  resolveHardwareEdit,
  type HardwareEditPlan,
  type HardwareEditPreview,
} from '@/modules/hardware-copilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('plan'),
    message: z.string().trim().min(3, 'Describe the hardware change.').max(4000, 'Keep the edit under 4000 characters.'),
  }),
  z.object({
    mode: z.literal('apply'),
    message: z.string().trim().min(3, 'Describe the hardware change.').max(4000, 'Keep the edit under 4000 characters.'),
    baseRevision: z.number().int().nonnegative(),
  }),
]);

function partsPreview(before: ApplyOutput['project'], after: ApplyOutput['project']): HardwareEditPreview['parts'] {
  const beforeById = new Map(before.components.map((selection) => [selection.componentId, selection]));
  const afterById = new Map(after.components.map((selection) => [selection.componentId, selection]));
  const rows: HardwareEditPreview['parts'] = [];

  for (const [componentId, selection] of beforeById) {
    if (!afterById.has(componentId)) {
      rows.push({ kind: 'removed', before: selection.name, detail: `remove ${selection.quantity} × ${selection.name}` });
      continue;
    }
    const next = afterById.get(componentId);
    if (next && next.quantity !== selection.quantity) {
      rows.push({
        kind: 'changed',
        before: `${selection.quantity} × ${selection.name}`,
        after: `${next.quantity} × ${next.name}`,
        detail: `quantity ${selection.quantity} → ${next.quantity}`,
      });
    }
  }
  for (const [componentId, selection] of afterById) {
    if (!beforeById.has(componentId)) {
      rows.push({ kind: 'added', after: selection.name, detail: `add ${selection.quantity} × ${selection.name}` });
    }
  }
  return rows;
}

function previewOf(before: ApplyOutput['project'], after: ApplyOutput['project'], result: ApplyOutput): HardwareEditPreview {
  const beforeCode = before.artifacts.code?.files.map((file) => `${file.path}\n${file.content}`).join('\n') ?? '';
  const afterCode = after.artifacts.code?.files.map((file) => `${file.path}\n${file.content}`).join('\n') ?? '';
  const codeDiff = diffLines(beforeCode, afterCode);
  const beforePins = before.pinAssignments.length;
  const afterPins = after.pinAssignments.length;
  const beforeWires = before.wiring?.connections.length ?? 0;
  const afterWires = after.wiring?.connections.length ?? 0;

  return {
    parts: partsPreview(before, after),
    pins: { before: beforePins, after: afterPins, delta: afterPins - beforePins },
    wires: { before: beforeWires, after: afterWires, delta: afterWires - beforeWires },
    firmware: { files: after.artifacts.code?.files.length ?? 0, changed: codeDiff.added > 0 || codeDiff.removed > 0 },
    applied: result.applied.length,
    rejected: result.rejected.map((entry) => ({ op: entry.op, reason: entry.reason })),
    notes: result.notes.slice(0, 8),
  };
}

function withPreview(plan: HardwareEditPlan, preview: HardwareEditPreview): HardwareEditPlan {
  return { ...plan, preview };
}

async function previewChanges(
  project: Awaited<ReturnType<typeof getProjectState>>,
  changes: HardwareEditPlan['changes'],
  catalog: Awaited<ReturnType<typeof getCatalog>>['components'],
): Promise<ApplyOutput> {
  if (!project) throw new Error('Project not found.');
  const controller = controllerInfo(project, catalog);
  const refreshers = buildRefreshers({ catalog, baseline: project, analysis: analyzePrompt(project.prompt) });
  return applyChanges({
    project,
    changes,
    catalog,
    ...(controller.profile ? { profile: controller.profile } : {}),
    iteration: project.iteration.current,
    syncFirmware: true,
    refresh: refreshers,
  });
}

function statusFor(passed: boolean, warnings: number): 'completed' | 'completed_with_warnings' | 'completed_with_errors' {
  if (!passed) return 'completed_with_errors';
  return warnings > 0 ? 'completed_with_warnings' : 'completed';
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });

  try {
    const body = parseBody(BodySchema, await readJson(request));
    const project = await getProjectState(id.trim());
    if (!project) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    if (isRunning(project.id) || ['running', 'validating', 'fixing'].includes(project.status)) {
      return jsonError(409, { code: 'project_busy', message: 'The project is still running. The copilot unlocks when the current build finishes.' });
    }
    if (project.status === 'intake' || project.components.length === 0) {
      return jsonError(409, { code: 'hardware_not_ready', message: 'Finish the first hardware build before editing its parts.' });
    }
    if (body.mode === 'apply' && body.baseRevision !== project.revision) {
      return jsonError(409, {
        code: 'stale_plan',
        message: `This plan was based on v${body.baseRevision}, but the project is now v${project.revision}. Plan it again so the diff starts from the current design.`,
      });
    }

    const catalog = (await getCatalog()).components;
    const resolution = resolveHardwareEdit(body.message, project, catalog);
    let plan = buildHardwareEditPlan(resolution, project, body.message);

    if (plan.status !== 'ready' || plan.changes.length === 0) {
      return jsonOk({ plan });
    }

    const previewBase = body.mode === 'apply' ? { ...project, revision: project.revision + 1 } : project;
    const preview = await previewChanges(previewBase, plan.changes, catalog);
    plan = withPreview(plan, previewOf(project, preview.project, preview));

    if (body.mode === 'plan') {
      return jsonOk({ plan });
    }

    if (preview.applied.length === 0) {
      return jsonOk({ applied: false, plan });
    }

    const candidate = { ...preview.project, revision: project.revision + 1 };
    const controller = controllerInfo(candidate, catalog);
    const validation = await validateProject({
      project: candidate,
      catalog,
      catalogContext: formatCatalogContext(catalog),
      mcuContext: controller.profile ? formatMcuContext([controller.profile]) : '',
      ...(controller.profile ? { profile: controller.profile } : {}),
      iteration: project.iteration.current,
      enableModelReview: false,
    });
    const finishedAt = new Date();
    const nextStatus = statusFor(validation.result.passed, validation.result.summary.warnings);
    const revisionProject = {
      ...candidate,
      validation: validation.result,
      status: nextStatus,
      stage: 'completed' as const,
      completedAt: finishedAt.toISOString(),
      updatedAt: finishedAt.toISOString(),
    };
    const revision = createRevision({
      project: revisionProject,
      version: candidate.revision,
      reason: 'replanned_after_human_input',
      summary: `Hardware Copilot: ${plan.summary}`,
      changes: preview.changes,
      validation: validation.result,
      stage: 'completed',
    });
    const revisions = appendRevision(project, revision);
    const saved = await saveProjectState(project.id, {
      components: revisionProject.components,
      hardwarePlan: revisionProject.hardwarePlan,
      pinAssignments: revisionProject.pinAssignments,
      wiring: revisionProject.wiring,
      softwarePlan: revisionProject.softwarePlan,
      artifacts: revisionProject.artifacts,
      validation: revisionProject.validation,
      revisions,
      revision: revisionProject.revision,
      status: revisionProject.status,
      stage: revisionProject.stage,
      completedAt: finishedAt,
    });
    if (!saved) return jsonError(500, { code: 'persistence_failed', message: 'The hardware edit was computed but could not be saved.' });

    await appendEvents(project.id, [
      {
        seq: project.events.reduce((max, event) => Math.max(max, event.seq), 0) + 1,
        id: createId('evt'),
        type: 'info',
        status: 'completed',
        message: `Hardware Copilot applied — ${plan.summary} — revision v${revisionProject.revision} verified with ${validation.result.summary.errors} error(s) and ${validation.result.summary.warnings} warning(s).`,
        timestamp: nowIso(),
        stage: 'completed',
        metadata: {
          source: 'hardware_copilot',
          request: body.message,
          revision: revisionProject.revision,
          applied: preview.applied.length,
          rejected: preview.rejected.length,
        },
      },
    ]);

    return jsonOk({ applied: true, plan, project: saved });
  } catch (error) {
    if (error instanceof BadRequestError) return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    const mapped = fromUnknown(error, `POST /api/projects/${id}/copilot`);
    return jsonError(mapped.status, mapped.error);
  }
}
