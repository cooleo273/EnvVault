#!/usr/bin/env node
/*
 * Scans files tracked by Git (and staged changes) for credentials and key
 * material: EnvVault keyrings, recovery keys, backups and integrity keys,
 * private keys, cloud and service tokens, and database URLs with real
 * passwords. Prints file and line only, never the match.
 *
 *   node scripts/scan-secrets.mjs           # tracked files
 *   node scripts/scan-secrets.mjs --staged  # what the next commit would add
 *
 * A dedicated scanner (gitleaks) also runs in CI; this one needs no install.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  [
    'EnvVault key file',
    /"format"\s*:\s*"envvault\.(local-keyring|recovery-key|integrity-key)"[\s\S]{0,400}"key"\s*:\s*"[A-Za-z0-9+/]{43}="/,
  ],
  [
    'EnvVault keyring backup',
    /"format"\s*:\s*"envvault\.keyring-backup"[\s\S]{0,2000}"ciphertext"\s*:\s*"[A-Za-z0-9+/]{40,}/,
  ],
  [
    'Private key',
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/,
  ],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Neon API key', /\bnapi_[a-z0-9]{40,}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe secret key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ['Database URL with password', /\bpostgres(?:ql)?:\/\/[^:\s/'"`]+:([^@\s'"`]+)@([^/\s'"`:]+)/],
  ['Redis URL with password', /\brediss?:\/\/[^:\s/'"`]*:([^@\s'"`]+)@([^/\s'"`:]+)/],
];

/** Passwords and hosts that only ever appear as placeholders or disposable test values. */
const PLACEHOLDER_PASSWORD =
  /^(?:change-me[\w-]*|ci-disposable-password|placeholder|password|PASSWORD|REDIS_PASSWORD|pass|secret|x|\$\{?[A-Z_]+\}?|<[^>]+>|\*+)$/;
// Local services and the reserved example domains of RFC 2606.
const LOCAL_HOST =
  /^(?:localhost|127\.0\.0\.1|host|postgres|redis|db|ep-example[\w.-]*|[\w.-]*\.(?:example|test|invalid|localhost))$/;

const MAX_BYTES = 2 * 1024 * 1024;

function files(staged) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '-z'];
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function contentOf(path, staged) {
  if (staged)
    return execFileSync('git', ['show', `:${path}`], {
      encoding: 'utf8',
      maxBuffer: MAX_BYTES * 2,
    });
  if (statSync(path).size > MAX_BYTES) return '';
  return readFileSync(path, 'utf8');
}

const staged = process.argv.includes('--staged');
const findings = [];
for (const path of files(staged)) {
  if (/\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip|gz)$/i.test(path) || path === 'pnpm-lock.yaml')
    continue;
  let text;
  try {
    text = contentOf(path, staged);
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  for (const [name, pattern] of RULES) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    );
    for (const match of text.matchAll(global)) {
      if (name.endsWith('with password')) {
        const [, password = '', host = ''] = match;
        if (PLACEHOLDER_PASSWORD.test(password) || LOCAL_HOST.test(host)) continue;
      }
      const line = text.slice(0, match.index).split('\n').length;
      findings.push(`${path}:${String(line)}  ${name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Possible secrets found (${String(findings.length)}):\n${findings.map((f) => `  ${f}`).join('\n')}\n`,
  );
  process.stderr.write(
    'Remove them (and rotate anything real). Matches are not printed on purpose.\n',
  );
  process.exit(1);
}
process.stdout.write(`No secrets found in ${staged ? 'staged changes' : 'tracked files'}.\n`);
