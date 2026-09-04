'use client';

/**
 * Hand-rolled syntax highlighting.
 *
 * No third-party tokenizer: a small state machine per language family produces
 * `{ text, className }` tokens which are then split into lines so the gutter
 * can show real line numbers. Output is React elements — never `dangerouslySet
 * InnerHTML` — so generated code can never inject markup.
 */

import { memo, useMemo, type ReactNode } from 'react';

export interface Token {
  text: string;
  cls?: string;
}

const CPP_TYPES = new Set([
  'void',
  'int',
  'float',
  'double',
  'char',
  'bool',
  'boolean',
  'long',
  'short',
  'unsigned',
  'signed',
  'struct',
  'class',
  'enum',
  'union',
  'String',
  'size_t',
  'uint8_t',
  'uint16_t',
  'uint32_t',
  'int8_t',
  'int16_t',
  'int32_t',
  'byte',
  'word',
]);

const CPP_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'default',
  'sizeof',
  'new',
  'delete',
  'const',
  'static',
  'volatile',
  'extern',
  'inline',
  'typedef',
  'namespace',
  'using',
  'public',
  'private',
  'protected',
  'virtual',
  'override',
  'template',
  'typename',
  'this',
  'try',
  'catch',
  'throw',
  'goto',
  'register',
  'constexpr',
]);

const CPP_LITERALS = new Set(['true', 'false', 'nullptr', 'NULL', 'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP']);

const CPP_BUILTINS = new Set(['Serial', 'Serial1', 'Serial2', 'SerialUSB', 'Wire', 'SPI', 'BluetoothSerial', 'WiFi', 'Servo']);

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function tokenizeCpp(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let atLineStart = true;

  const push = (text: string, cls?: string) => {
    if (text.length === 0) return;
    tokens.push(cls ? { text, cls } : { text });
  };

  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    /* line comment */
    if (char === '/' && next === '/') {
      let end = index;
      while (end < source.length && source[end] !== '\n') end += 1;
      push(source.slice(index, end), 'tok-com');
      index = end;
      continue;
    }

    /* block comment */
    if (char === '/' && next === '*') {
      let end = source.indexOf('*/', index + 2);
      end = end === -1 ? source.length : end + 2;
      push(source.slice(index, end), 'tok-com');
      index = end;
      continue;
    }

    /* preprocessor */
    if (char === '#' && atLineStart) {
      let end = index;
      while (end < source.length && source[end] !== '\n') {
        if (source[end] === '\\' && source[end + 1] === '\n') {
          end += 2;
          continue;
        }
        end += 1;
      }
      push(source.slice(index, end), 'tok-pre');
      index = end;
      continue;
    }

    /* string / char literal */
    if (char === '"' || char === "'") {
      const quote = char;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === '\\') {
          end += 2;
          continue;
        }
        if (source[end] === quote || source[end] === '\n') {
          end += 1;
          break;
        }
        end += 1;
      }
      push(source.slice(index, Math.min(end, source.length)), 'tok-str');
      index = Math.min(end, source.length);
      atLineStart = false;
      continue;
    }

    /* number */
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(next ?? ''))) {
      let end = index;
      if (char === '0' && /[xXbB]/.test(next ?? '')) {
        end += 2;
        while (end < source.length && /[0-9a-fA-F_]/.test(source[end] as string)) end += 1;
      } else {
        while (end < source.length && /[0-9._eEuUlLfF+-]/.test(source[end] as string)) {
          const current = source[end] as string;
          if ((current === '+' || current === '-') && !/[eE]/.test(source[end - 1] as string)) break;
          end += 1;
        }
      }
      push(source.slice(index, end), 'tok-num');
      index = end;
      atLineStart = false;
      continue;
    }

    /* identifier / keyword / function call */
    if (isIdentStart(char)) {
      let end = index;
      while (end < source.length && isIdentChar(source[end] as string)) end += 1;
      const word = source.slice(index, end);
      let look = end;
      while (look < source.length && /\s/.test(source[look] as string)) look += 1;
      const followedByParen = source[look] === '(';

      let cls: string | undefined;
      if (CPP_TYPES.has(word)) cls = 'tok-type';
      else if (CPP_KEYWORDS.has(word)) cls = 'tok-kw';
      else if (CPP_LITERALS.has(word)) cls = 'tok-bool';
      else if (CPP_BUILTINS.has(word)) cls = 'tok-type';
      else if (followedByParen) cls = 'tok-fn';
      else if (/^[A-Z0-9_]{2,}$/.test(word)) cls = 'tok-bool';
      push(word, cls);
      index = end;
      atLineStart = false;
      continue;
    }

    /* whitespace */
    if (/\s/.test(char)) {
      let end = index;
      while (end < source.length && /\s/.test(source[end] as string) && source[end] !== '\n') end += 1;
      if (end === index) {
        push(char);
        end = index + 1;
      } else {
        push(source.slice(index, end));
      }
      index = end;
      atLineStart = source.slice(index - 1, index) === '\n' || /^\s*$/.test(source.slice(0, index).split('\n').pop() ?? '');
      if (char === '\n') atLineStart = true;
      continue;
    }

    /* punctuation */
    push(char, 'tok-punc');
    index += 1;
    atLineStart = false;
  }

  return tokens;
}

function tokenizeJson(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const push = (text: string, cls?: string) => {
    if (text.length === 0) return;
    tokens.push(cls ? { text, cls } : { text });
  };

  while (index < source.length) {
    const char = source[index] as string;

    if (char === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === '\\') {
          end += 2;
          continue;
        }
        if (source[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      const text = source.slice(index, Math.min(end, source.length));
      let look = Math.min(end, source.length);
      while (look < source.length && /\s/.test(source[look] as string)) look += 1;
      push(text, source[look] === ':' ? 'tok-key' : 'tok-str');
      index = Math.min(end, source.length);
      continue;
    }

    if (/[-0-9]/.test(char)) {
      let end = index;
      while (end < source.length && /[-0-9.eE+]/.test(source[end] as string)) end += 1;
      push(source.slice(index, end), 'tok-num');
      index = end;
      continue;
    }

    if (isIdentStart(char)) {
      let end = index;
      while (end < source.length && isIdentChar(source[end] as string)) end += 1;
      const word = source.slice(index, end);
      push(word, word === 'true' || word === 'false' || word === 'null' ? 'tok-bool' : undefined);
      index = end;
      continue;
    }

    if (/\s/.test(char)) {
      let end = index;
      while (end < source.length && /\s/.test(source[end] as string)) end += 1;
      push(source.slice(index, end));
      index = end;
      continue;
    }

    push(char, 'tok-punc');
    index += 1;
  }

  return tokens;
}

function tokenizeMarkdown(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split('\n');
  let inFence = false;

  lines.forEach((line, lineIndex) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      tokens.push({ text: line, cls: 'tok-dim' });
    } else if (inFence) {
      tokens.push({ text: line, cls: 'tok-fn' });
    } else if (/^#{1,6}\s/.test(line)) {
      tokens.push({ text: line, cls: 'tok-head' });
    } else if (/^\s*[-*+]\s/.test(line) || /^\s*\d+[.)]\s/.test(line)) {
      const match = /^(\s*(?:[-*+]|\d+[.)])\s)(.*)$/.exec(line);
      tokens.push({ text: match?.[1] ?? line, cls: 'tok-punc' });
      if (match?.[2]) tokens.push({ text: match[2] });
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      for (const part of line.split(/(\|)/)) {
        tokens.push(part === '|' ? { text: part, cls: 'tok-punc' } : { text: part });
      }
    } else if (/^\s*>\s?/.test(line)) {
      tokens.push({ text: line, cls: 'tok-com' });
    } else {
      let cursor = 0;
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (match.index > cursor) tokens.push({ text: line.slice(cursor, match.index) });
        tokens.push({ text: match[0], cls: match[0].startsWith('`') ? 'tok-str' : 'tok-bold' });
        cursor = match.index + match[0].length;
      }
      if (cursor < line.length) tokens.push({ text: line.slice(cursor) });
    }
    if (lineIndex < lines.length - 1) tokens.push({ text: '\n' });
  });

  return tokens;
}

export function tokenize(source: string, language: string): Token[] {
  const normalized = (language ?? '').toLowerCase();
  if (normalized.includes('json')) return tokenizeJson(source);
  if (normalized.includes('md') || normalized.includes('markdown') || normalized.includes('text')) return tokenizeMarkdown(source);
  return tokenizeCpp(source);
}

/** Split a token stream into per-line token arrays. */
export function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    if (!token.text.includes('\n')) {
      (lines[lines.length - 1] as Token[]).push(token);
      continue;
    }
    const parts = token.text.split('\n');
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) lines.push([]);
      if (part.length > 0) (lines[lines.length - 1] as Token[]).push({ text: part, ...(token.cls ? { cls: token.cls } : {}) });
    });
  }
  return lines;
}

export function languageOf(path: string, fallback = 'arduino-cpp'): string {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md') || path.endsWith('.markdown')) return 'markdown';
  if (path.endsWith('.ino')) return 'arduino-cpp';
  if (path.endsWith('.h') || path.endsWith('.hpp')) return 'c-header';
  if (path.endsWith('.cpp') || path.endsWith('.c')) return 'cpp';
  if (path.endsWith('.txt')) return 'text';
  return fallback;
}

interface CodeViewProps {
  content: string;
  language: string;
  maxHeight?: number;
}

/** Code body with a real line-number gutter. */
export const CodeView = memo(function CodeView({ content, language, maxHeight }: CodeViewProps) {
  const lines = useMemo(() => toLines(tokenize(content, language)), [content, language]);
  const gutter = useMemo(() => lines.map((_, index) => String(index + 1)).join('\n'), [lines]);

  return (
    <div className="code__scroll" style={maxHeight ? { maxHeight } : undefined}>
      <pre className="code__pre">
        <span className="code__gutter" aria-hidden>
          {gutter}
        </span>
        <code className="code__lines">
          {lines.map((line, lineIndex) => (
            <span className="code__line" key={lineIndex}>
              {line.length === 0 ? (
                <span> </span>
              ) : (
                line.map((token, tokenIndex) =>
                  token.cls ? (
                    <span className={token.cls} key={tokenIndex}>
                      {token.text}
                    </span>
                  ) : (
                    <span key={tokenIndex}>{token.text}</span>
                  ),
                )
              )}
              {lineIndex < lines.length - 1 ? '\n' : ''}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
});

/** Inline highlighted snippet (single line, no gutter). */
export function InlineCode({ text, language = 'arduino-cpp' }: { text: string; language?: string }): ReactNode {
  const tokens = useMemo(() => tokenize(text, language), [text, language]);
  return (
    <code>
      {tokens.map((token, index) =>
        token.cls ? (
          <span className={token.cls} key={index}>
            {token.text}
          </span>
        ) : (
          <span key={index}>{token.text}</span>
        ),
      )}
    </code>
  );
}
