import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createRepositories, withTransaction } from '@envvault/database';
import {
  type bulkActionInputSchema,
  type BulkResult,
  type listSecretsQuerySchema,
  SECRET_ERROR_CODES,
  SECRET_TRANSFER_ERROR_CODES,
  type SecretSelection,
} from '@envvault/shared';
import type { z } from 'zod';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ApiException } from '../common/api-exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  SecretAuthorizationService,
  type SecretRequestContext,
} from './secret-authorization.service.js';
import { conflict, notFound, SecretVault, STALE } from './secret-vault.service.js';

type BulkInput = z.output<typeof bulkActionInputSchema>;
type ListQuery = z.output<typeof listSecretsQuerySchema>;

const AUDIT_ACTIONS = {
  delete: 'secret.bulk_deleted',
  restore: 'secret.bulk_restored',
  update: 'secret.bulk_updated',
} as const;

/**
 * Metadata operations on many variables: delete, restore and category, tag
 * or required changes. Values are never touched. Requests name every
 * variable with the revision the caller saw; the whole batch is refused if
 * any variable is outside this environment, in the wrong state or changed
 * meanwhile, and applied in one transaction otherwise.
 */
@Injectable()
export class SecretBulkService {
  constructor(
    private readonly database: DatabaseService,
    private readonly vault: SecretVault,
    private readonly authorization: SecretAuthorizationService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /** Every variable matching the filters (not just one page), up to the bulk limit. */
  async selection(ctx: SecretRequestContext, query: ListQuery): Promise<SecretSelection> {
    const max = this.env.SECRET_BULK_MAX_ITEMS;
    const { items, total } = await this.vault.repos.secretBulk.selection(
      ctx.environment.scope,
      {
        status: query.status,
        q: query.q,
        types: query.type,
        categories: query.category,
        tag: query.tag,
      },
      max,
    );
    return { items, total, truncated: total > items.length };
  }

  async apply(ctx: SecretRequestContext, input: BulkInput): Promise<BulkResult> {
    const action = AUDIT_ACTIONS[input.action];
    await this.authorization.require(
      ctx,
      input.action === 'update' ? 'secret:write' : 'secret:delete',
      action,
    );
    if (input.items.length > this.env.SECRET_BULK_MAX_ITEMS) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        SECRET_TRANSFER_ERROR_CODES.SECRET_BULK_TOO_LARGE,
        `Bulk changes are limited to ${String(this.env.SECRET_BULK_MAX_ITEMS)} variables`,
      );
    }
    const scope = ctx.environment.scope;
    const ids = input.items.map((i) => i.id);
    const states = await this.vault.repos.secretBulk.byIds(scope, ids);
    // Mixed requests (ids from another environment or tenant) are refused whole.
    if (states.length !== ids.length) throw notFound();
    const expected = new Map(input.items.map((i) => [i.id, i.expectedRevision]));
    const wantDeleted = input.action === 'restore';
    if (states.some((s) => s.deleted !== wantDeleted)) {
      throw conflict(
        wantDeleted
          ? 'Some selected variables are not deleted.'
          : 'Some selected variables are deleted.',
      );
    }
    if (states.some((s) => s.revision !== expected.get(s.id))) throw conflict(STALE);
    if (input.action === 'restore') {
      const keys = states.map((s) => s.key);
      const taken = new Set(
        (await this.vault.repos.secretBulk.liveByKeys(scope, keys)).map((s) => s.key),
      );
      const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
      const blocked = [...new Set([...keys.filter((k) => taken.has(k)), ...repeated])];
      if (blocked.length > 0) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          SECRET_ERROR_CODES.SECRET_KEY_TAKEN,
          `These names are in use: ${blocked.slice(0, 10).join(', ')}${blocked.length > 10 ? ' …' : ''}`,
        );
      }
    }

    const secretIds = await this.vault.write(null, () =>
      withTransaction(
        this.database.client,
        async (tx) => {
          const repos = createRepositories(tx);
          const user = ctx.principal.userId;
          const changed =
            input.action === 'delete'
              ? await repos.secretBulk.softDelete(scope, input.items, user)
              : input.action === 'restore'
                ? await repos.secretBulk.restore(scope, input.items, user)
                : await repos.secretBulk.patch(scope, input.items, input.patch, user);
          if (changed.length !== input.items.length) throw conflict(STALE);
          await this.vault.auditBatch(
            repos,
            ctx,
            action,
            changed,
            {
              count: changed.length,
              ...(input.action === 'update'
                ? {
                    fields: Object.keys(input.patch),
                  }
                : {}),
            },
            { resourceType: 'environment' },
          );
          return changed;
        },
        { timeoutMs: 30_000 },
      ),
    );
    return { action: input.action, count: secretIds.length, secretIds };
  }
}
