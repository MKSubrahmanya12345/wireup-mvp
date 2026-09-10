# ---------------------------------------------------------------------------
# Wireup — container build (the alternative to Render's native Node runtime)
#
# Use this when you want the Docker runtime on Render (`runtime: docker`), or
# any other host that takes an image. Two reasons it exists at all:
#
#   1. `g++` is present, so the host-side firmware compile gate actually runs.
#      On Render's native Node runtime there is no C++ compiler and the gate
#      honestly reports "skipped" instead of type-checking the sketch.
#   2. The image ships Next's standalone trace only. This repo carries a ~105 MB
#      vendored Velxio checkout that must not end up in a published layer —
#      `.dockerignore` keeps it out of the build context entirely.
#
# If you do not need either, `render.yaml`'s native Node service is the simpler
# deploy: same app, no image to maintain.
#
#   docker build -t wireup .
#   docker run --rm -p 3000:3000 --env-file .env wireup
# ---------------------------------------------------------------------------

# Pinned to the major in .node-version; both are needed for their toolchains, so
# the runtime stage installs only the smaller pieces it actually requires.
FROM node:24-slim AS deps

WORKDIR /app

# Corepack is how the pinned pnpm in `packageManager` becomes a command. The
# npm fallback covers a base image built without it, and the prompt-disable keeps
# a first-run version download from stalling a non-interactive build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm || npm install -g pnpm@9.15.4

COPY package.json pnpm-lock.yaml ./
# `--frozen-lockfile` fails the build if the lockfile is out of sync with
# package.json, rather than quietly resolving something different from what was
# tested. devDependencies are kept: `next`, `tsx` and `typescript` are all
# build-time tools.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------

FROM node:24-slim AS build

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm || true

# Build args, not ENV: nothing here is a secret, and NEXT_PUBLIC_* values are
# inlined into the client bundle at build time, so they must exist NOW rather
# than at runtime. Changing one means rebuilding, which is why Render's native
# path (build on the server) is less surprising for these.
ARG NEXT_PUBLIC_APP_NAME=Wireup
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_TELEMETRY_DISABLED=1
# Asks `next build` for the traced standalone bundle this image runs directly
# (`node server.js`). Render's native Node runtime never sets this and runs
# `next start` against the ordinary output, so each entry point keeps the build
# it is actually supported with.
ENV WIREUP_STANDALONE_BUILD=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm run build

# ---------------------------------------------------------------------------

FROM node:24-slim AS runtime

WORKDIR /app

# The firmware compile gate shells out to a C++ compiler. `--no-install-recommends`
# keeps this to a few tens of MB; delete the layer and the gate reports itself as
# unavailable rather than passing silently, which is the intended degradation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Standalone trace: the server bundle plus only the dependencies it imports.
# `public/` and `/.next/static` are NOT in the trace (verified against a local
# build) and must be copied by hand — a missing one is the classic "the page
# renders but every asset 404s" image bug.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# The stub Arduino core the firmware compile gate type-checks sketches against,
# and the runtime shim the behaviour evaluator links the sketch against. Both are
# resolved from `process.cwd()` at request time, so they must sit beside
# `server.js`. Next's tracer happens to pick them up today; that is an
# implementation detail of a build step, so the copy is explicit rather than
# borrowed from `.next/standalone`.
COPY --from=build /app/scripts/firmware-shim ./scripts/firmware-shim
COPY --from=build /app/scripts/firmware-shim-runtime ./scripts/firmware-shim-runtime

# The catalog is seeded by the app itself on first use (WIREUP_AUTOSEED_
# COMPONENTS=true) rather than by `pnpm seed` here: that script needs `tsx`,
# which is a devDependency and deliberately not in this image. Run it from the
# build stage instead if you want to own the moment of seeding:
#   docker build --target build -o type=tar,dest=- . | ...

# Never run as root: the CAD studio can write to the filesystem.
USER node

EXPOSE 3000

# Uses the dependency-free liveness route for the same reason `render.yaml`
# does — readiness that depends on MongoDB turns a database blip into a restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `tini` as PID 1: the compile gate spawns child processes, and an orphaned g++
# would otherwise linger as a zombie in a long-lived container.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
