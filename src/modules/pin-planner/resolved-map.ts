/**
 * Resolved pin map — THE single source of truth for component ↔ MCU wiring.
 *
 * The pin planner produces `PinAssignment[]`. Everything downstream (firmware
 * prompt, code generator, diagram generator, validator, fixer) used to consume
 * those rows separately, which let each consumer form its own — occasionally
 * divergent — view of the circuit. This module freezes the plan into one
 * authoritative object:
 *
 *     pin planner
 *         ↓
 *   ResolvedPinMap ──────┬──────────────┬────────────────┐
 *         │              ↓              ↓                ↓
 *         │        firmware prompt  generateCode   generateDiagram
 *         │        (PIN_* law)     (audit + gate)  (pin bindings)
 *         ↓
 *     validator: firmware pins == map == diagram bindings
 *
 * `byTarget` is the machine-readable core (e.g. `{ "pushbutton-6mm-1:1": "D4" }`):
 * one lookup table every consumer reads, so no stage ever re-decides a pin.
 */

import type { ConnectionProtocol, PinAssignment, SignalType } from '@/types/wiring';

import { constantName, pinLiteral } from '@/modules/code-generator/templates';

/** One row of the map: a peripheral pin bound to exactly one MCU pin. */
export interface ResolvedPinBinding {
  /** Stable lookup key, `<instanceId>:<targetPin>` (e.g. `soil-moisture-sensor-1:AO`). */
  key: string;
  instanceId: string;
  componentId: string;
  /** Pin on the peripheral (e.g. `SDA`, `IN1`, `1`). */
  targetPin: string;
  /** Canonical pin name on the MCU (e.g. `D4`, `A4`, `GPIO25`). */
  mcuPin: string;
  /** Board pin number when the profile provides one. */
  mcuPinNumber?: number;
  /** The firmware constant every consumer agrees on (e.g. `PIN_LED_5MM_1_A`). */
  constant: string;
  /** The C++ literal the constant holds (e.g. `7`, `A4`, `25`). */
  cValue: string;
  direction: 'input' | 'output';
  signal: SignalType;
  protocol: ConnectionProtocol;
  purpose: string;
  required: boolean;
  source: PinAssignment['source'];
  /** Shared-bus pins (I2C/SPI) may legitimately appear in several bindings. */
  busShared: boolean;
}

export interface ResolvedPinMap {
  controller: {
    componentId: string;
    instanceId: string;
    name: string;
  };
  /** The planner rows this map was frozen from (kept for legacy consumers). */
  assignments: readonly PinAssignment[];
  bindings: readonly ResolvedPinBinding[];
  /** `instanceId:TARGETPIN` → canonical MCU pin name (`D4`). */
  byTarget: Readonly<Record<string, string>>;
  /** `instanceId:TARGETPIN` → firmware constant name (`PIN_PUSHBUTTON_6MM_1_1`). */
  constantByTarget: Readonly<Record<string, string>>;
  /** Firmware constant name → canonical MCU pin name. */
  byConstant: Readonly<Record<string, string>>;
}

export interface ControllerRef {
  componentId?: string;
  instanceId?: string;
  name?: string;
}

/** Case-insensitive canonical key for one peripheral pin. */
export function pinMapKey(instanceId: string, targetPin: string): string {
  return `${instanceId}:${targetPin}`.toUpperCase();
}

/**
 * Freeze the pin plan into the authoritative resolved map.
 *
 * The controller identity is taken from the assignments themselves when it is
 * not supplied explicitly, so the map can be rebuilt from persisted state
 * (fixer refreshers, validation) without re-running the planner.
 */
export function buildResolvedPinMap(input: { assignments: PinAssignment[]; controller?: ControllerRef }): ResolvedPinMap {
  const { assignments } = input;
  const first = assignments[0];

  const controller = {
    componentId: input.controller?.componentId ?? first?.mcuComponentId ?? '',
    instanceId: input.controller?.instanceId ?? first?.mcuInstanceId ?? '',
    name: input.controller?.name ?? first?.mcuComponentId ?? 'the controller',
  };

  const bindings: ResolvedPinBinding[] = assignments.map((assignment) => ({
    key: pinMapKey(assignment.targetInstanceId, assignment.targetPin),
    instanceId: assignment.targetInstanceId,
    componentId: assignment.targetComponentId,
    targetPin: assignment.targetPin,
    mcuPin: assignment.pin,
    ...(assignment.pinNumber !== undefined ? { mcuPinNumber: assignment.pinNumber } : {}),
    constant: constantName(assignment),
    cValue: pinLiteral(assignment),
    direction: assignment.direction,
    signal: assignment.signal,
    protocol: assignment.protocol,
    purpose: assignment.purpose,
    required: assignment.required,
    source: assignment.source,
    busShared: assignment.protocol === 'i2c' || assignment.protocol === 'spi',
  }));

  const byTarget: Record<string, string> = {};
  const constantByTarget: Record<string, string> = {};
  const byConstant: Record<string, string> = {};
  for (const binding of bindings) {
    byTarget[binding.key] = binding.mcuPin;
    constantByTarget[binding.key] = binding.constant;
    byConstant[binding.constant] = binding.mcuPin;
  }

  return { controller, assignments, bindings, byTarget, constantByTarget, byConstant };
}

/** Look up the binding for one peripheral pin (case-insensitive on both parts). */
export function bindingFor(map: ResolvedPinMap, instanceId: string, targetPin: string): ResolvedPinBinding | undefined {
  const key = pinMapKey(instanceId, targetPin);
  return map.bindings.find((binding) => binding.key === key);
}

/**
 * Every literal a firmware author might type that means "this MCU pin":
 * the C++ value (`7`, `A4`), the canonical board name (`D7`, `GPIO25`), and
 * the raw pin number (`18` for A4). `analogRead()` additionally accepts the
 * ADC channel index (`4` for A4) — modelled by `analogChannelOf` below.
 */
export function literalAliases(binding: ResolvedPinBinding): Set<string> {
  const aliases = new Set<string>();
  aliases.add(binding.cValue.toUpperCase());
  aliases.add(binding.mcuPin.toUpperCase());
  if (binding.mcuPinNumber !== undefined) aliases.add(String(binding.mcuPinNumber));
  return aliases;
}

/** AVR-style shorthand: `analogRead(0)` addresses channel 0, i.e. pin A0. */
export function analogChannelOf(binding: ResolvedPinBinding): string | undefined {
  const match = /^A(\d{1,2})$/i.exec(binding.cValue);
  return match?.[1];
}

/**
 * Resolve a literal token found in firmware (`2`, `A4`, `D4`, `GPIO25`) to
 * candidate bindings. Direct `cValue` hits always win; aliases are only used
 * when nothing matches directly so `analogRead(4)` on a board whose D4 is
 * also assigned does not flip meaning.
 */
export function lookupPinLiteral(map: ResolvedPinMap, token: string, options: { analogContext?: boolean } = {}): ResolvedPinBinding[] {
  const upper = token.trim().toUpperCase();
  if (upper.length === 0) return [];

  const direct = map.bindings.filter((binding) => binding.cValue.toUpperCase() === upper);
  if (direct.length > 0) return direct;

  const aliased = map.bindings.filter((binding) => {
    if (literalAliases(binding).has(upper)) return true;
    if (options.analogContext === true && analogChannelOf(binding) === upper) return true;
    return false;
  });
  return aliased;
}

/**
 * Format the map for the firmware prompt. This block is the *only* pin
 * information the firmware-writing model is given, so it is formatted as an
 * explicit law rather than a suggestion.
 */
export function formatResolvedPinMapForPrompt(map: ResolvedPinMap): string {
  if (map.bindings.length === 0) {
    return '(no MCU pin assignments — this build has no pins to drive; write firmware accordingly)';
  }

  const lines: string[] = [];
  lines.push(
    `controller: ${map.controller.name} (${map.controller.componentId}) — instance ${map.controller.instanceId || 'mcu-1'}`,
  );
  lines.push('');
  lines.push('target (instance:pin)        → MCU pin    constant to use in firmware');
  lines.push('─'.repeat(78));

  const rows = [...map.bindings].sort((a, b) => a.key.localeCompare(b.key));
  for (const binding of rows) {
    const target = `${binding.instanceId}:${binding.targetPin}`;
    const annotations: string[] = [`MCU ${binding.direction}`, binding.protocol];
    if (binding.busShared) annotations.push('shared bus — hardware library owns it, never pinMode/digitalWrite it');
    lines.push(
      `${target.padEnd(29)} → ${binding.mcuPin.padEnd(10)}  ${binding.constant} = ${binding.cValue}   (${annotations.join(', ')})`,
    );
  }

  lines.push('');
  lines.push('JSON form ("target → mcu pin"):');
  const json: Record<string, string> = {};
  for (const binding of rows) json[`${binding.instanceId}:${binding.targetPin}`] = binding.mcuPin;
  lines.push(JSON.stringify({ controller: map.controller.componentId, pins: json }, null, 2));
  return lines.join('\n');
}
