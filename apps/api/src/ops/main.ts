import { runOps } from './cli.js';

const code = await runOps(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exit(code);
