'use client';

/**
 * WIRING & PINS — the picture of how it connects, told in plain language. The
 * graph and a readable wire list are front and centre; nets, conflicts and the
 * source of each wire are tucked behind "details".
 */

import { useMemo, useState } from 'react';

import { Badge, Card, DownloadButton, Empty, Loader, SectionTitle } from '../ui';
import { WiringGraph } from '../WiringGraph';
import { useHub } from '../hub-context';

export function WiringPanel() {
  const { project, running, details } = useHub();
  const [filter, setFilter] = useState<'all' | 'signal' | 'power' | 'ground'>('all');
  const [showAll, setShowAll] = useState(false);

  const wiring = project?.wiring ?? null;
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const selection of project?.components ?? []) {
      for (const instance of selection.instances) map.set(instance.instanceId, instance.label ?? instance.name);
    }
    return map;
  }, [project?.components]);

  if (!wiring) {
    return (
      <Card title="Wiring & Pins" wide count="none yet">
        {running ? (
          <Loader label="Planning the pins and how everything connects" />
        ) : (
          <Empty>No wiring was produced for this build.</Empty>
        )}
      </Card>
    );
  }

  const connections = wiring.connections;
  const visible = connections.filter((connection) => filter === 'all' || connection.kind === filter);
  const shown = showAll ? visible : visible.slice(0, 30);
  const controllerInstanceId = project?.hardwarePlan?.controller?.instanceId;

  const counts = {
    signal: connections.filter((connection) => connection.kind === 'signal').length,
    power: connections.filter((connection) => connection.kind === 'power').length,
    ground: connections.filter((connection) => connection.kind === 'ground').length,
  };

  return (
    <Card
      title="Wiring & Pins"
      wide
      count={`${connections.length} connections`}
      actions={details ? <DownloadButton filename="wiring.json" content={JSON.stringify(wiring, null, 2)} label="wiring.json" /> : undefined}
      footer={
        <span>
          {counts.signal} signal · {counts.power} power · {counts.ground} ground
        </span>
      }
    >
      <WiringGraph connections={connections} controllerInstanceId={controllerInstanceId} labels={labels} filter={filter} />

      <div className="legend">
        <span className="legend__item">
          <span className="legend__swatch" style={{ background: '#1565c0' }} /> signal
        </span>
        <span className="legend__item">
          <span className="legend__swatch" style={{ background: '#c62828' }} /> power
        </span>
        <span className="legend__item">
          <span className="legend__swatch" style={{ background: '#212121' }} /> ground
        </span>
      </div>

      {details && wiring.conflicts.length > 0 ? (
        <>
          <SectionTitle>Wiring conflicts ({wiring.conflicts.length})</SectionTitle>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>message</th>
                  <th>suggestion</th>
                </tr>
              </thead>
              <tbody>
                {wiring.conflicts.map((conflict) => (
                  <tr key={conflict.id}>
                    <td className="small">{conflict.message}</td>
                    <td className="small muted">{conflict.suggestion ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <SectionTitle>Connections</SectionTitle>
      <div className="filters">
        {(['all', 'signal', 'power', 'ground'] as const).map((option) => (
          <button key={option} type="button" className={filter === option ? 'filter filter--active' : 'filter'} onClick={() => setFilter(option)}>
            {option}
          </button>
        ))}
        <span className="card__spacer" style={{ flex: 1 }} />
        <span className="faint mono-sm">{(shown.length === visible.length ? visible.length : shown.length) || 0} in view</span>
      </div>

      {shown.length === 0 ? (
        <Empty>No {filter === 'all' ? '' : `${filter} `}connections to show.</Empty>
      ) : (
        shown.map((connection) => (
          <div className="wire" key={connection.id}>
            <span className="wire__end">
              <span className="wire__inst">{labels.get(connection.from.instanceId) ?? connection.from.instanceId}</span> <span className="wire__pin">{connection.from.pin}</span>
            </span>
            <span className="wire__link">
              <span className="wire__swatch" style={{ background: connection.wireColor ?? '#a1a1aa' }} />
            </span>
            <span className="wire__end wire__end--to">
              <span className="wire__pin">{connection.to.pin}</span> <span className="wire__inst">{labels.get(connection.to.instanceId) ?? connection.to.instanceId}</span>
            </span>
            <span className="wire__why">
              <Badge>{connection.kind}</Badge> <Badge>{connection.signal}</Badge>
              {connection.voltage !== undefined ? <Badge tone="info">{connection.voltage} V</Badge> : null}
              {connection.explanation}
            </span>
          </div>
        ))
      )}

      {visible.length > shown.length ? (
        <button type="button" className="btn btn--sm" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>
          show all {visible.length} connections
        </button>
      ) : null}
      {showAll ? (
        <button type="button" className="btn btn--sm" style={{ marginTop: 8 }} onClick={() => setShowAll(false)}>
          show fewer
        </button>
      ) : null}

      {details && wiring.nets.length > 0 ? (
        <>
          <SectionTitle>Nets</SectionTitle>
          {wiring.nets.map((net) => (
            <div className="net" key={net.id}>
              <span className="net__name">{net.name}</span>
              <Badge>{net.kind}</Badge>
              {net.voltage !== undefined ? <Badge tone="info">{net.voltage} V</Badge> : null}
              <span className="net__members">{net.members.map((member) => `${member.instanceId}.${member.pin}`).join('  ·  ')}</span>
            </div>
          ))}
        </>
      ) : null}
    </Card>
  );
}
