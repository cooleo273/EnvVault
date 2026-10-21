import type { IntegrityKeys } from '@envvault/crypto';
import {
  type ChainHead,
  createRepositories,
  type NewSeal,
  type PrismaClient,
  withTransaction,
} from '@envvault/database';
import { chainOf, GENESIS_MAC, sealInput, sealMac } from './audit-seal.js';

/** Events younger than this may still belong to transactions that have not committed. */
export const SEAL_GRACE_MS = 5_000;
/** A regular pass rescans this far before the newest sealed event, for late commits. */
export const SEAL_LOOKBACK_MS = 15 * 60_000;
const BATCH = 500;

export interface SealReport {
  sealed: number;
}

/**
 * Seals committed events that have no seal yet, in time order, extending
 * each workspace's chain. Safe to run from several processes: an advisory
 * lock serialises passes.
 */
export async function sealPending(
  db: PrismaClient,
  keys: IntegrityKeys,
  options: { full?: boolean; now?: Date } = {},
): Promise<SealReport> {
  const before = new Date((options.now ?? new Date()).getTime() - SEAL_GRACE_MS);
  let sealed = 0;
  for (;;) {
    const count = await withTransaction(db, async (tx) => {
      const repos = createRepositories(tx);
      await repos.auditSeals.lock();
      const heads = await repos.auditSeals.heads();
      const latest = options.full ? null : await repos.auditSeals.latestSealedOccurredAt();
      const since = latest ? new Date(latest.getTime() - SEAL_LOOKBACK_MS) : new Date(0);
      const events = await repos.auditSeals.unsealed(since, before, BATCH);
      const seals: NewSeal[] = [];
      for (const event of events) {
        const chainId = chainOf(event);
        const head = heads.get(chainId);
        const seq = (head?.seq ?? 0n) + 1n;
        const mac = sealMac(keys, chainId, seq, head?.mac ?? GENESIS_MAC, event);
        seals.push({ chainId, seq, eventId: event.id, keyId: keys.activeKeyId, mac });
        heads.set(chainId, { chainId, seq, keyId: keys.activeKeyId, mac, checkpoint: false });
      }
      await repos.auditSeals.insert(seals);
      return seals.length;
    });
    sealed += count;
    if (count < BATCH) return { sealed };
  }
}

export type ChainProblem =
  | { kind: 'start_missing'; seq: string }
  | { kind: 'gap'; expected: string; found: string }
  | { kind: 'mac_mismatch'; seq: string; eventId: string }
  | { kind: 'unknown_key'; seq: string; keyId: string };

export interface ChainReport {
  chainId: string;
  seals: number;
  firstSeq: string | null;
  head: { seq: string; mac: string } | null;
  problems: ChainProblem[];
}

export interface VerifyReport {
  chains: ChainReport[];
  /** Events old enough to have been sealed that have no seal. */
  unsealed: number;
}

/**
 * Recomputes every chain. Detects edited, removed, reordered or inserted
 * sealed events. It cannot detect changes to events that were never sealed,
 * or removal of the newest seals; compare the reported heads with copies
 * kept outside the database for that.
 */
export async function verifyChains(
  db: PrismaClient,
  keys: IntegrityKeys,
  options: { chainId?: string; now?: Date } = {},
): Promise<VerifyReport> {
  const repos = createRepositories(db);
  const chainIds = options.chainId ? [options.chainId] : await repos.auditSeals.chainIds();
  const chains: ChainReport[] = [];
  for (const chainId of chainIds) {
    const report: ChainReport = { chainId, seals: 0, firstSeq: null, head: null, problems: [] };
    let previous: ChainHead | null = null;
    let after = 0n;
    for (;;) {
      const page = await repos.auditSeals.page(chainId, after, 1000);
      if (page.length === 0) break;
      for (const seal of page) {
        if (previous === null) {
          report.firstSeq = seal.seq.toString();
          if (seal.seq !== 1n) {
            previous = await repos.auditSeals.checkpointBefore(chainId, seal.seq);
            if (previous?.seq !== seal.seq - 1n) {
              report.problems.push({ kind: 'start_missing', seq: seal.seq.toString() });
              previous = null;
            }
          }
        } else if (seal.seq !== previous.seq + 1n) {
          report.problems.push({
            kind: 'gap',
            expected: (previous.seq + 1n).toString(),
            found: seal.seq.toString(),
          });
        }
        report.seals += 1;
        if (!keys.has(seal.keyId)) {
          report.problems.push({
            kind: 'unknown_key',
            seq: seal.seq.toString(),
            keyId: seal.keyId,
          });
        } else {
          const ok = keys.verify(
            'audit-seal',
            sealInput(chainId, seal.seq, previous?.mac ?? GENESIS_MAC, seal.event),
            seal.mac,
            seal.keyId,
          );
          if (!ok) {
            report.problems.push({
              kind: 'mac_mismatch',
              seq: seal.seq.toString(),
              eventId: seal.eventId,
            });
          }
        }
        // Continue from the stored MAC so one bad seal is reported once, not for every later seal.
        previous = { chainId, seq: seal.seq, keyId: seal.keyId, mac: seal.mac, checkpoint: false };
        after = seal.seq;
      }
    }
    if (previous) report.head = { seq: previous.seq.toString(), mac: previous.mac.toString('hex') };
    chains.push(report);
  }
  const cutoff = new Date((options.now ?? new Date()).getTime() - SEAL_GRACE_MS - SEAL_LOOKBACK_MS);
  return { chains, unsealed: await repos.auditSeals.countUnsealed(cutoff) };
}
