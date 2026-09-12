/**
 * intakeReport — what the 3D view actually received, and what it did not.
 *
 * The 3D scene is fed by four independent loads: `/live-surfaces.json` (what
 * shows live state), `/cad-catalog.json` (specs: pins, features, dimensions),
 * `/models3d/` (the GLBs), and the running project in the store (boards, parts,
 * wires, pin levels). Each of them can be absent, stale, malformed or slower
 * than the scene, and until now every one of those failures looked the same on
 * screen: a part that renders and never moves.
 *
 * That is the one thing a 3D simulation must never do — stay silent about what
 * it is not showing. This module is the intake's own log: each loader records
 * what it got, the scene records what it could place, the live-state watcher
 * records which parts it can still see pins for, and the HUD puts the result on
 * screen next to the bench.
 *
 * It is a plain observable store (no React state, no per-frame work): producers
 * call a setter, the HUD re-renders, and the console gets one line per distinct
 * problem set — never per frame.
 */

export type ManifestSource = 'pending' | 'ok' | 'stale' | 'invalid' | 'missing';

export interface IntakeReport {
  /** `/live-surfaces.json` — the table that says what moves. */
  manifest: {
    source: ManifestSource;
    /** Version in the file, and the version this build's schema mirrors. */
    version: number;
    expectedVersion: number;
    parts: number;
    noLiveState: number;
    /** Times the loader tried (a failed fetch is retried, not cached). */
    attempts: number;
    problem?: string;
  };
  /** `/cad-catalog.json` — specs behind the bodies and the pin anchors. */
  catalog: { entries: number; withoutSpec: number };
  /** `/models3d/` GLBs, and the parametric fallback built from the catalog. */
  models: { glb: string[]; parametric: string[]; missing: string[] };
  /** Instances the project asked for, and the ones with no body to draw. */
  instances: { total: number; rendered: number; withoutModel: { id: string; key: string }[] };
  /** Wires in the project vs wires with both endpoints resolved in 3D. */
  wires: { total: number; drawn: number };
  /** CAD-bench parts whose pin contract is known (energy can be traced). */
  pins: { known: number; unknown: string[] };
  /** The emulator: live state follows it, so its state is reported too. */
  sim: { running: boolean };
  updatedAt: number;
}

function emptyReport(): IntakeReport {
  return {
    manifest: { source: 'pending', version: 0, expectedVersion: 0, parts: 0, noLiveState: 0, attempts: 0 },
    catalog: { entries: 0, withoutSpec: 0 },
    models: { glb: [], parametric: [], missing: [] },
    instances: { total: 0, rendered: 0, withoutModel: [] },
    wires: { total: 0, drawn: 0 },
    pins: { known: 0, unknown: [] },
    sim: { running: false },
    updatedAt: 0,
  };
}

let report: IntakeReport = emptyReport();
const listeners = new Set<() => void>();

/** Current snapshot. Stable between changes (safe for useSyncExternalStore). */
export function getIntakeReport(): IntakeReport {
  return report;
}

export function subscribeIntake(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(patch: Partial<IntakeReport>): void {
  report = { ...report, ...patch, updatedAt: Date.now() };
  for (const listener of listeners) listener();
  logIntakeOnce();
}

/* ─────────────────────────────── producers ─────────────────────────────── */

export function reportManifest(manifest: Partial<IntakeReport['manifest']>): void {
  publish({ manifest: { ...report.manifest, ...manifest } });
}

export function reportCatalog(catalog: Partial<IntakeReport['catalog']>): void {
  publish({ catalog: { ...report.catalog, ...catalog } });
}

export function reportModels(models: Partial<IntakeReport['models']>): void {
  publish({ models: { ...report.models, ...models } });
}

export function reportInstances(instances: Partial<IntakeReport['instances']>): void {
  publish({ instances: { ...report.instances, ...instances } });
}

export function reportWires(wires: Partial<IntakeReport['wires']>): void {
  publish({ wires: { ...report.wires, ...wires } });
}

export function reportPins(pins: Partial<IntakeReport['pins']>): void {
  publish({ pins: { ...report.pins, ...pins } });
}

export function reportSim(sim: Partial<IntakeReport['sim']>): void {
  publish({ sim: { ...report.sim, ...sim } });
}

/** Test/hot-reload seam: start from a blank intake. */
export function resetIntakeReport(): void {
  report = emptyReport();
  for (const listener of listeners) listener();
  lastLogged = '';
}

/* ───────────────────────────── human summary ───────────────────────────── */

/**
 * Every gap the intake knows about, as sentences. The HUD shows them, the
 * console logs them, and a test can assert them — one source of truth for
 * "what is the 3D view not showing, and why".
 */
export function intakeProblems(current: IntakeReport = report): string[] {
  const problems: string[] = [];
  const { manifest, models, instances, wires, pins } = current;

  if (manifest.source === 'missing') {
    problems.push(
      'live-surfaces.json is not served by this build — parts render, but nothing shows live state. Run `pnpm export:live-surfaces` in Wireup (or ship public/live-surfaces.json).',
    );
  } else if (manifest.source === 'invalid') {
    problems.push(`live-surfaces.json could not be used${manifest.problem ? ` — ${manifest.problem}` : ''}. Live state is unavailable for every part.`);
  } else if (manifest.source === 'stale') {
    problems.push(
      `live-surfaces.json is version ${manifest.version}, but this build expects ${manifest.expectedVersion}${manifest.problem ? ` (${manifest.problem})` : ''} — surfaces that changed shape were dropped.`,
    );
  }

  if (models.missing.length > 0) {
    problems.push(`${models.missing.length} catalog key(s) have no 3D body (no GLB and no spec to build one): ${list(models.missing)}`);
  }
  if (instances.withoutModel.length > 0) {
    const names = instances.withoutModel.map((entry) => `${entry.id} (${entry.key})`);
    problems.push(`${instances.withoutModel.length} part(s) in this project have no 3D body and are not on the bench: ${list(names)}`);
  }
  if (wires.total > 0 && wires.drawn < wires.total) {
    problems.push(
      `${wires.total - wires.drawn} of ${wires.total} wire(s) have no resolved pin anchor in 3D — their ends are not drawn (the 2D canvas and the netlist are unaffected).`,
    );
  }
  if (pins.unknown.length > 0) {
    problems.push(
      `${pins.unknown.length} CAD-bench part(s) have an unknown pin contract, so their live state cannot be traced: ${list(pins.unknown)}`,
    );
  }
  if (current.catalog.entries === 0) {
    problems.push('cad-catalog.json is empty or unreadable — parts fall back to GLB geometry only, with no pin anchors or spec features.');
  }
  return problems;
}

function list(items: string[], max = 4): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

/** One-line summary for the console and the HUD. */
export function intakeSummary(current: IntakeReport = report): string {
  const live = current.manifest.parts;
  return [
    `bodies ${current.instances.rendered}/${current.instances.total}`,
    `live ${live} key(s)`,
    `wires ${current.wires.drawn}/${current.wires.total}`,
    `pins ${current.pins.known}`,
    current.sim.running ? 'sim running' : 'sim stopped',
  ].join(' · ');
}

let lastLogged = '';
/**
 * Log the intake once per distinct problem set. A vendor debugging a bench
 * needs the list; a 60 Hz render loop must never fill the console.
 */
export function logIntakeOnce(current: IntakeReport = report): void {
  const problems = intakeProblems(current);
  const signature = problems.join('\n');
  if (signature === lastLogged) return;
  lastLogged = signature;
  if (problems.length === 0) {
    console.info(`[scene3d] intake ok — ${intakeSummary(current)}`);
    return;
  }
  console.warn(`[scene3d] intake: ${problems.length} gap(s) — ${intakeSummary(current)}\n  · ${problems.join('\n  · ')}`);
}
