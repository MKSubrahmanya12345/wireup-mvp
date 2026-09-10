import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/health/live — process liveness, nothing else.
 *
 * `/api/health` is the operator-facing dependency report the UI banner reads:
 * it answers 503 while MongoDB is unreachable or the catalog is empty, which is
 * exactly what a health check must NOT be built on. A platform probe on that
 * path restarts an instance during a database blip, and the replacement cannot
 * get healthier than the thing it replaced — a restart loop with a plausible
 * error message.
 *
 * So this route is deliberately dependency-free: if the Next server can answer,
 * it returns 200. That is the whole contract, and it is what
 * `healthCheckPath` in `render.yaml` points at.
 */
export function GET() {
  return NextResponse.json(
    {
      ok: true,
      status: 'alive',
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: process.env.NODE_ENV ?? 'development',
      // Render injects RENDER_GIT_COMMIT / RENDER_GIT_BRANCH, which makes
      // "which build am I actually looking at?" answerable from the URL alone.
      ...(process.env.RENDER_GIT_COMMIT ? { sha: process.env.RENDER_GIT_COMMIT.slice(0, 10) } : {}),
      ...(process.env.RENDER_GIT_BRANCH ? { branch: process.env.RENDER_GIT_BRANCH } : {}),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } },
  );
}
