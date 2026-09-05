/**
 * Amazon Bedrock client.
 *
 * The single place in the codebase that talks to Bedrock. Region, credentials
 * and model ids all come from the environment (`lib/validation/env.ts`).
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

import { createLogger, describeError } from '@/lib/logging/logger';
import { applyDnsResultOrder } from '@/lib/net/dns';
import { env, requireBedrockEnv } from '@/lib/validation/env';

const logger = createLogger('bedrock');

export type BedrockOp = 'generation' | 'validation' | 'fix';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export class BedrockError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly model: string;
  /** How many round trips were made before giving up (set by `converse`). */
  attempts: number;

  constructor(message: string, options: { code?: string; retryable?: boolean; statusCode?: number; model?: string } = {}) {
    super(message);
    this.name = 'BedrockError';
    this.code = options.code ?? 'bedrock_error';
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.model = options.model ?? 'unknown';
    this.attempts = 0;
  }
}

interface ClientCache {
  client: BedrockRuntimeClient | null;
  region: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupBedrock: ClientCache | undefined;
}

const cache: ClientCache = globalThis.__wireupBedrock ?? { client: null, region: null };
globalThis.__wireupBedrock = cache;

function buildClient(): { client: BedrockRuntimeClient; region: string } {
  const config = requireBedrockEnv();

  // Applied before the first socket is opened: on hosts whose resolver fails
  // the IPv6 half of a lookup, the default order turns a healthy endpoint into
  // a hard EAI_AGAIN. See lib/net/dns.ts.
  const dnsOrder = applyDnsResultOrder(env().net.dnsResultOrder);

  if (cache.client && cache.region === config.region) {
    return { client: cache.client, region: config.region };
  }

  const client = new BedrockRuntimeClient({
    region: config.region,
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
          },
        }
      : {}),
    maxAttempts: 1, // we implement our own retry/backoff so failures are observable
  });

  cache.client = client;
  cache.region = config.region;
  logger.info('client ready', { region: config.region, dnsResultOrder: dnsOrder });
  return { client, region: config.region };
}

/** Resolve which model serves a given operation. */
export function resolveModel(op: BedrockOp): string {
  const config = env().bedrock;
  const model =
    (op === 'validation' ? config.validationModelId : undefined) ??
    (op === 'fix' ? config.fixerModelId : undefined) ??
    config.modelId;

  if (!model) {
    throw new BedrockError(
      `No Bedrock model configured for op "${op}". Set BEDROCK_MODEL_ID (and optionally BEDROCK_${op.toUpperCase()}_MODEL_ID) in .env.`,
      { code: 'missing_model_configuration' },
    );
  }
  return model;
}

export interface ConverseOptions {
  op: BedrockOp;
  model?: string;
  system?: string[];
  userText: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
}

function createTimeoutSignal(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

interface ErrorFrame {
  name?: string;
  code?: string;
  message: string;
}

/**
 * Walk an error and its `cause` chain.
 *
 * Transport failures arrive wrapped: the AWS SDK hands us a bare `Error` named
 * "Error" with `code: ERR_HTTP2_STREAM_CANCEL` whose *cause* carries the real
 * `EAI_AGAIN` / `ETIMEDOUT` / ... code. Classifying only the outer frame is what
 * made DNS outages look like permanent, non-retryable model errors.
 */
function errorFrames(error: unknown): ErrorFrame[] {
  const frames: ErrorFrame[] = [];
  let current: unknown = error;

  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      frames.push({
        name: current.name,
        ...(typeof code === 'string' ? { code } : {}),
        message: current.message,
      });
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    frames.push({ message: describeError(current).message });
    break;
  }

  return frames;
}

/**
 * Codes that mean "we never received an answer" (DNS, TCP, TLS, socket).
 * They are always worth retrying — the opposite of a Bedrock rejection.
 */
const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NODATA',
  'EAI_NONAME',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'ERR_HTTP2_STREAM_CANCEL',
  'ERR_HTTP2_STREAM_ERROR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const DNS_ERROR_CODES = new Set(['EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME', 'ENOTFOUND']);

function classifyError(error: unknown, model: string): BedrockError {
  const described = describeError(error);
  const frames = errorFrames(error);
  const name = frames[0]?.name ?? described.name ?? '';
  const statusCode =
    typeof (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 'number'
      ? ((error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode as number)
      : undefined;

  /* Deepest network code wins: ERR_HTTP2_STREAM_CANCEL -> EAI_AGAIN. */
  const codes = frames.map((frame) => frame.code).filter((code): code is string => typeof code === 'string');
  const networkCode = [...codes].reverse().find((code) => NETWORK_ERROR_CODES.has(code));
  const haystack = [name, ...codes, ...frames.map((frame) => frame.message)].join(' | ');

  const retryableNames = [
    'ThrottlingException',
    'ModelTimeoutException',
    'ServiceQuotaExceededException',
    'ServiceUnavailableException',
    'InternalServerException',
    'TooManyRequestsException',
    'TimeoutError',
    'AbortError',
    'ECONNRESET',
    'ETIMEDOUT',
  ];

  const retryable =
    networkCode !== undefined ||
    retryableNames.some((candidate) => haystack.includes(candidate)) ||
    haystack.includes('socket hang up') ||
    (statusCode !== undefined && (statusCode === 429 || statusCode >= 500));

  const code =
    networkCode ??
    (name && name !== 'Error' ? name : undefined) ??
    (statusCode ? `http_${statusCode}` : undefined) ??
    'bedrock_error';

  /* Unreachable host: say so plainly, and name the host that was not reached. */
  if (networkCode) {
    const region = env().bedrock.region;
    const host = `bedrock-runtime.${region}.amazonaws.com`;
    const dnsFailure = DNS_ERROR_CODES.has(networkCode);
    return new BedrockError(
      dnsFailure
        ? `Cannot reach Amazon Bedrock in ${region}: DNS lookup for ${host} failed (${networkCode}). ` +
            'The request never left this machine, so credentials, model id and permissions were not evaluated. ' +
            'Check the DNS resolver on the host running Wireup (VPN, Docker embedded DNS, firewall/AV) and retry - ' +
            'EAI_AGAIN is a temporary resolver failure.'
        : `Cannot reach Amazon Bedrock in ${region}: the connection to ${host} failed (${networkCode}). ` +
            'The request never completed a round trip, so this is a network problem rather than a model or credentials problem.',
      { code, retryable, statusCode, model },
    );
  }

  if (name === 'AccessDeniedException' || statusCode === 403) {
    return new BedrockError(
      `Bedrock denied access to model "${model}". Check AWS credentials and that the model is enabled in ${env().bedrock.region}.`,
      { code, retryable: false, statusCode, model },
    );
  }
  if (name === 'ValidationException' || statusCode === 400) {
    return new BedrockError(`Bedrock rejected the request for model "${model}": ${described.message}`, {
      code,
      retryable: false,
      statusCode,
      model,
    });
  }
  if (name === 'ResourceNotFoundException' || statusCode === 404) {
    return new BedrockError(`Bedrock model "${model}" was not found in ${env().bedrock.region}. Check BEDROCK_MODEL_ID.`, {
      code,
      retryable: false,
      statusCode,
      model,
    });
  }

  return new BedrockError(described.message || 'Bedrock call failed', {
    code,
    retryable,
    statusCode,
    model,
  });
}

export function extractText(output: ConverseCommandOutput): string {
  const content = output.output?.message?.content ?? [];
  return content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

/** One Bedrock Converse call with timeout + bounded retries. */
export async function converse(options: ConverseOptions): Promise<{
  text: string;
  usage: TokenUsage;
  model: string;
  stopReason?: string;
  attempts: number;
  durationMs: number;
}> {
  const config = env().bedrock;
  const model = options.model ?? resolveModel(options.op);
  const maxRetries = Math.max(0, config.maxRetries);
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;

  const input: ConverseCommandInput = {
    modelId: model,
    messages: [{ role: 'user', content: [{ text: options.userText }] }],
    ...(options.system && options.system.length > 0
      ? { system: options.system.map((text) => ({ text })) }
      : {}),
    inferenceConfig: {
      maxTokens: options.maxTokens ?? config.maxTokens,
      temperature: options.temperature ?? config.temperature,
      topP: options.topP ?? config.topP,
    },
  };

  const startedAt = Date.now();
  let attempt = 0;
  let lastError: BedrockError | null = null;

  while (attempt <= maxRetries) {
    attempt += 1;
    const { client } = buildClient();
    const timeout = createTimeoutSignal(timeoutMs);

    try {
      const command = new ConverseCommand(input);
      const output = await client.send(command, { abortSignal: timeout.signal });
      const text = extractText(output);

      if (text.length === 0) {
        throw new BedrockError('Bedrock returned an empty completion.', {
          code: 'empty_completion',
          retryable: attempt <= maxRetries,
          model,
        });
      }

      return {
        text,
        usage: {
          inputTokens: output.usage?.inputTokens,
          outputTokens: output.usage?.outputTokens,
          totalTokens: output.usage?.totalTokens,
        },
        model,
        stopReason: output.stopReason,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error instanceof BedrockError ? error : classifyError(error, model);
      logger.warn('call failed', {
        op: options.op,
        model,
        attempt,
        code: lastError.code,
        retryable: lastError.retryable,
        error: lastError.message,
      });

      if (!lastError.retryable || attempt > maxRetries) break;

      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, backoff));
    } finally {
      timeout.dispose();
    }
  }

  if (lastError) {
    lastError.attempts = attempt;
    throw lastError;
  }
  throw new BedrockError('Bedrock call failed for an unknown reason.', { model });
}

/** Non-throwing probe used by the API health endpoint. */
export async function describeBedrockConfig(): Promise<{
  configured: boolean;
  region: string;
  model?: string;
  validationModel?: string;
  fixerModel?: string;
  maxTokens: number;
  temperature: number;
  problem?: string;
}> {
  const config = env().bedrock;
  try {
    requireBedrockEnv();
    return {
      configured: true,
      region: config.region,
      model: config.modelId,
      validationModel: config.validationModelId || config.modelId,
      fixerModel: config.fixerModelId || config.modelId,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    };
  } catch (error) {
    return {
      configured: false,
      region: config.region,
      model: config.modelId,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      problem: describeError(error).message,
    };
  }
}
