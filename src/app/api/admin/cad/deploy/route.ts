import { NextResponse } from 'next/server';
import { deployToVelxioAndCatalog, type CadComponentSpec } from '../../../../../../cad-helper/server';
import { adminGate } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const denied = adminGate(request);
  if (denied) return denied;
  try {
    const spec: CadComponentSpec = await request.json();

    if (!spec || !spec.id || !spec.name) {
      return NextResponse.json(
        { ok: false, error: 'Invalid component specification payload.' },
        { status: 400 }
      );
    }

    const result = await deployToVelxioAndCatalog(spec);

    // A failed deploy must not answer 200: the caller reads `ok`, but status
    // codes are what logs, retries and the health of a hosted deploy see.
    return NextResponse.json(
      { ok: result.success, result, ...(result.success ? {} : { error: result.message }) },
      { status: result.success ? 200 : 424 },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Deployment failed' },
      { status: 500 }
    );
  }
}
