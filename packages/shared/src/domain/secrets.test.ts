import { describe, expect, it } from 'vitest';
import {
  createSecretInputSchema,
  listSecretsQuerySchema,
  updateSecretInputSchema,
} from '../schemas/secrets.js';
import { isWellFormedText, SECRET_VALUE_MAX_BYTES, secretValueProblem } from './secrets.js';

const SYNTHETIC = 'synthetic-value-7f3a';

describe('secretValueProblem', () => {
  it('accepts empty values only for text types', () => {
    for (const type of ['STRING', 'SECRET', 'MULTILINE'] as const) {
      expect(secretValueProblem(type, '')).toBeNull();
    }
    for (const type of ['BOOLEAN', 'NUMBER', 'JSON'] as const) {
      expect(secretValueProblem(type, '')).not.toBeNull();
    }
  });

  it('validates booleans case insensitively', () => {
    for (const value of ['true', 'FALSE', '1', '0', 'Yes', 'no', 'on', 'OFF']) {
      expect(secretValueProblem('BOOLEAN', value)).toBeNull();
    }
    for (const value of ['truee', '2', ' true', 'y']) {
      expect(secretValueProblem('BOOLEAN', value)).not.toBeNull();
    }
  });

  it('accepts finite decimal numbers only', () => {
    for (const value of ['0', '42', '-7', '3.14', '1e3', '-2.5E-4']) {
      expect(secretValueProblem('NUMBER', value)).toBeNull();
    }
    for (const value of ['01', '1.', '.5', 'NaN', 'Infinity', '1e999', '0x10', '1 000', '+1']) {
      expect(secretValueProblem('NUMBER', value)).not.toBeNull();
    }
  });

  it('checks JSON syntax', () => {
    expect(secretValueProblem('JSON', '{"a":[1,true,null]}')).toBeNull();
    expect(secretValueProblem('JSON', '"text"')).toBeNull();
    expect(secretValueProblem('JSON', '{a:1}')).not.toBeNull();
  });

  it('supports Unicode and line breaks, and rejects lone surrogates', () => {
    expect(secretValueProblem('MULTILINE', 'line 1\nline 2\r\n🔐 ключ 秘密')).toBeNull();
    expect(secretValueProblem('SECRET', 'emoji 🔐')).toBeNull();
    expect(isWellFormedText('a\ud800b')).toBe(false);
    expect(isWellFormedText('\udc00')).toBe(false);
    expect(secretValueProblem('SECRET', 'a\ud800')).not.toBeNull();
  });

  it('limits values to 64 KiB of UTF-8', () => {
    expect(secretValueProblem('SECRET', 'a'.repeat(SECRET_VALUE_MAX_BYTES))).toBeNull();
    expect(secretValueProblem('SECRET', 'a'.repeat(SECRET_VALUE_MAX_BYTES + 1))).not.toBeNull();
    // Three bytes per character: fewer characters, same byte limit.
    expect(secretValueProblem('SECRET', '秘'.repeat(21_846))).not.toBeNull();
  });

  it('never repeats the value in messages', () => {
    for (const type of ['BOOLEAN', 'NUMBER', 'JSON'] as const) {
      expect(secretValueProblem(type, SYNTHETIC) ?? '').not.toContain(SYNTHETIC);
    }
  });
});

describe('createSecretInputSchema', () => {
  it('applies defaults and normalises tags and categories', () => {
    const parsed = createSecretInputSchema.parse({
      key: '  DATABASE_URL ',
      value: SYNTHETIC,
      category: '  Data   base ',
      tags: ['Backend', 'backend', ' infra '],
    });
    expect(parsed).toMatchObject({
      key: 'DATABASE_URL',
      type: 'SECRET',
      category: 'Data base',
      tags: ['backend', 'infra'],
      isRequired: false,
    });
  });

  it('keeps an empty value distinct from a missing one', () => {
    expect(createSecretInputSchema.parse({ key: 'A', value: '' }).value).toBe('');
    expect(createSecretInputSchema.parse({ key: 'A' }).value).toBeUndefined();
  });

  it('rejects invalid names, types and values without echoing the value', () => {
    for (const key of ['1ABC', 'MY-KEY', 'HAS SPACE', '', 'a'.repeat(257)]) {
      expect(createSecretInputSchema.safeParse({ key }).success).toBe(false);
    }
    expect(createSecretInputSchema.safeParse({ key: 'A', type: 'PASSWORD' }).success).toBe(false);
    const result = createSecretInputSchema.safeParse({
      key: 'PORT',
      type: 'NUMBER',
      value: SYNTHETIC,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(SYNTHETIC);
  });

  it('limits tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${String(i)}`);
    expect(createSecretInputSchema.safeParse({ key: 'A', tags }).success).toBe(false);
    expect(createSecretInputSchema.safeParse({ key: 'A', tags: ['UPPER CASE'] }).success).toBe(
      false,
    );
  });
});

describe('updateSecretInputSchema', () => {
  it('requires a revision and at least one change', () => {
    expect(updateSecretInputSchema.safeParse({ description: 'x' }).success).toBe(false);
    expect(updateSecretInputSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(updateSecretInputSchema.safeParse({ expectedRevision: 1, value: '' }).success).toBe(
      true,
    );
  });

  it('checks the value against the type when both are given', () => {
    expect(
      updateSecretInputSchema.safeParse({ expectedRevision: 2, type: 'BOOLEAN', value: 'maybe' })
        .success,
    ).toBe(false);
  });
});

describe('listSecretsQuerySchema', () => {
  it('parses comma separated filters', () => {
    expect(
      listSecretsQuerySchema.parse({ type: 'SECRET, JSON', category: 'API,none' }),
    ).toMatchObject({
      type: ['SECRET', 'JSON'],
      category: ['API', 'none'],
      status: 'active',
      sort: 'name',
    });
    expect(listSecretsQuerySchema.safeParse({ type: 'SECRET,OTHER' }).success).toBe(false);
  });
});
