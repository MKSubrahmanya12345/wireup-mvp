/**
 * Everflow types — the project graph, per-node completion goals, the intake
 * doubt session and the two-directional human channel.
 *
 * The graph is the pipeline's own state made visible: nodes are created by
 * intake, pipeline stages, continuation passes or explicit human edits, and
 * the materialised graph is a projection of the persisted project state, so
 * nothing here can drift from what the workspace files actually contain.
 *
 * Two invariants this slice enforces:
 *   1. NO DANGLING NODES — a node whose goal is unmet must carry an open task
 *      (AI-owned or human-owned) or a named next action. `evaluateEverflow`
 *      reports any violation as an `openEnd`.
 *   2. NO SILENT SELF-MODIFICATION — human additions never mutate the design
 *      by themselves; they become facts, and a human-confirmed step (a new
 *      revision) is what applies them.
 */

/* ------------------------------------------------------------------------- */
/* Graph                                                                      */
/* ------------------------------------------------------------------------- */

export type EverflowNodeKind =
  | 'intent'
  | 'claim'
  | 'assumption'
  | 'decision'
  | 'goal'
  | 'doubt'
  | 'evidence'
  | 'task'
  | 'artifact';

export type EverflowNodeStatus = 'proposed' | 'active' | 'blocked' | 'human_review' | 'complete' | 'rejected';

export type EverflowEdgeKind =
  | 'supports'
  | 'depends_on'
  | 'contradicts'
  | 'produces'
  | 'verified_by'
  | 'part_of'
  | 'located_in'
  | 'answered_by';

export interface EverflowEdge {
  id: string;
  from: string;
  to: string;
  kind: EverflowEdgeKind;
  note?: string;
}

/**
 * The completion contract of a single node. The criterion is human language;
 * `kind` selects the deterministic check the evaluator runs against the
 * project state — goals are judged by code, never by the model's mood.
 */
export interface NodeGoal {
  /** What "done" means for this node, in human language. */
  criterion: string;
  /** Which deterministic check evaluates this goal. */
  kind:
    | 'artifact_exists'
    | 'validation_clean'
    | 'behaviour_proven'
    | 'human_confirmed'
    | 'evidence_attached'
    | 'doubt_answered'
    | 'requirement_covered'
    | 'custom';
  /** Evaluator's current verdict (materialise declares `open`; evaluate decides). */
  state: 'open' | 'in_progress' | 'satisfied' | 'blocked_human' | 'waived';
  /** Deterministic check identifier (assertion id, check id, file path…). */
  checkId?: string;
  /** Node id of the evidence that satisfied the goal, when any. */
  satisfiedBy?: string;
  note?: string;
}

export interface EverflowNode {
  id: string;
  kind: EverflowNodeKind;
  label: string;
  content: string;
  status: EverflowNodeStatus;
  /** Calibrated 0..1, or null when not yet assessed. */
  confidence: number | null;
  owner: 'ai' | 'human' | 'shared';
  goal: NodeGoal;
  /** Graph ↔ workspace files: the file this node lives in, when it has one. */
  file?: { path: string; anchor?: string } | null;
  /** Internal reference (component id, issue id, check id, assertion id…). */
  ref?: string;
  source: {
    origin: 'intake' | 'pipeline' | 'human' | 'continuation' | 'research';
    stage?: string;
    revision?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EverflowGraph {
  projectId: string;
  nodes: EverflowNode[];
  edges: EverflowEdge[];
  updatedAt: string;
}

/* ------------------------------------------------------------------------- */
/* Intake doubt session                                                       */
/* ------------------------------------------------------------------------- */

/** Who owns the answer. `ai` = technical call, recorded and appealable. */
export type DoubtDecider = 'human' | 'ai' | 'ai_with_veto';

export type DoubtStatus = 'open' | 'answered' | 'assumed' | 'resolved_ai';

export interface ProjectDoubt {
  id: string;
  question: string;
  /** Why this matters — the consequence of guessing wrong. */
  consequence: string;
  decider: DoubtDecider;
  /** Blocking doubts gate the Build button (soft gate: skipping records an assumption). */
  blocking: boolean;
  options: string[];
  proposedDefault: string | null;
  /** The AI's confidence that the default is right, 0..1. */
  confidence: number;
  status: DoubtStatus;
  answer: {
    value: string;
    via: 'human' | 'ai_default' | 'skipped';
    at: string;
  } | null;
  /** Graph node this doubt resolves to, once the graph is materialised. */
  nodeId?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------------- */
/* Human channel — two directions                                             */
/* ------------------------------------------------------------------------- */

/**
 * `ai_to_human`  — column one: the agent needs something only a human can give
 *                  (confirmation, a choice, a real-world test, context).
 * `human_to_ai`  — column two: the human has information the agent cannot have
 *                  (ideas, corrections, resources, lived context).
 */
export type HumanTaskDirection = 'ai_to_human' | 'human_to_ai';

export type HumanTaskType =
  // AI → human
  | 'verify'
  | 'choose'
  | 'test'
  | 'review'
  | 'context'
  // human → AI
  | 'note'
  | 'idea'
  | 'correction'
  | 'resource';

export type ResponseShape = 'boolean' | 'choice' | 'text' | 'measurement';

export type HumanTaskStatus = 'open' | 'answered' | 'processed' | 'deferred' | 'expired';

export interface HumanTask {
  id: string;
  direction: HumanTaskDirection;
  type: HumanTaskType;
  title: string;
  body: string;
  asks: {
    shape: ResponseShape;
    options?: string[];
    /** Options that count as a positive/confirming answer (boolean tasks). */
    positiveOptions?: string[];
  };
  /** Graph nodes this task works on. */
  linkedNodeIds: string[];
  /** Where the human should look while answering. */
  lookAt?: { kind: 'node' | 'file' | 'sim' | 'quality' | 'project'; ref: string; label: string } | null;
  priority: 'low' | 'medium' | 'high';
  status: HumanTaskStatus;
  response: { value: string; note?: string; at: string } | null;
  /** What the agent does if this is never answered — it never blocks. */
  defaultOnExpiry: 'assume' | 'defer' | 'halt';
  assumptionIfSkipped: string | null;
  source: 'ai' | 'human' | 'intake';
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* ------------------------------------------------------------------------- */

export interface GoalEvaluation {
  nodeId: string;
  kind: EverflowNodeKind;
  label: string;
  goal: NodeGoal;
  satisfied: boolean;
  /** What the evaluator saw — shown verbatim in the UI. */
  evidence: string;
  /** True when the node is dangling: unmet goal, no task, no next action. */
  openEnd: boolean;
  openEndReason?: string;
}

export type NextActionKind = 'run_fix' | 'ask_human' | 'verify_sim' | 'integrate_input' | 'none';

export interface NextAction {
  kind: NextActionKind;
  nodeId?: string;
  description: string;
}

export interface EverflowEvaluation {
  at: string;
  pass: number;
  totals: {
    nodes: number;
    goalsTotal: number;
    goalsSatisfied: number;
    goalsOpen: number;
    goalsBlockedHuman: number;
    goalsWaived: number;
    openEnds: number;
    aiTasksOpen: number;
    humanTasksOpen: number;
  };
  /** 0..1 over non-waived goals. */
  completion: number;
  /** True when every non-waived goal is satisfied and nothing is dangling. */
  done: boolean;
  /** True when the only remaining work is owned by a human. */
  blockedOnHuman: boolean;
  results: GoalEvaluation[];
  nextActions: NextAction[];
  /** The rendered global project document (the context bundle). */
  brief: string;
}

/* ------------------------------------------------------------------------- */
/* Project-level state                                                        */
/* ------------------------------------------------------------------------- */

export interface EverflowState {
  /** Last materialised graph (persisted for the UI; the API can re-materialise live). */
  graph: EverflowGraph | null;
  /** Last evaluation of that graph. */
  evaluation: EverflowEvaluation | null;
  /** How many continuation passes have run. */
  pass: number;
}

/* ------------------------------------------------------------------------- */
/* Research — the agent's docs/web check tool                                 */
/* ------------------------------------------------------------------------- */

/** Where a research finding came from. */
export type ResearchSource = 'catalog' | 'corpus' | 'web';

/**
 * The result of the agent checking documentation (catalog, the bundled docs
 * corpus, or the live web) for a graph node it is not confident about.
 * Findings are EVIDENCE with a citation — they inform, they never silently
 * satisfy a goal, and web findings are always flagged for human review.
 */
export interface ResearchFinding {
  id: string;
  /** Graph node this research was performed for. */
  nodeId: string;
  /** What the agent wanted to know. */
  question: string;
  source: ResearchSource;
  /** Human-readable citation, e.g. "Raspberry Pi 5 — official specs". */
  title: string;
  url: string | null;
  /** The facts found, verbatim, for the record. */
  facts: string[];
  /** 0..1 — web findings are capped until a human confirms. */
  confidence: number;
  /** True when the human should still verify before this is trusted. */
  needsHumanCheck: boolean;
  at: string;
}

/**
 * The expanded brief — the messy prompt (often a voice transcription)
 * normalised into the global project document the agent works from.
 */
export interface ExpandedBrief {
  /** Rendered global project document (folded into the pipeline prompt). */
  text: string;
  structured: {
    goal: string;
    platform: string | null;
    components: { name: string; quantity: number; role: string }[];
    behaviours: string[];
    assumptions: string[];
    openQuestions: string[];
  };
  source: 'llm' | 'deterministic';
  at: string;
}
