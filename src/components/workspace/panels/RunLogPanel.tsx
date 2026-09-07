'use client';

/**
 * RUN LOG — the raw, per-event record of what the agent did. Deliberately a
 * separate page: it's the "for the curious" deep dive, not the main event.
 */

import { Card } from '../ui';
import { AgentConsole } from '../AgentConsole';
import { useHub } from '../hub-context';

export function RunLogPanel() {
  const { events, running, stage, error, polledAt } = useHub();

  return (
    <Card title="Run log" wide flush>
      <AgentConsole events={events} running={running} stage={stage} pollError={error} polledAt={polledAt} />
    </Card>
  );
}
