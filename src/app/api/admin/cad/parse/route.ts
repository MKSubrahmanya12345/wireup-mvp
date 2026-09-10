import { NextResponse } from 'next/server';
import { resolveDatasheetInput } from '@cad-helper/online-datasheet';
import { adminGate } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const denied = adminGate(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const { rawText, overrides } = body;

    const result = await resolveDatasheetInput(rawText || '', overrides);

    return NextResponse.json({ ok: true, spec: result.spec, tier: result.tier ?? 'derived', provenance: result.provenance });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to parse datasheet' },
      { status: 500 }
    );
  }
}
