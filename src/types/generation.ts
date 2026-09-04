/**
 * Agent runtime types: structured events, the normalised result of the
 * generation LLM call, and the strongly typed fix changeset.
 */

import type {
  ComponentRole,
  ComponentSelection,
  LibraryRequirement,
} from './component';
import type { Diagram } from './diagram';
import type {
  CodeArtifact,
  GenerationStage,
  HardwarePlan,
  InstructionsArtifact,
  LibrariesArtifact,
  ProjectRequirements,
  SoftwarePlan,
} from './project';
import type { ArtifactKind } from './validation';
import type { PinAssignment, WiringConnection } from './wiring';

/* ------------------------------------------------------------------------- */
/* Agent events                                                               */
/* ------------------------------------------------------------------------- */

export type AgentEventType =
  | 'project_created'
  | 'generation_started'
  | 'requirements_started'
  | 'requirements_completed'
  | 'component_search_started'
  | 'component_search_completed'
  | 'component_selected'
  | 'llm_call_started'
  | 'llm_call_completed'
  | 'llm_call_failed'
  | 'hardware_plan_started'
  | 'hardware_plan_completed'
  | 'pin_assignment_started'
  | 'pin_assignment_completed'
  | 'wiring_started'
  | 'wiring_completed'
  | 'software_plan_started'
  | 'software_plan_completed'
  | 'code_generation_started'
  | 'code_generation_completed'
  | 'libraries_generation_started'
  | 'libraries_generation_completed'
  | 'diagram_generation_started'
  | 'diagram_generation_completed'
  | 'instructions_generation_started'
  | 'instructions_generation_completed'
  | 'revision_created'
  | 'validation_started'
  | 'validation_completed'
  | 'validation_error'
  | 'fix_started'
  | 'fix_change_applied'
  | 'fix_change_rejected'
  | 'fix_completed'
  | 'final_project_completed'
  | 'generation_failed'
  | 'info';

export type AgentEventStatus = 'started' | 'completed' | 'failed' | 'info';

export interface AgentEvent {
  /** Monotonically increasing per project — used as the polling cursor. */
  seq: number;
  id: string;
  type: AgentEventType;
  status: AgentEventStatus;
  /** Human readable, console-style line shown in the agent panel. */
  message: string;
  timestamp: string;
  stage?: GenerationStage;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------------- */
/* Generation call output (normalised)                                        */
/* ------------------------------------------------------------------------- */

/**
 * The normalised payload produced by CALL 1 — GENERATION. Model output is
 * parsed leniently and then normalised into these canonical shapes so every
 * downstream module can rely on exact types.
 */
export interface GenerationResult {
  project: {
    name: string;
    summary: string;
  };
  requirements: ProjectRequirements;
  components: ComponentSelection[];
  hardwarePlan: HardwarePlan;
  pinAssignments: PinAssignment[];
  wiring: WiringConnection[];
  softwarePlan: SoftwarePlan;
  code: CodeArtifact;
  diagram: Diagram | null;
  libraries: LibrariesArtifact;
  instructions: InstructionsArtifact;
  /** Free-form engineering notes emitted by the model. */
  notes: string[];
}

/* ------------------------------------------------------------------------- */
/* Fix changeset                                                              */
/* ------------------------------------------------------------------------- */

interface BaseChange {
  /** Stable id so the UI can show exactly what was applied. */
  id: string;
  artifact: ArtifactKind;
  reason: string;
  /** Validation issue this change addresses, when any. */
  issueId?: string;
  issueCode?: string;
  /** Who produced the change. */
  origin: 'deterministic' | 'model';
}

export interface SetRequirementsFieldChange extends BaseChange {
  artifact: 'requirements';
  op: 'set_field';
  field: keyof ProjectRequirements;
  value: unknown;
}

export interface ReplaceComponentChange extends BaseChange {
  artifact: 'components';
  op: 'replace_component';
  selectionId: string;
  componentId?: string;
  quantity?: number;
  role?: ComponentRole;
}

export interface AddComponentChange extends BaseChange {
  artifact: 'components';
  op: 'add_component';
  componentId: string;
  quantity: number;
  reason: string;
  role: ComponentRole;
  required?: boolean;
}

export interface RemoveComponentChange extends BaseChange {
  artifact: 'components';
  op: 'remove_component';
  selectionId: string;
}

export interface SetComponentQuantityChange extends BaseChange {
  artifact: 'components';
  op: 'set_quantity';
  selectionId: string;
  quantity: number;
}

export interface SetPinAssignmentChange extends BaseChange {
  artifact: 'pinAssignments';
  op: 'set_pin_assignment';
  /** Existing assignment to update, or a new one when omitted. */
  assignmentId?: string;
  assignment?: Partial<PinAssignment> & { pin: string; targetInstanceId: string; targetPin: string };
}

export interface RemovePinAssignmentChange extends BaseChange {
  artifact: 'pinAssignments';
  op: 'remove_pin_assignment';
  assignmentId: string;
}

export interface AddConnectionChange extends BaseChange {
  artifact: 'wiring';
  op: 'add_connection';
  connection: Omit<WiringConnection, 'id'> & { id?: string };
}

export interface ReplaceConnectionChange extends BaseChange {
  artifact: 'wiring';
  op: 'replace_connection';
  connectionId: string;
  connection?: Partial<Omit<WiringConnection, 'id'>>;
  /** Convenience: move one endpoint to another pin. */
  fromPin?: string;
  toPin?: string;
}

export interface RemoveConnectionChange extends BaseChange {
  artifact: 'wiring';
  op: 'remove_connection';
  connectionId: string;
}

export interface PatchCodeFileChange extends BaseChange {
  artifact: 'code';
  op: 'patch_code_file';
  path: string;
  mode: 'replace' | 'append' | 'prepend' | 'find_replace' | 'regex_replace';
  /** Full new content for `replace`. */
  content?: string;
  find?: string;
  replace?: string;
}

export interface AddCodeFileChange extends BaseChange {
  artifact: 'code';
  op: 'add_code_file';
  path: string;
  language: string;
  content: string;
  purpose?: string;
}

export interface RemoveCodeFileChange extends BaseChange {
  artifact: 'code';
  op: 'remove_code_file';
  path: string;
}

export interface SetLibrariesChange extends BaseChange {
  artifact: 'libraries';
  op: 'set_libraries';
  libraries: LibraryRequirement[];
}

export interface AddLibraryChange extends BaseChange {
  artifact: 'libraries';
  op: 'add_library';
  library: LibraryRequirement;
}

export interface RemoveLibraryChange extends BaseChange {
  artifact: 'libraries';
  op: 'remove_library';
  libraryName: string;
}

export interface PatchInstructionsChange extends BaseChange {
  artifact: 'instructions';
  op: 'patch_instructions';
  sectionId: string;
  mode: 'replace' | 'append';
  content: string;
}

/** Ask the orchestrator to re-derive an artifact deterministically. */
export interface RerunStageChange extends BaseChange {
  artifact: 'diagram' | 'wiring' | 'pinAssignments' | 'instructions' | 'libraries' | 'code';
  op: 'rerun_stage';
  stage: 'pins' | 'wiring' | 'diagram' | 'instructions' | 'libraries' | 'code';
}

export type FixChange =
  | SetRequirementsFieldChange
  | ReplaceComponentChange
  | AddComponentChange
  | RemoveComponentChange
  | SetComponentQuantityChange
  | SetPinAssignmentChange
  | RemovePinAssignmentChange
  | AddConnectionChange
  | ReplaceConnectionChange
  | RemoveConnectionChange
  | PatchCodeFileChange
  | AddCodeFileChange
  | RemoveCodeFileChange
  | SetLibrariesChange
  | AddLibraryChange
  | RemoveLibraryChange
  | PatchInstructionsChange
  | RerunStageChange;

export type FixChangeOp = FixChange['op'];

/** Result of applying a changeset to a project. */
export interface FixResult {
  changes: FixChange[];
  applied: { id: string; op: string; artifact: ArtifactKind; detail: string }[];
  rejected: { id: string; op: string; artifact: ArtifactKind; reason: string }[];
  /** Artifacts that were touched and therefore need re-validation. */
  touchedArtifacts: ArtifactKind[];
  notes: string[];
}
