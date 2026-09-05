/**
 * Environment configuration.
 *
 * Every credential, model id and tunable comes from the environment — nothing
 * is hardcoded. Server only: never import this from a client component.
 */

import { z } from 'zod';

import { parseDnsResultOrder, type DnsResultOrder } from '@/lib/net/dns';

const optionalString = z
  .string()
  .transform((value) => (value.trim().length === 0 ? undefined : value.trim()))
  .optional()
  .or(z.literal('').transform(() => undefined));

const intFrom = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number.parseInt(value.trim(), 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const floatFrom = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number.parseFloat(value.trim());
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const boolFrom = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off'].includes(normalised)) return false;
      return fallback;
    });

const ServerEnvSchema = z.object({
  // --- MongoDB ---
  MONGODB_URI: optionalString,
  MONGODB_DB: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : 'wireup')),

  // --- Amazon Bedrock ---
  AWS_REGION: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : 'us-east-1')),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  AWS_SESSION_TOKEN: optionalString,
  BEDROCK_MODEL_ID: optionalString,
  BEDROCK_VALIDATION_MODEL_ID: optionalString,
  BEDROCK_FIXER_MODEL_ID: optionalString,
  BEDROCK_MAX_TOKENS: intFrom(8000),
  BEDROCK_TEMPERATURE: floatFrom(0.2),
  BEDROCK_TOP_P: floatFrom(0.9),
  BEDROCK_TIMEOUT_MS: intFrom(120_000),
  BEDROCK_MAX_RETRIES: intFrom(2),

  // --- Agent behaviour ---
  WIREUP_MAX_FIX_ITERATIONS: intFrom(3),
  WIREUP_ENABLE_LLM_FIXER: boolFrom(true),
  WIREUP_ENABLE_LLM_VALIDATION: boolFrom(true),
  WIREUP_AUTOSEED_COMPONENTS: boolFrom(true),
  WIREUP_MAX_REVISIONS: intFrom(12),
  WIREUP_MAX_EVENTS: intFrom(1500),

  // --- Networking ---
  WIREUP_DNS_RESULT_ORDER: optionalString,

  NODE_ENV: z.string().optional().transform((v) => v ?? 'development'),
});

export interface ServerEnv {
  mongodb: {
    uri: string;
    dbName: string;
  };
  bedrock: {
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    modelId?: string;
    validationModelId?: string;
    fixerModelId?: string;
    maxTokens: number;
    temperature: number;
    topP: number;
    timeoutMs: number;
    maxRetries: number;
  };
  agent: {
    maxFixIterations: number;
    enableLlmFixer: boolean;
    enableLlmValidation: boolean;
    autoseedComponents: boolean;
    maxRevisions: number;
    maxEvents: number;
  };
  net: {
    dnsResultOrder: DnsResultOrder;
  };
  nodeEnv: string;
}

export class EnvError extends Error {
  readonly missing: string[];

  constructor(missing: string[], detail?: string) {
    super(
      `Wireup is missing required environment configuration: ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill it in.${detail ? ` ${detail}` : ''}`,
    );
    this.name = 'EnvError';
    this.missing = missing;
  }
}

let cached: ServerEnv | null = null;

function read(): ServerEnv {
  const parsed = ServerEnvSchema.parse(process.env);

  return {
    mongodb: {
      uri: parsed.MONGODB_URI ?? '',
      dbName: parsed.MONGODB_DB ?? 'wireup',
    },
    bedrock: {
      region: parsed.AWS_REGION ?? 'us-east-1',
      accessKeyId: parsed.AWS_ACCESS_KEY_ID,
      secretAccessKey: parsed.AWS_SECRET_ACCESS_KEY,
      sessionToken: parsed.AWS_SESSION_TOKEN,
      modelId: parsed.BEDROCK_MODEL_ID,
      validationModelId: parsed.BEDROCK_VALIDATION_MODEL_ID,
      fixerModelId: parsed.BEDROCK_FIXER_MODEL_ID,
      maxTokens: parsed.BEDROCK_MAX_TOKENS,
      temperature: parsed.BEDROCK_TEMPERATURE,
      topP: parsed.BEDROCK_TOP_P,
      timeoutMs: parsed.BEDROCK_TIMEOUT_MS,
      maxRetries: parsed.BEDROCK_MAX_RETRIES,
    },
    agent: {
      maxFixIterations: Math.max(0, parsed.WIREUP_MAX_FIX_ITERATIONS),
      enableLlmFixer: parsed.WIREUP_ENABLE_LLM_FIXER,
      enableLlmValidation: parsed.WIREUP_ENABLE_LLM_VALIDATION,
      autoseedComponents: parsed.WIREUP_AUTOSEED_COMPONENTS,
      maxRevisions: Math.max(1, parsed.WIREUP_MAX_REVISIONS),
      maxEvents: Math.max(50, parsed.WIREUP_MAX_EVENTS),
    },
    net: {
      dnsResultOrder: parseDnsResultOrder(parsed.WIREUP_DNS_RESULT_ORDER),
    },
    nodeEnv: parsed.NODE_ENV ?? 'development',
  };
}

/** Cached, validated server environment. */
export function env(): ServerEnv {
  if (!cached) cached = read();
  return cached;
}

/** Force a re-read (used by tests/scripts after mutating process.env). */
export function resetEnvCache(): void {
  cached = null;
}

export function requireMongoEnv(): ServerEnv['mongodb'] {
  const { mongodb } = env();
  if (!mongodb.uri) throw new EnvError(['MONGODB_URI']);
  return mongodb;
}

export function requireBedrockEnv(): ServerEnv['bedrock'] {
  const { bedrock } = env();
  const missing: string[] = [];
  if (!bedrock.modelId) missing.push('BEDROCK_MODEL_ID');
  const hasStaticCreds = Boolean(bedrock.accessKeyId && bedrock.secretAccessKey);
  const hasChainCreds = Boolean(
    process.env.AWS_PROFILE ||
      process.env.AWS_ROLE_ARN ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_EC2_METADATA_DISABLED,
  );
  if (!hasStaticCreds && !hasChainCreds) {
    missing.push('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY');
  }
  if (missing.length > 0) {
    throw new EnvError(missing, 'Bedrock calls cannot be made without a model id and credentials.');
  }
  return bedrock;
}

/** Client-safe environment (NEXT_PUBLIC_* only). */
export const publicEnv = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? 'Wireup',
};
