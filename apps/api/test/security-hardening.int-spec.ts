import { randomUUID } from 'node:crypto';
import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { createRepositories } from '@envvault/database';
import { truncateAllTables } from '@envvault/database/testing';
import { createdSecretSchema, secretListSchema } from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SecretAuthorizationService } from '../src/secrets/secret-authorization.service.js';
import { errorCode, Harness, type TestUser } from './support/harness.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const VALUE = 'synthetic-hardening-value-5c1d';

let h: Harness;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    {
      STEP_UP_RATE_LIMIT: '2',
      SNAPSHOT_RESTORE_RATE_LIMIT: '1',
      ACCESS_CHANGE_RATE_LIMIT: '3',
    },
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

async function send(
  user: TestUser,
  method: 'post' | 'patch',
  path: string,
  body: object,
  key?: string,
) {
  const request = h
    .api()
    [method](`/api/v1${path}`)
    .set('Authorization', await h.bearer(user));
  if (key) request.set('Idempotency-Key', key);
  return request.send(body);
}

describe('idempotency keys', () => {
  it('replays a retried create instead of creating twice', async () => {
    const w = await api.world('idem');
    const key = `create-${randomUUID()}`;
    const first = await send(w.owner, 'post', w.secrets(w.dev), { key: 'IDEM', value: VALUE }, key);
    expect(first.status).toBe(201);
    const retry = await send(w.owner, 'post', w.secrets(w.dev), { key: 'IDEM', value: VALUE }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(createdSecretSchema.parse(retry.body).id).toBe(createdSecretSchema.parse(first.body).id);
    expect(await h.db.secret.count()).toBe(1);
    expect(await h.db.secretVersion.count()).toBe(1);

    const stored = await h.db.idempotencyRecord.findMany();
    expect(stored).toHaveLength(1);
    expect(
      JSON.stringify(stored, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain(VALUE);
  });

  it('refuses a key reused for a different request, and malformed keys', async () => {
    const w = await api.world('idem-reuse');
    const key = `reuse-${randomUUID()}`;
    expect(
      (await send(w.owner, 'post', w.secrets(w.dev), { key: 'A', value: VALUE }, key)).status,
    ).toBe(201);
    const other = await send(w.owner, 'post', w.secrets(w.dev), { key: 'B', value: VALUE }, key);
    expect(other.status).toBe(422);
    expect(errorCode(other.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    const bad = await send(w.owner, 'post', w.secrets(w.dev), { key: 'C', value: VALUE }, 'short');
    expect(errorCode(bad.body)).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(await h.db.secret.count()).toBe(1);
  });

  it('frees the key when the request fails, and scopes keys per user', async () => {
    const w = await api.world('idem-fail');
    const key = `fail-${randomUUID()}`;
    const invalid = await send(
      w.owner,
      'post',
      w.secrets(w.dev),
      { key: '1 bad', value: VALUE },
      key,
    );
    expect(invalid.status).toBe(400);
    expect(
      (await send(w.owner, 'post', w.secrets(w.dev), { key: 'GOOD', value: VALUE }, key)).status,
    ).toBe(201);
    const second = await api.world('idem-other');
    const theirs = await send(
      second.owner,
      'post',
      second.secrets(second.dev),
      { key: 'GOOD', value: VALUE },
      key,
    );
    expect(theirs.status).toBe(201);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('per user rate limits', () => {
  it('limits password confirmations per user, not per address', async () => {
    const w = await api.world('limits');
    const other = (await api.world('limits-b')).owner;
    const attempt = (user: TestUser) =>
      api.call(user, 'post', '/auth/step-up', { password: user.password });
    expect((await attempt(w.owner)).status).toBe(200);
    expect((await attempt(w.owner)).status).toBe(200);
    const limited = await attempt(w.owner);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Same client address (the test server), different user: not affected.
    expect((await attempt(other)).status).toBe(200);
    await attempt(w.owner);
    const events = await h.db.auditEvent.findMany({ where: { action: 'security.rate_limited' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ limitedAction: 'step-up' });
  });

  it('limits snapshot restores after authorization', async () => {
    const w = await api.world('restore-limit');
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'R', value: VALUE });
    const base = `/workspaces/${w.ws}/projects/${w.project}/environments/${w.dev}`;
    const snap = await api.ok(
      api.call(w.owner, 'post', `${base}/snapshots`, {}),
      201,
      z.object({ id: z.uuid() }),
    );
    const restore = async () => {
      const preview = await api.ok(
        api.call(w.owner, 'post', `${base}/snapshots/${snap.id}/restore/preview`, {}),
        200,
        z.object({ expectedState: z.array(z.object({ id: z.uuid(), revision: z.number() })) }),
      );
      return api.call(w.owner, 'post', `${base}/snapshots/${snap.id}/restore`, {
        expectedState: preview.expectedState,
        removeAdded: true,
      });
    };
    expect((await restore()).status).not.toBe(429);
    expect((await restore()).status).toBe(429);

    const viewer = h.newUser('restore-viewer');
    await api.addToProject(w, viewer, 'project-viewer');
    const denied = await api.call(viewer, 'post', `${base}/snapshots/${snap.id}/restore`, {
      expectedState: [],
      removeAdded: true,
    });
    // No write access: refused as forbidden, never as rate limited.
    expect(denied.status).toBe(403);
  });
});

describe('access checked again at write time', () => {
  it('stops a mutation whose access was revoked after the request was authorized', async () => {
    const w = await api.world('toctou');
    const dev = h.newUser('toctou-dev');
    await api.addToProject(w, dev, 'project-developer');
    const user = await h.db.user.findFirstOrThrow({ where: { email: dev.email } });
    const scope = { workspaceId: w.ws, projectId: w.project, environmentId: w.dev };
    const ctx = {
      principal: {
        userId: user.id,
        authUserId: dev.sub,
        email: dev.email,
        emailVerified: true,
        tokenIssuedAt: new Date(),
      },
      environment: {
        scope,
        permissions: new Set(['secret:write']),
        isProtected: false,
        archived: false,
      },
      requestId: 'toctou-test',
    } as never;
    const authorization = h.app.get(SecretAuthorizationService);
    await expect(
      authorization.recheck(
        ctx,
        createRepositories(h.db),
        ['secret:write'],
        'secret.import_started',
      ),
    ).resolves.toBeUndefined();

    await h.db.projectMembership.deleteMany({
      where: { projectId: w.project, workspaceMembership: { userId: user.id } },
    });
    await expect(
      authorization.recheck(
        ctx,
        createRepositories(h.db),
        ['secret:write'],
        'secret.import_started',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const denied = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'secret.access_denied', actorUserId: user.id },
    });
    expect(denied.metadata).toMatchObject({ reason: 'access_changed' });
  });
});

describe('object level authorization on Phase 3D and 3E routes', () => {
  it('never resolves another workspace’s snapshots, rules or retention runs', async () => {
    const a = await api.world('idor-a');
    const b = await api.world('idor-b');
    await api.createSecret(a.owner, a.secrets(a.dev), { key: 'A', value: VALUE });
    const aBase = `/workspaces/${a.ws}/projects/${a.project}/environments/${a.dev}`;
    const bBase = `/workspaces/${b.ws}/projects/${b.project}/environments/${b.dev}`;
    const snap = await api.ok(
      api.call(a.owner, 'post', `${aBase}/snapshots`, {}),
      201,
      z.object({ id: z.uuid() }),
    );

    // B's own path with A's snapshot id: not found, nothing about A leaks.
    for (const path of [`${bBase}/snapshots/${snap.id}`, `${bBase}/snapshots/${snap.id}/diff`]) {
      const response = path.endsWith('diff')
        ? await api.call(b.owner, 'post', path, {})
        : await api.call(b.owner, 'get', path);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(a.ws);
    }
    // A's path as B: not a member, so the workspace itself is not found.
    for (const path of [
      `${aBase}/snapshots`,
      `${aBase}/validation-rules`,
      `/workspaces/${a.ws}/retention`,
    ]) {
      expect((await api.call(b.owner, 'get', path)).status).toBe(404);
    }
    const compare = await api.call(
      b.owner,
      'post',
      `/workspaces/${b.ws}/projects/${b.project}/environments/compare`,
      {
        sourceEnvironmentId: b.dev,
        targetEnvironmentId: a.dev,
      },
    );
    expect(compare.status).toBe(404);
  });

  it('audits refused requests of members once per route and minute', async () => {
    const w = await api.world('refused');
    const member = h.newUser('refused-member');
    await api.join(w.owner, w.ws, member);
    for (let i = 0; i < 3; i++) {
      expect((await api.call(member, 'get', `/workspaces/${w.ws}/retention`)).status).toBe(403);
    }
    const events = await h.db.auditEvent.findMany({ where: { action: 'authz.denied' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspaceId: w.ws, outcome: 'DENIED' });
    expect(events[0]?.metadata).toEqual({ route: 'GET /api/v1/workspaces/:workspaceId/retention' });
  });

  it('requires authentication on every new route', async () => {
    const id = randomUUID();
    for (const [method, path] of [
      ['get', `/workspaces/${id}/retention`],
      ['post', `/workspaces/${id}/retention/runs`],
      ['post', `/workspaces/${id}/projects/${id}/environments/compare`],
      ['post', `/workspaces/${id}/projects/${id}/environments/${id}/snapshots/${id}/restore`],
    ] as const) {
      const response = await h.api()[method](`/api/v1${path}`).send({});
      expect(response.status).toBe(401);
    }
  });
});

describe('input handling', () => {
  it('rejects oversized and malformed bodies without echoing them', async () => {
    const w = await api.world('input');
    const big = await h
      .api()
      .post(`/api/v1${w.secrets(w.dev)}`)
      .set('Authorization', await h.bearer(w.owner))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ key: 'BIG', value: 'x'.repeat(200 * 1024) }));
    expect(big.status).toBe(413);
    const malformed = await h
      .api()
      .post(`/api/v1${w.secrets(w.dev)}`)
      .set('Authorization', await h.bearer(w.owner))
      .set('Content-Type', 'application/json')
      .send('{"key":"X","value":"synthetic-malformed-77');
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toContain('synthetic-malformed');
  });

  it('ignores or refuses fields a client must not set', async () => {
    const w = await api.world('mass');
    const b = await api.world('mass-b');
    const response = await api.call(w.owner, 'post', w.secrets(w.dev), {
      key: 'MASS',
      value: VALUE,
      workspaceId: b.ws,
      environmentId: b.dev,
      createdByUserId: randomUUID(),
      revision: 99,
      currentVersionId: randomUUID(),
    });
    if (response.status === 201) {
      const row = await h.db.secret.findFirstOrThrow({ where: { key: 'MASS' } });
      const owner = await h.db.user.findFirstOrThrow({ where: { email: w.owner.email } });
      expect(row).toMatchObject({
        workspaceId: w.ws,
        environmentId: w.dev,
        createdByUserId: owner.id,
        revision: 1,
      });
    } else {
      expect(response.status).toBe(400);
    }
    const list = await api.ok(api.call(b.owner, 'get', b.secrets(b.dev)), 200, secretListSchema);
    expect(list.total).toBe(0);
    expect(
      (
        await api.call(w.owner, 'put', `/workspaces/${w.ws}/retention`, {
          deletedSecretDays: null,
          versionKeepCount: null,
          versionMinAgeDays: null,
          snapshotDays: null,
          auditDays: null,
          includeProtected: false,
          workspaceId: b.ws,
        })
      ).status,
    ).toBe(400);
  });
});
