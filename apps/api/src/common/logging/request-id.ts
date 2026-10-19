import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidRequestId, REQUEST_ID_HEADER } from '@envvault/shared';

/**
 * Resolves the correlation ID for a request: a well-formed client-supplied
 * `x-request-id` is propagated, anything else is replaced by a fresh UUID.
 * The resolved ID is always echoed back on the response.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId = isValidRequestId(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  return requestId;
}
