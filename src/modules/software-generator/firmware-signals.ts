/**
 * What the generated firmware actually says over its control link.
 *
 * The dashboard contract and the static cross-check both need to know which
 * telemetry keys the sketch prints and which command characters its parser
 * accepts. Deriving that twice — once as a heuristic in `contract.ts`, once as
 * a string search in `validate.ts` — is how the two drifted: the contract
 * advertised a `speed` card for a keypad safe that has no speed, and the
 * validator looked for `case 'X':` labels while the sketches parse with
 * `if (command == 'X')`, so every command was reported unhandled.
 *
 * Reading the emitted source once, here, keeps the dashboard, the README and
 * the findings in agreement with the firmware by construction.
 */

import type { GeneratedCodeFile } from '@/types/project';

type FirmwareSource = Pick<GeneratedCodeFile, 'path' | 'content'>;

function combined(firmware: FirmwareSource[]): string {
  return firmware.map((file) => file.content).join('\n');
}

/** The body of `sendTelemetry(...)`, when the sketch has one. */
function telemetryBody(source: string): string | null {
  const start = /void\s+sendTelemetry\s*\([^)]*\)\s*\{/.exec(source);
  if (!start) return null;
  let index = (start.index ?? 0) + start[0].length - 1;
  let depth = 0;
  for (; index < source.length; index++) {
    const character = source[index];
    if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (depth === 0) return source.slice(start.index ?? 0, index + 1);
    }
  }
  return null;
}

/**
 * Telemetry keys the firmware prints, in the order it prints them.
 *
 * Keys appear as `\"field\":` inside a `print()` call (the generator escapes
 * them because they live in a C string). Returns null when there is no firmware
 * to read, which callers treat as "unknown" rather than "none".
 */
export function telemetryFields(firmware: FirmwareSource[]): string[] | null {
  const source = combined(firmware);
  if (source.trim().length === 0) return null;

  const scope = telemetryBody(source) ?? source;
  const fields: string[] = [];
  for (const match of scope.matchAll(/\\?"([A-Za-z_][A-Za-z0-9_]*)\\?"\s*:/g)) {
    const field = match[1];
    if (field && !fields.includes(field)) fields.push(field);
  }
  return fields;
}

/**
 * Command characters the firmware's parser accepts.
 *
 * Both idioms the generators use are recognised: a `switch` with `case 'x':`
 * labels and an `if` chain comparing the byte read from the link. Whitespace
 * characters the parser explicitly ignores are not commands.
 */
export function commandCharacters(firmware: FirmwareSource[]): string[] | null {
  const source = combined(firmware);
  if (source.trim().length === 0) return null;

  const characters: string[] = [];
  const add = (character: string | undefined): void => {
    if (!character || character.length !== 1) return;
    if (character === '\\' || /[nrt0]/.test(character)) return;
    const existing = characters.find((entry) => entry.toLowerCase() === character.toLowerCase());
    if (existing) {
      // `command == 'L' || command == 'l'` is one command: keep the upper case.
      if (character === character.toUpperCase() && existing !== character) {
        characters[characters.indexOf(existing)] = character;
      }
      return;
    }
    characters.push(character);
  };

  for (const match of source.matchAll(/case\s+'((?:[^'\\]|\\.)+)'\s*:/g)) add(match[1]);
  for (const match of source.matchAll(/(?:command|incoming|character|byte|c)\s*==\s*'((?:[^'\\]|\\.)+)'/g)) add(match[1]);

  return characters;
}

/** Does the firmware open the control link at all? */
export function opensControlLink(firmware: FirmwareSource[]): boolean {
  return /(?:Serial|Serial1|Serial2|controlLink|BluetoothSerial|bluetooth|link)\s*\.\s*begin\s*\(/i.test(combined(firmware));
}
