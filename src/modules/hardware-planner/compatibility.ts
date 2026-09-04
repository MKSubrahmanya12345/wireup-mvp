/**
 * Compatibility analysis between the selected parts.
 *
 * Checks logic levels, drive current, catalog-declared incompatibilities and
 * whether a mitigating part (driver, regulator, level shifter) is present.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { CompatibilityCheck } from '@/types/project';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import { isElectricallyActive, isPowerSource } from './power';

export interface CompatibilityInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  controller: ComponentSelection | null;
  profile?: McuProfile;
}

export interface CompatibilityResult {
  checks: CompatibilityCheck[];
  risks: string[];
}

function definitionFor(selection: ComponentSelection, catalog: ComponentDefinition[]): ComponentDefinition | undefined {
  return catalog.find((component) => component.id === selection.componentId);
}

function partLogicVoltage(definition: ComponentDefinition): number | undefined {
  const explicit = definition.metadata.logicVoltage;
  if (typeof explicit === 'number') return explicit;
  return definition.voltage;
}

function hasMitigation(selections: ComponentSelection[], catalog: ComponentDefinition[], kind: 'driver' | 'level_shifter' | 'regulator'): boolean {
  return selections.some((selection) => {
    const definition = definitionFor(selection, catalog);
    if (!definition) return false;
    if (kind === 'driver') return definition.category === 'motor_driver';
    if (kind === 'level_shifter') return /level\s*shifter|level\s*converter|translator/i.test(definition.name);
    return /regulator|buck|converter/i.test(definition.name) && definition.category === 'power';
  });
}

export function checkCompatibility(input: CompatibilityInput): CompatibilityResult {
  const { selections, catalog, controller, profile } = input;
  const checks: CompatibilityCheck[] = [];
  const risks: string[] = [];

  const controllerDefinition = controller ? definitionFor(controller, catalog) : undefined;
  const mcuLogic = profile?.logicVoltage ?? controllerDefinition?.voltage;

  for (const selection of selections) {
    const definition = definitionFor(selection, catalog);
    if (!definition) continue;
    if (!isElectricallyActive(definition)) continue;
    if (definition.category === 'microcontroller') continue;
    if (isPowerSource(definition)) continue;
    if (!controller) continue;

    const controllerId = controller.componentId;
    const pair = `${definition.id}<->${controllerId}`;

    // 1. Catalog-declared incompatibilities.
    const declaredIncompatible = definition.incompatibleComponents?.includes(controllerId) === true;
    if (declaredIncompatible) {
      const mitigated = hasMitigation(selections, catalog, 'driver');
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: mitigated,
        reason: mitigated
          ? `${definition.name} is declared incompatible with ${controller.name} directly, but a motor driver is in the bill of materials, so the MCU never drives the load itself.`
          : `${definition.name} is declared incompatible with ${controller.name}: ${String(definition.metadata.incompatibleReason ?? 'the load exceeds the MCU GPIO rating')}. Add a driver between them.`,
      });
      if (!mitigated) risks.push(`${definition.name} must not be driven from ${controller.name} GPIO — add an appropriate driver.`);
      continue;
    }

    // 2. Drive current.
    const maxCurrent = definition.currentRequirements?.maxMa;
    const directlyDriven = !definition.motorRequirements?.requiresDriver && definition.category !== 'motor';
    if (
      maxCurrent !== undefined &&
      profile &&
      directlyDriven &&
      maxCurrent > profile.maxGpioSinkMa &&
      definition.metadata.active !== true &&
      !/relay|module/i.test(definition.name)
    ) {
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: false,
        reason: `${definition.name} can draw ${maxCurrent} mA, above the ${profile.maxGpioSinkMa} mA absolute GPIO limit of ${controller.name}. Drive it through a transistor, MOSFET or dedicated driver.`,
      });
      risks.push(`${definition.name} exceeds the ${controller.name} GPIO current limit — a driver stage is required.`);
      continue;
    }

    // 3. Logic level.
    const partLogic = partLogicVoltage(definition);
    if (mcuLogic !== undefined && partLogic !== undefined && Math.abs(partLogic - mcuLogic) > 0.4) {
      const shifterPresent = hasMitigation(selections, catalog, 'level_shifter');
      const tolerant = definition.metadata.fiveVoltTolerantPins === true;
      const dividerHint = definition.metadata.levelShiftRequiredWith5vMcu === true || definition.metadata.levelShiftFrom3v3 === true;
      const compatible = shifterPresent || tolerant || partLogic > mcuLogic;

      checks.push({
        a: definition.id,
        b: controllerId,
        compatible,
        reason:
          partLogic > mcuLogic
            ? `${definition.name} runs at ${partLogic} V logic while ${controller.name} uses ${mcuLogic} V. Its outputs into the MCU need a divider or level shifter${shifterPresent ? ' — one is in the bill of materials' : ''}.`
            : `${definition.name} expects ${partLogic} V logic but ${controller.name} drives ${mcuLogic} V${
                shifterPresent ? '; a level shifter is included.' : '. Add a level shifter or series divider on the MCU-driven line.'
              }`,
      });

      if (!compatible) {
        risks.push(`Logic level mismatch between ${definition.name} (${partLogic} V) and ${controller.name} (${mcuLogic} V) — add level shifting.`);
      } else if (dividerHint && !shifterPresent) {
        risks.push(`${definition.name} on ${controller.name}: verify the interface voltage on shared lines even though the supply range overlaps.`);
      }
      continue;
    }

    // 4. Protocol availability.
    const protocols = definition.communicationProtocols ?? [];
    if (protocols.includes('i2c') && profile) {
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: true,
        reason: `I2C device on ${controller.name}: connect SDA to ${profile.i2c.sda} and SCL to ${profile.i2c.scl}. Share the bus with other I2C devices using distinct addresses.`,
      });
      continue;
    }
    if (protocols.includes('uart') && profile) {
      const freeUart = profile.uarts.find((uart) => uart.recommended);
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: true,
        reason: freeUart
          ? `UART device on ${controller.name}: use ${freeUart.id} (TX=${freeUart.tx}, RX=${freeUart.rx}) and cross-connect TX to RX.`
          : `UART device on ${controller.name}: the only hardware UART is shared with the USB serial bridge — use a software/emulated UART or remap pins.`,
      });
      continue;
    }

    checks.push({
      a: definition.id,
      b: controllerId,
      compatible: true,
      reason: `${definition.name} interfaces with ${controller.name} over standard ${protocols.length > 0 ? protocols.join('/') : 'GPIO'} lines at compatible levels.`,
    });
    void pair;
  }

  // 5. Part-to-part incompatibilities declared in the catalog.
  for (const left of selections) {
    const leftDefinition = definitionFor(left, catalog);
    if (!leftDefinition?.incompatibleComponents) continue;
    for (const right of selections) {
      if (right.componentId === left.componentId) continue;
      if (!leftDefinition.incompatibleComponents.includes(right.componentId)) continue;
      const mitigated = hasMitigation(selections, catalog, 'driver');
      checks.push({
        a: leftDefinition.id,
        b: right.componentId,
        compatible: mitigated,
        reason: mitigated
          ? `${leftDefinition.name} and ${right.name} are declared incompatible when directly connected; the driver in the bill of materials isolates them.`
          : `${leftDefinition.name} must not be connected directly to ${right.name}: ${String(leftDefinition.metadata.incompatibleReason ?? 'electrical ratings conflict')}.`,
      });
    }
  }

  if (!controller) {
    risks.push('No microcontroller was selected — the project has nothing to execute the firmware.');
  }

  return { checks, risks: [...new Set(risks)] };
}
