/**
 * The Bedrock operations exposed to the orchestrator.
 *
 * CALL 1 — GENERATION  : generateProjectSpec()
 * CALL 2 — VALIDATION  : reviewProject()
 * FIX (agentic loop)   : proposeFixChanges()
 *
 * Each returns an already JSON-parsed payload plus transport metadata. Payload
 * *interpretation* belongs to the modules that own the data.
 */

import {
  buildFixUserPrompt,
  buildGenerationUserPrompt,
  buildValidationUserPrompt,
  ENGINEER_PERSONA,
  type FixPromptInput,
  type GenerationPromptInput,
  type ValidationPromptInput,
} from '@/lib/bedrock/prompts';
import { runStructuredCall, type StructuredCallResult } from '@/lib/bedrock/structured';
import type { BedrockOp } from '@/lib/bedrock/client';

export interface BedrockOperationResult extends StructuredCallResult {
  op: BedrockOp;
}

const VALIDATOR_PERSONA = `You are a ruthless but fair hardware design reviewer on the Wireup platform.
You audit generated embedded projects the way a senior engineer audits a design review package:
component selection, electrical compatibility, pin usage, power budget, wiring completeness,
firmware correctness and documentation consistency. You never rubber-stamp, and you never invent problems.
Answer with JSON ONLY.`;

const FIXER_PERSONA = `You are the Wireup repair agent. You receive a broken artifact plus the exact
validation issues and you emit the SMALLEST possible set of typed changes that fixes them.
You never regenerate a project, never touch unrelated artifacts, and never change ids you were not asked to change.
Answer with JSON ONLY.`;

/** CALL 1 — full project generation. */
export async function generateProjectSpec(input: GenerationPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'generation',
    system: [ENGINEER_PERSONA],
    user: buildGenerationUserPrompt(input),
  });
  return { ...result, op: 'generation' };
}

/** CALL 2 — critical validation review. */
export async function reviewProject(input: ValidationPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'validation',
    system: [ENGINEER_PERSONA, VALIDATOR_PERSONA],
    user: buildValidationUserPrompt(input),
    // Validation output is small; a lower temperature keeps it consistent.
    temperature: 0,
  });
  return { ...result, op: 'validation' };
}

/** Targeted fix — produces a changeset, never a new project. */
export async function proposeFixChanges(input: FixPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'fix',
    system: [ENGINEER_PERSONA, FIXER_PERSONA],
    user: buildFixUserPrompt(input),
    temperature: 0.1,
  });
  return { ...result, op: 'fix' };
}
