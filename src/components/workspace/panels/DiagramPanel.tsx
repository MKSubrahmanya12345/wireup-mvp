'use client';

/**
 * DIAGRAM — the picture of your build plus the file to load into a simulator.
 * The canvas is front and centre, and the generated simulator `diagram.json`
 * is visible as soon as the canonical diagram exists. The per-part coordinate
 * table and richer Wireup graph remain under "details"; the simulator
 * projection is never hidden behind that switch or a second user action.
 */

import { useCallback, useEffect, useState } from 'react';

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
  const projectId = project?.id ?? null;
  const revision = project?.revision ?? 0;
  const diagram = project?.artifacts.diagram ?? null;
  const [wokwi, setWokwi] = useState<DiagramPayload | null>(null);
  const [wokwiState, setWokwiState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [wokwiError, setWokwiError] = useState<string | null>(null);

  const loadWokwi = useCallback(async () => {
    if (!projectId) return;
    setWokwiState('loading');
    setWokwiError(null);
    try {
      const payload = await fetchDiagram(projectId, 'wokwi');
      setWokwi(payload);
      setWokwiState('idle');
    } catch (error) {
      setWokwiState('error');
      setWokwiError(error instanceof Error ? error.message : String(error));
    }
  }, [projectId]);

  // `diagram.json` is a generated artifact, not a hidden "open in simulator"
  // side effect. Build the projection automatically whenever a new revision
  // arrives, so the file is present even if the user never touches a button.
  useEffect(() => {
    if (!projectId || !diagram) {
      setWokwi(null);
      setWokwiState('idle');
      setWokwiError(null);
      return;
    }
    setWokwi(null);
    void loadWokwi();
  }, [diagram ? true : false, projectId, revision, loadWokwi]);

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

  const canonicalJson = JSON.stringify(diagram, null, 2);
  const wokwiJson = wokwi ? JSON.stringify(wokwi.diagram, null, 2) : '';

  return (
    <Card
      title="Diagram & simulator"
      wide
      count={`${diagram.stats.components} parts · ${diagram.stats.connections} wires`}
      actions={
        <span className="row row--tight">
          <button type="button" className="btn btn--sm" onClick={() => void loadWokwi()} disabled={wokwiState === 'loading'}>
            {wokwiState === 'loading' ? 'building…' : 'refresh diagram.json'}
          </button>
          {wokwiJson ? <CopyButton text={wokwiJson} label="copy" /> : null}
          {wokwiJson ? <DownloadButton filename="diagram.json" content={wokwiJson} label="download" /> : null}
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

      <section className="diagram__export" aria-label="Canonical generated diagram">
        <div className="code__toolbar">
          <span className="mono-sm">canonical source graph</span>
          <Badge tone="ok">diagram.json</Badge>
          <Badge>Wireup format</Badge>
          <span className="card__spacer" style={{ flex: 1 }} />
          <CopyButton text={canonicalJson} label="copy" />
          <DownloadButton filename="wireup-diagram.json" content={canonicalJson} label="download" />
        </div>
        <p className="small muted" style={{ margin: '8px 0' }}>
          This is the authoritative generated graph: the selected controller, every drive motor, motor driver, power
          source and planned connection remain here even when a simulator target cannot model a physical part.
        </p>
        <CodeView content={canonicalJson} language="json" maxHeight={360} />
      </section>

      {wokwiState === 'loading' ? <Loader label="Generating simulator diagram.json in the Wokwi format" /> : null}
      {wokwiState === 'error' ? <Notice tone="err" title="Could not generate diagram.json">{wokwiError}</Notice> : null}

      <section className="diagram__export" aria-label="Generated diagram.json">
        <div className="code__toolbar">
          <span className="mono-sm">generated file</span>
          <Badge tone={wokwiJson ? 'ok' : 'neutral'}>diagram.json</Badge>
          <Badge>Wokwi format</Badge>
          <span className="card__spacer" style={{ flex: 1 }} />
          {wokwiJson ? <CopyButton text={wokwiJson} label="copy" /> : null}
          {wokwiJson ? <DownloadButton filename="diagram.json" content={wokwiJson} label="download" /> : null}
        </div>

        {wokwi ? (
          <>
            <p className="small muted" style={{ margin: '8px 0' }}>
              Generated automatically from the canonical Wireup graph at revision {wokwi.revision}. It contains only
              verified native Wokwi parts; anything the target cannot simulate is listed below rather than replaced.
            </p>
            {wokwi.warnings && wokwi.warnings.length > 0 ? (
              <Notice tone="warn" title={`${wokwi.warnings.length} simulator note${wokwi.warnings.length === 1 ? '' : 's'}`}>
                <ul className="list list--tight" style={{ margin: 0 }}>
                  {wokwi.warnings.map((warning) => (
                    <li key={warning} className="small">
                      {warning}
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : (
              <Notice tone="ok" title="diagram.json generated">
                Save or download this file next to <span className="mono-sm">sketch.ino</span> and open it in Wokwi.
              </Notice>
            )}
            <div className="row row--tight" style={{ margin: '10px 0 6px' }}>
              <Badge>{Array.isArray((wokwi.diagram as { parts?: unknown[] }).parts) ? (wokwi.diagram as { parts: unknown[] }).parts.length : 0} native parts</Badge>
              <Badge>{Array.isArray((wokwi.diagram as { connections?: unknown[] }).connections) ? (wokwi.diagram as { connections: unknown[] }).connections.length : 0} wires</Badge>
              {(wokwi.cadBench?.length ?? 0) > 0 ? (
                <Badge tone="neutral">{wokwi.cadBench?.length} parts carried as CAD bench</Badge>
              ) : null}
              {(wokwi.skippedParts?.filter((part) => part.carriedAs !== 'cad-bench').length ?? 0) > 0 ? (
                <Badge tone="warn">
                  {wokwi.skippedParts?.filter((part) => part.carriedAs !== 'cad-bench').length} parts omitted honestly
                </Badge>
              ) : null}
              {(wokwi.skippedConnections?.length ?? 0) > 0 ? <Badge tone="warn">{wokwi.skippedConnections?.length} wires omitted</Badge> : null}
            </div>
            {(wokwi.cadBench?.length ?? 0) > 0 ? (
              <div className="small muted" style={{ marginBottom: 10 }}>
                <strong>Carried as CAD bench parts:</strong> a Wokwi file is a closed schema and this build has no
                emulator element for them, so they are not in the file above — but they are not lost either. The
                Velxio canvas and the 3D bench place each one with its real shape, its real pin anchors and its
                wires, marked as having no electrical model.
                <ul className="list list--tight" style={{ margin: '4px 0 0' }}>
                  {wokwi.cadBench?.map((part) => (
                    <li key={part.id}>
                      <span className="mono-sm">{part.ref}</span> — {part.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(wokwi.skippedParts?.filter((part) => part.carriedAs !== 'cad-bench').length ?? 0) > 0 ? (
              <div className="small muted" style={{ marginBottom: 10 }}>
                <strong>Not substituted:</strong>
                <ul className="list list--tight" style={{ margin: '4px 0 0' }}>
                  {wokwi.skippedParts
                    ?.filter((part) => part.carriedAs !== 'cad-bench')
                    .map((part) => (
                      <li key={part.id}>
                        <span className="mono-sm">{part.ref}</span> — {part.reason}
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
            {wokwiJson ? <CodeView content={wokwiJson} language="json" maxHeight={420} /> : null}
          </>
        ) : wokwiState !== 'loading' && !wokwiError ? (
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            The generated file will appear here automatically when the projection is ready.
          </p>
        ) : null}
      </section>

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
        </>
      ) : null}
    </Card>
  );
}
