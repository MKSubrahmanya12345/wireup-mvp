/**
 * Hardware planner.
 *
 * Input : structured requirements + the component database (+ the model's
 *         component suggestions).
 * Output: real catalog components with quantities and reasons, an expanded
 *         instance list, power budget, compatibility analysis and the hardware
 *         architecture.
 *
 * The model never gets the final say on parts: everything it names is matched
 * back onto the catalog, and anything missing is added by engineering rules.
 */

import { z } from 'zod';

import type { ComponentCategory, ComponentDefinition, ComponentInstance, ComponentRole, ComponentSelection } from '@/types/component';
import type { HardwareBlock, HardwarePlan, ProjectRequirements, Subsystem } from '@/types/project';
import type { AgentEventLog } from '@/lib/logging/events';
import { selectionId } from '@/lib/validation/ids';
import { instanceId as buildInstanceId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { findComponentById, matchComponentStrict } from '@/modules/components/service';
import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';

import { checkCompatibility } from './compatibility';
import { applyEngineeringDefaults } from './defaults';
import { computePowerBudget, isElectricallyActive } from './power';
import type { DraftSelection, HardwarePlannerInput, HardwarePlanResult } from './types';

export const ROLE_BY_CATEGORY: Record<ComponentCategory, ComponentRole> = {
  microcontroller: 'controller',
  motor: 'actuator',
  motor_driver: 'driver',
  sensor: 'sensor',
  communication: 'communication',
  actuator: 'actuator',
  display: 'display',
  power: 'power',
  passive: 'passive',
  electromechanical: 'actuator',
  input_device: 'input',
  prototyping: 'prototyping',
  other: 'other',
};

const ModelComponentSchema = z
  .object({
    componentId: z.string().optional().catch(undefined),
    id: z.string().optional().catch(undefined),
    catalogId: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    part: z.string().optional().catch(undefined),
    quantity: z.union([z.number(), z.string()]).optional().catch(undefined),
    role: z.string().optional().catch(undefined),
    reason: z.string().optional().catch(undefined),
    justification: z.string().optional().catch(undefined),
    required: z.boolean().optional().catch(undefined),
    instanceLabels: z.array(z.string()).optional().catch(undefined),
    labels: z.array(z.string()).optional().catch(undefined),
    notes: z.string().optional().catch(undefined),
  })
  .passthrough();

function parseQuantity(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(12, Math.max(1, Math.round(value)));
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(12, parsed);
  }
  return 1;
}

function normaliseRole(value: unknown, category: ComponentCategory): ComponentRole {
  const known: ComponentRole[] = ['controller', 'driver', 'sensor', 'actuator', 'communication', 'power', 'input', 'display', 'passive', 'prototyping', 'other'];
  if (typeof value === 'string') {
    const normalised = value.toLowerCase().trim();
    if ((known as string[]).includes(normalised)) return normalised as ComponentRole;
    if (normalised === 'motors' || normalised === 'motor') return 'actuator';
    if (normalised === 'mcu' || normalised === 'microcontroller') return 'controller';
  }
  return ROLE_BY_CATEGORY[category] ?? 'other';
}

/** Map model component suggestions onto real catalog parts. */
export function normaliseModelSelections(
  raw: unknown,
  catalog: ComponentDefinition[],
): { drafts: DraftSelection[]; unmatched: { query: string; reason: string }[] } {
  const drafts: DraftSelection[] = [];
  const unmatched: { query: string; reason: string }[] = [];

  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];

  for (const entry of list) {
    const parsed = ModelComponentSchema.safeParse(entry);
    if (!parsed.success) {
      unmatched.push({ query: JSON.stringify(entry).slice(0, 120), reason: 'entry was not an object' });
      continue;
    }
    const value = parsed.data;
    const query = value.componentId ?? value.id ?? value.catalogId ?? value.name ?? value.part ?? '';
    if (!query) {
      unmatched.push({ query: '(empty)', reason: 'no component identifier supplied' });
      continue;
    }

    const exact = findComponentById(String(query), catalog);
    const match = exact ? { definition: exact, score: 100, via: 'id' as const } : matchComponentStrict(String(query), catalog);
    const fallback = match ? undefined : matchComponentStrict(String(value.name ?? ''), catalog);
    const resolved = match ?? fallback;

    if (!resolved) {
      unmatched.push({ query: String(query), reason: 'no catalog entry matched this name' });
      continue;
    }

    const definition = resolved.definition;
    const labels = (value.instanceLabels ?? value.labels ?? []).map((label) => String(label).trim()).filter(Boolean);

    drafts.push({
      componentId: definition.id,
      quantity: parseQuantity(value.quantity),
      role: normaliseRole(value.role, definition.category),
      reason: (value.reason ?? value.justification ?? '').trim() || `Selected for the ${definition.category} role it fills in this design.`,
      required: value.required ?? definition.category !== 'prototyping',
      source: exact || resolved.via === 'id' ? 'catalog' : 'model',
      ...(exact || resolved.via === 'id' ? {} : { matchedFrom: String(query) }),
      ...(value.notes ? { notes: value.notes } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    });
  }

  return { drafts, unmatched };
}

/** Merge duplicate component ids so quantities stay consistent. */
export function mergeDrafts(drafts: DraftSelection[]): DraftSelection[] {
  const merged = new Map<string, DraftSelection>();

  for (const draft of drafts) {
    const existing = merged.get(draft.componentId);
    if (!existing) {
      merged.set(draft.componentId, { ...draft });
      continue;
    }
    const combined: DraftSelection = {
      ...existing,
      quantity: Math.min(24, existing.quantity + draft.quantity),
      reason:
        existing.reason.toLowerCase() === draft.reason.toLowerCase()
          ? existing.reason
          : `${existing.reason} ${draft.reason}`.trim(),
      required: existing.required || draft.required,
      labels: [...(existing.labels ?? []), ...(draft.labels ?? [])],
      source: existing.source === 'planner' ? 'planner' : draft.source === 'planner' ? existing.source : existing.source,
      ...(existing.matchedFrom || draft.matchedFrom ? { matchedFrom: existing.matchedFrom ?? draft.matchedFrom } : {}),
    };
    merged.set(draft.componentId, combined);
  }

  return [...merged.values()];
}

function labelFor(definition: ComponentDefinition, index: number, quantity: number, labels?: string[]): string {
  const supplied = labels?.[index - 1];
  if (supplied && supplied.trim().length > 0) return supplied.trim();
  if (quantity === 1) return definition.name;
  if (definition.category === 'motor' && definition.motorRequirements?.motorType === 'dc' && quantity === 2) {
    return index === 1 ? 'Motor A (left channel)' : 'Motor B (right channel)';
  }
  return `${definition.name} ${index}`;
}

/** Materialise concrete instances so wiring/pins/diagram can address them. */
export function expandSelections(drafts: DraftSelection[], catalog: ComponentDefinition[]): ComponentSelection[] {
  const selections: ComponentSelection[] = [];

  for (const draft of drafts) {
    const definition = catalog.find((component) => component.id === draft.componentId);
    if (!definition) continue;

    const instances: ComponentInstance[] = [];
    for (let index = 1; index <= draft.quantity; index += 1) {
      instances.push({
        instanceId: buildInstanceId(definition.id, index),
        componentId: definition.id,
        name: definition.name,
        index,
        label: labelFor(definition, index, draft.quantity, draft.labels),
        category: definition.category,
      });
    }

    selections.push({
      id: selectionId(),
      componentId: definition.id,
      name: definition.name,
      category: definition.category,
      role: draft.role,
      quantity: draft.quantity,
      reason: draft.reason,
      required: draft.required,
      instances,
      source: draft.source,
      ...(draft.matchedFrom ? { matchedFrom: draft.matchedFrom } : {}),
      ...(draft.notes ? { notes: draft.notes } : {}),
    });
  }

  return selections;
}

function groupBySubsystem(selections: ComponentSelection[]): Record<string, ComponentSelection[]> {
  const groups: Record<string, ComponentSelection[]> = {
    control: [],
    drive: [],
    sensing: [],
    communication: [],
    actuation: [],
    display: [],
    power: [],
    support: [],
  };

  for (const selection of selections) {
    switch (selection.role) {
      case 'controller':
        groups.control.push(selection);
        break;
      case 'driver':
        groups.drive.push(selection);
        break;
      case 'sensor':
        groups.sensing.push(selection);
        break;
      case 'communication':
        groups.communication.push(selection);
        break;
      case 'input':
        groups.sensing.push(selection);
        break;
      case 'display':
        groups.display.push(selection);
        break;
      case 'actuator':
        if (selection.category === 'motor') groups.drive.push(selection);
        else groups.actuation.push(selection);
        break;
      case 'power':
        groups.power.push(selection);
        break;
      default:
        groups.support.push(selection);
        break;
    }
  }

  return groups;
}

const SUBSYSTEM_META: Record<string, { name: string; kind: HardwareBlock['kind']; description: string }> = {
  control: { name: 'Control', kind: 'controller', description: 'Executes the firmware, reads inputs and drives outputs.' },
  drive: { name: 'Drive train', kind: 'drive', description: 'Power stage that converts logic signals into motor motion.' },
  sensing: { name: 'Sensing & input', kind: 'sensing', description: 'Sensors and user inputs that inform the control logic.' },
  communication: { name: 'Communication', kind: 'communication', description: 'Wireless or wired link used for commands and telemetry.' },
  actuation: { name: 'Indication & actuation', kind: 'actuation', description: 'Lights, sound and switching outputs.' },
  display: { name: 'Display', kind: 'actuation', description: 'Visual output of state and sensor data.' },
  power: { name: 'Power', kind: 'power', description: 'Energy source, regulation and protection.' },
  support: { name: 'Support & assembly', kind: 'support', description: 'Passives, connectors and the prototyping medium.' },
};

function buildSubsystems(selections: ComponentSelection[]): Subsystem[] {
  const groups = groupBySubsystem(selections);
  const subsystems: Subsystem[] = [];

  for (const [key, members] of Object.entries(groups)) {
    if (members.length === 0) continue;
    const meta = SUBSYSTEM_META[key];
    if (!meta) continue;

    subsystems.push({
      id: key,
      name: meta.name,
      description: meta.description,
      instanceIds: members.flatMap((member) => member.instances.map((instance) => instance.instanceId)),
      inputs:
        key === 'drive' || key === 'actuation'
          ? ['logic signals from the controller']
          : key === 'sensing'
            ? ['physical environment / user']
            : key === 'power'
              ? ['battery or external supply']
              : [],
      outputs:
        key === 'sensing'
          ? ['electrical signals to the controller']
          : key === 'drive'
            ? ['mechanical motion']
            : key === 'power'
              ? ['regulated voltage rails']
              : key === 'communication'
                ? ['wireless link to the user device']
                : [],
    });
  }

  return subsystems;
}

function buildArchitecture(selections: ComponentSelection[]): HardwareBlock[] {
  const groups = groupBySubsystem(selections);
  const blocks: HardwareBlock[] = [];

  for (const [key, members] of Object.entries(groups)) {
    if (members.length === 0) continue;
    const meta = SUBSYSTEM_META[key];
    if (!meta) continue;
    blocks.push({
      id: key,
      name: meta.name,
      description: members.map((member) => `${member.quantity}x ${member.name}`).join(', '),
      instanceIds: members.flatMap((member) => member.instances.map((instance) => instance.instanceId)),
      kind: meta.kind,
    });
  }

  return blocks;
}

function buildSignalFlow(selections: ComponentSelection[], requirements: HardwarePlannerInput['requirements']): string[] {
  const flow: string[] = [];
  const groups = groupBySubsystem(selections);

  const sources: string[] = [];
  for (const selection of groups.communication) sources.push(`${selection.name} command link`);
  for (const selection of groups.sensing) sources.push(`${selection.name} reading`);
  if (sources.length === 0) sources.push('Firmware start-up');

  flow.push(...sources);

  const controller = groups.control[0];
  flow.push(controller ? `${controller.name} firmware (input handling → control logic)` : 'Controller firmware');

  for (const requirement of requirements.behaviors.slice(0, 3)) flow.push(`Behaviour: ${requirement}`);

  for (const selection of groups.drive) {
    if (selection.role === 'driver') flow.push(`${selection.name} power stage`);
  }
  for (const selection of groups.drive) {
    if (selection.category === 'motor') flow.push(`${selection.name} motion`);
  }
  for (const selection of groups.actuation) flow.push(`${selection.name} output`);
  for (const selection of groups.display) flow.push(`${selection.name} readout`);

  return [...new Set(flow)];
}

/** Build the hardware plan: parts, instances, power, compatibility, architecture. */
export async function planHardware(input: HardwarePlannerInput, events?: AgentEventLog): Promise<HardwarePlanResult> {
  const { catalog, requirements, analysis } = input;

  const searchHandle = events?.start('component_search_started', 'Searching component database...', {
    stage: 'catalog',
    metadata: { catalogSize: catalog.length },
  });

  const { drafts: modelDrafts, unmatched } = normaliseModelSelections(input.modelComponents, catalog);

  searchHandle?.complete(
    `Component database searched — ${modelDrafts.length} model suggestion(s) matched to real parts, ${unmatched.length} unmatched`,
    { matched: modelDrafts.length, unmatched: unmatched.map((entry) => entry.query) },
  );

  const defaults = applyEngineeringDefaults({ drafts: modelDrafts, catalog, requirements, analysis });
  const mergedDrafts = mergeDrafts([...modelDrafts, ...defaults.additions]);

  const selections = expandSelections(mergedDrafts, catalog);
  const controller = selections.find((selection) => selection.role === 'controller') ?? null;

  for (const selection of selections) {
    events?.emit('component_selected', `Selected ${selection.quantity}x ${selection.name}`, {
      stage: 'hardware',
      status: 'completed',
      metadata: {
        componentId: selection.componentId,
        quantity: selection.quantity,
        role: selection.role,
        reason: selection.reason,
        source: selection.source,
        instances: selection.instances.map((instance) => instance.instanceId),
      },
    });
  }

  const profile = controller ? getMcuProfile(controller.componentId) : undefined;

  const power = computePowerBudget({ selections, catalog, controller, ...(profile ? { profile } : {}) });
  const { checks, risks } = checkCompatibility({ selections, catalog, controller, ...(profile ? { profile } : {}) });

  const subsystems = buildSubsystems(selections);
  const architecture = buildArchitecture(selections);
  const signalFlow = buildSignalFlow(selections, requirements);

  const supportingComponents = selections
    .filter((selection) => selection.source === 'planner')
    .flatMap((selection) =>
      selection.instances.map((instance) => ({
        instanceId: instance.instanceId,
        componentId: selection.componentId,
        reason: selection.reason,
      })),
    );

  const motorCount = selections.reduce((sum, selection) => (selection.category === 'motor' ? sum + selection.quantity : sum), 0);
  const sensorCount = selections.reduce((sum, selection) => (selection.role === 'sensor' ? sum + selection.quantity : sum), 0);

  const summaryParts = [
    controller ? `${controller.name} as the controller` : 'no controller selected',
    motorCount > 0 ? `${motorCount} motor channel(s)` : null,
    sensorCount > 0 ? `${sensorCount} sensor(s)` : null,
    power.supplyVoltage !== undefined ? `${power.supplyVoltage} V supply` : 'power source unresolved',
    `${selections.length} distinct parts`,
  ].filter(Boolean) as string[];

  const notes = [
    ...defaults.notes,
    ...unmatched.map((entry) => `Model requested "${entry.query}" which is not in the component database (${entry.reason}).`),
    ...power.notes.filter((note) => !power.adequate || /exceed|mismatch|No explicit/i.test(note)),
  ];

  const inactive = selections.filter((selection) => {
    const definition = catalog.find((component) => component.id === selection.componentId);
    return !isElectricallyActive(definition);
  });
  if (inactive.length > 0) {
    notes.push(
      `${inactive.map((selection) => selection.name).join(', ')} are assembly/medium items and are intentionally excluded from the electrical connection graph.`,
    );
  }

  const plan: HardwarePlan = {
    summary: `Hardware architecture: ${summaryParts.join(', ')}.`,
    architecture,
    controller: controller
      ? {
          instanceId: controller.instances[0]?.instanceId ?? controller.componentId,
          componentId: controller.componentId,
          name: controller.name,
          reason: controller.reason,
        }
      : null,
    power,
    subsystems,
    signalFlow,
    compatibility: checks,
    supportingComponents,
    risks: [...new Set([...risks, ...power.notes.filter((note) => /exceeds|cannot|mismatch|brown/i.test(note))])],
  };

  events?.emit('hardware_plan_completed', `Hardware plan complete — ${selections.length} parts, ${plan.architecture.length} subsystem block(s)`, {
    stage: 'hardware',
    status: 'completed',
    metadata: {
      parts: selections.length,
      instances: selections.reduce((sum, selection) => sum + selection.instances.length, 0),
      powerAdequate: power.adequate,
      totalPeakMa: power.totalPeakMa ?? null,
      risks: risks.length,
      completedAt: nowIso(),
    },
  });

  return { selections, plan, unmatched, notes: [...new Set(notes)] };
}

/* ------------------------------------------------------------------------- */
/* Refresh (used by the fixer)                                                */
/*                                                                            */
/* Recomputes everything that is *derived* from the component list — power     */
/* budget, architecture blocks, subsystems, signal flow, compatibility — while */
/* keeping the patched selections exactly as they are. No model call, no        */
/* engineering defaults, no regeneration of the bill of materials.              */
/* ------------------------------------------------------------------------- */

export interface HardwareRefreshInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  requirements: ProjectRequirements;
  /** Previous plan, used to preserve the controller rationale and summary. */
  previous?: HardwarePlan | null;
}

export function refreshHardwarePlan(input: HardwareRefreshInput): HardwarePlan {
  const { selections, catalog, requirements, previous } = input;
  const controller = selections.find((selection) => selection.role === 'controller') ?? null;
  const profile = controller ? getMcuProfile(controller.componentId) : undefined;

  const power = computePowerBudget({ selections, catalog, controller, ...(profile ? { profile } : {}) });
  const { checks, risks } = checkCompatibility({ selections, catalog, controller, ...(profile ? { profile } : {}) });

  const subsystems = buildSubsystems(selections);
  const architecture = buildArchitecture(selections);
  const signalFlow = buildSignalFlow(selections, requirements);

  const supportingComponents = selections
    .filter((selection) => selection.source === 'planner')
    .flatMap((selection) =>
      selection.instances.map((instance) => ({
        instanceId: instance.instanceId,
        componentId: selection.componentId,
        reason: selection.reason,
      })),
    );

  const motorCount = selections.reduce((sum, selection) => (selection.category === 'motor' ? sum + selection.quantity : sum), 0);
  const sensorCount = selections.reduce((sum, selection) => (selection.role === 'sensor' ? sum + selection.quantity : sum), 0);
  const summaryParts = [
    controller ? `${controller.name} as the controller` : 'no controller selected',
    motorCount > 0 ? `${motorCount} motor channel(s)` : null,
    sensorCount > 0 ? `${sensorCount} sensor(s)` : null,
    power.supplyVoltage !== undefined ? `${power.supplyVoltage} V supply` : 'power source unresolved',
    `${selections.length} distinct parts`,
  ].filter(Boolean) as string[];

  return {
    summary: `Hardware architecture: ${summaryParts.join(', ')}.`,
    architecture,
    controller: controller
      ? {
          instanceId: controller.instances[0]?.instanceId ?? controller.componentId,
          componentId: controller.componentId,
          name: controller.name,
          reason: previous?.controller?.reason ?? controller.reason,
        }
      : null,
    power,
    subsystems,
    signalFlow,
    compatibility: checks,
    supportingComponents,
    risks: [...new Set([...risks, ...power.notes.filter((note) => /exceeds|cannot|mismatch|brown/i.test(note))])],
  };
}
