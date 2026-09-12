/**
 * IntakeHud — what the 3D view received, on screen next to the bench.
 *
 * A 3D simulation that silently drops a part, a wire or a whole live-state table
 * looks exactly like a simulation where nothing happens. This chip is the
 * difference: it reports the intake (bodies placed, live-state key coverage,
 * wires drawn, CAD-bench pins traced, whether the emulator is running) and lists
 * every gap it knows about, in the words of the thing that went missing.
 *
 * It is deliberately small and out of the way — a corner chip that expands when
 * clicked — and it renders OUTSIDE the WebGL canvas (plain DOM), so a bench that
 * fails to load still shows why.
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import { getIntakeReport, intakeProblems, intakeSummary, subscribeIntake } from './intakeReport';

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: 10,
  bottom: 10,
  zIndex: 60,
  maxWidth: 460,
  font: '500 10px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#cbd5e1',
  background: 'rgba(12, 16, 22, 0.86)',
  border: '1px solid rgba(148, 163, 184, 0.28)',
  borderRadius: 7,
  padding: '4px 7px',
  pointerEvents: 'auto',
  backdropFilter: 'blur(3px)',
};

export function IntakeHud() {
  const report = useSyncExternalStore(subscribeIntake, getIntakeReport, getIntakeReport);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  const problems = intakeProblems(report);
  const loading = report.manifest.source === 'pending' && report.instances.total === 0;
  const tone = problems.length > 0 ? '#fbbf24' : loading ? '#94a3b8' : '#5eead4';
  const label = problems.length > 0 ? `intake: ${problems.length} gap(s)` : loading ? 'intake: loading' : 'intake: ok';

  return (
    <div style={PANEL_STYLE} data-testid="intake-hud">
      <button
        type="button"
        onClick={toggle}
        title={problems.length > 0 ? 'Click for the list' : 'Everything the 3D view needs is here'}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          gap: 6,
          alignItems: 'baseline',
          color: tone,
        }}
      >
        <span aria-hidden>{problems.length > 0 ? '▲' : '●'}</span>
        <span>{label}</span>
        <span style={{ color: '#8b98a9' }}>{intakeSummary(report)}</span>
        <span style={{ color: '#64748b' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open ? (
        <div style={{ marginTop: 4, borderTop: '1px solid rgba(148,163,184,0.22)', paddingTop: 4 }}>
          <Row label="live-surfaces.json" value={`${report.manifest.source} · v${report.manifest.version} (expected v${report.manifest.expectedVersion}) · ${report.manifest.parts} key(s), ${report.manifest.noLiveState} inert · ${report.manifest.attempts} attempt(s)`} />
          <Row label="catalog" value={`${report.catalog.entries} spec(s)${report.catalog.withoutSpec ? `, ${report.catalog.withoutSpec} incomplete` : ''}`} />
          <Row label="models" value={`${report.models.glb.length} GLB · ${report.models.parametric.length} parametric${report.models.missing.length ? ` · ${report.models.missing.length} without GLB` : ''}`} />
          <Row label="bodies" value={`${report.instances.rendered}/${report.instances.total} placed`} />
          <Row label="wires" value={`${report.wires.drawn}/${report.wires.total} drawn`} />
          <Row label="bench pins" value={`${report.pins.known} traced${report.pins.unknown.length ? ` · ${report.pins.unknown.length} unknown` : ''}`} />
          <Row label="simulator" value={report.sim.running ? 'running' : 'stopped — live state follows the emulator'} />
          {problems.map((problem) => (
            <div key={problem} style={{ marginTop: 4, color: '#fcd34d' }}>
              · {problem}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <span style={{ color: '#7c8a9c', minWidth: 108 }}>{label}</span>
      <span style={{ color: '#cbd5e1' }}>{value}</span>
    </div>
  );
}

export default IntakeHud;
