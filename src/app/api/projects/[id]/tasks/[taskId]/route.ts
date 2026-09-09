/**
 * /api/projects/[id]/tasks/[taskId] — the human's side of the protocol.
 *
 *   POST { action: 'claim' }
 *   POST { action: 'submit', answer, evidence?, note? }
 *   POST { action: 'skip' }
 *
 * `submit` on a task with a `fact` key writes that answer into the project's
 * fact list, where later planning reads it instead of guessing. `skip` applies
 * the task default and records it as an assumption — it never blocks the build.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError, jsonOk } from '@/lib/http';
import { getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { humanLoopSummary, nextActionable, claimTask, skipTask, submitTask } from '@/modules/human-loop';
import { emptyHumanLoop } from '@/modules/human-loop/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>;
}

interface ActionBody {
  action?: 'claim' | 'submit' | 'skip';
  answer?: string;
  evidence?: string;
  note?: string;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params;
  if (!id?.trim()) return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  if (!taskId?.trim()) return jsonError(400, { code: 'bad_request', message: 'A task id is required.' });

  let body: ActionBody = {};
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return jsonError(400, { code: 'bad_request', message: 'Expected a JSON body with an action.' });
  }

  const action = body.action;
  if (action !== 'claim' && action !== 'submit' && action !== 'skip') {
    return jsonError(400, { code: 'bad_request', message: 'action must be one of: claim, submit, skip.' });
  }

  try {
    const project = await getProjectState(id.trim());
    if (!project) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });

    const current = project.humanLoop ?? emptyHumanLoop();
    let outcome;

    if (action === 'claim') {
      outcome = claimTask(current, taskId.trim());
    } else if (action === 'submit') {
      const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
      if (answer.length === 0) {
        return jsonError(400, { code: 'bad_request', message: 'submit requires a non-empty answer.' });
      }
      outcome = submitTask(current, taskId.trim(), {
        answer,
        ...(body.evidence ? { evidence: body.evidence } : {}),
        ...(body.note ? { note: body.note } : {}),
      });
    } else {
      outcome = skipTask(current, taskId.trim());
    }

    if (!outcome.task) {
      return jsonError(404, { code: 'not_found', message: `Task ${taskId} does not exist on this project.` });
    }

    const saved = await saveProjectState(id.trim(), { humanLoop: outcome.state });
    if (!saved) return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });

    return jsonOk({
      task: outcome.task,
      fact: outcome.fact ?? null,
      summary: humanLoopSummary(outcome.state),
      next: nextActionable(outcome.state)?.id ?? null,
    });
  } catch (error) {
    const mapped = fromUnknown(error, `POST /api/projects/${id}/tasks/${taskId}`);
    return jsonError(mapped.status, mapped.error);
  }
}
