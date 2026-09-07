'use client';

/**
 * Bridge to the EMBEDDED Velxio instance.
 *
 * The other end is `external/velxio/frontend/src/utils/embedBridge.ts`, which
 * is vendored in this repository already patched — there is no patch for the
 * user to apply. Protocol: `window.postMessage`, JSON payloads, origin-checked
 * in both directions.
 *
 *   velxio → wireup  { type: 'velxio:ready' }                  it booted
 *   wireup → velxio  { type: 'velxio:load-vlx', vlx }          push the build
 *   velxio → wireup  { type: 'velxio:vlx-loaded', name }       push ack
 *   wireup → velxio  { type: 'velxio:export-vlx' }             pull request
 *   velxio → wireup  { type: 'velxio:vlx-export', vlx }        canvas state
 *   wireup → velxio  { type: 'velxio:serial-subscribe' }       start streaming
 *   velxio → wireup  { type: 'velxio:serial-data', chunk }     UART output
 *   wireup → velxio  { type: 'velxio:serial-write', data }     UART input
 *   velxio → wireup  { type: 'velxio:vlx-error', message }     either failed
 *
 * The user therefore never imports the .vlx by hand: the build's circuit lands
 * on the canvas as soon as the iframe is ready, and canvas edits can be pulled
 * back without leaving the page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** The canvas payload, as far as this side needs to understand it. */
export interface VlxCanvasPayload {
  format?: string;
  version?: number;
  name?: string;
  boards: { id: string; boardKind?: string }[];
  fileGroups?: Record<string, { name: string; content: string }[]>;
  components: { id: string; metadataId: string; x?: number; y?: number; properties?: Record<string, unknown> }[];
  wires: {
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }[];
  activeBoardId?: string | null;
}

export type BridgeStatus =
  | { state: 'idle' }
  /** The iframe is mounted but Velxio has not said hello yet. */
  | { state: 'waiting' }
  | { state: 'ready' }
  | { state: 'pushed'; name: string | null }
  | { state: 'error'; message: string };

export interface SerialChunk {
  /** Monotonic, so a consumer can tell a repeat render from new bytes. */
  seq: number;
  text: string;
}

export interface VelxioBridge {
  status: BridgeStatus;
  /** Latest bytes the emulated board printed. */
  serialChunk: SerialChunk | null;
  /** Push a .vlx (JSON string) onto the canvas. */
  push: (vlxJson: string) => void;
  /** Pull the current canvas. Rejects when the bridge does not answer. */
  pull: () => Promise<VlxCanvasPayload>;
  /** Ask Velxio to start streaming the board's UART. Idempotent. */
  subscribeSerial: () => void;
  /** Write characters into the board's UART RX. */
  serialWrite: (data: string) => void;
  frameRef: (node: HTMLIFrameElement | null) => void;
}

const PULL_TIMEOUT_MS = 8_000;

export function useVelxioBridge({
  embedUrl,
  autoPushVlx,
}: {
  embedUrl: string | null;
  autoPushVlx: string | null;
}): VelxioBridge {
  const [status, setStatus] = useState<BridgeStatus>({ state: 'idle' });
  const [serialChunk, setSerialChunk] = useState<SerialChunk | null>(null);

  const frame = useRef<HTMLIFrameElement | null>(null);
  const pullWaiters = useRef<{ resolve: (payload: VlxCanvasPayload) => void; reject: (error: Error) => void }[]>([]);
  const serialSeq = useRef(0);
  const subscribed = useRef(false);

  // Kept in a ref so the message listener never has to be re-registered when
  // the build's .vlx changes — re-registering would race Velxio's `ready`.
  const pending = useRef<string | null>(autoPushVlx);
  pending.current = autoPushVlx;

  const origin = useMemo(() => {
    if (!embedUrl) return null;
    try {
      return new URL(embedUrl, typeof window === 'undefined' ? 'http://localhost' : window.location.href).origin;
    } catch {
      return null;
    }
  }, [embedUrl]);

  const post = useCallback(
    (message: Record<string, unknown>) => {
      const target = frame.current?.contentWindow;
      if (!target || !origin) return;
      target.postMessage(message, origin);
    },
    [origin],
  );

  const push = useCallback((vlxJson: string) => post({ type: 'velxio:load-vlx', vlx: vlxJson }), [post]);

  const subscribeSerial = useCallback(() => {
    if (subscribed.current) return;
    subscribed.current = true;
    post({ type: 'velxio:serial-subscribe' });
  }, [post]);

  const serialWrite = useCallback((data: string) => post({ type: 'velxio:serial-write', data }), [post]);

  const pull = useCallback(
    (): Promise<VlxCanvasPayload> =>
      new Promise((resolve, reject) => {
        if (!frame.current?.contentWindow) {
          reject(new Error('The Velxio iframe is not mounted.'));
          return;
        }
        pullWaiters.current.push({ resolve, reject });
        post({ type: 'velxio:export-vlx' });
        // A bridge that never answers means the iframe is not the vendored
        // Velxio (or is not running at all). Say which, rather than hanging.
        setTimeout(() => {
          const index = pullWaiters.current.findIndex((waiter) => waiter.resolve === resolve);
          if (index < 0) return;
          pullWaiters.current.splice(index, 1);
          reject(
            new Error(
              `Velxio at ${embedUrl ?? 'the configured URL'} did not answer within ${
                PULL_TIMEOUT_MS / 1000
              } s. Make sure its dev server is running from this repository's external/velxio (the embed bridge is vendored there).`,
            ),
          );
        }, PULL_TIMEOUT_MS);
      }),
    [post, embedUrl],
  );

  useEffect(() => {
    if (!origin) {
      setStatus({ state: 'idle' });
      return undefined;
    }
    setStatus({ state: 'waiting' });
    subscribed.current = false;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const message = event.data as {
        type?: string;
        name?: string;
        message?: string;
        chunk?: string;
        vlx?: VlxCanvasPayload;
      };
      if (!message || typeof message.type !== 'string') return;

      switch (message.type) {
        case 'velxio:ready': {
          setStatus({ state: 'ready' });
          // The whole point: the build lands on the canvas unasked.
          if (pending.current) post({ type: 'velxio:load-vlx', vlx: pending.current });
          break;
        }
        case 'velxio:vlx-loaded': {
          setStatus({ state: 'pushed', name: message.name ?? null });
          break;
        }
        case 'velxio:vlx-export': {
          const waiter = pullWaiters.current.shift();
          if (waiter && message.vlx) waiter.resolve(message.vlx);
          break;
        }
        case 'velxio:serial-data': {
          if (typeof message.chunk !== 'string' || message.chunk.length === 0) break;
          serialSeq.current += 1;
          setSerialChunk({ seq: serialSeq.current, text: message.chunk });
          break;
        }
        case 'velxio:vlx-error':
        case 'velxio:serial-error': {
          const detail = message.message ?? 'unknown bridge error';
          const waiter = pullWaiters.current.shift();
          if (waiter) waiter.reject(new Error(detail));
          else setStatus({ state: 'error', message: detail });
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      // Reject anything still in flight so a caller never awaits forever after
      // the page navigates away.
      for (const waiter of pullWaiters.current) waiter.reject(new Error('The simulation page closed the bridge.'));
      pullWaiters.current = [];
    };
  }, [origin, post]);

  // A .vlx that arrives AFTER Velxio said ready (the build finished while the
  // page was open) still has to reach the canvas.
  useEffect(() => {
    if (!autoPushVlx) return;
    if (status.state !== 'ready') return;
    push(autoPushVlx);
  }, [autoPushVlx, status.state, push]);

  const frameRef = useCallback((node: HTMLIFrameElement | null) => {
    frame.current = node;
  }, []);

  return { status, serialChunk, push, pull, subscribeSerial, serialWrite, frameRef };
}
