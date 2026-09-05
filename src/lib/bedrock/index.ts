/** Bedrock service barrel. */

export {
  BedrockError,
  converse,
  describeBedrockConfig,
  extractText,
  resolveModel,
  type BedrockOp,
  type ConverseOptions,
  type TokenUsage,
} from './client';

export {
  generateFirmwareSpec,
  generateProjectSpec,
  proposeFixChanges,
  reviewProject,
  type BedrockOperationResult,
} from './operations';

export {
  buildFirmwareUserPrompt,
  buildFixUserPrompt,
  buildGenerationUserPrompt,
  buildValidationUserPrompt,
  ENGINEER_PERSONA,
  FIRMWARE_JSON_CONTRACT,
  FIRMWARE_PERSONA,
  GENERATION_JSON_CONTRACT,
  ISSUE_CODE_LIST,
  VALIDATION_JSON_CONTRACT,
  type FirmwarePromptInput,
  type FixPromptInput,
  type GenerationPromptInput,
  type ValidationPromptInput,
} from './prompts';

export { runStructuredCall, type StructuredCallOptions, type StructuredCallResult } from './structured';
