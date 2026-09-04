/**
 * POST /api/projects — create a brand new project and start the agent.
 * GET  /api/projects — list recent projects.
 *
 * Every POST inserts a fresh document: nothing is ever cached, deduplicated or
 * reused, even for an identical prompt.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { env } from '@/lib/validation/env';
import { createProjectRecord, listProjectStates } from '@/lib/mongodb/projects';
import { startGeneration } from '@/modules/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CreateProjectSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(8, 'Describe the project you want built (at least 8 characters).')
    .max(4000, 'Prompts are limited to 4000 characters.'),
  name: z.string().trim().min(1).max(120).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await readJson(request);
    const parsed = parseBody(CreateProjectSchema, body);

    const project = await createProjectRecord({
      prompt: parsed.prompt,
      ...(parsed.name ? { name: parsed.name } : {}),
      maxIterations: env().agent.maxFixIterations,
    });

    // The agent runs in the background; the client polls /events for progress.
    startGeneration(project.id);
    logger.info({ projectId: project.id }, 'project created, generation started');

    return jsonOk({ project, started: true }, { status: 201 });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    const mapped = fromUnknown(error, 'POST /api/projects');
    return jsonError(mapped.status, mapped.error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const rawLimit = request.nextUrl.searchParams.get('limit') ?? '25';
    const parsedLimit = Number.parseInt(rawLimit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 25;

    const projects = await listProjectStates(limit);
    return jsonOk({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        prompt: project.prompt,
        status: project.status,
        stage: project.stage,
        revision: project.revision,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        completedAt: project.completedAt,
        components: project.components.length,
        connections: project.wiring?.connections.length ?? 0,
        validation: project.validation
          ? { passed: project.validation.passed, errors: project.validation.summary.errors, warnings: project.validation.summary.warnings }
          : null,
      })),
      count: projects.length,
    });
  } catch (error) {
    const described = describeError(error);
    const mapped = fromUnknown(error, 'GET /api/projects');
    logger.warn({ error: described.message }, 'project list failed');
    return jsonError(mapped.status, mapped.error);
  }
}
