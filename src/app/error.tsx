'use client';

/**
 * Route-level error boundary — surfaces real backend failures (MongoDB down,
 * missing env, unexpected render errors) instead of a blank page.
 */

import Link from 'next/link';
import { useEffect } from 'react';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    // The structured logger on the server already records pipeline failures;
    // this keeps a client-side trace for render/route errors.
    console.error('[wireup] workspace error', error);
  }, [error]);

  return (
    <div className="error-page">
      <div>
        <h1>Something went wrong</h1>
        <p className="muted">{error.message || 'The workspace could not be rendered.'}</p>
        {error.digest ? <p className="small faint mono-sm">digest {error.digest}</p> : null}
        <p className="small muted">
          Common causes: <span className="mono-sm">MONGODB_URI</span> not reachable, Bedrock credentials missing, or the
          project document being written to while this page loaded. Check <span className="mono-sm">/api/health</span> for
          the exact state of every dependency.
        </p>
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={reset}>
            Try again
          </button>
          <Link href="/" className="btn btn--ghost">
            Back to prompt
          </Link>
          <Link href="/api/health" className="btn btn--ghost">
            Health check
          </Link>
        </div>
      </div>
    </div>
  );
}
