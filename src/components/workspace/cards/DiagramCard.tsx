'use client';

/**
 * DIAGRAM card — renders `diagram.json` (machine readable: unique ids, layout
 * coordinates, pin anchors, routed wires) and can project it into the Wokwi
 * simulator format, reporting honestly what cannot be represented.
 */

import { useCallback, useState } from 'react';

import type { Diagram, DiagramComponent } from '@/types/diagram';

import { Badge, Card, CopyButton, DownloadButton, Empty, Loader, Notice, SectionTitle } from '../ui';
import { CodeView } from '../syntax';
import { fetchDiagram, type DiagramPayload } from '../api';
import { plural, type CardProps } from './types';

type Tab = 'diagram' | 'json' | 'wokwi';

const FALLBACK_COLOR = '#52525b';

function pinAnchor(component: DiagramComponent, pinName: string): { x: number; y: number } {
  const pin = component.pins.find((entry) => entry.name === pinName);
  if (pin && typeof pin.x === 'number' && typeof pin.y === 'number') return { x: pin.x, y: pin.y };
  return { x: component.x + component.width / 2, y: component.y + component.height / 2 };
}

function DiagramCanvas({ diagram }: { diagram: Diagram }) {
  const byId = new Map(diagram.components.map((component) => [component.id, component]));
  const width = Math.max(360, diagram.layout.width);
  const height = Math.max(240, diagram.layout.height);

  return (
    <div className="diagram">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={diagram.meta.title}>
        {diagram.groups.map((group) => {
          const members = group.memberIds.map((id) => byId.get(id)).filter((entry): entry is DiagramComponent => Boolean(entry));
          if (members.length === 0) return null;
          const minX = Math.min(...members.map((member) => member.x)) - 8;
          const minY = Math.min(...members.map((member) => member.y)) - 16;
          const maxX = Math.max(...members.map((member) => member.x + member.width)) + 8;
          const maxY = Math.max(...members.map((member) => member.y + member.height)) + 8;
          return (
            <g key={group.id}>
              <rect
                x={minX}
                y={minY}
                width={Math.max(10, maxX - minX)}
                height={Math.max(10, maxY - minY)}
                rx={5}
                fill="none"
                stroke="#d1d1d6"
                strokeDasharray="4 3"
              />
              <text className="diagram__sub" x={minX + 4} y={minY + 11}>
                {group.name}
              </text>
            </g>
          );
        })}

        {diagram.connections.map((connection) => {
          const from = byId.get(connection.from.component);
          const to = byId.get(connection.to.component);
          if (!from || !to) return null;
          const start = pinAnchor(from, connection.from.pin);
          const end = pinAnchor(to, connection.to.pin);
          const points = connection.path && connection.path.length >= 2 ? connection.path : [start, end];
          const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
          return (
            <g key={connection.id}>
              <path className="diagram__wire" d={d} stroke={connection.wireColor ?? FALLBACK_COLOR}>
                <title>{`${connection.from.component}.${connection.from.pin} → ${connection.to.component}.${connection.to.pin} (${connection.kind}/${connection.signal})`}</title>
              </path>
              <circle cx={start.x} cy={start.y} r={2.4} fill={connection.wireColor ?? FALLBACK_COLOR} />
              <circle cx={end.x} cy={end.y} r={2.4} fill={connection.wireColor ?? FALLBACK_COLOR} />
            </g>
          );
        })}

        {diagram.components.map((component) => {
          const isMcu = component.category === 'microcontroller';
          return (
            <g key={component.id}>
              <rect
                className={isMcu ? 'diagram__part diagram__part--mcu' : 'diagram__part'}
                x={component.x}
                y={component.y}
                width={component.width}
                height={component.height}
                rx={3}
              />
              <text
                className={isMcu ? 'diagram__label diagram__label--mcu' : 'diagram__label'}
                x={component.x + 7}
                y={component.y + 14}
              >
                {component.label ?? component.name}
              </text>
              <text className={isMcu ? 'diagram__sub diagram__label--mcu' : 'diagram__sub'} x={component.x + 7} y={component.y + 25}>
                {component.id}
              </text>
              {component.pins.map((pin) =>
                typeof pin.x === 'number' && typeof pin.y === 'number' ? (
                  <g key={`${component.id}-${pin.name}`}>
                    <circle className="diagram__pin-dot" cx={pin.x} cy={pin.y} r={2.2} />
                    <text
                      className={isMcu ? 'diagram__pin diagram__label--mcu' : 'diagram__pin'}
                      x={pin.x <= component.x + component.width / 2 ? pin.x - 5 : pin.x + 5}
                      y={pin.y + 3}
                      textAnchor={pin.x <= component.x + component.width / 2 ? 'end' : 'start'}
                    >
                      {pin.label ?? pin.name}
                    </text>
                  </g>
                ) : null,
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function DiagramCard({ project, running, activity }: CardProps) {
  const diagram = project?.artifacts.diagram ?? null;
  const [tab, setTab] = useState<Tab>('diagram');
  const [wokwi, setWokwi] = useState<DiagramPayload | null>(null);
  const [wokwiState, setWokwiState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [wokwiError, setWokwiError] = useState<string | null>(null);

  const loadWokwi = useCallback(async () => {
    if (!project) return;
    setWokwiState('loading');
    setWokwiError(null);
    try {
      const payload = await fetchDiagram(project.id, 'wokwi');
      setWokwi(payload);
      setWokwiState('idle');
    } catch (error) {
      setWokwiState('error');
      setWokwiError(error instanceof Error ? error.message : String(error));
    }
  }, [project]);

  if (!diagram) {
    return (
      <Card title="Diagram" wide count="diagram.json">
        {running ? (
          <Loader label="Laying out diagram.json from the wiring graph" detail={activity} />
        ) : (
          <Empty>No diagram was generated.</Empty>
        )}
      </Card>
    );
  }

  const wokwiJson = wokwi ? JSON.stringify(wokwi.diagram, null, 2) : '';

  return (
    <Card
      title="Diagram"
      wide
      count={`${plural(diagram.stats.components, 'part')} · ${plural(diagram.stats.connections, 'wire')}`}
      actions={
        <span className="row row--tight">
          <button
            type="button"
            className={tab === 'diagram' ? 'filter filter--active' : 'filter'}
            onClick={() => setTab('diagram')}
          >
            canvas
          </button>
          <button type="button" className={tab === 'json' ? 'filter filter--active' : 'filter'} onClick={() => setTab('json')}>
            diagram.json
          </button>
          <button
            type="button"
            className={tab === 'wokwi' ? 'filter filter--active' : 'filter'}
            onClick={() => {
              setTab('wokwi');
              if (!wokwi && wokwiState !== 'loading') void loadWokwi();
            }}
          >
            wokwi
          </button>
          {tab === 'json' ? (
            <DownloadButton filename="wireup-diagram.json" content={JSON.stringify(diagram, null, 2)} label="download" />
          ) : null}
          {tab === 'wokwi' && wokwiJson ? <DownloadButton filename="diagram.json" content={wokwiJson} label="download diagram.json" /> : null}
        </span>
      }
      footer={
        <span>
          format <span className="mono-sm">{diagram.format}</span> v{diagram.version} · revision v{diagram.revision} ·{' '}
          {diagram.layout.width}×{diagram.layout.height}px · grid {diagram.meta.gridSize}px · target {diagram.meta.simulatorTarget}
        </span>
      }
    >
      {tab === 'diagram' ? (
        <>
          <DiagramCanvas diagram={diagram} />
          <div className="legend">
            <span className="legend__item">
              <span className="legend__swatch" style={{ background: '#c62828' }} /> power
            </span>
            <span className="legend__item">
              <span className="legend__swatch" style={{ background: '#212121' }} /> ground
            </span>
            <span className="legend__item">
              <span className="legend__swatch" style={{ background: '#1565c0' }} /> signal
            </span>
            <span className="legend__item faint">
              {diagram.stats.pins} pin anchors · {diagram.layout.columns} column(s) · {diagram.layout.rows} row(s)
            </span>
          </div>

          {diagram.rails.length > 0 ? (
            <>
              <SectionTitle>Rails</SectionTitle>
              {diagram.rails.map((rail) => (
                <div className="net" key={rail.id}>
                  <span className="net__name">{rail.name}</span>
                  <Badge tone={rail.kind === 'power' ? 'err' : 'neutral'}>{rail.kind}</Badge>
                  {rail.voltage !== undefined ? <Badge tone="info">{rail.voltage} V</Badge> : null}
                  <span className="net__members">{rail.members.map((member) => `${member.component}.${member.pin}`).join(' · ')}</span>
                </div>
              ))}
            </>
          ) : null}

          {diagram.groups.length > 0 ? (
            <>
              <SectionTitle>Groups</SectionTitle>
              <ul className="list list--tight">
                {diagram.groups.map((group) => (
                  <li key={group.id} className="small">
                    <strong>{group.name}</strong>{' '}
                    <span className="faint mono-sm">({group.memberIds.join(', ')})</span>
                    {group.description ? <span className="muted"> — {group.description}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <SectionTitle>Parts</SectionTitle>
          <div className="table-wrap">
            <table className="table table--mono">
              <thead>
                <tr>
                  <th>id</th>
                  <th>ref</th>
                  <th>type</th>
                  <th className="num">x</th>
                  <th className="num">y</th>
                  <th className="num">pins</th>
                  <th>simulator</th>
                </tr>
              </thead>
              <tbody>
                {diagram.components.map((component) => (
                  <tr key={component.id}>
                    <td>{component.id}</td>
                    <td>{component.ref}</td>
                    <td>{component.type}</td>
                    <td className="num">{component.x}</td>
                    <td className="num">{component.y}</td>
                    <td className="num">{component.pins.length}</td>
                    <td>
                      {component.simulator?.part ? (
                        <Badge tone={component.simulator.supported === false ? 'warn' : 'ok'}>{component.simulator.part}</Badge>
                      ) : (
                        <span className="faint">none</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'json' ? (
        <>
          <div className="code__toolbar">
            <span className="mono-sm">diagram.json</span>
            <Badge>json</Badge>
            <span className="card__spacer" style={{ flex: 1 }} />
            <CopyButton text={JSON.stringify(diagram, null, 2)} label="copy" />
          </div>
          <CodeView content={JSON.stringify(diagram, null, 2)} language="json" maxHeight={520} />
        </>
      ) : null}

      {tab === 'wokwi' ? (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            This is the file to load into the Wokwi simulator (save it as <span className="mono-sm">diagram.json</span> next to{' '}
            <span className="mono-sm">sketch.ino</span>). The <em>diagram.json</em> tab is Wireup&apos;s own richer format and is not understood by Wokwi.
          </p>
          <div className="row" style={{ marginBottom: 8 }}>
            <button type="button" className="btn btn--sm" onClick={() => void loadWokwi()} disabled={wokwiState === 'loading'}>
              {wokwiState === 'loading' ? 'projecting…' : wokwi ? 're-project' : 'project to wokwi diagram.json'}
            </button>
            <span className="faint small">GET /api/projects/{project?.id}/diagram?target=wokwi</span>
          </div>

          {wokwiState === 'loading' ? <Loader label="Projecting the diagram into the Wokwi format" /> : null}
          {wokwiState === 'error' ? <Notice tone="err" title="Projection failed">{wokwiError}</Notice> : null}

          {wokwi ? (
            <>
              {wokwi.warnings && wokwi.warnings.length > 0 ? (
                <Notice tone="warn" title={`${wokwi.warnings.length} projection warning(s)`}>
                  <ul className="list list--tight" style={{ margin: 0 }}>
                    {wokwi.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}

              <Kvish
                parts={(wokwi.diagram as { parts?: unknown[] })?.parts?.length ?? 0}
                connections={(wokwi.diagram as { connections?: unknown[] })?.connections?.length ?? 0}
                skippedParts={wokwi.skippedParts?.length ?? 0}
                skippedConnections={wokwi.skippedConnections?.length ?? 0}
              />

              {wokwi.skippedParts && wokwi.skippedParts.length > 0 ? (
                <>
                  <SectionTitle>Parts Wokwi cannot represent</SectionTitle>
                  <ul className="list list--tight">
                    {wokwi.skippedParts.map((part) => (
                      <li key={part.id} className="small">
                        <span className="mono-sm">{part.id}</span> ({part.ref}) — <span className="muted">{part.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {wokwi.skippedConnections && wokwi.skippedConnections.length > 0 ? (
                <>
                  <SectionTitle>Wires skipped</SectionTitle>
                  <ul className="list list--tight">
                    {wokwi.skippedConnections.map((connection) => (
                      <li key={connection.id} className="small">
                        <span className="mono-sm">{connection.id}</span> — <span className="muted">{connection.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              <div className="code__toolbar" style={{ marginTop: 10 }}>
                <span className="mono-sm">wokwi diagram.json</span>
                <Badge>json</Badge>
                <span className="card__spacer" style={{ flex: 1 }} />
                <CopyButton text={wokwiJson} label="copy" />
              </div>
              <CodeView content={wokwiJson} language="json" maxHeight={420} />
            </>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function Kvish({
  parts,
  connections,
  skippedParts,
  skippedConnections,
}: {
  parts: number;
  connections: number;
  skippedParts: number;
  skippedConnections: number;
}) {
  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <Badge tone="ok">{plural(parts, 'part')} mapped</Badge>
      <Badge tone="ok">{plural(connections, 'wire')} mapped</Badge>
      <Badge tone={skippedParts > 0 ? 'warn' : 'neutral'}>{plural(skippedParts, 'part')} skipped</Badge>
      <Badge tone={skippedConnections > 0 ? 'warn' : 'neutral'}>{plural(skippedConnections, 'wire')} skipped</Badge>
    </div>
  );
}
