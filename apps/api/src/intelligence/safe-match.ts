import { createContext, Script } from 'node:vm';
import { patternProblem } from '@envvault/shared';

/** Upper bound for one pattern match, on top of the syntax restrictions. */
const MATCH_TIMEOUT_MS = 50;
/** Longer values are not matched against patterns (reported as not checked). */
export const PATTERN_MAX_INPUT = 16 * 1024;

const script = new Script('result = new RegExp(pattern, "u").test(input)');

export type MatchResult = 'match' | 'no_match' | 'not_checked';

/**
 * Tests a validation pattern against a value. The pattern must pass the
 * shared safety check; the match runs in a separate V8 context with a time
 * limit, so even an unexpected slow pattern cannot stall the API.
 */
export function safeMatch(pattern: string, input: string): MatchResult {
  if (patternProblem(pattern) !== null || input.length > PATTERN_MAX_INPUT) return 'not_checked';
  const sandbox: { pattern: string; input: string; result?: boolean } = { pattern, input };
  try {
    script.runInContext(createContext(sandbox), { timeout: MATCH_TIMEOUT_MS });
  } catch {
    return 'not_checked';
  } finally {
    sandbox.input = '';
  }
  return sandbox.result === true ? 'match' : 'no_match';
}
