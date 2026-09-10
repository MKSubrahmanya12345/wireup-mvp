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
  BEDROCK_CODEGEN_MODEL_ID: optionalString,
  BEDROCK_MAX_TOKENS: intFrom(8000),
  // Upper bound the structured caller may raise maxTokens to after a response
  // is cut short (stopReason "max_tokens"). Kimi K2.5 caps output at 16k.
  BEDROCK_MAX_TOKENS_CEILING: intFrom(16_000),
  BEDROCK_TEMPERATURE: floatFrom(0.2),
  BEDROCK_TOP_P: floatFrom(0.9),
  BEDROCK_TIMEOUT_MS: intFrom(120_000),
  BEDROCK_MAX_RETRIES: intFrom(2),

  // --- Agent behaviour ---
  WIREUP_MAX_FIX_ITERATIONS: intFrom(3),
  WIREUP_ENABLE_LLM_FIXER: boolFrom(true),
  WIREUP_ENABLE_LLM_VALIDATION: boolFrom(true),
  // AI-first firmware authoring: the model writes the sketch logic against the
  // grounded pin plan; the rooting gate keeps the managed blocks authoritative
  // and falls back to the deterministic template on any violation.
  WIREUP_ENABLE_LLM_CODEGEN: boolFrom(true),
  // Host compile gate: type-check generated/edited firmware against the stub
  // Arduino core with g++/clang++ before a revision is frozen. Skipped
  // honestly when no compiler is on PATH.
  WIREUP_ENABLE_FIRMWARE_COMPILE: boolFrom(true),
  WIREUP_AUTOSEED_COMPONENTS: boolFrom(true),
  WIREUP_MAX_REVISIONS: intFrom(12),
  WIREUP_MAX_EVENTS: intFrom(1500),

  // --- Everflow (the iteration loop over the project graph) ---
  // Passes per trigger before the loop yields (each pass is idempotent and
  // small; the loop also stops as soon as it stops making progress).
  WIREUP_EVERFLOW_MAX_PASSES: intFrom(3),
  // Open human-channel tasks allowed per project before new asks stay parked.
  WIREUP_EVERFLOW_MAX_HUMAN_TASKS: intFrom(12),
  // Research tool: allow the agent to pull a snippet from the cited page
  // (best-effort; offline sources always work and web findings are flagged
  // for human review).
  WIREUP_ENABLE_WEB_DOCS: boolFrom(true),
  WIREUP_WEB_DOCS_TIMEOUT_MS: intFrom(4000),

  // --- Networking ---
  WIREUP_DNS_RESULT_ORDER: optionalString,

  // --- Admin surface (/admin and /api/admin/*) ---
  // Both must be set for the admin surface to be reachable at all; leaving
  // them unset closes it, which is the correct default for a public host.
  WIREUP_ADMIN_EMAIL: optionalString,
  WIREUP_ADMIN_PASSWORD: optionalString,
  // Optional HMAC key for admin session cookies. Falls back to the password,
  // so changing the password also invalidates every live session.
  WIREUP_ADMIN_SECRET: optionalString,

  // --- Velxio (the simulator, usually hosted apart from Wireup) ---
  // Where the CAD studio writes generated models: <dir>/public/models3d.
  // Defaults to this repo's vendored checkout. Point it at a mounted shared
  // volume to hand assets to a separately hosted Velxio; leave it unset when
  // Velxio is deployed elsewhere entirely, and the studio says so honestly.
  WIREUP_VELXIO_FRONTEND_DIR: optionalString,

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
    codegenModelId?: string;
    maxTokens: number;
    maxTokensCeiling: number;
    temperature: number;
    topP: number;
    timeoutMs: number;
    maxRetries: number;
  };
  agent: {
    maxFixIterations: number;
    enableLlmFixer: boolean;
    enableLlmValidation: boolean;
    enableLlmCodegen: boolean;
    enableFirmwareCompile: boolean;
    autoseedComponents: boolean;
    maxRevisions: number;
    maxEvents: number;
    everflowMaxPasses: number;
    everflowMaxHumanTasks: number;
    webDocsEnabled: boolean;
    webDocsTimeoutMs: number;
  };
  net: {
    dnsResultOrder: DnsResultOrder;
  };
  admin: {
    email?: string;
    password?: string;
    secret?: string;
  };
  /** Absolute or relative path to a Velxio frontend checkout, or `null` when it is hosted apart. */
  velxioFrontendDir: string | null;
  nodeEnv: string;
  isProduction: boolean;
}

export class EnvError extends Error {
  readonly missing: string[];

  constructor(missing: string[], detail?: string) {
    super(
      `Wireup is missing required environment configuration: ${missing.join(', ')}. ` +
        `${deploymentEnvHint()}${detail ? ` ${detail}` : ''}`,
    );
    this.name = 'EnvError';
    this.missing = missing;
  }
}

/**
 * Where to put the missing value depends on where Wireup is running. Saying
 * "copy .env.example to .env" to someone whose app is deployed is a dead end —
 * a hosted container has no editable .env, its environment comes from the
 * provider.
 */
function deploymentEnvHint(): string {
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
    return 'This deployment runs on Render: add the variable under the service\'s Environment tab (or in render.yaml) and redeploy — a .env file is not read there.';
  }
  if (process.env.NODE_ENV === 'production') {
    return 'This is a production deployment: set the variable in the host\'s environment (Render/Fly/Containers dashboard, CI secret) rather than in a .env file.';
  }
  return 'Copy .env.example to .env and fill it in.';
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
      codegenModelId: parsed.BEDROCK_CODEGEN_MODEL_ID,
      maxTokens: parsed.BEDROCK_MAX_TOKENS,
      maxTokensCeiling: Math.max(parsed.BEDROCK_MAX_TOKENS, parsed.BEDROCK_MAX_TOKENS_CEILING),
      temperature: parsed.BEDROCK_TEMPERATURE,
      topP: parsed.BEDROCK_TOP_P,
      timeoutMs: parsed.BEDROCK_TIMEOUT_MS,
      maxRetries: parsed.BEDROCK_MAX_RETRIES,
    },
    agent: {
      maxFixIterations: Math.max(0, parsed.WIREUP_MAX_FIX_ITERATIONS),
      enableLlmFixer: parsed.WIREUP_ENABLE_LLM_FIXER,
      enableLlmValidation: parsed.WIREUP_ENABLE_LLM_VALIDATION,
      enableLlmCodegen: parsed.WIREUP_ENABLE_LLM_CODEGEN,
      enableFirmwareCompile: parsed.WIREUP_ENABLE_FIRMWARE_COMPILE,
      autoseedComponents: parsed.WIREUP_AUTOSEED_COMPONENTS,
      maxRevisions: Math.max(1, parsed.WIREUP_MAX_REVISIONS),
      maxEvents: Math.max(50, parsed.WIREUP_MAX_EVENTS),
      everflowMaxPasses: Math.max(1, parsed.WIREUP_EVERFLOW_MAX_PASSES),
      everflowMaxHumanTasks: Math.max(1, parsed.WIREUP_EVERFLOW_MAX_HUMAN_TASKS),
      webDocsEnabled: parsed.WIREUP_ENABLE_WEB_DOCS,
      webDocsTimeoutMs: Math.max(500, parsed.WIREUP_WEB_DOCS_TIMEOUT_MS),
    },
    net: {
      dnsResultOrder: parseDnsResultOrder(parsed.WIREUP_DNS_RESULT_ORDER),
    },
    admin: {
      email: parsed.WIREUP_ADMIN_EMAIL,
      password: parsed.WIREUP_ADMIN_PASSWORD,
      secret: parsed.WIREUP_ADMIN_SECRET,
    },
    velxioFrontendDir: parsed.WIREUP_VELXIO_FRONTEND_DIR ?? null,
    nodeEnv: parsed.NODE_ENV ?? 'development',
    isProduction: (parsed.NODE_ENV ?? 'development') === 'production',
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
  const { mongodb, isProduction } = env();
  if (!mongodb.uri) {
    throw new EnvError(
      ['MONGODB_URI'],
      isProduction
        ? 'Wireup cannot serve any project page without a database, so this fails on the first request rather than at boot.'
        : undefined,
    );
  }
  // A local default of mongodb://127.0.0.1 is fine; on a hosted service it is
  // always the wrong answer (the container has no mongod of its own) and the
  // resulting 10s socket timeout looks like a network fault, not a typo.
  if (isProduction && /\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(mongodb.uri)) {
    throw new EnvError(
      ['MONGODB_URI'],
      `MONGODB_URI points at ${mongodb.uri}, i.e. this container's own loopback. On a hosted deployment that must be a reachable server — a MongoDB Atlas (or equivalent) connection string.`,
    );
  }
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
