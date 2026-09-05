/**
 * Firmware pin audit — the mechanical half of "the pin map is the single
 * source of truth".
 *
 * The pin planner owns pin selection. Firmware — whether written by the model
 * or patched by the fixer — is *untrusted input*: this module statically
 * checks every GPIO call site against the resolved pin map and, where the
 * literal is merely a raw spelling of a mapped pin (`digitalWrite(7, …)`),
 * rewrites it to the canonical `PIN_*` constant so the shipped sketch can only
 * ever reference pins through the map.
 *
 * Three findings:
 *   rewrites  — raw literal that resolves to exactly one map pin; replaced by
 *               the map's constant (`7` → `PIN_LED_5MM_1_A`);
 *   violations — pin references the map does not contain (the model "chose a
 *               pin again"): unknown bare literals and `PIN_*` constants that
 *               are not in the map;
 *   ambiguous  — literals that could be several mapped pins; left untouched and
 *               reported so a human (or the validator) sees the uncertainty.
 */

import type { ResolvedPinBinding, ResolvedPinMap } from '@/modules/pin-planner/resolved-map';
import { lookupPinLiteral } from '@/modules/pin-planner/resolved-map';

/* ------------------------------------------------------------------------- */
/* Masking                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Replace comments and string/char literal bodies with spaces, preserving
 * length and newlines, so byte offsets and line numbers stay valid against the
 * original source and regex matches never land inside prose or format strings.
 */
export function maskCommentsAndStrings(source: string): string {
  const chars = source.split('');
  let i = 0;
  while (i < chars.length) {
    const char = chars[i] as string;
    const next = chars[i + 1];

    if (char === '/' && next === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n') chars[i] = ' ';
        i += 1;
      }
      if (i < chars.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      while (i < chars.length) {
        if (chars[i] === '\\') {
          chars[i] = ' ';
          if (chars[i + 1] !== '\n' && i + 1 < chars.length) chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (chars[i] === quote) {
          i += 1;
          break;
        }
        if (chars[i] !== '\n') chars[i] = ' ';
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/* ------------------------------------------------------------------------- */
/* GPIO call sites                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Functions whose argument list carries MCU pin numbers, with the index of
 * every pin argument. Anything not listed here is not a pin decision point —
 * `Serial.begin(115200)` baud rates, `setCursor(0, 1)` columns, I2C addresses
 * and delay durations must never be touched.
 */
const PIN_ARG_POSITIONS: Record<string, number[]> = {
  pinmode: [0],
  digitalwrite: [0],
  digitalread: [0],
  analogwrite: [0],
  analogread: [0],
  tone: [0],
  notone: [0],
  pulsein: [0],
  pulseinlong: [0],
  shiftout: [0, 1],
  shiftin: [0, 1],
  attachinterrupt: [0],
  detachinterrupt: [0],
  // ESP32 LEDC PWM binding (Arduino core 2.x and 3.x spellings).
  ledcattach: [0],
  ledcattachpin: [0],
  // Constructors that take pins.
  softwareserial: [0, 1], // (rx, tx)
  dht: [0],
  onewire: [0],
  newping: [0, 1], // (trigger, echo)
  stepper: [1, 2, 3, 4], // (steps, p1..p4)
  liquidcrystal: [0, 1, 2, 3, 4, 5], // (rs, enable, d4..d7)
};

/** `servo.attach(pin)` — method form, keyed by method name. */
const PIN_METHOD_POSITIONS: Record<string, number[]> = {
  attach: [0], // Servo
};

/** Identifiers that are legitimate firmware vocabulary, not map violations. */
const SAFE_IDENTIFIERS = new Set([
  'LED_BUILTIN',
  'INPUT',
  'OUTPUT',
  'INPUT_PULLUP',
  'INPUT_PULLDOWN',
  'HIGH',
  'LOW',
  'CHANGE',
  'RISING',
  'FALLING',
]);

interface CallSite {
  api: string;
  /** Arguments split at top level; indexes into the *masked* source. */
  args: { start: number; end: number; text: string }[];
}

/** Find every `name(...)` call with its top-level arguments. */
function findCallSites(masked: string): CallSite[] {
  const sites: CallSite[] = [];
  const names = new Set([...Object.keys(PIN_ARG_POSITIONS), ...Object.keys(PIN_METHOD_POSITIONS)]);
  const callPattern = /(\.)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(masked)) !== null) {
    const name = (match[2] ?? '').toLowerCase();
    const isMethod = match[1] === '.';
    if (!names.has(name)) continue;
    if (isMethod && !(name in PIN_METHOD_POSITIONS)) continue;
    if (!isMethod && !(name in PIN_ARG_POSITIONS)) continue;

    const openParen = match.index + match[0].length - 1;
    const args: CallSite['args'] = [];
    let depth = 0;
    let argStart = openParen + 1;
    let closed = -1;
    for (let i = openParen; i < masked.length; i += 1) {
      const char = masked[i];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          closed = i;
          break;
        }
      } else if (char === ',' && depth === 1) {
        args.push({ start: argStart, end: i, text: masked.slice(argStart, i) });
        argStart = i + 1;
      }
    }
    if (closed === -1) continue; /* unbalanced — brace checks report this separately */
    const tailText = masked.slice(argStart, closed);
    if (tailText.trim().length > 0 || args.length > 0) args.push({ start: argStart, end: closed, text: tailText });

    sites.push({ api: name, args });
    callPattern.lastIndex = closed + 1;
  }
  return sites;
}

/** The pin token of one argument, unwrapping `digitalPinToInterrupt(PIN)`. */
function pinTokenOfArg(arg: { start: number; end: number; text: string }): { token: string; start: number; end: number } | undefined {
  const text = arg.text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const leading = text.length - text.trimStart().length;

  const inner = /^digitalPinToInterrupt\s*\(\s*([^()]+?)\s*\)$/i.exec(trimmed);
  const innerText = inner?.[1]?.trim();
  if (inner && innerText) {
    const start = arg.start + leading + inner[0].indexOf(innerText);
    return { token: innerText, start, end: start + innerText.length };
  }
  return { token: trimmed, start: arg.start + leading, end: arg.start + leading + trimmed.length };
}

/* ------------------------------------------------------------------------- */
/* Audit                                                                     */
/* ------------------------------------------------------------------------- */

export interface PinRewrite {
  api: string;
  token: string;
  constant: string;
  line: number;
}

export interface FirmwarePinViolation {
  kind: 'unknown_pin_literal' | 'unknown_pin_constant' | 'bus_pin_driven';
  severity: 'error';
  api: string;
  token: string;
  line: number;
  message: string;
}

export interface AmbiguousPinLiteral {
  api: string;
  token: string;
  line: number;
  candidates: string[];
}

export interface FirmwarePinAudit {
  content: string;
  rewrites: PinRewrite[];
  violations: FirmwarePinViolation[];
  ambiguous: AmbiguousPinLiteral[];
}

function isAnalogApi(api: string): boolean {
  return api === 'analogread' || api === 'analogwrite';
}

function pickBinding(candidates: ResolvedPinBinding[]): ResolvedPinBinding | undefined {
  if (candidates.length === 0) return undefined;
  const byCValue = new Map(candidates.map((binding) => [binding.cValue, binding]));
  if (byCValue.size > 1) return undefined; // genuinely ambiguous
  // Shared-bus rows share one MCU pin; any of their constants names the pin.
  return candidates.find((binding) => !binding.busShared) ?? candidates[0];
}

export interface FirmwareAuditOptions {
  /**
   * raw literal (uppercase) → canonical PIN_* constant, learned from the
   * constants the model itself declared (`const int LED_PIN = 3;` records
   * that the model meant "the LED" whenever it wrote `3`). Consulted after
   * the map lookup misses, so `digitalWrite(3, LOW)` is corrected to the
   * LED's real constant instead of being condemned as unassigned.
   */
  legacyLiterals?: ReadonlyMap<string, string>;
}

/**
 * Canonicalise a sketch against the resolved pin map and report every pin
 * reference that cannot be traced back to it.
 *
 * The returned `content` has every provably-mapped raw literal replaced by the
 * map's constant. Violations are *not* silently edited: they are reported so
 * the caller can decide (the generator rejects the file; the validator raises
 * `code_pin_mismatch`).
 */
export function auditFirmwareAgainstPinMap(content: string, map: ResolvedPinMap, options: FirmwareAuditOptions = {}): FirmwarePinAudit {
  const masked = maskCommentsAndStrings(content);
  const rewrites: PinRewrite[] = [];
  const violations: FirmwarePinViolation[] = [];
  const ambiguous: AmbiguousPinLiteral[] = [];

  /** Edits applied to the ORIGINAL source: [start, end, replacement]. */
  const edits: { start: number; end: number; replacement: string }[] = [];

  /*
   * Local constant declarations (name → declared value). Needed so an
   * identifier used at a GPIO call site can be traced: `const byte BTN = 2;`
   * followed by `digitalRead(BTN)` is a pin decision even though no map
   * constant is named anywhere.
   */
  const declaredConstants = new Map<string, string>();
  const declarationPattern =
    /(?:(?:static\s+|constexpr\s+|const\s+|volatile\s+)*(?:unsigned\s+)?(?:int|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|byte|pin_size_t)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);|#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_"]+))/g;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = declarationPattern.exec(masked)) !== null) {
    const name = declarationMatch[1] ?? declarationMatch[3];
    const value = (declarationMatch[2] ?? declarationMatch[4] ?? '').trim();
    if (name && value) declaredConstants.set(name, value);
  }

  const positionsFor = (site: CallSite): number[] =>
    site.api in PIN_METHOD_POSITIONS ? (PIN_METHOD_POSITIONS[site.api] ?? []) : (PIN_ARG_POSITIONS[site.api] ?? []);

  /** GPIO-drive APIs that must never target a shared bus pin (I2C/SPI). */
  const drivesGpio = (api: string) =>
    ['pinmode', 'digitalwrite', 'digitalread', 'analogwrite', 'tone', 'notone', 'ledcattach', 'ledcattachpin', 'attachinterrupt', 'detachinterrupt'].includes(api);

  for (const site of findCallSites(masked)) {
    for (const position of positionsFor(site)) {
      const arg = site.args[position];
      if (!arg) continue;
      const pin = pinTokenOfArg(arg);
      if (!pin) continue;
      const token = pin.token;

      // Already canonical: a constant straight from the map.
      if (token in map.byConstant) {
        const binding = map.bindings.find((candidate) => candidate.constant === token);
        if (binding?.busShared && drivesGpio(site.api)) {
          violations.push({
            kind: 'bus_pin_driven',
            severity: 'error',
            api: site.api,
            token,
            line: lineNumberAt(content, pin.start),
            message: `${site.api}() drives ${token}, which is the shared ${binding.protocol.toUpperCase()} bus pin ${binding.mcuPin} (${binding.key}) — bus pins are owned by their hardware library (Wire.begin()/SPI.begin()), never by pinMode/digitalWrite.`,
          });
        }
        continue;
      }
      if (SAFE_IDENTIFIERS.has(token)) continue;

      // A PIN_* name that is NOT in the map is a fabricated pin contract.
      if (/^PIN_[A-Z0-9_]+$/i.test(token)) {
        violations.push({
          kind: 'unknown_pin_constant',
          severity: 'error',
          api: site.api,
          token,
          line: lineNumberAt(content, pin.start),
          message: `${site.api}() references ${token}, which is not one of the resolved pin map's constants — the firmware must not invent pin names.`,
        });
        continue;
      }

      // Raw literal (`2`, `A4`, `D4`, `25`): must map back to the plan.
      if (/^\d{1,2}$/.test(token) || /^[AD]\d{1,2}$/i.test(token) || /^GPIO\d{1,2}$/i.test(token)) {
        const candidates = lookupPinLiteral(map, token, { analogContext: isAnalogApi(site.api) });
        const binding = pickBinding(candidates);
        if (binding) {
          if (binding.busShared && drivesGpio(site.api)) {
            violations.push({
              kind: 'bus_pin_driven',
              severity: 'error',
              api: site.api,
              token,
              line: lineNumberAt(content, pin.start),
              message: `${site.api}() drives ${binding.mcuPin} (${binding.key}), which is a shared ${binding.protocol.toUpperCase()} bus pin — bus pins are owned by their hardware library (Wire.begin()/SPI.begin()), never by pinMode/digitalWrite.`,
            });
          } else if (token !== binding.constant) {
            edits.push({ start: pin.start, end: pin.end, replacement: binding.constant });
            rewrites.push({ api: site.api, token, constant: binding.constant, line: lineNumberAt(content, pin.start) });
          }
          continue;
        }

        /*
         * The map does not know this literal — but the model may have spelled
         * one of its own re-pointed constants by value (`digitalWrite(3, …)`
         * where `LED_PIN` was 3 before the sync moved it to the plan's pin).
         * The legacy table translates that intent to the real constant, so a
         * wrong pin choice is corrected instead of either shipping or
         * nuking an otherwise good sketch.
         */
        const legacy = options.legacyLiterals?.get(token.trim().toUpperCase());
        if (legacy && legacy in map.byConstant) {
          edits.push({ start: pin.start, end: pin.end, replacement: legacy });
          rewrites.push({ api: site.api, token, constant: legacy, line: lineNumberAt(content, pin.start) });
          continue;
        }

        if (candidates.length > 0) {
          ambiguous.push({
            api: site.api,
            token,
            line: lineNumberAt(content, pin.start),
            candidates: [...new Set(candidates.map((entry) => entry.constant))],
          });
        } else if (/^\d{1,2}$/.test(token) || /^A\d{1,2}$/i.test(token)) {
          // A bare number/Ax that nothing — map or the model's own
          // declarations — claims: the firmware genuinely chose a new pin.
          violations.push({
            kind: 'unknown_pin_literal',
            severity: 'error',
            api: site.api,
            token,
            line: lineNumberAt(content, pin.start),
            message: `${site.api}() is called with raw pin ${token}, which the resolved pin map never assigns — every firmware pin must come from the pin plan.`,
          });
        }
        // D<n>/GPIO<n> spellings on this platform are only pin-like when they
        // resolve; otherwise they are most likely not pins at all (e.g. an id).
        continue;
      }

      /*
       * A locally-declared identifier used as a pin (`digitalRead(BTN)` where
       * `const byte BTN = 2;`): the declaration is the pin decision. If its
       * value matches no pin in the map (directly or through the legacy
       * table), the firmware picked a pin that was never assigned — flag it.
       * A correct value (`BTN = 4` when the button is on D4) is a consistent
       * hand alias and passes.
       */
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
        const declared = declaredConstants.get(token);
        if (declared !== undefined && /^(?:\d{1,2}|A\d{1,2}|D\d{1,2}|GPIO\d{1,2})$/i.test(declared)) {
          const resolves =
            lookupPinLiteral(map, declared, { analogContext: isAnalogApi(site.api) }).length > 0 ||
            (options.legacyLiterals?.has(declared.toUpperCase()) ?? false);
          if (!resolves) {
            violations.push({
              kind: 'unknown_pin_constant',
              severity: 'error',
              api: site.api,
              token,
              line: lineNumberAt(content, pin.start),
              message: `${site.api}() uses ${token}, declared as ${token} = ${declared} — pin ${declared} is not in the resolved pin map, so this firmware does not match the wired circuit.`,
            });
          }
          continue;
        }

        /*
         * A pin-shaped identifier nothing declares (`digitalWrite(ledPin, …)`
         * with no `ledPin` definition in this file): we cannot prove it wrong
         * — it might be a function parameter — so it is reported as ambiguous
         * rather than blocking. (Function parameters with real values are
         * materially rare in firmware written against this architecture; the
         * codebase's own templates never produce them.)
         */
        if (/(?:^pin|pin$|gpio|sda|scl|mosi|miso|sck|trig|echo)/i.test(token)) {
          ambiguous.push({
            api: site.api,
            token,
            line: lineNumberAt(content, pin.start),
            candidates: [],
          });
        }
        continue;
      }

      // Member expressions (motor.in1) and computed values carry no static
      // pin decision — outside this audit's jurisdiction.
    }
  }

  // PIN_* references *anywhere* (not just call sites) must exist in the map.
  const referencePattern = /\b(PIN_[A-Z0-9_]+)\b/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = referencePattern.exec(masked)) !== null) {
    const name = refMatch[1] ?? '';
    if (name in map.byConstant) continue;
    if (violations.some((violation) => violation.kind === 'unknown_pin_constant' && violation.token === name)) continue;
    violations.push({
      kind: 'unknown_pin_constant',
      severity: 'error',
      api: '(reference)',
      token: name,
      line: lineNumberAt(content, refMatch.index),
      message: `${name} is not declared by the resolved pin map — the firmware may only reference pin constants the pin planner produced.`,
    });
  }

  let result = content;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    if (!edit) continue;
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }

  /*
   * A wrong DECLARATION (`const byte BTN_LED = 9;`) is one root cause even
   * when three call sites use the name — report it once, with the line of
   * the first offending use.
   */
  const seenViolations = new Set<string>();
  const distinctViolations = violations.filter((violation) => {
    const key = `${violation.kind}:${violation.token}`;
    if (violation.kind === 'unknown_pin_literal') return true; // each literal use is its own fact
    if (seenViolations.has(key)) return false;
    seenViolations.add(key);
    return true;
  });

  return { content: result, rewrites, violations: distinctViolations, ambiguous };
}

/** Error-severity findings only — the gate the code generator applies. */
export function pinAuditErrors(audit: FirmwarePinAudit): FirmwarePinViolation[] {
  return audit.violations;
}
