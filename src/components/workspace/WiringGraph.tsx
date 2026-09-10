'use client';

/**
 * Connection graph, derived from structured data only.
 *
 * Topology comes from `layoutWiring` in the graph kernel (net-banded pin
 * order, lane offsets for parallel wires, a dedicated lane for
 * peripheral↔peripheral runs) — nothing is hardcoded to a particular
 * project. Rendering is pure SVG (no external library), every wire carries
 * a `<title>`, and the kind filter applies to the GRAPH as well as the
 * list, so the picture and the list can never disagree.
 */

import { useMemo } from 'react';

import type { WiringConnection, ConnectionKind } from '@/types/wiring';

import { layoutWiring } from '@/modules/graph';

import { Empty } from './ui';

export function WiringGraph({
  connections,
  controllerInstanceId,
  labels,
  filter = 'all',
}: {
  connections: WiringConnection[];
  controllerInstanceId?: string;
  labels: Map<string, string>;
  filter?: 'all' | ConnectionKind;
}) {
  const graph = useMemo(
    () => layoutWiring(connections, controllerInstanceId, labels, filter),
    [connections, controllerInstanceId, labels, filter],
  );

  if (!graph) return <Empty>Nothing to draw yet.</Empty>;
  if (graph.wires.length === 0) {
    return <Empty>No {filter === 'all' ? '' : `${filter} `}connections to draw{graph.hiddenByFilter > 0 ? ` — ${graph.hiddenByFilter} hidden by the filter` : ''}.</Empty>;
  }

  return (
    <div className="diagram diagram--wiring">
      <svg
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        role="img"
        aria-label={`Wiring graph: ${graph.wires.length} wires`}
        className="diagram--wiring__svg"
      >
        {graph.wires.map((wire) => (
          <path key={wire.id} className="diagram__wire" d={wire.d} stroke={wire.color}>
            <title>{wire.title}</title>
          </path>
        ))}

        <g>
          <rect className="diagram__part diagram__part--mcu" x={graph.controller.x} y={graph.controller.y} width={graph.controller.width} height={graph.controller.height} rx={3} />
          <text className="diagram__label diagram__label--mcu" x={graph.controller.x + 8} y={graph.controller.y + 15}>
            {graph.controller.label}
          </text>
          {graph.controller.pins.map((pin) => (
            <g key={pin.pin}>
              <title>{`${graph.controller.instanceId}.${pin.pin} (${pin.kind}, ${pin.signal})`}</title>
              <circle className="diagram__pin-dot" cx={graph.controller.x + graph.controller.width} cy={pin.y} r={2.6} />
              <text className="diagram__pin diagram__label--mcu" x={graph.controller.x + graph.controller.width - 8} y={pin.y + 3} textAnchor="end">
                {pin.pin}
              </text>
            </g>
          ))}
        </g>

        {graph.peripherals.map((peripheral) => (
          <g key={peripheral.instanceId}>
            <rect className="diagram__part" x={peripheral.x} y={peripheral.y} width={peripheral.width} height={peripheral.height} rx={3} />
            <text className="diagram__label" x={peripheral.x + 8} y={peripheral.y + 13}>
              {peripheral.label.length > 26 ? `${peripheral.label.slice(0, 25)}…` : peripheral.label}
            </text>
            <text className="diagram__sub" x={peripheral.x + 8} y={peripheral.y + peripheral.height - 5}>
              {peripheral.instanceId}
            </text>
            {peripheral.pins.map((pin) => (
              <g key={pin.pin}>
                <title>{`${peripheral.instanceId}.${pin.pin} (${pin.kind}, ${pin.signal})`}</title>
                <circle className="diagram__pin-dot" cx={peripheral.x} cy={pin.y} r={2.6} />
                <text className="diagram__pin" x={peripheral.x + 8} y={pin.y + 3}>
                  {pin.pin}
                </text>
              </g>
            ))}
          </g>
        ))}
      </svg>
      {graph.hiddenByFilter > 0 ? (
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          {graph.hiddenByFilter} connection{graph.hiddenByFilter === 1 ? '' : 's'} hidden by the “{filter}” filter.
        </p>
      ) : null}
    </div>
  );
}
