/**
 * GET /api/projects/[id]/simulation/software.zip
 *
 * The generated dashboard, as the raw zip the user downloads and sets up
 * themselves. Nothing was installed, compiled or executed to produce it — the
 * sources are generated in memory, statically validated, and deflated here.
 *
 * When the static gate found errors the archive is STILL served (a user who
 * wants to look at broken output is entitled to), but the findings ride along
 * in `VALIDATION.md` inside the zip and in the `X-Wireup-Validation` header so
 * nothing about the failure is hidden.
 */

import type { NextRequest } from 'next/server';

import { fromUnknown, jsonError } from '@/lib/http';
import { getProjectState } from '@/lib/mongodb/projects';
import { createZip } from '@/lib/zip';
import { buildSimulationBundle } from '@/modules/simulation';
import type { SoftwareFinding } from '@/modules/software-generator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The findings, as a file inside the archive. */
function validationReport(findings: SoftwareFinding[], passed: boolean, generatedAt: string): string {
  const lines = [
    '# Static validation report',
    '',
    `Generated ${generatedAt} by Wireup.`,
    '',
    'This project was **generated and statically checked only**. No dependency was',
    'installed, no compiler was run and nothing was executed while producing this',
    'zip. The checks below read the generated source text and catch the failures',
    'that stop a fresh checkout from starting: unresolved imports, missing entry',
    'points, invalid JSON, unbalanced delimiters, and drift between the dashboard',
    'and the firmware it was generated alongside.',
    '',
    'The real type gate is yours to run:',
    '',
    '```bash',
    'npm install',
    'npm run typecheck',
    'npm run build',
    '```',
    '',
  ];

  if (findings.length === 0) {
    lines.push('## Result', '', 'All static checks passed. No findings.', '');
    return lines.join('\n');
  }

  lines.push('## Result', '', passed ? 'No errors; warnings only.' : '**Errors were found — read them before running the project.**', '');
  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    lines.push(`### ${severity}s (${group.length})`, '');
    for (const finding of group) {
      lines.push(`- **${finding.code}**${finding.file ? ` · \`${finding.file}\`` : ''}`);
      lines.push(`  ${finding.message}`);
      if (finding.suggestion) lines.push(`  _${finding.suggestion}_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  try {
    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    const bundle = buildSimulationBundle(project);
    if (!bundle.software) {
      return jsonError(409, {
        code: 'software_not_ready',
        message: 'The dashboard has not been generated for this project yet.',
        details: bundle.blocked.software ?? `Current stage: ${project.stage}.`,
      });
    }

    const software = bundle.software;
    const root = software.slug;
    const entries = [
      ...software.files.map((file) => ({ path: `${root}/${file.path}`, content: file.content })),
      {
        path: `${root}/VALIDATION.md`,
        content: validationReport(software.findings, software.passed, software.generatedAt),
      },
    ];

    // The .vlx rides along so the zip is self-contained: unzip, and you have
    // both the dashboard and the circuit it was generated for.
    if (bundle.velxio) {
      entries.push({ path: `${root}/simulation/${root}.vlx`, content: bundle.velxio.json });
    }

    const zip = createZip(entries, { modifiedAt: new Date(software.generatedAt) });
    const errors = software.findings.filter((finding) => finding.severity === 'error').length;
    const warnings = software.findings.filter((finding) => finding.severity === 'warning').length;

    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(zip.length),
        'Content-Disposition': `attachment; filename="${root}-dashboard.zip"`,
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
        'X-Wireup-Validation': software.passed ? `passed (${warnings} warning(s))` : `failed (${errors} error(s))`,
      },
    });
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}/simulation/software.zip`);
    return jsonError(mapped.status, mapped.error);
  }
}
