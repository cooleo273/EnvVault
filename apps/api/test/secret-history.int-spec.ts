import { generateKeyring, LocalKeyProvider, rotateKeyring } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  revealedSecretSchema,
  revealedVersionSchema,
  secretSummarySchema,
  secretVersionPageSchema,
  versionComparisonSchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from './support/harness.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const V1 = 'synthetic-history-v1-a4c2';
const V2 = 'synthetic-history-v2-71fe';
const V3 = 'synthetic-history-v3-0d9b';

let h: Harness;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
  api = client(h);
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
});

/** A variable with three versions (V1, V2, V3) in Development. */
async function threeVersions() {
  const w = await api.world();
  const owner = w.owner;
  const path = w.secrets(w.dev);
  const { id } = await api.createSecret(owner, path, { key: 'ROTATED', value: V1 });
  await api.ok(
    api.call(owner, 'patch', `${path}/${id}`, {
      expectedRevision: 1,
      value: V2,
      changeReason: 'rotate',
    }),
    200,
  );
  await api.ok(api.call(owner, 'patch', `${path}/${id}`, { expectedRevision: 2, value: V3 }), 200);
  const page = await api.ok(
    api.call(owner, 'get', `${path}/${id}/versions`),
    200,
    secretVersionPageSchema,
  );
  const byNumber = (n: number) => page.items.find((v) => v.version === n)?.id ?? '';
  return { w, path, id, v1: byNumber(1), v2: byNumber(2), v3: byNumber(3) };
}

describe('history', () => {
  it('lists versions newest first with provenance and pages without decrypting', async () => {
    const { w, path, id } = await threeVersions();
    const first = await api.ok(
      api.call(w.owner, 'get', `${path}/${id}/versions?limit=2`),
      200,
      secretVersionPageSchema,
    );
    expect(first.items.map((v) => [v.version, v.origin, v.isCurrent])).toEqual([
      [3, 'UPDATE', true],
      [2, 'UPDATE', false],
    ]);
    expect(first.items[1]).toMatchObject({ changeReason: 'rotate', keyVersion: 1 });
    expect(first).toMatchObject({ total: 3, nextBefore: 2 });
    const rest = await api.ok(
      api.call(w.owner, 'get', `${path}/${id}/versions?before=2`),
      200,
      secretVersionPageSchema,
    );
    expect(rest.items).toMatchObject([{ version: 1, origin: 'CREATE' }]);
    expect(JSON.stringify([first, rest])).not.toMatch(/synthetic-history/);
  });

  it('reveals a historical value only with value read access, and audits it', async () => {
    const { w, path, id, v1 } = await threeVersions();
    const value = await api.ok(
      api.call(w.owner, 'post', `${path}/${id}/versions/${v1}/reveal`),
      200,
      revealedVersionSchema,
    );
    expect(value).toMatchObject({ version: 1, value: V1 });
    const viewer = h.newUser('viewer');
    await api.addToProject(w, viewer, 'project-viewer');
    await api.ok(api.call(viewer, 'get', `${path}/${id}/versions`), 200);
    expect(
      await api.fails(api.call(viewer, 'post', `${path}/${id}/versions/${v1}/reveal`), 403),
    ).toBe('FORBIDDEN');
    // A version id of another secret is not found under this one.
    const other = await api.createSecret(w.owner, path, { key: 'OTHER', value: 'x' });
    expect(
      await api.fails(api.call(w.owner, 'post', `${path}/${other.id}/versions/${v1}/reveal`), 404),
    ).toBe('NOT_FOUND');
    const events = await h.db.auditEvent.findMany({ where: { resourceId: id } });
    expect(events.map((e) => `${e.action}:${e.outcome}`)).toEqual(
      expect.arrayContaining(['secret.version_revealed:SUCCESS', 'secret.access_denied:DENIED']),
    );
    expect(JSON.stringify(events)).not.toContain(V1);
  });

  it('compares versions on the server without returning values', async () => {
    const { w, path, id, v1, v2 } = await threeVersions();
    const different = await api.ok(
      api.call(w.owner, 'post', `${path}/${id}/versions/compare`, {
        fromVersionId: v1,
        toVersionId: v2,
      }),
      200,
      versionComparisonSchema,
    );
    expect(different).toMatchObject({ sameValue: false, from: { version: 1 }, to: { version: 2 } });
    expect(JSON.stringify(different)).not.toMatch(/synthetic-history/);
    // Roll back to v1, then v1 and v4 are equal.
    await api.ok(
      api.call(w.owner, 'post', `${path}/${id}/rollback`, { versionId: v1, expectedRevision: 3 }),
      200,
    );
    const page = await api.ok(
      api.call(w.owner, 'get', `${path}/${id}/versions`),
      200,
      secretVersionPageSchema,
    );
    const v4 = page.items[0]?.id ?? '';
    const same = await api.ok(
      api.call(w.owner, 'post', `${path}/${id}/versions/compare`, {
        fromVersionId: v1,
        toVersionId: v4,
      }),
      200,
      versionComparisonSchema,
    );
    expect(same.sameValue).toBe(true);
  });
});

describe('rollback', () => {
  it('appends a new version with the old value and leaves history untouched', async () => {
    const { w, path, id, v1 } = await threeVersions();
    const before = await h.db.secretVersion.findMany({
      where: { secretId: id },
      orderBy: { versionNumber: 'asc' },
    });
    const summary = await api.ok(
      api.call(w.owner, 'post', `${path}/${id}/rollback`, {
        versionId: v1,
        expectedRevision: 3,
        changeReason: 'bad rotation',
      }),
      200,
      secretSummarySchema,
    );
    expect(summary).toMatchObject({ currentVersion: 4, revision: 4 });
    expect(
      revealedSecretSchema.parse((await api.call(w.owner, 'post', `${path}/${id}/reveal`)).body)
        .value,
    ).toBe(V1);
    const page = await api.ok(
      api.call(w.owner, 'get', `${path}/${id}/versions`),
      200,
      secretVersionPageSchema,
    );
    expect(page.items[0]).toMatchObject({
      version: 4,
      origin: 'ROLLBACK',
      restoredFromVersion: 1,
      changeReason: 'bad rotation',
      isCurrent: true,
    });
    const after = await h.db.secretVersion.findMany({
      where: { secretId: id, versionNumber: { lte: 3 } },
      orderBy: { versionNumber: 'asc' },
    });
    expect(after).toEqual(before);
    // The rollback has its own ciphertext; nothing was copied.
    const v4 = await h.db.secretVersion.findFirstOrThrow({
      where: { secretId: id, versionNumber: 4 },
    });
    expect(Buffer.from(v4.ciphertext).equals(Buffer.from(before[0]?.ciphertext ?? []))).toBe(false);
    const event = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'secret.rolled_back' },
    });
    expect(event.metadata).toMatchObject({ restoredVersion: 1, previousVersion: 3, version: 4 });
    expect(JSON.stringify(event)).not.toContain(V1);
  });

  it('prevents lost updates: concurrent rollbacks, stale revisions and no op rollbacks', async () => {
    const { w, path, id, v1, v2 } = await threeVersions();
    const results = await Promise.all(
      [v1, v2].map(
        async (versionId) =>
          (
            await api.call(w.owner, 'post', `${path}/${id}/rollback`, {
              versionId,
              expectedRevision: 3,
            })
          ).status,
      ),
    );
    expect(results.sort()).toEqual([200, 409]);
    expect(await h.db.secretVersion.count({ where: { secretId: id } })).toBe(4);
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${path}/${id}/rollback`, { versionId: v1, expectedRevision: 3 }),
        409,
      ),
    ).toBe('SECRET_CONFLICT');
    const page = await api.ok(
      api.call(w.owner, 'get', `${path}/${id}/versions`),
      200,
      secretVersionPageSchema,
    );
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${path}/${id}/rollback`, {
          versionId: page.items[0]?.id,
          expectedRevision: 4,
        }),
        409,
      ),
    ).toBe('SECRET_ROLLBACK_NOOP');
  });

  it('refuses a value that no longer fits the type', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const { id } = await api.createSecret(w.owner, path, { key: 'PORT', value: 'not a number' });
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${id}`, {
        expectedRevision: 1,
        type: 'NUMBER',
        value: '8080',
      }),
      200,
    );
    const page = await api.ok(
      api.call(w.owner, 'get', `${path}/${id}/versions`),
      200,
      secretVersionPageSchema,
    );
    const v1 = page.items.find((v) => v.version === 1)?.id;
    const refused = await api.call(w.owner, 'post', `${path}/${id}/rollback`, {
      versionId: v1,
      expectedRevision: 2,
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toContain('not a number');
  });

  it('needs secret:rollback, and a direct grant in protected environments', async () => {
    const w = await api.world();
    const dev = h.newUser('dev');
    const membership = await api.addToProject(w, dev, 'project-developer');
    const path = w.secrets(w.dev);
    const { id } = await api.createSecret(dev, path, { key: 'K', value: V1 });
    await api.ok(api.call(dev, 'patch', `${path}/${id}`, { expectedRevision: 1, value: V2 }), 200);
    const page = await api.ok(
      api.call(dev, 'get', `${path}/${id}/versions`),
      200,
      secretVersionPageSchema,
    );
    const v1 = page.items.find((v) => v.version === 1)?.id;
    // Developers write values but do not hold secret:rollback.
    expect(
      await api.fails(
        api.call(dev, 'post', `${path}/${id}/rollback`, { versionId: v1, expectedRevision: 2 }),
        403,
      ),
    ).toBe('FORBIDDEN');

    await api.grant(w, w.prod, membership, 'environment-writer');
    const prodPath = w.secrets(w.prod);
    const prod = await api.createSecret(dev, prodPath, { key: 'P', value: V1 });
    await api.ok(
      api.call(dev, 'patch', `${prodPath}/${prod.id}`, { expectedRevision: 1, value: V2 }),
      200,
    );
    const prodPage = await api.ok(
      api.call(dev, 'get', `${prodPath}/${prod.id}/versions`),
      200,
      secretVersionPageSchema,
    );
    const p1 = prodPage.items.find((v) => v.version === 1)?.id;
    await api.ok(
      api.call(dev, 'post', `${prodPath}/${prod.id}/rollback`, {
        versionId: p1,
        expectedRevision: 2,
      }),
      200,
    );
    // The owner administers the project, yet has no rollback right in Production.
    expect(
      await api.fails(
        api.call(w.owner, 'post', `${prodPath}/${prod.id}/rollback`, {
          versionId: p1,
          expectedRevision: 3,
        }),
        403,
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('key versions', () => {
  it('rolls back across a key rotation: encrypts again under the active key, old versions still open', async () => {
    const keyring = generateKeyring();
    const before = await Harness.start(
      {},
      {
        encryption: {
          status: 'ready',
          provider: new LocalKeyProvider(keyring, { nodeEnv: 'test' }),
        },
      },
    );
    let after: Harness | undefined;
    try {
      const first = client(before);
      const w = await first.world('rotation');
      const path = w.secrets(w.dev);
      const { id } = await first.createSecret(w.owner, path, { key: 'K', value: V1 });
      await first.ok(
        first.call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 1, value: V2 }),
        200,
      );
      await before.stop();

      after = await Harness.start(
        {},
        {
          encryption: {
            status: 'ready',
            provider: new LocalKeyProvider(rotateKeyring(keyring), { nodeEnv: 'test' }),
          },
        },
      );
      after.neon.addUser(w.owner.email, w.owner.password, w.owner.sub);
      const owner = {
        ...w.owner,
        token: () =>
          after!.neon.issueToken({
            sub: w.owner.sub,
            email: w.owner.email,
            emailVerified: true,
          }),
      };
      const second = client(after);
      const page = await second.ok(
        second.call(owner, 'get', `${path}/${id}/versions`),
        200,
        secretVersionPageSchema,
      );
      const v1 = page.items.find((v) => v.version === 1)?.id ?? '';
      expect(page.items.map((v) => v.keyVersion)).toEqual([1, 1]);
      await second.ok(
        second.call(owner, 'post', `${path}/${id}/rollback`, {
          versionId: v1,
          expectedRevision: 2,
        }),
        200,
      );
      const rotated = await second.ok(
        second.call(owner, 'get', `${path}/${id}/versions`),
        200,
        secretVersionPageSchema,
      );
      expect(rotated.items[0]).toMatchObject({ version: 3, origin: 'ROLLBACK', keyVersion: 2 });
      expect(
        revealedSecretSchema.parse((await second.call(owner, 'post', `${path}/${id}/reveal`)).body)
          .value,
      ).toBe(V1);
      const old = await second.ok(
        second.call(owner, 'post', `${path}/${id}/versions/${v1}/reveal`),
        200,
        revealedVersionSchema,
      );
      expect(old.value).toBe(V1);
    } finally {
      await after?.stop();
    }
  });
});

describe('rate limits', () => {
  it('limits reveals per user and variable, and audits the block once', async () => {
    const limited = await Harness.start(
      { SECRET_REVEAL_RESOURCE_RATE_LIMIT: '3', SECRET_REVEAL_RATE_LIMIT: '7' },
      {
        encryption: {
          status: 'ready',
          provider: new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' }),
        },
      },
    );
    try {
      const l = client(limited);
      await truncateAllTables(limited.db);
      const w = await l.world('limited');
      const path = w.secrets(w.dev);
      const a = await l.createSecret(w.owner, path, { key: 'A', value: V1 });
      const b = await l.createSecret(w.owner, path, { key: 'B', value: V2 });
      for (let i = 0; i < 3; i++)
        await l.ok(l.call(w.owner, 'post', `${path}/${a.id}/reveal`), 200);
      const blocked = await l.call(w.owner, 'post', `${path}/${a.id}/reveal`);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.stringify(blocked.body)).not.toContain(V1);
      await l.ok(l.call(w.owner, 'post', `${path}/${a.id}/reveal`), 429);
      // Another variable still works until the per user limit (7 attempts, refused ones count).
      await l.ok(l.call(w.owner, 'post', `${path}/${b.id}/reveal`), 200);
      await l.ok(l.call(w.owner, 'post', `${path}/${b.id}/reveal`), 200);
      expect((await l.call(w.owner, 'post', `${path}/${b.id}/reveal`)).status).toBe(429);
      // Another user has their own budget.
      const dev = limited.newUser('dev2');
      await l.addToProject(w, dev, 'project-developer');
      await l.ok(l.call(dev, 'post', `${path}/${a.id}/reveal`), 200);
      const events = await limited.db.auditEvent.findMany({
        where: { action: 'secret.access_denied', resourceId: a.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toMatchObject({ reason: 'rate_limited' });
    } finally {
      await limited.stop();
    }
  });
});
