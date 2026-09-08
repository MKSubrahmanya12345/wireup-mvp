/**
 * Shared offline bootstrap for the scratch/verification harnesses
 * (`scripts/repro-safe.ts`, `scripts/compile-check.ts`).
 *
 * Every harness must run with no MongoDB, no AWS credentials and no network:
 * the DNS stub makes Bedrock lookups fail fast with `EAI_AGAIN` — the exact
 * failure a flaky resolver produces — so the pipeline takes its deterministic
 * path, which is the path these scripts exist to exercise. Call
 * `installOfflineDns()` and `applyOfflineEnv()` at the very top of the script,
 * before any pipeline work (the stub only needs to be active before the first
 * Bedrock call, which happens inside main()).
 */

import dns from 'node:dns';

import type { ProjectState } from '@/types/project';
import { nowIso } from '@/lib/validation/time';

/** Force every `*.amazonaws.com` lookup to fail like a broken resolver would. */
export function installOfflineDns(): void {
  const realLookup = dns.lookup as unknown as (...args: unknown[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns as any).lookup = (hostname: string, ...rest: unknown[]): unknown => {
    const callback = rest[rest.length - 1];
    if (typeof callback === 'function' && String(hostname).endsWith('amazonaws.com')) {
      const error = new Error(`getaddrinfo EAI_AGAIN ${hostname}`) as NodeJS.ErrnoException;
      error.code = 'EAI_AGAIN';
      return (callback as (err: Error) => void)(error);
    }
    return realLookup(hostname, ...rest);
  };
}

/**
 * Point the pipeline at a MongoDB/Bedrock configuration that fails fast
 * instead of hanging: a short server-selection timeout and one Bedrock retry.
 * Only the identifying defaults are `??`-overridable from the environment, so
 * CI and sandboxes behave the same whether or not real variables are set.
 */
export function applyOfflineEnv(options: { accessKeyId: string; maxRetries?: string }): void {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=800';
  process.env.BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'moonshotai.kimi-k2.5';
  process.env.AWS_REGION = process.env.AWS_REGION ?? 'eu-north-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? options.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'not-a-real-secret';
  process.env.BEDROCK_MAX_RETRIES = options.maxRetries ?? '1';
}

/** Fresh ProjectState in the shape the pipeline expects. */
export function initialProject(id: string, prompt: string): ProjectState {
  const now = nowIso();
  return {
    id,
    name: 'Untitled project',
    prompt,
    status: 'pending',
    stage: 'idle',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    requirements: null,
    components: [],
    hardwarePlan: null,
    pinAssignments: [],
    wiring: null,
    softwarePlan: null,
    artifacts: { code: null, diagram: null, libraries: null, instructions: null },
    validation: null,
    revisions: [],
    events: [],
    iteration: { current: 0, max: 3 },
    llm: { calls: [] },
    revision: 0,
  };
}
