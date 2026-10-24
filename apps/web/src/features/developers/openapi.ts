import 'server-only';
import { serverEnv } from '@/server-env';

/** A JSON schema as the API publishes it (OpenAPI 3.0 subset). */
export interface Schema {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  additionalProperties?: Schema | boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  $ref?: string;
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  callers: string[];
  permission: string | null;
  gate: string | null;
  stepUp: boolean;
  deprecated: boolean;
  parameters: { name: string; in: string; required: boolean; schema: Schema }[];
  body: Schema | null;
  responses: { status: string; description: string; schema: Schema | null }[];
}

export interface Reference {
  version: string;
  protocolVersion: number;
  tags: { name: string; description: string }[];
  operations: Operation[];
  errorCodes: Record<string, string[]>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function jsonSchema(content: unknown): Schema | null {
  if (!isObject(content)) return null;
  const json = content['application/json'];
  return isObject(json) && isObject(json.schema) ? json.schema : null;
}

/** Reduces the OpenAPI document to what the reference page renders. */
export function toReference(document: unknown): Reference | null {
  if (!isObject(document) || !isObject(document.paths) || !isObject(document.info)) return null;
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isObject(item)) continue;
    for (const [method, raw] of Object.entries(item)) {
      if (!isObject(raw)) continue;
      const parameters = Array.isArray(raw.parameters) ? raw.parameters.filter(isObject) : [];
      const responses = isObject(raw.responses) ? raw.responses : {};
      const body = isObject(raw.requestBody) ? jsonSchema(raw.requestBody.content) : null;
      operations.push({
        id: text(raw.operationId) || `${method}${path}`,
        method: method.toUpperCase(),
        path,
        tag: Array.isArray(raw.tags) ? text(raw.tags[0]) : '',
        summary: text(raw.summary),
        description: text(raw.description),
        callers: Array.isArray(raw['x-envvault-callers'])
          ? raw['x-envvault-callers'].map(text)
          : [],
        permission: text(raw['x-envvault-permission']) || null,
        gate: text(raw['x-envvault-gate-permission']) || null,
        stepUp: raw['x-envvault-step-up'] === true,
        deprecated: raw.deprecated === true,
        parameters: parameters.map((p) => ({
          name: text(p.name),
          in: text(p.in),
          required: p.required === true,
          schema: isObject(p.schema) ? p.schema : {},
        })),
        body,
        responses: Object.entries(responses).map(([status, r]) => ({
          status,
          description: isObject(r) ? text(r.description) : '',
          schema: isObject(r) && !text(r.$ref) ? jsonSchema(r.content) : null,
        })),
      });
    }
  }
  const tags = Array.isArray(document.tags)
    ? document.tags
        .filter(isObject)
        .map((t) => ({ name: text(t.name), description: text(t.description) }))
    : [];
  const catalog = isObject(document['x-envvault-error-codes'])
    ? document['x-envvault-error-codes']
    : {};
  return {
    version: text(document.info.version),
    protocolVersion:
      typeof document['x-envvault-protocol-version'] === 'number'
        ? document['x-envvault-protocol-version']
        : 0,
    tags,
    operations,
    errorCodes: Object.fromEntries(
      Object.entries(catalog).map(([group, codes]) => [
        group,
        isObject(codes) ? Object.values(codes).map(text).sort() : [],
      ]),
    ),
  };
}

/**
 * The live API description. Public data only (no tokens are sent), fetched
 * server side and cached for five minutes.
 */
export async function loadReference(): Promise<Reference | null> {
  const env = serverEnv();
  const origin = env.API_INTERNAL_URL ?? env.NEXT_PUBLIC_API_URL;
  try {
    const response = await fetch(`${origin}/api/v1/openapi.json`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return toReference(await response.json());
  } catch {
    return null;
  }
}
