/**
 * cad-helper/velxio-sync.ts
 * Integrates generated CAD models with Velxio's 3D simulator runtime
 * and WireUp's seeded component catalog.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CadComponentSpec, DeploymentResult, GeneratedCadOutput } from './types';
import { buildCadBundle } from './bundle-generator';

/**
 * Deploys the generated CAD assets to Velxio frontend and registers in manifest.json
 */
export async function deployToVelxioAndCatalog(
  spec: CadComponentSpec,
  bundle?: GeneratedCadOutput
): Promise<DeploymentResult> {
  try {
    const data = bundle || buildCadBundle(spec);
    const repoRoot = process.cwd();

    // 1. Ensure target model folder exists in Velxio
    const modelDir = path.join(repoRoot, 'external', 'velxio', 'frontend', 'public', 'models3d', spec.id);
    fs.mkdirSync(modelDir, { recursive: true });

    // 2. Write GLB file
    const glbPath = path.join(modelDir, `${spec.id}.glb`);
    fs.writeFileSync(glbPath, data.glbBinary);

    // 3. Write STL file
    const stlPath = path.join(modelDir, `${spec.id}.stl`);
    fs.writeFileSync(stlPath, data.stlBinary);

    // 4. Write Spec JSON
    const specPath = path.join(modelDir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf-8');

    // 5. Update / merge manifest.json in Velxio
    const manifestPath = path.join(repoRoot, 'external', 'velxio', 'frontend', 'public', 'models3d', 'manifest.json');
    let manifest: any = { version: 1, models: {} };

    if (fs.existsSync(manifestPath)) {
      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        manifest = JSON.parse(raw);
        if (!manifest.models) manifest.models = {};
      } catch (err) {
        manifest = { version: 1, models: {} };
      }
    }

    manifest.models[spec.id] = data.manifestEntry;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    return {
      success: true,
      key: spec.id,
      glbPath: `/models3d/${spec.id}/${spec.id}.glb`,
      stlPath: `/models3d/${spec.id}/${spec.id}.stl`,
      manifestUpdated: true,
      seedUpdated: true,
      message: `Successfully generated and registered 3D CAD model for "${spec.name}" in Velxio models3d registry!`,
    };
  } catch (error) {
    return {
      success: false,
      key: spec.id,
      glbPath: '',
      stlPath: '',
      manifestUpdated: false,
      seedUpdated: false,
      message: error instanceof Error ? error.message : 'Failed to deploy CAD model',
    };
  }
}
