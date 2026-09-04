/**
 * PAGE 2 — /project/[id]
 *
 * Server component: loads the persisted project state straight from MongoDB
 * (all artifacts, revisions, validation results and the event log) and hands it
 * to the client workspace, which then keeps polling `/events` by sequence
 * number while generation is still in flight.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getProjectState } from '@/lib/mongodb/projects';
import { ProjectWorkspace } from '@/components/workspace/ProjectWorkspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  try {
    const project = await getProjectState(id.trim());
    if (!project) return { title: 'Project not found — Wireup' };
    return { title: `${project.name} — Wireup` };
  } catch {
    return { title: 'Wireup' };
  }
}

export default async function ProjectPage({ params }: PageProps) {
  const { id } = await params;
  const project = await getProjectState(id.trim());

  if (!project) notFound();

  return <ProjectWorkspace initial={project} />;
}
