/**
 * The Bedrock operations exposed to the orchestrator.
 *
 * CALL 1 — GENERATION  : generateProjectSpec()   (design: parts, plans — NO firmware)
 * CALL 2 — FIRMWARE    : generateFirmwareSpec()  (code written against the resolved pin map)
 * CALL 3 — VALIDATION  : reviewProject()
 * CALL 4 — FIX (agentic loop): proposeFixChanges()
 *
 * Generation and firmware are deliberately separate calls with the pin planner
 * between them: the model never designs the circuit and writes code for it in
 * the same step, so firmware can never be authored against pin decisions the
 * planner later overrides.
 *
 * Each returns an already JSON-parsed payload plus transport metadata. Payload
 * *interpretation* belongs to the modules that own the data.
 */

import {
  buildFirmwareUserPrompt,
  buildFixUserPrompt,
  buildGenerationUserPrompt,
  buildValidationUserPrompt,
  ENGINEER_PERSONA,
  FIRMWARE_PERSONA,
  type FirmwarePromptInput,
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
The pin plan is owned by the backend: you may reference the PIN_* constants from the resolved pin
map, but you never move, renumber or invent GPIO pins in code patches.
Answer with JSON ONLY.`;

/** CALL 1 — project design (components, plans, wiring intent; no firmware). */
export async function generateProjectSpec(input: GenerationPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'generation',
    system: [ENGINEER_PERSONA],
    user: buildGenerationUserPrompt(input),
  });
  return { ...result, op: 'generation' };
}

/** CALL 2 — firmware authored strictly against the resolved pin map. */
export async function generateFirmwareSpec(input: FirmwarePromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'firmware',
    system: [ENGINEER_PERSONA, FIRMWARE_PERSONA],
    user: buildFirmwareUserPrompt(input),
    temperature: 0.2,
  });
  return { ...result, op: 'firmware' };
}

/** CALL 3 — critical validation review. */
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

/** CALL 4 — targeted fix; produces a changeset, never a new project. */
export async function proposeFixChanges(input: FixPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'fix',
    system: [ENGINEER_PERSONA, FIXER_PERSONA],
    user: buildFixUserPrompt(input),
    temperature: 0.1,
  });
  return { ...result, op: 'fix' };
}
