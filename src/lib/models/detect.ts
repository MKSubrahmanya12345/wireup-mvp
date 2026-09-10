/**
 * Model layer — family detection + effort policy.
 *
 * Detection is by model-id substring so it works identically for Bedrock
 * ids (`…gpt-6-astra…`, `…claude-fable-5…`), direct ids (`gpt-6-astra`,
 * `claude-fable-5-1`) and inference-profile ARNs. Effort defaults follow
 * the vendors' guidance: start at Fable's default (`high`) only for the
 * reviewer; expansion proposes at `medium`; the R2 probe runs at `low`;
 * nothing ever requests `none` (Astra rejects it).
 */

import type { EffortLevel, ModelFamily } from './types';

export function detectModelFamily(modelId: string | undefined | null): ModelFamily {
  if (!modelId || modelId.trim().length === 0) return 'none';
  const haystack = modelId.toLowerCase();
  if (haystack.includes('gpt-6-astra') || haystack.includes('astra')) return 'astra';
  if (haystack.includes('fable')) return 'fable';
  if (haystack.includes('opus-5') || haystack.includes('sonnet-5')) return 'fable'; // Mythos-era Claude shares the effort API
  return 'generic';
}

export function isAstraModel(modelId: string | undefined | null): boolean {
  return detectModelFamily(modelId) === 'astra';
}

export function isFableModel(modelId: string | undefined | null): boolean {
  return detectModelFamily(modelId) === 'fable';
}

export type EffortOp = 'intake' | 'generation' | 'validation' | 'fix' | 'codegen' | 'idea_expansion' | 'idea_r2' | 'idea_review';

/**
 * Default effort per operation. Env overrides (`WIREUP_MODEL_EFFORT_*`)
 * win; both families clamp to their own range (Astra/Fable min `low`).
 */
export function defaultEffort(op: EffortOp): EffortLevel {
  switch (op) {
    case 'idea_r2':
      return 'low'; // one cheap boolean probe
    case 'intake':
    case 'idea_expansion':
      return 'medium'; // structured proposals, bounded schema
    case 'generation':
    case 'codegen':
      return 'medium';
    case 'validation':
    case 'fix':
    case 'idea_review':
      return 'high'; // the reviewer earns the ceiling
  }
}

const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Clamp an effort override into range (unknown values fall back). */
export function parseEffort(value: string | undefined, fallback: EffortLevel): EffortLevel {
  const normalised = value?.trim().toLowerCase();
  if (normalised === 'low' || normalised === 'medium' || normalised === 'high' || normalised === 'xhigh' || normalised === 'max') return normalised;
  return fallback;
}

export function compareEffort(a: EffortLevel, b: EffortLevel): number {
  return EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b);
}
