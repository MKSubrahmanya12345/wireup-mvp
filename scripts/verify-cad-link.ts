/**
 * Registry ↔ CAD link verifier.
 *
 *   pnpm verify:cad-link
 *
 * The component registry is the electrical ground truth; the CAD studio turns
 * a part into geometry with named pin anchors. If those two drift apart, the
 * 3D view silently anchors wires to the wrong place — a failure that *looks*
 * fine on screen, which is the worst kind.
 *
 * This script proves the coupling holds:
 *
 *   1. every authored CAD preset maps to a real catalog id (no orphan models);
 *   2. every registry pin has a CAD anchor, by name or by declared alias;
 *   3. every CAD anchor exists on the registry part (no invented pins);
 *   4. the preset's studio role matches the registry category;
 *   5. every catalog part resolves to *some* previewable spec, so no part is
 *      unreachable from the studio.
 *
 * Needs no credentials, no MongoDB and no network. Exits 0 on success, 1 on
 * any mismatch.
 */

import { auditCatalogCadLink, listLinkedSpecs, specForCatalogComponent } from 'cad-helper';
import { SEED_COMPONENTS } from '@/modules/components/catalog';

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('-'.repeat(text.length));
}

function main(): number {
  const audit = auditCatalogCadLink();
  const linked = listLinkedSpecs();

  heading('wireup · registry ↔ CAD link');
  console.log(`catalog components : ${audit.totalCatalogComponents}`);
  console.log(`reviewed assemblies: ${audit.reference}`);
  console.log(`authored CAD specs : ${audit.preset}`);
  console.log(`derived parametric : ${audit.derived}`);

  const failures: string[] = [];

  // 1-4: preset/registry parity.
  if (!audit.ok) {
    for (const issue of audit.issues) {
      failures.push(`${issue.componentId}: [${issue.kind}] ${issue.detail}`);
    }
  }

  // 5: total coverage — every catalog part must be previewable.
  const linkedIds = new Set(linked.map((entry) => entry.spec.id));
  for (const component of SEED_COMPONENTS) {
    if (!linkedIds.has(component.id)) {
      failures.push(`${component.id}: catalog part has no resolvable CAD spec`);
      continue;
    }

    const resolved = specForCatalogComponent(component.id);
    if (!resolved) {
      failures.push(`${component.id}: specForCatalogComponent returned nothing`);
      continue;
    }

    // A spec with electrical pins must expose an anchor for each of them,
    // otherwise the wiring layer has nowhere to attach.
    const anchors = new Set(resolved.spec.pins.map((entry) => entry.name));
    for (const componentPin of component.pins) {
      if (resolved.tier === 'derived' && !anchors.has(componentPin.name)) {
        failures.push(`${component.id}: derived spec dropped pin "${componentPin.name}"`);
      }
    }

    const nonFinite = resolved.spec.pins.filter(
      (entry) => !Number.isFinite(entry.xMm) || !Number.isFinite(entry.yMm) || !Number.isFinite(entry.zMm),
    );
    if (nonFinite.length) {
      failures.push(`${component.id}: ${nonFinite.length} anchor(s) with non-finite coordinates`);
    }

    const { widthMm, lengthMm, heightMm } = resolved.spec.dimensions;
    if (!(widthMm > 0 && lengthMm > 0 && heightMm > 0)) {
      failures.push(`${component.id}: non-positive body dimensions (${widthMm} × ${lengthMm} × ${heightMm})`);
    }
  }

  heading('result');
  if (failures.length === 0) {
    console.log(`ok · ${linked.length} catalog parts are previewable and every anchor matches the registry`);
    return 0;
  }

  console.log(`${failures.length} problem(s):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  return 1;
}

process.exit(main());
