/**
 * Project Atlas API.
 *
 * POST mode=analyze clones the submitted source, builds a provenance graph,
 * quantifies what was actually understood and prepares a target transformation.
 * POST mode=apply re-reads the persisted source snapshot, checks the Atlas
 * version, and only then records the generated target project after the human
 * review boundary.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { isRunning } from '@/modules/orchestrator';
import { buildProjectAtlas, normalizeAtlasSource, planAtlasTransform, withAtlasTransform } from '@/modules/project-atlas';
import type { AtlasTargetSpec, ProjectAtlasState } from '@/types/project-atlas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TargetSchema = z.object({
  language: z.string().trim().min(1).max(48),
  framework: z.string().trim().max(80).optional(),
  packageName: z.string().trim().max(120).optional(),
});

const AnalyzeSchema = z.object({
  mode: z.literal('analyze'),
  source: z.object({
    title: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(['brief', 'profile', 'document', 'code', 'data', 'note']).optional(),
    content: z.string().trim().min(8, 'Provide at least a few source facts.').max(120_000),
  }),
  target: TargetSchema.default({ language: 'java' }),
});

const ApplySchema = z.object({
  mode: z.literal('apply'),
  baseVersion: z.number().int().positive(),
  target: TargetSchema,
});

const BodySchema = z.discriminatedUnion('mode', [AnalyzeSchema, ApplySchema]);

function eventSequence(project: NonNullable<Awaited<ReturnType<typeof getProjectState>>>): number {
  return project.events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function eventFor(
  project: NonNullable<Awaited<ReturnType<typeof getProjectState>>>,
  message: string,
  metadata: Record<string, unknown>,
) {
  return {
    seq: eventSequence(project),
    id: createId('evt'),
    type: 'info' as const,
    status: 'info' as const,
    message,
    timestamp: nowIso(),
    stage: 'understanding' as const,
    metadata: { source: 'project_atlas', ...metadata },
  };
}

function targetOf(target: z.infer<typeof TargetSchema>): AtlasTargetSpec {
  return {
    language: target.language,
    ...(target.framework ? { framework: target.framework } : {}),
    ...(target.packageName ? { packageName: target.packageName } : {}),
  };
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id?.trim()) return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });

  try {
    const project = await getProjectState(id.trim());
    if (!project) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    return jsonOk({ atlas: project.atlas ?? null });
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}/atlas`);
    return jsonError(mapped.status, mapped.error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id?.trim()) return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });

  try {
    const body = parseBody(BodySchema, await readJson(request));
    const project = await getProjectState(id.trim());
    if (!project) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    if (isRunning(project.id) || ['pending', 'running', 'validating', 'fixing'].includes(project.status)) {
      return jsonError(409, { code: 'project_busy', message: 'Let the current build finish before indexing a new project source.' });
    }

    if (body.mode === 'analyze') {
      const source = normalizeAtlasSource({
        title: body.source.title ?? 'User source',
        kind: body.source.kind ?? 'profile',
        content: body.source.content,
        origin: 'user',
      });
      const atlas = buildProjectAtlas([source], (project.atlas?.version ?? 0) + 1);
      const transform = planAtlasTransform(atlas, targetOf(body.target));
      const nextAtlas = withAtlasTransform(atlas, transform);
      const saved = await saveProjectState(project.id, { atlas: nextAtlas });
      if (!saved) return jsonError(500, { code: 'persistence_failed', message: 'Atlas was built but could not be persisted.' });

      await appendEvents(project.id, [eventFor(project, `Project Atlas indexed ${source.title} — ${nextAtlas.quantification.nodeCount} nodes, ${nextAtlas.quantification.edgeCount} edges, ${nextAtlas.quantification.metricCount} metrics.`, {
        action: 'analyze',
        atlasVersion: nextAtlas.version,
        target: transform.target.language,
        coverage: nextAtlas.quantification.coverage,
        confidence: nextAtlas.quantification.confidence,
      })]);
      return jsonOk({ atlas: nextAtlas, applied: false });
    }

    if (!project.atlas) {
      return jsonError(409, { code: 'atlas_missing', message: 'Index a source before applying a transformation.' });
    }
    if (body.baseVersion !== project.atlas.version) {
      return jsonError(409, {
        code: 'stale_atlas',
        message: `This transformation was based on Atlas v${body.baseVersion}, but the project is now at Atlas v${project.atlas.version}. Index the source again before applying it.`,
      });
    }

    // The browser sends only the target and version. The server re-reads the
    // source snapshot, so a client cannot smuggle arbitrary generated files
    // across the approval boundary.
    const freshAtlas = buildProjectAtlas(project.atlas.sources, project.atlas.version);
    const plan = planAtlasTransform(freshAtlas, targetOf(body.target));
    if (plan.status !== 'ready') {
      const nextAtlas = withAtlasTransform(freshAtlas, plan);
      return jsonOk({ atlas: nextAtlas, applied: false });
    }

    const appliedPlan = { ...plan, status: 'applied' as const, appliedAt: nowIso() };
    const nextAtlas: ProjectAtlasState = {
      ...freshAtlas,
      version: freshAtlas.version + 1,
      transform: appliedPlan,
      updatedAt: nowIso(),
    };
    const saved = await saveProjectState(project.id, { atlas: nextAtlas });
    if (!saved) return jsonError(500, { code: 'persistence_failed', message: 'The transformation was computed but could not be persisted.' });

    await appendEvents(project.id, [eventFor(project, `Project Atlas applied ${plan.target.language} projection — ${plan.files.length} files, ${plan.metrics.mappedFacts} mapped facts, ${(plan.metrics.confidence * 100).toFixed(0)}% mapping confidence.`, {
      action: 'apply',
      atlasVersion: nextAtlas.version,
      target: plan.target.language,
      files: plan.files.length,
      mappedFacts: plan.metrics.mappedFacts,
      confidence: plan.metrics.confidence,
    })]);
    return jsonOk({ atlas: nextAtlas, applied: true });
  } catch (error) {
    const mapped = fromUnknown(error, `POST /api/projects/${id}/atlas`);
    return jsonError(mapped.status, mapped.error);
  }
}
