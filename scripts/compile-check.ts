/**
 * Firmware compilation harness.
 *
 * The generator's output has never been compiled by the pipeline itself, so
 * "the sketch looks plausible" was the only quality bar. This script closes
 * that gap offline: it runs representative prompts through the deterministic
 * pipeline and type-checks every generated sketch with the host C++ compiler
 * against the stub core in `scripts/firmware-shim/`.
 *
 * The stub is not the real Arduino core — it has no hardware behind it — but it
 * has the same declarations, so a sketch that type-checks here has no missing
 * prototypes, no redefined constants, no undeclared identifiers and no wrong
 * argument types. Those are exactly the failures the reported safe build had.
 *
 * Usage: npx tsx scripts/compile-check.ts [--case <name>] [--keep]
 */
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspect } from 'node:util';

/* Run offline: force Bedrock lookups to fail fast so the deterministic path is used. */
const realLookup = dns.lookup as unknown as (...args: unknown[]) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = (hostname: string, ...rest: unknown[]): unknown => {
  const callback = rest[rest.length - 1];
  if (typeof callback === 'function' && String(hostname).endsWith('amazonaws.com')) {
    const error = new Error(`getaddrinfo EAI_AGAIN ${hostname}`) as NodeJS.ErrnoException;
    error.code = 'EAI_AGAIN';
    return (callback as (err: Error) => void)(error);
  }
  return realLookup(hostname, ...rest);
};

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=800';
process.env.BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'moonshotai.kimi-k2.5';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'eu-north-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'AKIACOMPILECHECK0';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'not-a-real-secret';
process.env.BEDROCK_MAX_RETRIES = '1';

/* The deterministic path logs one Bedrock DNS failure per case; that noise
 * buries the actual compiler output, so drop only those lines. */
const NOISE = /amazonaws\.com|EAI_AGAIN|Bedrock|MONGODB_URI|ECONNREFUSED|serverSelectionTimeoutMS/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNoise = (args: any[]): boolean => NOISE.test(inspect(args));
/*
 * The offline path logs one Bedrock DNS failure per stage on every channel
 * (`console.log`, `warn` and `error` are all used by src/lib/logging). Filtering
 * only console.error left most of it in the output, where it buried the compiler
 * diagnostics this script exists to show.
 */
for (const channel of ['log', 'warn', 'error', 'debug'] as const) {
  const original = console[channel].bind(console);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console[channel] = (...args: any[]): void => {
    if (isNoise(args)) return;
    original(...args);
  };
}

import { AgentEventLog } from '@/lib/logging/events';
import { nowIso } from '@/lib/validation/time';
import type { ProjectState } from '@/types/project';
import { runPipeline } from '@/modules/orchestrator/pipeline';

interface Case {
  name: string;
  prompt: string;
}

const CASES: Case[] = [
  {
    name: 'safe-keypad-servo',
    prompt: `Build an electronic safe on an Arduino Nano. A 4x4 matrix keypad enters a PIN,
a micro servo drives the bolt, a green LED and a red LED show access granted and denied,
an active buzzer sounds an alarm after three wrong attempts, and a 0.96" I2C OLED shows the
state. The PIN must survive a power cycle. Use a 4 digit PIN, servo 0 degrees locked and 90
degrees unlocked, and a pushbutton as the door switch that re-locks when the door closes.`,
  },
  {
    name: 'safe-relay-buttons',
    prompt: `Arduino Uno keypad door lock: four pushbuttons enter a 4 digit code, a relay module
drives an electric strike, a passive buzzer beeps on each key press and alarms on three failed
attempts, a green LED and a red LED show granted and denied, and a 1602 I2C LCD shows the prompt.
Remember the code after a reset.`,
  },
  {
    name: 'safe-keypad-servo-6pin',
    prompt: `Arduino Nano electronic safe with a 6 digit PIN, a 4x4 matrix keypad, a micro servo
bolt, a green LED and a red LED. Remember the PIN after a power cycle.`,
  },
  {
    name: 'led-button-counter',
    prompt: `Arduino Nano with two pushbuttons and one LED: press the first button to increase a
counter shown on the serial monitor, press the second to reset it, and blink the LED once per press.`,
  },
  {
    name: 'dht-oled-monitor',
    prompt: `Arduino Uno weather monitor: DHT22 temperature and humidity sensor read every 2 seconds,
values shown on a 0.96" SSD1306 I2C OLED, alarm LED lights above 30 degrees Celsius.`,
  },
  {
    name: 'servo-sweep-nano',
    prompt: `Arduino Nano servo sweep: an SG90 moves from 0 to 180 degrees and back continuously,
a pushbutton pauses the sweep, and the current angle is printed on the serial monitor.
Make the movement smooth.`,
  },
  {
    name: 'ultrasonic-alarm',
    prompt: `Arduino Uno proximity alarm: HC-SR04 ultrasonic sensor measures distance, a passive
buzzer beeps faster as an object gets closer, and an LED lights below 20 cm.`,
  },
  {
    name: 'neopixel-esp32',
    prompt: `ESP32 devkit with an 8 pixel WS2812B NeoPixel strip: cycle through rainbow colours,
a pushbutton changes the pattern, and report the active pattern over the serial link.`,
  },
  {
    name: 'stepper-driver',
    prompt: `Arduino Uno with a 28BYJ-48 stepper on its ULN2003 driver board: rotate 500 steps
clockwise when a pushbutton is pressed, 500 steps counter-clockwise when the second is pressed,
and show the position on the serial monitor.`,
  },
];

const SHIM_DIR = path.join(process.cwd(), 'scripts', 'firmware-shim');

function initialProject(id: string, prompt: string): ProjectState {
  const now = nowIso();
  return {
    id,
    name: 'Untitled project',
    prompt,
    status: 'pending',
    stage: 'idle',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    requirements: null,
    components: [],
    hardwarePlan: null,
    pinAssignments: [],
    wiring: null,
    softwarePlan: null,
    artifacts: { code: null, diagram: null, libraries: null, instructions: null },
    validation: null,
    revisions: [],
    events: [],
    iteration: { current: 0, max: 3 },
    llm: { calls: [] },
    revision: 0,
  };
}

function findCompiler(): string | null {
  for (const candidate of ['g++', 'clang++']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

interface SourceCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Static checks that do not need a compiler. */
function sourceChecks(sketch: string, prompt: string): SourceCheck[] {
  const checks: SourceCheck[] = [];

  const constants = [...sketch.matchAll(/^\s*(?:const\s+\w+\s+|static\s+const\s+\w+\s+)([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*=/gm)].map(
    (match) => match[1],
  );
  const seen = new Map<string, number>();
  for (const name of constants) seen.set(name, (seen.get(name) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([name, count]) => `${name} x${count}`);
  checks.push({
    id: 'unique-constants',
    ok: duplicates.length === 0,
    detail: duplicates.length === 0 ? `${constants.length} constants` : `redefined: ${duplicates.join(', ')}`,
  });

  checks.push({
    id: 'setup-loop',
    ok: /^\s*void\s+setup\s*\(/m.test(sketch) && /^\s*void\s+loop\s*\(/m.test(sketch),
    detail: 'both entry points present',
  });

  const stray = [...sketch.matchAll(/\b(TODO|FIXME|XXX|placeholder)\b/gi)].map((match) => match[1]);
  checks.push({
    id: 'no-placeholders',
    ok: stray.length === 0,
    detail: stray.length === 0 ? 'clean' : `found: ${[...new Set(stray)].join(', ')}`,
  });

  const braces = sketch.split('').reduce((balance, character) => balance + (character === '{' ? 1 : character === '}' ? -1 : 0), 0);
  checks.push({ id: 'balanced-braces', ok: braces === 0, detail: `net ${braces}` });

  /*
   * Every constant in the managed pin map must be used by the firmware. A pin
   * that is assigned but never referenced means the wiring and the sketch
   * disagree about what the build does — the compiler cannot catch that.
   */
  const pinMap = /\/\/ >>> WIREUP PIN MAP >>>([\s\S]*?)\/\/ <<< WIREUP PIN MAP <<</.exec(sketch)?.[1] ?? '';
  const declared = [...pinMap.matchAll(/const\s+\w+\s+(PIN_\w+)\s*=/g)].map((match) => match[1]);
  const body = sketch.slice(pinMap.length === 0 ? 0 : (sketch.indexOf(pinMap) + pinMap.length));
  const unused = declared.filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
  checks.push({
    id: 'pin-map-usage',
    ok: unused.length === 0,
    detail: unused.length === 0 ? `${declared.length} pin constant(s), all used` : `declared but never used: ${unused.join(', ')}`,
  });

  /*
   * A PIN-lock build must never ship a factory default shorter than its own
   * minimum length: the default could then never be accepted, leaving the
   * device permanently locked. A compiler cannot see this.
   */
  const pinMin = /const\s+uint8_t\s+PIN_MIN_LENGTH\s*=\s*(\d+)\s*;/.exec(sketch)?.[1];
  const fallback = /const\s+char\s*\*\s*fallback\s*=\s*"(\d+)"/.exec(sketch)?.[1];
  if (pinMin !== undefined && fallback !== undefined) {
    const min = Number(pinMin);
    checks.push({
      id: 'default-pin-length',
      ok: fallback.length >= min,
      detail:
        fallback.length >= min
          ? `default PIN (${fallback.length} digit(s)) covers PIN_MIN_LENGTH ${min}`
          : `default PIN "${fallback}" is shorter than PIN_MIN_LENGTH ${min} — the device would be permanently locked`,
    });
  }

  /*
   * "Press one button to count, another to reset" is the canonical counter
   * brief; the reset button must zero the count, not increment it.
   */
  if (/\b(reset|clear|zero)\b/i.test(prompt) && /\bpressCount\s*\+\+\s*;/.test(sketch)) {
    checks.push({
      id: 'counter-reset',
      ok: /\bpressCount\s*=\s*0\s*;/.test(sketch),
      detail: /\bpressCount\s*=\s*0\s*;/.test(sketch)
        ? 'the reset button zeroes the count'
        : 'the brief asks for a reset but every button only increments',
    });
  }

  return checks;
}

interface Result {
  name: string;
  files: string;
  checks: SourceCheck[];
  compiled: 'pass' | 'fail' | 'skipped';
  errors: string[];
  controller: string;
  behaviour: string;
}

async function main() {
  const only = (() => {
    const index = process.argv.indexOf('--case');
    return index >= 0 ? process.argv[index + 1] : undefined;
  })();
  const keep = process.argv.includes('--keep');
  const compiler = findCompiler();
  const outDir = keep ? path.join(os.tmpdir(), 'wireup-compile-check') : fs.mkdtempSync(path.join(os.tmpdir(), 'wireup-cc-'));
  fs.mkdirSync(outDir, { recursive: true });

  if (!compiler) {
    console.log('No g++ or clang++ on PATH — static checks only, compilation skipped.');
  }

  const cases = only ? CASES.filter((entry) => entry.name === only) : CASES;
  if (cases.length === 0) {
    console.error(`Unknown case "${only}". Known cases: ${CASES.map((entry) => entry.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const results: Result[] = [];
  for (const entry of cases) {
    process.stdout.write(`\n--- ${entry.name} ---\n`);
    const events = new AgentEventLog({ initialSeq: 0 });
    let result: Result;
    try {
      const pipeline = await runPipeline({ project: initialProject(entry.name, entry.prompt), events });
      const project = pipeline.project;
      const code = project.artifacts.code;
      const sketch = code?.files.find((file) => file.path === code.entryPoint)?.content ?? '';
      if (sketch.length === 0) {
        results.push({
          name: entry.name,
          files: 'none',
          checks: [{ id: 'sketch-present', ok: false, detail: 'no sketch was generated' }],
          compiled: 'skipped',
          errors: [],
          controller: project.hardwarePlan?.controller?.componentId ?? '?',
          behaviour: '?',
        });
        continue;
      }

      const file = path.join(outDir, `${entry.name}.ino`);
      fs.writeFileSync(file, sketch);

      let compiled: Result['compiled'] = 'skipped';
      const errors: string[] = [];
      if (compiler) {
        try {
          execFileSync(compiler, ['-std=gnu++17', '-fsyntax-only', '-x', 'c++', `-I${SHIM_DIR}`, file], { encoding: 'utf8', stdio: 'pipe' });
          compiled = 'pass';
        } catch (error) {
          compiled = 'fail';
          const raw = `${(error as { stderr?: string }).stderr ?? ''}`;
          errors.push(
            ...raw
              .split('\n')
              .filter((line) => /error:/.test(line))
              .slice(0, 12)
              .map((line) => line.replace(`${file}:`, '')),
          );
        }
      }

      const behaviour = /access-control behaviour/.test(sketch)
        ? 'access-control'
        : /counting|counter/i.test(sketch)
          ? 'button-counter'
          : 'generic';

      result = {
        name: entry.name,
        files: (code?.files ?? []).map((candidate) => `${candidate.path}(${candidate.content.length}b)`).join(' '),
        checks: sourceChecks(sketch, entry.prompt),
        compiled,
        errors,
        controller: project.hardwarePlan?.controller?.componentId ?? '?',
        behaviour,
      };
    } catch (error) {
      result = {
        name: entry.name,
        files: 'pipeline failed',
        checks: [{ id: 'pipeline', ok: false, detail: (error as Error).message.slice(0, 200) }],
        compiled: 'skipped',
        errors: [],
        controller: '?',
        behaviour: '?',
      };
    }

    results.push(result);
    console.log(`  controller: ${result.controller}   behaviour: ${result.behaviour}   compile: ${result.compiled}`);
    console.log(`  files: ${result.files}`);
    for (const check of result.checks) console.log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}`);
    for (const line of result.errors) console.log(`       ${line.trim()}`);
  }

  const failed = results.filter((result) => result.compiled === 'fail' || result.checks.some((check) => !check.ok));
  console.log(`\n=== ${results.length - failed.length}/${results.length} sketches clean ===`);
  if (keep) console.log(`  sources kept in ${outDir}`);
  else fs.rmSync(outDir, { recursive: true, force: true });
  if (failed.length > 0) {
    console.log(`  failing: ${failed.map((result) => result.name).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
