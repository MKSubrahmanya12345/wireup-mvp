/**
 * Seed the MongoDB component catalog.
 *
 *   pnpm seed                 # upsert every bundled component (idempotent)
 *   pnpm seed -- --dry-run    # validate + report, touch nothing
 *   pnpm seed -- --reset      # wipe the collection first, then seed
 *   pnpm seed -- --force      # seed even if the integrity report has problems
 *
 * The catalog is the ground truth for hardware: the planners and the model may
 * only select parts that exist here (or were inserted into MongoDB by hand).
 * Run this once after `pnpm install`, and again whenever a seed file changes.
 *
 * Note: this is a plain Node/tsx script, not a Next.js route, so it loads
 * `.env` itself (Node's `--env-file` is not assumed).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { connectMongo, disconnectMongo } from '@/lib/mongodb/client';
import { countComponents, listComponents, upsertComponents } from '@/lib/mongodb/components';
import { getComponentModel } from '@/models/Component';
import { SEED_COMPONENTS, checkCatalogIntegrity } from '@/modules/components/catalog';
import { ComponentDefinitionSchema } from '@/modules/components/schema';
import { env, resetEnvCache, requireMongoEnv, EnvError } from '@/lib/validation/env';
import { describeError } from '@/lib/logging/logger';
import type { ComponentDefinition } from '@/types/component';

interface Flags {
  dryRun: boolean;
  reset: boolean;
  force: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false, reset: false, force: false, help: false };
  for (const arg of argv) {
    const value = arg.trim().toLowerCase();
    if (value === '--dry-run' || value === '-n') flags.dryRun = true;
    else if (value === '--reset') flags.reset = true;
    else if (value === '--force') flags.force = true;
    else if (value === '--help' || value === '-h') flags.help = true;
  }
  return flags;
}

const HELP = `
wireup component seeder

usage: pnpm seed [--dry-run] [--reset] [--force]

  --dry-run   validate the bundled catalog and print the report, write nothing
  --reset     delete every document in the components collection before seeding
  --force     seed even when the integrity report lists problems
  --help      show this message

environment (read from .env / .env.local, or the process environment):
  MONGODB_URI   connection string (required)
  MONGODB_DB    database name (default "wireup")
`.trim();

/**
 * Minimal `.env` loader: `KEY=VALUE` lines, `#` comments, optional `export`
 * prefix and quoted values. Existing process env always wins so that CI and
 * container deployments are not silently overridden.
 */
function loadDotEnv(cwd: string): string[] {
  const loaded: string[] = [];
  for (const filename of ['.env.local', '.env']) {
    const path = resolve(cwd, filename);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const separator = withoutExport.indexOf('=');
      if (separator <= 0) continue;
      const key = withoutExport.slice(0, separator).trim();
      let value = withoutExport.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (key.length === 0) continue;
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded.push(`${filename}:${key}`);
      }
    }
  }
  return loaded;
}

function summariseByCategory(components: ComponentDefinition[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const component of components) {
    counts.set(component.category, (counts.get(component.category) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Never print credentials: hide the user:pass@ section of a Mongo URI. */
function redactUri(uri: string): string {
  const withoutScheme = uri.replace(/^[a-z+]+:\/\//i, '');
  const at = withoutScheme.lastIndexOf('@');
  if (at < 0) return uri;
  const scheme = uri.slice(0, uri.length - withoutScheme.length);
  return `${scheme}****@${withoutScheme.slice(at + 1)}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const loaded = loadDotEnv(process.cwd());
  // env() caches its first read; make sure it sees the .env values we just set.
  resetEnvCache();
  console.log('wireup · component seeder');
  console.log(`env files: ${loaded.length > 0 ? loaded.join(', ') : '(none needed — using process environment)'}`);

  // --- 1. Structural integrity of the bundled catalog ----------------------
  const report = checkCatalogIntegrity(SEED_COMPONENTS);
  console.log(`\nbundled catalog: ${report.total} components`);
  for (const row of summariseByCategory(SEED_COMPONENTS)) {
    console.log(`  ${pad(row.category, 22)} ${row.count}`);
  }

  if (report.ok) {
    console.log('\nintegrity: ok (unique ids, named pins, power/ground declared)');
  } else {
    console.log(`\nintegrity: ${report.problems.length} problem(s)`);
    for (const problem of report.problems) console.log(`  ✕ ${problem}`);
  }

  // --- 2. Re-validate every definition against the runtime schema ----------
  const schemaFailures: string[] = [];
  for (const component of SEED_COMPONENTS) {
    const parsed = ComponentDefinitionSchema.safeParse(component);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      schemaFailures.push(`${component.id} — ${issues}`);
    }
  }
  if (schemaFailures.length === 0) {
    console.log('schema: all definitions satisfy ComponentDefinitionSchema');
  } else {
    console.log(`schema: ${schemaFailures.length} definition(s) failed validation`);
    for (const failure of schemaFailures) console.log(`  ✕ ${failure}`);
  }

  if (!report.ok && !flags.force) {
    console.error('\nRefusing to seed a catalog with integrity problems. Fix the seed files, or pass --force.');
    return 1;
  }
  if (schemaFailures.length > 0 && !flags.force) {
    console.error('\nRefusing to seed definitions that fail schema validation. Pass --force to override.');
    return 1;
  }

  // --- 3. Environment ------------------------------------------------------
  const configuration = env();
  let mongoConfig: ReturnType<typeof requireMongoEnv>;
  try {
    mongoConfig = requireMongoEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(`\nMongoDB is not configured: ${error.message}`);
      console.error('Set MONGODB_URI in .env (copy .env.example) and try again.');
      return 1;
    }
    throw error;
  }
  console.log(
    `\nmongodb: db=${mongoConfig.dbName} uri=${redactUri(mongoConfig.uri)} autoseedComponents=${configuration.agent.autoseedComponents}`,
  );

  if (flags.dryRun) {
    console.log('\n--dry-run: nothing written. Catalog is valid and ready to seed.');
    return 0;
  }

  // --- 4. Write ------------------------------------------------------------
  try {
    await connectMongo();
    const before = await countComponents();
    console.log(`connected · ${before} document(s) already in the collection`);

    if (flags.reset) {
      const Component = getComponentModel();
      const deleted = await Component.deleteMany({});
      console.log(`--reset: deleted ${deleted.deletedCount ?? 0} document(s)`);
    }

    const result = await upsertComponents(SEED_COMPONENTS);
    console.log(`upsert: ${result.inserted} inserted, ${result.updated} updated, ${result.total} total`);

    // Prove what is actually queryable now, not just what we sent.
    const stored = await listComponents();
    const missing = SEED_COMPONENTS.filter((component) => !stored.some((entry) => entry.id === component.id)).map(
      (component) => component.id,
    );
    if (missing.length > 0) {
      console.error(`\n✕ ${missing.length} component(s) are not readable after seeding: ${missing.join(', ')}`);
      return 1;
    }

    console.log(`verified: all ${SEED_COMPONENTS.length} seeded components are readable from MongoDB`);
    const orphans = stored.filter((entry) => !SEED_COMPONENTS.some((component) => component.id === entry.id));
    if (orphans.length > 0) {
      console.log(
        `note: ${orphans.length} extra component(s) exist only in MongoDB (hand-inserted or from an older seed): ${orphans
          .slice(0, 8)
          .map((entry) => entry.id)
          .join(', ')}${orphans.length > 8 ? ', …' : ''}`,
      );
    }
    console.log('\nCatalog ready. The component selector will now retrieve these parts for every new project.');
    return 0;
  } catch (error) {
    const described = describeError(error);
    console.error(`\n✕ seeding failed: ${described.name ?? 'Error'}: ${described.message}`);
    console.error('  Check MONGODB_URI, network access and that the database accepts writes.');
    return 1;
  } finally {
    await disconnectMongo().catch(() => undefined);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    // Mongoose can keep handles open; exit explicitly so the script terminates.
    setTimeout(() => process.exit(code), 0).unref();
  })
  .catch((error: unknown) => {
    const described = describeError(error);
    console.error(`unexpected failure: ${described.message}`);
    if (described.stack) console.error(described.stack);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0).unref();
  });
