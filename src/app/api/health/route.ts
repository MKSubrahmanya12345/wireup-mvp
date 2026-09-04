/**
 * GET /api/health — dependency status for the UI banner and for operators.
 *
 * Reports MongoDB reachability, the component database size/source and the
 * Amazon Bedrock configuration. It never throws: a broken dependency is data,
 * not a 500.
 */

import { NextResponse } from 'next/server';

import { describeError } from '@/lib/logging/logger';
import { env } from '@/lib/validation/env';
import { countComponents } from '@/lib/mongodb/components';
import { getCatalog } from '@/modules/components';
import { describeBedrockConfig } from '@/lib/bedrock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const startedAt = Date.now();

  const mongo: { ok: boolean; components?: number; error?: string } = { ok: false };
  try {
    const components = await countComponents();
    mongo.ok = true;
    mongo.components = components;
  } catch (error) {
    mongo.error = describeError(error).message;
  }

  let catalog: { size: number; source: string; error?: string } = { size: 0, source: 'unavailable' };
  try {
    const state = await getCatalog();
    catalog = { size: state.components.length, source: state.source, ...(state.error ? { error: state.error } : {}) };
  } catch (error) {
    catalog = { size: 0, source: 'unavailable', error: describeError(error).message };
  }

  let bedrock: Awaited<ReturnType<typeof describeBedrockConfig>>;
  try {
    bedrock = await describeBedrockConfig();
  } catch (error) {
    bedrock = { configured: false, region: 'unknown', maxTokens: 0, temperature: 0, problem: describeError(error).message };
  }

  const configuration = env();
  const healthy = catalog.size > 0;

  return NextResponse.json(
    {
      ok: healthy,
      status: healthy ? 'ready' : 'degraded',
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      mongo,
      catalog,
      bedrock: {
        configured: bedrock.configured,
        region: bedrock.region,
        model: bedrock.model ?? null,
        validationModel: bedrock.validationModel ?? null,
        fixerModel: bedrock.fixerModel ?? null,
        maxTokens: bedrock.maxTokens,
        temperature: bedrock.temperature,
        problem: bedrock.problem ?? null,
      },
      agent: {
        maxFixIterations: configuration.agent.maxFixIterations,
        enableLlmFixer: configuration.agent.enableLlmFixer,
        enableLlmValidation: configuration.agent.enableLlmValidation,
        autoseedComponents: configuration.agent.autoseedComponents,
        maxRevisions: configuration.agent.maxRevisions,
        maxEvents: configuration.agent.maxEvents,
      },
      notes: [
        mongo.ok ? `MongoDB reachable (${mongo.components ?? 0} component document(s)).` : `MongoDB unreachable: ${mongo.error ?? 'unknown error'}`,
        catalog.size > 0
          ? `Component database: ${catalog.size} part(s) from ${catalog.source}.`
          : `Component database unavailable: ${catalog.error ?? 'unknown error'}`,
        bedrock.configured
          ? `Bedrock configured (${bedrock.region}, model ${bedrock.model ?? 'unknown'}).`
          : `Bedrock not configured (${bedrock.problem ?? 'missing credentials'}) — generation runs deterministically.`,
      ],
    },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } },
  );
}
