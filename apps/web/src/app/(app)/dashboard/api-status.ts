import 'server-only';
import { createEnvVaultClient } from '@envvault/sdk';
import { parsePublicEnv } from '@/env';

export interface ApiStatus {
  apiOrigin: string;
  reachable: boolean;
  version?: string;
  databaseReady?: boolean;
  checkedAt: string;
}

/** Live status from the API's health endpoints. Never throws; failures map to "unreachable". */
export async function getApiStatus(): Promise<ApiStatus> {
  const { NEXT_PUBLIC_API_URL: apiOrigin } = parsePublicEnv(process.env);
  const client = createEnvVaultClient({ baseUrl: apiOrigin, timeoutMs: 2_000 });
  const checkedAt = new Date().toISOString();
  try {
    const [health, readiness] = await Promise.all([client.health(), client.readiness()]);
    return {
      apiOrigin,
      reachable: health.status === 'ok',
      version: health.version,
      databaseReady: readiness.checks.database?.status === 'up',
      checkedAt,
    };
  } catch {
    return { apiOrigin, reachable: false, checkedAt };
  }
}
