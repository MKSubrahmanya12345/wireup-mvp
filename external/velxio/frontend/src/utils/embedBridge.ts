/**
 * Embed bridge — lets a PARENT page (Wireup's /simulation page) drive this
 * Velxio instance when it runs inside an iframe. Wireup vendors Velxio under
 * `external/velxio` and embeds it; without this bridge the only way in is the
 * manual file picker, which no parent page can trigger cross-origin.
 *
 * Protocol (window.postMessage, JSON-serialisable payloads only):
 *
 *   ── project ────────────────────────────────────────────────────────────
 *   parent → velxio   { type: 'velxio:load-vlx', vlx: string | VlxPayload }
 *     Loads a .vlx project into the canvas — the exact same code path as the
 *     Import button (validation included). Replies with
 *     { type: 'velxio:vlx-loaded', name } or { type: 'velxio:vlx-error', message }.
 *
 *   parent → velxio   { type: 'velxio:export-vlx', name?: string }
 *     Serialises the CURRENT canvas (boards + components + wires + files) and
 *     replies with { type: 'velxio:vlx-export', vlx: VlxPayload }. This is the
 *     other half of the bidirectional sync: canvas edits flow back to the
 *     parent, which folds them into its own diagram.json.
 *
 *   ── run control ────────────────────────────────────────────────────────
 *   parent → velxio   { type: 'velxio:run' | 'velxio:stop' | 'velxio:reset' }
 *     Drives the simulation the same way the toolbar buttons do. Each replies
 *     with { type: 'velxio:run-state', running }.
 *
 *   ── SERIAL — the real hardware⇄software link ───────────────────────────
 *   parent → velxio   { type: 'velxio:serial-subscribe' }
 *     Starts streaming the board's UART output to the parent as
 *     { type: 'velxio:serial-data', chunk } messages (one per store update,
 *     carrying only the bytes appended since the last one). Also replays what
 *     the board has already printed so a late subscriber is not blind.
 *   parent → velxio   { type: 'velxio:serial-unsubscribe' }
 *   parent → velxio   { type: 'velxio:serial-write', data: string }
 *     Writes into the board's UART RX — this is how the generated dashboard's
 *     buttons reach the firmware's command parser. Nothing is faked: the bytes
 *     go through `serialWrite`, exactly like typing in the serial monitor.
 *
 *   ── lifecycle ──────────────────────────────────────────────────────────
 *   velxio → parent   { type: 'velxio:ready' }
 *     Fired once on startup (embedded contexts only) so the parent knows when
 *     it may start posting.
 *
 * Security: the bridge only activates when the window is actually embedded,
 * and every reply goes to event.origin — never '*'. Loading a project is the
 * same trust decision as the user importing a file; nothing here can touch
 * accounts, storage or the host machine.
 */
import { buildVlxPayload, importVlxFile } from './vlxFile';
import { useSimulatorStore } from '../store/useSimulatorStore';

interface BridgeMessage {
  type?: unknown;
  vlx?: unknown;
  name?: unknown;
  data?: unknown;
}

function reply(event: MessageEvent, payload: Record<string, unknown>): void {
  (event.source as WindowProxy | null)?.postMessage(payload, event.origin);
}

/** One subscriber = one parent window/origin pair. */
interface SerialSubscriber {
  source: WindowProxy;
  origin: string;
  /** How much of `serialOutput` this subscriber has already been sent. */
  cursor: number;
}

let subscribers: SerialSubscriber[] = [];
let unsubscribeStore: (() => void) | null = null;

/**
 * Push newly-printed UART bytes to every subscriber.
 *
 * `serialOutput` is an append-only string in the store, so the diff is a
 * plain slice from each subscriber's own cursor. A board reset truncates it;
 * that is detected by the string getting shorter and the cursor is rewound
 * rather than slicing garbage.
 */
function flushSerial(output: string): void {
  for (const subscriber of subscribers) {
    if (output.length < subscriber.cursor) subscriber.cursor = 0; // reset/clear
    if (output.length === subscriber.cursor) continue;
    const chunk = output.slice(subscriber.cursor);
    subscriber.cursor = output.length;
    try {
      subscriber.source.postMessage({ type: 'velxio:serial-data', chunk }, subscriber.origin);
    } catch {
      // A closed parent window is not an error worth surfacing; it is dropped
      // on the next subscriber sweep below.
    }
  }
  subscribers = subscribers.filter((subscriber) => !subscriber.source.closed);
}

function ensureSerialWatch(): void {
  if (unsubscribeStore) return;
  let previous = useSimulatorStore.getState().serialOutput;
  unsubscribeStore = useSimulatorStore.subscribe((state) => {
    const output = state.serialOutput;
    if (output === previous) return;
    previous = output;
    flushSerial(output);
  });
}

function stopSerialWatch(): void {
  if (subscribers.length > 0 || !unsubscribeStore) return;
  unsubscribeStore();
  unsubscribeStore = null;
}

function postRunState(event: MessageEvent): void {
  reply(event, { type: 'velxio:run-state', running: useSimulatorStore.getState().running });
}

export function initEmbedBridge(): void {
  if (window.parent === window) return; // not embedded — stay inert

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as BridgeMessage;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'velxio:load-vlx': {
        const text = typeof message.vlx === 'string' ? message.vlx : JSON.stringify(message.vlx);
        const file = new File([text], 'embedded.vlx', { type: 'application/json' });
        importVlxFile(file)
          .then((payload) => reply(event, { type: 'velxio:vlx-loaded', name: payload.name ?? null }))
          .catch((err: unknown) =>
            reply(event, {
              type: 'velxio:vlx-error',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }

      case 'velxio:export-vlx': {
        try {
          const payload = buildVlxPayload(typeof message.name === 'string' ? { name: message.name } : {});
          reply(event, { type: 'velxio:vlx-export', vlx: payload });
        } catch (err: unknown) {
          reply(event, {
            type: 'velxio:vlx-error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case 'velxio:run':
        useSimulatorStore.getState().startSimulation();
        postRunState(event);
        return;

      case 'velxio:stop':
        useSimulatorStore.getState().stopSimulation();
        postRunState(event);
        return;

      case 'velxio:reset':
        useSimulatorStore.getState().resetSimulation();
        postRunState(event);
        return;

      case 'velxio:run-state':
        postRunState(event);
        return;

      case 'velxio:serial-subscribe': {
        const source = event.source as WindowProxy | null;
        if (!source) return;
        const existing = subscribers.find(
          (subscriber) => subscriber.source === source && subscriber.origin === event.origin,
        );
        // Replaying from 0 means a dashboard that attaches late still sees the
        // telemetry the firmware has already printed.
        if (existing) existing.cursor = 0;
        else subscribers.push({ source, origin: event.origin, cursor: 0 });
        ensureSerialWatch();
        flushSerial(useSimulatorStore.getState().serialOutput);
        reply(event, { type: 'velxio:serial-subscribed' });
        return;
      }

      case 'velxio:serial-unsubscribe': {
        subscribers = subscribers.filter(
          (subscriber) => !(subscriber.source === event.source && subscriber.origin === event.origin),
        );
        stopSerialWatch();
        return;
      }

      case 'velxio:serial-write': {
        if (typeof message.data !== 'string' || message.data.length === 0) return;
        try {
          useSimulatorStore.getState().serialWrite(message.data);
        } catch (err: unknown) {
          reply(event, {
            type: 'velxio:serial-error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      default:
    }
  });

  window.parent.postMessage({ type: 'velxio:ready' }, '*');
}
