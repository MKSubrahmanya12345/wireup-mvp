/**
 * Deterministic validation rule engine.
 *
 * Every rule is evidence-based: it points at the exact pin, connection, file or
 * component instance that is wrong, and declares whether a non-LLM fix exists.
 * The model review (see `llm.ts`) is merged on top of these findings.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { Diagram } from '@/types/diagram';
import type { ProjectRequirements, ProjectState } from '@/types/project';
import type { ValidationCheck, ValidationDomain, ValidationIssue, ValidationIssueCode, ValidationSeverity } from '@/types/validation';
import type { PinAssignment, WiringPlan } from '@/types/wiring';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import {
  CodeArtifactSchema,
  ComponentSelectionSchema,
  DiagramSchema,
  InstructionsArtifactSchema,
  LibrariesArtifactSchema,
  PinAssignmentSchema,
  ProjectRequirementsSchema,
  WiringConnectionSchema,
} from '@/lib/validation/schema';
import { issueId } from '@/lib/validation/ids';

import { analyzeCoverage } from '@/modules/project-understanding';
import { braceBalance } from '@/modules/code-generator';
import { constantName, pinLiteral } from '@/modules/code-generator/templates';
import { checkDiagramIntegrity, findMissingDiagramComponents } from '@/modules/diagram-generator';
import { detectConflicts } from '@/modules/wiring-planner/conflicts';
import { includeStatement } from '@/modules/code-generator/templates';

/** Issue codes the deterministic fixer knows how to repair. */
export const AUTO_FIXABLE_CODES: ValidationIssueCode[] = [
  'gpio_conflict',
  'reserved_pin_used',
  'input_only_pin_driven',
  'capability_mismatch',
  'missing_ground',
  'missing_power',
  'motor_on_mcu_pin',
  'dangling_reference',
  'unknown_pin',
  'duplicate_connection',
  'floating_required_pin',
  'diagram_out_of_sync',
  'diagram_missing_component',
  'diagram_missing_connection',
  'code_pin_mismatch',
  'code_missing_include',
  'code_unbalanced_braces',
  'code_missing_setup_loop',
  'library_missing',
  'instructions_missing_section',
  'instructions_out_of_sync',
  'missing_component',
];

export interface RuleContext {
  project: ProjectState;
  catalog: ComponentDefinition[];
  profile?: McuProfile;
}

interface IssueDraft {
  code: ValidationIssueCode;
  severity: ValidationSeverity;
  domain: ValidationDomain;
  message: string;
  details?: string;
  fixHint?: string;
  target?: ValidationIssue['target'];
}

export interface RuleEngineResult {
  checks: ValidationCheck[];
  issues: ValidationIssue[];
}

export function runRuleEngine(context: RuleContext): RuleEngineResult {
  const checks: ValidationCheck[] = [];
  const issues: ValidationIssue[] = [];
  const { project, catalog, profile } = context;

  const add = (checkId: string, draft: IssueDraft): ValidationIssue => {
    const issue: ValidationIssue = {
      id: issueId(),
      code: draft.code,
      severity: draft.severity,
      domain: draft.domain,
      message: draft.message,
      autoFixable: AUTO_FIXABLE_CODES.includes(draft.code),
      origin: 'rules',
      ...(draft.details ? { details: draft.details } : {}),
      ...(draft.fixHint ? { fixHint: draft.fixHint } : {}),
      ...(draft.target ? { target: draft.target } : {}),
    };
    issues.push(issue);
    return issue;
  };

  const finishCheck = (id: string, name: string, domain: ValidationDomain, from: number, okMessage: string): void => {
    const produced = issues.slice(from);
    checks.push({
      id,
      name,
      domain,
      status: produced.length === 0 ? 'passed' : produced.some((issue) => issue.severity === 'error') ? 'failed' : 'passed',
      message: produced.length === 0 ? okMessage : produced.map((issue) => issue.message).join(' | '),
      issueIds: produced.map((issue) => issue.id),
    });
  };

  /* 1. Structural schema validation ---------------------------------------- */
  let mark = issues.length;
  const requirementsCheck = ProjectRequirementsSchema.safeParse(project.requirements);
  if (project.requirements && !requirementsCheck.success) {
    add('structure', {
      code: 'schema_violation',
      severity: 'error',
      domain: 'requirements',
      message: 'Project requirements do not match the ProjectRequirements schema.',
      details: requirementsCheck.error.issues.slice(0, 5).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
      fixHint: 'Re-run the requirements normalisation stage.',
      target: { artifact: 'requirements' },
    });
  }
  for (const selection of project.components) {
    const parsed = ComponentSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'components',
        message: `Component selection "${selection.name ?? selection.componentId}" violates the schema.`,
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'components', selectionId: selection.id },
      });
    }
  }
  for (const assignment of project.pinAssignments) {
    const parsed = PinAssignmentSchema.safeParse(assignment);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'pins',
        message: `Pin assignment ${assignment.id} violates the schema.`,
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'pinAssignments', assignmentId: assignment.id },
      });
    }
  }
  for (const connection of project.wiring?.connections ?? []) {
    const parsed = WiringConnectionSchema.safeParse(connection);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'wiring',
        message: `Connection ${connection.id} violates the schema.`,
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'wiring', connectionId: connection.id },
      });
    }
  }
  if (project.artifacts.code) {
    const parsed = CodeArtifactSchema.safeParse(project.artifacts.code);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'code',
        message: 'The code artifact violates the CodeArtifact schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'code' },
      });
    }
  }
  finishCheck('structure.schema', 'Artifact schema validation', 'structure', mark, 'All artifacts match their schemas');

  /* 2. Requirements --------------------------------------------------------- */
  mark = issues.length;
  const requirements: ProjectRequirements | null = project.requirements;
  if (!requirements) {
    add('requirements', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'requirements',
      message: 'No project requirements were produced, so nothing downstream can be trusted.',
      fixHint: 'Re-run the project understanding stage.',
      target: { artifact: 'requirements' },
    });
  } else {
    if (!requirements.goal.trim()) {
      add('requirements', {
        code: 'empty_artifact',
        severity: 'error',
        domain: 'requirements',
        message: 'The requirements goal is empty.',
        target: { artifact: 'requirements' },
      });
    }
    const corpus = [
      ...project.components.map((selection) => `${selection.name} ${selection.reason} ${selection.notes ?? ''}`),
      ...(project.artifacts.code?.files ?? []).map((file) => file.content),
      project.softwarePlan?.architecture ?? '',
      ...(project.softwarePlan?.modules ?? []).map((module) => `${module.name} ${module.responsibility}`),
      ...(project.wiring?.connections ?? []).map((connection) => connection.explanation),
      project.artifacts.instructions?.markdown ?? '',
    ].join('\n');

    const coverage = analyzeCoverage({ requirements, searchCorpus: corpus });
    for (const statement of coverage.uncovered.slice(0, 6)) {
      add('requirements', {
        code: 'requirement_uncovered',
        severity: 'warning',
        domain: 'requirements',
        message: `Requirement appears unimplemented: "${statement}"`,
        details: 'No component, wiring note, code or instruction text references the key terms of this requirement.',
        fixHint: 'Add the missing hardware/software behaviour or document why it is out of scope.',
        target: { artifact: 'requirements' },
      });
    }
  }
  finishCheck('requirements.coverage', 'Requirement coverage', 'requirements', mark, 'Every stated requirement is reflected in the design');

  /* 3. Components ----------------------------------------------------------- */
  mark = issues.length;
  if (project.components.length === 0) {
    add('components', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'components',
      message: 'No components were selected.',
      target: { artifact: 'components' },
    });
  }

  const controller = project.components.find((selection) => selection.role === 'controller');
  if (!controller) {
    add('components', {
      code: 'missing_controller',
      severity: 'error',
      domain: 'components',
      message: 'The bill of materials contains no microcontroller, so the firmware has nothing to run on.',
      fixHint: 'Add a controller that satisfies the platform and communication requirements.',
      target: { artifact: 'components' },
    });
  }

  const instanceIds = new Set<string>();
  for (const selection of project.components) {
    if (!catalog.some((component) => component.id === selection.componentId)) {
      add('components', {
        code: 'unknown_component',
        severity: 'error',
        domain: 'components',
        message: `Component "${selection.componentId}" is not in the component database.`,
        details: selection.name !== selection.componentId ? `Listed as "${selection.name}".` : undefined,
        fixHint: 'Replace it with the closest catalog part.',
        target: { artifact: 'components', componentId: selection.componentId, selectionId: selection.id },
      });
    }
    if (selection.source === 'model') {
      add('components', {
        code: 'invented_component',
        severity: 'info',
        domain: 'components',
        message: `"${selection.name}" was matched from model text ("${selection.matchedFrom ?? selection.componentId}") rather than selected directly from the catalog.`,
        fixHint: 'Confirm the substitution is electrically suitable.',
        target: { artifact: 'components', componentId: selection.componentId, selectionId: selection.id },
      });
    }
    if (!selection.reason || selection.reason.trim().length < 4) {
      add('components', {
        code: 'empty_artifact',
        severity: 'warning',
        domain: 'components',
        message: `${selection.name} has no engineering reason recorded.`,
        target: { artifact: 'components', selectionId: selection.id },
      });
    }
    if (selection.quantity !== selection.instances.length) {
      add('components', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'components',
        message: `${selection.name} declares quantity ${selection.quantity} but has ${selection.instances.length} instance(s).`,
        fixHint: 'Re-expand the selection instances.',
        target: { artifact: 'components', selectionId: selection.id },
      });
    }
    for (const instance of selection.instances) {
      if (instanceIds.has(instance.instanceId)) {
        add('components', {
          code: 'duplicate_instance_id',
          severity: 'error',
          domain: 'components',
          message: `Duplicate component instance id "${instance.instanceId}".`,
          target: { artifact: 'components', componentInstanceId: instance.instanceId },
        });
      }
      instanceIds.add(instance.instanceId);
    }
  }

  // Motors without a driver.
  const hasDriver = project.components.some((selection) => selection.category === 'motor_driver');
  for (const selection of project.components) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;
    if (definition.category !== 'motor') continue;
    if (definition.motorRequirements?.motorType === 'servo') continue;
    if (definition.motorRequirements?.requiresDriver !== true) continue;
    if (typeof definition.metadata.driverIntegrated === 'string') continue;
    if (hasDriver) continue;
    add('components', {
      code: 'missing_component',
      severity: 'error',
      domain: 'components',
      message: `${definition.name} needs an H-bridge/step driver but none is in the bill of materials.`,
      fixHint: 'Add L298N, L293D, TB6612FNG or A4988 depending on motor type and current.',
      target: { artifact: 'components', componentId: definition.id, selectionId: selection.id },
    });
  }
  finishCheck('components.selection', 'Component selection', 'components', mark, 'Component selection is complete and grounded in the catalog');

  /* 4. Compatibility -------------------------------------------------------- */
  mark = issues.length;
  for (const entry of project.hardwarePlan?.compatibility ?? []) {
    if (entry.compatible) continue;
    add('compatibility', {
      code: 'incompatible_components',
      severity: 'error',
      domain: 'compatibility',
      message: `${entry.a} and ${entry.b} are not compatible: ${entry.reason}`,
      fixHint: 'Insert the interface component (driver, regulator or level shifter) or choose a different part.',
      target: { artifact: 'hardwarePlan', componentId: entry.a },
    });
  }
  finishCheck('compatibility.matrix', 'Compatibility matrix', 'compatibility', mark, 'All declared component pairs are compatible');

  /* 5. Pins ----------------------------------------------------------------- */
  mark = issues.length;
  const knownInstances = instanceIds;
  for (const assignment of project.pinAssignments) {
    if (!knownInstances.has(assignment.targetInstanceId)) {
      add('pins', {
        code: 'dangling_reference',
        severity: 'error',
        domain: 'pins',
        message: `Pin assignment ${assignment.id} targets unknown instance "${assignment.targetInstanceId}".`,
        fixHint: 'Remove the assignment or add the component.',
        target: { artifact: 'pinAssignments', assignmentId: assignment.id, componentInstanceId: assignment.targetInstanceId },
      });
      continue;
    }
    const targetDefinition = catalog.find((component) => component.id === assignment.targetComponentId);
    const targetPin = targetDefinition?.pins.find((entry) => entry.name.toLowerCase() === assignment.targetPin.toLowerCase());
    if (targetDefinition && !targetPin) {
      add('pins', {
        code: 'unknown_pin',
        severity: 'error',
        domain: 'pins',
        message: `${assignment.targetInstanceId} has no pin named "${assignment.targetPin}".`,
        details: `Valid pins: ${targetDefinition.pins.map((entry) => entry.name).join(', ')}.`,
        target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.targetPin },
      });
    }
    if (profile && assignment.mcuInstanceId === project.hardwarePlan?.controller?.instanceId) {
      const spec = profile.pins.find((entry) => entry.name === assignment.pin);
      if (!spec) {
        add('pins', {
          code: 'unknown_pin',
          severity: 'error',
          domain: 'pins',
          message: `${assignment.pin} is not a pin of ${profile.name}.`,
          target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
        });
      } else if (assignment.direction === 'output' && spec.capabilities.includes('input-only')) {
        add('pins', {
          code: 'input_only_pin_driven',
          severity: 'error',
          domain: 'pins',
          message: `${assignment.pin} is input-only on ${profile.name} but is assigned as an output for ${assignment.targetInstanceId}.${assignment.targetPin}.`,
          fixHint: `Use an output-capable pin such as ${profile.pins.filter((entry) => !entry.capabilities.includes('input-only')).slice(0, 4).map((entry) => entry.name).join(', ')}.`,
          target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
        });
      }
      if (profile.reserved.some((entry) => entry.pin === assignment.pin)) {
        add('pins', {
          code: 'reserved_pin_used',
          severity: 'error',
          domain: 'pins',
          message: `${assignment.pin} is reserved on ${profile.name} and cannot be used for ${assignment.targetInstanceId}.${assignment.targetPin}.`,
          target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
        });
      }
    }
  }

  const peripheralNeeds = new Map<string, number>();
  for (const selection of project.components) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;
    if (definition.metadata.electrical === false || definition.metadata.integrated === true) continue;
    if (['prototyping', 'passive', 'power'].includes(definition.category)) continue;
    const needed = definition.pins.filter((entry) => entry.required && ['digital', 'analog', 'pwm', 'uart', 'i2c', 'spi', 'one_wire', 'enable'].includes(entry.type)).length;
    if (needed === 0) continue;
    for (const instance of selection.instances) peripheralNeeds.set(instance.instanceId, needed);
  }
  for (const [instanceId, needed] of peripheralNeeds) {
    const assigned = project.pinAssignments.filter((assignment) => assignment.targetInstanceId === instanceId).length;
    if (assigned < needed) {
      add('pins', {
        code: 'floating_required_pin',
        severity: 'warning',
        domain: 'pins',
        message: `${instanceId} needs ${needed} MCU pin(s) but only ${assigned} were assigned.`,
        fixHint: 'Assign the remaining required pins or document why they are unused.',
        target: { artifact: 'pinAssignments', componentInstanceId: instanceId },
      });
    }
  }
  finishCheck('pins.assignments', 'Pin assignment legality', 'pins', mark, 'All pin assignments are legal for the selected MCU');

  /* 6. Wiring --------------------------------------------------------------- */
  mark = issues.length;
  const wiring: WiringPlan | null = project.wiring;
  if (!wiring || wiring.connections.length === 0) {
    add('wiring', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'wiring',
      message: 'The wiring graph is empty — there is nothing to build.',
      target: { artifact: 'wiring' },
    });
  } else {
    for (const conflict of detectConflicts({
      connections: wiring.connections,
      assignments: project.pinAssignments,
      selections: project.components,
      catalog,
      ...(project.hardwarePlan?.power ? { power: project.hardwarePlan.power } : {}),
      ...(profile ? { profile } : {}),
      ...(project.hardwarePlan?.controller?.instanceId ? { controllerInstanceId: project.hardwarePlan.controller.instanceId } : {}),
    })) {
      const code = conflict.code as ValidationIssueCode;
      add('wiring', {
        code: AUTO_FIXABLE_CODES.includes(code) ? code : 'dangling_reference',
        severity: conflict.severity,
        domain: 'wiring',
        message: conflict.message,
        ...(conflict.suggestion ? { fixHint: conflict.suggestion } : {}),
        target: {
          artifact: 'wiring',
          ...(conflict.connectionIds[0] ? { connectionId: conflict.connectionIds[0] } : {}),
          ...(conflict.instanceIds[0] ? { componentInstanceId: conflict.instanceIds[0] } : {}),
          ...(conflict.pins[0] ? { pin: conflict.pins[0] } : {}),
        },
      });
    }

    // Every pin assignment must have a matching wire.
    for (const assignment of project.pinAssignments) {
      const found = wiring.connections.some(
        (connection) =>
          (connection.from.instanceId === assignment.mcuInstanceId &&
            connection.from.pin === assignment.pin &&
            connection.to.instanceId === assignment.targetInstanceId &&
            connection.to.pin.toLowerCase() === assignment.targetPin.toLowerCase()) ||
          (connection.to.instanceId === assignment.mcuInstanceId &&
            connection.to.pin === assignment.pin &&
            connection.from.instanceId === assignment.targetInstanceId &&
            connection.from.pin.toLowerCase() === assignment.targetPin.toLowerCase()) ||
          // Level-shifted or series-resistor paths are indirect but valid.
          (connection.metadata?.assignmentId === assignment.id),
      );
      const indirect = wiring.connections.some(
        (connection) =>
          connection.from.instanceId === assignment.mcuInstanceId && connection.from.pin === assignment.pin && connection.kind === 'signal',
      );
      if (!found && !indirect) {
        add('wiring', {
          code: 'dangling_reference',
          severity: 'error',
          domain: 'wiring',
          message: `Pin assignment ${assignment.mcuInstanceId}.${assignment.pin} → ${assignment.targetInstanceId}.${assignment.targetPin} has no corresponding wire.`,
          fixHint: 'Re-run the wiring stage so the connection graph matches the pin plan.',
          target: { artifact: 'wiring', assignmentId: assignment.id, pin: assignment.pin, componentInstanceId: assignment.targetInstanceId },
        });
      }
    }
  }
  finishCheck('wiring.graph', 'Wiring graph integrity', 'wiring', mark, 'Wiring graph is complete and conflict-free');

  /* 7. Power ---------------------------------------------------------------- */
  mark = issues.length;
  const power = project.hardwarePlan?.power;
  if (!power) {
    add('power', {
      code: 'empty_artifact',
      severity: 'warning',
      domain: 'power',
      message: 'No power analysis was produced.',
      target: { artifact: 'hardwarePlan' },
    });
  } else {
    if (!power.supplyComponentId) {
      add('power', {
        code: 'missing_component',
        severity: 'error',
        domain: 'power',
        message: 'No power supply is present in the hardware plan.',
        fixHint: 'Add a battery, regulator or bench supply that fits the load.',
        target: { artifact: 'components' },
      });
    }
    if (!power.adequate) {
      add('power', {
        code: 'power_budget_exceeded',
        severity: 'error',
        domain: 'power',
        message: `Power budget is not adequate: ${
          power.shortfalls?.[0] ?? power.notes[0] ?? 'the supply cannot serve the calculated load.'
        }`,
        details: power.notes.join(' '),
        fixHint: 'Increase supply capability or add regulation with headroom.',
        target: { artifact: 'hardwarePlan' },
      });
    }
  }
  finishCheck('power.budget', 'Power budget', 'power', mark, 'Power budget is adequate for the selected supply');

  /* 8. Code ----------------------------------------------------------------- */
  mark = issues.length;
  const code = project.artifacts.code;
  if (!code || code.files.length === 0) {
    add('code', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'code',
      message: 'No firmware source was generated.',
      target: { artifact: 'code' },
    });
  } else {
    const entry = code.files.find((file) => file.path === code.entryPoint) ?? code.files[0];
    if (!entry) {
      add('code', {
        code: 'empty_artifact',
        severity: 'error',
        domain: 'code',
        message: `Entry point "${code.entryPoint}" is not present in the generated files.`,
        target: { artifact: 'code' },
      });
    } else {
      const content = entry.content;
      if (!/void\s+setup\s*\(/.test(content) || !/void\s+loop\s*\(/.test(content)) {
        add('code', {
          code: 'code_missing_setup_loop',
          severity: 'error',
          domain: 'code',
          message: `${entry.path} does not define both setup() and loop().`,
          fixHint: 'Regenerate the sketch from the software plan.',
          target: { artifact: 'code', filePath: entry.path },
        });
      }
      const balance = braceBalance(content);
      if (balance !== 0) {
        add('code', {
          code: 'code_unbalanced_braces',
          severity: 'error',
          domain: 'code',
          message: `${entry.path} has unbalanced braces (${balance > 0 ? `${balance} unclosed` : `${-balance} extra closing`}).`,
          fixHint: 'Repair the block structure or regenerate the file.',
          target: { artifact: 'code', filePath: entry.path },
        });
      }
      if (/\b(TODO|FIXME|your code here|placeholder)\b/i.test(content)) {
        add('code', {
          code: 'code_missing_setup_loop',
          severity: 'warning',
          domain: 'code',
          message: `${entry.path} still contains placeholder markers.`,
          target: { artifact: 'code', filePath: entry.path },
        });
      }

      // Pin constants must agree with the pin plan.
      for (const assignment of project.pinAssignments) {
        const name = constantName(assignment);
        const literal = pinLiteral(assignment);
        const declared = new RegExp(`(?:const\\s+\\w+\\s+${name}\\s*=\\s*([^;]+);|#define\\s+${name}\\s+(\\S+))`).exec(content);
        if (!declared) {
          add('code', {
            code: 'code_pin_mismatch',
            severity: 'warning',
            domain: 'code',
            message: `${entry.path} does not declare ${name} for ${assignment.mcuInstanceId}.${assignment.pin} → ${assignment.targetInstanceId}.${assignment.targetPin}.`,
            fixHint: 'Re-inject the generated pin map block.',
            target: { artifact: 'code', filePath: entry.path, pin: assignment.pin },
          });
          continue;
        }
        const value = (declared[1] ?? declared[2] ?? '').trim();
        if (value !== literal) {
          add('code', {
            code: 'code_pin_mismatch',
            severity: 'error',
            domain: 'code',
            message: `${entry.path} declares ${name} = ${value} but the pin plan assigns ${assignment.pin} (${literal}).`,
            fixHint: `Set ${name} to ${literal}.`,
            target: { artifact: 'code', filePath: entry.path, pin: assignment.pin },
          });
        }
      }

      // Includes must cover every library.
      const allCode = code.files.map((file) => file.content).join('\n');
      for (const library of project.artifacts.libraries?.libraries ?? []) {
        if (library.builtIn && /^Arduino\.h$/i.test(library.import)) continue;
        const statement = includeStatement(library);
        if (!statement) continue;
        if (!allCode.includes(library.import)) {
          add('code', {
            code: 'code_missing_include',
            severity: 'warning',
            domain: 'code',
            message: `Library "${library.name}" is required but ${library.import} is never included.`,
            fixHint: `Add ${statement} to ${entry.path}.`,
            target: { artifact: 'code', filePath: entry.path, library: library.name },
          });
        }
      }
    }
  }
  finishCheck('code.firmware', 'Firmware correctness', 'code', mark, 'Firmware is structurally sound and matches the pin plan');

  /* 9. Libraries ------------------------------------------------------------ */
  mark = issues.length;
  if (project.artifacts.libraries) {
    const parsed = LibrariesArtifactSchema.safeParse(project.artifacts.libraries);
    if (!parsed.success) {
      add('libraries', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'libraries',
        message: 'libraries.json violates its schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'libraries' },
      });
    }
    const codeText = (project.artifacts.code?.files ?? []).map((file) => file.content).join('\n');
    const includePattern = /#\s*include\s*[<"]([^>"]+)[>"]/g;
    const included = new Set<string>();
    let includeMatch: RegExpExecArray | null;
    while ((includeMatch = includePattern.exec(codeText)) !== null) included.add(String(includeMatch[1] ?? '').toLowerCase());

    const listed = new Set((project.artifacts.libraries.libraries ?? []).map((library) => library.import.toLowerCase()));
    for (const header of included) {
      if (!header) continue;
      if (/^(Arduino|Wire|SPI|SoftwareSerial|Servo|BluetoothSerial|WiFi|BLEDevice|EEPROM)\.h$/i.test(header)) continue;
      if (!listed.has(header)) {
        add('libraries', {
          code: 'library_missing',
          severity: 'error',
          domain: 'libraries',
          message: `The firmware includes <${header}> but libraries.json does not list it.`,
          fixHint: `Add an entry for ${header} with its install instructions.`,
          target: { artifact: 'libraries', library: header },
        });
      }
    }
  } else {
    add('libraries', {
      code: 'empty_artifact',
      severity: 'warning',
      domain: 'libraries',
      message: 'libraries.json was not generated.',
      target: { artifact: 'libraries' },
    });
  }
  finishCheck('libraries.manifest', 'Library manifest', 'libraries', mark, 'libraries.json matches the firmware includes');

  /* 10. Diagram ------------------------------------------------------------- */
  mark = issues.length;
  const diagram: Diagram | null = project.artifacts.diagram;
  const integrity = checkDiagramIntegrity(diagram);
  for (const problem of integrity.problems) {
    add('diagram', {
      code: 'diagram_out_of_sync',
      severity: 'error',
      domain: 'diagram',
      message: problem,
      fixHint: 'Regenerate diagram.json from the current wiring graph.',
      target: { artifact: 'diagram' },
    });
  }
  if (diagram) {
    const parsed = DiagramSchema.safeParse(diagram);
    if (!parsed.success) {
      add('diagram', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'diagram',
        message: 'diagram.json violates the Wireup diagram schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'diagram' },
      });
    }
    if (diagram.revision !== project.revision) {
      add('diagram', {
        code: 'diagram_out_of_sync',
        severity: 'error',
        domain: 'diagram',
        message: `diagram.json was generated at revision ${diagram.revision} but the project is at revision ${project.revision}.`,
        fixHint: 'Re-run the diagram stage.',
        target: { artifact: 'diagram' },
      });
    }
    for (const missing of findMissingDiagramComponents(diagram, project.components, catalog)) {
      add('diagram', {
        code: 'diagram_missing_component',
        severity: 'error',
        domain: 'diagram',
        message: `Component instance "${missing}" is in the bill of materials but missing from diagram.json.`,
        fixHint: 'Regenerate the diagram.',
        target: { artifact: 'diagram', componentInstanceId: missing },
      });
    }
    for (const connection of project.wiring?.connections ?? []) {
      const present = diagram.connections.some((entry) => entry.id === connection.id);
      if (!present) {
        add('diagram', {
          code: 'diagram_missing_connection',
          severity: 'error',
          domain: 'diagram',
          message: `Wiring connection ${connection.from.instanceId}.${connection.from.pin} → ${connection.to.instanceId}.${connection.to.pin} is missing from diagram.json.`,
          fixHint: 'Regenerate the diagram from the wiring graph.',
          target: { artifact: 'diagram', connectionId: connection.id },
        });
      }
    }
  }
  finishCheck('diagram.integrity', 'diagram.json integrity', 'diagram', mark, 'diagram.json is complete and internally consistent');

  /* 11. Instructions -------------------------------------------------------- */
  mark = issues.length;
  const instructions = project.artifacts.instructions;
  if (!instructions) {
    add('instructions', {
      code: 'empty_artifact',
      severity: 'warning',
      domain: 'instructions',
      message: 'No setup instructions were generated.',
      target: { artifact: 'instructions' },
    });
  } else {
    const parsed = InstructionsArtifactSchema.safeParse(instructions);
    if (!parsed.success) {
      add('instructions', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'instructions',
        message: 'The instructions artifact violates its schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'instructions' },
      });
    }
    const requiredSections = ['overview', 'bill-of-materials', 'wiring', 'pinout', 'power', 'software-setup', 'flashing', 'usage'];
    const presentIds = new Set(instructions.sections.map((section) => section.id));
    for (const sectionId of requiredSections) {
      if (!presentIds.has(sectionId)) {
        add('instructions', {
          code: 'instructions_missing_section',
          severity: 'warning',
          domain: 'instructions',
          message: `Instructions are missing the "${sectionId}" section.`,
          fixHint: 'Re-run the instructions generator.',
          target: { artifact: 'instructions', sectionId },
        });
      }
    }
    if (instructions.billOfMaterials.length !== project.components.length) {
      add('instructions', {
        code: 'instructions_out_of_sync',
        severity: 'warning',
        domain: 'instructions',
        message: `Bill of materials lists ${instructions.billOfMaterials.length} line(s) but the project has ${project.components.length} selection(s).`,
        fixHint: 'Regenerate the instructions after the component change.',
        target: { artifact: 'instructions', sectionId: 'bill-of-materials' },
      });
    }
  }
  finishCheck('instructions.completeness', 'Instruction completeness', 'instructions', mark, 'Instructions cover every required section');

  return { checks, issues };
}

/** Group issues by the artifact they target — used to route targeted fixes. */
export function groupIssuesByArtifact(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const key = issue.target?.artifact ?? issue.domain;
    const list = groups.get(key) ?? [];
    list.push(issue);
    groups.set(key, list);
  }
  return groups;
}

export function summariseIssues(issues: ValidationIssue[]): { errors: number; warnings: number; info: number } {
  return {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    info: issues.filter((issue) => issue.severity === 'info').length,
  };
}

export type { ComponentSelection, PinAssignment };
