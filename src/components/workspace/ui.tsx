'use client';

/**
 * Shared UI primitives for the workspace. Plain hand-written CSS classes from
 * `app/globals.css` — no component library, no utility framework.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ProjectState } from '@/types/project';

export type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'solid';

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export interface CardProps {
  title: string;
  count?: string | number | null;
  actions?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  flush?: boolean;
  children: ReactNode;
}

export function Card({ title, count, actions, footer, wide, flush, children }: CardProps) {
  return (
    <section className={wide ? 'card card--wide' : 'card'} aria-label={title}>
      <header className="card__head">
        <h2 className="card__title">{title}</h2>
        {count !== null && count !== undefined && count !== '' ? <span className="card__count">{count}</span> : null}
        <span className="card__spacer" />
        {actions}
      </header>
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
      {footer ? <div className="card__foot">{footer}</div> : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const suffix = tone === 'neutral' ? '' : ` badge--${tone}`;
  return <span className={`badge${suffix}`}>{children}</span>;
}

const STATUS_LABEL: Record<ProjectState['status'], string> = {
  pending: 'queued',
  running: 'running',
  validating: 'validating',
  fixing: 'fixing',
  completed: 'completed',
  completed_with_warnings: 'completed · warnings',
  completed_with_errors: 'completed · unresolved errors',
  failed: 'failed',
};

export function StatusBadge({ status }: { status: ProjectState['status'] }) {
  const tone: Tone =
    status === 'completed'
      ? 'ok'
      : status === 'failed' || status === 'completed_with_errors'
        ? 'err'
        : status === 'completed_with_warnings'
          ? 'warn'
          : 'info';
  return (
    <span className="row row--tight">
      <span className={`dot ${status === 'failed' ? 'dot--err' : status === 'completed' ? 'dot--ok' : 'dot--live'}`} />
      <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: 'error' | 'warning' | 'info' }) {
  const tone: Tone = severity === 'error' ? 'err' : severity === 'warning' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{severity}</Badge>;
}

/* -------------------------------------------------------------------------- */
/* Loaders — always tied to a real backend stage                               */
/* -------------------------------------------------------------------------- */

export function Loader({ label, detail }: { label: string; detail?: string | null }) {
  return (
    <div className="loader" role="status" aria-live="polite">
      <span className="loader__bar" />
      <span>
        <span className="loader__label">{label}</span>
        {detail ? <span className="faint small"> — {detail}</span> : null}
      </span>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="skeleton" style={{ width: `${88 - index * 9}%` }} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Data display                                                                */
/* -------------------------------------------------------------------------- */

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="section-title">{children}</h3>;
}

export function Kv({ items }: { items: { key: string; value: ReactNode }[] }) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div key={item.key} style={{ display: 'contents' }}>
          <dt className="kv__key">{item.key}</dt>
          <dd className="kv__val" style={{ margin: 0 }}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Chips({ items, dark }: { items: string[]; dark?: boolean }) {
  if (items.length === 0) return <span className="faint small">none</span>;
  return (
    <span className="chips">
      {items.map((item) => (
        <span key={item} className={dark ? 'chip chip--dark' : 'chip'}>
          {item}
        </span>
      ))}
    </span>
  );
}

export function Notice({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const suffix = tone === 'neutral' ? '' : ` notice--${tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : ''}`;
  return (
    <div className={`notice${suffix}`}>
      <div className="notice__body">
        {title ? <span className="notice__title">{title}</span> : null}
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Clipboard / download                                                        */
/* -------------------------------------------------------------------------- */

export function CopyButton({ text, label = 'copy', className = 'btn btn--sm' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" className={className} onClick={() => void copy()} title="Copy to clipboard">
      {copied ? 'copied ✓' : label}
    </button>
  );
}

export function DownloadButton({
  filename,
  content,
  label,
  mime = 'application/json',
}: {
  filename: string;
  content: string;
  label?: string;
  mime?: string;
}) {
  const href = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    return URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  }, [content, mime]);

  useEffect(() => {
    if (href === '#') return;
    return () => URL.revokeObjectURL(href);
  }, [href]);

  return (
    <a className="btn btn--sm" href={href} download={filename}>
      {label ?? `download ${filename}`}
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* Minimal markdown renderer (instructions are generated markdown)             */
/* -------------------------------------------------------------------------- */

interface MdBlock {
  kind: 'heading' | 'paragraph' | 'list' | 'ordered' | 'code' | 'table' | 'quote' | 'rule';
  level?: number;
  lines?: string[];
  text?: string;
  lang?: string;
  rows?: string[][];
  header?: string[];
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let index = 0;

  const splitRow = (line: string) =>
    line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());

  while (index < lines.length) {
    const line = lines[index] as string;

    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] as string)) {
        body.push(lines[index] as string);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n'), lang });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: (heading[1] as string).length, text: heading[2] as string });
      index += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] as string)) {
        body.push((lines[index] as string).replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join(' ') });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|[\s:-]+\|\s*$/.test(lines[index + 1] as string)) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] as string)) {
        rows.push(splitRow(lines[index] as string));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] as string)) {
        items.push((lines[index] as string).replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push({ kind: 'list', lines: items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index] as string)) {
        items.push((lines[index] as string).replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push({ kind: 'ordered', lines: items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !/^\s*$/.test(lines[index] as string) && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[index] as string)) {
      paragraph.push(lines[index] as string);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  return (
    <div className="markdown">
      {blocks.map((block, blockIndex) => {
        const key = `md-${blockIndex}`;
        switch (block.kind) {
          case 'heading': {
            const level = Math.min(6, Math.max(2, block.level ?? 2));
            const Tag = (`h${level}` as unknown) as 'h2';
            return <Tag key={key}>{inline(block.text ?? '', key)}</Tag>;
          }
          case 'paragraph':
            return <p key={key}>{inline(block.text ?? '', key)}</p>;
          case 'quote':
            return <blockquote key={key}>{inline(block.text ?? '', key)}</blockquote>;
          case 'rule':
            return <hr key={key} />;
          case 'list':
            return (
              <ul key={key}>
                {(block.lines ?? []).map((item, itemIndex) => (
                  <li key={`${key}-li${itemIndex}`}>{inline(item, `${key}-li${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case 'ordered':
            return (
              <ol key={key}>
                {(block.lines ?? []).map((item, itemIndex) => (
                  <li key={`${key}-ol${itemIndex}`}>{inline(item, `${key}-ol${itemIndex}`)}</li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case 'table':
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {(block.header ?? []).map((cell, cellIndex) => (
                      <th key={`${key}-th${cellIndex}`}>{inline(cell, `${key}-th${cellIndex}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(block.rows ?? []).map((row, rowIndex) => (
                    <tr key={`${key}-tr${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${key}-td${rowIndex}-${cellIndex}`}>{inline(cell, `${key}-td${rowIndex}-${cellIndex}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
