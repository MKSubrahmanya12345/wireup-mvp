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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspect } from 'node:util';

import { applyOfflineEnv, initialProject, installOfflineDns } from './lib/offline';

/* Run offline: force Bedrock lookups to fail fast so the deterministic path is used. */
installOfflineDns();
applyOfflineEnv({ accessKeyId: 'AKIACOMPILECHECK0' });

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
import type { ProjectState } from '@/types/project';
import { runPipeline } from '@/modules/orchestrator/pipeline';

interface Case {
  name: string;
  prompt: string;
  /**
   * Case-specific assertions that run after generation and need no compiler.
   * They exist to pin the DEGRADED paths (no EEPROM, no display, remapped bus)
   * — the generic source checks cannot tell a deliberate degradation from a bug.
   */
  extraChecks?: (input: { project: ProjectState; sketch: string }) => SourceCheck[];
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
  {
    name: 'esp32-oled-i2c',
    prompt: `ESP32 devkit room monitor: a DHT22 temperature and humidity sensor read every 2 seconds,
values shown on a 0.96" SSD1306 I2C OLED display, and a warning line on the display above 30 degrees
Celsius.`,
    extraChecks: ({ sketch }) => [
      {
        id: 'i2c-remappable-wire-begin',
        ok: /Wire\.begin\(\s*PIN_\w+,\s*PIN_\w+\s*\)/.test(sketch),
        detail:
          'ESP32 core routes I2C to any GPIO, so setup() must start the bus with the planned SDA/SCL pins (Wire.begin(sda, scl)), not the no-argument AVR form',
      },
    ],
  },
  {
    /*
     * No display may be mentioned, not even as "no display" — the feature
     * matcher is keyword-based and a negation still selects the OLED. Feedback
     * is LEDs + buzzer only, so the lock UI must degrade to the serial link.
     */
    name: 'relay-lock-keypad',
    prompt: `Arduino Nano gate controller: a 4x4 matrix keypad accepts a 4 digit PIN, a relay module
releases an electric strike when the PIN is right, a green LED and a red LED show success and
failure, and an active buzzer sounds after three wrong tries. Feedback is by LEDs and the buzzer
only. The PIN must survive a power cycle.`,
    extraChecks: ({ sketch }) => [
      {
        id: 'access-control-without-display',
        ok: /access-control behaviour/.test(sketch) && !/#include\s*<(Adafruit_SSD1306|LiquidCrystal_I2C)\.h>/.test(sketch),
        detail: 'a lock state machine with no display must still be generated, with no display library pulled in',
      },
      {
        id: 'persistence-planned',
        ok: /#include\s*<EEPROM\.h>/.test(sketch),
        detail: 'the brief asks the PIN to survive a power cycle, so EEPROM must be in the library manifest and included',
      },
    ],
  },
  {
    /*
     * Deliberately avoids every persistence word (store/persist/remember/survive)
     * AND every credential word the planner matches (pin/password/code/access/
     * safe/lock) — needsPersistentStorage() must stay false so the EEPROM library
     * is never planned, and the firmware must degrade to a compiled-in PIN and
     * SAY SO in its header notes (invariant 8: report, never fake).
     */
    name: 'safe-no-eeprom',
    prompt: `Arduino Nano combination gate: a 4x4 matrix keypad accepts a 4 digit combination,
an SG90 micro servo moves the bolt, a green LED and a red LED show success and failure, an active
buzzer beeps on a wrong try, and a 0.96" I2C OLED shows the prompt. Make the servo movement smooth.`,
    extraChecks: ({ sketch }) => [
      {
        id: 'access-control-detected',
        ok: /access-control behaviour/.test(sketch),
        detail: 'servo + keypad must dispatch to the lock state machine even without persistence',
      },
      {
        id: 'no-eeprom-include',
        ok: !/#include\s*<EEPROM\.h>/.test(sketch),
        detail: 'the managed include block is authoritative: without EEPROM in the library manifest the include must be pruned',
      },
      {
        id: 'degradation-reported',
        ok: /compiled in/.test(sketch),
        detail: 'the sketch header must warn that the PIN is compiled in and a reset restores the default',
      },
    ],
  },
  {
    name: 'l298n-two-motor',
    prompt: `Arduino Uno robot car: two DC gear motors driven by an L298N dual H-bridge board,
powered by a 2S LiPo battery. One pushbutton drives both motors forward, a second pushbutton drives
them in reverse, and the direction is printed on the serial monitor.`,
    extraChecks: ({ project }) => [
      {
        id: 'driver-and-supply-selected',
        ok: project.components.some((selection) => selection.componentId === 'l298n-motor-driver') &&
          project.components.some((selection) => selection.category === 'power'),
        detail: `BOM: ${project.components.map((selection) => selection.componentId).join(', ')}`,
      },
    ],
  },
  {
    /*
     * Exercises the line-follower behaviour: two reflectance sensors + a
     * two-channel L298N must produce a real follow controller (steer toward
     * the sensor that sees the line), with the motors stopped at boot and a
     * reported lost-line stop — not the generic skeleton that wires the parts
     * and then never reads the sensors.
     */
    name: 'line-follower-l298n',
    prompt: `Arduino Nano line follower robot: two line sensors read the black line on the floor,
two DC gear motors on an L298N driver drive the wheels, and a pushbutton starts and stops the run.
Both sensors on the line drive straight; when a sensor leaves the line, steer back toward the line.
An LED shows the robot is running. Follow at a fixed speed.`,
    extraChecks: ({ sketch }) => [
      {
        id: 'follow-logic-present',
        ok: /DriveCommand decideCommand/.test(sketch) && /STATE_LINE_LOST/.test(sketch),
        detail: 'the sketch must contain the steer-toward-the-line controller and a reported lost-line stop',
      },
      {
        id: 'motors-safe-at-boot',
        ok: /void setup\(\)\s*\{[\s\S]*?allMotorsStop\(\);/.test(sketch),
        detail: 'setup() must stop the motors before anything else so a reset never lurches the robot',
      },
    ],
  },
];

const SHIM_DIR = path.join(process.cwd(), 'scripts', 'firmware-shim');

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
function sourceChecks(sketch: string): SourceCheck[] {
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
        : /line-follower behaviour/.test(sketch)
          ? 'line-follower'
          : /counting|counter/i.test(sketch)
            ? 'button-counter'
            : 'generic';

      result = {
        name: entry.name,
        files: (code?.files ?? []).map((candidate) => `${candidate.path}(${candidate.content.length}b)`).join(' '),
        checks: [...sourceChecks(sketch), ...(entry.extraChecks?.({ project, sketch }) ?? [])],
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
