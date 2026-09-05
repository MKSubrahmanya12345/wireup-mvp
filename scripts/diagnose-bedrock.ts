/**
 * Bedrock connectivity doctor.
 *
 *   pnpm diagnose:bedrock
 *
 * Walks the path a real call takes — env → DNS → TCP/TLS → authenticated
 * Bedrock `Converse` — and stops at the first thing that fails, so "the model
 * is broken" and "this machine cannot resolve the endpoint" never look the same
 * again. Reads `.env` / `.env.local` like the app does. Nothing is written.
 *
 * Exits 0 when a real Bedrock round trip succeeds, 1 otherwise.
 */

import dns from 'node:dns';
import tls from 'node:tls';

import { loadDotEnv } from '@/lib/validation/dotenv';
import { env, resetEnvCache, EnvError } from '@/lib/validation/env';
import { describeError } from '@/lib/logging/logger';
import { applyDnsResultOrder } from '@/lib/net/dns';
import { converse, BedrockError } from '@/lib/bedrock/client';

const TIMEOUT_MS = 10_000;

function mask(value: string | undefined): string {
  if (!value) return '(unset)';
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

function credentialSource(): string {
  const sources = [
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? 'static AWS_ACCESS_KEY_ID/SECRET' : null,
    process.env.AWS_PROFILE ? `AWS_PROFILE=${process.env.AWS_PROFILE}` : null,
    process.env.AWS_ROLE_ARN ? `AWS_ROLE_ARN=${process.env.AWS_ROLE_ARN}` : null,
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? 'ECS container credentials' : null,
    process.env.AWS_EC2_METADATA_DISABLED ? 'IMDS disabled' : null,
  ].filter((entry): entry is string => Boolean(entry));
  return sources.length > 0 ? sources.join(', ') : 'none — the SDK default chain will be tried (and will fail)';
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function lookupAll(host: string, family: 4 | 6): Promise<string[]> {
  const addresses = await dns.promises.lookup(host, { all: true, family });
  return addresses.map((address) => address.address);
}

function checkTls(host: string, port: number): Promise<{ ok: true; protocol: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: TIMEOUT_MS }, () => {
      const protocol = socket.getProtocol() ?? 'unknown';
      socket.destroy();
      resolve({ ok: true, protocol });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, error: `no TLS handshake within ${TIMEOUT_MS}ms` });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve({ ok: false, error: `${error.code ?? error.name}: ${error.message}` });
    });
  });
}

async function main(): Promise<number> {
  const loaded = loadDotEnv(process.cwd());
  resetEnvCache();
  const configuration = env().bedrock;
  const dnsOrder = applyDnsResultOrder(env().net.dnsResultOrder);
  const host = `bedrock-runtime.${configuration.region}.amazonaws.com`;

  console.log('wireup · bedrock doctor');
  console.log(`env files: ${loaded.length > 0 ? loaded.join(', ') : '(none — using the process environment)'}`);

  /* --- 1. Configuration ---------------------------------------------------- */
  console.log('\n1. configuration');
  console.log(`   region            ${configuration.region}`);
  console.log(`   model             ${configuration.modelId ?? '(BEDROCK_MODEL_ID is unset)'}`);
  console.log(`   validation model  ${configuration.validationModelId ?? '(falls back to BEDROCK_MODEL_ID)'}`);
  console.log(`   fixer model       ${configuration.fixerModelId ?? '(falls back to BEDROCK_MODEL_ID)'}`);
  console.log(`   credentials       ${credentialSource()} — secret ${mask(configuration.secretAccessKey)}`);
  console.log(`   max retries       ${configuration.maxRetries}   timeout ${configuration.timeoutMs}ms`);
  console.log(`   dns result order  ${dnsOrder}${dnsOrder === 'ipv4first' ? ' (IPv4 preferred — works around resolvers that fail AAAA lookups)' : ''}`);

  if (!configuration.modelId) {
    console.error('\n✕ BEDROCK_MODEL_ID is not set. Copy .env.example to .env and set it.');
    return 1;
  }

  /* --- 2. DNS -------------------------------------------------------------- */
  console.log(`\n2. DNS — ${host}`);
  try {
    const v4 = await withTimeout(lookupAll(host, 4), TIMEOUT_MS, 'IPv4 lookup');
    let v6Error: string | null = null;
    const v6 = await withTimeout(lookupAll(host, 6), TIMEOUT_MS, 'IPv6 lookup').catch((error: unknown) => {
      v6Error = (error as NodeJS.ErrnoException).code ?? describeError(error).message;
      return [] as string[];
    });
    const resolved = [...v4, ...v6];
    console.log(
      `   ✓ resolved ${resolved.length} address(es): ${resolved.slice(0, 4).join(', ')}${resolved.length > 4 ? ', …' : ''}`,
    );
    if (v6Error) {
      console.log(
        `   · IPv6 (AAAA) lookup failed (${v6Error}) — harmless here because the result order is \`${dnsOrder}\`.`,
      );
      console.log('     Keep WIREUP_DNS_RESULT_ORDER=ipv4first on this host, or the failure comes back as EAI_AGAIN.');
    }
  } catch (error) {
    const described = describeError(error);
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    console.error(`   ✕ lookup failed (${code}): ${described.message}`);
    console.error('\nThis is the failure in your logs: the request never left this machine, so');
    console.error('credentials, model id and permissions were never evaluated. Do this:');
    console.error('   • retry — EAI_AGAIN is often a transient resolver failure and clears by itself');
    console.error('   • set WIREUP_DNS_RESULT_ORDER=ipv4first in .env if only the IPv6 (AAAA) half fails');
    console.error(`   • node -e "require('dns').lookup('${host}',console.log)"`);
    console.error(`   • dig ${host} +tries=1 +time=3   (compare with your browser)`);
    console.error('   • cat /etc/resolv.conf           (Docker? use --dns 1.1.1.1)');
    console.error('   • disable VPN / proxy / AV DNS filtering and retry');
    return 1;
  }

  /* --- 3. TCP + TLS -------------------------------------------------------- */
  console.log(`\n3. TLS — ${host}:443`);
  const handshake = await checkTls(host, 443);
  if (!handshake.ok) {
    console.error(`   ✕ ${handshake.error}`);
    console.error('\nDNS works but the TLS connection does not. Do this:');
    console.error('   • check outbound 443 (corporate firewall / egress proxy)');
    console.error('   • if you need a proxy, set HTTPS_PROXY — the AWS SDK honours it');
    console.error('   • check the system clock: a skewed clock breaks SigV4 and TLS alike');
    return 1;
  }
  console.log(`   ✓ handshake ok (${handshake.protocol})`);

  /* --- 4. A real Bedrock call --------------------------------------------- */
  console.log('\n4. Bedrock Converse — a real round trip');
  const startedAt = Date.now();
  try {
    const result = await converse({
      op: 'generation',
      userText: 'Reply with exactly {"ok": true} and nothing else.',
      maxTokens: 32,
      temperature: 0,
      timeoutMs: Math.min(configuration.timeoutMs, 30_000),
    });
    console.log(`   ✓ ${result.model} answered in ${result.durationMs}ms (attempts: ${result.attempts})`);
    console.log(
      `     stopReason ${result.stopReason ?? 'n/a'} · tokens ${result.usage.inputTokens ?? 0}→${result.usage.outputTokens ?? 0}`,
    );
    console.log(`     reply: ${result.text.slice(0, 160)}`);
    if (/^!+$/.test(result.text.trim())) {
      console.error('\n⚠ the model returned only "!" padding — a known Bedrock-side Kimi regression.');
      console.error('  Nothing is wrong with Wireup; retry later or point BEDROCK_MODEL_ID at another model.');
      return 1;
    }
    console.log(`\n✓ Bedrock is reachable and answering (total ${Date.now() - startedAt}ms). Generation will use the model.`);
    return 0;
  } catch (error) {
    const described = describeError(error);
    if (error instanceof BedrockError) {
      console.error(`   ✕ ${error.code} (retryable: ${error.retryable}) — ${error.message}`);
    } else if (error instanceof EnvError) {
      console.error(`   ✕ not configured: ${error.message}`);
    } else {
      console.error(`   ✕ ${described.name ?? 'Error'}: ${described.message}`);
    }
    console.error('\nDNS and TLS both succeeded, so this is an AWS-side or configuration problem. Do this:');
    console.error('   • AccessDeniedException      → enable model access in the Bedrock console for this region/account');
    console.error('   • ResourceNotFoundException  → the model id is wrong for this region; check the model card');
    console.error('   • ValidationException        → the request was rejected; check BEDROCK_MAX_TOKENS and the model id');
    console.error('   • UnrecognizedClientException / SignatureDoesNotMatch → the credentials are wrong or expired');
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 0).unref();
  })
  .catch((error: unknown) => {
    const described = describeError(error);
    console.error(`unexpected failure: ${described.message}`);
    if (described.stack) console.error(described.stack);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0).unref();
  });
