/**
 * The 3D view's intake — everything it has to receive before it can show a
 * living bench, and what happens when something is missing.
 *
 * These tests cover the layers that used to fail silently:
 *
 *   • `/live-surfaces.json` — validation of every part and surface, the schema
 *     version check, and a fetch failure that is RE-TRIED instead of being
 *     cached for the rest of the session;
 *   • the intake report — the summary the HUD shows and the console logs, and
 *     the sentences it produces for each kind of gap;
 *   • the live-state watcher — that the CAD-bench parts it cannot trace are
 *     reported (unknown pin contracts), and that the emulator's run state is
 *     part of the picture.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PinManager } from '../simulation/PinManager';
import {
  forgetPins,
  readPartDrive,
  rememberPinsFor,
  rolesFor,
} from '../simulation/liveState/driveResolver';
import { sampleOnce } from '../simulation/liveState/partActivity';
import {
  getIntakeReport,
  intakeProblems,
  intakeSummary,
  resetIntakeReport,
} from '../scene3d/live/intakeReport';
import {
  LIVE_SURFACE_SCHEMA_VERSION,
  type LiveSurfaceManifest,
} from '../scene3d/live/surfaceTypes';
import { loadLiveSurfaces, resetLiveSurfaces, validateManifest } from '../scene3d/live/liveSurfaceManifest';
import { usePartRenderStore } from '../store/usePartRenderStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

const MANIFEST: LiveSurfaceManifest = {
  version: LIVE_SURFACE_SCHEMA_VERSION,
  generatedAt: '2026-01-01T00:00:00.000Z',
  parts: {
    'fan-5v-40mm': {
      tag: 'velxio-cad-bench-part',
      surfaces: [
        {
          id: 'rotor',
          kind: 'motion',
          anchor: { frame: 'spec', feature: 'blade_ring' },
          motion: { mode: 'spin', props: ['drive', 'turnsPerSecond'] },
        },
      ],
    },
  },
  noLiveState: { capacitor: 'Passive/discrete: nothing to mirror in 3D.' },
};

beforeEach(() => {
  vi.unstubAllGlobals();
  resetLiveSurfaces();
  resetIntakeReport();
  forgetPins();
  usePartRenderStore.setState({ values: {} });
  useSimulatorStore.setState({ components: [], wires: [], boards: [] });
});

/* ─────────────────────────── manifest validation ─────────────────────────── */

describe('live-surfaces intake', () => {
  it('keeps every valid part and surface', () => {
    const { manifest, dropped, problem } = validateManifest(MANIFEST);
    expect(problem).toBeUndefined();
    expect(dropped).toBe(0);
    expect(Object.keys(manifest.parts)).toEqual(['fan-5v-40mm']);
    expect(manifest.parts['fan-5v-40mm']?.surfaces).toHaveLength(1);
  });

  it('drops a surface the renderer could not act on, and says how many', () => {
    const { manifest, dropped, problem } = validateManifest({
      ...MANIFEST,
      parts: {
        ...MANIFEST.parts,
        'pump-5v': {
          tag: 'velxio-cad-bench-part',
          surfaces: [
            { id: 'ok', kind: 'readout', anchor: { frame: 'spec', feature: 'body' } },
            { id: 'unknown-kind', kind: 'hologram', anchor: { frame: 'spec', feature: 'body' } },
            { id: 'no-anchor', kind: 'readout' },
            null,
          ] as never,
        },
      },
    });
    expect(dropped).toBe(3);
    expect(problem).toContain('3 unusable surface definition(s)');
    expect(manifest.parts['pump-5v']?.surfaces?.map((surface) => surface.id)).toEqual(['ok']);
    // The part is kept (with no surfaces) so the report can name it.
    expect(manifest.parts['pump-5v']).toBeDefined();
  });

  it('flags a version skew instead of pretending to be current', () => {
    const { manifest, problem } = validateManifest({ ...MANIFEST, version: LIVE_SURFACE_SCHEMA_VERSION + 3 });
    expect(problem).toContain('version');
    // The parts still load: a skew is reported, not fatal.
    expect(Object.keys(manifest.parts)).toHaveLength(1);
  });

  it('refuses a file that is not a manifest at all', () => {
    expect(validateManifest({ nope: true }).manifest.parts).toEqual({});
    expect(validateManifest(['array']).problem).toContain('not a JSON object');
  });

  it('loads the manifest and reports what arrived', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => MANIFEST }) as Response);
    const manifest = await loadLiveSurfaces();
    expect(Object.keys(manifest.parts)).toEqual(['fan-5v-40mm']);

    const report = getIntakeReport();
    expect(report.manifest.source).toBe('ok');
    expect(report.manifest.version).toBe(LIVE_SURFACE_SCHEMA_VERSION);
    expect(report.manifest.parts).toBe(1);
    expect(report.manifest.noLiveState).toBe(1);
    expect(report.manifest.attempts).toBe(1);
  });

  it('retries a failed fetch instead of disabling live state for the session', async () => {
    let calls = 0;
    const failing = new Set([1]); // the first response fails with a 5xx
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (failing.has(calls)) return { ok: false, status: 503, json: async () => null } as Response;
      return { ok: true, status: 200, json: async () => MANIFEST } as Response;
    });

    const manifest = await loadLiveSurfaces();
    expect(calls).toBe(2);
    expect(manifest.parts['fan-5v-40mm']).toBeDefined();
    expect(getIntakeReport().manifest.source).toBe('ok');
    expect(getIntakeReport().manifest.attempts).toBe(2);
  });

  it('reports a manifest that is simply not served, without throwing', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => null }) as Response);
    const manifest = await loadLiveSurfaces();
    expect(manifest.parts).toEqual({});
    const report = getIntakeReport();
    expect(report.manifest.source).toBe('missing');
    expect(intakeProblems(report).join(' ')).toContain('live-surfaces.json');
  });
});

/* ──────────────────────────── intake report ─────────────────────────────── */

describe('intake report', () => {
  it('is quiet about a complete intake', () => {
    const report = {
      ...getIntakeReport(),
      manifest: { source: 'ok' as const, version: 1, expectedVersion: 1, parts: 97, noLiveState: 26, attempts: 1 },
      catalog: { entries: 97, withoutSpec: 0 },
      models: { glb: ['fan-5v-40mm'], parametric: [], missing: [] },
      instances: { total: 3, rendered: 3, withoutModel: [] },
      wires: { total: 5, drawn: 5 },
      pins: { known: 2, unknown: [] },
      sim: { running: true },
    };
    expect(intakeProblems(report)).toEqual([]);
    expect(intakeSummary(report)).toContain('sim running');
  });

  it('names every kind of gap in plain words', () => {
    const report = {
      ...getIntakeReport(),
      manifest: { source: 'stale' as const, version: 1, expectedVersion: 2, parts: 97, noLiveState: 0, attempts: 1 },
      catalog: { entries: 0, withoutSpec: 0 },
      models: { glb: [], parametric: [], missing: ['ghost-part'] },
      instances: { total: 4, rendered: 2, withoutModel: [{ id: 'p1', key: 'ghost-part' }] },
      wires: { total: 6, drawn: 4 },
      pins: { known: 1, unknown: ['mystery-module'] },
      sim: { running: false },
    };
    const problems = intakeProblems(report);
    const all = problems.join('\n');
    expect(all).toContain('version 1, but this build expects 2');
    expect(all).toContain('ghost-part');
    expect(all).toContain('1 part(s) in this project have no 3D body and are not on the bench: p1 (ghost-part)');
    expect(all).toContain('2 of 6 wire(s) have no resolved pin anchor');
    expect(all).toContain('mystery-module');
    expect(all).toContain('cad-catalog.json is empty');
    expect(problems).toHaveLength(6);
  });
});

/* ───────────────────── watcher: pins and emulator state ─────────────────── */

describe('watcher intake', () => {
  function bench(components: { id: string; metadataId: string }[], running: boolean): void {
    useSimulatorStore.setState({
      boards: [{ id: 'uno', boardKind: 'arduino-uno', x: 0, y: 0, running } as never],
      activeBoardId: 'uno',
      components: components.map((component) => ({ ...component, x: 0, y: 0, properties: {} })) as never,
      wires: [] as never,
      pinManager: new PinManager(),
    });
  }

  it('reports the CAD-bench parts it cannot trace (unknown pin contract)', () => {
    bench([{ id: 'm1', metadataId: 'cad-bench-dc-motor-generic-6v' }], true);
    rememberPinsFor('cad-bench-dc-motor-generic-6v', ['A', 'B']);
    sampleOnce(useSimulatorStore.getState());

    const report = getIntakeReport();
    expect(report.sim.running).toBe(true);
    expect(report.pins.known).toBe(1);
    expect(report.pins.unknown).toEqual([]);
  });

  it('names a part whose pin contract never arrived', () => {
    bench(
      [
        { id: 'm1', metadataId: 'cad-bench-dc-motor-generic-6v' },
        { id: 'x1', metadataId: 'cad-bench-mystery-module' },
      ],
      false,
    );
    rememberPinsFor('cad-bench-dc-motor-generic-6v', ['A', 'B']);
    sampleOnce(useSimulatorStore.getState());

    const report = getIntakeReport();
    expect(report.pins.unknown).toEqual(['mystery-module']);
    expect(report.sim.running).toBe(false);
    expect(intakeProblems(report).join(' ')).toContain('mystery-module');
  });

  it('traces a driven part through the rail and through a driver', () => {
    // A pump on the board's 5 V rail and a motor behind a relay: the two routes
    // the whole live-state layer exists for.
    rememberPinsFor('cad-bench-water-pump-5v-submersible', ['+', '-']);
    rememberPinsFor('cad-bench-relay-module-5v-1ch', ['VCC', 'GND', 'IN', 'COM', 'NO', 'NC']);
    rememberPinsFor('cad-bench-dc-motor-generic-6v', ['A', 'B']);
    useSimulatorStore.setState({
      boards: [{ id: 'uno', boardKind: 'arduino-uno', x: 0, y: 0, running: true } as never],
      activeBoardId: 'uno',
      components: [
        { id: 'p1', metadataId: 'cad-bench-water-pump-5v-submersible', x: 0, y: 0, properties: {} },
        { id: 'r1', metadataId: 'cad-bench-relay-module-5v-1ch', x: 0, y: 0, properties: {} },
        { id: 'm1', metadataId: 'cad-bench-dc-motor-generic-6v', x: 0, y: 0, properties: {} },
      ] as never,
      wires: [
        { id: 'w1', start: { componentId: 'p1', pinName: '+', x: 0, y: 0 }, end: { componentId: 'uno', pinName: '5V', x: 0, y: 0 }, waypoints: [], color: '#888', autoRouted: true },
        { id: 'w2', start: { componentId: 'r1', pinName: 'IN', x: 0, y: 0 }, end: { componentId: 'uno', pinName: '7', x: 0, y: 0 }, waypoints: [], color: '#888', autoRouted: true },
        { id: 'w3', start: { componentId: 'r1', pinName: 'NO', x: 0, y: 0 }, end: { componentId: 'm1', pinName: 'A', x: 0, y: 0 }, waypoints: [], color: '#888', autoRouted: true },
      ] as never,
      pinManager: new PinManager(),
    });

    const state = useSimulatorStore.getState();
    expect(readPartDrive(state, 'p1', rolesFor('cad-bench-water-pump-5v-submersible')!).on).toBe(true);

    // Relay open: the motor's terminal sees an un-driven contact.
    expect(readPartDrive(state, 'm1', rolesFor('cad-bench-dc-motor-generic-6v')!).on).toBe(false);

    state.pinManager.setPinState(7, true);
    const closed = readPartDrive(useSimulatorStore.getState(), 'm1', rolesFor('cad-bench-dc-motor-generic-6v')!);
    expect(closed.on).toBe(true);
    expect(closed.via).toBe('output');
    expect(closed.through).toBe('r1');

    sampleOnce(useSimulatorStore.getState());
    const values = usePartRenderStore.getState().values;
    expect(values.p1?.drive).toBe(1);
    expect(values.m1?.drive).toBe(1);
    expect(values.m1?.turnsPerSecond).toBeGreaterThan(0);
    expect(values.r1?.triggered).toBe(1);
  });
});
