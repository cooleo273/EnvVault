/** Header used to propagate a request correlation ID between clients and the API. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Client-supplied request IDs are only accepted when they are short and consist of
 * safe characters, so they cannot be used for log injection or header smuggling.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}
