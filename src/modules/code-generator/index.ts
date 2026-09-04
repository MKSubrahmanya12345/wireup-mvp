/**
 * Code generator.
 *
 * The model writes the firmware, but the pin map, the include list and the pin
 * constants are re-derived here from the authoritative pin plan. That way the
 * sketch can never disagree with the wiring graph or `diagram.json`, and a pin
 * fix later only needs to re-run this synchronisation step.
 *
 * If the model returns no usable code, a complete sketch is generated from the
 * structured project instead — the artifact always exists.
 */

import type { ComponentDefinition, ComponentSelection, LibraryRequirement } from '@/types/component';
import type { CodeArtifact, GeneratedCodeFile, ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';
import type { I2CBus, SerialLink } from '@/modules/pin-planner';
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

export interface CodeGeneratorInput {
  projectName: string;
  projectSummary: string;
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  assignments: PinAssignment[];
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
 * Re-point every pin constant in the source at the value from the pin plan.
 * Handles both the generated constant names and model-invented names that can
 * be matched unambiguously to an assignment.
 */
export function syncPinConstants(
  content: string,
  assignments: PinAssignment[],
): { content: string; synced: { name: string; from: string; to: string }[]; unresolved: string[] } {
  const synced: { name: string; from: string; to: string }[] = [];
  const unresolved: string[] = [];

  const blockStart = content.indexOf(PIN_MAP_START);
  const blockEnd = content.indexOf(PIN_MAP_END);
  const protectedRanges: [number, number][] = blockStart >= 0 && blockEnd > blockStart ? [[blockStart, blockEnd + PIN_MAP_END.length]] : [];

  const inProtectedRange = (index: number) => protectedRanges.some(([start, end]) => index >= start && index <= end);

  const expected = new Map<string, string>();
  for (const assignment of assignments) expected.set(constantName(assignment), pinLiteral(assignment));

  const byNormalised = new Map<string, string>();
  for (const [name, literal] of expected) byNormalised.set(normalizeConstantName(name), literal);

  // const int NAME = VALUE;  |  const uint8_t NAME = VALUE;  |  #define NAME VALUE
  const definitionPattern = /(?:const\s+(?:unsigned\s+)?(?:int|uint8_t|uint16_t|int8_t|byte)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);|#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_"]+))/g;

  let result = content;
  let match: RegExpExecArray | null;
  const replacements: { start: number; end: number; text: string }[] = [];

  while ((match = definitionPattern.exec(content)) !== null) {
    if (inProtectedRange(match.index)) continue;
    const name = match[1] ?? match[3] ?? '';
    const value = (match[2] ?? match[4] ?? '').trim();
    if (!name) continue;

    let literal = byNormalised.get(normalizeConstantName(name));

    if (literal === undefined) {
      // Fuzzy match: unique assignment whose target pin name appears in the constant name.
      const upper = normalizeConstantName(name);
      const candidates = assignments.filter((assignment) => {
        const pinToken = normalizeConstantName(assignment.targetPin);
        const instanceToken = normalizeConstantName(assignment.targetInstanceId);
        return pinToken.length > 0 && (upper.includes(pinToken) || upper.endsWith(`_${pinToken}`) || upper.includes(instanceToken));
      });
      const uniqueLiterals = new Set(candidates.map((candidate) => pinLiteral(candidate)));
      if (candidates.length > 0 && uniqueLiterals.size === 1) literal = [...uniqueLiterals][0];
      else if (candidates.length > 1) unresolved.push(name);
    }

    if (literal === undefined) continue;
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

  return { content: result, synced, unresolved: [...new Set(unresolved)] };
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
  const handle = input.events?.start('code_generation_started', 'Generating firmware...', {
    stage: 'code',
    metadata: { assignments: input.assignments.length },
  });

  const notes: string[] = [];
  const sketchContext: SketchContext = {
    projectName: input.projectName,
    projectSummary: input.projectSummary,
    requirements: input.requirements,
    selections: input.selections,
    catalog: input.catalog,
    assignments: input.assignments,
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
  let generatedFromTemplate = false;

  if (!entryCandidate) {
    entryContent = generateSketch(sketchContext);
    generatedFromTemplate = true;
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
      notes.push('Model-authored firmware was used as the base and synchronised with the pin plan.');
    }
  }

  // Deterministic synchronisation passes.
  const withIncludes = ensureIncludesBlock(entryContent, input.softwarePlan.libraries, platformIsEsp32);
  const includeResult = ensureLibraryIncludes(withIncludes, input.softwarePlan.libraries, platformIsEsp32);
  if (includeResult.added.length > 0) {
    notes.push(`Added missing include(s): ${includeResult.added.join(', ')}.`);
  }

  const withPinMap = ensurePinMap(includeResult.content, input.assignments, input.profile);
  const syncResult = syncPinConstants(withPinMap, input.assignments);
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

  const files: GeneratedCodeFile[] = [
    {
      path: 'sketch.ino',
      language: 'arduino',
      content: syncResult.content,
      purpose: generatedFromTemplate
        ? 'Complete firmware generated from the pin plan, wiring graph and software plan.'
        : 'Complete firmware for the project (model authored, pin-synchronised by Wireup).',
      generatedBy: generatedFromTemplate ? 'planner' : 'model',
    },
  ];

  for (const file of modelFiles) {
    if (file === entryCandidate) continue;
    files.push({
      path: file.path,
      language: file.language || languageForPath(file.path),
      content: file.content,
      purpose: file.purpose,
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
    { files: files.length, lines: files[0]?.content.split('\n').length ?? 0, generatedFromTemplate, syncedConstants: syncResult.synced.length },
  );

  return artifact;
}
