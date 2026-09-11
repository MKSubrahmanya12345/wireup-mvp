import { NextRequest } from 'next/server';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { jsonError, jsonOk, readJson } from '@/lib/http';
import { createProjectRecord } from '@/lib/mongodb/projects';
import { startGeneration } from '@/modules/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const exec = promisify(execFile);
const Schema = z.object({ url: z.string().trim().url().refine((value) => /^https:\/\/(www\.)?github\.com\/[^/]+\/[^/]+(?:\.git)?\/?$/.test(value), 'Only public GitHub repository URLs are supported.') });

export async function POST(request: NextRequest) {
  let dir = '';
  try {
    const body = Schema.parse(await readJson(request));
    const url = body.url.replace(/\.git\/?$/, '').replace(/\/$/, '') + '.git';
    dir = await mkdtemp(join(tmpdir(), 'wireup-repo-'));
    await exec('git', ['clone', '--depth', '1', '--no-tags', url, dir], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const [{ stdout: branch }, { stdout: log }, { stdout: files }] = await Promise.all([
      exec('git', ['-C', dir, 'branch', '--show-current']),
      exec('git', ['-C', dir, 'log', '-1', '--format=%h %s']),
      exec('git', ['-C', dir, 'ls-files', '-z']),
    ]);
    const paths = files.split('\0').filter(Boolean);
    const sample = paths.slice(0, 250).join(', ');
    let readme = '';
    try { readme = (await readFile(join(dir, 'README.md'), 'utf8')).slice(0, 6000); } catch { /* optional */ }
    const prompt = `Build Wireup's project-state graph for the imported GitHub repository ${body.url}. Treat the repository as the source of truth: inspect its files, architecture, dependencies, build/test commands, risks, and open work. Imported git snapshot: ${log.trim()}; branch: ${branch.trim() || 'default'}; ${paths.length} tracked files. File sample: ${sample}. README excerpt: ${readme}`;
    const project = await createProjectRecord({ prompt, name: body.url.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? 'imported-repository', maxIterations: 3 });
    startGeneration(project.id);
    return jsonOk({ project, repository: { url: body.url, files: paths.length, commit: log.trim() }, started: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join('; ') : error instanceof Error ? error.message : 'Repository import failed.';
    return jsonError(error instanceof z.ZodError ? 400 : 502, { code: 'repository_import_failed', message });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
