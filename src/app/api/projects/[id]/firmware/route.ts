/**
 * POST /api/projects/[id]/firmware — the firmware workbench write path.
 *
 * Two modes, one endpoint:
 *
 *   { mode: 'chat', message }    — a conversational edit turn: the model
 *                                  proposes a rooted sketch plan, the rooting
 *                                  gate + compile gate vet it, and on success
 *                                  it lands as a new revision with a diff.
 *   { mode: 'manual', path, content }
 *                                — a hand edit from the editor: deterministic
 *                                  sync passes repair pin/include drift, the
 *                                  compile gate vets, then revision.
 *
 * Both persist the chat transcript on the project document, so the workbench
 * history survives reloads. Changes are NEVER applied silently: every reply
 * carries the outcome (applied / answer / rejected / failed) and, for applied
 * changes, the unified diff.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { getProjectState, recordLlmCall, saveProjectState } from '@/lib/mongodb/projects';
import { describeBedrockConfig } from '@/lib/bedrock';
import { logger } from '@/lib/logging/logger';
import { isRunning } from '@/modules/orchestrator';
import { bedrockSketchEditProvider, llmCodegenEnabled } from '@/modules/code-generator/llm';
import { runFirmwareChatTurn, applyManualFirmwareEdit } from '@/modules/firmware-chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('chat'),
    message: z.string().trim().min(1, 'A message is required.').max(4000, 'Keep the message under 4000 characters.'),
  }),
  z.object({
    mode: z.literal('manual'),
    path: z.string().trim().min(1).max(200),
    content: z.string().max(200_000, 'The file is too large to save.'),
  }),
]);

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  const parsedBody = await readJson(request);
  const parsed = parseBody(BodySchema, parsedBody);

  try {
    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }
    if (isRunning(project.id) || project.status === 'running' || project.status === 'validating' || project.status === 'fixing') {
      return jsonError(409, { code: 'project_busy', message: 'This project is mid-generation — the workbench unlocks when the run finishes.' });
    }
    if (!project.artifacts.code) {
      return jsonError(409, { code: 'no_firmware', message: 'This project has no firmware to edit yet.' });
    }

    const body = parsed;

    if (body.mode === 'chat') {
      const bedrock = await describeBedrockConfig();
      const provider = bedrock.configured && llmCodegenEnabled() ? bedrockSketchEditProvider() : undefined;

      const turn = await runFirmwareChatTurn({ project, message: body.message, provider });
      for (const call of turn.llmCalls) {
        await recordLlmCall(project.id, call).catch(() => undefined);
      }

      const saved = await saveProjectState(project.id, {
        chat: turn.project.chat,
        artifacts: turn.project.artifacts,
        revisions: turn.project.revisions,
        revision: turn.project.revision
      });
      if (!saved) {
        return jsonError(500, { code: 'persistence_failed', message: 'The turn finished but the project could not be saved.' });
      }

      logger.info({ projectId: project.id, outcome: turn.assistantMessage.outcome, revision: saved.revision }, 'firmware chat turn');
      return jsonOk({ message: turn.assistantMessage, project: saved });
    }

    /* manual mode */
    const result = applyManualFirmwareEdit({ project, path: body.path, content: body.content });
    if (result.applied) {
      const saved = await saveProjectState(project.id, {
        chat: result.project.chat,
        artifacts: result.project.artifacts,
        revisions: result.project.revisions,
        revision: result.project.revision
      });
      if (!saved) {
        return jsonError(500, { code: 'persistence_failed', message: 'The edit was computed but the project could not be saved.' });
      }
      logger.info({ projectId: project.id, revision: saved.revision, path: body.path }, 'firmware manual edit saved');
      return jsonOk({ message: result.assistantMessage, project: saved, diagnostics: result.diagnostics });
    }

    // Refused: nothing was persisted. The client keeps its local editor text
    // and shows the diagnostics; we still store the transcript message so the
    // refusal is visible in history.
    const withMessage = {
      ...result.project,
      chat: [...result.project.chat, result.assistantMessage].slice(-100),
    };
    await saveProjectState(project.id, { chat: withMessage.chat }).catch(() => undefined);
    return jsonOk({ message: result.assistantMessage, project: null, diagnostics: result.diagnostics });
  } catch (error) {
    const mapped = fromUnknown(error, `POST /api/projects/${id}/firmware`);
    logger.error({ err: error, projectId: id }, 'firmware workbench request failed');
    return jsonError(mapped.status, mapped.error);
  }
}

/** Keep the JSON reader referenced for symmetric GET-style parsing later. */
void readJson;
