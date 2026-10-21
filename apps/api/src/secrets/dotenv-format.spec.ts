import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { dotenvValue, parseDotenv, yamlString } from './dotenv-format.js';

const SAMPLE = [
  '# Synthetic values only',
  '',
  'PLAIN=value',
  'export EXPORTED=1',
  'SPACED =  trimmed  ',
  "SINGLE='  keep $HOME and \\n literally  '",
  'DOUBLE="line one\\nline two"',
  'MULTI="first',
  'second',
  'third"',
  'BACKTICK=`it\'s "quoted"`',
  'INLINE=abc # comment',
  'HASH=abc#def',
  'EMPTY=',
  'EMPTY_QUOTED=""',
  'YAMLISH: colon style',
  'UNICODE="ключ 🔐 秘密"',
  'not an assignment',
  'PLAIN=second',
  'bad-name=x',
].join('\r\n');

describe('parseDotenv', () => {
  it('produces exactly what dotenv.parse produces, per occurrence', () => {
    const { assignments } = parseDotenv(SAMPLE);
    const lastByKey = Object.fromEntries(assignments.map((a) => [a.key, a.value]));
    expect(lastByKey).toEqual(parse(SAMPLE));
  });

  it('reports line numbers, duplicates and ignored lines', () => {
    const { assignments, ignoredLines } = parseDotenv(SAMPLE);
    expect(assignments.filter((a) => a.key === 'PLAIN')).toEqual([
      { line: 3, key: 'PLAIN', value: 'value' },
      { line: 19, key: 'PLAIN', value: 'second' },
    ]);
    expect(assignments.find((a) => a.key === 'MULTI')).toEqual({
      line: 8,
      key: 'MULTI',
      value: 'first\nsecond\nthird',
    });
    // Lines inside a multiline value are part of the assignment, not ignored.
    expect(ignoredLines).toEqual([{ line: 18, reason: expect.any(String) }]);
  });

  it('keeps whitespace inside quotes and never expands or executes anything', () => {
    const values = Object.fromEntries(parseDotenv(SAMPLE).assignments.map((a) => [a.key, a.value]));
    expect(values).toMatchObject({
      SPACED: 'trimmed',
      SINGLE: '  keep $HOME and \\n literally  ',
      DOUBLE: 'line one\nline two',
      BACKTICK: 'it\'s "quoted"',
      INLINE: 'abc',
      HASH: 'abc',
      EMPTY: '',
      EMPTY_QUOTED: '',
      YAMLISH: 'colon style',
      UNICODE: 'ключ 🔐 秘密',
      EXPORTED: '1',
    });
    const risky = parseDotenv('CMD=$(rm -rf /)\nREF=${HOME}\nTICK=`whoami`');
    expect(risky.assignments.map((a) => a.value)).toEqual(['$(rm -rf /)', '${HOME}', 'whoami']);
  });

  it('handles empty input and comment only files', () => {
    expect(parseDotenv('')).toEqual({ assignments: [], ignoredLines: [] });
    expect(parseDotenv('# only\n   \n#x')).toEqual({ assignments: [], ignoredLines: [] });
  });
});

describe('dotenvValue', () => {
  const VALUES = [
    '',
    'simple',
    'postgres://user:pa55@host:5432/db?sslmode=require',
    '  leading and trailing  ',
    'has # hash',
    "it's",
    'say "hi"',
    'both \' and "',
    'line one\nline two',
    'with \\n literal backslash n',
    'tab\there',
    'unicode ключ 🔐',
    '$HOME ${PATH} $(whoami)',
    '{"json": [1, true]}',
    '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
    'back`tick',
    'ends with backslash\\',
  ];

  it('round trips every representable value through parseDotenv', () => {
    for (const value of VALUES) {
      const encoded = dotenvValue(value);
      if (encoded === null) continue;
      const [parsed] = parseDotenv(`K=${encoded}\n`).assignments;
      expect(parsed?.value, `value ${JSON.stringify(value)} as ${encoded}`).toBe(value);
    }
  });

  it('refuses values no quoting style can carry instead of corrupting them', () => {
    expect(dotenvValue('a\'b"c`d\ne')).toBeNull();
    expect(dotenvValue('carriage\r\nreturn "x"')).toBeNull();
  });
});

describe('yamlString', () => {
  it('escapes characters YAML treats as breaks or non printable', () => {
    expect(yamlString('a\u2028b\u0085c')).toBe('"a\\u2028b\\u0085c"');
    expect(yamlString('quote " and \\ and\nnewline')).toBe('"quote \\" and \\\\ and\\nnewline"');
  });
});
