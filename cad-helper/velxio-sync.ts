/**
 * cad-helper/velxio-sync.ts
 * Integrates generated CAD models with Velxio's 3D simulator runtime
 * and WireUp's seeded component catalog.
 *
 * Where the assets land is a deployment question, not a code question. Locally
 * the answer is this repo's vendored checkout; when Velxio is hosted on its own
 * service (the usual arrangement), this process has no copy of its `public/`
 * directory to write into, and inventing one would only produce a file that
 * disappears on the next deploy. So the target is configurable and its absence
 * is reported as a real, actionable failure instead of a silent success.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CadComponentSpec, DeploymentResult, GeneratedCadOutput } from './types';
import { buildCadBundle } from './bundle-generator';

/** Vendored checkout, relative to the repo root — the zero-config default. */
const DEFAULT_FRONTEND_DIR = path.join('external', 'velxio', 'frontend');

export interface VelxioAssetTarget {
  /** Absolute path to the `models3d` directory to write into, or null when there is none. */
  modelsDir: string | null;
  /** Why there is none, in terms of what the operator can change. */
  reason?: string;
}

/**
 * Resolve where generated models should be written.
 *
 * `WIREUP_VELXIO_FRONTEND_DIR` points at a Velxio *frontend checkout* (the
 * directory that owns `public/models3d`) — set it when that checkout lives
 * outside this repo, e.g. on a mounted shared volume.
 *
 * `WIREUP_VELXIO_ASSETS=off` closes the write path deliberately, for a
 * deployment that hands generated models to Velxio some other way.
 *
 * Reads `process.env` directly rather than Wireup's env module: cad-helper is a
 * standalone surface and must stay usable from its own scripts.
 */
export function resolveVelxioAssetTarget(env: NodeJS.ProcessEnv = process.env): VelxioAssetTarget {
  if ((env.WIREUP_VELXIO_ASSETS ?? '').trim().toLowerCase() === 'off') {
    return {
      modelsDir: null,
      reason:
        'Asset writing is switched off on this deployment (WIREUP_VELXIO_ASSETS=off). The bundle is still ' +
        'generated and returned — deliver it to Velxio through its own asset pipeline.',
    };
  }

  const configured = (env.WIREUP_VELXIO_FRONTEND_DIR ?? '').trim();

  // Without an explicit target, the only candidate is this checkout's vendored
  // Velxio — and on a hosted service that directory is a copy made at build
  // time, not the site anyone is serving. Writing into it would report success
  // while publishing nothing, so production asks for intent instead.
  if (!configured && (env.NODE_ENV ?? '') === 'production') {
    return {
      modelsDir: null,
      reason:
        'This deployment hosts Velxio elsewhere, so there is no Velxio checkout to publish into. Generated ' +
        'models are still returned by the generate step; to hand them to the other service, mount its ' +
        'frontend where this process can write it and set WIREUP_VELXIO_FRONTEND_DIR to that path.',
    };
  }

  const frontendDir = path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured || DEFAULT_FRONTEND_DIR);
  const modelsDir = path.join(frontendDir, 'public', 'models3d');

  if (!fs.existsSync(path.join(frontendDir, 'public'))) {
    return {
      modelsDir: null,
      reason:
        `No Velxio frontend checkout at ${frontendDir}, so there is nothing to write into — expected when ` +
        'Velxio is hosted as a separate service. The generated model is still available from ' +
        '/api/admin/cad/generate; point WIREUP_VELXIO_FRONTEND_DIR at a mounted copy of that checkout if this ' +
        'deployment should publish assets directly.',
    };
  }

  return { modelsDir };
}

/**
 * Deploys the generated CAD assets to Velxio and registers them in manifest.json
 */
export async function deployToVelxioAndCatalog(
  spec: CadComponentSpec,
  bundle?: GeneratedCadOutput
): Promise<DeploymentResult> {
  const fail = (message: string): DeploymentResult => ({
    success: false,
    key: spec.id,
    glbPath: '',
    stlPath: '',
    manifestUpdated: false,
    seedUpdated: false,
    message,
  });

  const data = bundle || buildCadBundle(spec);

  const target = resolveVelxioAssetTarget();
  if (!target.modelsDir) return fail(target.reason ?? 'No writable Velxio asset directory.');

  const modelDir = path.join(target.modelsDir, spec.id);
  const manifestPath = path.join(target.modelsDir, 'manifest.json');

  try {
    // 1. Ensure the model folder exists in Velxio's public assets.
    fs.mkdirSync(modelDir, { recursive: true });

    // 2. GLB, STL and the spec that produced them, together, so a model can be
    //    re-derived from what is on disk rather than from the admin's history.
    fs.writeFileSync(path.join(modelDir, `${spec.id}.glb`), data.glbBinary);
    fs.writeFileSync(path.join(modelDir, `${spec.id}.stl`), data.stlBinary);
    fs.writeFileSync(path.join(modelDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf-8');

    // 3. Merge into manifest.json.
    let manifest: { version?: number; models?: Record<string, unknown> } = { version: 1, models: {} };

    if (fs.existsSync(manifestPath)) {
      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        manifest = JSON.parse(raw);
        if (!manifest.models) manifest.models = {};
      } catch {
        // A corrupt manifest is worth replacing; a permission error is not, so
        // only the parse failure falls back to an empty registry.
        manifest = { version: 1, models: {} };
      }
    }

    manifest.models![spec.id] = data.manifestEntry;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    return {
      success: true,
      key: spec.id,
      glbPath: `/models3d/${spec.id}/${spec.id}.glb`,
      stlPath: `/models3d/${spec.id}/${spec.id}.stl`,
      manifestUpdated: true,
      // Deliberately false: this writes Velxio's asset registry, not Wireup's
      // component catalog or Velxio's cad-catalog.json. Claiming otherwise here
      // is how a deploy ends up looking complete while the catalog still says
      // the part has no model — that step is `pnpm export:cad-catalog`.
      seedUpdated: false,
      message: `Deployed 3D CAD model for "${spec.name}" into ${target.modelsDir}. Run \`pnpm export:cad-catalog\` to push the catalog side.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to deploy CAD model';
    const code = (error as NodeJS.ErrnoException)?.code;
    // A read-only mount or a full disk is a deployment condition, so name it
    // as one instead of surfacing a bare ENOENT/EACCES to the console.
    if (code === 'EACCES' || code === 'EROFS' || code === 'EDQUOT' || code === 'ENOSPC') {
      return fail(
        `Cannot write generated models into ${target.modelsDir} (${code}: ${message}). This filesystem is not ` +
          'writable/persistent — hosting the assets for a separately deployed Velxio needs a shared volume.',
      );
    }
    return fail(message);
  }
}
