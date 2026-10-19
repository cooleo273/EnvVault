import { describe, expect, it } from 'vitest';
import { isValidRequestId } from './request-id.js';

describe('isValidRequestId', () => {
  it.each(['3f2b8c1e-7a4d-4e9b-9c1a-2d5e6f7a8b9c', 'trace_abc.123-XYZ'])('accepts %s', (id) => {
    expect(isValidRequestId(id)).toBe(true);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['newline injection', 'abcdefgh\nlevel=error'],
    ['spaces', 'abcd efgh'],
    ['non-string', 12345678],
    ['undefined', undefined],
  ])('rejects %s', (_label, id) => {
    expect(isValidRequestId(id)).toBe(false);
  });
});
