// A long running worker that keeps its EnvVault configuration current.
//
//   ENVVAULT_API_URL=https://api.envvault.example.com \
//   ENVVAULT_SERVICE_CREDENTIAL_FILE=/run/secrets/envvault  (or ..._CREDENTIAL from the platform) \
//   ENVVAULT_ENVIRONMENT=production node worker.mjs
//
// - Startup fails closed: without configuration the worker does not start.
// - Values are reloaded every REFRESH_SECONDS (with jitter, so a fleet does not
//   reload at once). Each reload exchanges the credential for a fresh 15 minute
//   access token and ends it afterwards.
// - A short outage keeps the last good configuration, retried with backoff, for
//   at most MAX_STALE_SECONDS; then the worker stops rather than run on old values.
// - Revoked access (credential revoked or expired, identity disabled, grant
//   removed) stops the worker at the next reload.
// Values stay in memory and are never logged.
import { EnvVaultApiError, EnvVaultNetworkError } from '@envvault/sdk';
import { machineClientFromEnvironment } from '@envvault/sdk/node';

const environment = process.env.ENVVAULT_ENVIRONMENT ?? 'development';
const refreshMs = Number(process.env.REFRESH_SECONDS ?? 300) * 1000;
const maxStaleMs = Number(process.env.MAX_STALE_SECONDS ?? 1800) * 1000;
const EXIT_REVOKED = 3;
const EXIT_STALE = 4;

let config = {};
let loadedAt = 0;

async function load() {
  const envvault = machineClientFromEnvironment(process.env, { timeoutMs: 10_000, retries: 2 });
  try {
    return await envvault.runtimeValues(environment);
  } finally {
    await envvault.close();
  }
}

/** Access ended for good: retrying cannot help. */
function revoked(error) {
  return error instanceof EnvVaultApiError && [401, 403, 404].includes(error.statusCode);
}

function transient(error) {
  return (
    error instanceof EnvVaultNetworkError ||
    (error instanceof EnvVaultApiError && (error.statusCode >= 500 || error.statusCode === 429))
  );
}

function describe(error) {
  // Codes and request ids are safe to log; values and credentials never appear in them.
  return error instanceof EnvVaultApiError
    ? `${error.code} (request ${error.requestId ?? 'unknown'})`
    : error instanceof EnvVaultNetworkError
      ? `network ${error.reason}`
      : 'unexpected error';
}

async function refresh() {
  try {
    config = await load();
    loadedAt = Date.now();
    console.log(`Configuration loaded: ${Object.keys(config).length} values from ${environment}`);
    return refreshMs;
  } catch (error) {
    if (revoked(error)) {
      console.error(`Access to EnvVault ended (${describe(error)}); stopping.`);
      config = {};
      process.exit(EXIT_REVOKED);
    }
    if (!transient(error) || Date.now() - loadedAt > maxStaleMs) {
      console.error(`Configuration could not be refreshed (${describe(error)}); stopping.`);
      config = {};
      process.exit(EXIT_STALE);
    }
    console.error(`Refresh failed (${describe(error)}); keeping the last configuration.`);
    return Math.min(refreshMs, 30_000);
  }
}

// Fail closed at startup.
try {
  config = await load();
  loadedAt = Date.now();
  console.log(`Configuration loaded: ${Object.keys(config).length} values from ${environment}`);
} catch (error) {
  console.error(`Configuration could not be loaded (${describe(error)}); not starting.`);
  process.exit(revoked(error) ? EXIT_REVOKED : EXIT_STALE);
}

async function schedule(delay) {
  const jitter = delay * 0.1 * Math.random();
  setTimeout(() => {
    void refresh().then(schedule);
  }, delay + jitter);
}
void schedule(refreshMs);

// The work itself would read `config` here; this example only reports counts.
setInterval(
  () => {
    console.log(`Working with ${Object.keys(config).length} values`);
  },
  Math.max(1000, refreshMs),
);
process.on('SIGTERM', () => {
  config = {};
  process.exit(0);
});
