'use client';

/**
 * WIRING card — the connection graph rendered from structured data only.
 *
 * The visualisation is computed from `project.wiring.connections` and the pin
 * assignments: nothing about the topology is hardcoded, so an RC car, a sensor
 * node and a stepper rig all draw themselves.
 */

import { useMemo, useState } from 'react';

import type { WiringConnection } from '@/types/wiring';

import { Badge, Card, DownloadButton, Empty, Loader, SectionTitle } from '../ui';
import { plural, type CardProps } from './types';

const ROW = 17;
const LEFT_X = 190;
const RIGHT_X = 430;
const WIDTH = 620;
const TOP = 26;

type Filter = 'all' | 'signal' | 'power' | 'ground';

interface GraphModel {
  width: number;
  height: number;
  controller: { instanceId: string; label: string; pins: { pin: string; y: number }[] };
  peripherals: { instanceId: string; label: string; x: number; y: number; height: number; pins: { pin: string; y: number }[] }[];
  paths: { id: string; d: string; color: string; title: string; kind: string }[];
}

function buildGraph(connections: WiringConnection[], controllerInstanceId: string | undefined, labels: Map<string, string>): GraphModel | null {
  if (connections.length === 0) return null;

  const controllerId = controllerInstanceId ?? connections[0]?.from.instanceId ?? '';
  const leftPins: string[] = [];
  const rightOrder: string[] = [];
  const rightPins = new Map<string, string[]>();

  const touch = (instanceId: string, pin: string) => {
    if (instanceId === controllerId) {
      if (!leftPins.includes(pin)) leftPins.push(pin);
      return;
    }
    if (!rightPins.has(instanceId)) {
      rightPins.set(instanceId, []);
      rightOrder.push(instanceId);
    }
    const list = rightPins.get(instanceId) as string[];
    if (!list.includes(pin)) list.push(pin);
  };

  for (const connection of connections) {
    touch(connection.from.instanceId, connection.from.pin);
    touch(connection.to.instanceId, connection.to.pin);
  }

  const leftY = new Map<string, number>();
  leftPins.forEach((pin, index) => leftY.set(`${controllerId}.${pin}`, TOP + 22 + index * ROW));

  const peripherals: GraphModel['peripherals'] = [];
  const rightY = new Map<string, number>();
  let cursorY = TOP + 8;
  for (const instanceId of rightOrder) {
    const pins = rightPins.get(instanceId) ?? [];
    const height = Math.max(30, pins.length * ROW + 20);
    peripherals.push({
      instanceId,
      label: labels.get(instanceId) ?? instanceId,
      x: RIGHT_X,
      y: cursorY,
      height,
      pins: pins.map((pin, index) => {
        const y = cursorY + 18 + index * ROW;
        rightY.set(`${instanceId}.${pin}`, y);
        return { pin, y };
      }),
    });
    cursorY += height + 12;
  }

  const leftHeight = Math.max(40, leftPins.length * ROW + 26);
  const height = Math.max(cursorY, TOP + leftHeight) + 18;

  const paths = connections.map((connection) => {
    const fromKey = `${connection.from.instanceId}.${connection.from.pin}`;
    const toKey = `${connection.to.instanceId}.${connection.to.pin}`;
    const fromX = connection.from.instanceId === controllerId ? LEFT_X : RIGHT_X;
    const toX = connection.to.instanceId === controllerId ? LEFT_X : RIGHT_X;
    const fromY = (connection.from.instanceId === controllerId ? leftY : rightY).get(fromKey) ?? TOP;
    const toY = (connection.to.instanceId === controllerId ? leftY : rightY).get(toKey) ?? TOP;

    let d: string;
    if (fromX !== toX) {
      const midX = (fromX + toX) / 2;
      d = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
    } else {
      const bow = fromX === LEFT_X ? -46 : 46;
      d = `M ${fromX} ${fromY} C ${fromX + bow} ${fromY}, ${toX + bow} ${toY}, ${toX} ${toY}`;
    }

    return {
      id: connection.id,
      d,
      color: connection.wireColor ?? (connection.kind === 'power' ? '#c62828' : connection.kind === 'ground' ? '#212121' : '#1565c0'),
      title: `${connection.from.instanceId}.${connection.from.pin} → ${connection.to.instanceId}.${connection.to.pin} (${connection.kind}, ${connection.signal})`,
      kind: connection.kind,
    };
  });

  return {
    width: WIDTH,
    height,
    controller: {
      instanceId: controllerId,
      label: labels.get(controllerId) ?? controllerId,
      pins: leftPins.map((pin) => ({ pin, y: leftY.get(`${controllerId}.${pin}`) ?? TOP })),
    },
    peripherals,
    paths,
  };
}

function WiringGraph({
  connections,
  controllerInstanceId,
  labels,
}: {
  connections: WiringConnection[];
  controllerInstanceId?: string;
  labels: Map<string, string>;
}) {
  const graph = useMemo(
    () => buildGraph(connections, controllerInstanceId, labels),
    [connections, controllerInstanceId, labels],
  );

  if (!graph) return <Empty>Nothing to draw yet.</Empty>;

  return (
    <div className="diagram">
      <svg width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-label="Wiring graph">
        {graph.paths.map((path) => (
          <path key={path.id} className="diagram__wire" d={path.d} stroke={path.color}>
            <title>{path.title}</title>
          </path>
        ))}

        <g>
          <rect className="diagram__part diagram__part--mcu" x={LEFT_X - 170} y={TOP} width={170} height={Math.max(40, graph.controller.pins.length * ROW + 26)} rx={3} />
          <text className="diagram__label diagram__label--mcu" x={LEFT_X - 162} y={TOP + 15}>
            {graph.controller.label}
          </text>
          {graph.controller.pins.map((pin) => (
            <g key={pin.pin}>
              <circle className="diagram__pin-dot" cx={LEFT_X} cy={pin.y} r={2.6} />
              <text className="diagram__pin diagram__label--mcu" x={LEFT_X - 8} y={pin.y + 3} textAnchor="end">
                {pin.pin}
              </text>
            </g>
          ))}
        </g>

        {graph.peripherals.map((peripheral) => (
          <g key={peripheral.instanceId}>
            <rect className="diagram__part" x={peripheral.x} y={peripheral.y} width={170} height={peripheral.height} rx={3} />
            <text className="diagram__label" x={peripheral.x + 8} y={peripheral.y + 13}>
              {peripheral.label.length > 26 ? `${peripheral.label.slice(0, 25)}…` : peripheral.label}
            </text>
            <text className="diagram__sub" x={peripheral.x + 8} y={peripheral.y + peripheral.height - 5}>
              {peripheral.instanceId}
            </text>
            {peripheral.pins.map((pin) => (
              <g key={pin.pin}>
                <circle className="diagram__pin-dot" cx={peripheral.x} cy={pin.y} r={2.6} />
                <text className="diagram__pin" x={peripheral.x + 8} y={pin.y + 3}>
                  {pin.pin}
                </text>
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function WiringCard({ project, running, activity }: CardProps) {
  const wiring = project?.wiring ?? null;
  const [filter, setFilter] = useState<Filter>('all');
  const [showAll, setShowAll] = useState(false);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const selection of project?.components ?? []) {
      for (const instance of selection.instances) map.set(instance.instanceId, instance.label ?? instance.name);
    }
    return map;
  }, [project?.components]);

  if (!wiring) {
    return (
      <Card title="Wiring" wide count="0 wires">
        {running ? (
          <Loader label="Planning pins, nets and the connection graph" detail={activity} />
        ) : (
          <Empty>No wiring graph was produced.</Empty>
        )}
      </Card>
    );
  }

  const connections = wiring.connections;
  const counts = {
    signal: connections.filter((connection) => connection.kind === 'signal').length,
    power: connections.filter((connection) => connection.kind === 'power').length,
    ground: connections.filter((connection) => connection.kind === 'ground').length,
  };
  const visible = connections.filter((connection) => filter === 'all' || connection.kind === filter);
  const shown = showAll ? visible : visible.slice(0, 40);
  const controllerInstanceId = project?.hardwarePlan?.controller?.instanceId;

  return (
    <Card
      title="Wiring"
      wide
      count={`${plural(connections.length, 'wire')} · ${plural(wiring.nets.length, 'net')}`}
      actions={
        <DownloadButton filename="wiring.json" content={JSON.stringify(wiring, null, 2)} label="wiring.json" />
      }
      footer={
        <span>
          {counts.signal} signal · {counts.power} power · {counts.ground} ground · generated {wiring.generatedAt}
        </span>
      }
    >
      <WiringGraph connections={connections} controllerInstanceId={controllerInstanceId} labels={labels} />

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
        <span className="legend__item faint">graph is derived from wiring.connections — never hardcoded</span>
      </div>

      {wiring.conflicts.length > 0 ? (
        <>
          <SectionTitle>Conflicts detected while planning ({wiring.conflicts.length})</SectionTitle>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>code</th>
                  <th>severity</th>
                  <th>message</th>
                  <th>suggestion</th>
                </tr>
              </thead>
              <tbody>
                {wiring.conflicts.map((conflict) => (
                  <tr key={conflict.id}>
                    <td className="mono-sm">{conflict.code}</td>
                    <td>
                      <Badge tone={conflict.severity === 'error' ? 'err' : 'warn'}>{conflict.severity}</Badge>
                    </td>
                    <td className="small">{conflict.message}</td>
                    <td className="small muted">{conflict.suggestion ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <SectionTitle>Nets</SectionTitle>
      {wiring.nets.length > 0 ? (
        wiring.nets.map((net) => (
          <div className="net" key={net.id}>
            <span className="net__name">{net.name}</span>
            <Badge>{net.kind}</Badge>
            {net.voltage !== undefined ? <Badge tone="info">{net.voltage} V</Badge> : null}
            <span className="net__members">{net.members.map((member) => `${member.instanceId}.${member.pin}`).join('  ·  ')}</span>
          </div>
        ))
      ) : (
        <Empty>No nets resolved.</Empty>
      )}

      <SectionTitle>Connections</SectionTitle>
      <div className="filters">
        {(['all', 'signal', 'power', 'ground'] as Filter[]).map((option) => (
          <button
            key={option}
            type="button"
            className={filter === option ? 'filter filter--active' : 'filter'}
            onClick={() => setFilter(option)}
          >
            {option}
          </button>
        ))}
        <span className="card__spacer" style={{ flex: 1 }} />
        <span className="faint mono-sm">{plural(visible.length, 'wire')} in view</span>
      </div>

      {shown.map((connection) => (
        <div className="wire" key={connection.id}>
          <span className="wire__end">
            <span className="wire__inst">{labels.get(connection.from.instanceId) ?? connection.from.instanceId}</span>{' '}
            <span className="wire__pin">{connection.from.pin}</span>
          </span>
          <span className="wire__link">
            <span className="wire__swatch" style={{ background: connection.wireColor ?? '#a1a1aa' }} />
          </span>
          <span className="wire__end wire__end--to">
            <span className="wire__pin">{connection.to.pin}</span>{' '}
            <span className="wire__inst">{labels.get(connection.to.instanceId) ?? connection.to.instanceId}</span>
          </span>
          <span className="wire__why">
            <Badge>{connection.kind}</Badge> <Badge>{connection.signal}</Badge>{' '}
            {connection.voltage !== undefined ? <Badge tone="info">{connection.voltage} V</Badge> : null}{' '}
            <Badge tone={connection.source === 'fixer' ? 'warn' : 'neutral'}>{connection.source}</Badge> {connection.explanation}
          </span>
        </div>
      ))}

      {visible.length > shown.length ? (
        <button type="button" className="btn btn--sm" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>
          show all {visible.length} wires
        </button>
      ) : null}

      {wiring.notes.length > 0 ? (
        <>
          <SectionTitle>Planner notes</SectionTitle>
          <ul className="list list--tight">
            {wiring.notes.map((note) => (
              <li key={note} className="small muted">
                {note}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
