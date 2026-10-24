// A Node.js backend that loads its configuration from EnvVault once, at startup.
//
//   ENVVAULT_API_URL=https://api.envvault.example.com \
//   ENVVAULT_SERVICE_CREDENTIAL=...  (from your secret store, never from code) \
//   ENVVAULT_ENVIRONMENT=staging node server.mjs
//
// Values stay in this process's memory. They are never logged, never sent to
// a browser and never written to disk.
import { createServer } from 'node:http';
import { machineClientFromEnvironment } from '@envvault/sdk/node';

const environment = process.env.ENVVAULT_ENVIRONMENT ?? 'development';

async function loadConfiguration() {
  const envvault = machineClientFromEnvironment();
  try {
    return await envvault.runtimeValues(environment);
  } finally {
    // Ends the access token; the next start exchanges the credential again.
    await envvault.close();
  }
}

const config = await loadConfiguration();
console.log(`Configuration loaded: ${Object.keys(config).length} values from ${environment}`);

const server = createServer((request, response) => {
  if (request.url === '/health') {
    // Report counts only, never values.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', configured: Object.keys(config).length }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  const address = server.address();
  console.log(`Listening on port ${typeof address === 'object' && address ? address.port : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
