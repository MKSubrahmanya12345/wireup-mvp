/**
 * The gate shown in front of `/admin` on a hosted deployment.
 *
 * A server component with a plain HTML form: no client-side JavaScript, no
 * state, nothing to hydrate. It posts to `/api/admin/auth`, which sets the
 * session cookie and redirects back here.
 */


const styles = {
  wrap: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    padding: '24px',
    background: 'var(--bg-sunken, #0b0d10)',
  },
  card: {
    width: 'min(420px, 100%)',
    border: '1px solid var(--border-strong, #262a31)',
    borderRadius: '14px',
    background: 'var(--bg, #111418)',
    padding: '26px',
    display: 'grid',
    gap: '16px',
  },
  eyebrow: {
    fontSize: '11px',
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--text-faint, #7c879a)',
  },
  title: { fontSize: '20px', fontWeight: 650, margin: 0 },
  label: { display: 'grid', gap: '6px', fontSize: '12px', color: 'var(--text-muted, #a9b3c1)' },
  input: {
    padding: '10px 12px',
    borderRadius: '9px',
    border: '1px solid var(--border-strong, #262a31)',
    background: 'var(--bg-sunken, #0b0d10)',
    color: 'var(--text, #e8ecf2)',
    fontSize: '14px',
    font: 'inherit',
  },
  button: {
    padding: '10px 14px',
    borderRadius: '9px',
    border: '1px solid transparent',
    background: 'var(--accent, #2f6df6)',
    color: '#fff',
    fontWeight: 620,
    fontSize: '14px',
    cursor: 'pointer',
  },
  error: {
    margin: 0,
    padding: '10px 12px',
    borderRadius: '9px',
    fontSize: '13px',
    border: '1px solid #7c2d3a',
    background: 'rgba(220, 60, 80, 0.12)',
    color: '#ffb3bd',
  },
  note: { margin: 0, fontSize: '12px', lineHeight: 1.55, color: 'var(--text-faint, #7c879a)' },
} as const;

export function AdminLogin({
  mode,
  error,
  note,
}: {
  /** `disabled` is the closed door: no credential configured, or a broken one. */
  mode: 'sign-in' | 'disabled';
  error?: string | null;
  note?: string | null;
}) {
  if (mode === 'disabled') {
    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <span style={styles.eyebrow}>admin surface · closed</span>
          <h1 style={styles.title}>Admin access is not enabled on this deployment</h1>
          <p style={styles.note}>
            Wireup ships the console unlocked-by-default on purpose: it reaches generation internals, so a public
            host must opt in. Set <code>WIREUP_ADMIN_EMAIL</code> and <code>WIREUP_ADMIN_PASSWORD</code> in the
            service environment (on Render: the service&apos;s <em>Environment</em> tab, or <code>render.yaml</code>)
            and redeploy.
          </p>
          {note ? (
            <p style={styles.error}>{note}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <form style={styles.card} method="post" action="/api/admin/auth">
        <span style={styles.eyebrow}>admin surface</span>
        <h1 style={styles.title}>Sign in to the Wireup console</h1>

        {error ? <p style={styles.error}>{error}</p> : null}

        <label style={styles.label}>
          Email
          <input style={styles.input} name="email" type="email" autoComplete="username" required />
        </label>

        <label style={styles.label}>
          Password
          <input style={styles.input} name="password" type="password" autoComplete="current-password" required />
        </label>

        <input type="hidden" name="redirectTo" value="/admin" />

        <button type="submit" style={styles.button}>
          Sign in
        </button>

        <p style={styles.note}>
          Sessions last eight hours and are stored in an httpOnly cookie signed with{' '}
          <code>WIREUP_ADMIN_SECRET</code> (or the password, when no secret is set).
        </p>
      </form>
    </div>
  );
}
