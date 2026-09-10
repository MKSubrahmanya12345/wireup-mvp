/**
 * Admin surface authentication.
 *
 * `/admin` and every `/api/admin/*` route reach into generation internals: CAD
 * generation spends model tokens, the deploy route writes files, the demand
 * report exposes telemetry. On any host that is reachable from outside the
 * developer's machine, that surface needs a credential.
 *
 * Nothing here is hardcoded — the credential pair comes from the environment.
 * And when a production deployment has *not* configured it, the admin surface
 * closes rather than opening: forgetting a variable must never be the same as
 * shipping an unlocked console.
 *
 * Sessions are HMAC-signed httpOnly cookies, verified with node:crypto. That
 * makes this module Node-runtime only (which every route that uses it already
 * declares) — it must not be imported from Edge middleware, where `node:crypto`
 * is unavailable and `process.env` is not what a container sets.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { EnvError, env } from '@/lib/validation/env';

export const ADMIN_COOKIE = 'wireup_admin';

/** Sessions are short: this is a control plane, not a consumer login. */
export const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8;

/** Version byte + payload + `.` + tag, so the format can evolve. */
const SESSION_VERSION = 'v1';

export class AdminAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AdminAuthError';
    this.status = status;
  }
}

interface AdminCredentialConfig {
  email: string;
  password: string;
  secret: string;
}

/**
 * The configured credential pair, or `null` when this deployment has no admin
 * access — the safe default. Throws `EnvError` on a half-set credential, which
 * is a misconfiguration rather than a choice.
 */
function adminConfig(): AdminCredentialConfig | null {
  const { admin } = env();
  if (!admin.password) return null;
  if (!admin.email) {
    throw new EnvError(['WIREUP_ADMIN_EMAIL'], 'WIREUP_ADMIN_PASSWORD is set, so the login needs an email too.');
  }
  return { email: admin.email, password: admin.password, secret: admin.secret ?? admin.password };
}

/** Constant-time compare that tolerates unequal lengths without leaking which failed. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Whether the gate applies at all.
 *
 * Development is deliberately open: the console has to stay reachable with a
 * clone and `pnpm dev`, and localhost is the developer's own machine. A
 * production process — which is what every host runs, Render included — always
 * gates, and gates closed.
 */
export function adminGateRequired(): boolean {
  return env().isProduction;
}

export function adminAuthConfigured(): boolean {
  return adminConfig() !== null;
}

export interface AdminSession {
  value: string;
  maxAge: number;
}

export function issueAdminSession(): AdminSession {
  const config = adminConfig();
  if (!config) {
    throw new AdminAuthError(503, 'Admin access is not configured on this deployment.');
  }
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
  const payload = `${SESSION_VERSION}.${expiresAt}.${randomBytes(12).toString('base64url')}`;
  return { value: `${payload}.${sign(payload, config.secret)}`, maxAge: ADMIN_SESSION_TTL_SECONDS };
}

export function verifyAdminSession(value: string | undefined): boolean {
  if (!value) return false;

  let config: AdminCredentialConfig | null;
  try {
    config = adminConfig();
  } catch {
    // Misconfigured credential → nothing verifies. Fail closed.
    return false;
  }
  if (!config) return false;

  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const [version, expiry, nonce, tag] = parts as [string, string, string, string];
  if (version !== SESSION_VERSION || !nonce) return false;
  if (!safeEqual(tag, sign(`${version}.${expiry}.${nonce}`, config.secret))) return false;

  const expiresAt = Number.parseInt(expiry, 10);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function checkAdminCredentials(email: unknown, password: unknown): boolean {
  const config = adminConfig();
  if (!config) {
    throw new AdminAuthError(
      503,
      'The admin surface is disabled: set WIREUP_ADMIN_EMAIL and WIREUP_ADMIN_PASSWORD in the deployment environment to enable it.',
    );
  }
  const givenEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const givenPassword = typeof password === 'string' ? password : '';
  // Both halves are compared even when the first already failed, so a wrong
  // email does not answer measurably faster than a wrong password.
  const emailOk = safeEqual(givenEmail, config.email.toLowerCase());
  const passwordOk = safeEqual(givenPassword, config.password);
  return emailOk && passwordOk;
}

/** Read the session cookie off a request. Never throws. */
export function requestHasAdminSession(request: Request): boolean {
  const header = request.headers.get('cookie');
  if (!header) return false;
  for (const part of header.split(/;\s*/)) {
    const index = part.indexOf('=');
    if (index <= 0 || part.slice(0, index) !== ADMIN_COOKIE) continue;
    return verifyAdminSession(decodeURIComponent(part.slice(index + 1)));
  }
  return false;
}

/** The same check for a server component, where cookies come from `next/headers`. */
export async function pageHasAdminSession(): Promise<boolean> {
  try {
    const store = await cookies();
    return verifyAdminSession(store.get(ADMIN_COOKIE)?.value);
  } catch {
    return false;
  }
}

/**
 * `Authorization: Wireup-Admin <session>` — for scripted calls (curl, CI) where
 * carrying a cookie is awkward. Same signature, same expiry, same closed door
 * when nothing is configured.
 */
function bearerIsAdmin(request: Request): boolean {
  const header = request.headers.get('authorization');
  if (!header) return false;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return false;
  if (scheme.toLowerCase() !== 'wireup-admin') return false;
  return verifyAdminSession(value.trim());
}

/**
 * Gate for a route handler.
 *
 * Returns `null` when the caller may proceed, otherwise a ready-to-return
 * rejection. Returning rather than throwing keeps the check outside each
 * handler's try/catch, so a 401 cannot be relabelled as a 500 by a generic
 * error branch.
 */
export function adminGate(request: Request): NextResponse | null {
  if (!adminGateRequired()) return null;

  if (requestHasAdminSession(request) || bearerIsAdmin(request)) return null;

  let configured: boolean;
  try {
    configured = adminAuthConfigured();
  } catch (error) {
    return json(
      503,
      error instanceof Error ? error.message : 'The admin credential is misconfigured on this deployment.',
    );
  }
  if (!configured) {
    return json(
      503,
      'The admin surface is disabled: set WIREUP_ADMIN_EMAIL and WIREUP_ADMIN_PASSWORD in the deployment environment to enable it.',
    );
  }
  return json(401, 'Sign in at /admin first.');
}

function json(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error, code: 'admin_auth_required' }, { status });
}

/** Attach a freshly issued session. */
export function withAdminSession(response: NextResponse, session: AdminSession, secure: boolean): NextResponse {
  response.cookies.set(ADMIN_COOKIE, session.value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: session.maxAge,
  });
  return response;
}

export function withoutAdminSession(response: NextResponse): NextResponse {
  response.cookies.set(ADMIN_COOKIE, '', { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 0 });
  return response;
}

/**
 * Was the request served over https? Behind Render's proxy `request.url` is the
 * internal origin, so the forwarded header is the only honest answer — and a
 * `secure` cookie the browser silently drops looks exactly like broken login.
 */
export function requestIsSecure(request: Request): boolean {
  if (request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}
