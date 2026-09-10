/**
 * Next.js configuration.
 *
 * `render.yaml` (and the Dockerfile) are the deployment side of this file: the
 * settings below exist because the app is expected to run somewhere other than
 * a laptop.
 */

/**
 * The container build asks for a traced, self-contained server bundle. It is
 * opt-in per build because `next start` — the entry point Render's *native* Node
 * runtime uses — is not a supported way to serve that output and warns about it
 * on every boot ("next start does not work with output: standalone"). It does
 * still serve correctly, but a deploy log that opens with a warning is a deploy
 * log nobody trusts, and the next major is free to turn it into an error. So the
 * trace is requested only where the entry point matches it.
 */
const standalone = process.env.WIREUP_STANDALONE_BUILD === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Linting is intentionally not part of the build; `pnpm typecheck` is the gate.
  eslint: { ignoreDuringBuilds: true },

  // Native/server-only packages must not be bundled by the Next.js webpack pass.
  serverExternalPackages: ['mongoose', '@aws-sdk/client-bedrock-runtime'],

  // `.next/standalone`: a server bundle holding only the files this app needs at
  // runtime. Set for the image build (see the Dockerfile) and deliberately not
  // set for Render's native runtime, which runs `next start` against the normal
  // output. The extra trace also matters here because the repo carries a ~105 MB
  // vendored Velxio checkout that must never be packed into a published layer.
  ...(standalone ? { output: 'standalone' } : {}),

  // No need to advertise the server stack on a public URL.
  poweredByHeader: false,

  // No `assetPrefix`/CDN and no `basePath` on purpose: everything the browser
  // is told to fetch here is a relative same-origin URL, so a build made on
  // Render's host serves correctly from any domain or preview URL. Baking an
  // origin in at build time is the classic "works in prod, breaks on the
  // preview" bug, and the app never needs it.
};

export default nextConfig;
