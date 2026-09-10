/**
 * POST /api/projects/:id/build — start the build from the doubt session.
 *
 * This is the handoff the intake UI's "Build the project →" button calls.
 * It used to 404 (the route was never created), so the default everflow flow
 * dead-ended after the questions were answered — from the user's chair:
 * "I asked for an RC car and nothing came up."
 *
 * Contract:
 *   • blocking doubts must be settled first (the UI soft-gates; the server
 *     enforces — skipping a blocking doubt IS settling it, as an assumption);
 *   • any doubt still open at build time becomes a recorded assumption with
 *     its proposed default (never a silent guess);
 *   • `rebuild: true` re-runs generation as a new frozen revision
 *     (`replanned_after_human_input`), bounded by WIREUP_MAX_REVISIONS.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { env } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { buildIntakeContext } from '@/modules/everflow';
import { isRunning, startGeneration } from '@/modules/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BodySchema = z
  .object({
    rebuild: z.boolean().optional(),
  })
  .default({});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    const parsed = parseBody(BodySchema, body);

    const state = await getProjectState(id);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });
    if (isRunning(id)) {
      return jsonError(409, { code: 'already_running', message: 'A build is already running for this project.' });
    }

    if (parsed.rebuild) {
      const maxRevisions = env().agent.maxRevisions;
      if (state.revision >= maxRevisions) {
        return jsonError(409, {
          code: 'revision_cap',
          message: `Revision cap reached (${maxRevisions}). Open a new project instead of replanning this one.`,
        });
      }
      if (state.status === 'pending' || state.doubts.length === 0) {
        return jsonError(409, { code: 'nothing_to_rebuild', message: 'This project has no build to rebuild yet.' });
      }

      await appendEvents(id, [
        {
          seq: state.events.reduce((max, event) => Math.max(max, event.seq), 0) + 1,
          id: createId('evt'),
          type: 'rebuild_started',
          status: 'info',
          message: `Rebuild requested — the design is replanned as revision v${state.revision + 1}; v${state.revision} stays frozen for diffing.`,
          timestamp: nowIso(),
          stage: 'idle',
          metadata: { baseRevision: state.revision, nextRevision: state.revision + 1 },
        },
      ]);

      startGeneration(id, {
        baseRevision: state.revision + 1,
        reason: 'replanned_after_human_input',
        trigger: 'rebuild_requested',
      });
      logger.info({ projectId: id, baseRevision: state.revision + 1 }, 'rebuild started');
      return jsonOk({ project: state, started: true, rebuild: true, nextRevision: state.revision + 1 });
    }

    /* ---- first build from the doubt session ---- */
    if (state.status !== 'intake') {
      return jsonError(409, {
        code: 'not_in_intake',
        message: 'This project already has a build. Use `rebuild: true` to replan it as a new revision.',
      });
    }

    const at = nowIso();
    const openDoubts = state.doubts.filter((doubt) => doubt.status === 'open');
    const blockingOpen = openDoubts.filter((doubt) => doubt.blocking);
    if (blockingOpen.length > 0) {
      return jsonError(409, {
        code: 'blocking_doubts_open',
        message: `${blockingOpen.length} blocking question(s) still open — answer or skip them first.`,
        details: blockingOpen.map((doubt) => doubt.question).join(' | '),
      });
    }

    // Open non-blocking doubts become assumptions on the record (value = the
    // proposed default), so nothing the user ignored can act as a hidden fact.
    const doubts =
      openDoubts.length > 0
        ? state.doubts.map((doubt) =>
            doubt.status === 'open'
              ? {
                  ...doubt,
                  status: 'assumed' as const,
                  answer: { value: doubt.proposedDefault ?? 'agent decides', via: 'skipped' as const, at },
                }
              : doubt,
          )
        : state.doubts;
    const intakeContext = buildIntakeContext(doubts);

    await saveProjectState(id, {
      doubts,
      ...(intakeContext ? { intakeContext } : {}),
      status: 'pending',
    });

    if (openDoubts.length > 0) {
      await appendEvents(id, [
        {
          seq: state.events.reduce((max, event) => Math.max(max, event.seq), 0) + 1,
          id: createId('evt'),
          type: 'intake_answered',
          status: 'info',
          message: `${openDoubts.length} unsettled question(s) recorded as assumption(s) with their proposed defaults — revisit them on the Everflow tab.`,
          timestamp: at,
          stage: 'idle',
          metadata: { assumed: openDoubts.length, doubtIds: openDoubts.map((doubt) => doubt.id) },
        },
      ]);
    }

    startGeneration(id, { trigger: 'intake_completed' });
    logger.info({ projectId: id }, 'build started from the doubt session');
    return jsonOk({ project: { ...state, doubts }, started: true });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    const described = describeError(error);
    logger.warn({ error: described.message }, 'build start failed');
    const mapped = fromUnknown(error, 'POST /api/projects/[id]/build');
    return jsonError(mapped.status, mapped.error);
  }
}
