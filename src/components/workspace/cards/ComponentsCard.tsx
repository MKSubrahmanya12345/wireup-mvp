'use client';

/**
 * COMPONENTS card — the bill of materials actually selected from the component
 * database, with per-instance ids and the pins each instance was given.
 */

import { useState } from 'react';

import type { ComponentSelection } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';

import { Badge, Card, Empty, Loader } from '../ui';
import { plural, type CardProps } from './types';

const SOURCE_TONE: Record<ComponentSelection['source'], 'ok' | 'warn' | 'info'> = {
  catalog: 'ok',
  planner: 'info',
  model: 'warn',
};

function assignmentsFor(selection: ComponentSelection, assignments: PinAssignment[]): PinAssignment[] {
  const ids = new Set(selection.instances.map((instance) => instance.instanceId));
  return assignments.filter((assignment) => ids.has(assignment.targetInstanceId));
}

function PartRow({
  selection,
  assignments,
  open,
  onToggle,
}: {
  selection: ComponentSelection;
  assignments: PinAssignment[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="part">
      <button type="button" className="part__head" onClick={onToggle} aria-expanded={open}>
        <span className="faint mono-sm">{open ? '▾' : '▸'}</span>
        <span className="part__name">{selection.name}</span>
        <Badge>{selection.role}</Badge>
        <Badge tone="solid">×{selection.quantity}</Badge>
        <Badge tone={SOURCE_TONE[selection.source] ?? 'neutral'}>{selection.source}</Badge>
      </button>

      {open ? (
        <div className="part__body">
          <p className="part__reason">{selection.reason}</p>
          <div className="row row--tight" style={{ marginBottom: 6 }}>
            <span className="part__id">{selection.componentId}</span>
            <Badge>{selection.category}</Badge>
            {selection.required ? <Badge tone="warn">required</Badge> : null}
            {selection.matchedFrom ? <Badge tone="info">matched from “{selection.matchedFrom}”</Badge> : null}
          </div>

          {selection.notes ? (
            <p className="small muted" style={{ margin: '0 0 6px' }}>
              {selection.notes}
            </p>
          ) : null}

          {selection.instances.map((instance) => {
            const own = assignments.filter((assignment) => assignment.targetInstanceId === instance.instanceId);
            return (
              <div className="instance" key={instance.instanceId}>
                <span className="mono-sm">{instance.instanceId}</span>
                {instance.label ? <span className="faint small">({instance.label})</span> : null}
                <span className="card__spacer" style={{ flex: 1 }} />
                {own.length > 0 ? (
                  <span className="instance__pin">
                    {own.map((assignment) => `${assignment.targetPin}→${assignment.pin}`).join('  ')}
                  </span>
                ) : (
                  <span className="faint small">no MCU pins</span>
                )}
              </div>
            );
          })}

          {assignments.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table table--mono">
                <thead>
                  <tr>
                    <th>peripheral pin</th>
                    <th>mcu pin</th>
                    <th>dir</th>
                    <th>signal</th>
                    <th>purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((assignment) => (
                    <tr key={assignment.id}>
                      <td>
                        {assignment.targetInstanceId}.{assignment.targetPin}
                      </td>
                      <td>{assignment.pin}</td>
                      <td>{assignment.direction}</td>
                      <td>{assignment.signal}</td>
                      <td className="small muted" style={{ fontFamily: 'var(--sans)' }}>
                        {assignment.purpose}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ComponentsCard({ project, running, activity }: CardProps) {
  const selections = project?.components ?? [];
  const assignments = project?.pinAssignments ?? [];
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (selections.length === 0) {
    return (
      <Card title="Components" count="0">
        {running ? (
          <Loader label="Searching the component database for real parts" detail={activity} />
        ) : (
          <Empty>No components were selected.</Empty>
        )}
      </Card>
    );
  }

  const instances = selections.reduce((sum, selection) => sum + selection.instances.length, 0);
  const grouped = [...selections].sort((a, b) => {
    const order = ['controller', 'driver', 'power', 'communication', 'sensor', 'actuator', 'display', 'input', 'passive', 'prototyping', 'other'];
    return order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name);
  });

  const supporting = project?.hardwarePlan?.supportingComponents ?? [];

  return (
    <Card
      title="Components"
      count={`${plural(selections.length, 'part')} · ${plural(instances, 'instance')}`}
      footer={<span>every part comes from the seeded component database — the model cannot invent hardware</span>}
    >
      {grouped.map((selection) => {
        const own = assignmentsFor(selection, assignments);
        const isOpen = open[selection.id] ?? selection.role === 'controller';
        return (
          <PartRow
            key={selection.id}
            selection={selection}
            assignments={own}
            open={isOpen}
            onToggle={() => setOpen((current) => ({ ...current, [selection.id]: !isOpen }))}
          />
        );
      })}

      {supporting.length > 0 ? (
        <>
          <h3 className="section-title">Added by engineering rules</h3>
          <ul className="list list--tight">
            {supporting.map((entry) => (
              <li key={`${entry.instanceId}-${entry.componentId}`} className="small">
                <span className="mono-sm">{entry.instanceId}</span> — <span className="muted">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
