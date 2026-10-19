import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const SENSITIVE_RATE_LIMIT_KEY = 'envvault:rate-limit:sensitive';
const reflector = new Reflector();

/**
 * Applies the stricter `sensitive` throttler (RATE_LIMIT_SENSITIVE_MAX
 * requests per minute per client) on top of the default limit. Use on
 * endpoints that accept guessable or high-value input, such as invitation
 * tokens.
 */
export const SensitiveRateLimit = () => SetMetadata(SENSITIVE_RATE_LIMIT_KEY, true);

/** `skipIf` for the `sensitive` throttler: only marked routes are counted. */
export function isNotSensitiveRoute(context: ExecutionContext): boolean {
  return (
    reflector.get<boolean | undefined>(SENSITIVE_RATE_LIMIT_KEY, context.getHandler()) !== true
  );
}
