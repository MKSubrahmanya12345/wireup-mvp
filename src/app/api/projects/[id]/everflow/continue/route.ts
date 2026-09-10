/**
 * POST /api/projects/:id/everflow/continue
 *
 * Run another continuation pass on demand (the "run another pass" button).
 * The loop is idempotent and bounded — it stops as soon as it stops making
 * progress, or when the project is done / blocked only on humans.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { getProjectState } from '@/lib/mongodb/projects';
import { env } from '@/lib/validation/env';
import { continueEverflow, evaluateEverflow, materializeGraph, mongoEverflowStore } from '@/modules/everflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const state = await getProjectState(id);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });
    if (state.status === 'intake') {
      return jsonError(409, { code: 'not_in_intake', message: 'Start the build first — the loop works on finished designs.' });
    }

    await continueEverflow(id, 'manual', mongoEverflowStore(), {
      maxPasses: env().agent.everflowMaxPasses,
      maxHumanTasks: env().agent.everflowMaxHumanTasks,
    });

    const fresh = (await getProjectState(id))!;
    const graph = materializeGraph(fresh);
    const evaluation = evaluateEverflow(fresh, graph, fresh.everflow?.pass ?? 0);

    return jsonOk({
      projectId: id,
      status: fresh.status,
      graph,
      evaluation,
      doubts: fresh.doubts,
      humanTasks: fresh.humanTasks,
    });
  } catch (error) {
    const described = describeError(error);
    logger.warn({ error: described.message }, 'everflow continue failed');
    const mapped = fromUnknown(error, 'POST /api/projects/[id]/everflow/continue');
    return jsonError(mapped.status, mapped.error);
  }
}
