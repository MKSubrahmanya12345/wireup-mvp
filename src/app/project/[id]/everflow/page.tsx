/**
 * /project/[id]/everflow — the project as a living graph.
 *
 * Every node carries a completion goal; the agent iterates until every goal
 * is satisfied or parked behind a named task. The right side is the human
 * channel in two columns: asks the agent needs from you, and additions you
 * make that the agent cannot have.
 */

import { EverflowPanel } from '@/components/everflow/EverflowPanel';

export default function EverflowPage() {
  return <EverflowPanel />;
}
