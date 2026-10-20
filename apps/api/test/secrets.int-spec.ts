import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { Logger } from '@nestjs/common';
import { generateKeyring, LocalKeyProvider, writeKeyringFile } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  createdSecretSchema,
  environmentSummarySchema,
  issuedInvitationSchema,
  paginatedSchema,
  revealedSecretSchema,
  secretListSchema,
  secretSummarySchema,
  secretVersionSchema,
  workspaceMemberSchema,
  workspaceSummarySchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseEnv } from '../src/config/env.js';
import { loadEncryption } from '../src/encryption/encryption.config.js';
import { SecretEncryptionService } from '../src/encryption/secret-encryption.service.js';
import { errorCode, Harness, type TestUser } from './support/harness.js';

// Synthetic values only. Never use real credentials in tests.
const SYNTHETIC = 'synthetic-db-password-9c41e2';
const SYNTHETIC_2 = 'synthetic-rotated-value-55ab';

let h: Harness;
let provider: LocalKeyProvider;

beforeAll(async () => {
  provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start({}, { encryption: { status: 'ready', provider } });
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
});

/* ------------------------------------------------------------------ helpers */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

async function call(user: TestUser, method: Method, path: string, body?: object, harness = h) {
  const req = harness
    .api()
    [method](`/api/v1${path}`)
    .set('Authorization', await harness.bearer(user));
  return body === undefined ? req : req.send(body);
}

async function ok<T>(
  promise: Promise<{ status: number; body: unknown }>,
  status: number,
  schema?: z.ZodType<T>,
) {
  const response = await promise;
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return (schema ? schema.parse(response.body) : response.body) as T;
}

async function fails(promise: Promise<{ status: number; body: unknown }>, status: number) {
  const response = await promise;
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return errorCode(response.body);
}

async function join(owner: TestUser, workspaceId: string, user: TestUser, roleKey = 'member') {
  const issued = await ok(
    call(owner, 'post', `/workspaces/${workspaceId}/invitations`, { email: user.email, roleKey }),
    201,
    issuedInvitationSchema,
  );
  const token = new URL(issued.acceptUrl ?? '').hash.replace('#token=', '');
  await ok(call(user, 'post', '/invitations/accept', { token }), 200);
  const members = await ok(
    call(owner, 'get', `/workspaces/${workspaceId}/members`),
    200,
    z.array(workspaceMemberSchema),
  );
  const found = members.find((m) => m.user.email === user.email);
  if (!found) throw new Error('join failed');
  return found.id;
}

interface World {
  owner: TestUser;
  ws: string;
  project: string;
  dev: string;
  prod: string;
  /** `/workspaces/:ws/projects/:p/environments/:env/secrets` */
  secrets: (env: string) => string;
}

/** Owner creates a workspace and a project (becoming its Project Admin) with Development and protected Production. */
async function world(label = 'acme'): Promise<World> {
  const owner = h.newUser(`${label}-owner`);
  const workspace = await ok(
    call(owner, 'post', '/workspaces', { name: label }),
    201,
    workspaceSummarySchema,
  );
  const project = await ok(
    call(owner, 'post', `/workspaces/${workspace.id}/projects`, {
      name: 'Backend',
      environments: [
        { name: 'Development', kind: 'DEVELOPMENT' },
        { name: 'Production', kind: 'PRODUCTION', isProtected: true },
      ],
    }),
    201,
    z.object({ id: z.uuid() }),
  );
  const envs = await ok(
    call(owner, 'get', `/workspaces/${workspace.id}/projects/${project.id}/environments`),
    200,
    paginatedSchema(environmentSummarySchema),
  );
  const byName = (name: string) => envs.items.find((e) => e.name === name)?.id ?? '';
  const base = `/workspaces/${workspace.id}/projects/${project.id}/environments`;
  return {
    owner,
    ws: workspace.id,
    project: project.id,
    dev: byName('Development'),
    prod: byName('Production'),
    secrets: (env) => `${base}/${env}/secrets`,
  };
}

async function addToProject(w: World, user: TestUser, roleKey: string, workspaceRole = 'member') {
  const membershipId = await join(w.owner, w.ws, user, workspaceRole);
  const member = await ok(
    call(w.owner, 'post', `/workspaces/${w.ws}/projects/${w.project}/members`, {
      workspaceMembershipId: membershipId,
      roleKey,
    }),
    201,
    z.object({ id: z.uuid() }),
  );
  return { membershipId, projectMemberId: member.id };
}

async function grant(
  w: World,
  env: string,
  membershipId: string,
  roleKey: string,
  effect: 'ALLOW' | 'DENY' = 'ALLOW',
) {
  await ok(
    call(w.owner, 'post', `/workspaces/${w.ws}/projects/${w.project}/environments/${env}/access`, {
      workspaceMembershipId: membershipId,
      roleKey,
      effect,
    }),
    201,
  );
}

async function createSecret(user: TestUser, path: string, body: object) {
  return ok(call(user, 'post', path, body), 201, createdSecretSchema);
}

async function reveal(user: TestUser, path: string, id: string) {
  return call(user, 'post', `${path}/${id}/reveal`);
}

async function auditActions(projectId: string) {
  return (
    await h.db.auditEvent.findMany({ where: { projectId }, orderBy: { occurredAt: 'asc' } })
  ).map((e) => `${e.action}:${e.outcome}`);
}

/** Every bytea column of the secrets tables, checked for the plaintext. */
async function storedContains(plaintext: string): Promise<boolean> {
  const needle = Buffer.from(plaintext, 'utf8');
  const versions = await h.db.secretVersion.findMany();
  const secrets = await h.db.secret.findMany();
  const audits = await h.db.auditEvent.findMany();
  return (
    versions.some((v) =>
      [v.ciphertext, v.iv, v.authTag, v.encryptedDataKey].some((b) =>
        Buffer.from(b).includes(needle),
      ),
    ) ||
    JSON.stringify(secrets).includes(plaintext) ||
    JSON.stringify(audits).includes(plaintext)
  );
}

/* -------------------------------------------------------------------- tests */

describe('secret lifecycle', () => {
  it('creates, lists masked metadata, reveals with no-store and never stores plaintext', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id, revision } = await createSecret(w.owner, path, {
      key: 'DATABASE_PASSWORD',
      value: SYNTHETIC,
      category: 'Database',
      tags: ['Backend'],
      description: 'Primary database',
      isRequired: true,
    });
    expect(revision).toBe(1);

    const decrypt = vi.spyOn(SecretEncryptionService.prototype, 'decryptSecret');
    const listResponse = await call(w.owner, 'get', path);
    await ok(call(w.owner, 'get', `${path}/${id}`), 200);
    await ok(call(w.owner, 'get', `${path}/${id}/versions`), 200);
    expect(decrypt).not.toHaveBeenCalled();
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(listResponse.body)).not.toContain(SYNTHETIC);
    const list = secretListSchema.parse(listResponse.body);
    expect(list).toMatchObject({
      total: 1,
      facets: { categories: ['Database'], tags: ['backend'] },
      items: [
        {
          id,
          key: 'DATABASE_PASSWORD',
          type: 'SECRET',
          hasValue: true,
          currentVersion: 1,
          isRequired: true,
          status: 'ACTIVE',
        },
      ],
    });
    expect(Object.keys(list.items[0] ?? {})).not.toContain('value');

    const revealed = await reveal(w.owner, path, id);
    expect(revealed.status).toBe(200);
    expect(decrypt).toHaveBeenCalledTimes(1);
    decrypt.mockRestore();
    expect(revealed.headers['cache-control']).toContain('no-store');
    expect(revealedSecretSchema.parse(revealed.body)).toMatchObject({
      value: SYNTHETIC,
      version: 1,
    });

    expect(await storedContains(SYNTHETIC)).toBe(false);
    const row = await h.db.secretVersion.findFirstOrThrow({ where: { secretId: id } });
    expect(row).toMatchObject({ envelopeVersion: 1, algorithm: 'AES_256_GCM', kmsKeyVersion: '1' });
    const key = await h.db.encryptionKey.findUniqueOrThrow({ where: { id: row.encryptionKeyId } });
    expect(key).toMatchObject({ workspaceId: w.ws, kmsProvider: 'local', status: 'ACTIVE' });

    expect(await auditActions(w.project)).toEqual(
      expect.arrayContaining(['secret.created:SUCCESS', 'secret.revealed:SUCCESS']),
    );
  });

  it('keeps empty, missing, Unicode and multiline values distinct and intact', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const empty = await createSecret(w.owner, path, { key: 'EMPTY', value: '' });
    const missing = await createSecret(w.owner, path, { key: 'MISSING' });
    const text = 'line one\nline two 🔐 ключ 秘密\r\n';
    const multi = await createSecret(w.owner, path, {
      key: 'CERT',
      type: 'MULTILINE',
      value: text,
    });

    expect(revealedSecretSchema.parse((await reveal(w.owner, path, empty.id)).body).value).toBe('');
    expect(revealedSecretSchema.parse((await reveal(w.owner, path, multi.id)).body).value).toBe(
      text,
    );
    expect(await fails(reveal(w.owner, path, missing.id), 409)).toBe('SECRET_VALUE_NOT_SET');
    const list = await ok(call(w.owner, 'get', path), 200, secretListSchema);
    expect(list.items.find((s) => s.key === 'MISSING')).toMatchObject({
      hasValue: false,
      currentVersion: null,
    });
  });

  it('validates names, types and values without echoing them', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    expect(await fails(call(w.owner, 'post', path, { key: 'bad-name', value: 'x' }), 400)).toBe(
      'BAD_REQUEST',
    );
    expect(await fails(call(w.owner, 'post', path, { key: 'A', type: 'PASSWORD' }), 400)).toBe(
      'BAD_REQUEST',
    );
    for (const [type, value] of [
      ['NUMBER', SYNTHETIC],
      ['BOOLEAN', SYNTHETIC],
      ['JSON', SYNTHETIC],
    ]) {
      const response = await call(w.owner, 'post', path, { key: `K_${type}`, type, value });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain(SYNTHETIC);
    }
    const tooLarge = await call(w.owner, 'post', path, { key: 'BIG', value: 'a'.repeat(65_537) });
    expect(tooLarge.status).toBe(400);
    await createSecret(w.owner, path, { key: 'PORT', type: 'NUMBER', value: '8080' });
    await createSecret(w.owner, path, { key: 'FLAG', type: 'BOOLEAN', value: 'true' });
    await createSecret(w.owner, path, { key: 'CONFIG', type: 'JSON', value: '{"a":1}' });
    expect(await h.db.secret.count()).toBe(3);
  });

  it('rejects duplicate names per environment and allows them elsewhere', async () => {
    const w = await world();
    await createSecret(w.owner, w.secrets(w.dev), { key: 'TOKEN', value: 'a' });
    expect(
      await fails(call(w.owner, 'post', w.secrets(w.dev), { key: 'TOKEN', value: 'b' }), 409),
    ).toBe('SECRET_KEY_TAKEN');
    await ok(call(w.owner, 'post', w.secrets(w.dev), { key: 'token', value: 'c' }), 201);
  });
});

describe('updates and versions', () => {
  it('changes metadata without a new version and values with one', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'API_KEY', value: SYNTHETIC });

    const renamed = await ok(
      call(w.owner, 'patch', `${path}/${id}`, {
        expectedRevision: 1,
        key: 'STRIPE_API_KEY',
        category: 'Payments',
        tags: ['billing'],
      }),
      200,
      secretSummarySchema,
    );
    expect(renamed).toMatchObject({ key: 'STRIPE_API_KEY', revision: 2, currentVersion: 1 });
    expect(await h.db.secretVersion.count({ where: { secretId: id } })).toBe(1);

    const rotated = await ok(
      call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 2, value: SYNTHETIC_2 }),
      200,
      secretSummarySchema,
    );
    expect(rotated).toMatchObject({ revision: 3, currentVersion: 2 });
    expect(revealedSecretSchema.parse((await reveal(w.owner, path, id)).body)).toMatchObject({
      value: SYNTHETIC_2,
      version: 2,
    });

    const versions = await ok(
      call(w.owner, 'get', `${path}/${id}/versions`),
      200,
      z.array(secretVersionSchema),
    );
    expect(versions.map((v) => [v.version, v.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(JSON.stringify(versions)).not.toContain(SYNTHETIC);

    const actions = await auditActions(w.project);
    expect(actions).toEqual(
      expect.arrayContaining(['secret.updated:SUCCESS', 'secret.value_changed:SUCCESS']),
    );
    const updated = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'secret.updated' } });
    expect(updated.metadata).toMatchObject({ renamedFrom: 'API_KEY', renamedTo: 'STRIPE_API_KEY' });
  });

  it('refuses stale revisions, including concurrent editors', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'SHARED', value: 'v1' });
    const results = await Promise.all(
      ['a', 'b', 'c'].map(
        async (value) =>
          (await call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 1, value })).status,
      ),
    );
    expect(results.sort()).toEqual([200, 409, 409]);
    expect(await h.db.secretVersion.count({ where: { secretId: id } })).toBe(2);
    expect(
      await fails(call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 1, tags: [] }), 409),
    ).toBe('SECRET_CONFLICT');
  });

  it('asks for a value when switching to a stricter type and refuses taken names', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'PORT', value: 'abc' });
    await createSecret(w.owner, path, { key: 'OTHER', value: 'x' });
    expect(
      await fails(
        call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 1, type: 'NUMBER' }),
        400,
      ),
    ).toBe('SECRET_VALUE_REQUIRED');
    expect(
      await fails(
        call(w.owner, 'patch', `${path}/${id}`, {
          expectedRevision: 1,
          type: 'NUMBER',
          value: 'x',
        }),
        400,
      ),
    ).toBe('BAD_REQUEST');
    await ok(
      call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 1, type: 'NUMBER', value: '80' }),
      200,
    );
    expect(
      await fails(
        call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 2, key: 'OTHER' }),
        409,
      ),
    ).toBe('SECRET_KEY_TAKEN');
  });
});

describe('delete and restore', () => {
  it('soft deletes, keeps history, restores and reports name conflicts', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'LEGACY', value: SYNTHETIC });
    await ok(call(w.owner, 'delete', `${path}/${id}`), 204);
    expect((await ok(call(w.owner, 'get', path), 200, secretListSchema)).total).toBe(0);
    const deleted = await ok(call(w.owner, 'get', `${path}?status=deleted`), 200, secretListSchema);
    expect(deleted.items[0]).toMatchObject({ id, status: 'DELETED' });
    expect(await fails(reveal(w.owner, path, id), 404)).toBe('NOT_FOUND');
    expect(await h.db.secretVersion.count({ where: { secretId: id } })).toBe(1);

    await createSecret(w.owner, path, { key: 'LEGACY', value: 'replacement' });
    expect(await fails(call(w.owner, 'post', `${path}/${id}/restore`), 409)).toBe(
      'SECRET_KEY_TAKEN',
    );

    const other = await createSecret(w.owner, path, { key: 'TEMP', value: SYNTHETIC_2 });
    await ok(call(w.owner, 'delete', `${path}/${other.id}`), 204);
    const restored = await ok(
      call(w.owner, 'post', `${path}/${other.id}/restore`),
      200,
      secretSummarySchema,
    );
    expect(restored).toMatchObject({ status: 'ACTIVE', deletedAt: null });
    expect(revealedSecretSchema.parse((await reveal(w.owner, path, other.id)).body).value).toBe(
      SYNTHETIC_2,
    );
    expect(await fails(call(w.owner, 'post', `${path}/${other.id}/restore`), 409)).toBe(
      'SECRET_NOT_DELETED',
    );
    expect(await auditActions(w.project)).toEqual(
      expect.arrayContaining(['secret.deleted:SUCCESS', 'secret.restored:SUCCESS']),
    );
  });

  it('refuses a delete from a stale revision', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'GUARDED', value: 'x' });
    expect(await fails(call(w.owner, 'delete', `${path}/${id}?expectedRevision=7`), 409)).toBe(
      'SECRET_CONFLICT',
    );
  });
});

describe('authorization', () => {
  it('never lets workspace owners or admins read values through their workspace role', async () => {
    const w = await world();
    const { id } = await createSecret(w.owner, w.secrets(w.dev), { key: 'K', value: SYNTHETIC });
    const admin = h.newUser('admin');
    await join(w.owner, w.ws, admin, 'admin');
    // Admin administers the project but holds no secret permission at all.
    expect(await fails(call(admin, 'get', w.secrets(w.dev)), 403)).toBe('FORBIDDEN');
    expect(await fails(reveal(admin, w.secrets(w.dev), id), 403)).toBe('FORBIDDEN');
    // The owner created the project (Project Admin) yet production values need a grant.
    const prodSecret = await call(w.owner, 'post', w.secrets(w.prod), { key: 'K', value: 'x' });
    expect(prodSecret.status).toBe(403);
    expect(await h.db.secret.count({ where: { environmentId: w.prod } })).toBe(0);
  });

  it('separates metadata from values and audits refused reveals', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'K', value: SYNTHETIC });
    const viewer = h.newUser('viewer');
    await addToProject(w, viewer, 'project-viewer');
    const list = await ok(call(viewer, 'get', path), 200, secretListSchema);
    expect(list.total).toBe(1);
    const denied = await reveal(viewer, path, id);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain(SYNTHETIC);
    expect(denied.headers['cache-control']).toContain('no-store');
    expect(await fails(call(viewer, 'post', path, { key: 'NEW', value: 'x' }), 403)).toBe(
      'FORBIDDEN',
    );
    expect(
      await fails(call(viewer, 'patch', `${path}/${id}`, { expectedRevision: 1, value: 'x' }), 403),
    ).toBe('FORBIDDEN');
    expect(await fails(call(viewer, 'delete', `${path}/${id}`), 403)).toBe('FORBIDDEN');
    const event = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'secret.access_denied', resourceId: id },
    });
    expect(event).toMatchObject({ outcome: 'DENIED', metadata: { attempted: 'secret.revealed' } });
  });

  it('lets developers work in unprotected environments only, and never delete', async () => {
    const w = await world();
    const dev = h.newUser('dev');
    await addToProject(w, dev, 'project-developer');
    const created = await createSecret(dev, w.secrets(w.dev), { key: 'K', value: SYNTHETIC });
    expect((await reveal(dev, w.secrets(w.dev), created.id)).status).toBe(200);
    expect(await fails(call(dev, 'delete', `${w.secrets(w.dev)}/${created.id}`), 403)).toBe(
      'FORBIDDEN',
    );
    // Production metadata is visible, its values and writes are not.
    await ok(call(dev, 'get', w.secrets(w.prod)), 200);
    expect(await fails(call(dev, 'post', w.secrets(w.prod), { key: 'K', value: 'x' }), 403)).toBe(
      'FORBIDDEN',
    );
  });

  it('requires a direct grant and a step up for protected values; DENY and expiry win', async () => {
    const w = await world();
    const dev = h.newUser('dev');
    const { membershipId } = await addToProject(w, dev, 'project-developer');
    await grant(w, w.prod, membershipId, 'environment-writer');
    const { id } = await createSecret(dev, w.secrets(w.prod), {
      key: 'PROD_KEY',
      value: SYNTHETIC,
    });

    expect(await fails(reveal(dev, w.secrets(w.prod), id), 403)).toBe('STEP_UP_REQUIRED');
    await ok(call(dev, 'post', '/auth/step-up', { password: dev.password }), 200);
    expect(revealedSecretSchema.parse((await reveal(dev, w.secrets(w.prod), id)).body).value).toBe(
      SYNTHETIC,
    );

    // Expired grants stop authorizing immediately.
    await h.db.accessPolicy.updateMany({
      where: { environmentId: w.prod, workspaceMembershipId: membershipId },
      data: { createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await fails(reveal(dev, w.secrets(w.prod), id), 403)).toBe('FORBIDDEN');

    // DENY overrides the developer role in an unprotected environment.
    const devSecret = await createSecret(w.owner, w.secrets(w.dev), { key: 'D', value: 'x' });
    expect((await reveal(dev, w.secrets(w.dev), devSecret.id)).status).toBe(200);
    await grant(w, w.dev, membershipId, 'environment-reader', 'DENY');
    // The denied role includes environment:read, so the environment disappears entirely.
    expect(await fails(reveal(dev, w.secrets(w.dev), devSecret.id), 404)).toBe('NOT_FOUND');
    expect(await fails(call(dev, 'get', w.secrets(w.dev)), 404)).toBe('NOT_FOUND');
  });

  it('cuts off revoked members and hides other tenants, projects and environments', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'K', value: SYNTHETIC });
    const dev = h.newUser('dev');
    const { membershipId, projectMemberId } = await addToProject(w, dev, 'project-developer');
    expect((await reveal(dev, path, id)).status).toBe(200);

    await ok(
      call(
        w.owner,
        'delete',
        `/workspaces/${w.ws}/projects/${w.project}/members/${projectMemberId}`,
      ),
      204,
    );
    expect(await fails(reveal(dev, path, id), 404)).toBe('NOT_FOUND');
    expect(await fails(call(dev, 'get', path), 404)).toBe('NOT_FOUND');
    await ok(call(w.owner, 'delete', `/workspaces/${w.ws}/members/${membershipId}`), 204);
    expect(await fails(call(dev, 'get', path), 404)).toBe('NOT_FOUND');

    // Another tenant cannot reach the secret, even with its id.
    const other = await world('other');
    expect(await fails(reveal(other.owner, path, id), 404)).toBe('NOT_FOUND');
    expect(await fails(reveal(other.owner, other.secrets(other.dev), id), 404)).toBe('NOT_FOUND');
    // The secret id under another environment of the same project is not found.
    expect(await fails(call(w.owner, 'get', `${w.secrets(w.prod)}/${id}`), 404)).toBe('NOT_FOUND');
    expect(
      await fails(
        call(w.owner, 'patch', `${w.secrets(w.prod)}/${id}`, { expectedRevision: 1, value: 'x' }),
        404,
      ),
    ).toBe('NOT_FOUND');
    // A project id from another workspace with this workspace's id: not found.
    const mixed = `/workspaces/${w.ws}/projects/${other.project}/environments/${other.dev}/secrets`;
    expect(await fails(call(w.owner, 'get', mixed), 404)).toBe('NOT_FOUND');
  });

  it('accepts upper case ids in the URL without breaking the encryption context', async () => {
    const w = await world();
    const { id } = await createSecret(w.owner, w.secrets(w.dev), { key: 'K', value: SYNTHETIC });
    const [ws, project, env, secret] = [w.ws, w.project, w.dev, id].map((v) => v.toUpperCase());
    const upper = `/workspaces/${ws}/projects/${project}/environments/${env}/secrets`;
    const response = await reveal(w.owner, upper, secret ?? '');
    expect(revealedSecretSchema.parse(response.body).value).toBe(SYNTHETIC);
  });
});

describe('encryption integration', () => {
  it('detects tampered ciphertext and a foreign context, without leaking details', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const a = await createSecret(w.owner, path, { key: 'A', value: SYNTHETIC });
    const b = await createSecret(w.owner, path, { key: 'B', value: SYNTHETIC_2 });

    // Copy A's envelope into a new version of B: the context (secret and version ids) differs.
    const source = await h.db.secretVersion.findFirstOrThrow({ where: { secretId: a.id } });
    const forgedId = '01900000-0000-7000-8000-00000000f00d';
    await h.db.$transaction(async (tx) => {
      await tx.secret.update({ where: { id: b.id }, data: { latestVersionNumber: 2 } });
      await tx.secretVersion.create({
        data: { ...source, id: forgedId, secretId: b.id, versionNumber: 2 },
      });
      await tx.secret.update({ where: { id: b.id }, data: { currentVersionId: forgedId } });
    });
    const forged = await reveal(w.owner, path, b.id);
    expect(forged.status).toBe(500);
    expect(errorCode(forged.body)).toBe('SECRET_INTEGRITY_ERROR');
    expect(JSON.stringify(forged.body)).not.toMatch(/synthetic|DECRYPTION|tag/i);

    // Flip one ciphertext byte of A through a fresh version row (the trigger forbids edits in place).
    const tampered = Buffer.from(source.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const tamperedId = '01900000-0000-7000-8000-00000000beef';
    await h.db.$transaction(async (tx) => {
      await tx.secret.update({ where: { id: a.id }, data: { latestVersionNumber: 2 } });
      await tx.secretVersion.create({
        data: {
          ...source,
          id: tamperedId,
          versionNumber: 2,
          ciphertext: new Uint8Array(tampered),
        },
      });
      await tx.secret.update({ where: { id: a.id }, data: { currentVersionId: tamperedId } });
    });
    expect(await fails(reveal(w.owner, path, a.id), 500)).toBe('SECRET_INTEGRITY_ERROR');
    const failures = await h.db.auditEvent.findMany({
      where: { action: 'secret.decryption_failed' },
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      outcome: 'FAILURE',
      metadata: { errorCode: 'DECRYPTION_FAILED' },
    });
    // No success event was written for the failed reveals.
    expect(
      await h.db.auditEvent.count({
        where: { action: 'secret.revealed', resourceId: { in: [a.id, b.id] } },
      }),
    ).toBe(0);
  });

  it('fails closed on an unknown key version', async () => {
    const w = await world();
    const path = w.secrets(w.dev);
    const { id } = await createSecret(w.owner, path, { key: 'K', value: SYNTHETIC });
    // kms_key_version is the one mutable key reference (rewrapping updates it).
    await h.db.secretVersion.updateMany({ where: { secretId: id }, data: { kmsKeyVersion: '99' } });
    expect(await fails(reveal(w.owner, path, id), 503)).toBe('ENCRYPTION_UNAVAILABLE');
  });

  it('keeps plaintext out of logs, error responses and audit events', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level),
    );
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      const w = await world();
      const path = w.secrets(w.dev);
      const { id } = await createSecret(w.owner, path, { key: 'K', value: SYNTHETIC });
      await call(w.owner, 'patch', `${path}/${id}`, { expectedRevision: 1, value: SYNTHETIC_2 });
      await call(w.owner, 'post', path, { key: 'BAD', type: 'NUMBER', value: SYNTHETIC });
      await h.db.secretVersion.updateMany({
        where: { secretId: id },
        data: { kmsKeyVersion: '42' },
      });
      await reveal(w.owner, path, id);
      const output = [...spies, stdout, stderr]
        .flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')))
        .join('\n');
      expect(output).not.toContain(SYNTHETIC);
      expect(output).not.toContain(SYNTHETIC_2);
      expect(await storedContains(SYNTHETIC_2)).toBe(false);
    } finally {
      for (const spy of [...spies, stdout, stderr]) spy.mockRestore();
    }
  });
});

describe('without configured keys', () => {
  let disabled: Harness;

  beforeAll(async () => {
    disabled = await Harness.start();
  });
  afterAll(async () => {
    await disabled.stop();
  });

  it('refuses to store values and writes nothing, but still manages metadata', async () => {
    const owner = disabled.newUser('nokeys');
    const workspace = workspaceSummarySchema.parse(
      (await call(owner, 'post', '/workspaces', { name: 'No keys' }, disabled)).body,
    );
    const project = z.object({ id: z.uuid() }).parse(
      (
        await call(
          owner,
          'post',
          `/workspaces/${workspace.id}/projects`,
          {
            name: 'P',
            environments: [{ name: 'Development', kind: 'DEVELOPMENT' }],
          },
          disabled,
        )
      ).body,
    );
    const envs = paginatedSchema(environmentSummarySchema).parse(
      (
        await call(
          owner,
          'get',
          `/workspaces/${workspace.id}/projects/${project.id}/environments`,
          undefined,
          disabled,
        )
      ).body,
    );
    const path = `/workspaces/${workspace.id}/projects/${project.id}/environments/${envs.items[0]?.id ?? ''}/secrets`;

    const refused = await call(owner, 'post', path, { key: 'K', value: SYNTHETIC }, disabled);
    expect(refused.status).toBe(503);
    expect(errorCode(refused.body)).toBe('ENCRYPTION_UNAVAILABLE');
    expect(await disabled.db.secret.count()).toBe(0);
    const failure = await disabled.db.auditEvent.findFirstOrThrow({
      where: { action: 'secret.encryption_failed' },
    });
    expect(failure.metadata).toMatchObject({ errorCode: 'NOT_CONFIGURED' });

    const placeholder = await call(owner, 'post', path, { key: 'LATER' }, disabled);
    expect(placeholder.status).toBe(201);
  });
});

describe('key persistence across restarts', () => {
  /** Boots the API with the keyring file the way main.ts does (loadEncryption). */
  async function boot(file: string): Promise<Harness> {
    const config = { ENCRYPTION_PROVIDER: 'local', ENCRYPTION_KEYRING_FILE: file };
    const env = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      CORS_ORIGINS: 'http://localhost:3000',
      NEON_AUTH_BASE_URL: 'https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth',
      ...config,
    });
    return Harness.start(config, { encryption: await loadEncryption(env) });
  }

  /** The same Neon Auth user as seen by another API instance (each has its own fake issuer). */
  function sameUser(harness: Harness, user: TestUser): TestUser {
    harness.neon.addUser(user.email, user.password, user.sub);
    return {
      ...user,
      token: () =>
        harness.neon.issueToken({ sub: user.sub, email: user.email, emailVerified: true }),
    };
  }

  it('decrypts after a restart with the same keyring file and fails closed with another', async () => {
    const directory = await mkdtemp(pathJoin(tmpdir(), 'envvault-restart-'));
    const file = pathJoin(directory, 'keyring.json');
    const replacement = pathJoin(directory, 'replacement.json');
    await writeKeyringFile(file, generateKeyring());
    await writeKeyringFile(replacement, generateKeyring());
    const running: Harness[] = [];
    try {
      const first = await boot(file);
      running.push(first);
      const owner = first.newUser('restart');
      const workspace = workspaceSummarySchema.parse(
        (await call(owner, 'post', '/workspaces', { name: 'Restart' }, first)).body,
      );
      const project = z
        .object({ id: z.uuid() })
        .parse(
          (
            await call(
              owner,
              'post',
              `/workspaces/${workspace.id}/projects`,
              { name: 'P', environments: [{ name: 'Development', kind: 'DEVELOPMENT' }] },
              first,
            )
          ).body,
        );
      const envs = paginatedSchema(environmentSummarySchema).parse(
        (
          await call(
            owner,
            'get',
            `/workspaces/${workspace.id}/projects/${project.id}/environments`,
            undefined,
            first,
          )
        ).body,
      );
      const path = `/workspaces/${workspace.id}/projects/${project.id}/environments/${envs.items[0]?.id ?? ''}/secrets`;
      const created = createdSecretSchema.parse(
        (await call(owner, 'post', path, { key: 'K', value: SYNTHETIC }, first)).body,
      );
      await first.stop();
      running.pop();

      const second = await boot(file);
      running.push(second);
      const again = await call(
        sameUser(second, owner),
        'post',
        `${path}/${created.id}/reveal`,
        undefined,
        second,
      );
      expect(revealedSecretSchema.parse(again.body).value).toBe(SYNTHETIC);
      await second.stop();
      running.pop();

      // A different keyring (for example a lost file replaced by a new one) cannot decrypt.
      const third = await boot(replacement);
      running.push(third);
      const refused = await call(
        sameUser(third, owner),
        'post',
        `${path}/${created.id}/reveal`,
        undefined,
        third,
      );
      expect(refused.status).toBe(503);
      expect(errorCode(refused.body)).toBe('ENCRYPTION_UNAVAILABLE');
    } finally {
      for (const harness of running) await harness.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
