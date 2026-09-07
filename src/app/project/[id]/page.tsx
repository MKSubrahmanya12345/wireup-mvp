/**
 * /project/[id] — Overview (the hook). Renders inside the /project/[id]
 * layout's <ProjectHub> shell, which owns the live stream.
 */

import { OverviewPanel } from '@/components/workspace/panels/OverviewPanel';

export default function ProjectOverviewPage() {
  return <OverviewPanel />;
}
