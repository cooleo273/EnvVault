import { AUTH_ERROR_CODES } from './auth.js';
import { CLI_ERROR_CODES } from './cli.js';
import { INTELLIGENCE_ERROR_CODES } from './environment-intelligence.js';
import { GENERAL_ERROR_CODES } from './error.js';
import { MACHINE_ERROR_CODES } from './machine.js';
import { INTEGRATION_ERROR_CODES } from './integrations.js';
import { OIDC_ERROR_CODES } from './oidc.js';
import { PROJECT_ERROR_CODES } from './projects.js';
import { RETENTION_ERROR_CODES } from './retention.js';
import { SECRET_TRANSFER_ERROR_CODES } from './secret-transfers.js';
import { SECRET_ERROR_CODES } from './secrets.js';
import { WORKSPACE_ERROR_CODES } from './workspaces.js';

/** Every `error.code` the API documents, grouped by area (published in the OpenAPI document). */
export const API_ERROR_CATALOG = {
  general: GENERAL_ERROR_CODES,
  auth: AUTH_ERROR_CODES,
  workspaces: WORKSPACE_ERROR_CODES,
  projects: PROJECT_ERROR_CODES,
  secrets: SECRET_ERROR_CODES,
  transfers: SECRET_TRANSFER_ERROR_CODES,
  intelligence: INTELLIGENCE_ERROR_CODES,
  retention: RETENTION_ERROR_CODES,
  cli: CLI_ERROR_CODES,
  machine: MACHINE_ERROR_CODES,
  oidc: OIDC_ERROR_CODES,
  integrations: INTEGRATION_ERROR_CODES,
} as const;

export const API_ERROR_CODES: readonly string[] = [
  ...new Set(Object.values(API_ERROR_CATALOG).flatMap((group) => Object.values(group))),
].sort();
