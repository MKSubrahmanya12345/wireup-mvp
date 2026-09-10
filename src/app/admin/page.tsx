import { AdminConsole } from '@/components/admin/AdminConsole';
import { AdminLogin } from '@/components/admin/AdminLogin';
import { adminAuthConfigured, adminGateRequired, pageHasAdminSession } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `/admin` — the control plane.
 *
 * Locally this renders straight through. On a hosted (production) deployment
 * it sits behind a session cookie, because the console drives endpoints that
 * spend model tokens and touch the filesystem. The gate never fails open: with
 * no credential configured the page explains how to enable it instead of
 * handing over an unlocked console.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  const invalid = Array.isArray(params?.error) ? params.error[0] : params?.error;

  if (!adminGateRequired()) return <AdminConsole />;

  let configured = false;
  let problem: string | null = null;
  try {
    configured = adminAuthConfigured();
  } catch (error) {
    problem = error instanceof Error ? error.message : 'The admin credential is misconfigured.';
  }

  if (!configured) return <AdminLogin mode="disabled" note={problem} />;
  if (await pageHasAdminSession()) return <AdminConsole />;

  return (
    <AdminLogin
      mode="sign-in"
      error={invalid === 'invalid' ? 'Those credentials were not accepted.' : null}
    />
  );
}
