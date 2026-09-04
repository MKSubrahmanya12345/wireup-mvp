'use client';

/**
 * LEFT PANE — the live agent console.
 *
 * Every line is a real persisted `AgentEvent` (polled from MongoDB by seq), so
 * what the user reads is exactly what the backend did, including durations and
 * failure reasons. Nothing here is simulated.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { AgentEvent } from '@/types/generation';

const ICONS: Record<AgentEvent['status'], string> = {
  started: '›',
  completed: '✓',
  failed: '✕',
  info: '·',
};

const STATUS_CLASS: Record<AgentEvent['status'], string> = {
  started: 'console__line--started',
  completed: 'console__line--completed',
  failed: 'console__line--failed',
  info: 'console__line--info',
};

function clockOf(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function summariseMetadata(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      parts.push(`${key}=[${value.slice(0, 4).map((entry) => String(entry)).join(', ')}${value.length > 4 ? ', …' : ''}]`);
      continue;
    }
    if (typeof value === 'object') {
      parts.push(`${key}={${Object.keys(value as object).slice(0, 4).join(', ')}}`);
      continue;
    }
    const text = String(value);
    parts.push(`${key}=${text.length > 42 ? `${text.slice(0, 42)}…` : text}`);
  }
  return parts.join(' ');
}

interface ConsoleProps {
  events: AgentEvent[];
  running: boolean;
  stage: string;
  pollError: string | null;
  polledAt: number | null;
}

export function AgentConsole({ events, running, stage, pollError, polledAt }: ConsoleProps) {
  const [query, setQuery] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return events;
    return events.filter((event) =>
      `${event.seq} ${event.type} ${event.message} ${event.stage ?? ''} ${summariseMetadata(event.metadata ?? {})}`
        .toLowerCase()
        .includes(needle),
    );
  }, [events, query]);

  useEffect(() => {
    if (!autoscroll) return;
    const node = bodyRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [visible.length, autoscroll]);

  const failures = events.filter((event) => event.status === 'failed').length;

  return (
    <div className="pane pane--console">
      <div className="pane__head">
        <span className={`dot ${running ? 'dot--live' : failures > 0 ? 'dot--err' : 'dot--ok'}`} />
        <strong>agent activity</strong>
        <span className="card__spacer" style={{ flex: 1 }} />
        <span>{events.length} events</span>
      </div>

      <div className="pane__head" style={{ gap: 6 }}>
        <input
          className="mono-sm"
          style={{
            flex: 1,
            minWidth: 0,
            border: '1px solid var(--border)',
            borderRadius: 3,
            padding: '2px 6px',
            background: 'var(--bg)',
            color: 'var(--text)',
            outline: 'none',
          }}
          placeholder="filter events…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter agent events"
        />
        <button
          type="button"
          className={autoscroll ? 'filter filter--active' : 'filter'}
          onClick={() => setAutoscroll((current) => !current)}
          title="Follow the log as new events arrive"
        >
          follow
        </button>
      </div>

      <div className="pane__body" ref={bodyRef}>
        {pollError ? (
          <div className="console__line console__line--failed">
            <span className="console__seq">!</span>
            <span className="console__icon">✕</span>
            <span className="console__body">
              <span className="console__msg">Event stream interrupted: {pollError}</span>
              <span className="console__type">retrying with backoff…</span>
            </span>
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div className="console__empty">
            {events.length === 0
              ? 'Waiting for the first agent event… The console fills as soon as the backend starts working.'
              : 'No events match this filter.'}
          </div>
        ) : (
          <div className="console">
            {visible.map((event) => {
              const metadata = event.metadata ?? {};
              const summary = summariseMetadata(metadata);
              const isOpen = expanded[event.seq] === true;
              return (
                <div className={`console__line ${STATUS_CLASS[event.status] ?? ''}`} key={event.id}>
                  <span className="console__seq">{event.seq}</span>
                  <span className="console__icon">{ICONS[event.status] ?? '·'}</span>
                  <span className="console__body">
                    <span className="console__msg">
                      {event.message}
                      {typeof event.durationMs === 'number' && event.durationMs > 0 ? (
                        <span className="console__duration"> ({event.durationMs < 1000 ? `${event.durationMs}ms` : `${(event.durationMs / 1000).toFixed(1)}s`})</span>
                      ) : null}
                    </span>
                    <span className="console__type">
                      {clockOf(event.timestamp)} · {event.type}
                      {event.stage ? ` · ${event.stage}` : ''}
                    </span>
                    {summary ? (
                      <span className="console__meta">
                        {isOpen ? summary : `${summary.slice(0, 120)}${summary.length > 120 ? '…' : ''} `}
                        <button type="button" onClick={() => setExpanded((current) => ({ ...current, [event.seq]: !isOpen }))}>
                          {isOpen ? 'hide' : 'details'}
                        </button>
                      </span>
                    ) : null}
                    {isOpen ? <pre className="console__raw">{JSON.stringify(metadata, null, 2)}</pre> : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="pane__head">
        <span>stage: {stage}</span>
        <span className="card__spacer" style={{ flex: 1 }} />
        <span>{polledAt ? `polled ${clockOf(new Date(polledAt).toISOString())}` : 'connecting…'}</span>
      </div>
    </div>
  );
}
