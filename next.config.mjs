/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting is intentionally not part of the build; `pnpm typecheck` is the gate.
  eslint: { ignoreDuringBuilds: true },
  // Native/server-only packages must not be bundled by the Next.js webpack pass.
  serverExternalPackages: ['mongoose', '@aws-sdk/client-bedrock-runtime'],
};

export default nextConfig;
