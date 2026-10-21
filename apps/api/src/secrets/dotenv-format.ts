import { parse } from 'dotenv';

/**
 * dotenv 17's assignment pattern (`LINE` in dotenv/lib/main.js), used only to
 * find where each assignment starts and ends so problems can be reported by
 * line. Values are always produced by dotenv's own `parse`, and a unit test
 * checks that the results equal `parse` on the whole file. Update both when
 * dotenv is upgraded.
 */
const ASSIGNMENT =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
const LEADING = /^\s*(?:export\s+)?/;

export interface DotenvAssignment {
  /** 1 based line of the name. */
  line: number;
  key: string;
  value: string;
}

export interface ParsedDotenv {
  assignments: DotenvAssignment[];
  /** Lines that are neither blank, comments nor part of an assignment. */
  ignoredLines: { line: number; reason: string }[];
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Parses .env text with dotenv's rules: `KEY=value`, optional `export`,
 * `#` comments, single, double and backtick quotes, multiline quoted values,
 * `\n` and `\r` expansion in double quotes only. Nothing is evaluated: there
 * is no variable expansion and no command substitution. Unlike `parse`, it
 * keeps every occurrence of a name (so duplicates can be reported) and
 * reports lines dotenv would skip silently.
 */
export function parseDotenv(content: string): ParsedDotenv {
  const text = content.replace(/\r\n?/g, '\n');
  const assignments: DotenvAssignment[] = [];
  const covered = new Set<number>();
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(text); match !== null; match = ASSIGNMENT.exec(text)) {
    const [whole, key] = match;
    if (key === undefined) continue;
    const start = match.index + (LEADING.exec(whole)?.[0].length ?? 0);
    const first = lineAt(text, start);
    const last = first + (text.slice(start, match.index + whole.length).match(/\n/g)?.length ?? 0);
    for (let line = first; line <= last; line++) covered.add(line);
    assignments.push({ line: first, key, value: parse(whole)[key] ?? '' });
  }
  const ignoredLines = text.split('\n').flatMap((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (covered.has(line) || trimmed === '' || trimmed.startsWith('#')) return [];
    return [{ line, reason: 'Not a KEY=VALUE assignment; it was ignored' }];
  });
  return { assignments, ignoredLines };
}

/* ------------------------------------------------------------------ Export */

/** Values safe without quotes: dotenv trims and stops unquoted values at `#`. */
const UNQUOTED = /^[A-Za-z0-9_./:@%+,=~^-]+$/;

/**
 * One value as dotenv text that `parseDotenv` reads back exactly, or null
 * when no quoting style can carry it (the caller reports it instead of
 * writing a corrupted value).
 */
export function dotenvValue(value: string): string | null {
  if (value === '') return '';
  if (UNQUOTED.test(value)) return value;
  if (!value.includes("'") && !/[\n\r]/.test(value)) return `'${value}'`;
  // Double quotes expand \n and \r, so the value must not contain those sequences itself.
  if (!value.includes('"') && !/\\[nr]/.test(value)) {
    return `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }
  // Backticks keep everything literally except carriage returns, which dotenv normalises.
  if (!value.includes('`') && !value.includes('\r')) return `\`${value}\``;
  return null;
}

const YAML_UNSAFE = /[\u007f-\u009f\u2028\u2029\ufeff]/g;

/** A YAML 1.2 double quoted scalar (JSON escapes plus the characters YAML treats specially). */
export function yamlString(value: string): string {
  return JSON.stringify(value).replace(
    YAML_UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export const EXPORT_HEADER =
  'EnvVault export. Contains plaintext secret values: keep this file out of version control and delete it when done.';
