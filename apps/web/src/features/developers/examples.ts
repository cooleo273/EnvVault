/**
 * Request examples for the API reference. Placeholders only: no example
 * ever contains a real token, credential or value.
 */

export interface ExampleOperation {
  method: string;
  path: string;
  callers: string[];
  hasBody: boolean;
}

export interface Example {
  label: string;
  language: 'bash' | 'typescript' | 'python';
  code: string;
}

const TOKEN_FOR: Record<string, string> = {
  machine: '$ENVVAULT_ACCESS_TOKEN',
  cli: '$ENVVAULT_CLI_TOKEN',
  person: '$ENVVAULT_ACCESS_TOKEN',
  'service-credential': '$ENVVAULT_SERVICE_CREDENTIAL',
};

/** SDK calls for the operations developers use most, by `METHOD path`. */
const SDK: Record<string, { typescript?: string; python?: string }> = {
  'GET /meta': {
    typescript: 'await api.checkCompatibility();',
    python: 'client.check_compatibility()',
  },
  'POST /machine/token': {
    typescript:
      "import { machineClientFromEnvironment } from '@envvault/sdk/node';\n\n// Exchanges and renews tokens itself; the credential comes from the environment.\nconst envvault = machineClientFromEnvironment();",
    python:
      'from envvault import EnvVaultClient\n\n# Exchanges and renews tokens itself; the credential comes from the environment.\nclient = EnvVaultClient.from_environment()',
  },
  'GET /machine/identity': {
    typescript: 'const me = await envvault.identity();',
    python: 'me = client.identity()',
  },
  'GET /machine/environments': {
    typescript: 'const environments = await envvault.environments();',
    python: 'environments = client.environments()',
  },
  'GET /machine/environments/{environmentId}/variables': {
    typescript: "const { items } = await envvault.variables('staging');",
    python: 'variables = client.list_variables("staging")',
  },
  'POST /machine/environments/{environmentId}/runtime': {
    typescript:
      "const values = await envvault.runtimeValues('staging');\nconsole.log('Configuration loaded:', Object.keys(values).length);",
    python:
      'config = client.get_runtime_config(environment="staging")\nprint("Configuration loaded:", len(config))',
  },
  'GET /workspaces': { typescript: 'const workspaces = await api.listWorkspaces();' },
  'GET /workspaces/{workspaceId}/projects': {
    typescript:
      'for await (const project of api.iterateProjects(workspaceId)) {\n  console.log(project.name);\n}',
  },
  'GET /workspaces/{workspaceId}/projects/{projectId}/environments': {
    typescript:
      'for await (const environment of api.iterateEnvironments(workspaceId, projectId)) {\n  console.log(environment.name);\n}',
  },
  'GET /workspaces/{workspaceId}/projects/{projectId}/environments/{environmentId}/secrets': {
    typescript:
      '// Metadata only, never values.\nfor await (const variable of api.iterateSecrets(workspaceId, projectId, environmentId)) {\n  console.log(variable.key);\n}',
  },
  'POST /workspaces/{workspaceId}/projects/{projectId}/environments/{environmentId}/runtime': {
    typescript:
      'const config = await api.runtimeConfiguration(workspaceId, projectId, environmentId);',
  },
};

function curlPath(path: string): string {
  return path.replace(
    /\{(\w+)\}/g,
    (_match, name: string) => `$${name.replace(/([A-Z])/g, '_$1').toUpperCase()}`,
  );
}

export function examplesFor(operation: ExampleOperation): Example[] {
  const examples: Example[] = [];
  const caller = operation.callers.find((c) => c !== 'anonymous');
  const lines = [
    `curl -X ${operation.method} "$ENVVAULT_API_URL/api/v1${curlPath(operation.path)}"`,
  ];
  if (caller)
    lines.push(`  -H "Authorization: Bearer ${TOKEN_FOR[caller] ?? '$ENVVAULT_ACCESS_TOKEN'}"`);
  if (operation.hasBody) {
    lines.push('  -H "Content-Type: application/json"', "  -d '{}'");
  }
  examples.push({ label: 'curl', language: 'bash', code: lines.join(' \\\n') });
  const sdk = SDK[`${operation.method} ${operation.path}`];
  if (sdk?.typescript)
    examples.push({ label: 'TypeScript', language: 'typescript', code: sdk.typescript });
  if (sdk?.python) examples.push({ label: 'Python', language: 'python', code: sdk.python });
  return examples;
}
