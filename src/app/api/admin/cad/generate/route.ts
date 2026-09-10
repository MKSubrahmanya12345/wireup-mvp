import { NextResponse } from 'next/server';
import { buildCadBundle, type CadComponentSpec } from 'cad-helper';
import { adminGate } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const denied = adminGate(request);
  if (denied) return denied;
  try {
    const spec: CadComponentSpec = await request.json();

    if (!spec || !spec.id || !spec.name || !spec.dimensions) {
      return NextResponse.json(
        { ok: false, error: 'Invalid component specification payload.' },
        { status: 400 }
      );
    }

    const bundle = buildCadBundle(spec);

    return NextResponse.json({
      ok: true,
      spec: bundle.spec,
      stlAscii: bundle.stlAscii,
      stlBinaryBase64: bundle.stlBinary.toString('base64'),
      glbBinaryBase64: bundle.glbBinary.toString('base64'),
      stlByteLength: bundle.stlBinary.length,
      glbByteLength: bundle.glbBinary.length,
      seedCode: bundle.seedCode,
      manifestEntry: bundle.manifestEntry,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to generate 3D CAD bundle' },
      { status: 500 }
    );
  }
}
