import { HttpStatus } from '@nestjs/common';
import type { Repositories, StoredSecretVersion, VariableRow } from '@envvault/database';
import { CLI_ERROR_CODES, CLI_LIMITS, type RuntimeConfiguration } from '@envvault/shared';
import type { AuthorizedEnvironment } from '../auth/principal.js';
import { ApiException } from '../common/api-exception.js';
import type { VaultContext } from '../secrets/secret-authorization.service.js';
import type { SecretVault } from '../secrets/secret-vault.service.js';

export const RUNTIME_ACTION = 'secret.runtime_loaded';

export function tooLarge(message: string): ApiException {
  return new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, CLI_ERROR_CODES.RUNTIME_TOO_LARGE, message);
}

export interface RuntimeSources {
  ctx: VaultContext;
  local: VariableRow[];
  /** Inherited rows the caller may load, with the base they come from. */
  inherited: VariableRow[];
  base: AuthorizedEnvironment | null;
  /** Inherited rows left out because the caller may not load the base. */
  withheld: number;
}

/**
 * Decrypts the values of one runtime load within the count and size
 * ceilings, then records the load before returning anything. Callers have
 * already checked `secret:runtime` (and step up for people).
 */
export async function loadRuntimeValues(
  vault: SecretVault,
  maxBytes: number,
  sources: RuntimeSources,
  auditMetadata: Record<string, string | number | boolean>,
): Promise<RuntimeConfiguration> {
  const { ctx, local, inherited, base } = sources;
  const environment = ctx.environment;
  if (local.length + inherited.length > CLI_LIMITS.runtimeMaxValues) {
    throw tooLarge('This environment has more variables than one run can load');
  }
  const repos: Repositories = vault.repos;
  const [localStored, baseStored] = await Promise.all([
    repos.secretBulk.currentVersions(
      environment.scope,
      local.map((r) => r.id),
    ),
    base && inherited.length > 0
      ? repos.secretBulk.currentVersions(
          base.scope,
          inherited.map((r) => r.id),
        )
      : Promise.resolve(new Map<string, StoredSecretVersion>()),
  ]);

  const required = new Set(
    (await repos.validationRules.list(environment.scope))
      .filter((rule) => rule.required)
      .map((rule) => rule.key),
  );
  for (const row of [...local, ...inherited]) if (row.isRequired) required.add(row.key);

  const values: RuntimeConfiguration['values'] = [];
  let bytes = 0;
  const decrypt = async (
    row: VariableRow,
    stored: StoredSecretVersion | undefined,
    target: AuthorizedEnvironment,
    source: 'local' | 'inherited',
  ) => {
    if (!stored) return;
    const value = await vault.open({ ...ctx, environment: target }, row.id, stored, {
      key: row.key,
      attempted: RUNTIME_ACTION,
    });
    bytes += Buffer.byteLength(row.key) + Buffer.byteLength(value);
    if (bytes > maxBytes) {
      throw tooLarge('The values of this environment exceed the size one run can load');
    }
    values.push({ key: row.key, value, source });
  };
  for (const row of local) await decrypt(row, localStored.get(row.id), environment, 'local');
  if (base) {
    for (const row of inherited) await decrypt(row, baseStored.get(row.id), base, 'inherited');
  }
  const present = new Set(values.map((v) => v.key));
  const missingRequired = [...required].filter((key) => !present.has(key)).sort();

  // Recorded before anything is returned; if it cannot be, nothing is.
  await vault.auditRead(
    ctx,
    RUNTIME_ACTION,
    environment.scope.environmentId,
    {
      count: values.length,
      inherited: values.filter((v) => v.source === 'inherited').length,
      withheldInherited: sources.withheld,
      missingRequired: missingRequired.length,
      ...auditMetadata,
    },
    'environment',
    [
      ...local.filter((r) => present.has(r.key)).map((r) => r.id),
      ...inherited.filter((r) => present.has(r.key)).map((r) => r.id),
    ],
  );
  return {
    environmentId: environment.scope.environmentId,
    values,
    missingRequired,
    withheldInherited: sources.withheld,
    issuedAt: new Date().toISOString(),
  };
}
