/**
 * Wiring conflict detection.
 *
 * Runs against the structured connection graph, the pin assignments and the
 * catalog so that obvious electrical mistakes are caught before validation:
 * duplicated GPIO use, motors on MCU pins, missing grounds, voltage windows,
 * output-to-output clashes, dangling references and floating required pins.
 */

import type { ComponentDefinition, ComponentInstance, ComponentSelection, PowerBudget } from '@/types/component';
import type { PinAssignment, WiringConflict, WiringConnection, WiringConflictCode } from '@/types/wiring';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';
import { createId } from '@/lib/validation/ids';

import { findPinConflicts } from '@/modules/pin-planner';

export interface ConflictInput {
  connections: WiringConnection[];
  assignments: PinAssignment[];
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  power?: PowerBudget;
  profile?: McuProfile;
  controllerInstanceId?: string;
}

function conflict(
  code: WiringConflictCode,
  severity: 'error' | 'warning',
  message: string,
  fields: { instanceIds?: string[]; pins?: string[]; connectionIds?: string[]; suggestion?: string } = {},
): WiringConflict {
  return {
    id: createId('wcf'),
    code,
    severity,
    message,
    instanceIds: fields.instanceIds ?? [],
    pins: fields.pins ?? [],
    connectionIds: fields.connectionIds ?? [],
    ...(fields.suggestion ? { suggestion: fields.suggestion } : {}),
  };
}

export interface InstanceIndexEntry {
  instanceId: string;
  componentId: string;
  selection: ComponentSelection;
  instance: ComponentInstance;
  definition?: ComponentDefinition;
}

export function indexInstances(selections: ComponentSelection[], catalog: ComponentDefinition[]): Map<string, InstanceIndexEntry> {
  const index = new Map<string, InstanceIndexEntry>();
  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    for (const instance of selection.instances) {
      index.set(instance.instanceId, { instanceId: instance.instanceId, componentId: selection.componentId, selection, instance, ...(definition ? { definition } : {}) });
    }
  }
  return index;
}

function pinExists(definition: ComponentDefinition | undefined, pinName: string): boolean {
  if (!definition) return false;
  const needle = pinName.toLowerCase();
  return definition.pins.some((entry) => entry.name.toLowerCase() === needle || (entry.aliases ?? []).some((alias) => alias.toLowerCase() === needle));
}

export function resolvePinName(definition: ComponentDefinition | undefined, pinName: string): string | undefined {
  if (!definition) return undefined;
  const needle = pinName.toLowerCase().trim();
  const exact = definition.pins.find((entry) => entry.name.toLowerCase() === needle);
  if (exact) return exact.name;
  const byAlias = definition.pins.find((entry) => (entry.aliases ?? []).some((alias) => alias.toLowerCase() === needle));
  return byAlias?.name;
}

/** Full electrical sanity pass. Returns conflicts ordered by severity. */
export function detectConflicts(input: ConflictInput): WiringConflict[] {
  const { connections, assignments, selections, catalog, power, profile, controllerInstanceId } = input;
  const conflicts: WiringConflict[] = [];
  const index = indexInstances(selections, catalog);

  const controllerEntry = controllerInstanceId ? index.get(controllerInstanceId) : undefined;
  const controllerDefinition = controllerEntry?.definition;

  /* --- Dangling references ------------------------------------------------ */
  for (const connection of connections) {
    for (const endpoint of [connection.from, connection.to]) {
      if (!index.has(endpoint.instanceId)) {
        conflicts.push(
          conflict('dangling_reference', 'error', `Connection ${connection.id} references unknown instance "${endpoint.instanceId}".`, {
            connectionIds: [connection.id],
            instanceIds: [endpoint.instanceId],
            suggestion: 'Remove the connection or add the missing component to the bill of materials.',
          }),
        );
        continue;
      }
      const entry = index.get(endpoint.instanceId);
      if (!pinExists(entry?.definition, endpoint.pin)) {
        conflicts.push(
          conflict('unknown_pin', 'error', `Connection ${connection.id} references pin "${endpoint.pin}" which does not exist on ${entry?.definition?.name ?? endpoint.componentId}.`, {
            connectionIds: [connection.id],
            instanceIds: [endpoint.instanceId],
            pins: [endpoint.pin],
            suggestion: `Valid pins are: ${entry?.definition?.pins.map((pin) => pin.name).join(', ') ?? 'unknown'}.`,
          }),
        );
      }
    }
  }

  /* --- Duplicate connections ---------------------------------------------- */
  const seen = new Map<string, WiringConnection>();
  for (const connection of connections) {
    const key = [
      `${connection.from.instanceId}.${connection.from.pin}`,
      `${connection.to.instanceId}.${connection.to.pin}`,
    ]
      .sort()
      .join(' <-> ');
    const existing = seen.get(key);
    if (existing) {
      conflicts.push(
        conflict('duplicate_connection', 'warning', `Duplicate connection between ${connection.from.instanceId}.${connection.from.pin} and ${connection.to.instanceId}.${connection.to.pin} (ids ${existing.id} and ${connection.id}).`, {
          connectionIds: [existing.id, connection.id],
          instanceIds: [connection.from.instanceId, connection.to.instanceId],
          pins: [connection.from.pin, connection.to.pin],
          suggestion: 'Remove the redundant wire.',
        }),
      );
    } else {
      seen.set(key, connection);
    }
  }

  /* --- GPIO conflicts ------------------------------------------------------ */
  for (const pinConflict of findPinConflicts(assignments)) {
    conflicts.push(
      conflict(
        'gpio_conflict',
        'error',
        `${pinConflict.pin} is assigned to ${pinConflict.assignments.length} different signals: ${pinConflict.assignments
          .map((assignment) => `${assignment.targetInstanceId}.${assignment.targetPin}`)
          .join(', ')}.`,
        {
          pins: [pinConflict.pin],
          instanceIds: pinConflict.assignments.map((assignment) => assignment.targetInstanceId),
          suggestion: 'Move one of the signals to a free pin that supports the same capability.',
        },
      ),
    );
  }

  /* --- Profile level checks ------------------------------------------------ */
  if (profile) {
    for (const assignment of assignments) {
      if (controllerInstanceId && assignment.mcuInstanceId !== controllerInstanceId) continue;
      const reserved = profile.reserved.find((entry) => entry.pin === assignment.pin);
      if (reserved) {
        conflicts.push(
          conflict('reserved_pin_used', 'error', `${assignment.pin} is reserved (${reserved.reason}) but is assigned to ${assignment.targetInstanceId}.${assignment.targetPin}.`, {
            pins: [assignment.pin],
            instanceIds: [assignment.targetInstanceId],
            suggestion: 'Reassign to a usable GPIO.',
          }),
        );
      }
      const spec = profile.pins.find((entry) => entry.name === assignment.pin);
      if (!spec) {
        conflicts.push(
          conflict('unknown_pin', 'error', `${assignment.pin} is not a pin of ${profile.name} (assigned to ${assignment.targetInstanceId}.${assignment.targetPin}).`, {
            pins: [assignment.pin],
            instanceIds: [assignment.targetInstanceId],
          }),
        );
        continue;
      }
      if (assignment.direction === 'output' && spec.capabilities.includes('input-only')) {
        conflicts.push(
          conflict('input_only_pin_driven', 'error', `${assignment.pin} on ${profile.name} is input-only but is driven as an output for ${assignment.targetInstanceId}.${assignment.targetPin}.`, {
            pins: [assignment.pin],
            instanceIds: [assignment.targetInstanceId],
            suggestion: 'Use an output-capable GPIO; input-only pins can only read signals.',
          }),
        );
      }
      if (assignment.protocol === 'adc' && !spec.capabilities.includes('adc')) {
        conflicts.push(
          conflict('capability_mismatch', 'error', `${assignment.pin} has no ADC but ${assignment.targetInstanceId}.${assignment.targetPin} needs an analog input.`, {
            pins: [assignment.pin],
            instanceIds: [assignment.targetInstanceId],
            suggestion: `Use one of: ${profile.pins.filter((entry) => entry.capabilities.includes('adc')).map((entry) => entry.name).join(', ')}.`,
          }),
        );
      }
      if ((assignment.signal === 'pwm' || assignment.protocol === 'pwm') && !spec.capabilities.includes('pwm')) {
        conflicts.push(
          conflict('capability_mismatch', 'warning', `${assignment.pin} is not PWM-capable on ${profile.name} but ${assignment.targetInstanceId}.${assignment.targetPin} requests PWM.`, {
            pins: [assignment.pin],
            instanceIds: [assignment.targetInstanceId],
            suggestion: `PWM-capable pins: ${profile.pins.filter((entry) => entry.capabilities.includes('pwm')).map((entry) => entry.name).join(', ')}.`,
          }),
        );
      }
    }
  }

  /* --- Motor directly on an MCU pin --------------------------------------- */
  const mcuInstanceIds = new Set(
    selections.filter((selection) => selection.category === 'microcontroller').flatMap((selection) => selection.instances.map((instance) => instance.instanceId)),
  );
  for (const connection of connections) {
    const fromIsMcu = mcuInstanceIds.has(connection.from.instanceId);
    const toIsMcu = mcuInstanceIds.has(connection.to.instanceId);
    if (!fromIsMcu && !toIsMcu) continue;

    const otherId = fromIsMcu ? connection.to.instanceId : connection.from.instanceId;
    const other = index.get(otherId);
    if (other?.definition?.category !== 'motor') continue;
    if (other.definition.motorRequirements?.motorType === 'servo') continue; // servos have an internal driver

    const otherPin = fromIsMcu ? connection.to.pin : connection.from.pin;
    const motorPinType = other.definition.pins.find((entry) => entry.name.toLowerCase() === otherPin.toLowerCase())?.type;
    if (motorPinType === 'motor' || motorPinType === 'power' || motorPinType === 'ground') {
      conflicts.push(
        conflict('motor_on_mcu_pin', 'error', `${other.definition.name} (${otherId}) terminal ${otherPin} is connected straight to a microcontroller pin. Stall current will destroy the GPIO.`, {
          instanceIds: [otherId, fromIsMcu ? connection.from.instanceId : connection.to.instanceId],
          connectionIds: [connection.id],
          pins: [otherPin],
          suggestion: 'Insert an H-bridge driver (L298N, L293D or TB6612FNG) between the MCU and the motor.',
        }),
      );
    }
  }

  /* --- Missing ground / power --------------------------------------------- */
  const groundedInstances = new Set<string>();
  const poweredInstances = new Set<string>();
  const groundSources = new Set<string>();

  for (const connection of connections) {
    if (connection.kind === 'ground') {
      groundedInstances.add(connection.from.instanceId);
      groundedInstances.add(connection.to.instanceId);
    }
    if (connection.kind === 'power') {
      poweredInstances.add(connection.from.instanceId);
      poweredInstances.add(connection.to.instanceId);
      const fromEntry = index.get(connection.from.instanceId);
      if (fromEntry?.definition?.category === 'power' || fromEntry?.definition?.powerSourceRequirements) {
        groundSources.add(connection.from.instanceId);
      }
    }
    // Motor outputs energise the motor, so those count as powered too.
    if (connection.signal === 'motor_drive') poweredInstances.add(connection.to.instanceId);
  }

  for (const entry of index.values()) {
    const definition = entry.definition;
    if (!definition) continue;
    if (definition.metadata.electrical === false || definition.metadata.integrated === true) continue;
    if (definition.category === 'power') continue;
    if (definition.category === 'passive') continue;
    if (definition.category === 'prototyping') continue;

    const hasGroundPin = definition.groundPins.length > 0;
    const hasPowerPin = definition.powerPins.length > 0;
    const drivenByDriver =
      definition.category === 'motor' &&
      connections.some((connection) => connection.to.instanceId === entry.instanceId && connection.signal === 'motor_drive');

    if (hasGroundPin && !groundedInstances.has(entry.instanceId)) {
      conflicts.push(
        conflict('missing_ground', 'error', `${definition.name} (${entry.instanceId}) has no ground connection. Without a common ground the logic levels are undefined and the circuit will not work reliably.`, {
          instanceIds: [entry.instanceId],
          pins: definition.groundPins,
          suggestion: `Connect ${definition.groundPins[0]} to the common ground (MCU GND).`,
        }),
      );
    }

    if (hasPowerPin && !poweredInstances.has(entry.instanceId) && !drivenByDriver) {
      conflicts.push(
        conflict('missing_power', 'error', `${definition.name} (${entry.instanceId}) has no supply connection on ${definition.powerPins.join('/')}.`, {
          instanceIds: [entry.instanceId],
          pins: definition.powerPins,
          suggestion: `Connect ${definition.powerPins[0]} to the appropriate rail (${definition.voltage ?? 'rated'} V).`,
        }),
      );
    }

    // Floating required pins.
    for (const definitionPin of definition.pins) {
      if (!definitionPin.required) continue;
      if (definitionPin.type === 'other') continue;
      const connected = connections.some(
        (connection) =>
          (connection.from.instanceId === entry.instanceId && connection.from.pin === definitionPin.name) ||
          (connection.to.instanceId === entry.instanceId && connection.to.pin === definitionPin.name),
      );
      if (!connected) {
        conflicts.push(
          conflict('floating_required_pin', 'warning', `${definition.name} (${entry.instanceId}) pin ${definitionPin.name} is required but left unconnected.`, {
            instanceIds: [entry.instanceId],
            pins: [definitionPin.name],
            suggestion: definitionPin.signal ? `Its purpose is: ${definitionPin.signal}.` : 'Connect it or document why it is intentionally left open.',
          }),
        );
      }
    }
  }

  if (groundSources.size === 0 && index.size > 1) {
    const hasAnyGround = groundedInstances.size > 0;
    if (!hasAnyGround) {
      conflicts.push(
        conflict('missing_ground', 'error', 'No common ground net exists in the wiring graph.', {
          instanceIds: [...index.keys()],
          suggestion: 'Tie every powered component ground to the MCU ground and the supply negative.',
        }),
      );
    }
  }

  /* --- Output-to-output ---------------------------------------------------- */
  for (const connection of connections) {
    if (connection.kind !== 'signal') continue;
    const fromEntry = index.get(connection.from.instanceId);
    const toEntry = index.get(connection.to.instanceId);
    const fromPin = fromEntry?.definition?.pins.find((entry) => entry.name.toLowerCase() === connection.from.pin.toLowerCase());
    const toPin = toEntry?.definition?.pins.find((entry) => entry.name.toLowerCase() === connection.to.pin.toLowerCase());
    if (!fromPin || !toPin) continue;
    if (fromPin.direction === 'output' && toPin.direction === 'output') {
      conflicts.push(
        conflict('output_to_output', 'error', `${connection.from.instanceId}.${connection.from.pin} (output) is wired to ${connection.to.instanceId}.${connection.to.pin} (output). Two drivers on one node will fight and can be destroyed.`, {
          instanceIds: [connection.from.instanceId, connection.to.instanceId],
          pins: [connection.from.pin, connection.to.pin],
          connectionIds: [connection.id],
          suggestion: 'One side must be an input, or the signal must be buffered.',
        }),
      );
    }
  }

  /* --- Voltage relationships ---------------------------------------------- */
  for (const connection of connections) {
    if (connection.kind !== 'power' || connection.voltage === undefined) continue;
    const loadEntry = index.get(connection.to.instanceId);
    const load = loadEntry?.definition;
    if (!load) continue;

    const motor = load.motorRequirements;
    const min = motor?.supplyVoltageMin ?? load.minVoltage;
    const max = motor?.supplyVoltageMax ?? load.maxVoltage;

    if (min !== undefined && connection.voltage < min) {
      conflicts.push(
        conflict('invalid_voltage', 'error', `${load.name} (${connection.to.instanceId}) is fed ${connection.voltage} V but needs at least ${min} V.`, {
          instanceIds: [connection.to.instanceId],
          connectionIds: [connection.id],
          pins: [connection.to.pin],
          suggestion: 'Use a higher supply or remove the regulator drop on this rail.',
        }),
      );
    }
    if (max !== undefined && connection.voltage > max) {
      conflicts.push(
        conflict('invalid_voltage', 'error', `${load.name} (${connection.to.instanceId}) is fed ${connection.voltage} V but is rated for at most ${max} V.`, {
          instanceIds: [connection.to.instanceId],
          connectionIds: [connection.id],
          pins: [connection.to.pin],
          suggestion: 'Regulate the rail down or choose a part rated for the supply voltage.',
        }),
      );
    }
  }

  /* --- Declared incompatibilities ----------------------------------------- */
  const connectedPairs = new Map<string, { a: string; b: string; direct: boolean; connectionIds: string[] }>();
  for (const connection of connections) {
    if (connection.from.instanceId === connection.to.instanceId) continue;
    const key = [connection.from.componentId, connection.to.componentId].sort().join('|');
    const entry = connectedPairs.get(key) ?? { a: connection.from.componentId, b: connection.to.componentId, direct: true, connectionIds: [] };
    entry.connectionIds.push(connection.id);
    connectedPairs.set(key, entry);
  }

  for (const pair of connectedPairs.values()) {
    const definitionA = catalog.find((component) => component.id === pair.a);
    const definitionB = catalog.find((component) => component.id === pair.b);
    const declared =
      definitionA?.incompatibleComponents?.includes(pair.b) === true || definitionB?.incompatibleComponents?.includes(pair.a) === true;
    if (!declared) continue;

    const hasDriver = selections.some((selection) => selection.category === 'motor_driver');
    const signalDirect = connections.some(
      (connection) =>
        connection.kind === 'signal' &&
        ((connection.from.componentId === pair.a && connection.to.componentId === pair.b) ||
          (connection.from.componentId === pair.b && connection.to.componentId === pair.a)),
    );

    if (signalDirect && !hasDriver) {
      conflicts.push(
        conflict('incompatible_components', 'error', `${definitionA?.name ?? pair.a} and ${definitionB?.name ?? pair.b} are declared incompatible but are directly connected.`, {
          instanceIds: [],
          connectionIds: pair.connectionIds,
          suggestion: String(definitionA?.metadata.incompatibleReason ?? definitionB?.metadata.incompatibleReason ?? 'Insert the appropriate interface component.'),
        }),
      );
    }
  }

  /* --- Power budget -------------------------------------------------------- */
  if (power && !power.adequate) {
    conflicts.push(
      conflict('invalid_voltage', 'warning', `Power budget check failed: ${power.notes[power.notes.length - 1] ?? 'the supply cannot serve the calculated load.'}`, {
        instanceIds: power.supplyInstanceId ? [power.supplyInstanceId] : [],
        suggestion: 'Increase supply capability, add a regulator with headroom, or stagger the loads.',
      }),
    );
  }

  /* --- Controller sanity --------------------------------------------------- */
  if (!controllerDefinition) {
    conflicts.push(
      conflict('incompatible_components', 'error', 'No microcontroller is present in the wiring graph, so no firmware can run.', {
        suggestion: 'Add a microcontroller from the component database.',
      }),
    );
  }

  return conflicts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
