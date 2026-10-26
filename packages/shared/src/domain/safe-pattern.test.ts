import { describe, expect, it } from 'vitest';
import { createSecretInputSchema } from '../schemas/secrets.js';
import {
  compareEnvironmentsInputSchema,
  replaceValidationRulesInputSchema,
  validationRuleInputSchema,
} from '../schemas/environment-intelligence.js';
import { patternProblem } from './safe-pattern.js';

describe('patternProblem', () => {
  it('accepts ordinary patterns', () => {
    for (const pattern of [
      '^https://',
      '^[a-z0-9-]+\\.example\\.com$',
      '^(dev|staging|prod)$',
      '^\\d{4}-\\d{2}-\\d{2}$',
      '^sk_(live|test)_[A-Za-z0-9]{24,}$',
      '^(?:[A-Z]{2})?\\d+$',
      '^(?<region>[a-z]+)-\\d$',
    ]) {
      expect(patternProblem(pattern), pattern).toBeNull();
    }
  });

  it('rejects patterns that can backtrack catastrophically', () => {
    for (const pattern of [
      '(a+)+$',
      '(a|a)*$',
      '(\\d*)*x',
      '((ab)*)+',
      '(?:a|b+)+',
      '(x{1,})*',
      '(a+){2,9}',
    ]) {
      expect(patternProblem(pattern), pattern).toMatch(/repeated group/);
    }
  });

  it('rejects backreferences, lookaround, invalid syntax and oversized patterns', () => {
    expect(patternProblem('(a)\\1')).toMatch(/Backreferences/);
    expect(patternProblem('^(?=a)')).toMatch(/Lookahead/);
    expect(patternProblem('(?<!a)b')).toMatch(/Lookahead/);
    expect(patternProblem('([a-')).toMatch(/valid/);
    expect(patternProblem('a'.repeat(201))).toMatch(/200/);
    expect(patternProblem('a*b*c*d*e*')).toMatch(/unbounded/);
  });

  it('treats quantifiers inside character classes as literals', () => {
    expect(patternProblem('^([+*?]x)+$')).toBeNull();
  });
});

describe('Phase 3D schemas', () => {
  it('never allows inheritable SECRET variables', () => {
    expect(
      createSecretInputSchema.safeParse({ key: 'A', type: 'SECRET', inheritable: true }).success,
    ).toBe(false);
    expect(
      createSecretInputSchema.parse({ key: 'A', type: 'STRING', inheritable: true }).inheritable,
    ).toBe(true);
    expect(createSecretInputSchema.parse({ key: 'A' }).inheritable).toBe(false);
  });

  it('validates rules, including the naming rule and unsafe patterns', () => {
    expect(
      validationRuleInputSchema.safeParse({
        key: 'PORT',
        format: 'NUMBER',
        minNumber: 1,
        maxNumber: 65535,
      }).success,
    ).toBe(true);
    expect(validationRuleInputSchema.safeParse({ key: '*', pattern: '^[A-Z_]+$' }).success).toBe(
      true,
    );
    expect(validationRuleInputSchema.safeParse({ key: '*' }).success).toBe(false);
    expect(validationRuleInputSchema.safeParse({ key: 'A', pattern: '(a+)+' }).success).toBe(false);
    expect(
      validationRuleInputSchema.safeParse({ key: 'A', minLength: 5, maxLength: 2 }).success,
    ).toBe(false);
    expect(
      replaceValidationRulesInputSchema.safeParse({ rules: [{ key: 'A' }, { key: 'A' }] }).success,
    ).toBe(false);
  });

  it('compares two different environments with metadata by default', () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(
      compareEnvironmentsInputSchema.safeParse({ sourceEnvironmentId: id, targetEnvironmentId: id })
        .success,
    ).toBe(false);
    expect(
      compareEnvironmentsInputSchema.parse({
        sourceEnvironmentId: id,
        targetEnvironmentId: '0190a000-0000-7000-8000-000000000002',
      }).compareValues,
    ).toBe(false);
  });
});
