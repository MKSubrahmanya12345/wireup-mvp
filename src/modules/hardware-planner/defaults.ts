/**
 * Engineering defaults.
 *
 * This is where the planner stops being a transcriber of the model's answer and
 * starts being an engineer: it adds the driver the model forgot, the level
 * shifter a 5 V MCU needs, the current-limiting resistor every LED needs, the
 * bulk capacitor that keeps a stalling motor from browning out the MCU, and the
 * breadboard/jumpers that are physically required to build anything at all.
 */

import type { ComponentDefinition, ComponentRole } from '@/types/component';
import type { ProjectRequirements } from '@/types/project';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';
import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';

import type { DraftSelection } from './types';

export interface DefaultsInput {
  drafts: DraftSelection[];
  catalog: ComponentDefinition[];
  requirements: ProjectRequirements;
  analysis: PromptAnalysis;
}

export interface DefaultsResult {
  additions: DraftSelection[];
  notes: string[];
}

interface CatalogIndex {
  byId: Map<string, ComponentDefinition>;
}

function indexCatalog(catalog: ComponentDefinition[]): CatalogIndex {
  return { byId: new Map(catalog.map((component) => [component.id, component])) };
}

export function applyEngineeringDefaults(input: DefaultsInput): DefaultsResult {
  const { drafts, catalog, requirements, analysis } = input;
  const { byId } = indexCatalog(catalog);
  const additions: DraftSelection[] = [];
  const notes: string[] = [];

  const definitionOf = (componentId: string) => byId.get(componentId);
  const present = (componentId: string) =>
    drafts.some((draft) => draft.componentId === componentId) || additions.some((draft) => draft.componentId === componentId);
  const presentWhere = (predicate: (definition: ComponentDefinition, draft: DraftSelection) => boolean) =>
    [...drafts, ...additions].some((draft) => {
      const definition = definitionOf(draft.componentId);
      return definition ? predicate(definition, draft) : false;
    });

  const add = (componentId: string, quantity: number, role: ComponentRole, reason: string, extra: Partial<DraftSelection> = {}) => {
    if (!byId.has(componentId)) {
      notes.push(`Engineering default "${componentId}" is not in the catalog and was skipped.`);
      return;
    }
    if (present(componentId)) return;
    additions.push({ componentId, quantity: Math.max(1, quantity), role, reason, required: true, source: 'planner', ...extra });
  };

  const features = new Set(analysis.features.map((feature) => feature.toLowerCase()));
  const totalQuantity = (predicate: (definition: ComponentDefinition) => boolean) =>
    [...drafts, ...additions].reduce((sum, draft) => {
      const definition = definitionOf(draft.componentId);
      return definition && predicate(definition) ? sum + draft.quantity : 0;
    }, 0);

  /* 1. Controller ------------------------------------------------------------ */
  let controller = drafts.find((draft) => definitionOf(draft.componentId)?.category === 'microcontroller');
  if (!controller) {
    const preferred = analysis.detectedPlatformComponentId;
    const needsRadio = features.has('bluetooth') || features.has('wifi') || features.has('ble');
    const chosen =
      (preferred && byId.has(preferred) ? preferred : undefined) ??
      (needsRadio && byId.has('esp32-devkit-v1') ? 'esp32-devkit-v1' : undefined) ??
      (byId.has('arduino-uno-r3') ? 'arduino-uno-r3' : undefined) ??
      catalog.find((component) => component.category === 'microcontroller')?.id;

    if (chosen) {
      add(chosen, 1, 'controller', `No microcontroller was selected; ${definitionOf(chosen)?.name ?? chosen} satisfies the platform and connectivity requirements.`, {
        required: true,
      });
      controller = additions[additions.length - 1];
      notes.push(`Controller auto-selected: ${definitionOf(chosen)?.name ?? chosen}.`);
    } else {
      notes.push('The catalog contains no microcontroller, so no controller could be selected.');
    }
  }

  const controllerDefinition = controller ? definitionOf(controller.componentId) : undefined;
  const profile = controller ? getMcuProfile(controller.componentId) : undefined;
  const mcuLogic = profile?.logicVoltage ?? controllerDefinition?.voltage ?? 5;
  const hasRadio =
    controllerDefinition?.metadata.bluetooth !== undefined &&
    (controllerDefinition.metadata.bluetooth as { classic?: boolean; ble?: boolean }).classic === true;

  /* 2. Motor drivers --------------------------------------------------------- */
  const motorDrafts = [...drafts, ...additions].filter((draft) => definitionOf(draft.componentId)?.category === 'motor');
  for (const draft of motorDrafts) {
    const definition = definitionOf(draft.componentId);
    if (!definition) continue;

    const requiresDriver = definition.motorRequirements?.requiresDriver === true;
    if (!requiresDriver) continue;

    if (typeof definition.metadata.driverIntegrated === 'string') {
      notes.push(`${definition.name} already includes its driver (${String(definition.metadata.driverIntegrated)}) — no extra driver needed.`);
      continue;
    }

    const driverPresent = presentWhere((component) => component.category === 'motor_driver');
    if (driverPresent) continue;

    const motorType = definition.motorRequirements?.motorType;
    if (motorType === 'stepper') {
      add('a4988-stepper-driver', draft.quantity, 'driver', `${definition.name} is a bipolar stepper and needs a chopper driver: the A4988 provides STEP/DIR control, microstepping and coil current regulation.`);
      continue;
    }

    const stallCurrent = definition.motorRequirements?.stallCurrentMa ?? definition.currentRequirements?.maxMa ?? 0;
    const channelsNeeded = draft.quantity;
    const driverChoice =
      stallCurrent > 1200
        ? 'l298n-motor-driver'
        : mcuLogic <= 3.3
          ? 'tb6612fng-motor-driver'
          : channelsNeeded > 2
            ? 'l298n-motor-driver'
            : 'tb6612fng-motor-driver';

    const driverDefinition = definitionOf(driverChoice);
    const channels = driverDefinition?.motorRequirements?.channels ?? 2;
    const quantity = Math.max(1, Math.ceil(channelsNeeded / channels));

    add(
      driverChoice,
      quantity,
      'driver',
      `${definition.name} must never be driven from a microcontroller GPIO (stall current ~${stallCurrent || 'unknown'} mA). ${driverDefinition?.name ?? driverChoice} provides ${channels} H-bridge channel(s)${
        driverChoice === 'tb6612fng-motor-driver'
          ? ' with a low voltage drop and 3.3 V logic compatibility'
          : ' and can handle up to 2 A per channel'
      } — ${quantity} unit(s) cover ${channelsNeeded} motor(s).`,
    );
  }

  /* 3. Power source ---------------------------------------------------------- */
  const needsExternalSupply = [...drafts, ...additions].some((draft) => {
    const definition = definitionOf(draft.componentId);
    return definition?.motorRequirements?.requiresExternalSupply === true || definition?.category === 'motor_driver';
  });
  const supplyPresent = presentWhere((component) => component.category === 'power' && component.powerSourceRequirements?.outputVoltage !== undefined);

  if (needsExternalSupply && !supplyPresent) {
    const motorStallTotal = motorDrafts.reduce((sum, draft) => {
      const definition = definitionOf(draft.componentId);
      const stall = definition?.motorRequirements?.stallCurrentMa ?? definition?.currentRequirements?.maxMa ?? 0;
      return sum + stall * draft.quantity;
    }, 0);

    if (motorStallTotal > 500) {
      add('battery-2s-lipo', 1, 'power', `Motor loads need a supply that survives stall current (~${motorStallTotal} mA worst case). A 2S LiPo delivers 7.4 V at many amps, inside the motor driver input window.`);
    } else {
      add('battery-holder-4xaa', 1, 'power', 'Loads need a portable supply; four AA cells give 6 V at 1–2 A, which fits the driver input window without a LiPo charger requirement.');
    }
    notes.push('No power source was selected; one was added based on the worst-case load current.');
  }

  /* 4. Radio / communication ------------------------------------------------- */
  const wantsBluetooth = features.has('bluetooth') || features.has('ble') || /bluetooth|\bble\b/i.test(requirements.goal);
  const wantsWifi = features.has('wifi');
  const radioSelected = presentWhere((component) => component.category === 'communication');

  if ((wantsBluetooth || wantsWifi) && !radioSelected) {
    if (hasRadio && byId.has('esp32-bluetooth-wifi-capability')) {
      add('esp32-bluetooth-wifi-capability', 1, 'communication', `${controllerDefinition?.name ?? 'The selected MCU'} already has an integrated radio, so no external module is needed — this entry documents the capability used by the firmware.`);
    } else if (wantsBluetooth) {
      add('hc-05-bluetooth', 1, 'communication', 'Bluetooth control from a phone requires an SPP module; the HC-05 works as master or slave and pairs with any serial terminal app.');
      if (mcuLogic >= 5) {
        add('logic-level-shifter-4ch', 1, 'power', 'The HC-05 has 3.3 V I/O while the MCU drives 5 V: the module RXD line needs level shifting (or a resistor divider) to stay inside its rating.');
      }
    } else if (wantsWifi) {
      add('esp8266-esp01-wifi', 1, 'communication', 'Wi-Fi connectivity was requested but the selected MCU has no radio; an ESP-01 provides Wi-Fi over AT commands on a 3.3 V UART.');
    }
  }

  /* 5. Interface protection -------------------------------------------------- */
  if (mcuLogic <= 3.3) {
    const fiveVoltOutputs = [...drafts, ...additions].filter((draft) => {
      const definition = definitionOf(draft.componentId);
      return definition?.metadata.echoOutputVoltage === 5 || definition?.metadata.outputLogicVoltage === 5;
    });
    if (fiveVoltOutputs.length > 0 && !present('logic-level-shifter-4ch')) {
      add(
        'logic-level-shifter-4ch',
        1,
        'power',
        `${fiveVoltOutputs.map((draft) => definitionOf(draft.componentId)?.name ?? draft.componentId).join(', ')} output 5 V into a ${mcuLogic} V MCU pin. A bidirectional level shifter protects the input and keeps the logic thresholds clean.`,
      );
    }
  }

  /* 6. LEDs need series resistors -------------------------------------------- */
  const ledQuantity = totalQuantity((component) => component.id === 'led-5mm');
  if (ledQuantity > 0 && !present('resistor-220ohm')) {
    const resistorValue = mcuLogic >= 5 ? 'resistor-220ohm' : 'resistor-1kohm';
    add(resistorValue, ledQuantity, 'passive', `Each LED needs a series current-limiting resistor. ${ledQuantity} LED(s) at ${mcuLogic} V logic with a ~2.1 V forward drop → ${definitionOf(resistorValue)?.metadata.resistanceOhm ?? 220} Ω keeps the current near 10–15 mA.`);
  }

  const rgbQuantity = totalQuantity((component) => component.id === 'rgb-led-common-cathode');
  if (rgbQuantity > 0 && !present('resistor-220ohm')) {
    add('resistor-220ohm', rgbQuantity * 3, 'passive', `An RGB LED has three independently driven channels, each needing its own series resistor (${rgbQuantity} LED(s) x 3 channels).`);
  }

  /* 7. Analog sensors need a divider ------------------------------------------ */
  if (presentWhere((component) => component.metadata.requiresVoltageDivider === true) && !present('resistor-10kohm')) {
    add('resistor-10kohm', 1, 'passive', 'The light-dependent resistor must form a voltage divider with a fixed resistor to produce an ADC-readable voltage; 10 kΩ is the standard pairing.');
  }

  /* 8. Bulk capacitance for motor/servo transients ---------------------------- */
  const transientLoads = [...drafts, ...additions].some((draft) => {
    const definition = definitionOf(draft.componentId);
    return definition?.category === 'motor' || definition?.metadata.requiresBulkCapacitor === true || definition?.category === 'motor_driver';
  });
  if (transientLoads && !present('capacitor-1000uf-electrolytic')) {
    add('capacitor-1000uf-electrolytic', 1, 'passive', 'Motor/servo inrush and stall transients collapse thin supplies. A 1000 µF bulk capacitor across the motor rail keeps the logic rail alive during stalls.');
  }

  /* 9. Decoupling for ICs ----------------------------------------------------- */
  const icCount = totalQuantity(
    (component) => component.category === 'sensor' || component.category === 'display' || component.category === 'communication' || component.category === 'motor_driver',
  );
  if (icCount > 0 && !present('capacitor-100nf-ceramic')) {
    add('capacitor-100nf-ceramic', Math.min(4, icCount), 'passive', 'Each IC needs a 100 nF decoupling capacitor between its supply and ground pins to suppress switching noise.');
  }

  /* 10. Flyback protection ---------------------------------------------------- */
  const rawInductiveLoad = [...drafts, ...additions].some((draft) => {
    const definition = definitionOf(draft.componentId);
    return definition?.category === 'motor' && definition?.motorRequirements?.requiresDriver === true;
  });
  const driverHasClamps = presentWhere((component) => component.metadata.internalClampDiodes === true || /l298n|l293d|tb6612/i.test(component.id));
  if (rawInductiveLoad && !driverHasClamps && !present('diode-1n4007')) {
    add('diode-1n4007', 2, 'power', 'Inductive loads generate back-EMF spikes when switched off. A flyback diode across each motor protects the driver outputs.');
  }

  /* 11. Prototyping medium ---------------------------------------------------- */
  add('breadboard-830', 1, 'prototyping', 'Solderless prototyping surface for the whole build; lets the wiring be assembled and changed without soldering.', { required: false });
  add('jumper-wires-kit', 1, 'prototyping', 'Jumper wires are the physical medium for every connection in the wiring plan.', { required: false });

  /* 12. Advisory notes -------------------------------------------------------- */
  const i2cDevices = [...drafts, ...additions].filter((draft) => (definitionOf(draft.componentId)?.communicationProtocols ?? []).includes('i2c'));
  if (i2cDevices.length > 1) {
    notes.push(
      `${i2cDevices.length} I2C devices share one bus: verify their addresses differ (${i2cDevices
        .map((draft) => `${definitionOf(draft.componentId)?.name ?? draft.componentId}@${String(definitionOf(draft.componentId)?.metadata.i2cAddress ?? '?')}`)
        .join(', ')}).`,
    );
  }

  const servoTotal = totalQuantity((component) => component.category === 'motor' && component.motorRequirements?.motorType === 'servo');
  if (servoTotal >= 2) {
    notes.push(`${servoTotal} servos on one supply: budget ~500 mA per servo at stall and feed them from the supply rail, not from the MCU board regulator.`);
  }

  const relayPresent = presentWhere((component) => /relay/i.test(component.id));
  if (relayPresent) {
    notes.push('Most opto-isolated relay modules trigger on a LOW input — verify the trigger level before assuming active-high logic in the firmware.');
  }

  return { additions, notes };
}
