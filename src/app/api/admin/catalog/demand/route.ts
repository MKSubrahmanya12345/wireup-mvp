import { NextResponse } from 'next/server';
import { getDemandReport } from '@/modules/components/demand';

export const dynamic = 'force-dynamic';

/**
 * Ranked catalog gaps.
 *
 * Answers "which part should we add next?" with evidence instead of intuition:
 * every part the model asked for is recorded with what it actually resolved to,
 * and the gaps are ranked by frequency weighted by how wrong the current answer
 * is (a silent substitution costs more than an honest provisional part).
 */
export async function GET() {
  try {
    const report = await getDemandReport();
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to read demand telemetry' },
      { status: 500 },
    );
  }
}
