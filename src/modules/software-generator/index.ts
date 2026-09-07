/**
 * Software generator — the dashboard half of a build.
 *
 * Produces a complete Vite + React + TypeScript project as an in-memory file
 * list, statically validates it, and hands it to the API layer to be zipped.
 *
 * ── The rule this module exists to keep ─────────────────────────────────────
 * NOTHING IS INSTALLED, BUILT OR EXECUTED HERE. No `npm install`, no `tsc`, no
 * child process, no network. The user asked for a raw zip they set up
 * themselves, and a generator that shells out to a package manager is a
 * generator that can hang, blow a disk quota or take down the request. So the
 * quality gate is static analysis over the generated text — see `validate.ts`,
 * which checks the things that actually break a fresh checkout: unresolved
 * imports, files referenced but never emitted, scripts pointing at missing
 * config, JSON that does not parse, unbalanced braces, contract drift between
 * the firmware and the UI.
 *
 * A failed check is reported, never silently patched: the artifact ships with
 * its findings attached so the /simulation page can show exactly what is
 * suspect before the user unzips it.
 */

import type { ComponentSelection } from '@/types/component';
import type { GeneratedCodeFile, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';

import { nowIso } from '@/lib/validation/time';

import { deriveDeviceContract, type DeviceContract } from './contract';
import { validateSoftwareProject, type SoftwareFinding } from './validate';
import {
  appComponent,
  appCss,
  contractModule,
  envDts,
  gitignore,
  indexHtml,
  linkModule,
  mainTsx,
  packageJson,
  protocolModule,
  readme,
  tsconfigJson,
  useBoardHook,
  viteConfig,
} from './templates';

export interface SoftwareFile {
  path: string;
  content: string;
}

export interface SoftwareArtifact {
  /** URL/zip-safe project name. */
  slug: string;
  contract: DeviceContract;
  files: SoftwareFile[];
  findings: SoftwareFinding[];
  /** False when any finding is an error — the zip still downloads, flagged. */
  passed: boolean;
  /** Port the generated dev server binds. */
  devPort: number;
  generatedAt: string;
  notes: string[];
}

export interface SoftwareGeneratorInput {
  projectName: string;
  controllerName: string;
  selections: ComponentSelection[];
  assignments: PinAssignment[];
  softwarePlan: SoftwarePlan;
  /** The firmware, so the generator can cross-check the contract against it. */
  firmware: Pick<GeneratedCodeFile, 'path' | 'content'>[];
  events?: AgentEventLog;
  generatedAt?: string;
}

export const DASHBOARD_DEV_PORT = 5175;

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'wireup-dashboard';
}

/**
 * Does the sketch look like it counts button presses? The sketch generator
 * decides this itself; the contract has to reach the same conclusion or the
 * dashboard would show a `count` card the firmware never fills (or miss one it
 * does). Reading the emitted firmware is the only way to be certain, so that
 * is what happens — the generated text, not a re-run of the heuristic.
 */
function firmwareHasCounter(firmware: Pick<GeneratedCodeFile, 'content'>[]): boolean {
  return firmware.some((file) => /\bpressCount\b/.test(file.content));
}

export function generateSoftware(input: SoftwareGeneratorInput): SoftwareArtifact {
  const handle = input.events?.start('software_generation_started', 'Generating the dashboard website...', {
    stage: 'software',
    metadata: { controller: input.controllerName },
  });

  const slug = slugify(input.projectName);
  const contract = deriveDeviceContract({
    projectName: input.projectName,
    controllerName: input.controllerName,
    selections: input.selections,
    assignments: input.assignments,
    softwarePlan: input.softwarePlan,
    hasCounter: firmwareHasCounter(input.firmware),
  });

  const files: SoftwareFile[] = [
    { path: 'package.json', content: packageJson(slug) },
    { path: 'tsconfig.json', content: tsconfigJson() },
    { path: 'vite.config.ts', content: viteConfig() },
    { path: 'index.html', content: indexHtml(contract.projectName) },
    { path: '.gitignore', content: gitignore() },
    { path: 'README.md', content: readme(contract, slug) },
    { path: 'src/vite-env.d.ts', content: envDts() },
    { path: 'src/main.tsx', content: mainTsx() },
    { path: 'src/App.tsx', content: appComponent(contract) },
    { path: 'src/app.css', content: appCss() },
    { path: 'src/contract.ts', content: contractModule(contract) },
    { path: 'src/protocol.ts', content: protocolModule(contract) },
    { path: 'src/link.ts', content: linkModule() },
    { path: 'src/useBoard.ts', content: useBoardHook() },
  ];

  const findings = validateSoftwareProject({ files, contract, firmware: input.firmware });
  const errors = findings.filter((finding) => finding.severity === 'error');
  const passed = errors.length === 0;

  const notes = [
    'Generated and statically validated only — no dependency was installed and no build was run.',
    `Run \`npm install && npm run dev\` after unzipping; the dev server binds port ${DASHBOARD_DEV_PORT}.`,
    'The dashboard talks to the board over Web Serial, or over the Wireup /simulation bridge when embedded.',
  ];
  if (!passed) {
    notes.push(`${errors.length} static check(s) failed — see the findings before running the project.`);
  }

  const artifact: SoftwareArtifact = {
    slug,
    contract,
    files,
    findings,
    passed,
    devPort: DASHBOARD_DEV_PORT,
    generatedAt: input.generatedAt ?? nowIso(),
    notes,
  };

  handle?.complete(
    `Dashboard generated — ${files.length} file(s), ${contract.metrics.length} reading(s), ${contract.commands.length} control(s)` +
      (passed ? ', all static checks passed.' : `, ${errors.length} check(s) failed.`),
    {
      files: files.length,
      metrics: contract.metrics.length,
      commands: contract.commands.length,
      findings: findings.length,
      passed,
    },
  );

  return artifact;
}

export type { DeviceContract, DeviceMetric, DeviceCommand } from './contract';
export type { SoftwareFinding } from './validate';
