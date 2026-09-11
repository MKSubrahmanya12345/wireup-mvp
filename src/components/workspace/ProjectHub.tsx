'use client';

/**
 * PROJECT HUB — the shell around every project output page.
 *
 * Replaces the old always-open agent console + 8-card dump. The hub leads with
 * a plain-language status ribbon, a six-step build progress bar, and guided
 * tabs (Overview, Parts, Wiring, Firmware, Build guide, Check & fix). The raw
 * run log and "technical details" are deliberately off to the side so a normal
 * user is never drowned in internals, but nothing is impossible to reach.
 *
 * A single `useProjectStream` poller lives here (in the `/project/[id]`
 * layout) and is shared by every child page through `HubContext`.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import type { AgentEvent } from '@/types/generation';
import type { GenerationStage, ProjectState } from '@/types/project';

import { buildSteps, humanStageLabel, isIntake, isInProgress, statusPhrase } from '@/lib/project-presentation';
import { useProjectStream } from './useProjectStream';
import { HubContext, type HubValue } from './hub-context';
import { StatusBadge } from './ui';
import { BuildPackButton } from './BuildPackButton';
import { IntakeSession } from '@/components/everflow/IntakeSession';
import { DrawerVeil, HumanDrawers, type DrawerSide } from './HumanDrawers';

const TABS = [
  { href: '', label: 'Overview', short: 'Overview' },
  { href: '/everflow', label: 'Everflow', short: 'Everflow' },
  { href: '/parts', label: 'Parts & BOM', short: 'Parts' },
  { href: '/wiring', label: 'Wiring & Pins', short: 'Wiring' },
  { href: '/diagram', label: 'Diagram & Simulator', short: 'Diagram' },
  { href: '/simulation', label: 'Simulation', short: 'Simulation' },
  { href: '/firmware', label: 'Firmware', short: 'Firmware' },
  { href: '/guide', label: 'Build guide', short: 'Guide' },
  { href: '/quality', label: 'Check & fix', short: 'Check' },
] as const;

export function ProjectHub({ projectId, initial, children }: { projectId: string; initial: ProjectState; children: ReactNode }) {
  const pathname = usePathname();
  const stream = useProjectStream(projectId, initial);
  const [details, setDetails] = useState(false);
  const [drawer, setDrawer] = useState<DrawerSide | null>(null);

  const project = stream.project;
  const base = `/project/${projectId}`;
  const activeHref = useMemo(() => {
    if (!pathname) return '';
    if (pathname === base) return '';
    if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
    return '';
  }, [pathname, base]);

  const toggleDetails = useCallback(() => setDetails((current) => !current), []);

  const value: HubValue = useMemo(
    () => ({ ...stream, details, toggleDetails }),
    [stream, details, toggleDetails],
  );

  const openAsks = project?.humanTasks?.filter((task) => task.direction === 'ai_to_human' && task.status === 'open').length ?? 0;
  const steps = buildSteps(project);
  const status = project?.status ?? 'pending';
  const inProgress = isInProgress(status);
  const canExport = Boolean(
    project &&
      !inProgress &&
      !isIntake(status) &&
      (project.artifacts.code || project.artifacts.diagram || project.artifacts.instructions || project.artifacts.libraries || project.components.length > 0),
  );
  const stage = humanStageLabel(stream.stage);
  const headline = statusPhrase(status);
  const subhead = inProgress
    ? `We're ${stage.toLowerCase()} right now.`
    : status === 'failed'
      ? 'We ran into a problem while building. The run log has the details.'
      : 'Everything is ready below.';

  return (
    <HubContext.Provider value={value}>
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">W</span>
          <span className="topbar__title">Wireup</span>
        </Link>

        <span className="topbar__meta hub__crumb">
          <span className="hub__crumb-label">active bench</span>
          <span className="hub__crumb-divider" aria-hidden="true" />
          {project?.name ?? 'Project'}
          {details ? <span className="faint mono-sm">{project?.id}</span> : null}
        </span>

        <span className="topbar__spacer" />

        <span className="topbar__meta">
          {inProgress ? (
            <span className="row row--tight">
              <span className="dot dot--live" />
              <span>working</span>
            </span>
          ) : (
            <StatusBadge status={status} />
          )}

          <BuildPackButton projectId={projectId} disabled={!canExport} />

          <Link href={`${base}/log`} className="btn btn--ghost btn--sm">
            run log
          </Link>

          <button
            type="button"
            className={`btn btn--sm${openAsks > 0 ? ' btn--attention' : ''}${drawer === 'left' ? ' btn--on' : ''}`}
            onClick={() => setDrawer((current) => (current === 'left' ? null : 'left'))}
            title="Asks the agent filed for you — it never blocks on you"
          >
            needs you{openAsks > 0 ? ` (${openAsks})` : ''}
          </button>

          <button
            type="button"
            className={`btn btn--sm${drawer === 'right' ? ' btn--on' : ''}`}
            onClick={() => setDrawer((current) => (current === 'right' ? null : 'right'))}
            title="Add a note, idea, correction, resource or steer mid-thought"
          >
            mid-thought
          </button>

          <button type="button" className="btn btn--sm" onClick={toggleDetails} title="Show internal ids, provenance and raw data">
            {details ? 'details: on' : 'details'}
          </button>

          <Link href="/" className="btn btn--ghost btn--sm">
            new project
          </Link>
        </span>
      </header>

      {isIntake(status) ? (
        <main className="hub__content hub__content--intake">
          <IntakeSession />
        </main>
      ) : (
        <>
       <div className={`hub__status${inProgress ? ' hub__status--working' : ''}${status === 'failed' ? ' hub__status--failed' : ''}`}>
        <div className="hub__inner">
           <div className="hub__kicker">
             <span className="hub__kicker-line" aria-hidden="true" />
             build handoff
           </div>
          <div className="hub__headline">
            <h1 className="hub__title">{headline}</h1>
            <p className="hub__sub">{subhead}</p>
          </div>

          <ol className="hub__steps">
            {steps.map((step) => (
              <li key={step.key} className={`hub__step hub__step--${step.state}`}>
                <span className="hub__step-dot" aria-hidden />
                <span className="hub__step-label">{step.label}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <nav className="hub__nav" aria-label="Project sections">
        {TABS.map((tab) => {
          const active = activeHref === tab.href;
          return (
            <Link key={tab.href} href={`${base}${tab.href}`} className={`hub__tab${active ? ' hub__tab--active' : ''}`}>
              {tab.label.replace('&', '\u00a0&')}
            </Link>
          );
        })}
      </nav>

      <main className="hub__content">{children}</main>
        </>
      )}

      {/* The two drawers — same live project, no second poll. */}
      <DrawerVeil open={drawer !== null} onClose={() => setDrawer(null)} />
      <HumanDrawers side="left" open={drawer === 'left'} onClose={() => setDrawer(null)} />
      <HumanDrawers side="right" open={drawer === 'right'} onClose={() => setDrawer(null)} />
    </HubContext.Provider>
  );
}
