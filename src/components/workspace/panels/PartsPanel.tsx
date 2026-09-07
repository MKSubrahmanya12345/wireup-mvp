'use client';

/**
 * PARTS & BOM — the list of parts you actually need, plain and obvious. Each
 * part explains why it's there; the internal id / source / pin mapping is only
 * shown when "details" is switched on.
 */

import { useState } from 'react';

import type { ComponentSelection } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';

import { Badge, Card, Empty, Loader, SectionTitle } from '../ui';
import { useHub } from '../hub-context';

const ROLE_ORDER = ['controller', 'driver', 'power', 'communication', 'sensor', 'actuator', 'display', 'input', 'passive', 'prototyping', 'other'];
const ROLE_LABEL: Record<string, string> = {
  controller: 'Controller',
  driver: 'Motor / driver',
  power: 'Power',
  communication: 'Communication',
  sensor: 'Sensors',
  actuator: 'Actuators',
  display: 'Display',
  input: 'Input',
  passive: 'Passive',
  prototyping: 'Prototyping',
  other: 'Other',
};

export function PartsPanel() {
  const { project, running, details } = useHub();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const selections = project?.components ?? [];
  const assignments = project?.pinAssignments ?? [];

  if (selections.length === 0) {
    return (
      <Card title="Parts & BOM" wide count="none yet">
        {running ? (
          <Loader label="Finding the right parts for your build" />
        ) : (
          <Empty>No parts were selected — the build didn't produce a bill of materials.</Empty>
        )}
      </Card>
    );
  }

  const instances = selections.reduce((sum, selection) => sum + selection.instances.length, 0);
  const grouped = [...selections].sort((a, b) => {
    const order = ROLE_ORDER;
    return order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name);
  });

  const roles = Array.from(new Set(grouped.map((selection) => selection.role))).sort(
    (a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b),
  );

  return (
    <Card
      title="Parts & BOM"
      wide
      count={`${selections.length} part types · ${instances} parts`}
      footer={<span>Every part is picked from the component database — nothing is invented.</span>}
    >
      {roles.map((role) => (
        <div key={role} className="parts__group">
          <SectionTitle>{ROLE_LABEL[role] ?? role}</SectionTitle>
          {grouped
            .filter((selection) => selection.role === role)
            .map((selection) => {
              const isOpen = open[selection.id] ?? selection.role === 'controller';
              const own = assignmentsFor(selection, assignments);
              return (
                <PartRow
                  key={selection.id}
                  selection={selection}
                  assignments={own}
                  open={isOpen}
                  details={details}
                  onToggle={() => setOpen((current) => ({ ...current, [selection.id]: !isOpen }))}
                />
              );
            })}
        </div>
      ))}
    </Card>
  );
}

function assignmentsFor(selection: ComponentSelection, assignments: PinAssignment[]): PinAssignment[] {
  const ids = new Set(selection.instances.map((instance) => instance.instanceId));
  return assignments.filter((assignment) => ids.has(assignment.targetInstanceId));
}

function PartRow({
  selection,
  assignments,
  open,
  details,
  onToggle,
}: {
  selection: ComponentSelection;
  assignments: PinAssignment[];
  open: boolean;
  details: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="part">
      <button type="button" className="part__head" onClick={onToggle} aria-expanded={open}>
        <span className="faint mono-sm">{open ? '▾' : '▸'}</span>
        <span className="part__name">{selection.name}</span>
        <Badge>×{selection.quantity}</Badge>
        {selection.required ? <Badge tone="warn">required</Badge> : null}
      </button>

      {open ? (
        <div className="part__body">
          <p className="part__reason">{selection.reason}</p>

          {selection.instances.map((instance) => {
            const own = assignments.filter((assignment) => assignment.targetInstanceId === instance.instanceId);
            return (
              <div className="instance" key={instance.instanceId}>
                <span className="mono-sm">{instance.label ?? instance.name}</span>
                {details ? <span className="faint small">({instance.instanceId})</span> : null}
                <span className="card__spacer" style={{ flex: 1 }} />
                {own.length > 0 ? (
                  <span className="instance__pin">{own.map((assignment) => `${assignment.targetPin}→${assignment.pin}`).join('  ')}</span>
                ) : null}
              </div>
            );
          })}

          {details ? (
            <div className="row row--tight" style={{ marginTop: 6 }}>
              <Badge>{selection.componentId}</Badge>
              <Badge>{selection.source}</Badge>
              {selection.matchedFrom ? <Badge tone="info">matched from “{selection.matchedFrom}”</Badge> : null}
              <Badge>{selection.category}</Badge>
            </div>
          ) : null}

          {details && assignments.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table table--mono">
                <thead>
                  <tr>
                    <th>pin</th>
                    <th>mcu pin</th>
                    <th>signal</th>
                    <th>purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((assignment) => (
                    <tr key={assignment.id}>
                      <td>{assignment.targetPin}</td>
                      <td>{assignment.pin}</td>
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
