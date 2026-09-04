/**
 * MongoDB model for a generated project.
 *
 * One document holds the whole agent state machine: requirements, component
 * selections, hardware plan, pin assignments, wiring graph, software plan,
 * artifacts (code / diagram / libraries / instructions), validation results,
 * revisions and the structured event log.
 */

import mongoose, { type Model, type Types } from 'mongoose';

import type { ComponentSelection } from '@/types/component';
import type { AgentEvent } from '@/types/generation';
import type {
  GenerationError,
  GenerationStage,
  HardwarePlan,
  IterationState,
  LlmCallRecord,
  ProjectArtifacts,
  ProjectRequirements,
  ProjectRevision,
  ProjectStatus,
  SoftwarePlan,
} from '@/types/project';
import type { ValidationResult } from '@/types/validation';
import type { PinAssignment, WiringPlan } from '@/types/wiring';

export interface ProjectDocument {
  _id: Types.ObjectId;
  prompt: string;
  name: string;
  status: ProjectStatus;
  stage: GenerationStage;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;

  error: GenerationError | null;

  requirements: ProjectRequirements | null;
  components: ComponentSelection[];
  hardwarePlan: HardwarePlan | null;
  pinAssignments: PinAssignment[];
  wiring: WiringPlan | null;
  softwarePlan: SoftwarePlan | null;
  artifacts: ProjectArtifacts;
  validation: ValidationResult | null;
  revisions: ProjectRevision[];
  events: AgentEvent[];
  iteration: IterationState;
  llm: {
    model?: string;
    validationModel?: string;
    calls: LlmCallRecord[];
  };
  revision: number;
}

const Mixed = mongoose.Schema.Types.Mixed;

const ProjectSchema = new mongoose.Schema(
  {
    prompt: { type: String, required: true },
    name: { type: String, required: true, default: 'Untitled project' },
    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: [
        'pending',
        'running',
        'validating',
        'fixing',
        'completed',
        'completed_with_warnings',
        'completed_with_errors',
        'failed',
      ],
      index: true,
    },
    stage: { type: String, required: true, default: 'idle', index: true },

    completedAt: { type: Date, default: null },
    error: { type: Mixed, default: null },

    requirements: { type: Mixed, default: null },
    components: { type: Mixed, default: [] },
    hardwarePlan: { type: Mixed, default: null },
    pinAssignments: { type: Mixed, default: [] },
    wiring: { type: Mixed, default: null },
    softwarePlan: { type: Mixed, default: null },
    artifacts: {
      type: Mixed,
      default: { code: null, diagram: null, libraries: null, instructions: null },
    },
    validation: { type: Mixed, default: null },
    revisions: { type: Mixed, default: [] },
    events: { type: Mixed, default: [] },
    iteration: { type: Mixed, default: { current: 0, max: 0 } },
    llm: { type: Mixed, default: { calls: [] } },
    revision: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    versionKey: false,
    collection: 'projects',
  },
);

ProjectSchema.index({ createdAt: -1 });
ProjectSchema.index({ status: 1, updatedAt: 1 });

export function getProjectModel(): Model<ProjectDocument> {
  return (mongoose.models.Project as Model<ProjectDocument>) || mongoose.model<ProjectDocument>('Project', ProjectSchema);
}

export default getProjectModel;
