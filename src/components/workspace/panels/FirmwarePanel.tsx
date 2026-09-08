'use client';

/**
 * FIRMWARE — the workbench.
 *
 * Cursor-for-firmware on top of Wireup's gates: a chat where the model
 * proposes changes (rooted to the pin plan, compile-checked, applied as
 * revisions with diffs), a real editor for hand changes (same gates on save),
 * a unified diff viewer, and the libraries table.
 *
 * The two write paths meet in the same API endpoint and the same guarantee:
 * nothing lands in the project that the rooting gate or the compiler rejected,
 * and every applied change is a frozen revision you can diff.
 */

import { useMemo, useState } from 'react';

import type { ChatDiff, ChatMessage, LibrariesArtifact } from '@/types/project';

import { Badge, Card, CopyButton, DownloadButton, Empty, Loader, SectionTitle } from '../ui';
import { languageOf } from '../syntax';
import { useHub } from '../hub-context';
import { saveFirmwareFile, sendFirmwareChat, type FirmwareTurnPayload } from '../api';
import { ChatPane } from '../firmware/ChatPane';
import { CodeEditor, type EditorProblem } from '../firmware/CodeEditor';
import { DiffView } from '../firmware/DiffView';

type View = 'firmware' | 'libraries';

/** `file:line:col: severity: message` → editor problem. */
function parseDiagnostics(diagnostics: string[], path: string): EditorProblem[] {
  const problems: EditorProblem[] = [];
  for (const diagnostic of diagnostics) {
    const match = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+:\\s*(error|warning|fatal error):\\s*(.+)$`).exec(diagnostic);
    if (match) {
      problems.push({ line: Number.parseInt(match[1] ?? '0', 10) || 1, severity: /error/i.test(match[2] ?? '') ? 'error' : 'warning', message: match[3] ?? diagnostic });
    } else {
      problems.push({ line: 1, severity: /error/i.test(diagnostic) ? 'error' : 'warning', message: diagnostic });
    }
  }
  return problems;
}

export function FirmwarePanel() {
  const { project, running, details, refresh } = useHub();
  const code = project?.artifacts.code ?? null;
  const libraries = project?.artifacts.libraries ?? null;
  const files = code?.files ?? [];

  const [activePath, setActivePath] = useState<string | null>(null);
  const [view, setView] = useState<View>('firmware');

  /* Workbench state */
  const [draft, setDraft] = useState<string | null>(null); // null = not editing
  const [problems, setProblems] = useState<EditorProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [pendingUser, setPendingUser] = useState<ChatMessage | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [shownDiff, setShownDiff] = useState<ChatDiff | null>(null);

  const active = useMemo(() => {
    if (files.length === 0) return null;
    if (activePath) return files.find((file) => file.path === activePath) ?? files[0] ?? null;
    return files.find((file) => file.path === code?.entryPoint) ?? files[0] ?? null;
  }, [activePath, code?.entryPoint, files]);

  const chatMessages: ChatMessage[] = useMemo(() => {
    const persisted = project?.chat ?? [];
    return pendingUser ? [...persisted, pendingUser] : persisted;
  }, [project?.chat, pendingUser]);

  if (!code && !libraries) {
    return (
      <Card title="Firmware" wide count="none yet">
        {running ? (
          <Loader label="Writing the firmware from your parts and wiring" />
        ) : (
          <Empty>No firmware was generated for this build.</Empty>
        )}
      </Card>
    );
  }

  const effectiveView: View = code ? view : 'libraries';
  const librariesJson = libraries ? JSON.stringify(libraries, null, 2) : '';
  const editable = Boolean(active) && !running;
  const isEditing = draft !== null && active !== null;

  const openFile = (path: string): void => {
    setActivePath(path);
    setDraft(null);
    setProblems([]);
    setShownDiff(null);
  };

  const beginEdit = (): void => {
    if (!active) return;
    setDraft(active.content);
    setProblems([]);
    setShownDiff(null);
  };

  const discardEdit = (): void => {
    setDraft(null);
    setProblems([]);
  };

  const saveEdit = async (): Promise<void> => {
    if (!project || !active || draft === null) return;
    setSaving(true);
    setProblems([]);
    try {
      const response: FirmwareTurnPayload = await saveFirmwareFile(project.id, active.path, draft);
      setProblems(parseDiagnostics(response.diagnostics ?? [], active.path));
      if (response.project) {
        setDraft(null);
        await refresh();
      }
    } catch (error) {
      setProblems([{ line: 1, severity: 'error', message: error instanceof Error ? error.message : String(error) }]);
    } finally {
      setSaving(false);
    }
  };

  const send = async (message: string): Promise<void> => {
    if (!project) return;
    setChatBusy(true);
    setTurnError(null);
    setPendingUser({ id: `pending-${Date.now()}`, role: 'user', text: message, at: new Date().toISOString() });
    setShownDiff(null);
    try {
      const response: FirmwareTurnPayload = await sendFirmwareChat(project.id, message);
      setPendingUser(null);
      if (response.message.diff) setShownDiff(response.message.diff);
      const replyProblems = parseDiagnostics(response.message.diagnostics ?? [], active?.path ?? '');
      if (response.message.outcome === 'applied') {
        setDraft(null);
        setProblems([]);
      } else if (response.message.outcome === 'rejected' && replyProblems.length > 0) {
        setProblems(replyProblems);
      }
      await refresh();
    } catch (error) {
      setPendingUser(null);
      setTurnError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <Card
      title="Firmware workbench"
      wide
      count={code ? `${files.length} file${files.length === 1 ? '' : 's'} · v${project?.revision ?? 0}` : 'libraries'}
      actions={
        <span className="row row--tight">
          <button type="button" className={effectiveView === 'firmware' ? 'filter filter--active' : 'filter'} onClick={() => setView('firmware')} disabled={!code}>
            workbench
          </button>
          <button type="button" className={effectiveView === 'libraries' ? 'filter filter--active' : 'filter'} onClick={() => setView('libraries')} disabled={!libraries}>
            libraries
          </button>
          {effectiveView === 'libraries' && librariesJson ? <DownloadButton filename="libraries.json" content={librariesJson} label="libraries.json" /> : null}
        </span>
      }
      footer={
        effectiveView === 'firmware' && code ? (
          <span>
            entry point <span className="mono-sm">{code.entryPoint}</span>
            {details ? <span> · pin map sync: {code.pinsSynchronised ? 'yes' : 'no'}</span> : null}
            {running ? <span> · generation in progress — workbench is read-only</span> : null}
          </span>
        ) : (
          <span>{libraries ? `${libraries.libraries.length} librar${libraries.libraries.length === 1 ? 'y' : 'ies'}` : ''}</span>
        )
      }
      flush={effectiveView === 'firmware'}
    >
      {effectiveView === 'firmware' ? (
        files.length === 0 || !active || !code ? (
          <Empty>The code artifact is empty.</Empty>
        ) : (
          <div className="fwb">
            {/* ---- chat column ---- */}
            <div className="fwb__chat">
              <div className="fwb__colhead">
                <span className="small" style={{ fontWeight: 600 }}>
                  chat
                </span>
                <Badge tone={running ? 'warn' : 'ok'}>{running ? 'busy' : 'ready'}</Badge>
              </div>
              <ChatPane
                messages={chatMessages}
                busy={chatBusy}
                disabled={running}
                disabledReason={running ? 'Generation is running — the workbench unlocks when it finishes.' : undefined}
                onSend={(text) => void send(text)}
                onViewDiff={(message) => message.diff && setShownDiff(message.diff)}
              />
              {turnError ? <p className="small" style={{ color: 'var(--bad, #b35900)', margin: '0 10px 8px' }}>Request failed: {turnError}</p> : null}
            </div>

            {/* ---- editor column ---- */}
            <div className="fwb__code">
              <div className="code__tabs" role="tablist">
                {files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    role="tab"
                    aria-selected={file.path === active.path}
                    className={file.path === active.path ? 'code__tab code__tab--active' : 'code__tab'}
                    onClick={() => openFile(file.path)}
                    title={file.purpose}
                  >
                    {file.path}
                  </button>
                ))}
              </div>

              <div className="code__toolbar">
                <span className="mono-sm">{active.path}</span>
                <Badge>{active.language || languageOf(active.path)}</Badge>
                {details ? <Badge>generated by {active.generatedBy}</Badge> : null}
                {isEditing ? <Badge tone="warn">unsaved edits</Badge> : null}
                <span style={{ flex: 1 }} />
                {shownDiff ? (
                  <button type="button" className="btn btn--sm" onClick={() => setShownDiff(null)}>
                    close diff
                  </button>
                ) : null}
                {!isEditing && editable ? (
                  <>
                    <CopyButton text={active.content} label="copy" />
                    <DownloadButton filename={active.path.replace(/[\\/]/g, '_')} content={active.content} mime="text/plain" label="download" />
                    <button type="button" className="btn btn--sm" onClick={beginEdit}>
                      edit
                    </button>
                  </>
                ) : null}
                {isEditing ? (
                  <>
                    <button type="button" className="btn btn--sm" onClick={discardEdit} disabled={saving}>
                      discard
                    </button>
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => void saveEdit()} disabled={saving || draft === active.content}>
                      {saving ? 'checking…' : 'check & save'}
                    </button>
                  </>
                ) : null}
              </div>

              {shownDiff ? (
                <DiffView diff={shownDiff} />
              ) : (
                <CodeEditor
                  path={active.path}
                  content={isEditing ? (draft as string) : active.content}
                  readOnly={!isEditing}
                  problems={problems}
                  onChange={(next) => setDraft(next)}
                />
              )}

              {problems.length > 0 ? (
                <div className="fwb-problems" role="alert">
                  <div className="fwb-problems__head">
                    {problems.filter((problem) => problem.severity === 'error').length} error(s),{' '}
                    {problems.filter((problem) => problem.severity === 'warning').length} warning(s)
                    {isEditing ? <span className="small muted"> — fix them and check & save again</span> : null}
                  </div>
                  <ul>
                    {problems.slice(0, 12).map((problem, index) => (
                      <li key={index} className={`fwb-problems__item fwb-problems__item--${problem.severity}`}>
                        <button
                          type="button"
                          className="fwb-problems__jump"
                          title="jump to line"
                          onClick={() => {
                            setShownDiff(null);
                            const node = document.querySelector(`.fwb-editor__input`) as HTMLTextAreaElement | null;
                            if (node) {
                              const position = node.value.split('\n').slice(0, problem.line - 1).join('\n').length;
                              node.focus();
                              node.setSelectionRange(position, position);
                            }
                          }}
                        >
                          line {problem.line}
                        </button>
                        <span>{problem.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!shownDiff && active.purpose ? (
                <p className="small muted" style={{ margin: '8px 14px 10px' }}>
                  {active.purpose}
                </p>
              ) : null}
            </div>
          </div>
        )
      ) : (
        <div style={{ padding: '14px' }}>
          <LibrariesView libraries={libraries} />
        </div>
      )}

      {effectiveView === 'libraries' && files.length > 1 ? (
        <>
          <SectionTitle>Files</SectionTitle>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>path</th>
                  <th>language</th>
                  <th>purpose</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.path}>
                    <td className="mono-sm">{file.path}</td>
                    <td className="mono-sm">{file.language}</td>
                    <td className="small muted">{file.purpose}</td>
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

function LibrariesView({ libraries }: { libraries: LibrariesArtifact | null }) {
  if (!libraries) return <Empty>No libraries were declared.</Empty>;

  return (
    <>
      {libraries.libraries.length === 0 ? (
        <Empty>The firmware only uses core headers — nothing to install.</Empty>
      ) : (
        <>
          <SectionTitle>Libraries</SectionTitle>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>name</th>
                  <th>import</th>
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
                    <td className="small muted">{entry.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {libraries.installCommands.length > 0 ? (
        <>
          <SectionTitle>To install</SectionTitle>
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
        </>
      ) : null}
    </>
  );
}
