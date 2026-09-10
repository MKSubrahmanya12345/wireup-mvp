/**
 * Where the two embedded halves of the simulation page live.
 *
 * /simulation embeds two things Wireup does not serve:
 *
 *   Velxio     the emulator (its own app, its own host)
 *   Dashboard  the web app this build generated, from the zip it produced
 *
 * Both are addressed by URL and both are loaded by the *browser*, never by
 * Wireup's server — it cannot reach them; they live on the visitor's machine or
 * on a service the visitor can see. That is the only arrangement that works
 * when the halves are on different machines, which is exactly what happens once
 * Wireup is hosted: Wireup runs on its own origin, Velxio on another.
 *
 * Defaults therefore depend on where Wireup itself is running:
 *
 *   development  `http://localhost:5174` / `:5175` — the ports those dev
 *                servers bind, so a clone needs no configuration.
 *   production   unset means *unconfigured*, not "the visitor's localhost".
 *                Falling back to localhost on a hosted deployment points every
 *                visitor's browser at their own machine, which is both wrong
 *                and confusing: they get an iframe that hangs on a port they
 *                never opened. Set WIREUP_VELXIO_URL to the hosted Velxio.
 */

export interface SimulationEndpoints {
  /** Velxio frontend (the emulator canvas), or null when not configured. */
  velxioUrl: string | null;
  /** The generated dashboard's dev server, or null when not configured. */
  websiteUrl: string | null;
  /** Which half the page opens on. */
  defaultView: 'simulation' | 'website';
  /**
   * Whether each URL points somewhere other than the visitor's own machine.
   * The UI uses this to switch between "start your dev server" advice and
   * "the hosted emulator is not answering" advice — they are different
   * problems with different fixes, and the difference only shows up once the
   * app is hosted.
   */
  velxioRemote: boolean;
  websiteRemote: boolean;
  /** Why the half is unavailable, in terms of the variable to set. */
  velxioProblem: string | null;
  websiteProblem: string | null;
}

const DEV_DEFAULTS = {
  velxio: 'http://localhost:5174',
  website: 'http://localhost:5175',
} as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

function production(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Normalised origin (no trailing slash), or null when the value is unusable. */
function normalise(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isRemote(url: string | null): boolean {
  if (!url) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function missing(variable: string, fallback: string): string {
  return (
    `${variable} is not set on this deployment. Without it there is nothing to embed — on a hosted ` +
    `Wireup the fallback cannot be ${fallback}, because that is the visitor's own machine, not a service ` +
    'of yours.'
  );
}

export function simulationConfig(): SimulationEndpoints {
  const velxioUrl = normalise(process.env.WIREUP_VELXIO_URL) ?? (production() ? null : DEV_DEFAULTS.velxio);
  const websiteUrl =
    normalise(process.env.WIREUP_WEBSITE_URL) ??
    (production() ? null : normalise(process.env.WIREUP_DASHBOARD_URL) ?? DEV_DEFAULTS.website);
  const view = process.env.WIREUP_SIM_DEFAULT_VIEW?.trim().toLowerCase();

  return {
    velxioUrl,
    websiteUrl,
    defaultView: view === 'website' ? 'website' : 'simulation',
    velxioRemote: isRemote(velxioUrl),
    websiteRemote: isRemote(websiteUrl),
    velxioProblem: velxioUrl ? null : missing('WIREUP_VELXIO_URL', DEV_DEFAULTS.velxio),
    websiteProblem: websiteUrl ? null : missing('WIREUP_WEBSITE_URL', DEV_DEFAULTS.website),
  };
}
