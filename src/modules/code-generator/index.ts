/**
 * Code generator.
 *
 * Data flow (single source of truth — see pin-planner/resolved-map.ts):
 *
 *     pin planner → ResolvedPinMap → THIS generator
 *
 * The firmware-authoring model receives the resolved pin map and is forbidden
 * from choosing pins. Its output is still treated as untrusted: the machine-
 * managed pin-map/include blocks are re-derived from the map, hand-written pin
 * constants are re-pointed at the map, raw pin literals at GPIO call sites are
 * rewritten to the map's `PIN_*` constants, and a final static audit rejects
 * any sketch that still references a pin the map does not contain. A rejected
 * model sketch is replaced by the deterministic template — the artifact always
 * exists and always agrees with `diagram.json`, because both are projections
 * of the same ResolvedPinMap.
 */

import type { ComponentDefinition, ComponentSelection, LibraryRequirement } from '@/types/component';
import type { CodeArtifact, GeneratedCodeFile, ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';
import type { I2CBus, SerialLink } from '@/modules/pin-planner';
import type { ResolvedPinMap } from '@/modules/pin-planner/resolved-map';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import {
  INCLUDES_END,
  INCLUDES_START,
  PIN_MAP_END,
  PIN_MAP_START,
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  generateSketch,
  includeStatement,
  pinLiteral,
  type SketchContext,
} from './templates';
import { applyFirmwareHygiene } from './hygiene';
import { auditFirmwareAgainstPinMap, pinAuditErrors, type FirmwarePinAudit } from './pin-audit';

export interface CodeGeneratorInput {
  projectName: string;
  projectSummary: string;
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  /** The authoritative pin map — the single source of truth for every GPIO. */
  pinMap: ResolvedPinMap;
  serialLinks: SerialLink[];
  i2cBuses: I2CBus[];
  softwarePlan: SoftwarePlan;
  controllerName: string;
  profile?: McuProfile;
  revision: number;
  modelCode?: unknown;
  events?: AgentEventLog;
}

interface ModelFile {
  path: string;
  language: string;
  content: string;
  purpose: string;
}

function languageForPath(path: string): string {
  if (path.endsWith('.ino')) return 'arduino';
  if (path.endsWith('.h') || path.endsWith('.hpp')) return 'c-header';
  if (path.endsWith('.c')) return 'c';
  if (path.endsWith('.cpp') || path.endsWith('.cc')) return 'cpp';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  return 'text';
}

function parseModelFiles(raw: unknown): ModelFile[] {
  const candidates: unknown[] = [];
  if (Array.isArray(raw)) candidates.push(...raw);
  else if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.files)) candidates.push(...record.files);
    else candidates.push(record);
  }

  const files: ModelFile[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : typeof record.code === 'string' ? record.code : '';
    if (content.trim().length === 0) continue;
    const path = String(record.path ?? record.filename ?? record.file ?? 'sketch.ino').trim().replace(/^\/+/, '');
    files.push({
      path: path || 'sketch.ino',
      language: typeof record.language === 'string' ? record.language : languageForPath(path),
      content,
      purpose: String(record.purpose ?? record.description ?? 'Generated firmware source'),
    });
  }
  return files;
}

/** Remove comments and string/char literals so brace counting is meaningful. */
function stripForAnalysis(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

export function braceBalance(source: string): number {
  const stripped = stripForAnalysis(source);
  let balance = 0;
  for (const char of stripped) {
    if (char === '{') balance += 1;
    if (char === '}') balance -= 1;
  }
  return balance;
}

interface CodeQualityReport {
  usable: boolean;
  reasons: string[];
}

export function assessCodeQuality(content: string): CodeQualityReport {
  const reasons: string[] = [];
  if (content.trim().length < 80) reasons.push('source is essentially empty');
  if (!/void\s+setup\s*\(/.test(content)) reasons.push('missing setup()');
  if (!/void\s+loop\s*\(/.test(content)) reasons.push('missing loop()');

  const balance = braceBalance(content);
  if (balance !== 0) reasons.push(`unbalanced braces (${balance > 0 ? `${balance} unclosed '{'` : `${-balance} extra '}'`})`);

  if (/\b(TODO|FIXME|placeholder|your code here|\.\.\.)\b/i.test(content)) reasons.push('contains placeholder/TODO markers');

  return { usable: reasons.length === 0, reasons };
}

export function replaceMarkerBlock(content: string, start: string, end: string, block: string): string | null {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  return `${content.slice(0, startIndex)}${block}${content.slice(endIndex + end.length)}`;
}

export function insertAfterIncludes(content: string, block: string): string {
  const includePattern = /^[ \t]*#\s*include\b.*$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = includePattern.exec(content)) !== null) lastMatch = match;

  if (lastMatch) {
    const insertAt = lastMatch.index + lastMatch[0].length;
    return `${content.slice(0, insertAt)}\n\n${block}${content.slice(insertAt)}`;
  }

  const headerEnd = content.indexOf('*/');
  if (headerEnd !== -1) {
    return `${content.slice(0, headerEnd + 2)}\n\n${block}\n${content.slice(headerEnd + 2)}`;
  }
  return `${block}\n\n${content}`;
}

/** Insert or replace the authoritative pin map block. */
export function ensurePinMap(content: string, assignments: PinAssignment[], profile?: McuProfile): string {
  const block = buildPinMapBlock(assignments, profile);
  const replaced = replaceMarkerBlock(content, PIN_MAP_START, PIN_MAP_END, block);
  if (replaced !== null) return replaced;
  return insertAfterIncludes(content, block);
}

/** Insert or replace the authoritative include block. */
export function ensureIncludesBlock(content: string, libraries: LibraryRequirement[], platformIsEsp32: boolean): string {
  const block = buildIncludesBlock(libraries, platformIsEsp32);
  const replaced = replaceMarkerBlock(content, INCLUDES_START, INCLUDES_END, block);
  if (replaced !== null) return replaced;

  // No marker block: append any missing includes after the existing ones.
  const missing: string[] = [];
  for (const library of libraries) {
    const statement = includeStatement(library);
    if (!statement) continue;
    if (/BluetoothSerial\.h|BLEDevice\.h|WiFi\.h/i.test(library.import) && !platformIsEsp32) continue;
    if (!content.includes(statement)) missing.push(statement);
  }
  if (missing.length === 0) return content;
  return insertAfterIncludes(content, missing.join('\n'));
}

function normalizeConstantName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Does `NAME = VALUE` plausibly declare an MCU pin? Pin constants carry a
 * pin-ish word (PIN, GPIO, SDA, SCL, …) and hold a pin literal (`7`, `A4`,
 * `D7`), never an address (`0x3C`), a size (`128`) or a rate (`9600`).
 */
function looksLikePinConstant(name: string, value: string): boolean {
  const upper = normalizeConstantName(name);
  const words = upper.split('_').filter(Boolean);
  const pinWords = new Set(['PIN', 'GPIO', 'IO', 'SDA', 'SCL', 'MOSI', 'MISO', 'SCK', 'CS', 'SS', 'TX', 'RX', 'TRIG', 'ECHO', 'DIN', 'DOUT', 'DATA', 'SIG', 'SIGNAL', 'IN1', 'IN2', 'IN3', 'IN4', 'ENA', 'ENB']);
  if (!words.some((word) => pinWords.has(word))) return false;
  if (/ADDR|ADDRESS|WIDTH|HEIGHT|BAUD|COUNT|SIZE|DELAY|TIMEOUT|INTERVAL|MS$|HZ$|RATE/i.test(upper)) return false;
  return /^(?:\d{1,2}|A\d{1,2}|D\d{1,2}|GPIO\d{1,2}|LED_BUILTIN)$/i.test(value.trim());
}

/** A generic role word models use for a peripheral (`LED_PIN`, `BUTTON_PIN`, `BUZZER_PIN`). */
function roleWordFor(assignment: PinAssignment): string | undefined {
  const id = assignment.targetInstanceId.toLowerCase();
  if (/oled|ssd1306|lcd/.test(id)) return 'OLED';
  if (/button|switch/.test(id)) return 'BUTTON';
  if (/rgb/.test(id)) return 'RGB';
  if (/(^|[^o])led/.test(id)) return 'LED';
  if (/buzzer/.test(id)) return 'BUZZER';
  if (/servo/.test(id)) return 'SERVO';
  if (/relay/.test(id)) return 'RELAY';
  if (/pir/.test(id)) return 'PIR';
  if (/dht/.test(id)) return 'DHT';
  if (/pot/.test(id)) return 'POT';
  if (/ldr|photo/.test(id)) return 'LDR';
  return undefined;
}

/**
 * Re-point every pin constant in the source at the value from the pin plan.
 * Handles both the generated constant names and model-invented names that can
 * be matched unambiguously to an assignment.
 *
 * Declaration forms covered: `const int X = …`, `int X = …` (non-const — the
 * exact shape of the "BUTTON_PIN = 2 next to an authoritative D4" bug),
 * `constexpr`/`static`/`volatile` qualifiers, `byte`/`uintN_t` typedefs and
 * `#define X …`. Aliases written in terms of a `PIN_*` constant from the map
 * (`const int BUTTON_PIN = PIN_PUSHBUTTON_6MM_1_1;`) are sanctioned — the
 * firmware prompt explicitly allows them — and are left alone.
 */
export function syncPinConstants(
  content: string,
  assignments: PinAssignment[] | ResolvedPinMap,
): {
  content: string;
  synced: { name: string; from: string; to: string }[];
  unresolved: string[];
  /**
   * raw literal (uppercase) → canonical PIN_* constant, for every constant the
   * model declared and we re-pointed. Lets the call-site audit treat a raw
   * `digitalWrite(3, …)` as "the pin the model thought the LED was on" and
   * rewrite it to the LED's real constant instead of flagging it untraceable.
   */
  legacyLiterals: Map<string, string>;
} {
  const rows: readonly PinAssignment[] = Array.isArray(assignments) ? assignments : assignments.assignments;
  const synced: { name: string; from: string; to: string }[] = [];
  const unresolved: string[] = [];
  const legacyLiterals = new Map<string, string>();

  const blockStart = content.indexOf(PIN_MAP_START);
  const blockEnd = content.indexOf(PIN_MAP_END);
  const protectedRanges: [number, number][] = blockStart >= 0 && blockEnd > blockStart ? [[blockStart, blockEnd + PIN_MAP_END.length]] : [];

  const inProtectedRange = (index: number) => protectedRanges.some(([start, end]) => index >= start && index <= end);

  const expected = new Map<string, string>();
  for (const assignment of rows) expected.set(constantName(assignment), pinLiteral(assignment));
  const canonicalFor = new Map<string, string>();
  for (const assignment of rows) canonicalFor.set(pinLiteral(assignment), constantName(assignment));

  const byNormalised = new Map<string, string>();
  const canonicalByNormalised = new Map<string, string>();
  for (const [name, literal] of expected) {
    byNormalised.set(normalizeConstantName(name), literal);
    canonicalByNormalised.set(normalizeConstantName(name), name);
  }

  /*
   * const/constexpr/static int NAME = VALUE;  |  int NAME = VALUE;  |
   * const uint8_t NAME = VALUE;  |  #define NAME VALUE
   */
  const definitionPattern =
    /(?:(?:static\s+|constexpr\s+|const\s+|volatile\s+)*(?:unsigned\s+)?(?:int|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|byte|pin_size_t)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);|#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_"]+))/g;

  let result = content;
  let match: RegExpExecArray | null;
  const replacements: { start: number; end: number; text: string }[] = [];

  while ((match = definitionPattern.exec(content)) !== null) {
    if (inProtectedRange(match.index)) continue;
    const name = match[1] ?? match[3] ?? '';
    const value = (match[2] ?? match[4] ?? '').trim();
    if (!name) continue;

    /*
     * A declaration in terms of the authoritative constants (`const int
     * BUTTON_PIN = PIN_PUSHBUTTON_6MM_1_1;`) is a sanctioned alias, not a
     * second pin decision — leave it untouched.
     */
    if (byNormalised.has(normalizeConstantName(value))) continue;

    let literal = byNormalised.get(normalizeConstantName(name));
    let constantForValue = canonicalByNormalised.get(normalizeConstantName(name));

    if (literal === undefined) {
      /*
       * Fuzzy match: a model-invented pin constant (BUTTON_PIN, LED_PIN,
       * PIN_OLED_SDA, …) that maps to exactly one assignment.
       *
       * Only constants that *look* like pin declarations qualify, and tokens
       * are compared as whole `_`-separated words — a substring test used to
       * turn `OLED_ADDRESS 0x3C` into `OLED_ADDRESS 4` because the LED's pin
       * is called `A`.
       */
      if (!looksLikePinConstant(name, value)) continue;
      const upper = normalizeConstantName(name);
      const words = new Set(upper.split('_').filter(Boolean));
      const hasWord = (token: string) => {
        const parts = token.split('_').filter(Boolean);
        return parts.length > 0 && parts.every((part) => words.has(part));
      };
      const candidates = rows.filter((assignment) => {
        const pinToken = normalizeConstantName(assignment.targetPin);
        const instanceToken = normalizeConstantName(assignment.targetInstanceId);
        const instanceStem = instanceToken.replace(/_\d+$/, '');
        const componentWords = instanceStem.split('_').filter((part) => part.length >= 3 && !/^\d+$/.test(part));
        const roleWord = roleWordFor(assignment);
        const mentionsComponent =
          hasWord(instanceToken) ||
          hasWord(instanceStem) ||
          componentWords.some((word) => words.has(word)) ||
          (roleWord !== undefined && words.has(roleWord));
        const mentionsPin = pinToken.length >= 2 && hasWord(pinToken);
        return mentionsComponent || mentionsPin;
      });
      // `OLED_SDA_PIN` matches both OLED assignments by component; the one
      // that also names the pin wins.
      const scored = candidates.map((assignment) => ({
        assignment,
        score: (normalizeConstantName(assignment.targetPin).length >= 2 && hasWord(normalizeConstantName(assignment.targetPin)) ? 1 : 0) as number,
      }));
      const best = Math.max(0, ...scored.map((entry) => entry.score));
      const narrowed = scored.filter((entry) => entry.score === best).map((entry) => entry.assignment);
      const uniqueLiterals = new Set(narrowed.map((candidate) => pinLiteral(candidate)));
      if (narrowed.length > 0 && uniqueLiterals.size === 1) {
        literal = [...uniqueLiterals][0];
        constantForValue = canonicalFor.get(literal);
      } else if (narrowed.length > 1) unresolved.push(name);
    }

    if (literal === undefined) continue;

    /*
     * Remember the model's OWN spelling of this pin (`BUTTON_PIN = 2` ⇒ `2`
     * used to mean the button) so the call-site audit can translate raw
     * literals that still carry the model's pre-correction meaning. If two
     * model constants claimed the same number, the literal is ambiguous and
     * poisoned — a bare `2` can no longer be trusted to mean either one.
     */
    if (constantForValue && value !== literal && /^(?:\d{1,2}|A\d{1,2}|D\d{1,2})$/i.test(value)) {
      const key = value.toUpperCase();
      const previous = legacyLiterals.get(key);
      if (previous === undefined) legacyLiterals.set(key, constantForValue);
      else if (previous !== constantForValue) legacyLiterals.set(key, '' /* poisoned */);
    }

    if (value === literal) continue;

    const isDefine = match[3] !== undefined;
    const text = isDefine ? `#define ${name} ${literal}` : `${match[0]?.split('=')[0]?.trim() ?? `const int ${name}`} = ${literal};`;
    replacements.push({ start: match.index, end: match.index + match[0].length, text });
    synced.push({ name, from: value, to: literal });
  }

  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const replacement = replacements[i];
    if (!replacement) continue;
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }

  for (const [key, value] of [...legacyLiterals.entries()]) {
    if (value === '') legacyLiterals.delete(key);
  }

  return { content: result, synced, unresolved: [...new Set(unresolved)], legacyLiterals };
}

/** Ensure the sketch declares every library the plan resolved. */
export function ensureLibraryIncludes(
  content: string,
  libraries: LibraryRequirement[],
  platformIsEsp32: boolean,
): { content: string; added: string[] } {
  const added: string[] = [];
  let output = content;

  for (const library of libraries) {
    const statement = includeStatement(library);
    if (!statement) continue;
    if (/BluetoothSerial\.h|BLEDevice\.h|WiFi\.h/i.test(library.import) && !platformIsEsp32) continue;
    if (output.includes(library.import)) continue;
    output = insertAfterIncludes(output, statement);
    added.push(library.import);
  }

  return { content: output, added };
}

/** Produce the code artifact. */
export function generateCode(input: CodeGeneratorInput): CodeArtifact {
  const assignments = [...input.pinMap.assignments];
  const handle = input.events?.start('code_generation_started', 'Generating firmware from the resolved pin map...', {
    stage: 'code',
    metadata: { assignments: assignments.length },
  });

  const notes: string[] = [];
  const sketchContext: SketchContext = {
    projectName: input.projectName,
    projectSummary: input.projectSummary,
    requirements: input.requirements,
    selections: input.selections,
    catalog: input.catalog,
    assignments,
    serialLinks: input.serialLinks,
    i2cBuses: input.i2cBuses,
    softwarePlan: input.softwarePlan,
    controllerName: input.controllerName,
    ...(input.profile ? { profile: input.profile } : {}),
    revision: input.revision,
  };

  const platformIsEsp32 = /esp32/i.test(input.controllerName);
  const modelFiles = parseModelFiles(input.modelCode);
  const entryCandidate =
    modelFiles.find((file) => file.path.toLowerCase() === 'sketch.ino') ??
    modelFiles.find((file) => file.path.toLowerCase().endsWith('.ino')) ??
    modelFiles[0];

  let entryContent = entryCandidate?.content ?? '';
  let generatedFromTemplate = entryCandidate === undefined;
  let pinAudit: FirmwarePinAudit = { content: '', rewrites: [], violations: [], ambiguous: [] };

  if (entryCandidate === undefined) {
    entryContent = generateSketch(sketchContext);
    notes.push('The model returned no source file; the firmware was generated deterministically from the pin plan and software plan.');
  } else {
    const quality = assessCodeQuality(entryContent);
    if (!quality.usable) {
      const balance = braceBalance(entryContent);
      if (balance > 0 && /void\s+setup\s*\(/.test(entryContent) && /void\s+loop\s*\(/.test(entryContent)) {
        entryContent = `${entryContent.trimEnd()}\n${'}'.repeat(balance)}\n`;
        notes.push(`Model source was missing ${balance} closing brace(s); they were appended.`);
        const reassessed = assessCodeQuality(entryContent);
        if (!reassessed.usable) {
          entryContent = generateSketch(sketchContext);
          generatedFromTemplate = true;
          notes.push(`Model source was unusable (${reassessed.reasons.join('; ')}) and was replaced by the deterministic sketch.`);
        }
      } else {
        entryContent = generateSketch(sketchContext);
        generatedFromTemplate = true;
        notes.push(`Model source was unusable (${quality.reasons.join('; ')}) and was replaced by the deterministic sketch.`);
      }
    } else {
      notes.push('Model-authored firmware was used as the base and synchronised with the resolved pin map.');
    }
  }

  // Deterministic synchronisation passes against the resolved pin map.
  const withIncludes = ensureIncludesBlock(entryContent, input.softwarePlan.libraries, platformIsEsp32);
  const includeResult = ensureLibraryIncludes(withIncludes, input.softwarePlan.libraries, platformIsEsp32);
  if (includeResult.added.length > 0) {
    notes.push(`Added missing include(s): ${includeResult.added.join(', ')}.`);
  }

  const withPinMap = ensurePinMap(includeResult.content, assignments, input.profile);
  const preSync = syncPinConstants(withPinMap, input.pinMap);
  const hygiene = applyFirmwareHygiene(preSync.content, {
    selections: input.selections,
    catalog: input.catalog,
    libraries: input.softwarePlan.libraries,
  });
  notes.push(...hygiene.notes);
  const syncResult = { ...preSync, content: hygiene.content };
  if (syncResult.synced.length > 0) {
    notes.push(
      `Re-synchronised ${syncResult.synced.length} pin constant(s) with the pin plan: ${syncResult.synced
        .map((entry) => `${entry.name} ${entry.from} → ${entry.to}`)
        .join(', ')}.`,
    );
  }
  if (syncResult.unresolved.length > 0) {
    notes.push(
      `Ambiguous pin constant name(s) left untouched (verify manually): ${syncResult.unresolved.join(', ')}.`,
    );
  }

  /*
   * Final gate: the firmware may only reference pins through the resolved pin
   * map. Raw literals that provably spell a mapped pin are rewritten to the
   * map's constant; a sketch that still references pins outside the map is
   * rejected wholesale — reconciliation by regex can never be allowed to
   * "almost work", because a wrong pin ships a broken circuit.
   */
  if (!generatedFromTemplate) {
    pinAudit = auditFirmwareAgainstPinMap(syncResult.content, input.pinMap, { legacyLiterals: syncResult.legacyLiterals });
    if (pinAudit.rewrites.length > 0) {
      notes.push(
        `Canonicalised ${pinAudit.rewrites.length} raw pin literal(s) to the pin map constants: ${pinAudit.rewrites
          .slice(0, 6)
          .map((entry) => `${entry.api}(${entry.token}) → ${entry.constant}`)
          .join(', ')}${pinAudit.rewrites.length > 6 ? ', …' : ''}.`,
      );
    }
    for (const entry of pinAudit.ambiguous) {
      notes.push(
        `Ambiguous raw pin literal ${entry.api}(${entry.token}) on line ${entry.line} could be ${entry.candidates.join(' or ')} — left as-is; verify manually.`,
      );
    }
    const errors = pinAuditErrors(pinAudit);
    if (errors.length > 0) {
      notes.push(
        `Model firmware referenced pin(s) outside the resolved pin map (${errors
          .slice(0, 4)
          .map((entry) => `${entry.api}(${entry.token}) line ${entry.line}`)
          .join('; ')}${errors.length > 4 ? ', …' : ''}) — the sketch was replaced by the deterministic template so firmware and diagram cannot disagree.`,
      );
      entryContent = generateSketch(sketchContext);
      generatedFromTemplate = true;
      const rebuiltSync = { content: entryContent, synced: [], unresolved: [] };
      return finishArtifact({ input, content: rebuiltSync.content, modelFiles, entryCandidate, generatedFromTemplate, notes, handle, pinAudit });
    }
  }

  return finishArtifact({
    input,
    content: generatedFromTemplate ? entryContent : pinAudit.content,
    modelFiles,
    entryCandidate,
    generatedFromTemplate,
    notes,
    handle,
    pinAudit,
  });
}

interface FinishArtifactInput {
  input: CodeGeneratorInput;
  content: string;
  modelFiles: ModelFile[];
  entryCandidate: ModelFile | undefined;
  generatedFromTemplate: boolean;
  notes: string[];
  handle: ReturnType<AgentEventLog['start']> | undefined;
  pinAudit: FirmwarePinAudit;
}

function finishArtifact(args: FinishArtifactInput): CodeArtifact {
  const { input, content, modelFiles, entryCandidate, generatedFromTemplate, notes, handle, pinAudit } = args;

  const files: GeneratedCodeFile[] = [
    {
      path: 'sketch.ino',
      language: 'arduino',
      content,
      purpose: generatedFromTemplate
        ? 'Complete firmware generated from the resolved pin map, wiring graph and software plan.'
        : 'Complete firmware for the project (model authored against the resolved pin map, canonicalised by Wireup).',
      generatedBy: generatedFromTemplate ? 'planner' : 'model',
    },
  ];

  for (const file of modelFiles) {
    if (file === entryCandidate) continue;
    // Non-entry files get the same treatment: re-inject nothing, but reject
    // pin references that contradict the pin map by auditing for violations.
    const audit = auditFirmwareAgainstPinMap(file.content, input.pinMap);
    files.push({
      path: file.path,
      language: file.language || languageForPath(file.path),
      content: audit.content,
      purpose:
        pinAuditErrors(audit).length > 0
          ? `${file.purpose} (WARNING: references pins outside the resolved pin map — flagged by validation)`
          : file.purpose,
      generatedBy: 'model',
    });
  }

  const artifact: CodeArtifact = {
    files,
    entryPoint: 'sketch.ino',
    pinsSynchronised: true,
    notes,
  };

  handle?.complete(
    `Firmware generated — ${files.length} file(s), ${files[0]?.content.split('\n').length ?? 0} lines in sketch.ino${generatedFromTemplate ? ' (deterministic template)' : ''}`,
    {
      files: files.length,
      lines: files[0]?.content.split('\n').length ?? 0,
      generatedFromTemplate,
      pinRewrites: pinAudit.rewrites.length,
      pinsRejected: pinAudit.violations.length,
    },
  );

  return artifact;
}

export {
  auditFirmwareAgainstPinMap,
  maskCommentsAndStrings,
  pinAuditErrors,
  type AmbiguousPinLiteral,
  type FirmwarePinAudit,
  type FirmwarePinViolation,
  type PinRewrite,
} from './pin-audit';
