import { timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  createRepositories,
  type NewSecretData,
  type NewSecretVersion,
  type ValueOverwrite,
  withTransaction,
} from '@envvault/database';
import {
  IMPORT_ENTRY_STATUSES,
  type ImportEntry,
  type ImportEntryStatus,
  type importCommitInputSchema,
  type ImportPreview,
  type importPreviewInputSchema,
  type ImportResult,
  SECRET_KEY_MAX_LENGTH,
  SECRET_KEY_PATTERN,
  SECRET_TRANSFER_ERROR_CODES,
  type SecretType,
  secretValueProblem,
} from '@envvault/shared';
import type { z } from 'zod';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ApiException } from '../common/api-exception.js';
import { uuidV7 } from '../common/uuid-v7.js';
import { DatabaseService } from '../database/database.service.js';
import { parseDotenv } from './dotenv-format.js';
import {
  SecretAuthorizationService,
  type SecretRequestContext,
} from './secret-authorization.service.js';
import { SecretRateLimiter } from './secret-rate-limiter.js';
import { errorLabel, SecretVault } from './secret-vault.service.js';

type PreviewInput = z.output<typeof importPreviewInputSchema>;
type CommitInput = z.output<typeof importCommitInputSchema>;

/** One evaluated assignment, with its value (kept on the server only). */
interface Planned extends ImportEntry {
  value: string;
}

const TEXT_TYPES: ReadonlySet<SecretType> = new Set<SecretType>(['STRING', 'SECRET']);

function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  try {
    return left.length === right.length && timingSafeEqual(left, right);
  } finally {
    left.fill(0);
    right.fill(0);
  }
}

function rejected(status: HttpStatus, issues: { path: string; message: string }[]): ApiException {
  return new ApiException(
    status,
    SECRET_TRANSFER_ERROR_CODES.SECRET_IMPORT_REJECTED,
    status === HttpStatus.CONFLICT
      ? 'Some variables changed since the preview. Preview again.'
      : 'Some selected variables cannot be imported.',
    {},
    issues,
  );
}

/**
 * Bulk import of .env content. The content is parsed in memory (never
 * written to disk or logged) with dotenv's rules and nothing is evaluated.
 * The preview reports names, sizes and statuses only. The commit parses the
 * content again, encrypts every selected value before the transaction, and
 * applies all creates and overwrites in one transaction: either every
 * selected variable changes or none does.
 */
@Injectable()
export class SecretImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async preview(ctx: SecretRequestContext, input: PreviewInput): Promise<ImportPreview> {
    await this.authorization.require(ctx, 'secret:write', 'secret.import_previewed');
    const { planned, ignoredLines } = await this.plan(ctx, input.content, input.defaultType);

    // Comparing reveals whether a value equals the stored one, so it needs
    // value read access (and a step up in protected environments).
    const compared = await this.mayCompare(ctx);
    if (compared) {
      const candidates = planned.filter(
        (p) => p.status === 'exists' && p.existing?.hasValue === true,
      );
      if (candidates.length > 0) {
        await this.limiter.consume(ctx, 'bulk-read');
        const stored = await this.vault.repos.secretBulk.currentVersions(
          ctx.environment.scope,
          candidates.flatMap((c) => (c.existing ? [c.existing.id] : [])),
        );
        for (const entry of candidates) {
          const version = entry.existing ? stored.get(entry.existing.id) : undefined;
          if (!version || !entry.existing) continue;
          const current = await this.vault.open(ctx, entry.existing.id, version, {
            key: entry.key,
            attempted: 'secret.import_previewed',
          });
          entry.status = equalText(current, entry.value) ? 'unchanged' : 'changed';
        }
      }
      for (const entry of planned) {
        if (entry.status === 'exists' && entry.existing?.hasValue === false)
          entry.status = 'changed';
      }
    }

    const summary = Object.fromEntries(IMPORT_ENTRY_STATUSES.map((s) => [s, 0])) as Record<
      ImportEntryStatus,
      number
    >;
    for (const entry of planned) summary[entry.status] += 1;
    await this.vault.audit(
      this.vault.repos,
      ctx,
      'secret.import_previewed',
      ctx.environment.scope.environmentId,
      {
        entries: planned.length,
        compared,
        ...summary,
      },
      { resourceType: 'environment' },
    );
    return {
      entries: planned.map(({ value: _value, ...entry }) => entry),
      ignoredLines,
      compared,
      summary,
      limits: {
        maxBytes: this.env.SECRET_IMPORT_MAX_BYTES,
        maxEntries: this.env.SECRET_IMPORT_MAX_ENTRIES,
      },
    };
  }

  async commit(ctx: SecretRequestContext, input: CommitInput): Promise<ImportResult> {
    await this.authorization.require(ctx, 'secret:write', 'secret.import_started');
    await this.limiter.consume(ctx, 'import', ctx.environment.scope.environmentId);
    const scope = ctx.environment.scope;
    await this.vault.write(null, () =>
      this.vault.audit(
        this.vault.repos,
        ctx,
        'secret.import_started',
        ctx.environment.scope.environmentId,
        {
          selected: input.items.length,
        },
        { resourceType: 'environment' },
      ),
    );
    try {
      const { planned } = await this.plan(ctx, input.content, input.defaultType);
      const byKey = new Map<string, Planned>();
      for (const entry of planned) if (entry.status !== 'duplicate') byKey.set(entry.key, entry);

      const invalid: { path: string; message: string }[] = [];
      const stale: { path: string; message: string }[] = [];
      for (const item of input.items) {
        const entry = byKey.get(item.key);
        if (!entry) {
          invalid.push({ path: item.key, message: 'Not found in the content' });
        } else if (entry.status === 'invalid') {
          invalid.push({ path: item.key, message: entry.problem ?? 'Invalid' });
        } else if (item.action === 'create' && entry.existing) {
          stale.push({ path: item.key, message: 'A variable with this name exists now' });
        } else if (item.action === 'overwrite' && !entry.existing) {
          stale.push({ path: item.key, message: 'The variable no longer exists' });
        } else if (
          item.action === 'overwrite' &&
          entry.existing &&
          entry.existing.revision !== item.expectedRevision
        ) {
          stale.push({ path: item.key, message: 'The variable changed since the preview' });
        }
      }
      if (invalid.length > 0) throw rejected(HttpStatus.BAD_REQUEST, invalid);
      if (stale.length > 0) throw rejected(HttpStatus.CONFLICT, stale);

      // Encrypt everything first: a failure here leaves the database untouched.
      const keyRows = new Map<string, string>();
      const creates: { data: NewSecretData; version: NewSecretVersion }[] = [];
      const overwrites: ValueOverwrite[] = [];
      for (const item of input.items) {
        const entry = byKey.get(item.key);
        if (!entry) continue;
        const secretId = entry.existing?.id ?? uuidV7();
        const version = await this.vault.seal(
          ctx,
          secretId,
          entry.value,
          'secret.import_completed',
          {
            origin: 'IMPORT',
            changeReason: input.changeReason,
          },
          keyRows,
        );
        if (item.action === 'create') {
          creates.push({
            data: {
              id: secretId,
              key: entry.key,
              description: null,
              type: entry.type,
              category: input.category ?? null,
              tags: [...new Set(input.tags)],
              isRequired: false,
            },
            version,
          });
        } else {
          overwrites.push({ secretId, expectedRevision: item.expectedRevision, version });
        }
      }

      const secretIds = await this.vault.write(null, () =>
        withTransaction(
          this.database.client,
          async (tx) => {
            const repos = createRepositories(tx);
            await this.authorization.recheck(ctx, repos, ['secret:write'], 'secret.import_started');
            await repos.secretBulk.createWithVersions(scope, creates, ctx.principal.userId);
            const updated = await repos.secretBulk.overwriteValues(
              scope,
              overwrites,
              ctx.principal.userId,
            );
            if (updated.length !== overwrites.length) {
              const done = new Set(updated);
              throw rejected(
                HttpStatus.CONFLICT,
                overwrites
                  .filter((o) => !done.has(o.secretId))
                  .map((o) => ({
                    path:
                      input.items.find((i) => byKey.get(i.key)?.existing?.id === o.secretId)?.key ??
                      o.secretId,
                    message: 'The variable changed while importing',
                  })),
              );
            }
            const ids = [...creates.map((c) => c.data.id), ...updated];
            await this.vault.auditBatch(
              repos,
              ctx,
              'secret.import_completed',
              ids,
              {
                created: creates.length,
                updated: overwrites.length,
                skipped: planned.length - input.items.length,
              },
              { resourceType: 'environment' },
            );
            return ids;
          },
          { timeoutMs: 60_000 },
        ),
      );
      return { created: creates.length, updated: overwrites.length, secretIds };
    } catch (error) {
      await this.vault.auditFailure(
        ctx,
        'secret.import_failed',
        ctx.environment.scope.environmentId,
        error,
        {
          selected: input.items.length,
          reason: errorLabel(error),
        },
        'environment',
      );
      throw error;
    }
  }

  /** Parses and evaluates the content against the environment. Values stay on the server. */
  private async plan(
    ctx: SecretRequestContext,
    content: string,
    defaultType: SecretType,
  ): Promise<{ planned: Planned[]; ignoredLines: { line: number; reason: string }[] }> {
    if (Buffer.byteLength(content, 'utf8') > this.env.SECRET_IMPORT_MAX_BYTES) {
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        SECRET_TRANSFER_ERROR_CODES.SECRET_IMPORT_TOO_LARGE,
        `Imports are limited to ${String(Math.floor(this.env.SECRET_IMPORT_MAX_BYTES / 1024))} KiB`,
      );
    }
    const { assignments, ignoredLines } = parseDotenv(content);
    if (assignments.length > this.env.SECRET_IMPORT_MAX_ENTRIES) {
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        SECRET_TRANSFER_ERROR_CODES.SECRET_IMPORT_TOO_LARGE,
        `Imports are limited to ${String(this.env.SECRET_IMPORT_MAX_ENTRIES)} variables`,
      );
    }
    const validName = (key: string) =>
      key.length <= SECRET_KEY_MAX_LENGTH && SECRET_KEY_PATTERN.test(key);
    const lastLine = new Map<string, number>();
    for (const a of assignments) lastLine.set(a.key, a.line);
    const existing = await this.vault.repos.secretBulk.liveByKeys(ctx.environment.scope, [
      ...new Set(assignments.map((a) => a.key).filter(validName)),
    ]);
    const existingByKey = new Map(existing.map((s) => [s.key, s]));

    const planned = assignments.map((a): Planned => {
      const current = existingByKey.get(a.key);
      const multiline = /[\n\r]/.test(a.value);
      const type =
        current?.type ?? (multiline && TEXT_TYPES.has(defaultType) ? 'MULTILINE' : defaultType);
      const base = {
        line: a.line,
        key: a.key,
        value: a.value,
        valueBytes: Buffer.byteLength(a.value, 'utf8'),
        multiline,
        type,
        existing: current
          ? {
              id: current.id,
              type: current.type,
              revision: current.revision,
              hasValue: current.hasValue,
            }
          : null,
      };
      if (lastLine.get(a.key) !== a.line) {
        return {
          ...base,
          status: 'duplicate',
          problem: `Defined again on line ${String(lastLine.get(a.key))}; the last definition is used`,
        };
      }
      if (!validName(a.key)) {
        return {
          ...base,
          status: 'invalid',
          problem: 'Use letters, digits and underscores, starting with a letter or underscore',
        };
      }
      const problem = secretValueProblem(type, a.value);
      if (problem) return { ...base, status: 'invalid', problem };
      return { ...base, status: current ? 'exists' : 'new', problem: null };
    });
    return { planned, ignoredLines };
  }

  private async mayCompare(ctx: SecretRequestContext): Promise<boolean> {
    if (!ctx.environment.permissions.has('secret:read')) return false;
    if (!ctx.environment.isProtected) return true;
    const expiry = await this.vault.repos.authState.findActiveStepUpExpiry(ctx.principal.userId);
    return expiry !== null;
  }
}
