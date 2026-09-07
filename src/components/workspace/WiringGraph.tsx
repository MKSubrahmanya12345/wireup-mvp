'use client';

/**
 * Connection graph, derived from structured data only.
 *
 * Everything about the topology is computed from `WiringConnection[]` and the
 * instance labels — nothing is hardcoded to a particular project. Rendering is
 * pure SVG (no external library), and every edge carries a `<title>` so the
 * relationship is readable on hover.
 */

import { useMemo } from 'react';

import type { WiringConnection } from '@/types/wiring';

import { Empty } from './ui';

const ROW = 17;
const LEFT_X = 190;
const RIGHT_X = 430;
const WIDTH = 620;
const TOP = 26;

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

export function WiringGraph({
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
