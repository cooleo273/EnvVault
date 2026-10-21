import type { ValidationRuleRecord } from '@envvault/database';
import { describe, expect, it } from 'vitest';
import { safeMatch } from './safe-match.js';
import { checkValue, needsValue } from './validation.service.js';

const SYNTHETIC = 'synthetic-validation-7e0c';

function rule(overrides: Partial<ValidationRuleRecord> = {}): ValidationRuleRecord {
  return {
    id: '0190a000-0000-7000-8000-000000000001',
    key: 'K',
    required: false,
    allowEmpty: true,
    format: 'ANY',
    minNumber: null,
    maxNumber: null,
    minLength: null,
    maxLength: null,
    pattern: null,
    allowedValues: [],
    description: null,
    updatedAt: new Date(),
    updatedBy: null,
    ...overrides,
  };
}

describe('safeMatch', () => {
  it('matches safe patterns and refuses unsafe ones without running them', () => {
    expect(safeMatch('^sk_test_[a-z0-9]+$', 'sk_test_abc123')).toBe('match');
    expect(safeMatch('^sk_test_', 'pk_live')).toBe('no_match');
    expect(safeMatch('(a+)+$', 'aaaa')).toBe('not_checked');
  });

  it('stops slow matches instead of stalling', () => {
    // Allowed by the syntax rules but polynomial: the time limit ends it.
    const started = Date.now();
    const result = safeMatch('^\\d*\\d*\\d*\\d*x$', '1'.repeat(10_000));
    expect(result).toBe('not_checked');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('checkValue', () => {
  it('checks formats, bounds, lengths, allowed values and patterns', () => {
    expect(checkValue('STRING', 'https://api.example.test', rule({ format: 'URL' }))).toEqual({
      outcome: 'passed',
    });
    expect(checkValue('STRING', 'not a url', rule({ format: 'URL' })).outcome).toBe('failed');
    expect(checkValue('STRING', '{"a":', rule({ format: 'JSON' })).outcome).toBe('failed');
    expect(
      checkValue('NUMBER', '70000', rule({ format: 'NUMBER', maxNumber: 65535 })).outcome,
    ).toBe('failed');
    expect(checkValue('STRING', '🔐🔐', rule({ maxLength: 2 }))).toEqual({ outcome: 'passed' });
    expect(checkValue('STRING', 'abc', rule({ minLength: 4 })).outcome).toBe('failed');
    expect(checkValue('STRING', 'staging', rule({ allowedValues: ['dev', 'prod'] })).outcome).toBe(
      'failed',
    );
    expect(checkValue('STRING', '', rule({ allowEmpty: false })).outcome).toBe('failed');
    expect(checkValue('STRING', '', rule({ format: 'URL' }))).toEqual({ outcome: 'passed' });
    expect(checkValue('BOOLEAN', 'maybe').outcome).toBe('failed');
  });

  it('never repeats the value in messages', () => {
    for (const r of [
      rule({ format: 'URL' }),
      rule({ allowedValues: ['x'] }),
      rule({ pattern: '^x$' }),
      rule({ maxLength: 3 }),
    ]) {
      const result = checkValue('STRING', SYNTHETIC, r);
      expect(result.outcome).toBe('failed');
      expect('message' in result ? result.message : '').not.toContain(SYNTHETIC);
    }
  });

  it('knows which rules need the value', () => {
    expect(needsValue(rule())).toBe(false);
    expect(needsValue(rule({ required: true }))).toBe(false);
    expect(needsValue(rule({ format: 'JSON' }))).toBe(true);
  });
});
