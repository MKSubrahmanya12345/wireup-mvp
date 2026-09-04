'use client';

/**
 * PROJECT card — the brief, the extracted requirements, the hardware
 * architecture and the power budget. Everything here comes from the persisted
 * project state, so it appears exactly when the backend produced it.
 */

import { Badge, Card, Chips, Kv, Loader, SectionTitle, StatusBadge } from '../ui';
import { formatTime, plural, type CardProps } from './types';

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <ul className="list list--tight">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

export function ProjectCard({ project, running, activity }: CardProps) {
  const requirements = project?.requirements ?? null;
  const plan = project?.hardwarePlan ?? null;

  if (!requirements) {
    return (
      <Card title="Project" count={project ? `v${project.revision}` : null}>
        {running ? (
          <Loader label="Reading the request and extracting requirements" detail={activity} />
        ) : (
          <div className="empty">No requirements were produced for this project.</div>
        )}
      </Card>
    );
  }

  const power = plan?.power ?? null;

  return (
    <Card
      title="Project"
      count={project ? `v${project.revision}` : null}
      footer={
        project ? (
          <span>
            created {formatTime(project.createdAt)} · updated {formatTime(project.updatedAt)} ·{' '}
            {plural(project.revisions.length, 'revision')}
          </span>
        ) : null
      }
    >
      <div className="row" style={{ marginBottom: 8 }}>
        {project ? <StatusBadge status={project.status} /> : null}
        {project ? <Badge>stage: {project.stage}</Badge> : null}
        {project ? <Badge tone={project.iteration.current > 0 ? 'info' : 'neutral'}>fix pass {project.iteration.current}/{project.iteration.max}</Badge> : null}
        {requirements.detectedPlatform ? <Badge tone="solid">{requirements.detectedPlatform}</Badge> : null}
      </div>

      <Kv
        items={[
          { key: 'name', value: project?.name ?? '—' },
          { key: 'goal', value: requirements.goal },
          { key: 'summary', value: requirements.summary },
          { key: 'id', value: <span className="mono-sm">{project?.id ?? '—'}</span> },
        ]}
      />

      <SectionTitle>Original prompt</SectionTitle>
      <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
        {project?.prompt ?? ''}
      </p>

      <SectionTitle>Requirements ({requirements.requirements.length})</SectionTitle>
      {requirements.requirements.length > 0 ? (
        <ul className="list list--tight">
          {requirements.requirements.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <span className="faint small">none recorded</span>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        {requirements.features.map((feature) => (
          <span key={feature} className="chip chip--dark">
            {feature}
          </span>
        ))}
      </div>

      {Object.keys(requirements.quantities).length > 0 ? (
        <>
          <SectionTitle>Quantities read from the prompt</SectionTitle>
          <Chips items={Object.entries(requirements.quantities).map(([key, value]) => `${key}: ${value}`)} />
        </>
      ) : null}

      <ListBlock title="Inputs" items={requirements.inputs} />
      <ListBlock title="Outputs" items={requirements.outputs} />
      <ListBlock title="Behaviours" items={requirements.behaviors} />
      <ListBlock title="Constraints" items={requirements.constraints} />
      <ListBlock title="Platform" items={requirements.platformRequirements} />
      <ListBlock title="Communication" items={requirements.communicationRequirements} />
      <ListBlock title="Power requirements" items={requirements.powerRequirements} />

      <ListBlock title="Assumptions made by the agent" items={requirements.assumptions} />
      <ListBlock title="Open ambiguities" items={requirements.ambiguities} />

      {plan ? (
        <>
          <SectionTitle>Hardware architecture</SectionTitle>
          <p className="small muted" style={{ marginTop: 0 }}>
            {plan.summary}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>block</th>
                  <th>kind</th>
                  <th>instances</th>
                </tr>
              </thead>
              <tbody>
                {plan.architecture.map((block) => (
                  <tr key={block.id}>
                    <td>
                      <strong>{block.name}</strong>
                      <div className="faint small">{block.description}</div>
                    </td>
                    <td>
                      <Badge>{block.kind}</Badge>
                    </td>
                    <td className="mono-sm">{block.instanceIds.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {plan.subsystems.length > 0 ? (
            <>
              <SectionTitle>Subsystems</SectionTitle>
              <ul className="list list--tight">
                {plan.subsystems.map((subsystem) => (
                  <li key={subsystem.id}>
                    <strong>{subsystem.name}</strong> — <span className="muted">{subsystem.description}</span>
                    <div className="faint mono-sm">
                      {subsystem.instanceIds.join(', ')}
                      {subsystem.inputs.length > 0 ? ` · in: ${subsystem.inputs.join(', ')}` : ''}
                      {subsystem.outputs.length > 0 ? ` · out: ${subsystem.outputs.join(', ')}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {plan.signalFlow.length > 0 ? (
            <>
              <SectionTitle>Signal flow</SectionTitle>
              <p className="mono-sm" style={{ margin: 0 }}>
                {plan.signalFlow.join(' → ')}
              </p>
            </>
          ) : null}
        </>
      ) : null}

      {power ? (
        <>
          <SectionTitle>Power budget</SectionTitle>
          <Kv
            items={[
              { key: 'adequate', value: <Badge tone={power.adequate ? 'ok' : 'err'}>{power.adequate ? 'yes' : 'no'}</Badge> },
              { key: 'supply', value: power.supplyComponentId ?? 'unresolved' },
              { key: 'supply voltage', value: power.supplyVoltage !== undefined ? `${power.supplyVoltage} V` : 'not stated' },
              { key: 'typical load', value: power.totalTypicalMa !== undefined ? `${power.totalTypicalMa} mA` : 'not stated' },
              { key: 'peak load', value: power.totalPeakMa !== undefined ? `${power.totalPeakMa} mA` : 'not stated' },
              {
                key: 'regulator',
                value: power.regulator
                  ? `${power.regulator.componentId ?? 'regulator'}${
                      power.regulator.inputVoltage !== undefined && power.regulator.outputVoltage !== undefined
                        ? `: ${power.regulator.inputVoltage} V → ${power.regulator.outputVoltage} V`
                        : ''
                    }`
                  : 'none needed',
              },
            ]}
          />
          {power.rails.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table table--mono">
                <thead>
                  <tr>
                    <th>rail</th>
                    <th className="num">V</th>
                    <th className="num">typ mA</th>
                    <th className="num">peak mA</th>
                    <th>loads</th>
                  </tr>
                </thead>
                <tbody>
                  {power.rails.map((rail) => (
                    <tr key={rail.rail}>
                      <td>{rail.rail}</td>
                      <td className="num">{rail.voltage}</td>
                      <td className="num">{rail.typicalMa ?? '—'}</td>
                      <td className="num">{rail.peakMa ?? '—'}</td>
                      <td className="small muted">{rail.loads.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {power.notes.length > 0 ? (
            <>
              <SectionTitle>Power notes</SectionTitle>
              <ul className="list list--tight">
                {power.notes.map((note) => (
                  <li key={note} className="small muted">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}

      {plan && plan.risks.length > 0 ? (
        <>
          <SectionTitle>Risks</SectionTitle>
          <ul className="list list--tight">
            {plan.risks.map((risk) => (
              <li key={risk} className="small">
                {risk}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {plan && plan.compatibility.length > 0 ? (
        <>
          <SectionTitle>Compatibility checks</SectionTitle>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>a</th>
                  <th>b</th>
                  <th>result</th>
                  <th>reason</th>
                </tr>
              </thead>
              <tbody>
                {plan.compatibility.map((check, index) => (
                  <tr key={`${check.a}-${check.b}-${index}`}>
                    <td className="mono-sm">{check.a}</td>
                    <td className="mono-sm">{check.b}</td>
                    <td>
                      <Badge tone={check.compatible ? 'ok' : 'err'}>{check.compatible ? 'ok' : 'conflict'}</Badge>
                    </td>
                    <td className="small muted">{check.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Card>
  );
}
