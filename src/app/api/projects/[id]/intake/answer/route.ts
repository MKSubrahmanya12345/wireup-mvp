/**
 * POST /api/projects/:id/intake/answer
 *
 * Answer one or more doubt-session questions. Answers become facts; skips
 * become recorded ASSUMPTIONS (a guess, never a silent fact).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { BadRequestError, fromUnknown, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { describeError, logger } from '@/lib/logging/logger';
import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { buildIntakeContext } from '@/modules/everflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const AnswerSchema = z.object({
  doubtId: z.string().min(1),
  value: z.string().trim().max(2000).optional(),
  /** `human` = answered with a value; `skipped` = accept the default as an assumption. */
  via: z.enum(['human', 'skipped']).default('human'),
});

const BodySchema = z
  .object({
    answer: AnswerSchema.optional(),
    answers: z.array(AnswerSchema).max(10).optional(),
  })
  .refine((body) => (body.answer ? 1 : body.answers?.length ?? 0) > 0, { message: 'Provide answer or answers.' });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    const parsed = parseBody(BodySchema, body);
    const items = parsed.answer ? [parsed.answer] : (parsed.answers as z.infer<typeof AnswerSchema>[]);

    const state = await getProjectState(id);
    if (!state) return jsonError(404, { code: 'not_found', message: 'Project not found.' });
    if (state.status !== 'intake') {
      return jsonError(409, { code: 'not_in_intake', message: 'This project is not in the doubt session.' });
    }

    const at = nowIso();
    const nextSeq = state.events.reduce((max, candidate) => Math.max(max, candidate.seq), 0) + 1;
    const doubts = state.doubts.map((doubt) => {
      const item = items.find((candidate) => candidate.doubtId === doubt.id);
      if (!item) return doubt;
      if (item.via === 'skipped') {
        return {
          ...doubt,
          status: 'assumed' as const,
          answer: { value: doubt.proposedDefault ?? 'agent decides', via: 'skipped' as const, at },
        };
      }
      return {
        ...doubt,
        status: 'answered' as const,
        answer: { value: item.value ?? doubt.proposedDefault ?? '', via: 'human' as const, at },
      };
    });

    const intakeContext = buildIntakeContext(doubts);
    await saveProjectState(id, { doubts, ...(intakeContext ? { intakeContext } : {}) });

    const answered = items
      .map((item) => doubts.find((doubt) => doubt.id === item.doubtId))
      .filter((doubt): doubt is NonNullable<typeof doubt> => Boolean(doubt));
    await appendEvents(id, [
      {
        seq: nextSeq,
        id: createId('evt'),
        type: 'intake_answered',
        status: 'info',
        message:
          items.length === 1
            ? `Doubt answered${items[0].via === 'skipped' ? ' (assumption recorded)' : ''}: ${answered[0]?.question ?? '—'}`
            : `${items.length} doubts answered${items.some((item) => item.via === 'skipped') ? ', assumption(s) recorded' : ''}.`,
        timestamp: at,
        stage: 'idle',
        metadata: { doubtIds: items.map((item) => item.doubtId), open: doubts.filter((doubt) => doubt.status === 'open').length },
      },
    ]);

    const updated = (await getProjectState(id))!;
    return jsonOk({ project: updated, openDoubts: updated.doubts.filter((doubt) => doubt.status === 'open').length });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    const described = describeError(error);
    logger.warn({ error: described.message }, 'intake answer failed');
    const mapped = fromUnknown(error, 'POST /api/projects/[id]/intake/answer');
    return jsonError(mapped.status, mapped.error);
  }
}
