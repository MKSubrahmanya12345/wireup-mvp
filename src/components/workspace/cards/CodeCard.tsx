'use client';

/**
 * CODE card — the generated firmware (`sketch.ino` and any extra files) plus
 * `libraries.json`. File tabs, syntax highlighting, real line numbers, copy and
 * download. The highlighted view is built from React nodes, so generated code
 * can never inject markup.
 */

import { useMemo, useState } from 'react';

import type { GeneratedCodeFile } from '@/types/project';

import { Badge, Card, CopyButton, DownloadButton, Empty, Loader, SectionTitle } from '../ui';
import { CodeView, languageOf } from '../syntax';
import { formatTime, plural, type CardProps } from './types';

const GENERATED_TONE: Record<GeneratedCodeFile['generatedBy'], 'ok' | 'info' | 'warn'> = {
  model: 'info',
  planner: 'ok',
  fixer: 'warn',
};

type View = 'firmware' | 'libraries';

export function CodeCard({ project, running, activity }: CardProps) {
  const code = project?.artifacts.code ?? null;
  const libraries = project?.artifacts.libraries ?? null;
  const files = code?.files ?? [];
  const [activePath, setActivePath] = useState<string | null>(null);
  const [view, setView] = useState<View>('firmware');

  const active = useMemo(() => {
    if (files.length === 0) return null;
    if (activePath) return files.find((file) => file.path === activePath) ?? files[0] ?? null;
    return files.find((file) => file.path === code?.entryPoint) ?? files[0] ?? null;
  }, [activePath, code?.entryPoint, files]);

  const librariesJson = useMemo(() => (libraries ? JSON.stringify(libraries, null, 2) : ''), [libraries]);

  if (!code && !libraries) {
    return (
      <Card title="Code" wide count="0 files">
        {running ? (
          <Loader label="Writing firmware from the pin plan and software plan" detail={activity} />
        ) : (
          <Empty>No firmware was generated.</Empty>
        )}
      </Card>
    );
  }

  const effectiveView: View = code ? view : 'libraries';
  const lineCount = active ? active.content.split('\n').length : 0;

  const viewToggle = (
    <span className="row row--tight">
      <button
        type="button"
        className={effectiveView === 'firmware' ? 'filter filter--active' : 'filter'}
        onClick={() => setView('firmware')}
        disabled={!code}
      >
        firmware
      </button>
      <button
        type="button"
        className={effectiveView === 'libraries' ? 'filter filter--active' : 'filter'}
        onClick={() => setView('libraries')}
        disabled={!libraries}
      >
        libraries.json
      </button>
    </span>
  );

  return (
    <Card
      title="Code"
      wide
      count={`${plural(files.length, 'file')}${libraries ? ` · ${plural(libraries.libraries.length, 'library', 'libraries')}` : ''}`}
      actions={
        <span className="row row--tight">
          {viewToggle}
          {effectiveView === 'firmware' && active ? (
            <>
              <CopyButton text={active.content} label="copy file" />
              <DownloadButton
                filename={active.path.replace(/[\\/]/g, '_')}
                content={active.content}
                mime="text/plain"
                label="download"
              />
            </>
          ) : null}
          {effectiveView === 'libraries' && librariesJson ? (
            <>
              <CopyButton text={librariesJson} label="copy json" />
              <DownloadButton filename="libraries.json" content={librariesJson} label="download" />
            </>
          ) : null}
        </span>
      }
      footer={
        effectiveView === 'firmware' && code ? (
          <span>
            pin map synchronised: <strong>{code.pinsSynchronised ? 'yes' : 'no'}</strong> · entry point{' '}
            <span className="mono-sm">{code.entryPoint}</span>
          </span>
        ) : (
          <span>
            {libraries ? `${plural(libraries.installCommands.length, 'install command')} · generated ${formatTime(libraries.generatedAt)}` : 'no libraries artifact'}
          </span>
        )
      }
    >
      {effectiveView === 'libraries' ? (
        libraries ? (
          <>
            <div className="code__toolbar">
              <span className="mono-sm">libraries.json</span>
              <Badge>json</Badge>
              <span style={{ flex: 1 }} />
              <span>
                {plural(libraries.libraries.length, 'library', 'libraries')} ·{' '}
                {plural(
                  libraries.libraries.filter((entry) => entry.builtIn).length,
                  'ships with the platform',
                  'ship with the platform',
                )}
              </span>
            </div>
            <CodeView content={librariesJson} language="json" maxHeight={360} />

            <SectionTitle>Libraries</SectionTitle>
            {libraries.libraries.length === 0 ? (
              <Empty>No libraries are declared — the firmware only uses core headers.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>name</th>
                      <th>import</th>
                      <th>manager</th>
                      <th>version</th>
                      <th>why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {libraries.libraries.map((entry) => (
                      <tr key={`${entry.name}-${entry.import}`}>
                        <td>
                          {entry.name}
                          {entry.builtIn ? <Badge tone="ok">built-in</Badge> : null}
                        </td>
                        <td className="mono-sm">{entry.import}</td>
                        <td className="mono-sm">{entry.manager ?? '—'}</td>
                        <td className="mono-sm">{entry.version ?? '—'}</td>
                        <td className="small muted">{entry.purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <SectionTitle>Install</SectionTitle>
            {libraries.installCommands.length === 0 ? (
              <Empty>Nothing to install.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table table--mono">
                  <tbody>
                    {libraries.installCommands.map((command) => (
                      <tr key={command}>
                        <td>{command}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {libraries.notes.length > 0 ? (
              <>
                <SectionTitle>Notes</SectionTitle>
                <ul className="list list--tight">
                  {libraries.notes.map((note) => (
                    <li key={note} className="small muted">
                      {note}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : (
          <Empty>
            {running ? 'libraries.json is generated right after the firmware.' : 'No libraries artifact was generated.'}
          </Empty>
        )
      ) : null}

      {effectiveView === 'firmware' ? (
        <>
          {files.length === 0 || !active || !code ? (
            <Empty>The code artifact is empty.</Empty>
          ) : (
            <div className="code">
              <div className="code__tabs" role="tablist">
                {files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    role="tab"
                    aria-selected={file.path === active.path}
                    className={file.path === active.path ? 'code__tab code__tab--active' : 'code__tab'}
                    onClick={() => setActivePath(file.path)}
                    title={file.purpose}
                  >
                    {file.path}
                    {file.generatedBy === 'fixer' ? <span className="faint"> •</span> : null}
                  </button>
                ))}
              </div>

              <div className="code__toolbar">
                <span className="mono-sm">{active.path}</span>
                <Badge>{active.language || languageOf(active.path)}</Badge>
                <Badge tone={GENERATED_TONE[active.generatedBy] ?? 'neutral'}>generated by {active.generatedBy}</Badge>
                <span style={{ flex: 1 }} />
                <span>
                  {lineCount} lines · {plural(active.content.length, 'char')}
                </span>
              </div>

              <CodeView content={active.content} language={active.language || languageOf(active.path)} />

              {active.purpose ? (
                <p className="small muted" style={{ margin: '8px 0 0' }}>
                  {active.purpose}
                </p>
              ) : null}
            </div>
          )}

          {files.length > 1 ? (
            <>
              <SectionTitle>Files</SectionTitle>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>path</th>
                      <th>language</th>
                      <th>source</th>
                      <th className="num">lines</th>
                      <th>purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((file) => (
                      <tr key={file.path}>
                        <td className="mono-sm">{file.path}</td>
                        <td className="mono-sm">{file.language}</td>
                        <td>
                          <Badge tone={GENERATED_TONE[file.generatedBy] ?? 'neutral'}>{file.generatedBy}</Badge>
                        </td>
                        <td className="num">{file.content.split('\n').length}</td>
                        <td className="small muted">{file.purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {code && code.notes.length > 0 ? (
            <>
              <SectionTitle>Generator notes</SectionTitle>
              <ul className="list list--tight">
                {code.notes.map((note) => (
                  <li key={note} className="small muted">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
