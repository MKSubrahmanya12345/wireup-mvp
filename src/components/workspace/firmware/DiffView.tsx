'use client';

/**
 * Unified diff renderer for the firmware workbench.
 *
 * Renders the persisted `ChatDiff` of an applied change: context collapsed
 * around the hunks, additions and deletions tinted, the same monospace
 * metrics as the code view so diffs read as code.
 */

import { useMemo } from 'react';

import type { ChatDiff } from '@/types/project';

import { collapseContext } from '@/lib/diff/lines';
import { tokenize, toLines } from '../syntax';

export function DiffView({ diff }: { diff: ChatDiff }) {
  const rows = useMemo(() => collapseContext(diff.lines, 3), [diff.lines]);

  return (
    <div className="fwb-diff" role="figure" aria-label={`Change to ${diff.path}`}>
      <div className="fwb-diff__head">
        <span className="mono-sm">{diff.path}</span>
        <span className="fwb-diff__stat fwb-diff__stat--add">+{diff.added}</span>
        <span className="fwb-diff__stat fwb-diff__stat--del">−{diff.removed}</span>
        {diff.truncated ? <span className="small muted">first {diff.lines.length} diff lines shown</span> : null}
      </div>
      <div className="fwb-diff__scroll">
        <pre className="fwb-diff__pre">
          {rows.map((row, index) => {
            if (row.kind === 'gap') {
              return (
                <span className="fwb-diff__row fwb-diff__row--gap" key={`gap-${index}`}>
                  <span className="fwb-diff__sign" />
                  <span className="fwb-diff__no" />
                  <span className="fwb-diff__no" />
                  <span className="fwb-diff__text">⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}</span>
                </span>
              );
            }
            if (row.kind === 'same') {
              return (
                <span className="fwb-diff__row" key={`same-${row.oldLine ?? index}`}>
                  <span className="fwb-diff__sign" />
                  <span className="fwb-diff__no">{row.oldLine}</span>
                  <span className="fwb-diff__no">{row.newLine}</span>
                  <span className="fwb-diff__text">{renderTokens(row.text)}</span>
                </span>
              );
            }
            return (
              <span className={`fwb-diff__row fwb-diff__row--${row.kind}`} key={`${row.kind}-${row.oldLine ?? row.newLine ?? index}`}>
                <span className="fwb-diff__sign">{row.kind === 'add' ? '+' : '−'}</span>
                <span className="fwb-diff__no">{row.kind === 'del' ? row.oldLine : ''}</span>
                <span className="fwb-diff__no">{row.kind === 'add' ? row.newLine : ''}</span>
                <span className="fwb-diff__text">{renderTokens(row.text)}</span>
              </span>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function renderTokens(text: string): ReturnType<typeof renderLineTokens> {
  return renderLineTokens(text);
}

function renderLineTokens(text: string): React.ReactNode {
  if (text.trim().length === 0) return ' ';
  const tokens = toLines(tokenize(text, 'arduino-cpp'))[0] ?? [];
  return tokens.map((token, index) =>
    token.cls ? (
      <span className={token.cls} key={index}>
        {token.text}
      </span>
    ) : (
      <span key={index}>{token.text}</span>
    ),
  );
}
