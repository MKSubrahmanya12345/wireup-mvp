/**
 * /project/[id] — route layout.
 *
 * Loads the persisted project once and hands it to the client <ProjectHub>,
 * which runs the single live poller for the whole section. Every child tab
 * (Overview, Parts, Wiring, Firmware, Guide, Check & fix, Run log) renders under
 * the same <ProjectHub> shell and shares its live state, so nothing re-fetches
 * or re-polls.
 */

import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getProjectState } from '@/lib/mongodb/projects';
import { ProjectHub } from '@/components/workspace/ProjectHub';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const loadProject = cache(async (id: string) => getProjectState(id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const project = await loadProject(id.trim());
    if (!project) return { title: 'Project not found — Wireup' };
    return { title: `${project.name} — Wireup` };
  } catch {
    return { title: 'Wireup' };
  }
}

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await loadProject(id.trim());
  if (!project) notFound();

  return <ProjectHub projectId={id.trim()} initial={project}>{children}</ProjectHub>;
}
