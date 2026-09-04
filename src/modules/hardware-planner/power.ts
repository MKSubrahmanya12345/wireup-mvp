/**
 * Power planning: rail analysis, supply selection and budget adequacy.
 *
 * Everything here is derived from catalog data — no invented numbers. Where a
 * value is unknown it stays unknown and the notes say so.
 */

import type { ComponentDefinition, ComponentSelection, PowerBudget, PowerRail } from '@/types/component';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

export interface PowerPlanningInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  controller: ComponentSelection | null;
  profile?: McuProfile;
}

/** Components that are electrically inert (breadboard, jumper wires) or integrated (ESP32 radio). */
export function isElectricallyActive(definition: ComponentDefinition | undefined): boolean {
  if (!definition) return false;
  if (definition.metadata.electrical === false) return false;
  if (definition.metadata.integrated === true) return false;
  if (definition.category === 'prototyping') return false;
  return true;
}

export function isPowerSource(definition: ComponentDefinition | undefined): boolean {
  if (!definition) return false;
  return definition.category === 'power' && definition.powerSourceRequirements?.outputVoltage !== undefined;
}

function definitionFor(selection: ComponentSelection, catalog: ComponentDefinition[]): ComponentDefinition | undefined {
  return catalog.find((component) => component.id === selection.componentId);
}

export function selectSupply(
  selections: ComponentSelection[],
  catalog: ComponentDefinition[],
): ComponentSelection | null {
  const sources = selections.filter((selection) => isPowerSource(definitionFor(selection, catalog)));
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0] ?? null;

  // Prefer the source that can deliver the most peak current, then the
  // widest voltage range (motor loads need headroom).
  return (
    sources.sort((a, b) => {
      const defA = definitionFor(a, catalog);
      const defB = definitionFor(b, catalog);
      const currentA = defA?.powerSourceRequirements?.maxCurrentMa ?? defA?.currentRequirements?.maxMa ?? 0;
      const currentB = defB?.powerSourceRequirements?.maxCurrentMa ?? defB?.currentRequirements?.maxMa ?? 0;
      if (currentA !== currentB) return currentB - currentA;
      return (defB?.powerSourceRequirements?.outputVoltage ?? 0) - (defA?.powerSourceRequirements?.outputVoltage ?? 0);
    })[0] ?? null
  );
}

interface LoadTotals {
  typicalMa: number;
  peakMa: number;
  loads: string[];
}

function sumLoads(
  selections: ComponentSelection[],
  catalog: ComponentDefinition[],
  filter: (definition: ComponentDefinition, selection: ComponentSelection) => boolean,
  excludeInstanceId?: string,
): LoadTotals {
  let typicalMa = 0;
  let peakMa = 0;
  const loads: string[] = [];

  for (const selection of selections) {
    const definition = definitionFor(selection, catalog);
    if (!definition || !isElectricallyActive(definition)) continue;
    if (!filter(definition, selection)) continue;

    for (const instance of selection.instances) {
      if (excludeInstanceId && instance.instanceId === excludeInstanceId) continue;
      const typical = definition.currentRequirements?.typicalMa;
      const max = definition.currentRequirements?.maxMa;
      if (typeof typical === 'number') typicalMa += typical;
      if (typeof max === 'number') peakMa += max;
      else if (typeof typical === 'number') peakMa += typical * 2;
      loads.push(`${instance.label ?? instance.name} (${instance.instanceId})`);
    }
  }

  return { typicalMa: Math.round(typicalMa), peakMa: Math.round(peakMa), loads };
}

export function computePowerBudget(input: PowerPlanningInput): PowerBudget {
  const { selections, catalog, controller, profile } = input;
  const notes: string[] = [];

  const supplySelection = selectSupply(selections, catalog);
  const supplyDefinition = supplySelection ? definitionFor(supplySelection, catalog) : undefined;
  const supplyVoltage = supplyDefinition?.powerSourceRequirements?.outputVoltage ?? supplyDefinition?.voltage;
  const supplyMaxCurrent =
    supplyDefinition?.powerSourceRequirements?.maxCurrentMa ?? supplyDefinition?.currentRequirements?.maxMa;

  const mcuLogic = profile?.logicVoltage;
  const logicVoltage = mcuLogic;

  const rails: PowerRail[] = [];

  // Motor / high-current loads run from the raw supply rail.
  const motorRail = sumLoads(
    selections,
    catalog,
    (definition) => definition.category === 'motor' || definition.category === 'motor_driver' || definition.category === 'actuator',
    supplySelection?.instances[0]?.instanceId,
  );
  if (motorRail.loads.length > 0 && supplyVoltage !== undefined) {
    rails.push({
      rail: supplyVoltage >= 6 ? 'VBAT' : 'VSUPPLY',
      voltage: supplyVoltage,
      typicalMa: motorRail.typicalMa,
      peakMa: motorRail.peakMa,
      loads: motorRail.loads,
      ...(supplySelection?.instances[0]?.instanceId ? { sourceInstanceId: supplySelection.instances[0].instanceId } : {}),
    });
  }

  // Logic rail: MCU + sensors + communication.
  const logicRail = sumLoads(
    selections,
    catalog,
    (definition) => ['microcontroller', 'sensor', 'communication', 'display', 'input_device'].includes(definition.category),
    supplySelection?.instances[0]?.instanceId,
  );
  if (logicRail.loads.length > 0) {
    rails.push({
      rail: mcuLogic === 3.3 ? '3V3' : '5V',
      voltage: mcuLogic ?? 5,
      typicalMa: logicRail.typicalMa,
      peakMa: logicRail.peakMa,
      loads: logicRail.loads,
      ...(controller?.instances[0]?.instanceId ? { sourceInstanceId: controller.instances[0].instanceId } : {}),
    });
  }

  const totalTypicalMa = rails.reduce((sum, rail) => sum + (rail.typicalMa ?? 0), 0);
  const totalPeakMa = rails.reduce((sum, rail) => sum + (rail.peakMa ?? 0), 0);

  // Regulator / conversion path.
  let regulator: PowerBudget['regulator'];
  const regulatorSelection = selections.find((selection) => {
    const definition = definitionFor(selection, catalog);
    return definition?.category === 'power' && !isPowerSource(definition) && /regulator|buck|converter/i.test(definition.name);
  });
  const driverWithRegulator = selections.find((selection) => {
    const definition = definitionFor(selection, catalog);
    return typeof definition?.metadata.onboardRegulator === 'string';
  });

  if (regulatorSelection) {
    const definition = definitionFor(regulatorSelection, catalog);
    regulator = {
      componentId: regulatorSelection.componentId,
      instanceId: regulatorSelection.instances[0]?.instanceId,
      inputVoltage: supplyVoltage,
      outputVoltage: definition?.powerSourceRequirements?.outputVoltage ?? mcuLogic,
    };
    notes.push(
      `${definition?.name ?? regulatorSelection.name} converts ${supplyVoltage ?? '?'} V to the ${regulator.outputVoltage ?? '?'} V logic rail.`,
    );
  } else if (driverWithRegulator) {
    const definition = definitionFor(driverWithRegulator, catalog);
    const threshold = typeof definition?.metadata.regulatorInputThresholdV === 'number' ? definition.metadata.regulatorInputThresholdV : undefined;
    regulator = {
      componentId: driverWithRegulator.componentId,
      instanceId: driverWithRegulator.instances[0]?.instanceId,
      inputVoltage: supplyVoltage,
      outputVoltage: 5,
    };
    notes.push(
      `${definition?.name ?? driverWithRegulator.name} has an on-board ${String(definition?.metadata.onboardRegulator)} regulator that provides 5 V${
        threshold && supplyVoltage !== undefined
          ? supplyVoltage >= threshold
            ? ` (supply ${supplyVoltage} V is above the ${threshold} V threshold, so the regulator is active — remove the 5 V jumper feed)`
            : ` only when the supply exceeds ${threshold} V; at ${supplyVoltage} V you must feed 5 V into the driver logic pin instead`
          : ''
      }.`,
    );
  } else if (supplyVoltage !== undefined && mcuLogic !== undefined && supplyVoltage !== mcuLogic) {
    notes.push(
      `No explicit regulator in the bill of materials: the ${supplyVoltage} V supply must reach the MCU through its VIN/USB input (on-board regulator) or a regulator must be added.`,
    );
  }

  // Adequacy analysis.
  let adequate = true;
  if (!supplySelection) {
    adequate = false;
    notes.push('No power source is present in the bill of materials — the project cannot be powered as designed.');
  } else if (supplyMaxCurrent !== undefined && totalPeakMa > 0) {
    if (totalPeakMa > supplyMaxCurrent) {
      adequate = false;
      notes.push(
        `Peak load ${totalPeakMa} mA exceeds what ${supplyDefinition?.name ?? 'the selected supply'} can deliver (${supplyMaxCurrent} mA). Use a higher-current supply or reduce simultaneous loads.`,
      );
    } else {
      const margin = Math.round(((supplyMaxCurrent - totalPeakMa) / supplyMaxCurrent) * 100);
      notes.push(`Peak load ${totalPeakMa} mA against a ${supplyMaxCurrent} mA supply — ${margin}% headroom.`);
      if (margin < 20) notes.push('Headroom is under 20%: stalls or radio bursts could brown out the logic rail. Add bulk capacitance.');
    }
  } else {
    notes.push('Supply current capability is unknown in the catalog — verify it against the measured load before building.');
  }

  // Voltage window checks.
  if (supplyVoltage !== undefined) {
    for (const selection of selections) {
      const definition = definitionFor(selection, catalog);
      if (!definition || !isElectricallyActive(definition)) continue;
      if (isPowerSource(definition)) continue;

      const motor = definition.motorRequirements;
      const min = motor?.supplyVoltageMin ?? definition.minVoltage;
      const max = motor?.supplyVoltageMax ?? definition.maxVoltage;
      const consumesSupplyRail = definition.category === 'motor' || definition.category === 'motor_driver';
      if (!consumesSupplyRail) continue;
      if (min !== undefined && supplyVoltage < min) {
        adequate = false;
        notes.push(`${definition.name} needs at least ${min} V but the supply provides ${supplyVoltage} V.`);
      }
      if (max !== undefined && supplyVoltage > max) {
        adequate = false;
        notes.push(`${definition.name} accepts at most ${max} V but the supply provides ${supplyVoltage} V.`);
      }
    }
  }

  const motorSelections = selections.filter((selection) => definitionFor(selection, catalog)?.category === 'motor');
  if (motorSelections.length > 0) {
    const stall = motorSelections.reduce((sum, selection) => {
      const definition = definitionFor(selection, catalog);
      const stallCurrent = definition?.motorRequirements?.stallCurrentMa ?? definition?.currentRequirements?.maxMa ?? 0;
      return sum + stallCurrent * selection.quantity;
    }, 0);
    if (stall > 0) notes.push(`Worst-case simultaneous motor stall current is roughly ${stall} mA; the driver and supply must tolerate it.`);
    notes.push('Add a bulk electrolytic capacitor across the motor supply to absorb stall transients and reduce brown-outs.');
  }

  if (mcuLogic === 3.3) {
    const fiveVoltLogicParts = selections.filter((selection) => {
      const definition = definitionFor(selection, catalog);
      if (!definition || !isElectricallyActive(definition)) return false;
      if (definition.category === 'microcontroller') return false;
      const partLogic = typeof definition.metadata.logicVoltage === 'number' ? definition.metadata.logicVoltage : definition.voltage;
      const outputsFiveVolts = definition.metadata.echoOutputVoltage === 5 || definition.metadata.outputLogicVoltage === 5;
      return partLogic === 5 || outputsFiveVolts === true;
    });
    if (fiveVoltLogicParts.length > 0) {
      notes.push(
        `3.3 V logic MCU with 5 V interface parts (${fiveVoltLogicParts.map((selection) => selection.name).join(', ')}): level shift or divide any 5 V signal going into the MCU.`,
      );
    }
  }

  if (logicVoltage === undefined) {
    notes.push('No microcontroller profile was available, so logic-rail analysis is limited.');
  }

  return {
    ...(supplyVoltage !== undefined ? { supplyVoltage } : {}),
    ...(supplySelection?.instances[0]?.instanceId ? { supplyInstanceId: supplySelection.instances[0].instanceId } : {}),
    ...(supplySelection ? { supplyComponentId: supplySelection.componentId } : {}),
    totalTypicalMa: totalTypicalMa || undefined,
    totalPeakMa: totalPeakMa || undefined,
    rails,
    ...(regulator ? { regulator } : {}),
    adequate,
    notes,
  };
}
