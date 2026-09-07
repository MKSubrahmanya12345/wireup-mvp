/**
 * Simulation module — everything the /simulation page is built from.
 *
 * A project's simulation payload is a pure function of its persisted state:
 * the diagram + the firmware in, a Velxio project and a generated dashboard
 * out. Nothing here is stored separately, so the two halves can never go stale
 * against the project they came from — regenerating is cheaper and safer than
 * invalidating a cache.
 */

import type { ProjectState } from '@/types/project';

import { generateSoftware, slugify, type SoftwareArtifact } from '@/modules/software-generator';

import { generateVelxioProject, type VelxioProjectResult } from './velxio-project';

export interface SimulationBundle {
  projectId: string;
  projectName: string;
  slug: string;
  revision: number;
  /** Null when the project has no diagram yet. */
  velxio: VelxioProjectResult | null;
  /** Null when the project has no firmware yet. */
  software: SoftwareArtifact | null;
  /** Why a half is missing, in the user's terms. */
  blocked: { velxio: string | null; software: string | null };
}

/** The controller's display name, or a plain fallback. */
function controllerName(project: ProjectState): string {
  const controller = project.hardwarePlan?.controller;
  if (controller?.name) return controller.name;
  const mcu = project.components.find((selection) => selection.category === 'microcontroller');
  return mcu?.name ?? 'the controller';
}

export function buildSimulationBundle(project: ProjectState): SimulationBundle {
  const diagram = project.artifacts.diagram;
  const code = project.artifacts.code;
  const libraries = project.artifacts.libraries?.libraries.map((library) => library.name) ?? [];

  const blocked: SimulationBundle['blocked'] = { velxio: null, software: null };

  let velxio: VelxioProjectResult | null = null;
  if (!diagram) {
    blocked.velxio =
      project.status === 'running' || project.status === 'validating' || project.status === 'fixing'
        ? 'The wiring graph is still being built — the simulator project is generated from it, so it comes next.'
        : 'This project has no diagram.json, so there is nothing to place on the simulator canvas.';
  } else {
    velxio = generateVelxioProject({
      projectName: project.name,
      diagram,
      files: code?.files ?? [],
      ...(code?.entryPoint ? { entryPoint: code.entryPoint } : {}),
      libraries,
    });
  }

  let software: SoftwareArtifact | null = null;
  if (!code || !project.softwarePlan) {
    blocked.software = !code
      ? 'The firmware has not been generated yet. The dashboard is derived from it (it reads the exact fields the sketch prints), so it comes after.'
      : 'This project has no software plan, so the dashboard\'s command set could not be derived.';
  } else {
    software = generateSoftware({
      projectName: project.name,
      controllerName: controllerName(project),
      selections: project.components,
      assignments: project.pinAssignments,
      softwarePlan: project.softwarePlan,
      firmware: code.files,
    });
  }

  return {
    projectId: project.id,
    projectName: project.name,
    slug: slugify(project.name),
    revision: project.revision,
    velxio,
    software,
    blocked,
  };
}

export { generateVelxioProject } from './velxio-project';
export type { VlxProject, VelxioProjectResult } from './velxio-project';
export { applyCanvasToDiagram, CanvasSyncError, assertCanvasPayload } from './vlx-sync';
export type { VlxCanvasPayload, CanvasSyncResult } from './vlx-sync';
