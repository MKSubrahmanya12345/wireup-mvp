/**
 * Small HTTP helpers shared by the API routes.
 *
 * Every route answers with the same envelope so the frontend can rely on it:
 * `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { describeError, logger } from '@/lib/logging/logger';

export interface ApiError {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
}

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, { ...init, headers: noStore(init?.headers) });
}

export function jsonError(status: number, error: ApiError, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: noStore(init?.headers) });
}

function noStore(headers?: HeadersInit): HeadersInit {
  const base: Record<string, string> = {
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (!headers) return base;
  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) base[key] = value;
    return base;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) base[key] = value;
    return base;
  }
  return { ...base, ...(headers as Record<string, string>) };
}

/** Classify an unknown throw into a status code + envelope error. */
export function fromUnknown(error: unknown, context: string): { status: number; error: ApiError } {
  const described = describeError(error);
  logger.error({ err: error, context }, 'api error');

  const message = described.message;
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ServerSelectionTimeout|mongo|topology/i.test(message)) {
    return {
      status: 503,
      error: {
        code: 'database_unavailable',
        message: 'MongoDB is not reachable, so the project cannot be stored.',
        details: message,
        retryable: true,
      },
    };
  }
  if (/bedrock|aws|credentials|InvokeModel/i.test(message) || described.name === 'BedrockError') {
    return {
      status: 502,
      error: { code: 'bedrock_unavailable', message: 'Amazon Bedrock could not be reached.', details: message, retryable: true },
    };
  }
  if (described.name === 'EnvError' || /missing required environment/i.test(message)) {
    return { status: 500, error: { code: 'misconfigured', message, details: described.stack?.split('\n')[1] } };
  }
  if (described.name === 'PersistenceError') {
    return { status: 500, error: { code: 'persistence_failed', message, retryable: true } };
  }
  if (described.name === 'OrchestratorError') {
    const notFound = /does not exist/i.test(message);
    return { status: notFound ? 404 : 500, error: { code: notFound ? 'not_found' : 'orchestrator_failed', message } };
  }
  return { status: 500, error: { code: 'internal_error', message: `${context}: ${message}` } };
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError('Request body is not valid JSON.');
  }
}

export class BadRequestError extends Error {
  readonly code = 'bad_request';
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'BadRequestError';
    this.issues = issues;
  }
}

/** Parse a body with zod, converting failures into a 400 envelope. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new BadRequestError('Request body failed validation.', issues);
  }
  return result.data;
}

/** Await Next 15 dynamic route params. */
export async function routeParams(params: Promise<Record<string, string>>): Promise<Record<string, string>> {
  return params;
}
