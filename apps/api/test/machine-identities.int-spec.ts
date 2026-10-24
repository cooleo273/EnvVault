import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { createRepositories } from '@envvault/database';
import { truncateAllTables } from '@envvault/database/testing';
import {
  issuedServiceCredentialSchema,
  machineActivityPageSchema,
  machineIdentityListSchema,
  machineIdentitySummarySchema,
  machineSelfSchema,
  machineTokenSchema,
  machineVariableListSchema,
  runtimeConfigurationSchema,
  serviceCredentialListSchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorCode, Harness, type TestUser } from './support/harness.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const VALUE = 'synthetic-machine-value-3f9a';
const PROD_VALUE = 'synthetic-production-value-7c21';

let h: Harness;
let api: ReturnType<typeof client>;
type World = Awaited<ReturnType<ReturnType<typeof client>['world']>>;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    { MACHINE_TOKEN_RATE_LIMIT: '8', MACHINE_RUNTIME_RESOURCE_RATE_LIMIT: '6' },
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

const base = (w: World) => `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;

async function clearStepUp(user: TestUser) {
  const row = await h.db.user.findFirstOrThrow({ where: { email: user.email } });
  await createRepositories(h.db).authState.clearStepUpGrants(row.id);
}

async function createIdentity(w: World, user: TestUser, name = 'GitHub Actions QA') {
  return api.ok(
    api.call(user, 'post', base(w), { name, description: 'Builds pull requests' }),
    201,
    machineIdentitySummarySchema,
  );
}

async function issue(
  w: World,
  user: TestUser,
  identityId: string,
  scopes: string[] = ['environment:read', 'secret:list', 'secret:runtime'],
  name = 'ci',
) {
  await api.stepUp(user);
  return api.ok(
    api.call(user, 'post', `${base(w)}/${identityId}/credentials`, {
      name,
      scopes,
      expiresInDays: 7,
    }),
    201,
    issuedServiceCredentialSchema,
  );
}

async function grant(
  w: World,
  user: TestUser,
  identityId: string,
  environmentId: string,
  roleKey = 'environment-runtime',
  effect: 'ALLOW' | 'DENY' = 'ALLOW',
) {
  await api.stepUp(user);
  return api.call(user, 'post', `${base(w)}/${identityId}/grants`, {
    environmentId,
    roleKey,
    effect,
  });
}

function exchange(credential: string, body: object = {}) {
  return h
    .api()
    .post('/api/v1/machine/token')
    .set('Authorization', `Bearer ${credential}`)
    .send(body);
}

async function token(credential: string, body: object = {}) {
  const response = await exchange(credential, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return machineTokenSchema.parse(response.body);
}

function machine(method: 'get' | 'post', path: string, accessToken: string, body?: object) {
  const request = h
    .api()
    [method](`/api/v1/machine${path}`)
    .set('Authorization', `Bearer ${accessToken}`);
  return method === 'post' ? request.send(body ?? {}) : request.send();
}

/** A project with a value in Development and a ready identity with runtime access there. */
async function ready(label: string) {
  const w = await api.world(label);
  await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
  const identity = await createIdentity(w, w.owner);
  expect((await grant(w, w.owner, identity.id, w.dev)).status).toBe(201);
  const issued = await issue(w, w.owner, identity.id);
  return { w, identity, issued };
}

describe('machine identity lifecycle', () => {
  it('starts with no access, never inheriting its creator', async () => {
    const w = await api.world('mi-empty');
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
    const identity = await createIdentity(w, w.owner);
    expect(identity).toMatchObject({ status: 'ACTIVE', grants: [], activeCredentials: 0 });
    const issued = await issue(w, w.owner, identity.id);
    const t = await token(issued.token);
    const self = machineSelfSchema.parse((await machine('get', '/identity', t.accessToken)).body);
    expect(self.environments).toEqual([]);
    expect((await machine('post', `/environments/${w.dev}/runtime`, t.accessToken)).status).toBe(
      404,
    );
  });

  it('loads granted values through a short lived token, audited without values', async () => {
    const { w, identity, issued } = await ready('mi-runtime');
    expect(issued.token).toMatch(/^evv_sk_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/);
    const t = await token(issued.token);
    expect(t.accessToken).toMatch(/^evv_mt_/);
    expect(t.expiresIn).toBeLessThanOrEqual(900);
    expect(t.expiresIn).toBeGreaterThanOrEqual(895);
    const row = await h.db.machineAccessToken.findFirstOrThrow({
      where: { credentialId: issued.credential.id },
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(900_000);
    expect(t.identity).toMatchObject({ id: identity.id, workspaceId: w.ws, projectId: w.project });

    const response = await machine('post', `/environments/${w.dev}/runtime`, t.accessToken);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const config = runtimeConfigurationSchema.parse(response.body);
    expect(config.values).toEqual([{ key: 'API_TOKEN', value: VALUE, source: 'local' }]);

    const variables = machineVariableListSchema.parse(
      (await machine('get', `/environments/${w.dev}/variables`, t.accessToken)).body,
    );
    expect(variables.items.map((v) => v.key)).toEqual(['API_TOKEN']);
    expect(JSON.stringify(variables)).not.toContain(VALUE);

    const loads = await h.db.auditEvent.findMany({ where: { action: 'secret.runtime_loaded' } });
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      actorType: 'SERVICE_IDENTITY',
      actorServiceIdentityId: identity.id,
      actorUserId: null,
    });
    const events = JSON.stringify(await h.db.auditEvent.findMany());
    expect(events).not.toContain(VALUE);
    expect(events).not.toContain(issued.token);
    expect(events).not.toContain(t.accessToken);
    expect(events).toContain('machine.authenticated');

    const stored = JSON.stringify([
      await h.db.serviceCredential.findMany(),
      await h.db.machineAccessToken.findMany(),
    ]);
    const secretPart = issued.token.split('_').slice(3).join('_');
    expect(stored).not.toContain(issued.token);
    expect(stored).not.toContain(secretPart);
    expect(stored).not.toContain(t.accessToken);

    const listed = await api.ok(
      api.call(w.owner, 'get', `${base(w)}/${identity.id}/credentials`),
      200,
      serviceCredentialListSchema,
    );
    expect(JSON.stringify(listed)).not.toContain(secretPart);
    expect(listed.items[0]?.displayPrefix).toMatch(/^evv_sk_[A-Za-z0-9]{8}…$/);

    const after = await api.ok(
      api.call(w.owner, 'get', `${base(w)}/${identity.id}`),
      200,
      machineIdentitySummarySchema,
    );
    expect(after.lastAuthenticatedAt).not.toBeNull();
    expect(after.lastUsedAt).not.toBeNull();
    const activity = machineActivityPageSchema.parse(
      (await api.call(w.owner, 'get', `${base(w)}/${identity.id}/activity`)).body,
    );
    const actions = activity.items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'machine_identity.created',
        'machine_identity.grant_added',
        'service_credential.created',
        'machine.authenticated',
        'secret.runtime_loaded',
      ]),
    );
  });

  it('confines a token to its credential scopes and requested environments', async () => {
    const { w, identity } = await ready('mi-scopes');
    const narrow = await issue(w, w.owner, identity.id, ['environment:read'], 'metadata only');
    const t = await token(narrow.token);
    const denied = await machine('post', `/environments/${w.dev}/runtime`, t.accessToken);
    expect(denied.status).toBe(403);
    expect(
      await h.db.auditEvent.count({
        where: { action: 'machine.access_denied', outcome: 'DENIED' },
      }),
    ).toBe(1);
    expect(errorCode((await exchange(narrow.token, { scopes: ['secret:runtime'] })).body)).toBe(
      'SCOPE_NOT_GRANTED',
    );

    expect((await grant(w, w.owner, identity.id, w.prod, 'environment-lister')).status).toBe(201);
    const full = await issue(w, w.owner, identity.id, undefined, 'second');
    const both = machineSelfSchema.parse(
      (await machine('get', '/identity', (await token(full.token)).accessToken)).body,
    );
    expect(both.environments.map((e) => e.id).sort()).toEqual([w.dev, w.prod].sort());
    const onlyDev = await token(full.token, { environmentIds: [w.dev] });
    const envs = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse((await machine('get', '/environments', onlyDev.accessToken)).body);
    expect(envs.items.map((e) => e.id)).toEqual([w.dev]);
    expect((await machine('get', `/environments/${w.prod}`, onlyDev.accessToken)).status).toBe(404);
    const other = await api.world('mi-scopes-other');
    expect(errorCode((await exchange(full.token, { environmentIds: [other.dev] })).body)).toBe(
      'SCOPE_NOT_GRANTED',
    );
  });
});

describe('protected environments and escalation', () => {
  it('needs a direct grant from someone who holds the permission on Production', async () => {
    const { w, identity } = await ready('mi-prod');
    // The owner administers the project but holds no data plane permission on Production.
    const refused = await grant(w, w.owner, identity.id, w.prod);
    expect(refused.status).toBe(403);
    expect(errorCode(refused.body)).toBe('GRANT_EXCEEDS_AUTHORITY');
    expect(await h.db.auditEvent.count({ where: { action: 'machine.grant_refused' } })).toBe(1);

    const lead = h.newUser('mi-prod-lead');
    const leadMembership = await api.addToProject(w, lead, 'project-admin');
    await api.grant(w, w.prod, leadMembership, 'environment-writer');
    await api.stepUp(lead);
    await api.ok(
      api.call(
        lead,
        'post',
        `/workspaces/${w.ws}/projects/${w.project}/environments/${w.prod}/secrets`,
        {
          key: 'DATABASE_URL',
          value: PROD_VALUE,
        },
      ),
      201,
    );
    await clearStepUp(lead);
    const withoutStepUp = await api.call(lead, 'post', `${base(w)}/${identity.id}/grants`, {
      environmentId: w.prod,
      roleKey: 'environment-runtime',
    });
    expect(errorCode(withoutStepUp.body)).toBe('STEP_UP_REQUIRED');
    expect((await grant(w, lead, identity.id, w.prod)).status).toBe(201);

    // The owner cannot issue a credential that reaches Production values they cannot read.
    await api.stepUp(w.owner);
    const beyond = await api.call(w.owner, 'post', `${base(w)}/${identity.id}/credentials`, {
      name: 'deploy',
      scopes: ['environment:read', 'secret:list', 'secret:runtime'],
    });
    expect(beyond.status).toBe(403);
    expect(errorCode(beyond.body)).toBe('GRANT_EXCEEDS_AUTHORITY');
    expect(await h.db.auditEvent.count({ where: { action: 'service_credential.refused' } })).toBe(
      1,
    );
    // Nor rotate one into existence.
    const existing = (
      await h.db.serviceCredential.findFirstOrThrow({
        where: { serviceIdentityId: identity.id, revokedAt: null },
      })
    ).id;
    const rotation = await api.call(
      w.owner,
      'post',
      `${base(w)}/${identity.id}/credentials/${existing}/rotate`,
      { overlapHours: 1 },
    );
    expect(errorCode(rotation.body)).toBe('GRANT_EXCEEDS_AUTHORITY');
    // Metadata only is within the owner's reach on Production.
    await issue(w, w.owner, identity.id, ['environment:read'], 'metadata');

    const full = await issue(w, lead, identity.id, undefined, 'deploy');
    const t = await token(full.token);
    const response = await machine('post', `/environments/${w.prod}/runtime`, t.accessToken);
    expect(response.status).toBe(200);
    expect(runtimeConfigurationSchema.parse(response.body).values).toEqual([
      { key: 'DATABASE_URL', value: PROD_VALUE, source: 'local' },
    ]);
  });

  it('refuses roles with permissions machines may not hold', async () => {
    const w = await api.world('mi-role');
    const identity = await createIdentity(w, w.owner);
    for (const roleKey of ['environment-reader', 'environment-writer', 'environment-exporter']) {
      const response = await grant(w, w.owner, identity.id, w.dev, roleKey);
      expect(errorCode(response.body)).toBe('ROLE_NOT_MACHINE_GRANTABLE');
    }
  });

  it('keeps management to people with service_identity permissions', async () => {
    const w = await api.world('mi-perm');
    const identity = await createIdentity(w, w.owner);
    const developer = h.newUser('mi-perm-dev');
    await api.addToProject(w, developer, 'project-developer');
    const viewer = h.newUser('mi-perm-viewer');
    await api.addToProject(w, viewer, 'project-viewer');
    expect((await api.call(developer, 'post', base(w), { name: 'mine' })).status).toBe(403);
    expect((await api.call(viewer, 'get', base(w))).status).toBe(403);
    await api.stepUp(developer);
    expect(
      (
        await api.call(developer, 'post', `${base(w)}/${identity.id}/credentials`, {
          name: 'x',
          scopes: ['secret:runtime'],
        })
      ).status,
    ).toBe(403);
    await clearStepUp(w.owner);
    const noStepUp = await api.call(w.owner, 'post', `${base(w)}/${identity.id}/credentials`, {
      name: 'x',
      scopes: ['secret:runtime'],
    });
    expect(errorCode(noStepUp.body)).toBe('STEP_UP_REQUIRED');
  });

  it('lets DENY win and takes grant removal into account on the next request', async () => {
    const { w, identity, issued } = await ready('mi-deny');
    const t = await token(issued.token);
    expect((await machine('post', `/environments/${w.dev}/runtime`, t.accessToken)).status).toBe(
      200,
    );
    const denied = await grant(w, w.owner, identity.id, w.dev, 'environment-lister', 'DENY');
    expect(denied.status).toBe(201);
    // DENY of environment:read hides the environment entirely.
    expect((await machine('post', `/environments/${w.dev}/runtime`, t.accessToken)).status).toBe(
      404,
    );

    const summary = machineIdentitySummarySchema.parse(denied.body);
    const deny = summary.grants.find((g) => g.effect === 'DENY');
    const allow = summary.grants.find((g) => g.effect === 'ALLOW');
    await clearStepUp(w.owner);
    const lift = await api.call(
      w.owner,
      'delete',
      `${base(w)}/${identity.id}/grants/${deny?.id ?? ''}`,
    );
    expect(errorCode(lift.body)).toBe('STEP_UP_REQUIRED');
    await api.stepUp(w.owner);
    await api.ok(
      api.call(w.owner, 'delete', `${base(w)}/${identity.id}/grants/${deny?.id ?? ''}`),
      200,
    );
    expect((await machine('post', `/environments/${w.dev}/runtime`, t.accessToken)).status).toBe(
      200,
    );
    await api.ok(
      api.call(w.owner, 'delete', `${base(w)}/${identity.id}/grants/${allow?.id ?? ''}`),
      200,
    );
    expect((await machine('post', `/environments/${w.dev}/runtime`, t.accessToken)).status).toBe(
      404,
    );
  });
});

describe('credentials', () => {
  it('rejects tampered, malformed and unknown credentials', async () => {
    const { identity, issued } = await ready('mi-invalid');
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;
    expect(errorCode((await exchange(tampered)).body)).toBe('INVALID_CREDENTIAL');
    expect(
      await h.db.auditEvent.count({
        where: { action: 'machine.authentication_failed', actorServiceIdentityId: identity.id },
      }),
    ).toBe(1);
    expect((await exchange('evv_sk_short')).status).toBe(401);
    expect((await exchange(`evv_sk_${'Z'.repeat(16)}_${'a'.repeat(43)}`)).status).toBe(401);
    const t = await token(issued.token);
    // An access token is not a credential, so it cannot mint more tokens.
    expect(errorCode((await exchange(t.accessToken)).body)).toBe('INVALID_CREDENTIAL');
    expect((await h.api().post('/api/v1/machine/token').send({})).status).toBe(401);
  });

  it('stops revoked credentials, their tokens and disabled identities immediately', async () => {
    const { w, identity, issued } = await ready('mi-revoke');
    const t = await token(issued.token);
    await api.stepUp(w.owner);
    await api.ok(
      api.call(
        w.owner,
        'post',
        `${base(w)}/${identity.id}/credentials/${issued.credential.id}/revoke`,
        {
          reason: 'leaked in a build log',
        },
      ),
      200,
    );
    const replay = await machine('post', `/environments/${w.dev}/runtime`, t.accessToken);
    expect(replay.status).toBe(401);
    expect(errorCode(replay.body)).toBe('TOKEN_REVOKED');
    expect(errorCode((await exchange(issued.token)).body)).toBe('CREDENTIAL_REVOKED');

    const second = await issue(w, w.owner, identity.id, undefined, 'second');
    const t2 = await token(second.token);
    await api.ok(
      api.call(w.owner, 'post', `${base(w)}/${identity.id}/disable`, { reason: 'incident' }),
      200,
    );
    expect((await machine('get', '/identity', t2.accessToken)).status).toBe(401);
    expect(errorCode((await exchange(second.token)).body)).toBe('IDENTITY_DISABLED');
    await clearStepUp(w.owner);
    expect(
      errorCode((await api.call(w.owner, 'post', `${base(w)}/${identity.id}/enable`)).body),
    ).toBe('STEP_UP_REQUIRED');
    await api.stepUp(w.owner);
    await api.ok(api.call(w.owner, 'post', `${base(w)}/${identity.id}/enable`), 200);
    // Tokens ended by the disable stay ended; a new exchange works again.
    expect((await machine('get', '/identity', t2.accessToken)).status).toBe(401);
    expect((await exchange(second.token)).status).toBe(200);
  });

  it('expires credentials, identities and access tokens', async () => {
    const { w, identity, issued } = await ready('mi-expiry');
    await h.db.serviceCredential.update({
      where: { id: issued.credential.id },
      data: { expiresAt: new Date(Date.now() + 1500) },
    });
    const t = await token(issued.token);
    expect(new Date(t.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 1500);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(errorCode((await machine('get', '/identity', t.accessToken)).body)).toBe(
      'TOKEN_EXPIRED',
    );
    expect(errorCode((await exchange(issued.token)).body)).toBe('CREDENTIAL_EXPIRED');

    const second = await issue(w, w.owner, identity.id, undefined, 'second');
    await h.db.serviceIdentity.update({
      where: { id: identity.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(errorCode((await exchange(second.token)).body)).toBe('IDENTITY_EXPIRED');
  });

  it('rotates with an overlap, once, even under concurrency', async () => {
    const { w, identity, issued } = await ready('mi-rotate');
    await api.stepUp(w.owner);
    const rotate = (credentialId: string, overlapHours: number) =>
      api.call(w.owner, 'post', `${base(w)}/${identity.id}/credentials/${credentialId}/rotate`, {
        overlapHours,
      });
    const rotated = issuedServiceCredentialSchema.parse(
      (await rotate(issued.credential.id, 1)).body,
    );
    expect(rotated.credential.rotatedFromId).toBe(issued.credential.id);
    expect(rotated.credential.scopes).toEqual(issued.credential.scopes);
    const overlapEnd = new Date(rotated.previousExpiresAt ?? 0).getTime();
    expect(overlapEnd).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(overlapEnd).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
    expect((await exchange(issued.token)).status).toBe(200);
    expect((await exchange(rotated.token)).status).toBe(200);
    expect(errorCode((await rotate(issued.credential.id, 1)).body)).toBe(
      'CREDENTIAL_ALREADY_ROTATED',
    );

    const results = await Promise.all([
      rotate(rotated.credential.id, 0),
      rotate(rotated.credential.id, 0),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = issuedServiceCredentialSchema.parse(results.find((r) => r.status === 201)?.body);
    expect(errorCode((await exchange(rotated.token)).body)).toBe('CREDENTIAL_REVOKED');
    expect((await exchange(winner.token)).status).toBe(200);
  });

  it('retires an identity for good', async () => {
    const { w, identity, issued } = await ready('mi-retire');
    await api.ok(api.call(w.owner, 'delete', `${base(w)}/${identity.id}`), 204);
    expect(errorCode((await exchange(issued.token)).body)).toBe('CREDENTIAL_REVOKED');
    expect(await h.db.accessPolicy.count({ where: { serviceIdentityId: identity.id } })).toBe(0);
    const list = machineIdentityListSchema.parse((await api.call(w.owner, 'get', base(w))).body);
    expect(list.items).toEqual([]);
    const retired = machineIdentityListSchema.parse(
      (await api.call(w.owner, 'get', `${base(w)}?includeRetired=true`)).body,
    );
    expect(retired.items[0]).toMatchObject({ id: identity.id, status: 'RETIRED' });
    // The name is free again for a new identity.
    await createIdentity(w, w.owner);
  });
});

describe('boundaries', () => {
  it('keeps machine tokens off human routes and human tokens off machine routes', async () => {
    const { w, issued } = await ready('mi-routes');
    const t = await token(issued.token);
    for (const path of ['/api/v1/users/me', '/api/v1/workspaces', `/api/v1${base(w)}`]) {
      const response = await h.api().get(path).set('Authorization', `Bearer ${t.accessToken}`);
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('MACHINE_TOKEN_NOT_ALLOWED');
    }
    const raw = await h
      .api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${issued.token}`);
    expect(errorCode(raw.body)).toBe('SERVICE_CREDENTIAL_NOT_ACCEPTED');
    expect(JSON.stringify(raw.body)).not.toContain(issued.token);
    const rawOnMachine = await machine('get', '/identity', issued.token);
    expect(errorCode(rawOnMachine.body)).toBe('SERVICE_CREDENTIAL_NOT_ACCEPTED');
    const human = await h
      .api()
      .get('/api/v1/machine/identity')
      .set('Authorization', await h.bearer(w.owner));
    expect(errorCode(human.body)).toBe('MACHINE_TOKEN_REQUIRED');
    const cli = await machine('get', '/identity', `evv_at_${'a'.repeat(43)}`);
    expect(errorCode(cli.body)).toBe('MACHINE_TOKEN_REQUIRED');
    // A token that merely looks like one is refused without detail.
    const forged = await machine('get', '/identity', `evv_mt_${'a'.repeat(43)}`);
    expect(forged.status).toBe(401);
    expect(errorCode(forged.body)).toBe('TOKEN_INVALID');
  });

  it('isolates projects and workspaces', async () => {
    const { w, identity, issued } = await ready('mi-tenant');
    const other = await api.world('mi-tenant-other');
    await api.createSecret(other.owner, other.secrets(other.dev), { key: 'OTHER', value: VALUE });
    const t = await token(issued.token);
    expect(
      (await machine('post', `/environments/${other.dev}/runtime`, t.accessToken)).status,
    ).toBe(404);
    // Another workspace's owner cannot see or manage this identity through their own project.
    expect((await api.call(other.owner, 'get', `${base(other)}/${identity.id}`)).status).toBe(404);
    // Nor grant it an environment of their project.
    await api.stepUp(other.owner);
    expect(
      (
        await api.call(other.owner, 'post', `${base(other)}/${identity.id}/grants`, {
          environmentId: other.dev,
          roleKey: 'environment-runtime',
        })
      ).status,
    ).toBe(404);
    // And this project cannot grant it an environment of another project.
    expect((await grant(w, w.owner, identity.id, other.dev)).status).toBe(404);
  });

  it('rate limits exchanges per credential and runtime loads per environment', async () => {
    const { w, issued } = await ready('mi-rate');
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await exchange(issued.token)).status);
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses[8]).toBe(429);

    const second = await issue(
      w,
      w.owner,
      (await h.db.serviceIdentity.findFirstOrThrow()).id,
      undefined,
      'b',
    );
    const t = await token(second.token);
    const loads: number[] = [];
    for (let i = 0; i < 7; i++) {
      loads.push((await machine('post', `/environments/${w.dev}/runtime`, t.accessToken)).status);
    }
    expect(loads.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(loads[6]).toBe(429);
  });
});
