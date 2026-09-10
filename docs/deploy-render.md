# Deploying Wireup on Render

Everything here is specific to Wireup-as-it-is: one Next.js 15 server that talks
to MongoDB and Amazon Bedrock, runs agent work **inside its own process**, and
embeds a simulator that lives somewhere else. Read the two "why" boxes before
changing instance sizes — they are the parts that bite.

**TL;DR** — create a MongoDB Atlas free cluster → add `MONGODB_URI` + the AWS
and admin variables → deploy the `render.yaml` Blueprint in this repo → open
`https://<service>.onrender.com/api/health` once so the catalog seeds itself.
Full steps below; the checklist at the end is the short version.

> **Read [§13](#12-is-it-safe-to-hand-someone-the-url) before you put the URL in
> a deck or a group chat.** It is the honest answer to "is it secure now", and it
> names the two things that are deliberately open.

---

## 1. What this app needs from a host

| Need | Why | Consequence if ignored |
| --- | --- | --- |
| ≥ 2 GB RAM for the build | `next build` here peaks at ~0.9 GB resident (measured locally, cold cache) | Starter/Free (512 MB): the build is killed by the OOM killer mid-compile, with a message that looks like a Next bug |
| A process that keeps running | generation runs execute in the process that took the `POST`, and the console polls for the events it appends | A sleeping instance loses an in-flight run. It does not corrupt anything (the next poll marks it interrupted, see [§8](#8-limits-that-come-from-running-an-agent-in-a-web-process)), but the run has to be re-triggered |
| Exactly one instance | same reason: in-memory run state (`isRunning`) is per-process | Scaling past 1 orphans runs on whichever instance did not start them |
| Outbound IPv4 to `*.amazonaws.com` + your Atlas host | Bedrock and MongoDB are both called over the public internet | Bedrock timeouts / 10 s Mongo connect failures |
| `PORT` honoured, bound on all interfaces | Render's proxy connects to the container interface, not loopback | Deploys that never pass the health check and roll back |

Wireup already satisfies the last row without help: `next start` reads `PORT`
itself (its CLI declares `.env('PORT')` and defaults its bind host to
`0.0.0.0`), and `pnpm run start:render` pins both explicitly so the behaviour
does not depend on a default that Next is free to change.

### Costs, stated plainly

Render's web service tiers (2026): Free 512 MB/0.1 CPU $0, **Standard 2 GB/1 CPU
$25**, Starter 512 MB/0.5 CPU $7. Atlas M0 (free) is enough to develop against.

Free is usable for a demo you poke at occasionally, with two eyes open: it
sleeps after 15 idle minutes, the first request waits ~a minute for the cold
start, and a build on 0.1 CPU is slow enough to be uncomfortable. It is also
below the memory the build needs, so **plan on Standard for anything you intend
to hand to someone else.**

---

## 2. Path A — the Blueprint (recommended)

`render.yaml` at the repo root declares the service, so no settings are typed
into a dashboard and none of them drift.

1. Push this branch to GitHub.
2. Render → **New +** → **Blueprint** → pick `MKSubrahmanya12345/wireup-mvp` →
   confirm the branch.
3. Render reads the file and asks for the values marked `sync: false`. Fill in
   what you have; leave blanks for anything you do not need yet (see §4 for what
   is optional).
4. Deploy. Then open `https://<name>.onrender.com/api/health` once — that call
   triggers catalog autoseeding (`WIREUP_AUTOSEED_COMPONENTS=true`) against an
   empty Atlas database.

Later, `pnpm exec prettier`-style drift is not an issue, but a Blueprint edit
*will* overwrite any variable that has a `value:` in `render.yaml`. That is why
secrets use `sync: false` (prompted once, then owned by the dashboard) and
`WIREUP_ADMIN_SECRET` uses `generateValue: true` (Render mints a 256-bit value).

## 3. Path B — by hand in the dashboard

Use this if you would rather not adopt the Blueprint yet. Create a **Web
Service** and set exactly:

```
Runtime         Node
Region          Oregon (pick the one nearest your Atlas cluster)
Branch          main
Build command   pnpm install --frozen-lockfile && pnpm run build
Start command   pnpm run start:render
Instance type   Standard (2 GB / 1 CPU)
Health check    /api/health/live
Scale           1 instance
```

Then add the environment variables from §4. Two things people get wrong here:

* **Do not set `NODE_ENV`.** Render already sets `NODE_ENV=production` at
  runtime, and `next build` sets it during the build. Setting it for the whole
  service makes the installer skip devDependencies — and `next`, `tsx` and
  `typescript` *are* devDependencies, so the build dies on `next: not found`.
* **Do not point the health check at `/api/health`.** That route is the
  operator-facing dependency report and it answers **503** when MongoDB is
  unreachable or the catalog is empty. A probe on it restarts an instance that
  is working fine — and the replacement is no healthier, so you get a restart
  loop with a plausible error message. `/api/health/live` is the dependency-free
  liveness route built for the probe.

---

## 4. Environment variables

Wireup reads every value through `src/lib/validation/env.ts`; nothing is
hardcoded, and everything not listed here has a working default, so a minimal
deployment is four rows.

**Required**

| Variable | Notes |
| --- | --- |
| `MONGODB_URI` | Atlas SRV string. **Production rejects a `localhost`/`127.0.0.1` URI outright** with an explanation, because on a host that URI means "this container's own loopback", and the resulting 10 s timeout reads like a network fault instead of a missing value. |
| `MONGODB_DB` | Default `wireup`. |
| `AWS_REGION`, `BEDROCK_MODEL_ID` | Must agree: a `us-east-1` client against a `us-west-2` model id surfaces as a timeout, not as a mismatch. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The SDK's default credential chain is also consulted, but Render gives a container no instance role — so on Render, static keys are the only thing that works. |

**Admin surface** (see §7)

| Variable | Notes |
| --- | --- |
| `WIREUP_ADMIN_EMAIL`, `WIREUP_ADMIN_PASSWORD` | Both, or the console stays closed. |
| `WIREUP_ADMIN_SECRET` | Session-signing key. Falls back to the password. |

**Simulator** (see §6)

| Variable | Notes |
| --- | --- |
| `WIREUP_VELXIO_URL` | Where the emulator iframe loads from. |
| `WIREUP_WEBSITE_URL` | Where the generated dashboard iframe loads from. |
| `WIREUP_SIM_DEFAULT_VIEW` | `simulation` (default) or `website`. |

**Tunables worth knowing about on a host**

| Variable | Default | Why you might change it on Render |
| --- | --- | --- |
| `BEDROCK_TIMEOUT_MS` | `120000` | A single model call may outlive Render's proxy read window. Harmless — generation is not request-scoped — but see §8. |
| `WIREUP_AUTOSEED_COMPONENTS` | `true` | Turn off once the collection is populated and you prefer to seed deliberately (`pnpm seed`). |
| `WIREUP_ENABLE_FIRMWARE_COMPILE` | `true` | Leave on. On Render's **native Node** runtime there is no `g++`, and the gate reports "no C++ compiler found on PATH" instead of pretending to have checked. The Docker image in §9 has one. |
| `WIREUP_ENABLE_WEB_DOCS` | `true` | The research tool's best-effort page fetch. |
| `WIREUP_MAX_REVISIONS` / `WIREUP_MAX_EVENTS` | `12` / `1500` | Caps per project document; lower them if Atlas free-tier document size gets tight. |
| `NEXT_PUBLIC_APP_NAME` | `Wireup` | Build-time inlined. Changing it in the dashboard alone does nothing until a rebuild. |

A note on names: Render injects its own `RENDER_*` variables and treats that
prefix as reserved — a `RENDER_…` variable you define can be overwritten by the
platform's. All of Wireup's own configuration is `WIREUP_*`, `BEDROCK_*`,
`AWS_*` or `MONGODB_*`, which is one reason it is spelled that way.

---

## 5. MongoDB Atlas checklist

1. **Build a free M0 cluster** (512 MB). Pick the provider/region closest to the
   Render region you chose.
2. **Network access → allow `0.0.0.0/0`.** Render does not give your service a
   fixed outbound IP, so an allowlist of specific addresses will fail
   intermittently — usually only when a container is rescheduled, which is the
   worst possible time to discover it. Restrict it properly later with Atlas
   Private Edge or a VPC peering setup instead.
3. **Database user** — create one; do not use the admin user for the app.
4. Copy the **DRIVER** connection string (the `mongodb+srv://…` one) into
   `MONGODB_URI`.
5. `MONGODB_DB` can stay `wireup`; the collections (`components`, `projects`)
   are created on first write.

Nothing else to migrate: the catalog seeds itself on first use, and there are no
schema migrations in this app.

---

## 6. Velxio, which lives somewhere else

This is the part of the topology that changed: Wireup does not host the
simulator. The `/simulation` page loads it in an iframe, so the only
relationship between the two is a URL that a **browser** must be able to reach.

Three conditions, and each fails in a way that looks like a Wireup bug:

* **`WIREUP_VELXIO_URL` must be set.** Unset in production now means
  "unconfigured" and the page says so; it no longer falls back to
  `localhost:5174`, because on a hosted app that fallback points every visitor's
  browser at *their own* machine.
* **It must be https** while Wireup is https. An https page cannot embed an
  http origin (localhost excepted) — the frame stays blank. The panel detects
  exactly this and shows a warning instead of a dead iframe.
* **That deployment must carry the embed bridge.** The page and the emulator talk
  over `postMessage` (`velxio:ready`, `velxio:load-vlx`, `velxio:serial-data`,
  …); a stock Velxio loads, renders the circuit and never greets the page. The
  patched source is in this repo at `external/velxio` (plus
  `external/patches/velxio-embed-bridge.patch` for an unpatched checkout), so
  deploy the emulator from that source, not from an upstream image.

Then: make sure Velxio's own response headers do not forbid framing
(`X-Frame-Options` unset, `frame-ancestors` including your Wireup origin), and
that its `embedBridge` accepts *Wireup's* origin rather than only localhost —
that is the check that has to widen when the two are on different hosts.

The generated **dashboard** half (`WIREUP_WEBSITE_URL`) is different in kind: it
is a zip the build produced, which the user unzips and runs. There is normally
nothing to point this at on a hosted deployment, so leave it unset; the page
offers the download and says why the frame is empty.

**The CAD studio's publish step follows the same topology.**
`POST /api/admin/cad/deploy` writes generated models into a Velxio frontend
checkout. When that checkout is not this process's to write (production with no
`WIREUP_VELXIO_FRONTEND_DIR`), the endpoint returns a failure that explains the
situation instead of writing into a build-time copy of a directory nobody serves
and reporting success. The model is still generated and returned by
`/api/admin/cad/generate`, so nothing is lost — delivery is just a different
service's job. `WIREUP_VELXIO_ASSETS=off` says the same thing on purpose.

---

## 7. The admin surface on a public URL

`/admin` drives endpoints that spend model tokens (`/api/admin/cad/generate`),
write files (`/api/admin/cad/deploy`) and read telemetry
(`/api/admin/catalog/demand`). Two things were true before this existed on the
internet: the console and all of those endpoints were reachable by anyone with
the URL, and `/api/admin/auth` checked a credential pair committed to the
repository. Both are fixed, and the fix is deliberate about direction:

* **Development is open.** `pnpm dev` needs no admin setup; localhost is your own
  machine.
* **Production is gated, and gates *closed*.** No `WIREUP_ADMIN_PASSWORD` → the
  page explains how to enable it, and the APIs answer 503. Forgetting a variable
  is never the same as an unlocked console.
* Signing in posts the configured email + password to `/api/admin/auth`, which
  sets an `httpOnly`, `SameSite=Lax` session cookie (Secure when the request came
  over https, judged from `X-Forwarded-Proto`, since behind Render's proxy the
  request URL itself is the internal one). Sessions last 8 hours and are HMAC
  signed; changing `WIREUP_ADMIN_SECRET` or the password invalidates them.
* Scripted calls can skip the cookie: `Authorization: Wireup-Admin <session>`.

To try it from a terminal:

```bash
curl -sS -X POST https://<name>.onrender.com/api/admin/auth \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$WIREUP_ADMIN_EMAIL\",\"password\":\"$WIREUP_ADMIN_PASSWORD\"}"
```

If you would rather not expose the console at all, simply leave the two admin
variables unset — that is a supported configuration, not a broken one.

---

## 8. Limits that come from running an agent in a web process

These are properties of the current architecture, not Render bugs. Worth knowing
before someone asks why a run stopped.

* **A restart mid-run loses that run.** Deploys, reschedules and free-tier
  sleep all restart the process. Nothing is corrupted: the project document is
  left non-terminal, and the next poll of `/api/projects/<id>/events` notices
  nobody owns it (`src/modules/orchestrator/recovery.ts`) and marks the run
  interrupted with a real event in the console. Re-triggering is a click in the
  workspace.
* **Proxy timeouts do not cancel a build**, because `POST /api/projects` returns
  immediately and progress arrives by polling. A long `BEDROCK_TIMEOUT_MS` is
  therefore not a deploy hazard. It *is* a hazard for anything that keeps one
  request open, which is one reason the events endpoint polls rather than
  streaming.
* **Local disk is disposable.** `/api/projects/<id>/simulation/software.zip` is
  built in memory, so downloads are safe. The demand telemetry file
  (`.wireup/demand.jsonl`) and any CAD assets written to disk vanish on redeploy;
  both are already written best-effort and degrade to a debug log. If the demand
  report matters to you, put it somewhere durable (a collection, an object
  store) rather than counting on the container filesystem.
* **The host-side compile gate is skipped** on the native Node runtime, honestly
  reported rather than silent. The Dockerfile in §9 installs `g++` if you want the
  gate to actually run in production.

---

## 9. Optional: the Docker runtime

`Dockerfile` + `.dockerignore` at the repo root. Use it when you want the
compile gate to work, when you want to review exactly what ships, or when you
want to run this image on another container host unchanged. It is a multi-stage
build that ships Next's standalone trace (`output: 'standalone'`), installs
`g++` for the compile gate, runs as `node` under `tini`, and keeps `external/`
out of the context.

```yaml
# the only render.yaml lines that change
runtime: docker
dockerfilePath: ./Dockerfile
# buildCommand / startCommand are ignored for Docker services
```

`HEALTHCHECK` in the image uses the same `/api/health/live` path, so container
orchestration and Render agree about what "healthy" means. The image build sets
`WIREUP_STANDALONE_BUILD=1`, which is what makes `next build` emit the traced
bundle the image then runs with `node server.js`; Render's native runtime leaves
it unset and serves the ordinary output through `next start`, because that pair
is the supported combination and it keeps a warning out of the deploy log.

Note the tradeoff, so it is not a surprise: with `runtime: docker`,
**`NEXT_PUBLIC_*` values are baked in at image build**, so §4's build-time
variables become a rebuild instead of an env edit. The native runtime builds on
Render's machine and has no such issue.

---

## 10. After the first deploy

```bash
BASE=https://<name>.onrender.com

# 1. liveness (what Render's probe sees)
curl -sS $BASE/api/health/live

# 2. the real dependency report — 200 once the catalog seeded, 503 until then
curl -sS $BASE/api/health | head -c 900

# 3. an end-to-end run, no UI: direct mode skips the intake session
ID=$(curl -sS -X POST $BASE/api/projects -H 'content-type: application/json' \
  -d '{"prompt":"ESP32-S3 greenhouse monitor: DHT22 temperature and humidity on a 0.96\" SSD1306 display, buzzer alarm above 32C, USB powered.","mode":"direct"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).project.id')

for i in $(seq 1 24); do
  curl -sS "$BASE/api/projects/$ID/events?after=0" \
    | node -pe 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));(d.status||"?")+" · "+(d.stage||"?")+" · rev "+d.revision'
  sleep 5
done
```

`/api/health` is the one call that tells you whether the deployment is actually
wired to anything: it reports Mongo reachability and component count, which
catalog source answered, whether Bedrock is configured (and with which model),
and the agent flags. With no credentials it says generation is running
deterministically — that is a working, honest state, not a failure, and it is a
useful thing to be able to show a judge.

Then in the UI: create a project from the home page, watch the console stream,
open `/project/<id>/simulation`, and if you wired Velxio, confirm the circuit
lands on its canvas without a manual import and that **pull canvas → diagram
json** writes a revision back.

---

## 11. Troubleshooting

| Symptom | Most likely cause, in this app |
| --- | --- |
| Build killed with exit code 137, no useful log | Not enough RAM for `next build`. Go to Standard (2 GB). |
| `next: command not found` during build | `NODE_ENV=production` set on the service → devDependencies were skipped. Remove it. |
| Deploy never goes live; health check fails | The app is bound to loopback or the wrong port (custom start command that dropped `-H 0.0.0.0`), or `healthCheckPath` points at `/api/health`, which legitimately answers 503 before seeding. |
| Pages 500 with `MongoDB connection failed` | Atlas allowlist. Needs `0.0.0.0/0`, or a peered network. |
| `Wireup is missing required environment configuration: MONGODB_URI` | Not set — or set only in a preview environment, where `sync: false` variables are deliberately excluded. |
| Generation completes but every sketch looks template-ish | Bedrock not configured (`/api/health` → `bedrock.configured: false`). Deterministic fallback is intentional; check `AWS_REGION`/model id agreement and the keys. |
| `Bedrock unreachable` / `EAI_AGAIN` | IPv6-half lookups. `WIREUP_DNS_RESULT_ORDER=ipv4first` (the default) is the fix; if something overrode it with `NODE_OPTIONS=--dns-result-order=…`, that wins. |
| The simulation iframe is blank | §6, in order: unset `WIREUP_VELXIO_URL`, http-under-https, or an unpatched Velxio. |
| A run stops at a random stage after a deploy | §8. Re-trigger it; consider `maxShutdownDelaySeconds` so in-flight work gets a chance to write a terminal event. |
| CAD deploy says it cannot write | Expected on a separately hosted Velxio. §6's last paragraph. |
| Every `NEXT_PUBLIC_*` change does nothing | It is build-time. Rebuild, not just redeploy. |


---

## 12. Is it safe to hand someone the URL?

Short answer: **the admin surface is locked, the demo surface is not — on
purpose.** Wireup has no accounts, no per-user data and no billing, so the model
it is safe to deploy under is *a single shared workspace that you are willing to
pay for*. Here is exactly what follows from that.

### Open by design, and what it costs

| Endpoint | Why it is open | The cost of that |
| --- | --- | --- |
| `POST /api/projects` | that **is** the product — a judge with a URL types a prompt | every run spends Bedrock tokens and a few minutes of this container; there is **no rate limit and no per-IP cap**, so one hostile page can turn $7 of inference into $700 |
| `GET`/`POST /api/projects/:id/*` | the workspace must be linkable to be demoable | knowing an id grants the firmware, the diagram, the zip download. Ids are 16 hex chars from `crypto.randomUUID()` (64 bits, not enumerable) — **but** `GET /api/projects` used to publish every id *with its prompt*, which is why that route now sits behind the admin session |
| `GET /api/health`, `/api/health/live` | the platform probe and the UI banner | leaks configuration *shape* (region, model id, counts). No credential ever appears in it: `logger.ts` redacts the credential keys and `MONGODB_URI` is logged host-only with its userinfo replaced |

If the money risk is not one you want to carry for a public link, the two things
that fix it are a Cloudflare Access / `Auth Basic` app in front of the service,
or a `WIREUP_REQUIRE_INVITE`-style gate on project creation. Say the word and I
will add the second; it is ~30 lines and it changes the demo flow, so it is not
a decision to make silently.

### Closed now, and why each one was a real problem

* **`/admin` and `/api/admin/*`** — were world-reachable, with a credential pair
  committed to source that nothing called. Now env-driven, session-gated, and
  closed when unconfigured (§7).
* **The behaviour harness no longer runs by default in production.** This is the
  one worth understanding, because it is not a web-shaped risk:
  `WIREUP_ENABLE_BEHAVIOUR_RUNTIME`'s harness compiles the generated sketch
  against the stub runtime and **executes it**, then reads its serial trace.
  Generated-from-a-prompt source, compiled and run as the service user, on a box
  whose environment contains `MONGODB_URI` and the AWS keys. Until now the child
  inherited `process.env` wholesale, which is a credential handover, and it was
  reachable anonymously because creating a project is.
  Two changes:
  1. **The child environment is now explicit** — `PATH`, the three `WIREUP_SIM_*`
     values and nothing else, with `cwd` confined to the scratch directory. A
     sketch that calls `getenv("MONGODB_URI")` gets `NULL` (verified by executing
     exactly that probe against the harness: `WIREUP_SIM_MS` visible, credentials
     missing). A run that wedges outside `loop()` is now killed at 30 s instead
     of being waited on forever.
  2. **It is off in production unless opted in.** Scrubbing the environment is
     containment by omission, not a sandbox: same uid, same filesystem, same
     `/proc` — and `/proc/<parent>/environ` is readable by a child of the same
     user, so the credentials were never *safely* reachable-but-fine. The
     honest fixes are isolation or not running it; until there is isolation, the
     default is to not run it. **Nothing pretends otherwise**: runtime assertions
     come back `status: skipped` with the reason, they are never counted as
     passing, and the `failures` tally ignores skipped checks — so a build that
     would have been flagged still reports its static results and its compile
     gate normally.

  To get runtime assertions on a hosted demo, choose one: run it on your own
  machine (default on), or set `WIREUP_ENABLE_BEHAVIOUR_RUNTIME=true` on a
  service whose traffic you control and accept that a prompt can execute native
  code inside that container.
* **Response headers** (`next.config.mjs`): `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN` + `Content-Security-Policy: frame-ancestors
  'self'` (so no third-party site can frame `/admin`'s login form), and
  `Referrer-Policy: strict-origin-when-cross-origin` (so a project id does not
  leak to an outbound link's referrer). Deliberately **not** a full CSP: the
  console paints with inline `style` attributes, so a strict `style-src` would
  strip the UI's appearance on the host while looking perfect in dev.
* **`poweredByHeader: false`**, and the vendored `external/` tree never enters
  the image (`.dockerignore`).

### Not addressed, by omission rather than oversight

* **Secret rotation is your job.** Render stores these as plain service env vars
  (no KMS/secret-manager integration here). If a deploy log or a screenshot ever
  shows `MONGODB_URI`, rotate the Atlas user; the AWS key should be scoped to
  `bedrock:InvokeModel*` on the one model ARN you use — that single IAM policy
  does more to bound the blast radius of anything on this list than any code
  change in it.
* **`pnpm audit` / lockfile review** was not part of this pass; run
  `pnpm audit --audit-level=high` before you call a deploy reviewed, and note
  `mongoose`/`zod` majors when they move.
* **No request body size limits** beyond the app's own validators (prompts cap at
  4 000 chars; the CAD routes accept whatever JSON arrives).
* **Free/paid sleep still truncates a run** (§8) and **local disk is still
  disposable** — availability properties, not confidentiality ones.

### The 60-second adversarial check on a live deploy

```bash
BASE=https://<name>.onrender.com
curl -sso /dev/null -w "project list without a session  -> %{http_code}  (want 401/503)\n" $BASE/api/projects
curl -sso /dev/null -w "admin console without a session -> %{http_code}  (want 200, and the body must be the login card)\n" $BASE/admin
curl -s  $BASE/admin | grep -c 'control-shell'                                          # want 0
curl -sSo /dev/null -D- $BASE/ | grep -iE "x-frame-options|nosniff|referrer-policy"       # want 3
curl -sS $BASE/api/health | node -pe 'const d=JSON.parse(0+require("fs").readFileSync(0,"utf8"));
  "bedrock "+(d.bedrock.configured?"configured":"not configured")+" · catalog "+d.catalog.size+" · mongo "+d.mongo.ok'
# and, from a browser devtools console on the deployed origin:
#   fetch('/api/admin/cad/generate',{method:'POST',body:'{}'})  -> 401, not 200
```

If `grep -c 'control-shell'` on an unauthenticated `/admin` ever returns 1, the
deployment is misconfigured — treat it as exposed and fix the variables before
sharing the link.

---

## 13. Checklist

- [ ] Atlas M0 cluster, allowlist `0.0.0.0/0`, app user (not admin), SRV string
- [ ] `MONGODB_URI`, `MONGODB_DB`, `AWS_REGION`, `BEDROCK_MODEL_ID`, the two AWS keys
- [ ] Instance type **Standard**, `numInstances` **1**, health check
      **`/api/health/live`**
- [ ] No `NODE_ENV` anywhere in the service's environment
- [ ] `WIREUP_ADMIN_EMAIL` / `_PASSWORD` set, or accepted as closed
- [ ] `WIREUP_VELXIO_URL` = the separately hosted emulator, https, embed-patched,
      framing permitted, and accepting Wireup's origin
- [ ] `curl $BASE/api/health` → 200, `mongo.ok`, catalog count > 0, Bedrock state as intended
- [ ] One end-to-end project run from the UI, then a canvas pull
- [ ] `WIREUP_ENABLE_BEHAVIOUR_RUNTIME` left unset (no native execution on a
      public host) or set `true` knowingly, with the tradeoff in §12 accepted
- [ ] Bedrock IAM key scoped to `bedrock:InvokeModel*` on the model ARN in use
- [ ] §12's adversarial curl block run against the live URL (unauthenticated
      `/api/projects` → 401/503; unauthenticated `/admin` → login card, not the console)
- [ ] Custom domain + forced HTTPS if the preview URL is going in a deck
