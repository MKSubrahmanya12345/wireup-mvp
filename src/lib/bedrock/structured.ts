/**
 * Structured (JSON) Bedrock calls.
 *
 * Wraps `converse()` with strict JSON extraction, repair, and one automatic
 * "your output was not valid JSON" retry before giving up. Nothing here knows
 * about hardware — modules own their own schemas.
 */

import { BedrockError, converse, type BedrockOp, type TokenUsage } from '@/lib/bedrock/client';
import { createLogger } from '@/lib/logging/logger';
import { parseJsonLoose, truncate } from '@/lib/validation/json';

const logger = createLogger('bedrock:structured');

export interface StructuredCallOptions {
  op: BedrockOp;
  /** System prompt blocks (persona + JSON contract). */
  system: string[];
  /** User turn content. */
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** How many extra calls to make when the payload cannot be parsed. */
  parseRetries?: number;
}

export interface StructuredCallResult {
  ok: boolean;
  payload?: unknown;
  raw: string;
  error?: string;
  /** Machine-readable failure class (e.g. `EAI_AGAIN`) when Bedrock errored. */
  code?: string;
  /** True when JSON repair was needed to recover the payload. */
  repaired: boolean;
  model: string;
  durationMs: number;
  usage: TokenUsage;
  /** Total Bedrock round trips (including parse retries). */
  attempts: number;
  stopReason?: string;
}

function mergeUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (next.totalTokens ?? 0),
  };
}

export async function runStructuredCall(options: StructuredCallOptions): Promise<StructuredCallResult> {
  const parseRetries = options.parseRetries ?? 1;
  const startedAt = Date.now();

  let usage: TokenUsage = {};
  let attempts = 0;
  let model = options.model ?? 'unknown';
  let lastRaw = '';
  let lastError = 'Unknown parse failure.';
  let stopReason: string | undefined;
  let repairedOverall = false;

  for (let round = 0; round <= parseRetries; round += 1) {
    const userText =
      round === 0
        ? options.user
        : `${options.user}

---
YOUR PREVIOUS RESPONSE COULD NOT BE PARSED AS JSON.

Parser error: ${lastError}

Previous response (truncated):
${truncate(lastRaw, 2500)}

Respond again with the COMPLETE corrected JSON object only. No markdown fences, no commentary, no trailing text.`;

    try {
      const call = await converse({
        op: options.op,
        model: options.model,
        system: options.system,
        userText,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      });

      attempts += call.attempts;
      usage = mergeUsage(usage, call.usage);
      model = call.model;
      lastRaw = call.text;
      stopReason = call.stopReason;

      const parsed = parseJsonLoose(call.text);
      if (parsed.ok) {
        logger.info('structured call ok', {
          op: options.op,
          model,
          rounds: round + 1,
          repaired: parsed.repaired,
          strategy: parsed.strategy,
          characters: call.text.length,
        });
        return {
          ok: true,
          payload: parsed.value,
          raw: call.text,
          repaired: parsed.repaired,
          model,
          durationMs: Date.now() - startedAt,
          usage,
          attempts,
          stopReason,
        };
      }

      lastError = parsed.error ?? 'Unable to parse JSON.';
      logger.warn('structured call produced unparseable JSON', {
        op: options.op,
        model,
        round: round + 1,
        error: lastError,
      });
    } catch (error) {
      // Transport / model level failure: not retryable here (client already retried).
      const message = error instanceof Error ? error.message : String(error);
      // The client resolved the model even though the call failed — report it
      // instead of the pre-call 'unknown' placeholder.
      if (error instanceof BedrockError && error.model && error.model !== 'unknown') {
        model = error.model;
      }
      const code = error instanceof BedrockError ? error.code : undefined;
      if (error instanceof BedrockError && error.attempts > 0) {
        attempts = error.attempts;
      }
      logger.error('structured call failed', {
        op: options.op,
        model,
        ...(code ? { code } : {}),
        attempts,
        error: message,
      });
      return {
        ok: false,
        raw: lastRaw,
        error: message,
        ...(code ? { code } : {}),
        repaired: false,
        model,
        durationMs: Date.now() - startedAt,
        usage,
        attempts,
        stopReason,
      };
    }
  }

  return {
    ok: false,
    raw: lastRaw,
    error: `Model output could not be parsed as JSON after ${parseRetries + 1} attempt(s). ${lastError}`,
    repaired: repairedOverall,
    model,
    durationMs: Date.now() - startedAt,
    usage,
    attempts,
    stopReason,
  };
}
