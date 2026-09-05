/**
 * Generation pipeline.
 *
 * Runs the stages in dependency order, one event + one persistence hook per
 * stage, so the UI always sees real progress:
 *
 *   understand → catalog → design call → requirements → hardware →
 *   pins → wiring → software → firmware call → code → libraries →
 *   diagram → instructions
 *
 * The circuit mapping is a SINGLE SOURCE OF TRUTH: the pin planner freezes it
 * into a ResolvedPinMap, and both the firmware generator and the diagram
 * generator receive that same object. The model never designs the circuit and
 * writes firmware for it in one step — the firmware call happens only after
 * the pin plan is final, sees nothing but the map, and its output is statically
 * audited against the map.
 *
 * Every stage has a deterministic fallback: if Bedrock is unavailable (or its
 * JSON is unusable) the planners still produce a complete, wired project from
 * the catalog. The model refines; it never owns correctness.
 */

import type { AgentEventLog } from '@/lib/logging/events';
import type { LlmCallRecord, ProjectArtifacts, ProjectState } from '@/types/project';
import type { GenerationStage } from '@/types/project';
import type { ProjectPatch } from '@/lib/mongodb/projects';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';

import { describeBedrockConfig, generateFirmwareSpec, generateProjectSpec } from '@/lib/bedrock';
import { createId } from '@/lib/validation/ids';
import { asRecord, truncate } from '@/lib/validation/json';
import { describeError, logger } from '@/lib/logging/logger';
import { nowIso } from '@/lib/validation/time';
import { env } from '@/lib/validation/env';

import { normalizeRequirements, understandPrompt } from '@/modules/project-understanding';
import { formatAnalysisForPrompt } from '@/modules/project-understanding/heuristics';
import { planHardware } from '@/modules/hardware-planner';
import { planPins } from '@/modules/pin-planner';
import { buildResolvedPinMap, formatResolvedPinMapForPrompt, type ResolvedPinMap } from '@/modules/pin-planner/resolved-map';
import { planWiring } from '@/modules/wiring-planner';
import { planSoftware } from '@/modules/software-planner';
import { generateCode } from '@/modules/code-generator';
import { generateLibraries } from '@/modules/libraries-generator';
import { generateDiagram } from '@/modules/diagram-generator';
import { generateInstructions } from '@/modules/instructions-generator';

import { buildGenerationContext, controllerInfo, type GenerationContext } from './context';

export interface PipelineInput {
  project: ProjectState;
  events: AgentEventLog;
  /** Persisted after every stage so the UI can render partial results. */
  onStage?: (patch: ProjectPatch, stage: GenerationStage) => Promise<void> | void;
}

export interface PipelineOutput {
  project: ProjectState;
  context: GenerationContext;
  analysis: PromptAnalysis;
  llmCalls: LlmCallRecord[];
  notes: string[];
}

const EMPTY_ARTIFACTS: ProjectArtifacts = { code: null, diagram: null, libraries: null, instructions: null };

/** Fields the pipeline is allowed to persist mid-run (never dates/events). */
type StagePatch = Partial<
  Pick<
    ProjectState,
    | 'name'
    | 'status'
    | 'stage'
    | 'requirements'
    | 'components'
    | 'hardwarePlan'
    | 'pinAssignments'
    | 'wiring'
    | 'softwarePlan'
    | 'artifacts'
    | 'llm'
    | 'revision'
    | 'iteration'
  >
>;

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { events, onStage } = input;
  const base = input.project;
  const notes: string[] = [];
  const llmCalls: LlmCallRecord[] = [];

  let state: ProjectState = { ...base, stage: 'understanding', status: 'running' };
  let artifacts: ProjectArtifacts = { ...EMPTY_ARTIFACTS };

  const stage = async (patch: StagePatch, next: GenerationStage): Promise<void> => {
    state = { ...state, ...patch, stage: next };
    if (!onStage) return;
    try {
      await onStage({ ...patch, stage: next } as ProjectPatch, next);
    } catch (error) {
      // A failed progress write must not abort generation; the final save will.
      logger.warn({ err: error, projectId: base.id, stage: next }, 'stage progress write failed');
    }
  };

  const pipelineHandle = events.start('generation_started', `Generation started for "${truncate(base.prompt, 120)}"`, {
    stage: 'generating',
    metadata: { projectId: base.id, promptLength: base.prompt.length },
  });

  /* --- 1. Understand the request ------------------------------------------ */
  const requirementsHandle = events.start('requirements_started', 'Reading the request and extracting requirements...', {
    stage: 'understanding',
  });
  const understanding = understandPrompt(base.prompt, events);
  const analysis = understanding.analysis;
  let requirements = understanding.requirementsDraft;

  requirementsHandle.complete(
    `Requirements extracted — ${requirements.requirements.length} requirement(s), ${requirements.features.length} feature(s)${
      requirements.ambiguities.length > 0 ? `, ${requirements.ambiguities.length} ambiguity(ies)` : ''
    }.`,
    {
      goal: requirements.goal,
      features: requirements.features,
      quantities: requirements.quantities,
      detectedPlatform: requirements.detectedPlatform ?? null,
      assumptions: requirements.assumptions.length,
      ambiguities: requirements.ambiguities.length,
    },
  );
  notes.push(...analysis.notes);
  await stage({ requirements, status: 'running' }, 'understanding');

  /* --- 2. Component database ---------------------------------------------- */
  const context = await buildGenerationContext({ prompt: base.prompt, analysis, events });
  const catalog = context.catalog;
  notes.push(...context.notes);
  await stage({}, 'catalog');

  /* --- 3. Design call (CALL 1 — parts, plans, wiring intent; no firmware) -- */
  const bedrock = await describeBedrockConfig();
  let modelPayload: Record<string, unknown> = {};

  if (bedrock.configured) {
    const startedAt = Date.now();
    const call: LlmCallRecord = {
      id: createId('llm'),
      op: 'generation',
      model: bedrock.model ?? 'unknown',
      startedAt: nowIso(),
      status: 'failed',
      iteration: 0,
    };
    const handle = events.start('llm_call_started', `Calling ${call.model} to design the project...`, {
      stage: 'generating',
      metadata: { op: 'generation', model: call.model },
    });

    try {
      const response = await generateProjectSpec({
        prompt: base.prompt,
        requirementsDraft: `${formatAnalysisForPrompt(analysis)}\n\n${truncate(JSON.stringify(requirements, null, 2), 4000)}`,
        catalogContext: context.catalogContext,
        mcuContext: context.mcuContext,
        extraGuidance:
          analysis.notes.length > 0 ? `Heuristic notes to verify: ${analysis.notes.join(' ')}` : undefined,
      });

      call.model = response.model;
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      call.inputTokens = response.usage.inputTokens;
      call.outputTokens = response.usage.outputTokens;

      if (response.ok && response.payload !== undefined) {
        call.status = 'ok';
        modelPayload = asRecord(response.payload);
        handle.complete(`Model design received (${response.raw.length} characters of JSON${response.repaired ? ', repaired' : ''}).`, {
          op: 'generation',
          model: response.model,
          repaired: response.repaired,
          attempts: response.attempts,
          inputTokens: response.usage.inputTokens ?? 0,
          outputTokens: response.usage.outputTokens ?? 0,
          keys: Object.keys(modelPayload),
        });
      } else {
        call.status = 'failed';
        call.error = response.error ?? 'unparsable payload';
        handle.fail(
          `Model design unavailable (${call.error}) — continuing with the deterministic planners.`,
          response.error,
          { op: 'generation', model: response.model },
        );
        notes.push(`Generation model call failed (${call.error}); the project was built deterministically from the catalog.`);
      }
    } catch (error) {
      const described = describeError(error);
      call.status = 'failed';
      call.error = described.message;
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      handle.fail(`Model design call threw: ${described.message} — continuing deterministically.`, described.message, { op: 'generation' });
      notes.push(`Generation model call threw (${described.message}); the project was built deterministically from the catalog.`);
    }

    llmCalls.push(call);
    await stage({ llm: { model: call.model, validationModel: bedrock.validationModel, calls: llmCalls } }, 'generating');
  } else {
    events.emit('info', `Amazon Bedrock is not configured${bedrock.problem ? ` (${bedrock.problem})` : ''} — building the project deterministically from the catalog.`, {
      stage: 'generating',
      metadata: { reason: bedrock.problem ?? 'not configured' },
    });
    notes.push('Bedrock is not configured; the project was built deterministically from the catalog.');
  }

  /* --- 4. Requirements (model + heuristics merged) ------------------------- */
  requirements = normalizeRequirements(modelPayload.requirements, {
    prompt: base.prompt,
    analysis,
    draft: understanding.requirementsDraft,
  });
  const projectName = pickProjectName(modelPayload.project, requirements, base);
  await stage({ requirements, name: projectName }, 'understanding');

  /* --- 5. Hardware -------------------------------------------------------- */
  const hardware = await planHardware(
    { requirements, analysis, modelComponents: modelPayload.components, catalog },
    events,
  );
  const selections = hardware.selections;
  const hardwarePlan = hardware.plan;
  notes.push(...hardware.notes);
  for (const entry of hardware.unmatched) {
    events.emit('info', `Model asked for "${entry.query}" which is not in the component database — ${entry.reason}.`, {
      stage: 'hardware',
      metadata: { query: entry.query, reason: entry.reason },
    });
  }
  state = { ...state, components: selections, hardwarePlan, name: projectName };
  await stage({ components: selections, hardwarePlan }, 'hardware');

  const controller = controllerInfo({ ...state, components: selections, hardwarePlan }, catalog);
  const profile = controller.profile;

  /* --- 6. Pins ------------------------------------------------------------ */
  const pinPlan = planPins({
    selections,
    catalog,
    ...(controller.instanceId ? { controllerInstanceId: controller.instanceId } : {}),
    modelPinAssignments: modelPayload.pinAssignments,
    events,
  });
  const assignments = pinPlan.assignments;
  notes.push(...pinPlan.notes);
  for (const entry of pinPlan.unassigned) {
    events.emit('info', `Could not assign ${entry.instanceId}.${entry.pin}: ${entry.reason}`, {
      stage: 'pins',
      metadata: { instanceId: entry.instanceId, pin: entry.pin, reason: entry.reason },
    });
  }
  await stage({ pinAssignments: assignments }, 'pins');

  /*
   * The single source of truth every downstream artifact is projected from.
   * Built ONCE from the pin planner's output; the firmware call + generator
   * and the diagram generator all receive this exact object.
   */
  const pinMap: ResolvedPinMap = buildResolvedPinMap({
    assignments,
    controller: {
      ...(controller.componentId ? { componentId: controller.componentId } : {}),
      ...(controller.instanceId ? { instanceId: controller.instanceId } : {}),
      name: controller.name,
    },
  });

  /* --- 7. Wiring ---------------------------------------------------------- */
  const wiring = planWiring({
    selections,
    catalog,
    assignments,
    power: hardwarePlan.power,
    ...(controller.instanceId ? { controllerInstanceId: controller.instanceId } : {}),
    ...(profile ? { profile } : {}),
    serialLinks: pinPlan.serialLinks,
    modelWiring: modelPayload.wiring,
    events,
  });
  notes.push(...wiring.notes);
  await stage({ wiring }, 'wiring');

  /* --- 8. Software plan --------------------------------------------------- */
  const softwarePlan = planSoftware({
    requirements,
    selections,
    catalog,
    assignments,
    serialLinks: pinPlan.serialLinks,
    i2cBuses: pinPlan.i2cBuses,
    ...(controller.instanceId ? { controllerInstanceId: controller.instanceId } : {}),
    ...(controller.componentId ? { controllerComponentId: controller.componentId } : {}),
    modelSoftwarePlan: modelPayload.softwarePlan,
    events,
  });
  await stage({ softwarePlan }, 'software');

  /* --- 9. Firmware call (CALL 2 — against the resolved pin map) ------------
   *
   * Deliberately a SEPARATE call after the pin planner has run: the model is
   * handed the resolved pin map and forbidden from choosing pins, so it can
   * never author firmware against pin decisions the planner overrode (the
   * "pin planner says D4, sketch says 2" class of bug). If the firmware call
   * is unavailable, the design call's code section (older agents) still gets
   * a chance — but only after the same canonicalisation + audit gate.
   */
  let firmwarePayload: unknown;
  const firmwareEnabled = bedrock.configured && env().agent.enableLlmFirmware;
  if (firmwareEnabled) {
    const startedAt = Date.now();
    const call: LlmCallRecord = {
      id: createId('llm'),
      op: 'firmware',
      model: bedrock.firmwareModel ?? bedrock.model ?? 'unknown',
      startedAt: nowIso(),
      status: 'failed',
      iteration: 0,
    };
    const handle = events.start('llm_call_started', `Calling ${call.model} to write firmware against the resolved pin map...`, {
      stage: 'code',
      metadata: { op: 'firmware', model: call.model, pinsLocked: pinMap.bindings.length },
    });

    try {
      const response = await generateFirmwareSpec({
        prompt: base.prompt,
        projectName,
        controllerName: controller.name,
        requirements: formatRequirementsForFirmware(requirements),
        softwarePlan: truncate(JSON.stringify(softwarePlan, null, 2), 6000),
        resolvedPinMap: formatResolvedPinMapForPrompt(pinMap),
        serialLinks: formatSerialLinks(pinPlan.serialLinks),
        i2cBuses: formatI2cBuses(pinPlan.i2cBuses),
        libraries: formatLibraryManifest(softwarePlan.libraries),
      });

      call.model = response.model;
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      call.inputTokens = response.usage.inputTokens;
      call.outputTokens = response.usage.outputTokens;

      if (response.ok && response.payload !== undefined) {
        call.status = 'ok';
        firmwarePayload = response.payload;
        handle.complete(`Model firmware received (${response.raw.length} characters of JSON${response.repaired ? ', repaired' : ''}).`, {
          op: 'firmware',
          model: response.model,
          repaired: response.repaired,
          attempts: response.attempts,
          inputTokens: response.usage.inputTokens ?? 0,
          outputTokens: response.usage.outputTokens ?? 0,
        });
      } else {
        call.error = response.error ?? 'unparsable payload';
        handle.fail(
          `Model firmware unavailable (${call.error}) — the deterministic sketch from the pin plan will be used instead.`,
          response.error,
          { op: 'firmware', model: response.model },
        );
        notes.push(`Firmware model call failed (${call.error}); the firmware was generated deterministically from the pin plan.`);
      }
    } catch (error) {
      const described = describeError(error);
      call.error = described.message;
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      handle.fail(`Firmware model call threw: ${described.message} — falling back to the deterministic sketch.`, described.message, {
        op: 'firmware',
      });
      notes.push(`Firmware model call threw (${described.message}); the firmware was generated deterministically from the pin plan.`);
    }

    llmCalls.push(call);
    await stage({ llm: { ...(bedrock.model ? { model: bedrock.model } : {}), calls: llmCalls } }, 'code');
  } else if (bedrock.configured) {
    events.emit('info', 'LLM firmware authoring is disabled (WIREUP_ENABLE_LLM_FIRMWARE=false) — the deterministic sketch from the pin plan will be used.', {
      stage: 'code',
      metadata: { reason: 'disabled' },
    });
  }

  /* --- 10. Firmware artifact ---------------------------------------------- */
  const code = generateCode({
    projectName,
    projectSummary: requirements.summary,
    requirements,
    selections,
    catalog,
    pinMap,
    serialLinks: pinPlan.serialLinks,
    i2cBuses: pinPlan.i2cBuses,
    softwarePlan,
    controllerName: controller.name,
    ...(profile ? { profile } : {}),
    revision: 1,
    // The design call no longer authors firmware, but honour its `code` block
    // if the model sent one anyway — as INPUT to the same map-audited path.
    modelCode: firmwarePayload ?? modelPayload.code,
    events,
  });
  artifacts = { ...artifacts, code };
  notes.push(...code.notes);
  await stage({ artifacts }, 'code');

  /* --- 11. Libraries ------------------------------------------------------ */
  const libraries = generateLibraries({
    softwarePlan,
    selections,
    catalog,
    ...(controller.componentId ? { controllerComponentId: controller.componentId } : {}),
    events,
  });
  artifacts = { ...artifacts, libraries };
  notes.push(...libraries.notes);
  await stage({ artifacts }, 'libraries');

  /* --- 12. Diagram (projected from the SAME resolved pin map) -------------- */
  const diagram = generateDiagram({
    projectId: base.id,
    revision: 1,
    projectName,
    projectSummary: requirements.summary,
    requirements,
    selections,
    catalog,
    pinMap,
    wiring,
    hardwarePlan,
    events,
  });
  artifacts = { ...artifacts, diagram };
  await stage({ artifacts }, 'diagram');

  /* --- 13. Instructions --------------------------------------------------- */
  const instructions = generateInstructions({
    projectName,
    projectSummary: requirements.summary,
    requirements,
    selections,
    catalog,
    hardwarePlan,
    pinAssignments: assignments,
    wiring,
    softwarePlan,
    libraries,
    diagram,
    controllerName: controller.name,
    ...(controller.componentId ? { controllerComponentId: controller.componentId } : {}),
    revision: 1,
    modelInstructions: modelPayload.instructions,
    events,
  });
  artifacts = { ...artifacts, instructions };
  if (instructions.estimatedBuildTimeMinutes) {
    notes.push(`Estimated build time: ${instructions.estimatedBuildTimeMinutes} minute(s).`);
  }
  await stage({ artifacts }, 'instructions');

  /* --- Done --------------------------------------------------------------- */
  state = {
    ...state,
    name: projectName,
    requirements,
    components: selections,
    hardwarePlan,
    pinAssignments: assignments,
    wiring,
    softwarePlan,
    artifacts,
    revision: 1,
    stage: 'validating',
    status: 'validating',
    iteration: { current: 0, max: state.iteration.max },
    llm: {
      ...(bedrock.model ? { model: bedrock.model } : {}),
      ...(bedrock.validationModel ? { validationModel: bedrock.validationModel } : {}),
      calls: llmCalls,
    },
    updatedAt: nowIso(),
  };

  pipelineHandle.complete(
    `Initial build complete — ${selections.length} part(s), ${assignments.length} pin assignment(s), ${wiring.connections.length} wire(s), ${code.files.length} file(s).`,
    {
      parts: selections.length,
      instances: selections.reduce((sum, selection) => sum + selection.instances.length, 0),
      assignments: assignments.length,
      connections: wiring.connections.length,
      conflicts: wiring.conflicts.length,
      files: code.files.length,
      libraries: libraries.libraries.length,
      diagramComponents: diagram.stats.components,
      instructionSections: instructions.sections.length,
    },
  );

  return { project: state, context, analysis, llmCalls, notes: [...new Set(notes)] };
}

/** Compact requirements view for the firmware call. */
function formatRequirementsForFirmware(requirements: ProjectState['requirements']): string {
  if (!requirements) return '(no requirements extracted)';
  const lines: string[] = [];
  lines.push(`goal: ${requirements.goal}`);
  if (requirements.summary) lines.push(`summary: ${requirements.summary}`);
  if (requirements.behaviors.length > 0) lines.push(`behaviours: ${requirements.behaviors.join(' | ')}`);
  if (requirements.inputs.length > 0) lines.push(`inputs: ${requirements.inputs.join(' | ')}`);
  if (requirements.outputs.length > 0) lines.push(`outputs: ${requirements.outputs.join(' | ')}`);
  if (requirements.constraints.length > 0) lines.push(`constraints: ${requirements.constraints.join(' | ')}`);
  return truncate(lines.join('\n'), 2500);
}

function formatSerialLinks(links: { id: string; kind: string; mcuTxPin: string; mcuRxPin: string; baud?: number; note: string }[]): string {
  if (links.length === 0) return '(none — no UART peripherals; use Serial for logging)';
  return links
    .map(
      (link) =>
        `${link.id} (${link.kind === 'hardware' ? 'hardware UART' : 'SoftwareSerial'}): MCU TX=${link.mcuTxPin || '(integrated)'} RX=${link.mcuRxPin || '(integrated)'}${link.baud ? ` @ ${link.baud} baud` : ''} — ${link.note}`,
    )
    .join('\n');
}

function formatI2cBuses(buses: { id: string; sdaPin: string; sclPin: string; devices: { instanceId: string; address?: string }[] }[]): string {
  if (buses.length === 0) return '(no I2C devices in this build)';
  return buses
    .map(
      (bus) =>
        `${bus.id}: SDA=${bus.sdaPin} SCL=${bus.sclPin}; devices: ${bus.devices.map((device) => `${device.instanceId}${device.address ? ` (${device.address})` : ''}`).join(', ')}`,
    )
    .join('\n');
}

function formatLibraryManifest(libraries: { name: string; import: string; purpose: string }[]): string {
  if (libraries.length === 0) return '(none — Arduino core headers only)';
  return libraries.map((library) => `${library.name} → #include <${library.import}> — ${library.purpose}`).join('\n');
}

/** The model may name the project; otherwise derive one from the goal. */
function pickProjectName(raw: unknown, requirements: ProjectState['requirements'], base: ProjectState): string {
  const record = asRecord(raw);
  const modelName = typeof record.name === 'string' ? record.name.trim() : '';
  if (modelName.length > 0) return truncate(modelName, 80);
  if (base.name && base.name !== 'Untitled project') return base.name;
  const goal = requirements?.goal?.trim();
  if (goal && goal.length > 0) return truncate(goal.replace(/\.$/, ''), 80);
  return truncate(base.prompt.split('\n')[0] ?? 'Wireup project', 80);
}
