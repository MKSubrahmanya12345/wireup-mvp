/**
 * The human loop.
 *
 * The agent cannot touch the physical world: it cannot plug in a ribbon cable,
 * read a terminal, smell a burnt MOSFET or measure a door frame. Everything it
 * cannot do itself it routes to a human through one of four verbs, and whatever
 * comes back is stored as a grounded *fact* that later planning reads instead of
 * guessing.
 *
 * See `docs/pi-face-lock/HANDS-AND-LEGS.md` for the protocol.
 */

/** What the agent is asking the human for. */
export type HumanTaskVerb =
  /** A decision only the human can make. Always offered with a default. */
  | 'ask'
  /** A physical action: plug it in, run this, press it, measure it. */
  | 'do'
  /** Report what reality says: LED colour, screen text, multimeter value. */
  | 'observe'
  /** A check with an explicit pass criterion the agent grades itself. */
  | 'verify';

export type HumanTaskStatus =
  | 'open'
  | 'claimed'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'skipped';

export type AnswerKind = 'choice' | 'text' | 'number' | 'boolean' | 'measurement' | 'terminal' | 'photo';

export interface AnswerOption {
  value: string;
  label: string;
  /** Why this option changes the build — shown inline, never a bare label. */
  note?: string;
}

export interface AnswerSpec {
  kind: AnswerKind;
  /** For `choice`. */
  options?: AnswerOption[];
  /** For `measurement`, e.g. "mm", "V", "fps". */
  unit?: string;
  /**
   * What a good answer looks like. Telling the human the expected shape is the
   * difference between a useful result and "idk it printed some stuff".
   */
  expect?: string;
  placeholder?: string;
  /** `verify` only: the criterion the agent applies to grade the answer. */
  passWhen?: string;
}

export type RiskLevel = 'none' | 'caution' | 'high';

export interface HumanTask {
  id: string;
  /** 1-based display order. */
  order: number;
  verb: HumanTaskVerb;
  /** One line, imperative. "Plug the CSI ribbon into CAM1". */
  title: string;
  /** Why the agent cannot do this itself. Always stated — no unexplained chores. */
  why: string;
  /** What the agent will do with the answer. Always stated. */
  thenWhat: string;
  /** Ordered sub-steps for `do`. */
  steps?: string[];
  /** Exact, copy-pasteable command for `do`. */
  command?: string;
  answer: AnswerSpec;
  /** Applied when the human skips. A task with no default is a bug. */
  default?: string | number | boolean;
  risk: RiskLevel;
  /** Hazard line shown for `caution` / `high` risk tasks. */
  hazard?: string;
  /** A blocking task halts the run until it is answered or skipped. */
  blocking: boolean;
  dependsOn?: string[];
  /** Fact key this task grounds, e.g. `camera.detected`. */
  fact?: string;
  group: string;
  status: HumanTaskStatus;
  createdAt: string;
  claimedAt?: string;
  submittedAt?: string;
  result?: HumanTaskResult;
  /** Set when the answer conflicts with a catalog value — never silently trusted. */
  conflict?: string;
}

export interface HumanTaskResult {
  answer: string;
  /** Terminal output, a measurement, a description of a photo. */
  evidence?: string;
  note?: string;
  at: string;
}

export interface HumanFact {
  key: string;
  value: string;
  sourceTaskId: string;
  at: string;
  /** `reported` = the human said so. `derived` = the agent computed it. */
  confidence: 'reported' | 'derived';
  /** True when the default was used because the task was skipped. */
  assumed?: boolean;
}

export interface HumanLoopState {
  tasks: HumanTask[];
  facts: HumanFact[];
  /** Set when the plan was generated, so regeneration is explicit. */
  plannedAt?: string;
}

export interface SubmitTaskInput {
  answer: string;
  evidence?: string;
  note?: string;
}

export const TASK_GROUP_LABELS: Record<string, string> = {
  decisions: 'Decisions',
  procurement: 'Procurement',
  bringup: 'Bring-up',
  wiring: 'Bench wiring',
  install: 'Physical install',
  vision: 'Vision tuning',
  enrollment: 'Enrollment',
  security: 'Security & safety',
};

export function emptyHumanLoop(): HumanLoopState {
  return { tasks: [], facts: [] };
}
