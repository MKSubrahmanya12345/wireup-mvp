import { useMemo, useState, type CSSProperties } from 'react';
import Editor from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { registerRetroAsm, LANGUAGE_ID as RETRO_ASM_ID } from './retroAsmLanguage';
import { attachIntellisenseMonaco } from '../../lib/intellisenseRegistry';
import { CHIP_JSON_SCHEMA, CHIP_JSON_SCHEMA_URI } from './chipJsonSchema';
import { isKnownBoardKind } from '../../types/board';
import {
  buildWokwiDiagram,
  parseWokwiDiagramToCircuit,
  retargetBoardWires,
  type DiagramParseResult,
  type WokwiDiagram,
} from '../../utils/wokwiZip';

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 's' || ext === 'asm') return RETRO_ASM_ID;
  if (['ino', 'cpp', 'c', 'cc', 'h', 'hpp'].includes(ext)) return 'cpp';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'hex') return 'plaintext';
  return 'plaintext';
}

export const CodeEditor = () => {
  const {
    files,
    activeFileId,
    setFileContent,
    theme,
    fontSize,
    manifestViewBoardId,
    diagramViewBoardId,
  } = useEditorStore();
  const boards = useSimulatorStore((s) => s.boards);
  const activeFile = files.find((f) => f.id === activeFileId);

  // READ-ONLY libraries.json view (the file explorer's libraries.json entry).
  // Shows the active board's declared library manifest as plain-text JSON, live.
  // It is read-only on purpose: adding/removing libraries is done from the
  // Library Manager modal, which edits board.libraries (this just reflects it).
  if (manifestViewBoardId) {
    const b = boards.find((x) => x.id === manifestViewBoardId);
    const content = JSON.stringify({ libraries: b?.libraries ?? [] }, null, 2);
    return (
      <div style={{ height: '100%', width: '100%' }}>
        <Editor
          key="__libraries_json__"
          height="100%"
          language="json"
          theme={theme}
          value={content}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
          }}
        />
      </div>
    );
  }

  // diagram.json view (the file explorer's diagram.json entry) — see
  // DiagramJsonView below. Live from the canvas, and editable: Apply pushes
  // hand edits back onto the canvas. Remounts per board (fresh draft/undo).
  if (diagramViewBoardId) {
    return (
      <DiagramJsonView key={diagramViewBoardId} boardId={diagramViewBoardId} theme={theme} fontSize={fontSize} />
    );
  }

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Editor
        // key forces a fresh editor instance per file (preserves undo/redo per file)
        key={activeFileId}
        height="100%"
        language={activeFile ? getLanguage(activeFile.name) : 'cpp'}
        theme={theme}
        value={activeFile?.content ?? ''}
        // A model path (unique per group+file) lets Monaco's JSON language
        // service match chip.json against the schema registered below. Only
        // set for chip manifests — other files keep the default in-memory
        // model so nothing else changes behaviour.
        {...(activeFile && activeFile.name.endsWith('chip.json')
          ? { path: `velxio-ws/${useEditorStore.getState().activeGroupId}/${activeFile.name}` }
          : {})}
        beforeMount={(monaco) => {
          // Register the 8080/Z80 assembly language once so Monaco knows how
          // to tokenize .s / .asm files when they're opened.
          registerRetroAsm(monaco);
          // Hand the monaco instance to the intellisense seam. Inert in OSS;
          // with the pro overlay loaded it registers the completion engine
          // (idempotent per monaco instance, so per-file remounts are fine).
          attachIntellisenseMonaco(monaco);
          // Validate chip.json manifests against the schema (idempotent per
          // monaco instance).
          const g = monaco as unknown as { __velxioChipJsonSchema?: boolean };
          if (!g.__velxioChipJsonSchema && monaco.languages.json?.jsonDefaults) {
            g.__velxioChipJsonSchema = true;
            monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
              validate: true,
              schemas: [
                {
                  uri: CHIP_JSON_SCHEMA_URI,
                  fileMatch: ['*chip.json'],
                  schema: CHIP_JSON_SCHEMA,
                },
              ],
            });
          }
        }}
        onChange={(value) => {
          if (activeFileId) setFileContent(activeFileId, value || '');
        }}
        options={{
          minimap: { enabled: true },
          fontSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          // Hover/suggest/signature widgets escape the editor's box as
          // position:fixed overlays. Without this, a marker hover wider
          // than the editor pane slides UNDER the simulator canvas next
          // to it (sibling stacking context) and can't be read.
          fixedOverflowWidgets: true,
          // Keep quick suggestions alive inside snippet placeholders:
          // completing `#include <|>` or an if-condition placeholder must
          // still offer suggestions while the snippet session is active.
          suggest: { snippetsPreventQuickSuggestions: false },
        }}
      />
    </div>
  );
};

/**
 * diagram.json — this board's circuit in the Wokwi diagram format, both ways.
 *
 * Following the canvas: the document regenerates live from the store on every
 * render, using the same builder the Wokwi-zip export uses — so what you read
 * is exactly what a downloaded .zip contains, and it can never go stale.
 *
 * Editing it: typing switches to a local draft, which the canvas stops
 * overwriting (your half-finished JSON never gets clobbered by a drag on the
 * other pane). Apply parses the draft through the same converter the Wokwi-zip
 * import uses — board detection, pin normalisation, #268 dangling checks — and
 * applies it to the canvas exactly the way a zip import does (EditorToolbar's
 * handler): stop the run, aim at this board, re-kind it when the diagram names
 * a known one, swap the circuit, retarget the wires. Discard drops the draft
 * and returns to the live view.
 */
function DiagramJsonView({
  boardId,
  theme,
  fontSize,
}: {
  boardId: string;
  theme: 'vs-dark' | 'light';
  fontSize: number;
}) {
  const boards = useSimulatorStore((s) => s.boards);
  const components = useSimulatorStore((s) => s.components);
  const wires = useSimulatorStore((s) => s.wires);
  /** The user's unapplied text. null = follow the canvas live. */
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(
    null,
  );

  // Same inputs as the toolbar's export: the board itself (never the legacy
  // boardType mirror — #268), plus the OTHER boards' ids so the format's
  // one-board limit drops their wires rather than faking them onto this one.
  const board = boards.find((x) => x.id === boardId) ?? boards[0];
  const foreignBoardIds = boards.filter((x) => x.id !== board?.id).map((x) => x.id);
  const derived = JSON.stringify(
    buildWokwiDiagram(
      components,
      wires,
      board?.boardKind ?? 'arduino-uno',
      board ? { x: board.x, y: board.y } : { x: 50, y: 50 },
      board?.id ?? 'arduino-uno',
      foreignBoardIds,
    ),
    null,
    2,
  );
  const value = draft ?? derived;

  const draftValid = useMemo(() => {
    if (draft === null) return false;
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!parsed || typeof parsed !== 'object') return false;
      const d = parsed as { parts?: unknown; connections?: unknown };
      return Array.isArray(d.parts) && Array.isArray(d.connections);
    } catch {
      return false;
    }
  }, [draft]);

  const apply = () => {
    if (draft === null) return;
    let circuit: DiagramParseResult;
    try {
      const parsed: unknown = JSON.parse(draft);
      const d = parsed as { parts?: unknown; connections?: unknown };
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(d.parts) || !Array.isArray(d.connections)) {
        throw new Error('diagram.json must be a JSON object with a parts array and a connections array.');
      }
      circuit = parseWokwiDiagramToCircuit(parsed as WokwiDiagram);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not parse the diagram.' });
      return;
    }

    // Same sequence as a Wokwi-zip import: stop the run, aim at THIS board
    // (the row click already switched to it, but the user may have clicked a
    // different group since), re-kind it when the diagram names a board this
    // build knows, then swap the circuit and retarget the wires at the id the
    // board really answers to on the canvas.
    const sim = useSimulatorStore.getState();
    sim.stopSimulation();
    const target =
      sim.boards.find((b) => b.id === boardId) ??
      sim.boards.find((b) => b.id === sim.activeBoardId) ??
      sim.boards[0] ??
      null;
    if (target && target.id !== sim.activeBoardId) sim.setActiveBoardId(target.id);

    const warnings = [...circuit.warnings];
    let appliedBoardId: string | null = null;
    if (circuit.boardType && isKnownBoardKind(circuit.boardType)) {
      if (target) {
        sim.setBoardType(circuit.boardType);
        appliedBoardId = target.id;
      } else {
        // Empty canvas: setBoardType re-kinds nothing, so add the board the
        // diagram asks for — the other half of the #268 fix.
        appliedBoardId = sim.addBoard(circuit.boardType, circuit.boardPosition.x, circuit.boardPosition.y);
        useSimulatorStore.getState().setActiveBoardId(appliedBoardId);
      }
    } else if (circuit.boardType) {
      // Unknown board kind: land the circuit on whatever is there and say so,
      // rather than silently swapping in a lookalike chip.
      appliedBoardId = target?.id ?? null;
      warnings.push(
        `The diagram's board "${circuit.boardType}" is not available in this build; the circuit was applied to the current board.`,
      );
    }

    sim.setBoardPosition(circuit.boardPosition);
    sim.setComponents(circuit.components);
    sim.setWires(
      appliedBoardId && circuit.boardType
        ? retargetBoardWires(circuit.wires, circuit.boardType, appliedBoardId)
        : circuit.wires,
    );

    // Back to the live view: the store is the truth again, and what it shows
    // is the round-tripped (normalised) version of what was just applied.
    setDraft(null);
    setStatus(
      warnings.length > 0
        ? { kind: 'info', text: `Applied — ${warnings.join(' ')}` }
        : { kind: 'ok', text: 'Applied to the canvas — this view follows it again.' },
    );
  };

  const headerNote =
    draft === null
      ? 'live from the canvas — edit and Apply to push changes back'
      : draftValid
        ? 'edited — not applied yet'
        : 'edited — invalid JSON (needs parts and connections arrays)';

  const buttonStyle: CSSProperties = {
    fontSize: 11,
    lineHeight: '18px',
    padding: '0 8px',
    borderRadius: 4,
    cursor: 'pointer',
  };

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '3px 10px',
          borderBottom: '1px solid #2d2d2d',
          background: '#1e1e1e',
          fontSize: 12,
          color: '#9d9d9d',
          flexShrink: 0,
        }}
      >
        <span style={{ color: '#5c9ded' }}>diagram.json</span>
        <span>{headerNote}</span>
        {draft !== null && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setStatus(null);
              }}
              style={{ ...buttonStyle, background: '#2d2d2d', color: '#cccccc', border: '1px solid #444' }}
            >
              Discard edits
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!draftValid}
              style={{
                ...buttonStyle,
                background: draftValid ? '#2f6fdb' : '#2d2d2d',
                color: draftValid ? '#ffffff' : '#666',
                border: '1px solid #444',
              }}
            >
              Apply to canvas
            </button>
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          key={`__diagram_json__${boardId}`}
          height="100%"
          language="json"
          theme={theme}
          value={value}
          onChange={(v) => setDraft(v ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
          }}
        />
      </div>
      {status && (
        <div
          style={{
            padding: '3px 10px',
            fontSize: 12,
            flexShrink: 0,
            color: status.kind === 'error' ? '#ff6b6b' : status.kind === 'info' ? '#ffd60a' : '#7ee787',
            background: '#1e1e1e',
            borderTop: '1px solid #2d2d2d',
          }}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
