import { ENVIRONMENT_KINDS } from '@envvault/shared';
import { describe, expect, it } from 'vitest';
import { EnvironmentKind } from '../generated/prisma/enums.js';

describe('EnvironmentKind contract', () => {
  it('matches the shared ENVIRONMENT_KINDS used by the web app', () => {
    expect(Object.values(EnvironmentKind).sort()).toEqual([...ENVIRONMENT_KINDS].sort());
  });
});
