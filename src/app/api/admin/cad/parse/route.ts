import { NextResponse } from 'next/server';
import { parseDatasheetText } from 'cad-helper';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { rawText, overrides } = body;

    const spec = parseDatasheetText(rawText || '', overrides);

    return NextResponse.json({ ok: true, spec });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to parse datasheet' },
      { status: 500 }
    );
  }
}
