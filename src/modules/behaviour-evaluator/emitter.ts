/**
 * Compiles a generated Arduino sketch against the instrumented host core
 * (scripts/firmware-shim-runtime) and runs it, returning the observed trace.
 *
 * The deterministic templates are plain C++ under the hood, so `g++` can
 * execute them directly; no real device is required. Model-authored sketches
 * that rely on unstubbed APIs simply fail to compile, which the evaluator
 * reports as `runtimeError` and falls back to static checks.
 */

import { execFileSync } from 'node:child_process';

import { env } from '@/lib/validation/env';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CodeArtifact } from '@/types/project';
import type { FirmwareTrace, TracePinEvent, TraceSerialLine, TraceServoEvent } from '@/types/behavioral';

export interface RunScenarioStep {
  atMs: number;
  kind: 'serial' | 'pin';
  byte?: string;
  pin?: number;
  level?: 0 | 1;
}

export interface RunFirmwareOptions {
  code: CodeArtifact;
  /** Scripted inputs played against the running sketch. */
  steps?: RunScenarioStep[];
  /** Virtual milliseconds to simulate. */
  simulateMs?: number;
}

export interface RunFirmwareResult {
  trace: FirmwareTrace;
  /** Why the emulator could not run (compiler missing, sketch non-C++, …). */
  error?: string;
}

const SHIM_DIR = resolve(process.cwd(), 'scripts', 'firmware-shim-runtime');

/**
 * Backstop for the executed sketch, well above the simulated budget the shim
 * self-limits by. A child that wedges outside `loop()` would otherwise be
 * waited on forever by a synchronous call on the request path.
 */
const RUN_HARD_TIMEOUT_MS = 30_000;

/** Headers that are materialised next to the sketch (so `#include "config.h"` resolves). */
const HEADER_EXT = /\.(h|hpp)$/;
/** Source files that are compiled to object code. */
const COMPILE_EXT = /\.(c|cc|cpp)$/;
/** Any C/C++ flavour the harness understands. */
const CPP_EXT = /\.(ino|h|hpp|c|cc|cpp)$/;

export function compileAndRunFirmware(input: RunFirmwareOptions): RunFirmwareResult {
  const emptyTrace: FirmwareTrace = {
    drivenPins: [],
    pinEvents: [],
    servoEvents: [],
    serialLines: [],
    simulatedMs: 0,
    loopIterations: 0,
  };

  // Compiling and *running* generated firmware is a capability, not a formality:
  // whatever the sketch does happens as this user, on this filesystem, with
  // this network position. Off by default in production (see
  // `WIREUP_ENABLE_BEHAVIOUR_RUNTIME`), and reported through the same honest
  // skip path a missing compiler uses — the report says "not run", never
  // "passed".
  if (!env().agent.enableBehaviourRuntime) {
    return {
      trace: emptyTrace,
      error:
        'the behaviour harness is disabled on this deployment (WIREUP_ENABLE_BEHAVIOUR_RUNTIME=false); ' +
        'runtime assertions are reported as skipped rather than executed',
    };
  }

  const { code } = input;
  if (!code || code.files.length === 0) {
    return { trace: emptyTrace, error: 'no firmware artifact' };
  }

  const entry = code.files.find((file) => file.path === code.entryPoint) ?? code.files.find((file) => file.path.endsWith('.ino'));
  if (!entry) return { trace: emptyTrace, error: 'no sketch.ino in the firmware artifact' };

  // The deterministic templates are C++; model sketches may be C++ too, but a
  // non-C++ sketch (Micropython, CircuitPython) cannot run in this harness.
  if (!CPP_EXT.test(entry.path)) {
    return { trace: emptyTrace, error: `entry sketch ${entry.path} is not a C++ sketch` };
  }

  const workDir = join(tmpdir(), `wireup-sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(workDir, { recursive: true });

  try {
    // 1. Materialise every header and C++ sibling next to the entry sketch.
    const compileSources: string[] = [];
    for (const file of code.files) {
      if (!CPP_EXT.test(file.path)) continue;
      if (!file.content || file.content.trim().length === 0) continue;
      const flat = file.path.split('/').pop() as string;
      const target = join(workDir, flat);
      writeFileSync(target, file.content, 'utf8');
      if (COMPILE_EXT.test(flat) && file.path !== entry.path) compileSources.push(target);
    }

    // 2. The Arduino toolchain prepends `#include "Arduino.h"` to the .ino;
    //    reproduce that so the core's String/Serial/pin types are in scope.
    const entryFlat = join(workDir, (entry.path.split('/').pop() as string).replace(/\.ino$/, '.ino.cpp'));
    const entrySource = readFileSync(join(workDir, entry.path.split('/').pop() as string), 'utf8');
    writeFileSync(entryFlat, `#include "Arduino.h"\n${entrySource}`, 'utf8');
    compileSources.unshift(entryFlat);

    // 3. Scripted inputs.
    let scenarioPath = '';
    if (input.steps && input.steps.length > 0) {
      scenarioPath = join(workDir, 'scenario.txt');
      const lines = input.steps.map((step) => {
        if (step.kind === 'pin') return `PIN ${step.atMs} ${step.pin ?? -1} ${step.level ? 1 : 0}`;
        return `SERIAL ${step.atMs} ${step.byte ?? ''}`;
      });
      writeFileSync(scenarioPath, lines.join('\n'), 'utf8');
    }
    const tracePath = join(workDir, 'trace.txt');

    // 4. Compile against the instrumented core.
    const objectFiles: string[] = [];
    for (const source of compileSources) {
      const obj = `${source}.o`;
      objectFiles.push(obj);
      execFileSync('g++', [
        '-std=gnu++17',
        '-w',
        '-fpermissive',
        '-I', workDir,
        '-I', SHIM_DIR,
        '-c', source,
        '-o', obj,
      ], { maxBuffer: 8 * 1024 * 1024 });
    }
    const binary = join(workDir, 'sketch.bin');
    execFileSync('g++', ['-std=gnu++17', '-w', '-fpermissive', '-I', workDir, '-I', SHIM_DIR, ...objectFiles, `${SHIM_DIR}/core.cpp`, '-o', binary], { maxBuffer: 8 * 1024 * 1024 });

    // 5. Execute and read the trace.
    //
    // The subject is a binary compiled from *generated* source, on a machine
    // whose environment holds the deployment's credentials. So the child gets
    // an explicit environment instead of `process.env`: inheriting it hands the
    // sketch `MONGODB_URI`, the AWS keys and the admin password for free, and
    // reading them back out of `environ` is a two-line `main()`. `cwd` is
    // confined to the scratch directory for the same reason — a relative path
    // should resolve against the harness, not against the checkout.
    //
    // This is containment by omission, not a sandbox: same user, same
    // filesystem, same /proc. Which is exactly why the step is off by default
    // in production — see `WIREUP_ENABLE_BEHAVIOUR_RUNTIME` and the note in
    // docs/deploy-render.md.
    // `NodeJS.ProcessEnv` declares `NODE_ENV` as required (Next's own type
    // augmentation narrows it to three literals), so the child is *told* which
    // mode it runs in rather than having the field cast away. Nothing else from
    // the parent environment crosses this boundary.
    const mode = process.env.NODE_ENV;
    const childEnv: NodeJS.ProcessEnv = {
      NODE_ENV: mode === 'production' || mode === 'test' ? mode : 'development',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      WIREUP_SCENARIO: scenarioPath,
      WIREUP_TRACE_OUT: tracePath,
      WIREUP_SIM_MS: String(input.simulateMs ?? 6000),
    };

    execFileSync(binary, [], {
      cwd: workDir,
      env: childEnv,
      // The shim self-limits through WIREUP_SIM_MS; this is the backstop for a
      // sketch that wedges outside `loop()` (a blocking static initialiser, a
      // syscall that never returns), so an unkillable child can never pin an
      // event-loop thread for the life of the process.
      timeout: RUN_HARD_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });

    const trace = parseTrace(readFileSync(tracePath, 'utf8'));
    return { trace };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { trace: emptyTrace, error: `firmware could not be compiled or run: ${message.split('\n')[0]}` };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Plain-text trace emitted by core.cpp → FirmwareTrace. */
function parseTrace(raw: string): FirmwareTrace {
  const trace: FirmwareTrace = {
    drivenPins: [],
    pinEvents: [],
    servoEvents: [],
    serialLines: [],
    simulatedMs: 0,
    loopIterations: 0,
  };

  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 0) continue;
    switch (parts[0]) {
      case 'serial': {
        const atMs = Number(parts[1]);
        const text = parts.slice(2).join(' ');
        trace.serialLines.push({ text, atMs });
        break;
      }
      case 'pin': {
        const pin = Number(parts[1]);
        const level = Number(parts[2]) as 0 | 1;
        const atMs = Number(parts[3]);
        trace.pinEvents.push({ pin, level, atMs });
        break;
      }
      case 'servo': {
        const pin = Number(parts[1]);
        const angle = Number(parts[2]);
        const atMs = Number(parts[3]);
        trace.servoEvents.push({ pin, angle, atMs });
        break;
      }
      case 'driven':
        trace.drivenPins.push(Number(parts[1]));
        break;
      case 'sim':
        trace.simulatedMs = Number(parts[1]);
        trace.loopIterations = Number(parts[2]);
        break;
      default:
        break;
    }
  }

  trace.drivenPins = [...new Set(trace.drivenPins)].sort((a, b) => a - b);
  return trace;
}

// Re-export trace types for convenience (documentation references).
export type { FirmwareTrace, TracePinEvent, TraceSerialLine, TraceServoEvent };

