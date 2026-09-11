'use client';

/**
 * SIMULATION — the two halves of a build, one toggle.
 *
 *   ⚡ Simulation — the Velxio emulator you run at localhost:5174, embedded.
 *                  This build's circuit and firmware land on the canvas the
 *                  moment the iframe reports ready: no manual .vlx import.
 *                  Canvas edits can be pulled back into this project's
 *                  diagram.json, as a revision.
 *
 *   🖥 Website    — the dashboard this build generated, running from the zip
 *                  you unzipped at localhost:5175. It is the real generated
 *                  bundle, served by your own dev server.
 *
 * ── The part that makes it not a demo ───────────────────────────────────────
 * This page is the RELAY between them. Both iframes are cross-origin to each
 * other, so they cannot talk directly; this page can talk to both, and it
 * pumps bytes across:
 *
 *   Velxio  --serial-data-->  this page  --wireup:serial-data-->  Dashboard
 *   Velxio  <--serial-write-- this page  <--wireup:dash-write---  Dashboard
 *
 * The bytes are the firmware's actual UART output and the dashboard's actual
 * command characters. Nothing in the loop is synthesised: turn the emulator
 * off and the dashboard's cards stop updating, because there is nothing left
 * to update them.
 *
 * Both iframes are the user's own localhost services. Wireup's server never
 * fetches them — it cannot reach the user's machine — so everything here is
 * browser-side by necessity as well as by design.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge, Card, Empty, Loader, Notice, SectionTitle } from '../ui';
import { useHub } from '../hub-context';
import { fetchSimulation, syncCanvas, type SimulationPayload } from '../api';
import { useVelxioBridge } from '../velxio-bridge';
import { useDashboardRelay } from '../dashboard-relay';

type View = 'simulation' | 'website';

export function SimulationPanel() {
  const { project, running, details, refresh } = useHub();
  const projectId = project?.id ?? null;

  const [payload, setPayload] = useState<SimulationPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('simulation');
  const [syncNote, setSyncNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  /* ── Load the bundle ---------------------------------------------------- */
  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const next = await fetchSimulation(projectId);
      setPayload(next);
      setLoadError(null);
      setView(next.config.defaultView);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load the simulation bundle.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the pipeline runs, the diagram and firmware appear one after the
  // other. Re-fetch when the project's revision moves so the halves light up
  // without the user reloading.
  const revision = project?.revision ?? 0;
  const stage = project?.stage ?? 'idle';
  useEffect(() => {
    if (!payload) return;
    if (payload.revision === revision && payload.velxio && payload.software) return;
    void load();
    // `stage` is in the deps on purpose: it moves during a run even when the
    // revision does not, and each move can unblock a half.
  }, [revision, stage, load, payload]);

  const velxioUrl = payload?.config.velxioUrl ?? null;
  const websiteUrl = payload?.config.websiteUrl ?? null;
  const vlx = payload?.velxio?.vlx ?? null;

  /* ── Bridges ------------------------------------------------------------ */
  const velxio = useVelxioBridge({ embedUrl: velxioUrl, autoPushVlx: vlx });
  const dashboard = useDashboardRelay({
    embedUrl: websiteUrl,
    // Bytes the emulator printed go straight to the dashboard.
    serialOut: velxio.serialChunk,
    connected: velxio.status.state === 'pushed' || velxio.status.state === 'ready',
    // Bytes the dashboard's buttons produce go straight into the emulator.
    onWrite: velxio.serialWrite,
  });

  // Velxio only streams serial once someone asks for it. Ask as soon as the
  // canvas is live, so the dashboard is never waiting on a subscription the
  // user cannot see or trigger.
  useEffect(() => {
    if (velxio.status.state !== 'pushed') return;
    velxio.subscribeSerial();
  }, [velxio]);

  /* ── Canvas → diagram.json --------------------------------------------- */
  const pullCanvas = useCallback(async () => {
    if (!projectId) return;
    setSyncing(true);
    setSyncNote(null);
    try {
      const canvas = await velxio.pull();
      const result = await syncCanvas(projectId, canvas);
      setSyncNote({
        tone: 'ok',
        text: `Saved as revision ${result.revision}. ${result.summary}`,
      });
      await refresh();
      await load();
    } catch (error) {
      setSyncNote({
        tone: 'err',
        text: error instanceof Error ? error.message : 'Pulling the canvas failed.',
      });
    } finally {
      setSyncing(false);
    }
  }, [projectId, velxio, refresh, load]);

  /* ── Render ------------------------------------------------------------- */
  if (loading && !payload) {
    return (
      <Card title="Simulation" wide>
        <Loader label="Preparing the simulator project and the dashboard" />
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card title="Simulation" wide>
        <Notice tone="err" title="Could not prepare this page">
          {loadError}
        </Notice>
      </Card>
    );
  }

  if (!payload) {
    return (
      <Card title="Simulation" wide>
        <Empty>No simulation data for this project.</Empty>
      </Card>
    );
  }

  return (
    <div className="sim">
      <div className="sim__bar">
        <div className="sim__swap" role="group" aria-label="Switch between the simulation and the website">
          <button
            type="button"
            className={view === 'simulation' ? 'sim__swap-btn sim__swap-btn--on' : 'sim__swap-btn'}
            aria-pressed={view === 'simulation'}
            onClick={() => setView('simulation')}
          >
            ⚡ Simulation
          </button>
          <button
            type="button"
            className={view === 'website' ? 'sim__swap-btn sim__swap-btn--on' : 'sim__swap-btn'}
            aria-pressed={view === 'website'}
            onClick={() => setView('website')}
          >
            🖥 Website
          </button>
        </div>

        <span className="sim__spacer" />

        <LinkPill label="emulator" state={velxioStatusLabel(velxio.status.state)} tone={velxioTone(velxio.status.state)} />
        <LinkPill
          label="dashboard"
          state={dashboard.attached ? 'attached' : 'waiting'}
          tone={dashboard.attached ? 'ok' : 'neutral'}
        />
        <LinkPill
          label="bytes"
          state={`${dashboard.bytesToDashboard} ↓ / ${dashboard.bytesToBoard} ↑`}
          tone={dashboard.bytesToDashboard > 0 ? 'ok' : 'neutral'}
        />

        <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {running ? (
        <Notice tone="info" title="This build is still running">
          The halves below appear as the pipeline produces them — the circuit first, then the firmware, then the
          dashboard derived from it. Nothing needs a reload.
        </Notice>
      ) : null}

      {/* Both iframes stay MOUNTED regardless of the toggle. Unmounting the
          hidden one would tear down its bridge, and the serial relay would
          reset every time the user flipped the switch. */}
      <div className="sim__stage">
        <section className={view === 'simulation' ? 'sim__half' : 'sim__half sim__half--hidden'} aria-hidden={view !== 'simulation'}>
          <SimulationHalf
            payload={payload}
            velxioUrl={velxioUrl}
            frameRef={velxio.frameRef}
            status={velxio.status}
            onPull={() => void pullCanvas()}
            syncing={syncing}
            syncNote={syncNote}
            details={details}
          />
        </section>

        <section className={view === 'website' ? 'sim__half' : 'sim__half sim__half--hidden'} aria-hidden={view !== 'website'}>
          <WebsiteHalf payload={payload} websiteUrl={websiteUrl} frameRef={dashboard.frameRef} attached={dashboard.attached} details={details} />
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Simulation half                                                            */
/* -------------------------------------------------------------------------- */

function SimulationHalf({
  payload,
  velxioUrl,
  frameRef,
  status,
  onPull,
  syncing,
  syncNote,
  details,
}: {
  payload: SimulationPayload;
  velxioUrl: string | null;
  frameRef: (node: HTMLIFrameElement | null) => void;
  status: ReturnType<typeof useVelxioBridge>['status'];
  onPull: () => void;
  syncing: boolean;
  syncNote: { tone: 'ok' | 'err'; text: string } | null;
  details: boolean;
}) {
  const velxio = payload.velxio;

  return (
    <>
      <div className="sim__head">
        <div>
          <SectionTitle>Velxio emulator — embedded from {velxioUrl}</SectionTitle>
          <p className="faint">
            {velxio
              ? `${velxio.boardKind ?? 'board'} · ${velxio.parts} part(s) · ${velxio.wires} wire(s) · ${velxio.files.length} source file(s), pushed onto the canvas automatically.`
              : payload.blocked.velxio}
          </p>
        </div>
        <span className="sim__spacer" />
        <button type="button" className="btn btn--sm" onClick={onPull} disabled={syncing || status.state === 'idle'}>
          {syncing ? 'pulling…' : 'pull canvas → diagram.json'}
        </button>
      </div>

      {syncNote ? (
        <Notice tone={syncNote.tone === 'ok' ? 'ok' : 'err'} title={syncNote.tone === 'ok' ? 'Canvas synced' : 'Sync failed'}>
          {syncNote.text}
        </Notice>
      ) : null}

      {status.state === 'error' ? (
        <Notice tone="err" title="The canvas did not answer">
          {status.message}
        </Notice>
      ) : null}

      {velxio && velxio.cadBench.length > 0 ? (
        <Notice tone="info" title={`${velxio.cadBench.length} part(s) are on the bench as CAD parts`}>
          <ul className="sim__list">
            {velxio.cadBench.map((entry) => (
              <li key={entry.id}>
                {entry.name} ({entry.catalogId})
              </li>
            ))}
          </ul>
          This build has no electrical model for them, so they hold their real shape and pin anchors on the
          canvas and in the 3D view without reacting to signals. They are never substituted with a lookalike
          emulator part.
        </Notice>
      ) : null}

      {velxio && velxio.unsupported.length > 0 ? (
        <Notice tone="warn" title={`${velxio.unsupported.length} item(s) could not be placed on the canvas`}>
          <ul className="sim__list">
            {velxio.unsupported.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
          These are reported rather than substituted: putting a lookalike part on the canvas would wire the
          firmware to pins the real component does not have.
        </Notice>
      ) : null}

      {velxioUrl ? (
        <div className="sim__frame-wrap">
          <iframe
            ref={frameRef}
            className="sim__frame"
            src={velxioUrl}
            title="Velxio emulator"
            allow="serial; usb"
          />
          {status.state === 'waiting' ? (
            <div className="sim__overlay">
              <strong>Waiting for Velxio at {velxioUrl}</strong>
              <p className="faint">
                Start it with <code>cd external/velxio/frontend &amp;&amp; npm install &amp;&amp; npm run dev</code>. The
                embed bridge is already vendored in this repo — no patch to apply.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <Empty>No emulator URL is configured.</Empty>
      )}

      {details && velxio ? (
        <details className="sim__details">
          <summary>the .vlx that was pushed</summary>
          <pre className="sim__pre">{velxio.vlx}</pre>
        </details>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Website half                                                               */
/* -------------------------------------------------------------------------- */

function WebsiteHalf({
  payload,
  websiteUrl,
  frameRef,
  attached,
  details,
}: {
  payload: SimulationPayload;
  websiteUrl: string | null;
  frameRef: (node: HTMLIFrameElement | null) => void;
  attached: boolean;
  details: boolean;
}) {
  const software = payload.software;
  const errors = software?.findings.filter((finding) => finding.severity === 'error') ?? [];
  const warnings = software?.findings.filter((finding) => finding.severity === 'warning') ?? [];
  const bytes = useMemo(
    () => (software ? software.files.reduce((total, file) => total + file.bytes, 0) : 0),
    [software],
  );

  return (
    <>
      <div className="sim__head">
        <div>
          <SectionTitle>Generated dashboard — your dev server at {websiteUrl}</SectionTitle>
          <p className="faint">
            {software
              ? `${software.files.length} file(s), ${Math.round(bytes / 1024)} kB of source. Generated and statically checked — never installed or built by Wireup.`
              : payload.blocked.software}
          </p>
        </div>
        <span className="sim__spacer" />
        {software ? (
          <a className="btn btn--sm btn--primary" href={software.zipUrl} download>
            download the zip
          </a>
        ) : null}
      </div>

      {software ? (
        <>
          <div className="sim__meta">
            <Badge tone={software.passed ? 'ok' : 'err'}>
              {software.passed ? 'static checks passed' : `${errors.length} error(s)`}
            </Badge>
            {warnings.length > 0 ? <Badge tone="warn">{warnings.length} warning(s)</Badge> : null}
            <Badge tone="neutral">{software.contract.metrics.length} reading(s)</Badge>
            <Badge tone="neutral">{software.contract.commands.length} control(s)</Badge>
            <Badge tone={attached ? 'ok' : 'neutral'}>{attached ? 'relay attached' : 'relay waiting'}</Badge>
          </div>

          {errors.length > 0 ? (
            <Notice tone="err" title="Static validation found problems">
              <ul className="sim__list">
                {errors.map((finding) => (
                  <li key={`${finding.code}-${finding.file ?? ''}-${finding.message}`}>
                    <code>{finding.code}</code> {finding.message}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {warnings.length > 0 ? (
            <Notice tone="warn" title={`${warnings.length} warning(s)`}>
              <ul className="sim__list">
                {warnings.map((finding) => (
                  <li key={`${finding.code}-${finding.message}`}>
                    <code>{finding.code}</code> {finding.message}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </>
      ) : null}

      {websiteUrl ? (
        <div className="sim__frame-wrap">
          <iframe ref={frameRef} className="sim__frame" src={websiteUrl} title="Generated dashboard" />
          {!attached ? (
            <div className="sim__overlay">
              <strong>Waiting for the dashboard at {websiteUrl}</strong>
              <p className="faint">
                Download the zip above, then <code>npm install &amp;&amp; npm run dev</code> in the unzipped folder. It
                binds port 5175 and attaches to this page automatically — the emulator's serial output starts
                flowing into it the moment it does.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <Empty>No dashboard URL is configured.</Empty>
      )}

      {details && software ? (
        <details className="sim__details">
          <summary>the device contract both halves were generated from</summary>
          <pre className="sim__pre">{JSON.stringify(software.contract, null, 2)}</pre>
        </details>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Small bits                                                                 */
/* -------------------------------------------------------------------------- */

function LinkPill({ label, state, tone }: { label: string; state: string; tone: 'ok' | 'warn' | 'err' | 'neutral' }) {
  return (
    <span className={`sim__pill sim__pill--${tone}`}>
      <span className="sim__pill-label">{label}</span>
      <span className="sim__pill-state">{state}</span>
    </span>
  );
}

function velxioStatusLabel(state: string): string {
  switch (state) {
    case 'waiting':
      return 'waiting';
    case 'ready':
      return 'connected';
    case 'pushed':
      return 'circuit loaded';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function velxioTone(state: string): 'ok' | 'warn' | 'err' | 'neutral' {
  if (state === 'pushed' || state === 'ready') return 'ok';
  if (state === 'error') return 'err';
  if (state === 'waiting') return 'warn';
  return 'neutral';
}
