import { resolve } from 'node:path';
import {
  generateIntegrityKeyFile,
  IntegrityKeys,
  readIntegrityKeyFile,
  rotateIntegrityKeyFile,
  writeIntegrityKeyFile,
} from '@envvault/crypto';
import { sealPending, verifyChains } from '../audit/audit-chain.js';
import { type OpsContext, OpsError } from './context.js';

function integrityPath(ops: OpsContext): string {
  const path = ops.env.INTEGRITY_KEY_FILE;
  if (!path) throw new OpsError('This command needs INTEGRITY_KEY_FILE');
  return path;
}

async function integrityKeys(ops: OpsContext): Promise<IntegrityKeys> {
  return new IntegrityKeys(await readIntegrityKeyFile(integrityPath(ops)));
}

/** Creates the integrity key file; never replaces an existing one. */
export async function integrityInitKey(ops: OpsContext, out: string | undefined): Promise<number> {
  if (!out) throw new OpsError('Missing --out <path>', 2);
  const path = resolve(out);
  const file = generateIntegrityKeyFile();
  await writeIntegrityKeyFile(path, file, { exclusive: true });
  ops.io.out(`Created integrity key ${file.activeKeyId} at ${path} (mode 0600).`);
  ops.io.out('Set INTEGRITY_KEY_FILE to it. Back it up with the keyring backups: without it,');
  ops.io.out(
    'existing audit seals can no longer be verified (the events themselves stay readable).',
  );
  return 0;
}

/** Adds a new active integrity key; older keys stay to verify what they sealed. */
export async function integrityRotateKey(
  ops: OpsContext,
  confirm: string | undefined,
): Promise<number> {
  const path = integrityPath(ops);
  const current = await readIntegrityKeyFile(path);
  if (confirm !== current.activeKeyId) {
    throw new OpsError(`Run again with --confirm ${current.activeKeyId}`, 2);
  }
  const rotated = rotateIntegrityKeyFile(current);
  await writeIntegrityKeyFile(path, rotated);
  ops.io.out(
    `Integrity key ${rotated.activeKeyId} is active; ${current.activeKeyId} is kept for verification.`,
  );
  ops.io.out('Restart every API instance to seal with the new key.');
  return 0;
}

export async function auditSeal(ops: OpsContext, full: boolean): Promise<number> {
  const keys = await integrityKeys(ops);
  try {
    const { sealed } = await sealPending(ops.db, keys, { full });
    ops.io.out(`Sealed ${String(sealed)} audit events.`);
    return 0;
  } finally {
    keys.destroy();
  }
}

/** Parses `chain:seq:machex` heads recorded outside the database. */
function parseHeads(values: readonly string[]): Map<string, { seq: string; mac: string }> {
  const heads = new Map<string, { seq: string; mac: string }>();
  for (const value of values) {
    const match = /^([0-9a-z-]{8,36}):(\d{1,19}):([0-9a-f]{16,64})$/.exec(value);
    if (!match?.[1] || !match[2] || !match[3])
      throw new OpsError(`Invalid --expect-head ${value}`, 2);
    heads.set(match[1], { seq: match[2], mac: match[3] });
  }
  return heads;
}

export async function auditVerify(
  ops: OpsContext,
  options: { chainId?: string | undefined; expectHeads: readonly string[] },
): Promise<number> {
  const expected = parseHeads(options.expectHeads);
  const keys = await integrityKeys(ops);
  let failed = false;
  try {
    const report = await verifyChains(
      ops.db,
      keys,
      options.chainId ? { chainId: options.chainId } : {},
    );
    for (const chain of report.chains) {
      const head = chain.head ? `${chain.head.seq}:${chain.head.mac.slice(0, 32)}` : 'none';
      ops.io.out(
        `${chain.chainId}: ${String(chain.seals)} seals from seq ${chain.firstSeq ?? '-'}, head ${chain.chainId}:${head}`,
      );
      for (const problem of chain.problems) {
        failed = true;
        ops.io.err(`  PROBLEM ${JSON.stringify(problem)}`);
      }
      const want = expected.get(chain.chainId);
      if (want) {
        const ok =
          chain.head !== null &&
          BigInt(chain.head.seq) >= BigInt(want.seq) &&
          (chain.head.seq !== want.seq || chain.head.mac.startsWith(want.mac));
        if (!ok) {
          failed = true;
          ops.io.err(
            `  PROBLEM head is behind or differs from the recorded ${want.seq}:${want.mac}`,
          );
        }
      }
    }
    for (const chainId of expected.keys()) {
      if (!report.chains.some((c) => c.chainId === chainId)) {
        failed = true;
        ops.io.err(`  PROBLEM chain ${chainId} has no seals`);
      }
    }
    if (report.unsealed > 0) {
      ops.io.err(
        `${String(report.unsealed)} older audit events have no seal (run pnpm ops audit:seal --full).`,
      );
    }
    ops.io.out(failed ? 'Verification FAILED.' : 'Verification passed for every sealed event.');
    return failed ? 1 : 0;
  } finally {
    keys.destroy();
  }
}
