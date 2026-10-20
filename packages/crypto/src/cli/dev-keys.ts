import { runDevKeys } from './dev-keys-commands.js';

// Run from the repository root via `pnpm crypto:init:dev` (and :rotate/:status).
process.exitCode = await runDevKeys(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
