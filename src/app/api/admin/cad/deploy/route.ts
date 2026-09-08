import { NextResponse } from 'next/server';
import { deployToVelxioAndCatalog, type CadComponentSpec } from '../../../../../../cad-helper/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const spec: CadComponentSpec = await request.json();

    if (!spec || !spec.id || !spec.name) {
      return NextResponse.json(
        { ok: false, error: 'Invalid component specification payload.' },
        { status: 400 }
      );
    }

    const result = await deployToVelxioAndCatalog(spec);

    return NextResponse.json({
      ok: result.success,
      result,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Deployment failed' },
      { status: 500 }
    );
  }
}
