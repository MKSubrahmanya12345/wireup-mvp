'use client';

/**
 * OVERVIEW — the hook. Leads with what was built and what to do next, never
 * with internals. While the build is still running it says so simply and points
 * you at the parts/firmware tabs as they fill in.
 */

import Link from 'next/link';

import { projectOverview, humanStageLabel } from '@/lib/project-presentation';
import { Badge, Card, Notice } from '../ui';
import { BuildPackButton } from '../BuildPackButton';
import { HardwareCopilot } from '../HardwareCopilot';
import { useHub } from '../hub-context';

const LINKS = [
  { href: 'parts', label: 'Parts & BOM', blurb: 'Every part you need, with why' },
  { href: 'wiring', label: 'Wiring & Pins', blurb: 'The picture of how it connects' },
  { href: 'diagram', label: 'Diagram & Simulator', blurb: 'See it laid out, open it in a simulator' },
  { href: 'firmware', label: 'Firmware', blurb: 'The code for your board' },
  { href: 'guide', label: 'Build guide', blurb: 'Step-by-step to assemble it' },
  { href: 'quality', label: 'Check & fix', blurb: 'Was it validated, and what to fix' },
] as const;

export function OverviewPanel() {
  const { project, running, stage } = useHub();
  const overview = projectOverview(project);

  const goal = project?.requirements?.goal;
  const prompt = project?.prompt;
  const failed = project?.status === 'failed';
  const pending = project === null;
  const canExport = Boolean(
    project &&
      !running &&
      (project.artifacts.code || project.artifacts.diagram || project.artifacts.instructions || project.artifacts.libraries || project.components.length > 0),
  );

  return (
    <div className="col stack hub__stack">
      {failed ? (
        <Notice tone="err" title="We couldn't finish this one">
          The build stopped here. Open the{' '}
          <Link href={`/project/${project?.id ?? ''}/log`} className="notice__link">
            run log
          </Link>{' '}
          to see what happened, or start a new project.
        </Notice>
      ) : null}

      <Card
        title="What you got"
        wide
        flush
        actions={project ? <BuildPackButton projectId={project.id} disabled={!canExport} /> : null}
      >
        <div className="overview__hero">
          <div className="overview__hero-topline">
            <span className="overview__hero-marker" aria-hidden="true" />
            <span>your build brief, made concrete</span>
          </div>
          <p className="overview__headline">{overview.headline}</p>
          {overview.subhead ? <p className="overview__subhead">{overview.subhead}</p> : null}

          {overview.facts.length > 0 ? (
            <dl className="overview__facts">
              {overview.facts.map((fact) => (
                <div key={fact.label} className="overview__fact">
                  <dt className="overview__fact-label">{fact.label}</dt>
                  <dd className="overview__fact-value">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : running ? (
            <p className="overview__subhead" style={{ marginBottom: 0 }}>
              Watch it come together — each part of your project will appear here as soon as it's ready.
            </p>
          ) : null}

          {overview.nextSteps.length > 0 ? (
            <div className="overview__steps">
              <span className="overview__steps-title">What to do next</span>
              <ul className="list list--tight">
                {overview.nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>

      {project && !running ? <HardwareCopilot /> : null}

      <Card title="Dig in">
        <div className="overview__links">
          {LINKS.map((link, index) => (
            <Link key={link.href} href={`/project/${project?.id ?? ''}/${link.href}`} className="overview__link">
              <span className="overview__link-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="overview__link-copy">
                <span className="overview__link-label">{link.label}</span>
                <span className="overview__link-blurb">{link.blurb}</span>
              </span>
              <span className="overview__link-arrow">open</span>
            </Link>
          ))}
        </div>
      </Card>

      {(goal || prompt) ? (
        <Card title="The brief" count={running ? undefined : 'from your prompt'}>
          {goal ? <p className="overview__goal">{goal}</p> : null}
          {prompt ? (
            <details className="overview__prompt">
              <summary className="mono-sm">your original prompt</summary>
              <p className="small muted" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {prompt}
              </p>
            </details>
          ) : null}
        </Card>
      ) : null}

      {pending && running ? (
        <Card title="Building" wide>
          <Badge tone="info">working</Badge>
          <p className="small muted" style={{ marginTop: 8 }}>
            We're {humanStageLabel(stage).toLowerCase()} right now. Your parts, wiring and firmware will appear as they're ready.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
