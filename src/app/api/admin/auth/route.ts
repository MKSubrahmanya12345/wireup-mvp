import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  AdminAuthError,
  adminGateRequired,
  checkAdminCredentials,
  issueAdminSession,
  requestIsSecure,
  withoutAdminSession,
  withAdminSession,
} from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Only ever a same-origin path — a login form must not become an open redirect. */
function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^\/[a-z0-9/?&_=,-]*$/i.test(value) ? value : null;
}

/**
 * POST /api/admin/auth — exchange the configured admin credential for a
 * signed session cookie.
 *
 * Accepts JSON and a urlencoded form, so the gate page can sign in with plain
 * HTML and no client-side JavaScript. Both halves of the credential come from
 * the environment (`WIREUP_ADMIN_EMAIL`, `WIREUP_ADMIN_PASSWORD`); a production
 * deployment that has not configured them gets 503 rather than an unlocked
 * console. In development there is no gate at all, so `pnpm dev` stays usable
 * with no setup.
 */
export async function POST(request: NextRequest) {
  let email: unknown;
  let password: unknown;
  let redirectTo: string | null = null;

  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.formData();
      email = form.get('email');
      password = form.get('password');
      redirectTo = safeRedirect(form.get('redirectTo'));
    } else {
      const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
      email = body?.email;
      password = body?.password;
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected a JSON or form body with email and password.' }, { status: 400 });
  }

  // The redirect branch answers a browser form post, so it has to land back on
  // the page that showed the form — with the reason, if there was one.
  const reply = (init: { status: number; error?: string; user?: Record<string, unknown>; session?: { value: string; maxAge: number } }) => {
    if (redirectTo) {
      const target = init.error ? `${redirectTo}${redirectTo.includes('?') ? '&' : '?'}error=invalid` : redirectTo;
      const response = NextResponse.redirect(new URL(target, request.url), { status: 303 });
      if (init.session) withAdminSession(response, init.session, requestIsSecure(request));
      return response;
    }
    return NextResponse.json(
      init.error ? { ok: false, error: init.error } : { ok: true, ...init.user, expiresIn: '8h' },
      { status: init.status },
    );
  };

  if (!adminGateRequired()) {
    return NextResponse.json({
      ok: true,
      user: { email: String(email ?? '').trim().toLowerCase() || 'developer', role: 'developer' },
      note: 'No gate is applied outside production; the console is open locally by design.',
    });
  }

  try {
    if (!checkAdminCredentials(email, password)) {
      return reply({ status: 401, error: 'Invalid credentials. Please check your email and password.' });
    }
  } catch (error) {
    if (error instanceof AdminAuthError) return reply({ status: error.status, error: error.message });
    throw error;
  }

  return reply({
    status: 200,
    user: { email: String(email).trim().toLowerCase(), role: 'administrator' },
    session: issueAdminSession(),
  });
}

/** Sign out: drop the session cookie. */
export async function DELETE() {
  return withoutAdminSession(NextResponse.json({ ok: true }));
}

export function GET() {
  return NextResponse.json({ ok: false, error: 'Use POST with { email, password } to sign in.' }, { status: 405, headers: { allow: 'POST, DELETE' } });
}
