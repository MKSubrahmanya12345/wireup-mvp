/**
 * Model layer — GPT-6 Astra direct client (OpenAI Responses API).
 *
 * Used ONLY when `OPENAI_API_KEY` is set and the routed model id is an
 * Astra id; otherwise the router sends Astra ids through Bedrock Converse
 * (Astra is available on Bedrock — same model, fewer primitives).
 *
 * Implemented primitives (per the Sep 2026 API guidance):
 *   - `reasoning.effort` (min `low`; `none` is rejected — we never send it)
 *   - no `temperature` / `top_p` (removed for Astra tool calling)
 *   - async tools: `registerAsyncTool` tracks a pending call by `call_id`;
 *     `attachToolResult` resolves it. The model-facing half (issuing the
 *     call, continuing independent work) is the model's; this module is the
 *     application half the docs require ("track pending calls and return
 *     results with the original call ID").
 *   - `configuration_update`: change effort mid-conversation without
 *     rewriting the prefix (the `updateEffort` helper returns the patch the
 *     caller sends over its Responses session; over plain HTTPS each call
 *     just carries the new effort and the same prefix).
 *
 * What is NOT implemented: the WebSocket transport for true mid-token
 * steering. `foldSteerAtBoundary` is the honest seam — steers fold at tool
 * boundaries (Tier-1.5), and the event log says exactly that.
 */

import { createLogger } from '@/lib/logging/logger';

import type { EffortLevel, ModelCallUsage } from './types';

const logger = createLogger('models:astra');

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface AstraRequest {
  model: string;
  system: string[];
  userText: string;
  maxTokens?: number;
  effort?: EffortLevel;
  timeoutMs?: number;
}

export interface AstraResponse {
  text: string;
  usage: ModelCallUsage;
  stopReason?: string;
}

/* ------------------------------------------------------------------------- */
/* Async tools — the application half                                         */
/* ------------------------------------------------------------------------- */

export interface PendingToolCall {
  callId: string;
  name: string;
  arguments: string;
  issuedAt: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupAstraTools: Map<string, PendingToolCall> | undefined;
}

function pendingTools(): Map<string, PendingToolCall> {
  if (!globalThis.__wireupAstraTools) globalThis.__wireupAstraTools = new Map();
  return globalThis.__wireupAstraTools;
}

/** Track a tool call the model issued while it keeps working elsewhere. */
export function registerAsyncTool(call: PendingToolCall): void {
  pendingTools().set(call.callId, call);
}

/** Resolve a tracked call with its result (matched by the original call id). */
export function attachToolResult(callId: string): PendingToolCall | null {
  const table = pendingTools();
  const found = table.get(callId) ?? null;
  if (found) table.delete(callId);
  return found;
}

export function pendingToolCount(): number {
  return pendingTools().size;
}

/* ------------------------------------------------------------------------- */
/* Effort updates without cache resets                                        */
/* ------------------------------------------------------------------------- */

/**
 * The `configuration_update` patch: same conversation prefix, new effort.
 * Over the WebSocket session this object is sent as-is; over HTTPS the
 * caller just issues the next call with `effort` set to `next`.
 */
export function updateEffort(next: EffortLevel): { type: 'configuration_update'; reasoning: { effort: EffortLevel } } {
  return { type: 'configuration_update', reasoning: { effort: next } };
}

/* ------------------------------------------------------------------------- */
/* The HTTPS call                                                             */
/* ------------------------------------------------------------------------- */

function apiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function astraDirectAvailable(): boolean {
  return apiKey() !== null;
}

export async function callAstra(request: AstraRequest): Promise<AstraResponse> {
  const key = apiKey();
  if (!key) throw new Error('OPENAI_API_KEY is not set — Astra direct calls are unavailable (use Bedrock transport).');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);
  try {
    const input = [...request.system.map((text) => ({ role: 'system' as const, content: text })), { role: 'user' as const, content: request.userText }];
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: request.model,
        input,
        reasoning: { effort: request.effort ?? 'medium' },
        max_output_tokens: request.maxTokens ?? 8000,
        store: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI Responses API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
      output_text?: string;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      incomplete_details?: { reason?: string };
    };
    const text =
      payload.output_text ??
      (payload.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('')
        .trim();
    if (!text) throw new Error('Astra returned an empty completion.');
    logger.info('astra direct call ok', { model: request.model, characters: text.length });
    return {
      text,
      usage: {
        ...(payload.usage?.input_tokens !== undefined ? { inputTokens: payload.usage.input_tokens } : {}),
        ...(payload.usage?.output_tokens !== undefined ? { outputTokens: payload.usage.output_tokens } : {}),
        ...(payload.usage?.total_tokens !== undefined ? { totalTokens: payload.usage.total_tokens } : {}),
      },
      ...(payload.incomplete_details?.reason ? { stopReason: payload.incomplete_details.reason } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
