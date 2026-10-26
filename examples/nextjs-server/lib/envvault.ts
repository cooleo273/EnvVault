// Server only: importing this from a Client Component fails the build, so
// values cannot end up in a browser bundle. Never copy them into
// NEXT_PUBLIC_* variables either: those are inlined into client JavaScript.
import 'server-only';
import { machineClientFromEnvironment } from '@envvault/sdk/node';

let loading: Promise<Record<string, string>> | undefined;

/**
 * The environment's values, loaded once per server process from
 * ENVVAULT_API_URL and ENVVAULT_SERVICE_CREDENTIAL. A failed load is retried
 * on the next call instead of being cached.
 */
export function configuration(): Promise<Record<string, string>> {
  loading ??= (async () => {
    const envvault = machineClientFromEnvironment();
    try {
      return await envvault.runtimeValues(process.env.ENVVAULT_ENVIRONMENT ?? 'development');
    } finally {
      await envvault.close();
    }
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

/** One value, for server code (route handlers, Server Components, Server Actions). */
export async function setting(key: string): Promise<string | undefined> {
  return (await configuration())[key];
}
