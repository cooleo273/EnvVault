import { parseArgs } from 'node:util';
import { KEYRING_USAGES, type KeyringUsage } from '@envvault/crypto';
import { auditSeal, auditVerify, integrityInitKey, integrityRotateKey } from './audit-ops.js';
import { describeFailure, OpsContext, OpsError, type OpsIo } from './context.js';
import {
  keyringBackup,
  keyringRestore,
  keyringVerifyBackup,
  keysInit,
  recoveryKeyGenerate,
} from './keyring-ops.js';
import {
  keysRetire,
  keysRotate,
  keysStatus,
  printRewrap,
  rewrap,
  verifyEnvelopes,
} from './keys.js';

const USAGE = `Usage: pnpm ops <command> [options]

Keys (need DATABASE_URL and ENCRYPTION_KEYRING_FILE):
  keys:status                          Key versions and how many secret versions use each
  keys:rotate --confirm <key id>       Add a new active key version
  keys:rewrap [--dry-run] [--batch-size n] [--max-failures n]
                                       Move data keys onto the active version (resumable)
  keys:verify [--key-version n] [--limit n]
                                       Authenticate stored envelopes without reading values
  keys:retire --version n --backup <file> --recovery-key-file <file> --confirm <key id>
                                       Destroy an unreferenced "decrypt-only" version

Keyring backup and recovery (files only unless noted):
  keys:init --out <file> [--usage self-managed|development]
  keyring:recovery-key --out <file>
  keyring:backup --recovery-key-file <file> --out <file> [--keyring-file <file>] [--no-record]
  keyring:verify-backup --backup <file> --recovery-key-file <file> [--against-database]
  keyring:restore --backup <file> --recovery-key-file <file> --to <file> [--overwrite <key id>]

Audit integrity (need DATABASE_URL and INTEGRITY_KEY_FILE):
  integrity:init-key --out <file>      Create the HMAC key file for seals and idempotency
  integrity:rotate-key --confirm <id>  Add a new active integrity key
  audit:seal [--full]                  Seal audit events that have no seal yet
  audit:verify [--chain <id>] [--expect-head <chain:seq:mac> ...]
                                       Recompute every seal; compare heads recorded elsewhere

Nothing here prints key material, recovery keys or secret values.`;

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,6}$/.test(value)) throw new OpsError(`${flag} must be a positive integer`, 2);
  return Number(value);
}

export async function runOps(
  argv: readonly string[],
  io: OpsIo,
  context: OpsContext = new OpsContext(io),
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        confirm: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'batch-size': { type: 'string' },
        'max-failures': { type: 'string' },
        'key-version': { type: 'string' },
        limit: { type: 'string' },
        version: { type: 'string' },
        backup: { type: 'string' },
        'recovery-key-file': { type: 'string' },
        'keyring-file': { type: 'string' },
        'no-record': { type: 'boolean' },
        'against-database': { type: 'boolean' },
        out: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'string' },
        usage: { type: 'string' },
        full: { type: 'boolean' },
        chain: { type: 'string' },
        'expect-head': { type: 'string', multiple: true },
        help: { type: 'boolean' },
      },
    });
  } catch {
    io.err(USAGE);
    return 2;
  }
  const [command] = parsed.positionals;
  const v = parsed.values;
  if (v.help || !command) {
    io.err(USAGE);
    return 2;
  }
  const controller = new AbortController();
  const stop = () => {
    io.err('Stopping after the current item…');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    switch (command) {
      case 'keys:status':
        return await keysStatus(context);
      case 'keys:rotate':
        return await keysRotate(context, v.confirm);
      case 'keys:rewrap': {
        const dryRun = v['dry-run'] === true;
        const report = await rewrap(context, {
          dryRun,
          batchSize: positiveInt(v['batch-size'], '--batch-size') ?? 100,
          maxFailures: positiveInt(v['max-failures'], '--max-failures'),
          signal: controller.signal,
        });
        return printRewrap(context, report, dryRun);
      }
      case 'keys:verify': {
        const report = await verifyEnvelopes(context, {
          keyVersion: positiveInt(v['key-version'], '--key-version'),
          limit: positiveInt(v.limit, '--limit'),
          batchSize: 200,
        });
        io.out(
          `Checked ${String(report.checked)} envelopes: ${String(report.failed.length)} failed.`,
        );
        for (const failure of report.failed.slice(0, 50))
          io.err(`  failed ${failure.id}: ${failure.code}`);
        return report.failed.length > 0 ? 1 : 0;
      }
      case 'keys:retire': {
        const version = positiveInt(v.version, '--version');
        if (version === undefined) throw new OpsError('Missing --version <n>', 2);
        return await keysRetire(context, {
          version,
          confirm: v.confirm,
          backupPath: v.backup,
          recoveryKeyPath: v['recovery-key-file'],
        });
      }
      case 'keys:init': {
        const usage = v.usage ?? 'self-managed';
        if (!(KEYRING_USAGES as readonly string[]).includes(usage)) {
          throw new OpsError('--usage must be "self-managed" or "development"', 2);
        }
        return await keysInit(context, { out: v.out, usage: usage as KeyringUsage });
      }
      case 'keyring:recovery-key':
        return await recoveryKeyGenerate(context, v.out);
      case 'keyring:backup':
        return await keyringBackup(context, {
          recoveryKeyFile: v['recovery-key-file'],
          out: v.out,
          keyringFile: v['keyring-file'],
          record: v['no-record'] !== true,
        });
      case 'keyring:verify-backup':
        return await keyringVerifyBackup(context, {
          backup: v.backup,
          recoveryKeyFile: v['recovery-key-file'],
          againstDatabase: v['against-database'] === true,
        });
      case 'keyring:restore':
        return await keyringRestore(context, {
          backup: v.backup,
          recoveryKeyFile: v['recovery-key-file'],
          to: v.to,
          overwrite: v.overwrite,
        });
      case 'integrity:init-key':
        return await integrityInitKey(context, v.out);
      case 'integrity:rotate-key':
        return await integrityRotateKey(context, v.confirm);
      case 'audit:seal':
        return await auditSeal(context, v.full === true);
      case 'audit:verify':
        return await auditVerify(context, {
          chainId: v.chain,
          expectHeads: v['expect-head'] ?? [],
        });
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(`Failed: ${describeFailure(error)}`);
    return error instanceof OpsError ? error.exitCode : 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await context.close();
  }
}
