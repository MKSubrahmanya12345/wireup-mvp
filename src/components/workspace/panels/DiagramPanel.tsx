'use client';

/**
 * DIAGRAM — the picture of your build plus the file to load into a simulator.
 * The canvas is front and centre; the per-part coordinate table and raw JSON are
 * only shown under "details". "Open in Wokwi" projects the diagram into the
 * simulator format on demand.
 */

import { useCallback, useState } from 'react';

import type { Diagram, DiagramComponent } from '@/types/diagram';

import { Badge, Card, CopyButton, DownloadButton, Empty, Loader, Notice, SectionTitle } from '../ui';
import { CodeView } from '../syntax';
import { fetchDiagram, type DiagramPayload } from '../api';
import { plural } from '@/lib/project-presentation';
import { useHub } from '../hub-context';

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
              <rect x={minX} y={minY} width={Math.max(10, maxX - minX)} height={Math.max(10, maxY - minY)} rx={5} fill="none" stroke="#d1d1d6" strokeDasharray="4 3" />
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
              <rect className={isMcu ? 'diagram__part diagram__part--mcu' : 'diagram__part'} x={component.x} y={component.y} width={component.width} height={component.height} rx={3} />
              <text className={isMcu ? 'diagram__label diagram__label--mcu' : 'diagram__label'} x={component.x + 7} y={component.y + 14}>
                {component.label ?? component.name}
              </text>
              <text className={isMcu ? 'diagram__sub diagram__label--mcu' : 'diagram__sub'} x={component.x + 7} y={component.y + 25}>
                {component.id}
              </text>
              {component.pins.map((pin) =>
                typeof pin.x === 'number' && typeof pin.y === 'number' ? (
                  <g key={`${component.id}-${pin.name}`}>
                    <circle className="diagram__pin-dot" cx={pin.x} cy={pin.y} r={2.2} />
                    <text className={isMcu ? 'diagram__pin diagram__label--mcu' : 'diagram__pin'} x={pin.x <= component.x + component.width / 2 ? pin.x - 5 : pin.x + 5} y={pin.y + 3} textAnchor={pin.x <= component.x + component.width / 2 ? 'end' : 'start'}>
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

export function DiagramPanel() {
  const { project, running, details } = useHub();
  const diagram = project?.artifacts.diagram ?? null;
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
      <Card title="Diagram & simulator" wide count="none yet">
        {running ? (
          <Loader label="Drawing the diagram" />
        ) : (
          <Empty>No diagram was generated for this build.</Empty>
        )}
      </Card>
    );
  }

  const wokwiJson = wokwi ? JSON.stringify(wokwi.diagram, null, 2) : '';

  return (
    <Card
      title="Diagram & simulator"
      wide
      count={`${diagram.stats.components} parts · ${diagram.stats.connections} wires`}
      actions={
        <span className="row row--tight">
          <button type="button" className="btn btn--sm" onClick={() => void loadWokwi()} disabled={wokwiState === 'loading'}>
            {wokwiState === 'loading' ? 'projecting…' : wokwi ? 're-project' : 'open in Wokwi'}
          </button>
          {details && wokwiJson ? <CopyButton text={wokwiJson} label="copy" /> : null}
        </span>
      }
      footer={
        <span>
          {diagram.stats.pins} pin anchors · {diagram.layout.width}×{diagram.layout.height}px
          {details ? ` · format ${diagram.format} v${diagram.version} · revision v${diagram.revision}` : ''}
        </span>
      }
    >
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
      </div>

      {wokwiState === 'loading' ? <Loader label="Projecting the diagram into the Wokwi format" /> : null}
      {wokwiState === 'error' ? <Notice tone="err" title="Projection failed">{wokwiError}</Notice> : null}

      {wokwi ? (
        <>
          {wokwi.warnings && wokwi.warnings.length > 0 ? (
            <Notice tone="warn" title={`${wokwi.warnings.length} thing${wokwi.warnings.length === 1 ? '' : 's'} Wokwi couldn't represent`}>
              <ul className="list list--tight" style={{ margin: 0 }}>
                {wokwi.warnings.map((warning) => (
                  <li key={warning} className="small">
                    {warning}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : (
            <p className="small muted" style={{ marginTop: 8 }}>
              Save this as <span className="mono-sm">diagram.json</span> next to your <span className="mono-sm">sketch.ino</span> and open it in the Wokwi simulator.
            </p>
          )}
          {details && wokwiJson ? (
            <div className="code__toolbar" style={{ marginTop: 10 }}>
              <span className="mono-sm">wokwi diagram.json</span>
              <Badge>json</Badge>
              <span className="card__spacer" style={{ flex: 1 }} />
              <DownloadButton filename="diagram.json" content={wokwiJson} label="download" />
            </div>
          ) : null}
          {details && wokwiJson ? <CodeView content={wokwiJson} language="json" maxHeight={420} /> : null}
        </>
      ) : null}

      {details ? (
        <>
          <SectionTitle>Parts</SectionTitle>
          <div className="table-wrap">
            <table className="table table--mono">
              <thead>
                <tr>
                  <th>id</th>
                  <th>type</th>
                  <th className="num">x</th>
                  <th className="num">y</th>
                  <th className="num">pins</th>
                </tr>
              </thead>
              <tbody>
                {diagram.components.map((component) => (
                  <tr key={component.id}>
                    <td>{component.id}</td>
                    <td>{component.type}</td>
                    <td className="num">{component.x}</td>
                    <td className="num">{component.y}</td>
                    <td className="num">{plural(component.pins.length, 'pin')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SectionTitle>Raw diagram</SectionTitle>
          <CodeView content={JSON.stringify(diagram, null, 2)} language="json" maxHeight={420} />
        </>
      ) : null}
    </Card>
  );
}
