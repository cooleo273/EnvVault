/**
 * Variable naming, typing and value rules shared by the API (enforcement) and
 * the web app (early feedback). Validation messages never include the value.
 */

export const SECRET_TYPES = ['STRING', 'SECRET', 'BOOLEAN', 'NUMBER', 'JSON', 'MULTILINE'] as const;
export type SecretType = (typeof SECRET_TYPES)[number];

export const SECRET_TYPE_LABELS: Record<SecretType, string> = {
  STRING: 'String',
  SECRET: 'Secret',
  BOOLEAN: 'Boolean',
  NUMBER: 'Number',
  JSON: 'JSON',
  MULTILINE: 'Multiline',
};

export const SECRET_TYPE_DESCRIPTIONS: Record<SecretType, string> = {
  STRING: 'Plain configuration text, such as a hostname or log level.',
  SECRET: 'Credentials such as API keys, passwords and connection strings.',
  BOOLEAN: 'true or false (also 1/0, yes/no, on/off).',
  NUMBER: 'A finite decimal number, such as 8080 or 0.25.',
  JSON: 'Any valid JSON document.',
  MULTILINE: 'Text with line breaks, such as certificates and private keys.',
};

/**
 * .env compatible names: an ASCII letter or underscore, then letters, digits
 * or underscores. Case is preserved and significant (`api_key` and `API_KEY`
 * are different variables), matching POSIX shells. Mirrors the database
 * CHECK `secrets_key_format_chk`.
 */
export const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_KEY_MAX_LENGTH = 256;

/** Values are limited to 64 KiB of UTF-8, the envelope and database limit. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

export const SECRET_DESCRIPTION_MAX_LENGTH = 1000;
export const SECRET_CATEGORY_MAX_LENGTH = 64;
export const SECRET_TAG_MAX_LENGTH = 32;
export const SECRET_MAX_TAGS = 20;

/** Lowercase letters and digits, then also `.`, `_` and `-`. */
export const SECRET_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** Letters (any script), digits, spaces and a little punctuation. */
export const SECRET_CATEGORY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} &/._-]*$/u;

/** Suggested categories. Any other label that matches the pattern is allowed too. */
export const SUGGESTED_SECRET_CATEGORIES = [
  'Database',
  'Authentication',
  'API',
  'Payments',
  'Storage',
  'Messaging',
  'General',
] as const;

export const BOOLEAN_VALUES = ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'] as const;

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Types whose empty value is meaningful. For the others an empty value is invalid. */
const EMPTY_ALLOWED: ReadonlySet<SecretType> = new Set<SecretType>([
  'STRING',
  'SECRET',
  'MULTILINE',
]);

/** Types a value must be rechecked for when a variable is switched to them. */
export const STRICT_SECRET_TYPES: ReadonlySet<SecretType> = new Set<SecretType>([
  'BOOLEAN',
  'NUMBER',
  'JSON',
]);

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

/** False for strings with lone UTF-16 surrogates, which cannot be encoded faithfully. */
export function isWellFormedText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function normaliseTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function normaliseCategory(category: string): string {
  return category.trim().replace(/\s+/g, ' ');
}

/**
 * Checks a value against its type. Returns a message for the user, or null
 * when the value is acceptable. The message never repeats the value.
 */
export function secretValueProblem(type: SecretType, value: string): string | null {
  if (!isWellFormedText(value)) return 'The value contains invalid Unicode characters';
  if (utf8ByteLength(value) > SECRET_VALUE_MAX_BYTES) {
    return `The value is larger than ${String(SECRET_VALUE_MAX_BYTES / 1024)} KiB`;
  }
  if (value === '') {
    return EMPTY_ALLOWED.has(type)
      ? null
      : `An empty value is not a valid ${SECRET_TYPE_LABELS[type].toLowerCase()}`;
  }
  switch (type) {
    case 'BOOLEAN':
      return (BOOLEAN_VALUES as readonly string[]).includes(value.toLowerCase())
        ? null
        : 'Enter true or false (1/0, yes/no and on/off are accepted)';
    case 'NUMBER':
      return NUMBER_PATTERN.test(value) && Number.isFinite(Number(value))
        ? null
        : 'Enter a finite number such as 42 or 3.14';
    case 'JSON':
      try {
        JSON.parse(value);
        return null;
      } catch {
        return 'Enter valid JSON';
      }
    default:
      return null;
  }
}
