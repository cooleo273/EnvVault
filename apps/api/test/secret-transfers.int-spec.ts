import { Logger } from '@nestjs/common';
import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  bulkResultSchema,
  exportResultSchema,
  importPreviewSchema,
  importResultSchema,
  revealedSecretSchema,
  secretListSchema,
  secretSelectionSchema,
  secretVersionPageSchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDotenv } from '../src/secrets/dotenv-format.js';
import { errorCode, Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const S1 = 'synthetic-import-one-6c1d';
const S2 = 'synthetic-import-two-90ab';
const S3 = 'synthetic-import-three-ee17';

let h: Harness;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    { SECRET_IMPORT_MAX_ENTRIES: '600', SECRET_BULK_READ_RATE_LIMIT: '100' },
    { encryption: { status: 'ready', provider } },
  );
  api = client(h);
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
});

async function reveal(user: Parameters<typeof api.call>[0], path: string, id: string) {
  return revealedSecretSchema.parse((await api.call(user, 'post', `${path}/${id}/reveal`)).body)
    .value;
}

async function idOf(path: string, user: Parameters<typeof api.call>[0], key: string) {
  const list = await api.ok(api.call(user, 'get', `${path}?pageSize=100`), 200, secretListSchema);
  const found = list.items.find((s) => s.key === key);
  if (!found) throw new Error(`no ${key}`);
  return found;
}

async function allText(): Promise<string> {
  const [secrets, versions, audits] = await Promise.all([
    h.db.secret.findMany(),
    h.db.secretVersion.findMany(),
    h.db.auditEvent.findMany(),
  ]);
  return [
    JSON.stringify(secrets),
    JSON.stringify(audits),
    ...versions.map((v) => Buffer.from(v.ciphertext).toString('utf8')),
  ].join('\n');
}

describe('import', () => {
  it('previews statuses without returning values', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    await api.createSecret(w.owner, path, { key: 'SAME', value: S1 });
    await api.createSecret(w.owner, path, { key: 'DIFFERENT', value: S1 });
    await api.createSecret(w.owner, path, { key: 'PORT', type: 'NUMBER', value: '80' });
    const content = [
      '# synthetic',
      `NEW_ONE=${S2}`,
      `SAME=${S1}`,
      `DIFFERENT=${S2}`,
      'PORT=not-a-number',
      `DUP=${S1}`,
      `DUP=${S3}`,
      'bad-name=x',
      'garbage line',
      `CERT="line1\nline2"`,
    ].join('\n');
    const response = await api.call(w.owner, 'post', `${path}/import/preview`, { content });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-import/);
    const preview = importPreviewSchema.parse(response.body);
    const status = Object.fromEntries(
      preview.entries.map((e) => [`${e.key}@${String(e.line)}`, e.status]),
    );
    expect(status).toEqual({
      'NEW_ONE@2': 'new',
      'SAME@3': 'unchanged',
      'DIFFERENT@4': 'changed',
      'PORT@5': 'invalid',
      'DUP@6': 'duplicate',
      'DUP@7': 'new',
      'bad-name@8': 'invalid',
      'CERT@10': 'new',
    });
    expect(preview.entries.find((e) => e.key === 'CERT')).toMatchObject({
      type: 'MULTILINE',
      multiline: true,
    });
    expect(preview.ignoredLines).toEqual([{ line: 9, reason: expect.any(String) }]);
    expect(preview.compared).toBe(true);
    expect(await allText()).not.toContain(S2);
  });

  it('imports selected entries atomically and encrypts every value', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    await api.createSecret(w.owner, path, { key: 'EXISTING', value: S1 });
    const existing = await idOf(path, w.owner, 'EXISTING');
    const content = `EXISTING=${S2}\nFRESH=${S3}\nSKIPPED=nope\n`;
    const result = await api.ok(
      api.call(w.owner, 'post', `${path}/import`, {
        content,
        category: 'Imported',
        tags: ['dotenv'],
        changeReason: 'initial import',
        items: [
          { action: 'overwrite', key: 'EXISTING', expectedRevision: existing.revision },
          { action: 'create', key: 'FRESH' },
        ],
      }),
      200,
      importResultSchema,
    );
    expect(result).toMatchObject({ created: 1, updated: 1 });
    expect(await reveal(w.owner, path, existing.id)).toBe(S2);
    const fresh = await idOf(path, w.owner, 'FRESH');
    expect(fresh).toMatchObject({ category: 'Imported', tags: ['dotenv'] });
    expect(await reveal(w.owner, path, fresh.id)).toBe(S3);
    const history = await api.ok(
      api.call(w.owner, 'get', `${path}/${existing.id}/versions`),
      200,
      secretVersionPageSchema,
    );
    expect(history.items[0]).toMatchObject({ origin: 'IMPORT', changeReason: 'initial import' });
    const actions = (await h.db.auditEvent.findMany({ where: { projectId: w.project } })).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['secret.import_started', 'secret.import_completed']),
    );
    const completed = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'secret.import_completed' },
    });
    expect(completed.metadata).toMatchObject({ created: 1, updated: 1, skipped: 1 });
    const text = await allText();
    expect(text).not.toContain(S2);
    expect(text).not.toContain(S3);
    expect(await h.db.secret.count({ where: { key: 'SKIPPED' } })).toBe(0);
  });

  it('rolls back everything when one entry is stale or invalid', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    await api.createSecret(w.owner, path, { key: 'EXISTING', value: S1 });
    const existing = await idOf(path, w.owner, 'EXISTING');
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${existing.id}`, { expectedRevision: 1, tags: ['x'] }),
      200,
    );
    const content = `A=${S2}\nEXISTING=${S3}\nB=bad\nPORT=x\n`;
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${path}/import`, {
          content,
          items: [
            { action: 'create', key: 'A' },
            { action: 'overwrite', key: 'EXISTING', expectedRevision: 1 },
          ],
        }),
        409,
      ),
    ).toBe('SECRET_IMPORT_REJECTED');
    // Creating an existing name is refused too.
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${path}/import`, {
          content,
          items: [{ action: 'create', key: 'EXISTING' }],
        }),
        409,
      ),
    ).toBe('SECRET_IMPORT_REJECTED');
    // A value that does not fit its type is refused before anything is written.
    await api.createSecret(w.owner, path, { key: 'PORT', type: 'NUMBER', value: '80' });
    const port = await idOf(path, w.owner, 'PORT');
    const invalid = await api.call(w.owner, 'post', `${path}/import`, {
      content,
      items: [
        { action: 'create', key: 'B' },
        { action: 'overwrite', key: 'PORT', expectedRevision: port.revision },
      ],
    });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain(S3);
    expect(await h.db.secret.count({ where: { key: { in: ['A', 'B'] } } })).toBe(0);
    expect(await reveal(w.owner, path, existing.id)).toBe(S1);
    expect(
      await h.db.auditEvent.count({
        where: { action: 'secret.import_failed', outcome: 'FAILURE' },
      }),
    ).toBe(3);
  });

  it('enforces permissions, protected environments and limits', async () => {
    const w = await api.world();
    const viewer = h.newUser('viewer');
    await api.addToProject(w, viewer, 'project-viewer');
    const content = `A=${S1}\n`;
    expect(
      await api.fails(
        api.call(viewer, 'post', `${w.secrets(w.dev)}/import/preview`, { content }),
        403,
      ),
    ).toBe('FORBIDDEN');
    // Project Admin has no write access to protected Production without a grant.
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${w.secrets(w.prod)}/import`, {
          content,
          items: [{ action: 'create', key: 'A' }],
        }),
        403,
      ),
    ).toBe('FORBIDDEN');
    const dev = h.newUser('dev');
    const membership = await api.addToProject(w, dev, 'project-developer');
    await api.grant(w, w.prod, membership, 'environment-writer');
    await api.createSecret(dev, w.secrets(w.prod), { key: 'A', value: S2 });
    // Without a step up, values in a protected environment are not compared.
    const preview = await api.ok(
      api.call(dev, 'post', `${w.secrets(w.prod)}/import/preview`, { content }),
      200,
      importPreviewSchema,
    );
    expect(preview).toMatchObject({ compared: false, entries: [{ key: 'A', status: 'exists' }] });

    const tooMany = Array.from({ length: 601 }, (_, i) => `K${String(i)}=v`).join('\n');
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${w.secrets(w.dev)}/import/preview`, { content: tooMany }),
        413,
      ),
    ).toBe('SECRET_IMPORT_TOO_LARGE');
    const big = `BIG="${'x'.repeat(300 * 1024)}"`;
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${w.secrets(w.dev)}/import/preview`, { content: big }),
        413,
      ),
    ).toBe('SECRET_IMPORT_TOO_LARGE');
  });

  it('imports 500 variables in one request', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const keys = Array.from({ length: 500 }, (_, i) => `BULK_${String(i).padStart(3, '0')}`);
    const content = keys.map((k) => `${k}=synthetic-${k.toLowerCase()}`).join('\n');
    const result = await api.ok(
      api.call(w.owner, 'post', `${path}/import`, {
        content,
        items: keys.map((key) => ({ action: 'create', key })),
      }),
      200,
      importResultSchema,
    );
    expect(result.created).toBe(500);
    expect(await h.db.secretVersion.count({ where: { origin: 'IMPORT' } })).toBe(500);
    // Every created id is in the audit trail, split across events under the size limit.
    const events = await h.db.auditEvent.findMany({
      where: { action: { in: ['secret.import_completed', 'secret.batch_items'] } },
    });
    const recorded = events.flatMap((e) => (e.metadata as { secretIds: string[] }).secretIds);
    expect(new Set(recorded)).toEqual(new Set(result.secretIds));
    expect(events).toHaveLength(2);
  });

  it('never logs import content', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level),
    );
    const stdout = vi.spyOn(process.stdout, 'write');
    try {
      const w = await api.world();
      const path = w.secrets(w.dev);
      await api.call(w.owner, 'post', `${path}/import/preview`, { content: `A=${S1}` });
      await api.call(w.owner, 'post', `${path}/import`, {
        content: `A=${S1}\nB={not json`,
        items: [{ action: 'create', key: 'A' }],
      });
      await api.call(w.owner, 'post', `${path}/import`, { content: `{"malformed": ${S2}` });
      const output = [...spies, stdout]
        .flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')))
        .join('\n');
      expect(output).not.toContain(S1);
      expect(output).not.toContain(S2);
    } finally {
      for (const spy of [...spies, stdout]) spy.mockRestore();
    }
  });
});

describe('export', () => {
  async function seeded() {
    const w = await api.world();
    const path = w.secrets(w.dev);
    await api.createSecret(w.owner, path, {
      key: 'API_URL',
      type: 'STRING',
      value: 'https://api.example.test',
    });
    await api.createSecret(w.owner, path, {
      key: 'PASSWORD',
      value: `${S1} with spaces # and hash`,
    });
    await api.createSecret(w.owner, path, { key: 'CERT', type: 'MULTILINE', value: 'a\nb\n' });
    await api.createSecret(w.owner, path, { key: 'NOT_SET' });
    return { w, path };
  }

  it('exports .env that imports back to the same values, with no-store and an audit event', async () => {
    const { w, path } = await seeded();
    const response = await api.call(w.owner, 'post', `${path}/export`, { format: 'dotenv' });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const result = exportResultSchema.parse(response.body);
    expect(result).toMatchObject({
      filename: 'development.env',
      count: 3,
      skipped: [{ key: 'NOT_SET', reason: 'No value set' }],
    });
    const parsed = Object.fromEntries(
      parseDotenv(result.content).assignments.map((a) => [a.key, a.value]),
    );
    expect(parsed).toEqual({
      API_URL: 'https://api.example.test',
      PASSWORD: `${S1} with spaces # and hash`,
      CERT: 'a\nb\n',
    });
    const event = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'secret.exported' } });
    expect(event).toMatchObject({ resourceType: 'environment', resourceId: w.dev });
    expect(event.metadata).toMatchObject({ format: 'dotenv', count: 3 });
    expect(JSON.stringify(event.metadata)).not.toContain(S1);
  });

  it('exports JSON and YAML and only the selected variables', async () => {
    const { w, path } = await seeded();
    const json = exportResultSchema.parse(
      (await api.call(w.owner, 'post', `${path}/export`, { format: 'json' })).body,
    );
    expect(JSON.parse(json.content)).toMatchObject({
      CERT: 'a\nb\n',
      API_URL: 'https://api.example.test',
    });
    const cert = await idOf(path, w.owner, 'CERT');
    const yaml = exportResultSchema.parse(
      (await api.call(w.owner, 'post', `${path}/export`, { format: 'yaml', secretIds: [cert.id] }))
        .body,
    );
    expect(yaml).toMatchObject({ filename: 'development.yaml', count: 1 });
    expect(yaml.content).toContain('"CERT": "a\\nb\\n"');
  });

  it('needs secret:export on top of secret:read, and direct grants in protected environments', async () => {
    const { w, path } = await seeded();
    const dev = h.newUser('dev');
    const membership = await api.addToProject(w, dev, 'project-developer');
    const id = (await idOf(path, w.owner, 'PASSWORD')).id;
    expect(await reveal(dev, path, id)).toContain(S1);
    expect(await api.fails(api.call(dev, 'post', `${path}/export`, { format: 'json' }), 403)).toBe(
      'FORBIDDEN',
    );
    const devUser = await h.db.user.findFirstOrThrow({ where: { email: dev.email } });
    const denied = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'secret.access_denied', actorUserId: devUser.id },
    });
    expect(denied.metadata).toMatchObject({
      attempted: 'secret.exported',
      permission: 'secret:export',
    });

    // The owner (Project Admin) cannot export Production without a grant.
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${w.secrets(w.prod)}/export`, { format: 'json' }),
        403,
      ),
    ).toBe('FORBIDDEN');
    await api.grant(w, w.prod, membership, 'environment-exporter');
    expect(
      await api.fails(
        api.call(dev, 'post', `${w.secrets(w.prod)}/export`, { format: 'json' }),
        403,
      ),
    ).toBe('STEP_UP_REQUIRED');
    await api.stepUp(dev);
    await api.ok(api.call(dev, 'post', `${w.secrets(w.prod)}/export`, { format: 'json' }), 200);
  });

  it('refuses ids from another environment instead of skipping them', async () => {
    const { w, path } = await seeded();
    const cert = await idOf(path, w.owner, 'CERT');
    const other = await api.world('other');
    const foreign = await api.createSecret(other.owner, other.secrets(other.dev), {
      key: 'FOREIGN',
      value: S3,
    });
    const response = await api.call(w.owner, 'post', `${path}/export`, {
      format: 'json',
      secretIds: [cert.id, foreign.id],
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(S3);
  });
});

describe('bulk actions', () => {
  it('selects across pages and applies changes with revision checks', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const content = Array.from(
      { length: 60 },
      (_, i) => `ITEM_${String(i).padStart(2, '0')}=v${String(i)}`,
    ).join('\n');
    const keys = parseDotenv(content).assignments.map((a) => a.key);
    await api.ok(
      api.call(w.owner, 'post', `${path}/import`, {
        content,
        items: keys.map((key) => ({ action: 'create', key })),
      }),
      200,
    );
    const selection = await api.ok(
      api.call(w.owner, 'get', `${path}/selection?q=ITEM_`),
      200,
      secretSelectionSchema,
    );
    expect(selection).toMatchObject({ total: 60, truncated: false });
    expect(selection.items).toHaveLength(60);
    const items = selection.items.map((i) => ({ id: i.id, expectedRevision: i.revision }));

    const updated = await api.ok(
      api.call(w.owner, 'post', `${path}/bulk`, {
        action: 'update',
        items,
        patch: { category: 'Bulk', addTags: ['batch'] },
      }),
      200,
      bulkResultSchema,
    );
    expect(updated.count).toBe(60);
    // Revisions moved on: replaying the old ones is refused as a whole.
    expect(
      await api.fails(api.call(w.owner, 'post', `${path}/bulk`, { action: 'delete', items }), 409),
    ).toBe('SECRET_CONFLICT');
    const fresh = await api.ok(
      api.call(w.owner, 'get', `${path}/selection`),
      200,
      secretSelectionSchema,
    );
    const freshItems = fresh.items.map((i) => ({ id: i.id, expectedRevision: i.revision }));
    await api.ok(
      api.call(w.owner, 'post', `${path}/bulk`, { action: 'delete', items: freshItems }),
      200,
    );
    expect((await api.ok(api.call(w.owner, 'get', path), 200, secretListSchema)).total).toBe(0);
    const deleted = await api.ok(
      api.call(w.owner, 'get', `${path}/selection?status=deleted`),
      200,
      secretSelectionSchema,
    );
    await api.ok(
      api.call(w.owner, 'post', `${path}/bulk`, {
        action: 'restore',
        items: deleted.items.map((i) => ({ id: i.id, expectedRevision: i.revision })),
      }),
      200,
    );
    const list = await api.ok(
      api.call(w.owner, 'get', `${path}?pageSize=100`),
      200,
      secretListSchema,
    );
    expect(list.total).toBe(60);
    expect(list.items.every((s) => s.category === 'Bulk' && s.tags.includes('batch'))).toBe(true);
    const actions = (await h.db.auditEvent.findMany({ where: { projectId: w.project } })).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'secret.bulk_updated',
        'secret.bulk_deleted',
        'secret.bulk_restored',
      ]),
    );
  });

  it('refuses mixed resources, wrong states, name conflicts and missing permissions', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const a = await api.createSecret(w.owner, path, { key: 'A', value: 'x' });
    const other = await api.world('other');
    const foreign = await api.createSecret(other.owner, other.secrets(other.dev), {
      key: 'F',
      value: 'x',
    });
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${path}/bulk`, {
          action: 'delete',
          items: [
            { id: a.id, expectedRevision: 1 },
            { id: foreign.id, expectedRevision: 1 },
          ],
        }),
        404,
      ),
    ).toBe('NOT_FOUND');
    expect((await h.db.secret.findUniqueOrThrow({ where: { id: a.id } })).deletedAt).toBeNull();
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${path}/bulk`, {
          action: 'restore',
          items: [{ id: a.id, expectedRevision: 1 }],
        }),
        409,
      ),
    ).toBe('SECRET_CONFLICT');

    await api.ok(api.call(w.owner, 'delete', `${path}/${a.id}`), 204);
    await api.createSecret(w.owner, path, { key: 'A', value: 'y' });
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${path}/bulk`, {
          action: 'restore',
          items: [{ id: a.id, expectedRevision: 2 }],
        }),
        409,
      ),
    ).toBe('SECRET_KEY_TAKEN');

    const dev = h.newUser('dev');
    await api.addToProject(w, dev, 'project-developer');
    const b = await api.createSecret(w.owner, path, { key: 'B', value: 'x' });
    expect(
      await api.fails(
        api.call(dev, 'post', `${path}/bulk`, {
          action: 'delete',
          items: [{ id: b.id, expectedRevision: 1 }],
        }),
        403,
      ),
    ).toBe('FORBIDDEN');
    await api.ok(
      api.call(dev, 'post', `${path}/bulk`, {
        action: 'update',
        items: [{ id: b.id, expectedRevision: 1 }],
        patch: { isRequired: true },
      }),
      200,
    );
    const malformed = await api.call(dev, 'post', `${path}/bulk`, { action: 'delete', items: [] });
    expect(errorCode(malformed.body)).toBe('BAD_REQUEST');
  });
});
