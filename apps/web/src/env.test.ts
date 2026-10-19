import { describe, expect, it } from 'vitest';
import { parsePublicEnv } from './env';

describe('parsePublicEnv', () => {
  it('defaults the API URL for local development', () => {
    expect(parsePublicEnv({}).NEXT_PUBLIC_API_URL).toBe('http://localhost:4000');
  });

  it('normalises the API URL to an origin', () => {
    expect(
      parsePublicEnv({ NEXT_PUBLIC_API_URL: 'https://api.example.com/v1/' }).NEXT_PUBLIC_API_URL,
    ).toBe('https://api.example.com');
  });

  it('rejects invalid URLs', () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_API_URL: 'javascript:alert(1)' })).toThrow(
      /NEXT_PUBLIC_API_URL/,
    );
  });
});
