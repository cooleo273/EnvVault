/**
 * Restricted regular expressions for validation rules. Patterns come from
 * users and run against secret values on the server, so the syntax is limited
 * to what cannot backtrack exponentially: no backreferences, no lookaround,
 * and no quantifier applied to a group that itself contains a quantifier or
 * an alternative (which rules out `(a+)+`, `(a|a)*`, `(a+){2,9}` and
 * similar; an optional `(...)?` is fine). The API
 * additionally runs every match under a time limit.
 */

export const PATTERN_MAX_LENGTH = 200;
/** Unbounded quantifiers (`*`, `+`, `{n,}`) allowed in one pattern. */
export const PATTERN_MAX_UNBOUNDED = 4;

interface Group {
  hasQuantifier: boolean;
  hasAlternative: boolean;
}

/** Returns why a pattern is not accepted, or null when it is safe to use. */
export function patternProblem(pattern: string): string | null {
  if (pattern.length === 0) return 'Enter a pattern';
  if (pattern.length > PATTERN_MAX_LENGTH) {
    return `Use at most ${String(PATTERN_MAX_LENGTH)} characters`;
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    return 'Not a valid regular expression';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'Backreferences are not supported';
  if (/\(\?<?[=!]/.test(pattern)) return 'Lookahead and lookbehind are not supported';

  const stack: Group[] = [{ hasQuantifier: false, hasAlternative: false }];
  let unbounded = 0;
  let lastClosed: Group | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const top = stack[stack.length - 1];
    if (!top) return 'Not a valid regular expression';
    if (char === '\\') {
      i++;
      lastClosed = null;
      continue;
    }
    if (char === '[') {
      // Skip the character class; quantifiers inside it are literals.
      i++;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++;
        i++;
      }
      lastClosed = null;
      continue;
    }
    if (char === '(') {
      stack.push({ hasQuantifier: false, hasAlternative: false });
      if (pattern[i + 1] === '?') {
        // Non capturing or named group prefix: `(?:` or `(?<name>`.
        i += pattern[i + 2] === ':' ? 2 : pattern.indexOf('>', i) - i;
      }
      lastClosed = null;
      continue;
    }
    if (char === ')') {
      const closed = stack.pop();
      const parent = stack[stack.length - 1];
      if (!closed || !parent) return 'Not a valid regular expression';
      if (closed.hasQuantifier) parent.hasQuantifier = true;
      if (closed.hasAlternative) parent.hasAlternative = true;
      lastClosed = closed;
      continue;
    }
    if (char === '|') {
      top.hasAlternative = true;
      lastClosed = null;
      continue;
    }
    const quantifier =
      char === '*' || char === '+' || char === '?'
        ? char
        : char === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i))
          ? (/^\{\d+(,\d*)?\}/.exec(pattern.slice(i))?.[0] ?? '')
          : null;
    if (quantifier !== null) {
      // An optional group matches at most once, so only real repetition counts.
      if (
        quantifier !== '?' &&
        lastClosed &&
        (lastClosed.hasQuantifier || lastClosed.hasAlternative)
      ) {
        return 'A repeated group cannot contain repetition or alternatives';
      }
      if (quantifier === '*' || quantifier === '+' || quantifier.endsWith(',}')) unbounded++;
      top.hasQuantifier = true;
      if (quantifier.length > 1) i += quantifier.length - 1;
      // A lazy marker after a quantifier is part of it.
      if (pattern[i + 1] === '?') i++;
      lastClosed = null;
      continue;
    }
    lastClosed = null;
  }
  if (unbounded > PATTERN_MAX_UNBOUNDED) {
    return `Use at most ${String(PATTERN_MAX_UNBOUNDED)} unbounded repetitions`;
  }
  return null;
}
