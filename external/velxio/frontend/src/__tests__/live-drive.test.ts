/**
 * The live-state producer for parts the emulator has no model for.
 *
 * These tests build real bench states (components, wires, board pin levels) and
 * assert what the 3D view will be told about each part: whether it is driven,
 * through which terminal, at what duty, and whether it is still. They are the
 * contract behind every "spinning fan / energised pump / closed relay" surface
 * in Wireup's live-surface table.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import { classifyPart, ratedRpm, roleOfPin, isSourceId, isPassiveId } from '../simulation/liveState/pinRoles';
import {
  anyPinHigh,
  forgetPins,
  readPartDrive,
  readPinEnergy,
  rememberPinsFor,
  rolesFor,
} from '../simulation/liveState/driveResolver';
import { sampleOnce } from '../simulation/liveState/partActivity';
import { usePartRenderStore } from '../store/usePartRenderStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

/* ─────────────────────────── test bench helpers ────────────────────────── */

interface WireSpec {
  from: [string, string];
  to: [string, string];
}

/** Install a bench: components, wires and the board the sketch is running. */
function bench(wires: WireSpec[], components: { id: string; metadataId: string }[]): void {
  const state = useSimulatorStore.getState();
  useSimulatorStore.setState({
    boards: [
      {
        id: 'uno',
        boardKind: 'arduino-uno',
        x: 0,
        y: 0,
        running: true,
      } as never,
    ],
    activeBoardId: 'uno',
    components: components.map((component) => ({
      ...component,
      x: 0,
      y: 0,
      properties: {},
      boardKind: undefined,
    })) as never,
    wires: wires.map((wire, index) => ({
      id: `w${index}`,
      start: { componentId: wire.from[0], pinName: wire.from[1], x: 0, y: 0 },
      end: { componentId: wire.to[0], pinName: wire.to[1], x: 0, y: 0 },
      waypoints: [],
      color: '#888',
      autoRouted: true,
    })) as never,
    pinManager: new PinManager(),
  });
  void state;
}

/** Drive a board pin the way the emulation does when a sketch writes it. */
function drivePin(pin: number, level: boolean, duty = 0): void {
  const { pinManager } = useSimulatorStore.getState();
  pinManager.setPinState(pin, level);
  if (duty > 0) pinManager.updatePwm(pin, duty);
}

beforeEach(() => {
  forgetPins();
  usePartRenderStore.setState({ values: {} });
  useSimulatorStore.setState({ components: [], wires: [], boards: [] });
});

/* ───────────────────────────── pin vocabulary ──────────────────────────── */

describe('classifyPart', () => {
  it('reads a plain load: every non-ground pin takes energy', () => {
    const roles = classifyPart(['VCC', 'GND']);
    expect(roles.controller).toBe(false);
    expect(roles.drivePins).toEqual(['VCC']);
    expect(roles.groundPins).toEqual(['GND']);
  });

  it('reads a motor’s own terminals as its drive, not as outputs', () => {
    const roles = classifyPart(['A', 'B']);
    expect(roles.controller).toBe(false);
    expect(roles.drivePins).toEqual(['A', 'B']);
    expect(roles.outputPins).toEqual([]);
  });

  it('turns the same pin names into outputs on a driver', () => {
    // The L298N's OUT1..4 sit next to IN1..4/ENA → it is a controller, and the
    // OUT pins are what it drives. Its A1/B1-shaped siblings are the same idea.
    const l298n = classifyPart(['ENA', 'IN1', 'IN2', 'OUT1', 'OUT2', '+12V', 'GND', '5V']);
    expect(l298n.controller).toBe(true);
    expect(l298n.controlPins).toEqual(['ENA', 'IN1', 'IN2']);
    expect(l298n.outputPins).toEqual(['OUT1', 'OUT2']);
    // Supply pins first, then bare terminals — both are where energy arrives.
    expect([...l298n.drivePins].sort()).toEqual(['+12V', '5V']);

    const drv8825 = classifyPart(['VMOT', 'GND_MOT', 'A1', 'A2', 'B1', 'B2', 'STEP', 'DIR', 'EN']);
    expect(drv8825.controller).toBe(true);
    expect(drv8825.outputPins).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(drv8825.controlPins).toEqual(['STEP', 'DIR', 'EN']);
  });

  it('separates bus lines from power, on sensors and radios', () => {
    const dht11 = classifyPart(['VCC', 'DATA', 'GND']);
    // DATA is not in the bus vocabulary (it is not I2C/SPI/one-wire-named):
    // it is the module's single signal terminal.
    expect([...dht11.drivePins].sort()).toEqual(['DATA', 'VCC']);

    const hc05 = classifyPart(['VCC', 'GND', 'TXD', 'RXD', 'STATE', 'KEY']);
    expect(hc05.busPins).toEqual(['TXD', 'RXD']);
    expect(hc05.controlPins).toEqual(['KEY']);
    expect([...hc05.drivePins].sort()).toEqual(['STATE', 'VCC']);

    const bme280 = classifyPart(['VIN', 'GND', 'SCL', 'SDA']);
    expect(bme280.busPins).toEqual(['SCL', 'SDA']);
    expect(bme280.drivePins).toEqual(['VIN']);
  });

  it('knows a relay’s contact is an output and its coil common is a return', () => {
    const roles = classifyPart(['VCC', 'GND', 'IN', 'COM', 'NO', 'NC']);
    expect(roles.controlPins).toEqual(['IN']);
    expect(roles.outputPins).toEqual(['NO', 'NC']);
    expect(roles.groundPins).toEqual(['GND', 'COM']);
  });

  it('classifies a unipolar stepper board by its command pins', () => {
    const roles = classifyPart(['IN1', 'IN2', 'IN3', 'IN4', 'VCC', 'GND']);
    expect(roles.controller).toBe(true);
    expect(roles.controlPins).toEqual(['IN1', 'IN2', 'IN3', 'IN4']);
    expect(roles.drivePins).toEqual(['VCC']);
  });

  it('keeps role classification and the part-level hints consistent', () => {
    expect(roleOfPin('GND', true)).toBe('ground');
    expect(roleOfPin('OUT1', true)).toBe('output');
    expect(roleOfPin('A', true)).toBe('power'); // a load's terminal, even on a controller
    expect(isSourceId('battery-2s-lipo')).toBe(true);
    expect(isSourceId('battery-holder-4xaa')).toBe(true);
    expect(isSourceId('dc-motor-generic-6v')).toBe(false);
    expect(isPassiveId('propeller-5045-tri-blade')).toBe(true);
    expect(ratedRpm('fan-5v-40mm')).toBeGreaterThan(0);
    expect(ratedRpm('peristaltic-pump-12v')).toBeGreaterThan(0);
    expect(ratedRpm('relay-module-5v-1ch')).toBeNull();
  });
});

/* ──────────────────────────── energy tracing ───────────────────────────── */

describe('drive resolution', () => {
  it('finds a motor energised from the GPIO its terminal is wired to', () => {
    rememberPinsFor('cad-bench-dc-motor-generic-6v', ['A', 'B']);
    bench(
      [
        { from: ['m1', 'A'], to: ['uno', '9'] },
        { from: ['m1', 'B'], to: ['uno', 'GND'] },
      ],
      [{ id: 'm1', metadataId: 'cad-bench-dc-motor-generic-6v' }],
    );

    const state = useSimulatorStore.getState();
    const roles = rolesFor('cad-bench-dc-motor-generic-6v')!;
    expect(readPartDrive(state, 'm1', roles).on).toBe(false);

    drivePin(9, true);
    const driven = readPartDrive(useSimulatorStore.getState(), 'm1', roles);
    expect(driven.on).toBe(true);
    expect(driven.via).toBe('gpio');
    expect(driven.pin).toBe('A');
  });

  it('reports the PWM duty a sketch wrote, and the pin it arrived at', () => {
    rememberPinsFor('cad-bench-fan-5v-40mm', ['VCC', 'GND']);
    bench([{ from: ['f1', 'VCC'], to: ['uno', '5'] }], [{ id: 'f1', metadataId: 'cad-bench-fan-5v-40mm' }]);
    drivePin(5, true, 128); // analogWrite(5, 128) ≈ 50 %

    const state = useSimulatorStore.getState();
    const energy = readPartDrive(state, 'f1', rolesFor('cad-bench-fan-5v-40mm')!);
    expect(energy.on).toBe(true);
    expect(energy.via).toBe('pwm');
    expect(energy.duty).toBeCloseTo(128 / 255, 3);
  });

  it('follows energy through a driver into the load it switches', () => {
    rememberPinsFor('cad-bench-dc-motor-generic-6v', ['A', 'B']);
    rememberPinsFor('cad-bench-relay-module-5v-1ch', ['VCC', 'GND', 'IN', 'COM', 'NO', 'NC']);
    bench(
      [
        { from: ['r1', 'IN'], to: ['uno', '7'] },
        { from: ['r1', 'NO'], to: ['m1', 'A'] },
        { from: ['m1', 'B'], to: ['uno', 'GND'] },
      ],
      [
        { id: 'r1', metadataId: 'cad-bench-relay-module-5v-1ch' },
        { id: 'm1', metadataId: 'cad-bench-dc-motor-generic-6v' },
      ],
    );

    const roles = rolesFor('cad-bench-dc-motor-generic-6v')!;
    // Relay open: the motor's terminal sees only an idle driver.
    expect(readPartDrive(useSimulatorStore.getState(), 'm1', roles).on).toBe(false);

    drivePin(7, true); // sketch pulls the relay's IN high
    const driven = readPartDrive(useSimulatorStore.getState(), 'm1', roles);
    expect(driven.on).toBe(true);
    expect(driven.via).toBe('output');
    expect(driven.through).toBe('r1');
  });

  it('treats a battery on the net as a live rail', () => {
    rememberPinsFor('cad-bench-water-pump-5v-submersible', ['+', '-']);
    rememberPinsFor('cad-bench-battery-9v', ['+', '-']);
    bench(
      [
        { from: ['p1', '+'], to: ['b1', '+'] },
        { from: ['p1', '-'], to: ['b1', '-'] },
      ],
      [
        { id: 'p1', metadataId: 'cad-bench-water-pump-5v-submersible' },
        { id: 'b1', metadataId: 'cad-bench-battery-9v' },
      ],
    );
    const energy = readPartDrive(useSimulatorStore.getState(), 'p1', rolesFor('cad-bench-water-pump-5v-submersible')!);
    expect(energy.on).toBe(true);
    expect(energy.via).toBe('rail');
    expect(energy.through).toBe('b1');
  });

  it('answers "nothing" for an unwired terminal rather than guessing', () => {
    rememberPinsFor('cad-bench-water-pump-5v-submersible', ['+', '-']);
    bench([], [{ id: 'p1', metadataId: 'cad-bench-water-pump-5v-submersible' }]);
    const state = useSimulatorStore.getState();
    expect(readPinEnergy(state, 'p1', '+').on).toBe(false);
    expect(readPinEnergy(state, 'p1', '+').via).toBe('none');
    expect(anyPinHigh(state, 'p1', ['+'])).toBe(false);
  });
});

/* ───────────────────────── the published live state ────────────────────── */

describe('partActivity', () => {
  it('publishes drive, speed and direction for a driven motor, and nothing for a still one', () => {
    rememberPinsFor('cad-bench-dc-motor-generic-6v', ['A', 'B']);
    rememberPinsFor('cad-bench-water-pump-5v-submersible', ['+', '-']);
    bench(
      [
        { from: ['m1', 'A'], to: ['uno', '9'] },
        { from: ['m1', 'B'], to: ['uno', 'GND'] },
      ],
      [
        { id: 'm1', metadataId: 'cad-bench-dc-motor-generic-6v' },
        { id: 'p1', metadataId: 'cad-bench-water-pump-5v-submersible' },
      ],
    );
    drivePin(9, true);

    sampleOnce(useSimulatorStore.getState());
    const values = usePartRenderStore.getState().values;
    const motor = values.m1;
    expect(motor).toBeDefined();
    expect(motor?.drive).toBeGreaterThan(0.9);
    // The rotation rate is the device's own rating scaled by the measured duty:
    // a geared 6 V motor at full drive turns at its geared output speed.
    const rated = ratedRpm('cad-bench-dc-motor-generic-6v')!;
    expect(motor?.turnsPerSecond).toBeCloseTo(rated / 60, 1);
    expect(motor?.rpm).toBe(rated);
    expect(motor?.activity).toBeGreaterThan(0.9);
    expect(motor?.via).toBe('gpio');

    // The pump's terminals reach no net: it must stay unpublished, not zeroed.
    expect(values.p1).toBeUndefined();
  });

  it('advances a stepper by one half-step per commanded coil-pattern change', () => {
    rememberPinsFor('cad-bench-stepper-28byj48-uln2003', ['IN1', 'IN2', 'IN3', 'IN4', 'VCC', 'GND']);
    bench(
      [
        { from: ['s1', 'IN1'], to: ['uno', '8'] },
        { from: ['s1', 'IN2'], to: ['uno', '9'] },
        { from: ['s1', 'IN3'], to: ['uno', '10'] },
        { from: ['s1', 'IN4'], to: ['uno', '11'] },
      ],
      [{ id: 's1', metadataId: 'cad-bench-stepper-28byj48-uln2003' }],
    );

    const entries = sampleOnce(useSimulatorStore.getState());
    // Sequence the coils the way a sketch does: 1,2,3,4 then back to 1.
    const sequence: [number, boolean][][] = [
      [[8, true], [9, false], [10, false], [11, false]],
      [[8, false], [9, true], [10, false], [11, false]],
      [[8, false], [9, false], [10, true], [11, false]],
      [[8, false], [9, false], [10, false], [11, true]],
    ];
    for (const step of sequence) {
      for (const [pin, level] of step) drivePin(pin, level);
      sampleOnce(useSimulatorStore.getState(), entries);
    }

    const angle = usePartRenderStore.getState().values.s1?.stepAngle ?? 0;
    expect(angle).toBeGreaterThan(0);
    expect(angle).toBeLessThan(5); // three pattern changes × 0.703°
  });

  it('reports bus traffic for a module being addressed', () => {
    rememberPinsFor('cad-bench-hc-05-bluetooth', ['VCC', 'GND', 'TXD', 'RXD', 'STATE', 'KEY']);
    bench(
      [
        { from: ['b1', 'VCC'], to: ['uno', '5V'] },
        { from: ['b1', 'GND'], to: ['uno', 'GND.1'] },
        { from: ['b1', 'RXD'], to: ['uno', '1'] },
        { from: ['b1', 'TXD'], to: ['uno', '0'] },
      ],
      [{ id: 'b1', metadataId: 'cad-bench-hc-05-bluetooth' }],
    );

    const entries = sampleOnce(useSimulatorStore.getState());
    // Powered from the board's 5 V rail, but nothing has been sent yet: the
    // module reports its supply and no traffic, not an invented stream.
    const first = usePartRenderStore.getState().values.b1;
    expect(first?.drive).toBe(1);
    expect(first?.via).toBe('rail');
    expect(first?.bus).toBe(0);

    // A byte going out toggles the line: that IS the module's live state, and
    // the module is powered, so its activity follows the traffic.
    for (const level of [true, false, true, false, true, false, true, false]) {
      drivePin(1, level);
      sampleOnce(useSimulatorStore.getState(), entries);
    }
    const after = usePartRenderStore.getState().values.b1;
    expect(after?.bus ?? 0).toBeGreaterThan(0.5);
    expect(after?.activity ?? 0).toBeGreaterThan(0.9);
  });
});
