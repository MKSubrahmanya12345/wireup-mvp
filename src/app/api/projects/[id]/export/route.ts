/**
 * GET /api/projects/[id]/export
 *
 * One click, one honest handoff. The build pack is deliberately assembled
 * from the project's persisted artifacts instead of asking the browser to
 * stitch together several downloads. A judge can unzip it and immediately see
 * the firmware, BOM, wiring, simulator diagram, instructions and validation
 * report that belong to the same revision.
 */

import { fromUnknown, jsonError } from '@/lib/http';
import { getProjectState } from '@/lib/mongodb/projects';
import { createZip, type ZipEntry } from '@/lib/zip';
import { toWokwiDiagram } from '@/modules/diagram-generator/wokwi';
import type { ProjectState } from '@/types/project';
import type { WiringEndpoint } from '@/types/wiring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Keep the download name friendly without letting project names escape a path. */
function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 72);
  return slug || fallback;
}

/** Generated file paths are trusted, but the archive should still enforce its boundary. */
function archivePath(value: string, fallback: string): string {
  const path = value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  if (!path || path.split('/').includes('..')) return fallback;
  return path;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function instanceName(project: ProjectState, endpoint: Pick<WiringEndpoint, 'instanceId'>): string {
  for (const selection of project.components) {
    const instance = selection.instances.find((candidate) => candidate.instanceId === endpoint.instanceId);
    if (instance) return instance.label ?? instance.name;
  }
  return endpoint.instanceId;
}

function endpointText(project: ProjectState, endpoint: Pick<WiringEndpoint, 'instanceId' | 'pin'>): string {
  return `${instanceName(project, endpoint)} · ${endpoint.pin}`;
}

function partsMarkdown(project: ProjectState): string {
  const lines = [
    '# Parts list',
    '',
    'The concrete parts selected for this build.',
    '',
    '| Part | Quantity | Role | Why it is here |',
    '| --- | ---: | --- | --- |',
  ];

  if (project.components.length === 0) {
    lines.push('| No parts selected | — | — | The build did not produce a bill of materials. |');
  } else {
    for (const selection of project.components) {
      lines.push(
        `| ${markdownCell(selection.name)} | ${selection.quantity} | ${markdownCell(selection.role)} | ${markdownCell(selection.reason || 'Required by the project brief.')} |`,
      );
    }
  }

  lines.push('', 'Quantities are the quantities in the generated revision, not a shopping-list estimate.', '');
  return lines.join('\n');
}

function wiringMarkdown(project: ProjectState): string {
  const connections = project.wiring?.connections ?? [];
  const lines = [
    '# Wiring and pinout',
    '',
    'Follow these connections from the generated revision. Power and ground connections are listed alongside signal wires.',
    '',
    '| From | To | Kind | Signal | Why |',
    '| --- | --- | --- | --- | --- |',
  ];

  if (connections.length === 0) {
    lines.push('| No connections | — | — | — | The wiring graph is not available for this build. |');
  } else {
    for (const connection of connections) {
      lines.push(
        `| ${markdownCell(endpointText(project, connection.from))} | ${markdownCell(endpointText(project, connection.to))} | ${connection.kind} | ${connection.signal} | ${markdownCell(connection.explanation || 'Part of the generated wiring plan.')} |`,
      );
    }
  }

  const assignments = project.pinAssignments;
  lines.push('', '## MCU pin assignments', '', '| Peripheral | Peripheral pin | MCU pin | Purpose |', '| --- | --- | --- | --- |');
  if (assignments.length === 0) {
    lines.push('| No assignments | — | — | The pin map is not available for this build. |');
  } else {
    for (const assignment of assignments) {
      lines.push(
        `| ${markdownCell(instanceName(project, { instanceId: assignment.targetInstanceId }))} | ${markdownCell(assignment.targetPin)} | ${markdownCell(assignment.pin)} | ${markdownCell(assignment.purpose)} |`,
      );
    }
  }

  if ((project.wiring?.conflicts.length ?? 0) > 0) {
    lines.push('', '## Wiring notes', '');
    for (const conflict of project.wiring?.conflicts ?? []) {
      lines.push(`- **${conflict.severity}:** ${conflict.message}${conflict.suggestion ? ` Fix: ${conflict.suggestion}` : ''}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function validationMarkdown(project: ProjectState): string {
  const validation = project.validation;
  const lines = [
    '# Validation report',
    '',
    `Project status: **${project.status}**`,
    `Revision: **v${project.revision}**`,
    '',
  ];

  if (!validation) {
    lines.push('Validation did not run for this project.', '');
    if (project.error) lines.push(`Build error: ${project.error.message}`, '');
    return lines.join('\n');
  }

  lines.push(
    `Verdict: **${validation.passed ? 'passed' : 'needs attention'}**`,
    `- ${validation.summary.errors} error(s)`,
    `- ${validation.summary.warnings} warning(s)`,
    `- ${validation.summary.info} informational note(s)`,
    `- ${validation.summary.checksPassed}/${validation.summary.checksRun} checks passed`,
    '',
  );

  if (validation.engineError) lines.push(`Validation engine note: ${validation.engineError}`, '');

  if (validation.issues.length === 0) {
    lines.push('## Issues', '', 'No validation issues were recorded.', '');
  } else {
    lines.push('## Issues', '');
    for (const issue of validation.issues) {
      lines.push(`- **${issue.severity}:** ${issue.message}`);
      if (issue.fixHint) lines.push(`  - Suggested next step: ${issue.fixHint}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function readme(project: ProjectState, files: string[], wokwiNotes: string): string {
  const summary = project.requirements?.summary || project.hardwarePlan?.summary || project.prompt;
  const has = new Set(files);
  const validation = project.validation
    ? project.validation.passed
      ? 'Passed the recorded validation gate.'
      : `${project.validation.summary.errors} error(s) need attention before you build.`
    : 'Validation was not recorded for this revision.';
  const controller = project.hardwarePlan?.controller?.name;
  const firmwareFiles = project.artifacts.code?.files ?? [];

  const lines = [
    `# ${project.name || 'Wireup build'}`,
    '',
    summary.trim(),
    '',
    `Generated by Wireup at revision **v${project.revision}**.`,
    '',
    '## Start here',
    '',
    has.has('instructions.md') ? '1. Read [`instructions.md`](instructions.md) before wiring anything.' : '1. No build guide was generated for this revision; use the wiring and parts files below as the handoff.',
    '2. Check [`validation.md`](validation.md) and resolve any errors or warnings that apply to your real parts.',
    has.has('diagram.json') ? '3. Open [`diagram.json`](diagram.json) in Wokwi when the listed parts are supported by that simulator.' : '3. No simulator diagram was generated for this revision.',
    has.has('firmware/sketch.ino') ? '4. Copy the files in [`firmware/`](firmware/) into your board project, then install the libraries listed in [`libraries.json`](libraries.json).' : '4. No firmware was generated for this revision.',
    '5. Use [`wiring.md`](wiring.md) as the bench-side pinout while assembling.',
    '',
    '## Build snapshot',
    '',
    `- **Status:** ${project.status}`,
    `- **Validation:** ${validation}`,
    `- **Controller:** ${controller ?? 'not resolved'}`,
    `- **Parts:** ${project.components.reduce((sum, selection) => sum + selection.instances.length, 0)}`,
    `- **Connections:** ${project.wiring?.connections.length ?? 0}`,
    `- **Firmware files:** ${firmwareFiles.length}`,
    '',
    '## Files in this pack',
    '',
    ...files.map((file) => `- [\`${file}\`](${file.includes('/') ? file : file})`),
    '',
    '## Simulator note',
    '',
    wokwiNotes,
    '',
    '> This pack is a generated engineering handoff. Verify the actual board, power supply, component ratings and wiring before applying power. Wireup does not certify a physical build.',
    '',
  ];

  return lines.join('\n');
}

function buildEntries(project: ProjectState): { entries: ZipEntry[]; files: string[] } {
  const entries: ZipEntry[] = [];
  const files: string[] = [];
  const add = (path: string, content: string | Buffer, executable = false): void => {
    const safePath = archivePath(path, `file-${entries.length + 1}.txt`);
    if (entries.some((entry) => entry.path === safePath)) return;
    entries.push({ path: safePath, content, ...(executable ? { executable: true } : {}) });
    files.push(safePath);
  };

  const diagram = project.artifacts.diagram;
  let wokwiNotes = 'No simulator diagram was generated for this revision.';
  if (diagram) {
    const projection = toWokwiDiagram(diagram);
    add('diagram.json', json(projection.diagram));
    add('wireup-diagram.json', json(diagram));
    const notes = [
      projection.skippedParts.length > 0 ? `${projection.skippedParts.length} part(s) were not representable in Wokwi.` : 'All diagram parts were represented in the Wokwi projection.',
      projection.skippedConnections.length > 0 ? `${projection.skippedConnections.length} connection(s) could not be projected.` : 'All diagram connections were represented in the Wokwi projection.',
      ...projection.warnings,
    ];
    wokwiNotes = notes.join(' ');
    add('simulation/wokwi-notes.md', `# Simulator notes\n\n${notes.map((note) => `- ${note}`).join('\n')}\n`);
  }

  add('parts.md', partsMarkdown(project));
  add('parts.json', json(project.components));
  add('wiring.md', wiringMarkdown(project));
  add('wiring.json', json(project.wiring));

  if (project.artifacts.code) {
    for (const file of project.artifacts.code.files) {
      add(`firmware/${archivePath(file.path, 'unnamed-file.txt')}`, file.content);
    }
  }
  if (project.artifacts.libraries) add('libraries.json', json(project.artifacts.libraries));
  if (project.artifacts.instructions) add('instructions.md', project.artifacts.instructions.markdown);
  add('validation.md', validationMarkdown(project));

  const readmePath = 'README.md';
  entries.unshift({ path: readmePath, content: readme(project, files, wokwiNotes) });
  files.unshift(readmePath);
  return { entries, files };
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!id || id.trim().length === 0) {
    return jsonError(400, { code: 'bad_request', message: 'A project id is required.' });
  }

  try {
    const project = await getProjectState(id.trim());
    if (!project) {
      return jsonError(404, { code: 'not_found', message: `Project ${id} does not exist.` });
    }

    const hasArtifacts = Boolean(
      project.artifacts.code ||
        project.artifacts.diagram ||
        project.artifacts.instructions ||
        project.artifacts.libraries ||
        project.components.length > 0,
    );
    if (!hasArtifacts) {
      return jsonError(409, {
        code: 'build_not_ready',
        message: 'The build pack is not ready yet. Wait for the first project artifacts to appear.',
        details: `Current stage: ${project.stage}, status: ${project.status}.`,
      });
    }

    const slug = slugify(project.name, `wireup-build-${project.id.slice(0, 8)}`);
    const { entries, files } = buildEntries(project);
    const stamp = new Date(project.updatedAt || project.createdAt);
    const zip = createZip(entries, { modifiedAt: Number.isNaN(stamp.getTime()) ? new Date() : stamp });

    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(zip.length),
        'Content-Disposition': `attachment; filename="${slug}-build-pack.zip"`,
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
        'X-Wireup-Pack-Revision': String(project.revision),
        'X-Wireup-Pack-Files': String(files.length),
      },
    });
  } catch (error) {
    const mapped = fromUnknown(error, `GET /api/projects/${id}/export`);
    return jsonError(mapped.status, mapped.error);
  }
}
