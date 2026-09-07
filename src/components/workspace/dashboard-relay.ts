'use client';

/**
 * Relay between the generated dashboard and the emulated board.
 *
 * The dashboard runs on the user's own dev server (localhost:5175) and the
 * emulator on another (localhost:5174). They are different origins, so they
 * cannot address each other — but this page can address both, and that makes
 * it the relay:
 *
 *   dashboard → wireup  { type: 'wireup:dash-ready' }        it mounted
 *   wireup → dashboard  { type: 'wireup:link-state', connected, detail }
 *   wireup → dashboard  { type: 'wireup:serial-data', chunk }  board output
 *   dashboard → wireup  { type: 'wireup:dash-write', data }    board input
 *
 * `chunk` is verbatim UART output from the emulated firmware, and `data` is
 * verbatim command characters from the dashboard's buttons. This hook does not
 * interpret, buffer-and-summarise or synthesise any of it — it counts the
 * bytes so the UI can prove traffic is flowing, and forwards them.
 *
 * The generated dashboard's other transport (Web Serial, straight to a real
 * board over USB) needs no relay at all; it is the same protocol either way,
 * which is why one dashboard serves both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SerialChunk } from './velxio-bridge';

export interface DashboardRelay {
  /** True once the dashboard has said hello. */
  attached: boolean;
  /** Bytes relayed board → dashboard, this session. */
  bytesToDashboard: number;
  /** Bytes relayed dashboard → board, this session. */
  bytesToBoard: number;
  frameRef: (node: HTMLIFrameElement | null) => void;
}

export function useDashboardRelay({
  embedUrl,
  serialOut,
  connected,
  onWrite,
}: {
  embedUrl: string | null;
  /** Latest chunk from the emulator. */
  serialOut: SerialChunk | null;
  /** Whether the board side of the relay is live. */
  connected: boolean;
  /** Called with characters the dashboard wants written to the board. */
  onWrite: (data: string) => void;
}): DashboardRelay {
  const [attached, setAttached] = useState(false);
  const [bytesToDashboard, setBytesToDashboard] = useState(0);
  const [bytesToBoard, setBytesToBoard] = useState(0);

  const frame = useRef<HTMLIFrameElement | null>(null);
  const lastForwarded = useRef(0);
  // The write handler is called from a listener registered once; a ref keeps
  // it current without re-registering (which would drop in-flight messages).
  const writeRef = useRef(onWrite);
  writeRef.current = onWrite;

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

  /* Dashboard → board ------------------------------------------------------ */
  useEffect(() => {
    if (!origin) {
      setAttached(false);
      return undefined;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const message = event.data as { type?: string; data?: string };
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'wireup:dash-ready') {
        setAttached(true);
        return;
      }
      if (message.type === 'wireup:dash-write' && typeof message.data === 'string') {
        const data = message.data;
        if (data.length === 0) return;
        writeRef.current(data);
        setBytesToBoard((total) => total + data.length);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin]);

  /* Board → dashboard ------------------------------------------------------ */
  useEffect(() => {
    if (!attached || !serialOut) return;
    // `seq` guards against a re-render re-sending the same chunk, which would
    // duplicate every telemetry line in the dashboard's log.
    if (serialOut.seq <= lastForwarded.current) return;
    lastForwarded.current = serialOut.seq;
    post({ type: 'wireup:serial-data', chunk: serialOut.text });
    setBytesToDashboard((total) => total + serialOut.text.length);
  }, [attached, serialOut, post]);

  /* Link state ------------------------------------------------------------- */
  useEffect(() => {
    if (!attached) return;
    post({
      type: 'wireup:link-state',
      connected,
      detail: connected ? 'Velxio emulator via Wireup' : 'the emulator is not running this circuit yet',
    });
  }, [attached, connected, post]);

  const frameRef = useCallback((node: HTMLIFrameElement | null) => {
    frame.current = node;
    if (node === null) setAttached(false);
  }, []);

  return { attached, bytesToDashboard, bytesToBoard, frameRef };
}
