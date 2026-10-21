import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  EXPORT_MEDIA_TYPES,
  type ExportFormat,
  type exportInputSchema,
  type ExportResult,
  SECRET_TRANSFER_ERROR_CODES,
} from '@envvault/shared';
import type { z } from 'zod';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ApiException } from '../common/api-exception.js';
import { dotenvValue, EXPORT_HEADER, yamlString } from './dotenv-format.js';
import {
  SecretAuthorizationService,
  type SecretRequestContext,
} from './secret-authorization.service.js';
import { SecretRateLimiter } from './secret-rate-limiter.js';
import { notFound, SecretVault } from './secret-vault.service.js';

type ExportInput = z.output<typeof exportInputSchema>;

const EXTENSIONS: Record<ExportFormat, string> = { dotenv: 'env', json: 'json', yaml: 'yaml' };

function serialize(
  format: ExportFormat,
  values: { key: string; value: string }[],
): { content: string; unrepresentable: string[] } {
  if (format === 'json') {
    const object = Object.fromEntries(values.map((v) => [v.key, v.value]));
    return { content: `${JSON.stringify(object, null, 2)}\n`, unrepresentable: [] };
  }
  if (format === 'yaml') {
    const lines = values.map((v) => `${yamlString(v.key)}: ${yamlString(v.value)}`);
    return { content: [`# ${EXPORT_HEADER}`, ...lines, ''].join('\n'), unrepresentable: [] };
  }
  const lines: string[] = [`# ${EXPORT_HEADER}`];
  const unrepresentable: string[] = [];
  for (const { key, value } of values) {
    const encoded = dotenvValue(value);
    if (encoded === null) unrepresentable.push(key);
    else lines.push(`${key}=${encoded}`);
  }
  return { content: `${lines.join('\n')}\n`, unrepresentable };
}

/**
 * Bulk download of decrypted values. Needs `secret:export` in addition to
 * `secret:read` (reading values one at a time never implies a bulk
 * download), a step up in protected environments, and is rate limited per
 * user. The file is built in memory and returned once with no-store; it is
 * never stored, logged or cached. Each export is audited with counts and
 * ids, never values.
 */
@Injectable()
export class SecretExportService {
  constructor(
    private readonly vault: SecretVault,
    private readonly authorization: SecretAuthorizationService,
    private readonly limiter: SecretRateLimiter,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async export(ctx: SecretRequestContext, input: ExportInput): Promise<ExportResult> {
    await this.authorization.require(ctx, 'secret:read', 'secret.exported');
    await this.authorization.require(ctx, 'secret:export', 'secret.exported');
    await this.authorization.requireStepUpIfProtected(ctx, null, 'secret.exported');
    await this.limiter.consume(ctx, 'bulk-read');

    const scope = ctx.environment.scope;
    const max = this.env.SECRET_EXPORT_MAX_ITEMS;
    if (input.secretIds && input.secretIds.length > max) throw this.tooLarge(max);
    const rows = await this.vault.repos.secretBulk.forExport(scope, input.secretIds, max);
    // Every requested id must be a live variable of this environment; ids
    // from elsewhere are not silently dropped.
    if (input.secretIds && rows.length !== input.secretIds.length) throw notFound();
    if (rows.length > max) throw this.tooLarge(max);

    await this.vault.write(null, () =>
      this.vault.audit(
        this.vault.repos,
        ctx,
        'secret.export_requested',
        scope.environmentId,
        {
          format: input.format,
          requested: rows.length,
        },
        { resourceType: 'environment' },
      ),
    );
    try {
      const skipped: { key: string; reason: string }[] = [];
      const values: { key: string; value: string }[] = [];
      for (const row of rows) {
        if (!row.stored) {
          skipped.push({ key: row.key, reason: 'No value set' });
          continue;
        }
        values.push({
          key: row.key,
          value: await this.vault.open(ctx, row.id, row.stored, {
            key: row.key,
            attempted: 'secret.exported',
          }),
        });
      }
      const { content, unrepresentable } = serialize(input.format, values);
      for (const key of unrepresentable) {
        skipped.push({
          key,
          reason: 'Cannot be written exactly in .env syntax; export JSON or YAML',
        });
      }
      const exported = rows.filter((r) => r.stored && !unrepresentable.includes(r.key));
      const environment = await this.vault.repos.environments.getDetail(scope);
      const slug = (environment?.slug ?? 'environment').replace(/[^a-z0-9-]/g, '') || 'environment';
      await this.vault.auditRead(
        ctx,
        'secret.exported',
        scope.environmentId,
        {
          format: input.format,
          count: exported.length,
          skipped: skipped.length,
          secretIds: exported.map((r) => r.id),
        },
        'environment',
      );
      return {
        // Browsers strip a leading dot from download names, so `.env.<slug>` would arrive mangled.
        filename: `${slug}.${EXTENSIONS[input.format]}`,
        mediaType: EXPORT_MEDIA_TYPES[input.format],
        format: input.format,
        count: exported.length,
        skipped,
        warnings: unrepresentable.map((key) => ({
          key,
          message: 'Left out of the .env file because no quoting style can hold it exactly',
        })),
        content,
      };
    } catch (error) {
      await this.vault.auditFailure(
        ctx,
        'secret.export_failed',
        scope.environmentId,
        error,
        {
          format: input.format,
        },
        'environment',
      );
      throw error;
    }
  }

  private tooLarge(max: number): ApiException {
    return new ApiException(
      HttpStatus.BAD_REQUEST,
      SECRET_TRANSFER_ERROR_CODES.SECRET_BULK_TOO_LARGE,
      `Exports are limited to ${String(max)} variables. Select fewer.`,
    );
  }
}
