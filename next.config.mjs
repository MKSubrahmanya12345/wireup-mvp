/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is intentionally not part of the build; `pnpm typecheck` is the gate.
  eslint: { ignoreDuringBuilds: true },
  // Native/server-only packages must not be bundled by the Next.js webpack pass.
  serverExternalPackages: ['mongoose', '@aws-sdk/client-bedrock-runtime'],
  // ── Dev-loop speed ────────────────────────────────────────────────────────
  // `pnpm dev` runs Turbopack (`dev:webpack` is the webpack fallback).
  //
  // 1. `next dev` compiles routes on demand, so every page you hop to pays a
  //    compile, and by default a page is dropped from the dev cache after
  //    just 25s of inactivity — hopping back recompiles it from scratch.
  //    Keep visited routes warm (webpack dev; Turbopack keeps everything
  //    resident already).
  onDemandEntries: {
    maxInactiveAge: 15 * 60 * 1000,
    pagesBufferLength: 10,
  },
  // 2. Don't burn the webpack dev file watcher on directories that are never
  //    part of the module graph: `external/` alone is ~105 MB / ~1,900
  //    vendored files, iframe-served and never imported. Next's built-in
  //    ignore list only covers node_modules/.git/.next, and there is no
  //    top-level config key for it (`watchOptions` only accepts
  //    pollIntervalMs), so extend the webpack config's watchOptions here.
  //    Unused by Turbopack, which manages its own watcher. The `turbopack`
  //    key below pins the workspace root and also tells Next this config is
  //    Turbopack-aware, silencing its "Webpack is configured while Turbopack
  //    is not" warning on every dev boot (an empty object does NOT count —
  //    Next detects the key by flattening the config).
  turbopack: {
    root: import.meta.dirname,
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // Replace the watcher ignore list entirely: webpack accepts either a
      // single RegExp (Next's default, covering node_modules/.git/.next) or
      // an array of glob strings — not a mix. Express the defaults as globs
      // and add external/ (105 MB of vendored iframe assets, never imported).
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/external/**'],
      };
    }
    return config;
  },
};

export default nextConfig;
