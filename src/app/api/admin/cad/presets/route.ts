import { NextResponse } from 'next/server';
import { COMPONENT_PRESETS, type CadComponentSpec } from 'cad-helper';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const list = Object.values(COMPONENT_PRESETS as Record<string, CadComponentSpec>).map((preset) => ({
      id: preset.id,
      name: preset.name,
      category: preset.category,
      description: preset.description,
      voltage: preset.voltage,
      dimensions: preset.dimensions,
      pinCount: preset.pins.length,
      pinNames: preset.pins.map((p) => p.name),
      spec: preset,
    }));

    return NextResponse.json({ ok: true, presets: list });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load presets' },
      { status: 500 }
    );
  }
}
