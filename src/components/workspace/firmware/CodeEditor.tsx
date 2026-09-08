'use client';

/**
 * The workbench code editor.
 *
 * A transparent <textarea> laid exactly over the syntax-highlighted view —
 * same font, same line-height, same paddings — so editing feels native while
 * highlighting stays live. A sticky line-number gutter sits left of both.
 * No editor dependency: this is deliberately the same hand-rolled stack as
 * the read-only view.
 */

import { useMemo, useRef, useState, useEffect } from 'react';

import { tokenize, toLines, languageOf } from '../syntax';

export interface EditorProblem {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export function CodeEditor({
  path,
  content,
  onChange,
  readOnly = false,
  problems = [],
}: {
  path: string;
  content: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  problems?: EditorProblem[];
}) {
  const language = languageOf(path);
  const lines = useMemo(() => toLines(tokenize(content, language)), [content, language]);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);

  const problemByLine = useMemo(() => {
    const map = new Map<number, EditorProblem>();
    for (const problem of problems) {
      const existing = map.get(problem.line);
      if (!existing || (existing.severity === 'warning' && problem.severity === 'error')) map.set(problem.line, problem);
    }
    return map;
  }, [problems]);

  /* Keep the overlay + gutter glued to the textarea's scroll. */
  const onScroll = (): void => {
    if (!textRef.current) return;
    const { scrollTop, scrollLeft } = textRef.current;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
  };

  useEffect(() => {
    onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  const gutter = useMemo(() => {
    const count = Math.max(content.split('\n').length, lines.length);
    return Array.from({ length: count }, (_, index) => index + 1);
  }, [content, lines.length]);

  return (
    <div className={`fwb-editor${readOnly ? '' : ' fwb-editor--editing'}`}>
      <div className="fwb-editor__surface">
        <div className="fwb-editor__gutter" ref={gutterRef} aria-hidden>
          {gutter.map((line) => {
            const problem = problemByLine.get(line);
            return (
              <span key={line} className={problem ? `fwb-editor__gutter-no fwb-editor__gutter-no--${problem.severity}` : 'fwb-editor__gutter-no'}>
                {line}
              </span>
            );
          })}
        </div>
        <div className="fwb-editor__stack">
          <pre className="fwb-editor__highlight" ref={preRef} aria-hidden>
            <code>
              {lines.map((line, lineIndex) => (
                <span className={`fwb-editor__line${problemByLine.get(lineIndex + 1) ? ` fwb-editor__line--${problemByLine.get(lineIndex + 1)?.severity}` : ''}`} key={lineIndex}>
                  {line.length === 0 ? (
                    <span> </span>
                  ) : (
                    line.map((token, tokenIndex) =>
                      token.cls ? (
                        <span className={token.cls} key={tokenIndex}>
                          {token.text}
                        </span>
                      ) : (
                        <span key={tokenIndex}>{token.text}</span>
                      ),
                    )
                  )}
                  {'\n'}
                </span>
              ))}
            </code>
          </pre>
          <textarea
            ref={textRef}
            className="fwb-editor__input"
            value={content}
            readOnly={readOnly}
            spellCheck={false}
            wrap="off"
            aria-label={`Edit ${path}`}
            onChange={(event) => onChange?.(event.target.value)}
            onScroll={onScroll}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </div>
      </div>
      {!readOnly && (
        <div className="fwb-editor__hints">
          <span className="small muted">{focused ? 'editing — unsaved changes live in this page only' : 'click into the code to edit'}</span>
        </div>
      )}
    </div>
  );
}
