/**
 * Velxio simulator truth for the Wireup catalog.
 *
 * The component registry may claim `simulator: { supported: true, part }`.
 * This module is the machine-checkable definition of what the vendored Velxio
 * build (AGPL-3.0, `external/velxio`) can actually do with a part, so a claim
 * can never drift from reality:
 *
 *   1. `VELXIO_SIMULATED_METADATA_IDS` — part ids with registered behaviour in
 *      `frontend/src/simulation/parts/PartSimulationRegistry` (the part reacts
 *      to pins, not just draws itself).
 *   2. `VELXIO_SPICE_METADATA_IDS` — part ids the circuit solver maps onto
 *      ngspice netlist cards (`simulation/spice/componentToSpice.ts`
 *      `MAPPERS`). Active devices (transistors, diodes, optos, op-amps,
 *      regulators, batteries) are deliberately NOT in the behaviour registry —
 *      per ActiveParts.ts, "Velxio always runs SPICE so every circuit is solved
 *      with real-world fidelity". A tier-2 claim is honest ONLY with a note
 *      saying what the circuit model does not do.
 *   3. `VELXIO_RENDER_ONLY_METADATA_IDS` — ids whose element is runtime-definable
 *      in the pinned build but has neither behaviour nor a netlist mapper: the
 *      wiring medium. They place correctly but no scenario drives them.
 *   4. `VELXIO_NPM_ELEMENT_TAGS` — the custom element tags the pinned
 *      `@wokwi/elements@1.9.2` dependency defines (provenance note below).
 *
 * `scripts/verify-simulator-link.ts` re-derives (1) and (2) from the vendored
 * source on every run and fails when this module or the catalog disagrees with
 * it. That keeps these tables honest without any runtime I/O.
 *
 * Governing rule (same as the CAD link): a registry that guesses confidently is
 * worse than a registry with holes. `supported: true` is only ever claimed when
 * the vendored Velxio renders the element AND either registers behaviour for it
 * or solves it on the netlist.
 */

/** Path of the vendored metadata file, relative to the repo root. */
export const VELXIO_METADATA_RELATIVE_PATH = 'external/velxio/frontend/public/components-metadata.json';

/** PartSimulationRegistry-registered ids in the vendored build (behaviour, not just rendering). */
export const VELXIO_SIMULATED_METADATA_IDS: ReadonlySet<string> = new Set([
  '74hc595',
  '7segment',
  'a4988',
  'analog-joystick',
  'biaxial-stepper',
  'big-sound-sensor',
  'bmp280',
  'buzzer',
  'custom-chip',
  'dht22',
  'dip-switch-8',
  'ds1307',
  'ds3231',
  'flame-sensor',
  'flip-flop-d',
  'flip-flop-jk',
  'flip-flop-t',
  'gas-sensor',
  'gps-neo6m',
  'hc-sr04',
  'heart-beat-sensor',
  'hx711',
  'ili9341',
  'ili9341-cap-touch',
  'ir-receiver',
  'ir-remote',
  'ks2e-m-dc5',
  'ky-040',
  'lcd1602',
  'lcd1602-i2c',
  'lcd2002',
  'lcd2004',
  'lcd2004-i2c',
  'led',
  'led-bar-graph',
  'led-ring',
  'logic-gate-and',
  'logic-gate-and-3',
  'logic-gate-and-4',
  'logic-gate-nand',
  'logic-gate-nand-3',
  'logic-gate-nand-4',
  'logic-gate-nor',
  'logic-gate-nor-3',
  'logic-gate-nor-4',
  'logic-gate-not',
  'logic-gate-or',
  'logic-gate-or-3',
  'logic-gate-or-4',
  'logic-gate-xnor',
  'logic-gate-xor',
  'membrane-keypad',
  'microsd-card',
  'mpu6050',
  'neopixel',
  'neopixel-matrix',
  'ntc-temperature-sensor',
  'pcf8574',
  'photodiode',
  'photoresistor-sensor',
  'pir-motion-sensor',
  'potentiometer',
  'pushbutton',
  'pushbutton-6mm',
  'raspberry-pi-3',
  'rgb-led',
  'rotary-dialer',
  'servo',
  'slide-potentiometer',
  'slide-switch',
  'small-sound-sensor',
  'ssd1306',
  'ssd1306-i2c-4pin',
  'stepper-motor',
  'tilt-switch',
]);

/**
 * Ids the ngspice netlist mapper covers (`componentToSpice.ts` `MAPPERS`, the
 * SPICE tier). Active semiconductors live here instead of the behaviour
 * registry by upstream design; the gate re-derives this set from the vendored
 * source both directions.
 */
export const VELXIO_SPICE_METADATA_IDS: ReadonlySet<string> = new Set([
  'analog-capacitor',
  'analog-inductor',
  'analog-resistor',
  'battery-9v',
  'battery-aa',
  'battery-coin-cell',
  'bjt-2n2222',
  'bjt-2n3055',
  'bjt-2n3906',
  'bjt-bc547',
  'bjt-bc557',
  'cap-100n',
  'cap-100p',
  'cap-10n',
  'cap-10p',
  'cap-1n',
  'cap-1u',
  'cap-22p',
  'cap-elec-1000u',
  'cap-elec-100u',
  'cap-elec-10u',
  'cap-elec-1u',
  'cap-elec-470u',
  'cap-elec-47u',
  'capacitor-electrolytic',
  'custom-chip',
  'diode-1n4007',
  'diode-1n4148',
  'diode-1n5817',
  'diode-1n5819',
  'ind-100u',
  'ind-10m',
  'ind-1m',
  'instr-ammeter',
  'instr-voltmeter',
  'logic-gate-and',
  'logic-gate-nand',
  'logic-gate-nor',
  'logic-gate-not',
  'logic-gate-or',
  'logic-gate-xnor',
  'logic-gate-xor',
  'mosfet-2n7000',
  'mosfet-fqp27p06',
  'mosfet-irf540',
  'mosfet-irf9540',
  'motor-driver-l293d',
  'ntc-temperature-sensor',
  'opamp-ideal',
  'opamp-lm324',
  'opamp-lm358',
  'opamp-lm741',
  'opamp-tl072',
  'opto-4n25',
  'opto-pc817',
  'power-supply',
  'pushbutton-6mm',
  'reg-7805',
  'reg-7812',
  'reg-7905',
  'reg-lm317',
  'resistor-100k',
  'resistor-10k',
  'resistor-1k',
  'resistor-1m',
  'resistor-220',
  'resistor-22k',
  'resistor-2k2',
  'resistor-330',
  'resistor-470',
  'resistor-47k',
  'resistor-4k7',
  'resistor-us',
  'signal-generator',
  'slide-potentiometer',
  'slide-switch',
  'zener-1n4733',
]);

/**
 * Ids the netlist mapper covers but which are never placed from the metadata:
 * runtime-injected bench instruments (ammeter/voltmeter — injected by
 * ComponentRegistry like the Raspberry Pi boards), internal symbol variants
 * (the US-style resistor) and the boardless analog-mode aliases of the three
 * passives. The exporter can never emit them (it maps through the metadata);
 * tracked so the SPICE tier stays exhaustive versus the vendored mapper.
 */
export const VELXIO_SPICE_RUNTIME_ONLY_IDS: ReadonlySet<string> = new Set([
  'analog-capacitor',
  'analog-inductor',
  'analog-resistor',
  'instr-ammeter',
  'instr-voltmeter',
  'resistor-us',
]);

/**
 * Ids Velxio registers behaviour for but which have NO entry in
 * components-metadata.json: runtime-injected or internal-only parts (custom
 * chips, the bare 74hc595, the PCF8574 expander behind the I2C LCDs, an
 * unlisted LCD variant, the ILI9341 touch overlay, the injected Raspberry Pi).
 * The exporter can never emit them (it maps through the metadata), so they are
 * tracked here purely to keep the registry table complete.
 */
export const VELXIO_RUNTIME_ONLY_REGISTERED_IDS: ReadonlySet<string> = new Set([
  '74hc595',
  'custom-chip',
  'ili9341-cap-touch',
  'lcd2002',
  'pcf8574',
  'raspberry-pi-3',
]);

/**
 * Runtime-definable, placeable, but with no registered behaviour: the SPICE
 * passives and the wiring medium. A catalog claim on one of these is honest
 * only when the note says what is NOT modelled.
 */
export const VELXIO_RENDER_ONLY_METADATA_IDS: ReadonlySet<string> = new Set([
  'breadboard',
  'breadboard-mini',
  'capacitor',
  'capacitor-electrolytic',
  'dc-motor',
  'inductor',
  'resistor',
]);

/**
 * Custom element tags available to the pinned Velxio build. 50 come from
 * `@wokwi/elements@1.9.2` — the exact version pinned in
 * `external/velxio/frontend/package.json` (verified by unpacking the published
 * tarball and listing its `customElement('wokwi-…')` registrations; the
 * docs/debug tag `wokwi-show-pins` is excluded) — plus `wokwi-capacitor` and
 * `wokwi-inductor`, which the Velxio frontend defines locally. Velxio's own
 * `velxio-*` elements live in the vendored source, which the verify script
 * scans directly.
 */
export const VELXIO_NPM_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  'wokwi-7segment',
  'wokwi-analog-joystick',
  'wokwi-arduino-mega',
  'wokwi-arduino-nano',
  'wokwi-arduino-uno',
  'wokwi-biaxial-stepper',
  'wokwi-big-sound-sensor',
  'wokwi-buzzer',
  'wokwi-capacitor',
  'wokwi-dht22',
  'wokwi-dip-switch-8',
  'wokwi-ds1307',
  'wokwi-esp32-devkit-v1',
  'wokwi-flame-sensor',
  'wokwi-franzininho',
  'wokwi-gas-sensor',
  'wokwi-hc-sr04',
  'wokwi-heart-beat-sensor',
  'wokwi-hx711',
  'wokwi-ili9341',
  'wokwi-inductor',
  'wokwi-ir-receiver',
  'wokwi-ir-remote',
  'wokwi-ks2e-m-dc5',
  'wokwi-ky-040',
  'wokwi-lcd1602',
  'wokwi-lcd2004',
  'wokwi-led',
  'wokwi-led-bar-graph',
  'wokwi-led-ring',
  'wokwi-membrane-keypad',
  'wokwi-microsd-card',
  'wokwi-mpu6050',
  'wokwi-nano-rp2040-connect',
  'wokwi-neopixel',
  'wokwi-neopixel-matrix',
  'wokwi-ntc-temperature-sensor',
  'wokwi-photoresistor-sensor',
  'wokwi-pir-motion-sensor',
  'wokwi-potentiometer',
  'wokwi-pushbutton',
  'wokwi-pushbutton-6mm',
  'wokwi-resistor',
  'wokwi-rgb-led',
  'wokwi-rotary-dialer',
  'wokwi-servo',
  'wokwi-slide-potentiometer',
  'wokwi-slide-switch',
  'wokwi-small-sound-sensor',
  'wokwi-ssd1306',
  'wokwi-stepper-motor',
  'wokwi-tilt-switch',
]);

export interface SimulatorClaimCheck {
  componentId: string;
  part: string;
  problem: string;
}

/**
 * Check every `supported: true` claim of a catalog against the Velxio truth.
 *
 * A claim is valid when the projected board is a known Velxio `BoardKind`, or
 * the part maps to a metadata id that either registers behaviour or is an
 * accepted render-only passive/wiring medium.
 */
export function checkSimulatorClaims(
  components: { id: string; simulator?: { part?: string; supported?: boolean } }[],
  metadataByWokwiType: Record<string, string>,
  boardKindsByWokwiType: Record<string, string>,
): SimulatorClaimCheck[] {
  const problems: SimulatorClaimCheck[] = [];
  for (const component of components) {
    const claim = component.simulator;
    if (!claim || claim.supported !== true || !claim.part) continue;

    if (boardKindsByWokwiType[claim.part] !== undefined) continue; // a board — validated against the BoardKind union by the gate

    const metadataId = metadataByWokwiType[claim.part];
    if (!metadataId) {
      problems.push({
        componentId: component.id,
        part: claim.part,
        problem: 'has no verified Velxio model in the exporter mapping table',
      });
      continue;
    }
    const behaviour = VELXIO_SIMULATED_METADATA_IDS.has(metadataId);
    const spiceMapped = VELXIO_SPICE_METADATA_IDS.has(metadataId);
    const renderOnly = VELXIO_RENDER_ONLY_METADATA_IDS.has(metadataId);
    if (!behaviour && !spiceMapped && !renderOnly) {
      problems.push({
        componentId: component.id,
        part: claim.part,
        problem: `maps to Velxio id "${metadataId}" which has neither registered behaviour nor a netlist mapper`,
      });
    }
  }
  return problems;
}
