/**
 * Model layer — the router.
 *
 * One function, `converseRouted`, that every model operation calls instead
 * of Bedrock directly:
 *
 *   model id is Astra + OPENAI_API_KEY set   → OpenAI Responses (direct)
 *   model id is Fable + ANTHROPIC_API_KEY set → Anthropic Messages (direct)
 *   otherwise, Bedrock configured             → Bedrock Converse, with
 *     family-correct inference config (Astra/Fable: NO temperature/top_p —
 *     both vendors reject them; effort is recorded on the result and, for
 *     Bedrock, folded into the system prompt per Bedrock's Converse shape)
 *   otherwise                                 → ModelRouteError `no_model`
 *     (the caller degrades honestly — this throw is never user-facing)
 *
 * The Bedrock path keeps the existing retry/timeout/usage behaviour by
 * delegating to `converse()`; the direct paths are single-shot with their
 * own timeout (their SDKs would add retries, and Wireup reports failures
 * rather than hiding them behind aggressive retry loops).
 */

import { converse, type BedrockOp } from '@/lib/bedrock/client';
import { createLogger, describeError } from '@/lib/logging/logger';

import { callFable, fableDirectAvailable } from './anthropic-fable';
import { detectModelFamily } from './detect';
import { astraDirectAvailable, callAstra } from './openai-astra';
import type { EffortLevel, ModelTransport, RoutedCallOptions, RoutedCallResult } from './types';
import { ModelRouteError } from './types';

const logger = createLogger('models:router');

function asBedrockOp(op: string): BedrockOp {
  switch (op) {
    case 'generation':
    case 'validation':
    case 'fix':
    case 'codegen':
    case 'intake':
    case 'idea_expansion':
    case 'idea_review':
      return op;
    default:
      return 'generation';
  }
}

export interface RouteDecision {
  transport: ModelTransport;
  /** Why this transport (shown in logs + the agent console). */
  reason: string;
}

/** Pure routing decision (no I/O — the verifier asserts on this). */
export function decideRoute(model: string, keys: { openai: boolean; anthropic: boolean; bedrockModel: boolean }): RouteDecision {
  const family = detectModelFamily(model);
  if (family === 'astra' && keys.openai) return { transport: 'openai', reason: 'Astra model id + OPENAI_API_KEY — direct Responses API.' };
  if (family === 'fable' && keys.anthropic) return { transport: 'anthropic', reason: 'Fable model id + ANTHROPIC_API_KEY — direct Messages API.' };
  if (keys.bedrockModel) {
    if (family === 'astra') return { transport: 'bedrock', reason: 'Astra model id via Bedrock Converse (no OPENAI_API_KEY — WebSocket-only primitives unavailable).' };
    if (family === 'fable') return { transport: 'bedrock', reason: 'Fable model id via Bedrock Converse (no ANTHROPIC_API_KEY — direct-only knobs unavailable).' };
    return { transport: 'bedrock', reason: 'Bedrock Converse.' };
  }
  return { transport: 'bedrock', reason: 'No model configured.' };
}

function liveKeys(model: string): { openai: boolean; anthropic: boolean; bedrockModel: boolean } {
  return {
    openai: astraDirectAvailable(),
    anthropic: fableDirectAvailable(),
    bedrockModel: model.trim().length > 0,
  };
}

export async function converseRouted(options: RoutedCallOptions): Promise<RoutedCallResult> {
  const startedAt = Date.now();
  const family = detectModelFamily(options.model);
  const decision = decideRoute(options.model, liveKeys(options.model));

  if (!options.model || options.model.trim().length === 0) {
    throw new ModelRouteError('No model configured for this operation.', { code: 'no_model', model: options.model });
  }

  if (decision.transport === 'openai') {
    try {
      const result = await callAstra({
        model: options.model,
        system: options.system,
        userText: options.userText,
        maxTokens: options.maxTokens,
        effort: options.effort ?? 'medium',
        timeoutMs: options.timeoutMs,
      });
      return {
        text: result.text,
        usage: result.usage,
        model: options.model,
        transport: 'openai',
        family,
        effort: options.effort ?? 'medium',
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        attempts: 1,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw new ModelRouteError(describeError(error).message, { code: 'direct_call_failed', retryable: false, model: options.model });
    }
  }

  if (decision.transport === 'anthropic') {
    try {
      const result = await callFable({
        model: options.model,
        system: options.system,
        userText: options.userText,
        maxTokens: options.maxTokens,
        effort: options.effort ?? 'high',
        timeoutMs: options.timeoutMs,
      });
      return {
        text: result.text,
        usage: result.usage,
        model: options.model,
        transport: 'anthropic',
        family,
        effort: options.effort ?? 'high',
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        attempts: 1,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw new ModelRouteError(describeError(error).message, { code: 'direct_call_failed', retryable: false, model: options.model });
    }
  }

  // Bedrock transport (the default): family-correct inference config.
  const newFamily = family === 'astra' || family === 'fable';
  const effort: EffortLevel | null = newFamily ? (options.effort ?? (family === 'astra' ? 'medium' : 'high')) : null;
  // Bedrock Converse has no effort field: record it, and name it in the
  // system prompt so the model still sees the requested depth. Sampling
  // params are stripped for the new families (both vendors reject them).
  const system = newFamily && effort ? [...options.system, `Reasoning effort for this request: ${effort}. (Transport: Bedrock Converse.)`] : options.system;
  logger.info('routed call', { op: options.op, model: options.model, transport: 'bedrock', family, effort });

  const call = await converse({
    op: asBedrockOp(options.op),
    model: options.model,
    system,
    userText: options.userText,
    maxTokens: options.maxTokens,
    ...(newFamily ? {} : { temperature: options.temperature, topP: options.topP }),
    timeoutMs: options.timeoutMs,
  });
  return {
    text: call.text,
    usage: call.usage,
    model: call.model,
    transport: 'bedrock',
    family,
    effort,
    ...(call.stopReason ? { stopReason: call.stopReason } : {}),
    attempts: call.attempts,
    durationMs: call.durationMs,
  };
}
