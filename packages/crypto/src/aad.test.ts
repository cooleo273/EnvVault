import { describe, expect, it } from 'vitest';
import { AAD_DOMAINS, encodeAad } from './aad.js';
import { CryptoInputError } from './errors.js';

describe('encodeAad', () => {
  it('is deterministic and versioned', () => {
    const a = encodeAad(AAD_DOMAINS.secretValue, [['a', '1']]);
    expect(a.equals(encodeAad(AAD_DOMAINS.secretValue, [['a', '1']]))).toBe(true);
    expect(a[0]).toBe(1);
  });

  it('is unambiguous: shifting bytes between fields changes the encoding', () => {
    const left = encodeAad(AAD_DOMAINS.secretValue, [
      ['x', 'ab'],
      ['y', 'c'],
    ]);
    const right = encodeAad(AAD_DOMAINS.secretValue, [
      ['x', 'a'],
      ['y', 'bc'],
    ]);
    expect(left.equals(right)).toBe(false);
  });

  it('separates domains', () => {
    const fields = [['a', '1']] as const;
    expect(
      encodeAad(AAD_DOMAINS.secretValue, fields).equals(encodeAad(AAD_DOMAINS.dataKeyWrap, fields)),
    ).toBe(false);
  });

  it('rejects duplicate or empty field names', () => {
    expect(() =>
      encodeAad(AAD_DOMAINS.secretValue, [
        ['a', '1'],
        ['a', '2'],
      ]),
    ).toThrow(CryptoInputError);
    expect(() => encodeAad(AAD_DOMAINS.secretValue, [['', '1']])).toThrow(CryptoInputError);
  });

  it('rejects oversized fields', () => {
    expect(() => encodeAad(AAD_DOMAINS.secretValue, [['a', 'x'.repeat(70_000)]])).toThrow(
      CryptoInputError,
    );
  });
});
