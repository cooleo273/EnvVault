import type { OidcTrustBinding } from '@envvault/shared';

/**
 * Example workflow for a trust binding, shown in the dashboard for copying.
 * It holds ids and the API address only: no credential, no value. Action
 * references are placeholders the reader pins to a full commit SHA.
 */
export const ACTION_PLACEHOLDER = '<owner>/<repo>/packages/github-action@<full-commit-sha>';
export const CHECKOUT_PLACEHOLDER = 'actions/checkout@<full-commit-sha>';

/** YAML scalar safe for the values this generator emits (names, refs, URLs). */
function scalar(value: string): string {
  return /^[A-Za-z0-9_./:@*-]+$/.test(value) && !/^[*&!|>%@`-]/.test(value)
    ? value
    : JSON.stringify(value);
}

function branchFilter(prefix: string, refs: readonly string[]): string[] {
  return refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
}

function triggers(binding: OidcTrustBinding): string[] {
  const events = binding.eventNames.length > 0 ? binding.eventNames : ['push'];
  const branches = branchFilter('refs/heads/', binding.refs);
  const tags = branchFilter('refs/tags/', binding.refs);
  const lines = ['on:'];
  for (const event of events) {
    if (event === 'push' && (branches.length > 0 || tags.length > 0)) {
      lines.push('  push:');
      if (branches.length > 0) lines.push(`    branches: [${branches.map(scalar).join(', ')}]`);
      if (tags.length > 0) lines.push(`    tags: [${tags.map(scalar).join(', ')}]`);
    } else {
      lines.push(`  ${event}:`);
    }
  }
  return lines;
}

export interface WorkflowOptions {
  apiUrl: string;
  projectId: string;
  command: string;
}

export function exampleWorkflow(binding: OidcTrustBinding, options: WorkflowOptions): string {
  const environment = binding.environments[0];
  const githubEnvironment = binding.githubEnvironments[0];
  const name =
    binding.workflowPath
      ?.split('/')
      .pop()
      ?.replace(/\.ya?ml$/, '') ?? 'envvault';
  return [
    `# ${binding.workflowPath ?? '.github/workflows/envvault.yml'}`,
    `name: ${scalar(name)}`,
    ...triggers(binding),
    '',
    'permissions:',
    '  contents: read',
    '  id-token: write # lets the job request its GitHub OIDC token; no stored secret',
    '',
    'jobs:',
    '  run:',
    '    runs-on: ubuntu-latest',
    ...(githubEnvironment ? [`    environment: ${scalar(githubEnvironment)}`] : []),
    '    steps:',
    `      - uses: ${CHECKOUT_PLACEHOLDER}`,
    '      - name: Run with EnvVault configuration',
    `        uses: ${ACTION_PLACEHOLDER}`,
    '        with:',
    `          api-url: ${scalar(options.apiUrl)}`,
    `          project-id: ${options.projectId}`,
    `          binding-id: ${binding.id}`,
    ...(binding.audience !== options.apiUrl
      ? [`          audience: ${scalar(binding.audience)}`]
      : []),
    `          environment: ${scalar(environment?.slug ?? '<environment>')}`,
    `          command: ${scalar(options.command)}`,
    '',
  ].join('\n');
}
