/**
 * Source templates for the generated dashboard.
 *
 * Everything here is a pure `contract → file content` function. No file is
 * written from a fixed string that ignores the build: the metric cards, the
 * command buttons and the parser all come from the `DeviceContract`, which was
 * itself derived from the same plan the firmware was generated from.
 *
 * The generated app is a plain Vite + React + TypeScript project with ZERO
 * runtime dependencies beyond react/react-dom. That is deliberate: the user
 * downloads a zip, runs `npm install && npm run dev`, and nothing in this
 * sandbox ever had to install, build or execute it.
 *
 * ── How it reaches the board ────────────────────────────────────────────────
 * Two transports, both real, chosen at runtime:
 *
 *   1. `webserial` — the browser's Web Serial API talking to the USB port the
 *      board is actually plugged into. Chrome/Edge, https or localhost.
 *   2. `embed` — when the dashboard runs inside Wireup's /simulation page, the
 *      parent relays the same byte stream to and from the Velxio emulator over
 *      postMessage. Same bytes, same protocol, emulated silicon instead of
 *      real silicon.
 *
 * There is no third "demo" transport that makes numbers up. If neither link is
 * available the dashboard says so and shows nothing.
 */

import type { DeviceContract, DeviceMetric } from './contract';

/** JSON-safe string literal for embedding in generated TS. */
function lit(value: string): string {
  return JSON.stringify(value);
}

export function packageJson(slug: string): string {
  return `${JSON.stringify(
    {
      name: slug,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc -b && vite build',
        preview: 'vite preview',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
      devDependencies: {
        '@types/react': '^19.0.7',
        '@types/react-dom': '^19.0.3',
        '@vitejs/plugin-react': '^4.3.4',
        typescript: '^5.7.3',
        vite: '^6.0.7',
      },
    },
    null,
    2,
  )}\n`;
}

export function tsconfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        types: ['vite/client'],
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`;
}

/**
 * The dev server config for the generated dashboard.
 *
 * Two settings exist purely so the embed in Wireup's /simulation page works,
 * and both are the kind of thing that fails invisibly:
 *
 *   `allowedHosts: true` — Vite 6 rejects requests whose Host header it does
 *     not recognise, answering with a blank error page inside the iframe.
 *
 *   frame-ancestors — Wireup may be running anywhere (localhost during
 *     development, a deployed origin otherwise) while this dashboard is always
 *     on the user's own machine. A restrictive ancestor list would therefore
 *     break the primary use case — a hosted Wireup framing a local dashboard —
 *     with a console-only error. This is a dev server bound to the user's own
 *     machine serving no secrets and holding no session, so permitting framing
 *     is the correct trade. Tighten it for anything you actually deploy.
 */
export function viteConfig(): string {
  return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard runs on 5175 so it can sit next to Velxio (5174) inside
 * Wireup's /simulation page without a port clash.
 *
 * Framing is deliberately open: the Wireup page that embeds this dashboard may
 * be served from anywhere, while this dev server only ever runs on your own
 * machine. If you deploy this dashboard, replace the header below with an
 * explicit \`frame-ancestors\` list.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5175,
    strictPort: true,
    // Vite 6 blocks unrecognised Host headers; in an iframe that failure is
    // invisible, so accept them here.
    allowedHosts: true,
    headers: {
      'Content-Security-Policy': 'frame-ancestors *',
    },
    cors: true,
  },
  preview: {
    port: 5175,
    strictPort: true,
    headers: {
      'Content-Security-Policy': 'frame-ancestors *',
    },
  },
});
`;
}

export function indexHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(projectName)} — dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function envDts(): string {
  return `/// <reference types="vite/client" />\n`;
}

/* -------------------------------------------------------------------------- */
/* The contract, as data the app imports                                      */
/* -------------------------------------------------------------------------- */

export function contractModule(contract: DeviceContract): string {
  return `/**
 * The device contract — generated from this project's pin plan and firmware.
 *
 * Every field listed here is a key the firmware's \`sendTelemetry()\` actually
 * prints, and every command is a character its \`handleCommand()\` switch
 * actually accepts. Editing this file by hand desynchronises the dashboard
 * from the board; regenerate the project instead.
 */

export interface DeviceMetric {
  field: string;
  label: string;
  unit: string;
  kind: 'number' | 'string';
  min?: number;
  max?: number;
  precision?: number;
  source: string;
}

export interface DeviceCommand {
  character: string;
  label: string;
  meaning: string;
  builtIn: boolean;
}

export interface DeviceContract {
  projectName: string;
  controller: string;
  baud: number;
  telemetryPrefix: string;
  telemetryIntervalMs: number;
  metrics: DeviceMetric[];
  commands: DeviceCommand[];
  transport: string;
  caveats: string[];
}

export const contract: DeviceContract = ${JSON.stringify(contract, null, 2)};
`;
}

/* -------------------------------------------------------------------------- */
/* Protocol parser                                                            */
/* -------------------------------------------------------------------------- */

export function protocolModule(contract: DeviceContract): string {
  return `/**
 * The board's line protocol, parsed.
 *
 * The firmware prints newline-terminated lines:
 *
 *   ${contract.telemetryPrefix}{"state":"idle","speed":70,...}   telemetry frame
 *   ok:<text>                                   an accepted command
 *   warn:<text> / err:<text>                    a problem the board reports
 *   anything else                               free-form log output
 *
 * Serial arrives in arbitrary chunks, so \`LineAssembler\` buffers partial
 * lines rather than dropping a frame that happened to be split across two
 * reads — the most common source of "the dashboard flickers" bugs.
 */

export type BoardLine =
  | { kind: 'telemetry'; values: Record<string, number | string>; raw: string }
  | { kind: 'ok' | 'warn' | 'error'; text: string; raw: string }
  | { kind: 'log'; text: string; raw: string };

const TELEMETRY_PREFIX = ${lit(contract.telemetryPrefix)};

export function parseLine(raw: string): BoardLine | null {
  const line = raw.replace(/\\r$/, '').trim();
  if (line.length === 0) return null;

  if (line.startsWith(TELEMETRY_PREFIX)) {
    const body = line.slice(TELEMETRY_PREFIX.length).trim();
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const values: Record<string, number | string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'number' || typeof value === 'string') values[key] = value;
        }
        return { kind: 'telemetry', values, raw: line };
      }
    } catch {
      // A truncated frame is a log line, not a crash. The next frame is 1 s away.
    }
    return { kind: 'log', text: line, raw: line };
  }

  if (line.startsWith('ok:')) return { kind: 'ok', text: line.slice(3).trim(), raw: line };
  if (line.startsWith('warn:')) return { kind: 'warn', text: line.slice(5).trim(), raw: line };
  if (line.startsWith('err:')) return { kind: 'error', text: line.slice(4).trim(), raw: line };
  return { kind: 'log', text: line, raw: line };
}

/** Reassembles newline-delimited lines out of arbitrary serial chunks. */
export class LineAssembler {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\\n');
    // The last element is either '' (chunk ended on a newline) or a partial
    // line that must wait for the next chunk.
    this.buffer = parts.pop() ?? '';
    // A board stuck printing without newlines must not grow this unbounded.
    if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-1024);
    return parts;
  }

  reset(): void {
    this.buffer = '';
  }
}
`;
}

/* -------------------------------------------------------------------------- */
/* Transports                                                                 */
/* -------------------------------------------------------------------------- */

export function linkModule(): string {
  return `/**
 * The link to the board — two real transports, no fake one.
 *
 *   webserial : the Web Serial API, talking to the USB port the board is
 *               plugged into. Chrome/Edge only, and the browser demands a
 *               user gesture before it will show the port picker.
 *   embed     : this dashboard is running inside Wireup's /simulation page.
 *               The parent relays the byte stream to and from the Velxio
 *               emulator over postMessage. Identical protocol; the silicon is
 *               emulated instead of physical.
 *
 * Both implement the same \`BoardLink\` interface, so nothing above this file
 * knows or cares which one is live.
 */

export type LinkKind = 'webserial' | 'embed';

export type LinkState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; kind: LinkKind; detail: string }
  | { status: 'error'; message: string };

export interface BoardLink {
  readonly kind: LinkKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Write raw characters to the board's RX. */
  write(data: string): Promise<void>;
  /** Called with every chunk that arrives. */
  onData(handler: (chunk: string) => void): void;
  onStateChange(handler: (state: LinkState) => void): void;
  readonly state: LinkState;
}

abstract class BaseLink implements BoardLink {
  abstract readonly kind: LinkKind;
  protected dataHandlers: ((chunk: string) => void)[] = [];
  protected stateHandlers: ((state: LinkState) => void)[] = [];
  protected current: LinkState = { status: 'disconnected' };

  get state(): LinkState {
    return this.current;
  }

  onData(handler: (chunk: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onStateChange(handler: (state: LinkState) => void): void {
    this.stateHandlers.push(handler);
    handler(this.current);
  }

  protected emitData(chunk: string): void {
    for (const handler of this.dataHandlers) handler(chunk);
  }

  protected setState(state: LinkState): void {
    this.current = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract write(data: string): Promise<void>;
}

/* ── Web Serial ─────────────────────────────────────────────────────────── */

// Minimal structural types: @types/w3c-web-serial is not a dependency, and
// declaring exactly what is used keeps the project dependency-free without
// resorting to \`any\`.
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

function serialApi(): SerialLike | null {
  const candidate = (navigator as unknown as { serial?: SerialLike }).serial;
  return candidate ?? null;
}

export function webSerialSupported(): boolean {
  return serialApi() !== null;
}

export class WebSerialLink extends BaseLink {
  readonly kind = 'webserial' as const;
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closing = false;

  constructor(private readonly baudRate: number) {
    super();
  }

  async connect(): Promise<void> {
    const serial = serialApi();
    if (!serial) {
      this.setState({
        status: 'error',
        message:
          'This browser has no Web Serial API. Use Chrome or Edge over https or localhost, or run the dashboard inside Wireup\\'s simulation page.',
      });
      return;
    }
    this.setState({ status: 'connecting' });
    try {
      // requestPort() must be called from a user gesture — the UI only ever
      // calls connect() from a click for exactly this reason.
      const port = await serial.requestPort();
      await port.open({ baudRate: this.baudRate });
      this.port = port;
      this.closing = false;

      const info = port.getInfo();
      const detail =
        info.usbVendorId !== undefined
          ? \`USB \${info.usbVendorId.toString(16).padStart(4, '0')}:\${(info.usbProductId ?? 0)
              .toString(16)
              .padStart(4, '0')} @ \${this.baudRate} baud\`
          : \`serial port @ \${this.baudRate} baud\`;
      this.setState({ status: 'connected', kind: 'webserial', detail });

      if (port.writable) this.writer = port.writable.getWriter();
      void this.readLoop();
    } catch (error) {
      this.setState({ status: 'error', message: describe(error) });
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.port?.readable) return;
    const decoder = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.emitData(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!this.closing) this.setState({ status: 'error', message: describe(error) });
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      if (!this.closing) this.setState({ status: 'disconnected' });
    }
  }

  async write(data: string): Promise<void> {
    if (!this.writer) throw new Error('The serial port is not open for writing.');
    await this.writer.write(new TextEncoder().encode(data));
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      // Cancelling an already-dead reader is not worth reporting.
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // Same.
    }
    this.writer = null;
    try {
      await this.port?.close();
    } catch {
      // Same.
    }
    this.port = null;
    this.setState({ status: 'disconnected' });
  }
}

/* ── Embedded (Wireup /simulation ⇄ Velxio) ─────────────────────────────── */

/**
 * Protocol with the Wireup host page. The host owns the Velxio iframe; this
 * dashboard never talks to Velxio directly (different origin, and the host
 * has to arbitrate which board is loaded anyway).
 *
 *   dashboard → host   { type: 'wireup:dash-ready' }
 *   dashboard → host   { type: 'wireup:dash-write', data }
 *   host → dashboard   { type: 'wireup:serial-data', chunk }
 *   host → dashboard   { type: 'wireup:link-state', connected, detail }
 */
export class EmbedLink extends BaseLink {
  readonly kind = 'embed' as const;
  private listener: ((event: MessageEvent) => void) | null = null;

  async connect(): Promise<void> {
    if (window.parent === window) {
      this.setState({
        status: 'error',
        message: 'This dashboard is not embedded, so there is no host to relay the emulator through.',
      });
      return;
    }
    this.setState({ status: 'connecting' });
    this.listener = (event: MessageEvent) => {
      const message = event.data as { type?: unknown; chunk?: unknown; connected?: unknown; detail?: unknown };
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'wireup:serial-data' && typeof message.chunk === 'string') {
        this.emitData(message.chunk);
        return;
      }
      if (message.type === 'wireup:link-state') {
        this.setState(
          message.connected
            ? {
                status: 'connected',
                kind: 'embed',
                detail: typeof message.detail === 'string' ? message.detail : 'Velxio emulator via Wireup',
              }
            : { status: 'disconnected' },
        );
      }
    };
    window.addEventListener('message', this.listener);
    // '*' is correct here: the dashboard does not know the host's origin, and
    // the payload is a capability-free hello. Everything the host sends back
    // is validated above before it is believed.
    window.parent.postMessage({ type: 'wireup:dash-ready' }, '*');
  }

  async write(data: string): Promise<void> {
    if (window.parent === window) throw new Error('Not embedded — nothing to write to.');
    window.parent.postMessage({ type: 'wireup:dash-write', data }, '*');
  }

  async disconnect(): Promise<void> {
    if (this.listener) window.removeEventListener('message', this.listener);
    this.listener = null;
    this.setState({ status: 'disconnected' });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotFoundError') return 'No serial port was selected.';
    if (error.name === 'NetworkError') return 'The serial port is already open in another program.';
    return error.message;
  }
  return String(error);
}

/** True when this page is running inside a frame (i.e. inside Wireup). */
export function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true; // A cross-origin parent throws on access — that means embedded.
  }
}
`;
}

/* -------------------------------------------------------------------------- */
/* React app                                                                  */
/* -------------------------------------------------------------------------- */

export function useBoardHook(): string {
  return `/**
 * One hook owning the board link, the latest telemetry and the log.
 *
 * State that changes 1×/second (telemetry) and state that changes on every
 * chunk (the log) are deliberately kept in the same reducer-ish shape so a
 * burst of serial output causes one render, not one per line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { contract } from './contract';
import { LineAssembler, parseLine, type BoardLine } from './protocol';
import { EmbedLink, WebSerialLink, isEmbedded, webSerialSupported, type BoardLink, type LinkKind, type LinkState } from './link';

export interface LogEntry {
  id: number;
  at: string;
  line: BoardLine;
}

const MAX_LOG = 300;

export function useBoard() {
  const [linkKind, setLinkKind] = useState<LinkKind>(() => (isEmbedded() ? 'embed' : 'webserial'));
  const [state, setState] = useState<LinkState>({ status: 'disconnected' });
  const [telemetry, setTelemetry] = useState<Record<string, number | string>>({});
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const linkRef = useRef<BoardLink | null>(null);
  const assembler = useRef(new LineAssembler());
  const logSeq = useRef(0);

  const build = useCallback(
    (kind: LinkKind): BoardLink => (kind === 'embed' ? new EmbedLink() : new WebSerialLink(contract.baud)),
    [],
  );

  const attach = useCallback((link: BoardLink) => {
    link.onStateChange(setState);
    link.onData((chunk) => {
      const lines = assembler.current.push(chunk);
      if (lines.length === 0) return;
      const parsed = lines.map(parseLine).filter((line): line is BoardLine => line !== null);
      if (parsed.length === 0) return;

      const frame = [...parsed].reverse().find((line) => line.kind === 'telemetry');
      if (frame && frame.kind === 'telemetry') {
        setTelemetry((current) => ({ ...current, ...frame.values }));
        setLastFrameAt(Date.now());
      }
      setLog((current) => {
        const entries = parsed.map((line) => ({
          id: (logSeq.current += 1),
          at: new Date().toLocaleTimeString(),
          line,
        }));
        const next = [...current, ...entries];
        return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
      });
    });
  }, []);

  const connect = useCallback(async () => {
    await linkRef.current?.disconnect();
    assembler.current.reset();
    const link = build(linkKind);
    linkRef.current = link;
    attach(link);
    await link.connect();
  }, [attach, build, linkKind]);

  const disconnect = useCallback(async () => {
    await linkRef.current?.disconnect();
    linkRef.current = null;
  }, []);

  // Embedded mode needs no user gesture, so it attaches itself: the dashboard
  // is live the moment the /simulation page shows it.
  useEffect(() => {
    if (linkKind !== 'embed') return;
    void connect();
    return () => {
      void linkRef.current?.disconnect();
    };
  }, [connect, linkKind]);

  const send = useCallback(async (character: string) => {
    const link = linkRef.current;
    if (!link || link.state.status !== 'connected') return;
    await link.write(character);
  }, []);

  const stale = useMemo(() => {
    if (lastFrameAt === null) return false;
    return Date.now() - lastFrameAt > contract.telemetryIntervalMs * 3;
  }, [lastFrameAt]);

  return {
    linkKind,
    setLinkKind,
    state,
    telemetry,
    lastFrameAt,
    stale,
    log,
    connect,
    disconnect,
    send,
    canUseWebSerial: webSerialSupported(),
    embedded: isEmbedded(),
    clearLog: () => setLog([]),
  };
}
`;
}

export function appComponent(contract: DeviceContract): string {
  return `/**
 * ${contract.projectName} — live dashboard.
 *
 * Every card below corresponds to a field this project's firmware prints, and
 * every button to a character its command parser accepts. When the board is
 * not connected the cards are empty — the dashboard never substitutes a
 * plausible-looking number for a reading it does not have.
 */
import { contract } from './contract';
import { useBoard } from './useBoard';
import './app.css';

function formatValue(value: number | string | undefined, precision: number | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '—';
  return precision === undefined ? String(value) : value.toFixed(precision);
}

export default function App() {
  const board = useBoard();
  const connected = board.state.status === 'connected';

  return (
    <div className="app">
      <header className="bar">
        <div>
          <h1>{contract.projectName}</h1>
          <p className="sub">
            {contract.controller} · {contract.transport}
          </p>
        </div>

        <div className="link">
          <span className={\`dot dot--\${board.state.status}\`} aria-hidden />
          <span className="link__label">
            {board.state.status === 'connected'
              ? board.state.detail
              : board.state.status === 'error'
                ? board.state.message
                : board.state.status === 'connecting'
                  ? 'connecting…'
                  : 'not connected'}
          </span>

          {!board.embedded && (
            <button type="button" onClick={() => (connected ? void board.disconnect() : void board.connect())}>
              {connected ? 'Disconnect' : 'Connect to the board'}
            </button>
          )}
        </div>
      </header>

      {!board.embedded && !board.canUseWebSerial && (
        <p className="notice">
          This browser has no Web Serial API, so the dashboard cannot open the board's USB port. Use Chrome or
          Edge, or open this dashboard inside Wireup's simulation page to drive the emulated board instead.
        </p>
      )}

      {board.stale && connected && (
        <p className="notice">
          No telemetry frame for over {Math.round((contract.telemetryIntervalMs * 3) / 1000)} s — the board may
          have stopped, reset, or lost its link. The values below are the last ones it sent.
        </p>
      )}

      <main>
        <section>
          <h2>Readings</h2>
          <div className="grid">
${contract.metrics.map((metric) => metricCard(metric)).join('\n')}
          </div>
        </section>

${contract.commands.length > 0 ? commandSection() : readOnlySection()}

        <section>
          <h2>
            Board output
            <button type="button" className="ghost" onClick={board.clearLog}>
              clear
            </button>
          </h2>
          <div className="log">
            {board.log.length === 0 ? (
              <p className="empty">Nothing received yet.</p>
            ) : (
              board.log.map((entry) => (
                <div key={entry.id} className={\`log__line log__line--\${entry.line.kind}\`}>
                  <span className="log__at">{entry.at}</span>
                  <span className="log__text">{entry.line.raw}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      <footer>
        <h2>What this dashboard is and is not</h2>
        <ul>
${contract.caveats.map((caveat) => `          <li>${escapeJsxText(caveat)}</li>`).join('\n')}
        </ul>
      </footer>
    </div>
  );
}
`;
}

function metricCard(metric: DeviceMetric): string {
  const range =
    metric.min !== undefined && metric.max !== undefined
      ? `              <span className="card__range">${metric.min}–${metric.max}${metric.unit ? ` ${escapeJsxText(metric.unit)}` : ''}</span>\n`
      : '';
  return `            <article className="card">
              <h3>${escapeJsxText(metric.label)}</h3>
              <p className="card__value">
                {formatValue(board.telemetry[${lit(metric.field)}], ${metric.precision === undefined ? 'undefined' : metric.precision})}
                ${metric.unit ? `<span className="card__unit">${escapeJsxText(metric.unit)}</span>` : ''}
              </p>
${range}              <p className="card__src">${escapeJsxText(metric.source)}</p>
            </article>`;
}

function commandSection(): string {
  return `        <section>
          <h2>Controls</h2>
          <p className="sub">
            Each button writes one character to the board's link — the same byte you would type into a serial
            monitor.
          </p>
          <div className="commands">
            {contract.commands.map((command) => (
              <button
                key={command.character}
                type="button"
                disabled={!connected}
                title={command.meaning}
                onClick={() => void board.send(command.character)}
              >
                <span className="commands__char">{command.character}</span>
                <span>{command.label}</span>
              </button>
            ))}
          </div>
          {!connected && <p className="empty">Connect to the board to enable the controls.</p>}
        </section>
`;
}

function readOnlySection(): string {
  return `        <section>
          <h2>Controls</h2>
          <p className="empty">
            This project's firmware defines no command set, so there is nothing to send. The dashboard is
            read-only by design, not by omission.
          </p>
        </section>
`;
}

/** JSX text is not HTML: only braces and angle brackets need escaping. */
function escapeJsxText(value: string): string {
  return value.replace(/[{}<>]/g, (char) => `{'${char}'}`);
}

export function mainTsx(): string {
  return `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing its #root element.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;
}

export function appCss(): string {
  return `:root {
  --bg: #fbfbfd;
  --panel: #ffffff;
  --ink: #1d1d1f;
  --muted: #6e6e73;
  --line: #e3e3e8;
  --accent: #0071e3;
  --ok: #1b9e4b;
  --warn: #b26a00;
  --err: #c8372d;
  color-scheme: light;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

.app { max-width: 1080px; margin: 0 auto; padding: 24px 20px 56px; }

.bar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 28px 0 12px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
h3 { margin: 0 0 6px; font-size: 12px; font-weight: 500; color: var(--muted); }
.sub { margin: 4px 0 0; color: var(--muted); font-size: 12px; }

.link { display: flex; align-items: center; gap: 10px; }
.link__label { font-size: 12px; color: var(--muted); max-width: 320px; }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.dot--connected { background: var(--ok); }
.dot--connecting { background: var(--warn); }
.dot--error { background: var(--err); }

button {
  font: inherit;
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.ghost { border: none; background: none; color: var(--muted); font-size: 11px; padding: 2px 6px; }

.notice {
  margin: 16px 0 0;
  padding: 10px 12px;
  border: 1px solid #f0d9a8;
  background: #fff9ec;
  border-radius: 8px;
  font-size: 13px;
}

.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }

.card {
  padding: 14px 16px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.card__value { margin: 0; font-size: 26px; font-weight: 500; letter-spacing: -0.02em; }
.card__unit { margin-left: 4px; font-size: 13px; color: var(--muted); font-weight: 400; }
.card__range, .card__src { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); }

.commands { display: flex; flex-wrap: wrap; gap: 8px; }
.commands button { display: flex; align-items: center; gap: 8px; }
.commands__char {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  border-radius: 5px;
  background: #f1f1f4;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.log {
  max-height: 300px;
  overflow: auto;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.log__line { display: flex; gap: 10px; padding: 1px 0; }
.log__at { color: #b0b0b8; flex: none; }
.log__text { white-space: pre-wrap; word-break: break-word; }
.log__line--ok .log__text { color: var(--ok); }
.log__line--warn .log__text { color: var(--warn); }
.log__line--error .log__text { color: var(--err); }
.log__line--telemetry .log__text { color: var(--muted); }

.empty { margin: 8px 0 0; color: var(--muted); font-size: 12px; }

footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid var(--line); }
footer ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
footer li { margin-bottom: 4px; }
`;
}

export function readme(contract: DeviceContract, slug: string): string {
  const metricRows = contract.metrics
    .map((metric) => `| \`${metric.field}\` | ${metric.label} | ${metric.unit || '—'} | ${metric.source} |`)
    .join('\n');
  const commandRows =
    contract.commands.length > 0
      ? contract.commands
          .map((command) => `| \`${command.character}\` | ${command.label} | ${command.meaning} |`)
          .join('\n')
      : '| — | — | This firmware defines no command set. |';

  return `# ${contract.projectName} — dashboard

Generated by Wireup from this project's pin plan and firmware. It is a plain
Vite + React + TypeScript app with no runtime dependencies beyond React.

## Run it

\`\`\`bash
npm install
npm run dev      # http://localhost:5175
\`\`\`

\`\`\`bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -b && vite build
\`\`\`

> Nothing was installed, built or executed when this zip was produced. The
> Wireup pipeline generates and statically validates the sources; \`npm install\`
> on your machine is the first time any dependency is fetched.

## How it reaches the board

Two transports, both real:

1. **Web Serial** — click *Connect to the board* and pick the port your
   ${contract.controller} is plugged into. Chrome or Edge, over \`localhost\` or
   https. The dashboard opens the port at **${contract.baud} baud**, the same
   rate \`setup()\` calls \`controlLink.begin()\` with.
2. **Embedded** — open this dashboard inside Wireup's **/simulation** page. The
   host relays the byte stream to and from the Velxio emulator, so the same
   parser and the same buttons drive emulated silicon. No code path differs.

There is no demo/mock transport. If no link is open, the cards stay empty.

## The protocol

The firmware prints newline-terminated lines. \`src/protocol.ts\` parses them:

| line | meaning |
| ---- | ------- |
| \`${contract.telemetryPrefix}{…}\` | a telemetry frame, at most every ${contract.telemetryIntervalMs} ms |
| \`ok:…\` | a command was accepted |
| \`warn:…\` / \`err:…\` | the board is reporting a problem |

### Telemetry fields

| field | shown as | unit | produced by |
| ----- | -------- | ---- | ----------- |
${metricRows}

### Commands

Each is a single character written to the board's link.

| char | button | meaning |
| ---- | ------ | ------- |
${commandRows}

## Caveats

${contract.caveats.map((caveat) => `- ${caveat}`).join('\n')}

## Layout

\`\`\`
${slug}/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── App.tsx        UI — cards and buttons, generated from the contract
    ├── app.css
    ├── contract.ts    the generated device contract (do not hand-edit)
    ├── link.ts        Web Serial + embedded transports
    ├── main.tsx
    ├── protocol.ts    line parser + chunk reassembly
    └── useBoard.ts    the one hook that owns the link and the state
\`\`\`
`;
}

export function gitignore(): string {
  return `node_modules/
dist/
*.local
.DS_Store
`;
}
