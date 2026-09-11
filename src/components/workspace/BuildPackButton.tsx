'use client';

/**
 * The one-click handoff for a finished project.
 *
 * It uses fetch instead of a naked download link so a still-running project
 * can explain why it is not ready, and a failed export can stay visible in the
 * workspace rather than becoming a mysterious JSON download.
 */

import { useEffect, useState } from 'react';

function filenameFromHeader(value: string | null): string | null {
  if (!value) return null;
  const match = /filename="?([^";]+)"?/i.exec(value);
  return match?.[1] ?? null;
}

export function BuildPackButton({
  projectId,
  disabled = false,
  className = '',
}: {
  projectId: string;
  disabled?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!downloaded) return;
    const timer = window.setTimeout(() => setDownloaded(false), 2200);
    return () => window.clearTimeout(timer);
  }, [downloaded]);

  const download = async (): Promise<void> => {
    if (disabled || busy) return;
    setBusy(true);
    setDownloaded(false);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export`, { cache: 'no-store' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { message?: string; details?: string } } | null;
        const message = payload?.error?.message ?? `The build pack could not be created (${response.status}).`;
        throw new Error(payload?.error?.details ? `${message} ${payload.error.details}` : message);
      }

      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filenameFromHeader(response.headers.get('Content-Disposition')) ?? 'wireup-build-pack.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setDownloaded(true);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={`build-pack${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="btn btn--sm build-pack__button"
        onClick={() => void download()}
        disabled={disabled || busy}
        title={disabled ? 'The build pack becomes available when the project has artifacts.' : 'Download firmware, wiring, diagram, guide and validation as one zip'}
      >
        {busy ? 'packing…' : downloaded ? 'build pack ✓' : 'download build pack'}
      </button>
      {error ? (
        <span className="build-pack__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
