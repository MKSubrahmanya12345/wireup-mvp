import { NextResponse } from 'next/server';
import { auditCatalogCadLink, listLinkedSpecs } from 'cad-helper';

export const dynamic = 'force-dynamic';

/**
 * The CAD studio's component list.
 *
 * This is now driven by the component registry rather than by the hand-written
 * preset table: every catalog part is offered, each carrying the best model
 * available for it (reviewed assembly > authored preset > parametric spec
 * derived from the registry entry). The `tier` field lets the UI state which
 * one it is instead of implying every model is equally accurate.
 */
export async function GET() {
  try {
    const linked = listLinkedSpecs();

    const presets = linked.map(({ spec, tier, component }) => ({
      id: spec.id,
      name: spec.name,
      category: spec.category,
      description: spec.description,
      voltage: spec.voltage,
      dimensions: spec.dimensions,
      pinCount: spec.pins.length,
      pinNames: spec.pins.map((entry) => entry.name),
      tier,
      catalogCategory: component?.category ?? null,
      inCatalog: Boolean(component),
      spec,
    }));

    const audit = auditCatalogCadLink();

    return NextResponse.json({
      ok: true,
      presets,
      link: {
        ok: audit.ok,
        totalCatalogComponents: audit.totalCatalogComponents,
        reference: audit.reference,
        preset: audit.preset,
        derived: audit.derived,
        orphanPresets: audit.orphanPresets,
        issues: audit.issues,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load presets' },
      { status: 500 }
    );
  }
}
