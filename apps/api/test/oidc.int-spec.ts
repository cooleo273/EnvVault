import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  machineEnvironmentSchema,
  machineIdentitySummarySchema,
  machineTokenSchema,
  oidcBindingAttemptListSchema,
  oidcTrustBindingListSchema,
  oidcTrustBindingSchema,
  runtimeConfigurationSchema,
} from '@envvault/shared';
import { type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorCode, Harness } from './support/harness.js';
import { OidcIssuer } from './support/oidc-issuer.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const DEV_VALUE = 'synthetic-oidc-dev-value-51ab';
const PROD_VALUE = 'synthetic-oidc-prod-value-8e02';
const AUD = 'https://envvault.test';
const REPO = '123456789';
const OWNER = '987654';

let h: Harness;
let api: ReturnType<typeof client>;
let issuer: OidcIssuer;

const encryption = () => ({
  status: 'ready' as const,
  provider: new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' }),
});

beforeAll(async () => {
  issuer = await OidcIssuer.start();
  h = await Harness.start(
    { OIDC_TRUSTED_ISSUERS: issuer.url, OIDC_TOKEN_RATE_LIMIT: '1000', STEP_UP_RATE_LIMIT: '100' },
    { encryption: encryption() },
  );
  api = client(h);
});
afterAll(async () => {
  await h.stop();
  await issuer.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
});

/**
 * The owner administers the project but holds no data permission on protected
 * Production, so a project lead with a direct writer grant there manages the
 * identity and its bindings, as in the Phase 4B tests.
 */
async function world(label: string) {
  const w = await api.world(label);
  const lead = h.newUser(`${label}-lead`);
  const membership = await api.addToProject(w, lead, 'project-admin');
  await api.grant(w, w.prod, membership, 'environment-writer');
  return { ...w, lead };
}
type World = Awaited<ReturnType<typeof world>>;
interface Scope {
  ws: string;
  project: string;
}

const machinesOf = (w: Scope) => `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;
const bindingsOf = (w: Scope) => `/workspaces/${w.ws}/projects/${w.project}/oidc-trust-bindings`;

async function identity(w: World, name = 'GitHub deploy') {
  const created = await api.ok(
    api.call(w.lead, 'post', machinesOf(w), { name }),
    201,
    machineIdentitySummarySchema,
  );
  return created.id;
}

async function grant(w: World, identityId: string, environmentId: string) {
  await api.stepUp(w.lead);
  await api.ok(
    api.call(w.lead, 'post', `${machinesOf(w)}/${identityId}/grants`, {
      environmentId,
      roleKey: 'environment-runtime',
    }),
    201,
  );
}

const STRICT = {
  workflowPath: '.github/workflows/deploy.yml',
  refs: ['refs/heads/main'],
  eventNames: ['push', 'workflow_dispatch'],
};

async function bind(w: World, identityId: string, environmentIds: string[], extra: object = {}) {
  await api.stepUp(w.lead);
  return api.ok(
    api.call(w.lead, 'post', bindingsOf(w), {
      identityId,
      name: 'Deploy from main',
      issuer: issuer.url,
      audience: AUD,
      repositoryId: REPO,
      repositoryOwnerId: OWNER,
      repositoryName: 'octo-org/app',
      environmentIds,
      ...STRICT,
      ...extra,
    }),
    201,
    oidcTrustBindingSchema,
  );
}

/** A world with Development (unprotected) and Production (protected) values and a bound identity. */
async function setup(label = 'oidc', extra: object = {}, environments: 'dev' | 'both' = 'dev') {
  const w = await world(label);
  await api.createSecret(w.lead, w.secrets(w.dev), { key: 'API_TOKEN', value: DEV_VALUE });
  await api.createSecret(w.lead, w.secrets(w.prod), { key: 'API_TOKEN', value: PROD_VALUE });
  const id = await identity(w);
  await grant(w, id, w.dev);
  if (environments === 'both') await grant(w, id, w.prod);
  const binding = await bind(w, id, environments === 'both' ? [w.dev, w.prod] : [w.dev], extra);
  return { w, identityId: id, binding };
}

function exchange(token: string, body: object = {}) {
  return h
    .api()
    .post('/api/v1/machine/oidc/token')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function refused(token: string, status: number, code: string, body: object = {}) {
  const response = await exchange(token, body);
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(errorCode(response.body)).toBe(code);
}

function machine(token: string) {
  return {
    get: (path: string) =>
      h.api().get(`/api/v1/machine${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      h.api().post(`/api/v1/machine${path}`).set('Authorization', `Bearer ${token}`).send(body),
  };
}

async function denials(identityId: string): Promise<string[]> {
  const rows = await h.db.auditEvent.findMany({
    where: { actorServiceIdentityId: identityId, action: 'machine.authentication_failed' },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.map((r) => String((r.metadata as Record<string, unknown>).reason));
}

const token = (claims: Record<string, unknown> = {}, extra: object = {}) =>
  issuer.token({ audience: AUD, claims, ...extra });

describe('GitHub OIDC exchange: authentication', () => {
  it('exchanges a valid token for a machine token limited to the binding', async () => {
    const { w, identityId, binding } = await setup();
    const response = await exchange(await token({ run_id: '4242' }), { projectId: w.project });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const issued = machineTokenSchema.parse(response.body);
    expect(issued.identity.id).toBe(identityId);
    expect(issued.credential.id).toBe(binding.id);
    expect(issued.environmentIds).toEqual([w.dev]);
    expect(issued.expiresIn).toBeLessThanOrEqual(900);
    expect(response.headers['cache-control']).toContain('no-store');

    const m = machine(issued.accessToken);
    const environments = z
      .object({ items: z.array(machineEnvironmentSchema) })
      .parse((await m.get('/environments')).body);
    expect(environments.items.map((e) => e.id)).toEqual([w.dev]);
    const runtime = runtimeConfigurationSchema.parse(
      (await m.post(`/environments/${w.dev}/runtime`)).body,
    );
    expect(runtime.values.find((v) => v.key === 'API_TOKEN')?.value).toBe(DEV_VALUE);

    const event = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'machine.authenticated', actorServiceIdentityId: identityId },
    });
    expect(event.metadata).toMatchObject({
      method: 'github_oidc',
      credentialId: binding.id,
      repositoryId: REPO,
      runId: '4242',
      ref: 'refs/heads/main',
    });
  });

  it('refuses tampered, malformed, unsigned and foreign key tokens', async () => {
    await setup();
    const valid = await token();
    const [header, payload, signature] = valid.split('.') as [string, string, string];
    const altered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        repository_id: '1',
      }),
    ).toString('base64url');
    await refused(`${header}.${altered}.${signature}`, 401, 'OIDC_TOKEN_INVALID');
    await refused('not-a-jwt', 401, 'OIDC_TOKEN_INVALID');
    await refused('a.b', 401, 'OIDC_TOKEN_INVALID');
    const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    await refused(`${unsignedHeader}.${payload}.`, 401, 'OIDC_TOKEN_INVALID');
    await refused(`${unsignedHeader}.${payload}.x`, 401, 'OIDC_TOKEN_INVALID');
    const rogue = await issuer.unpublishedKey();
    await refused(await token({}, { kid: rogue }), 401, 'OIDC_TOKEN_INVALID');
    // A symmetric signature with a published key id is refused: only RS256 and ES256 are accepted.
    const hmac = await new SignJWT(
      JSON.parse(Buffer.from(payload, 'base64url').toString()) as JWTPayload,
    )
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .sign(new TextEncoder().encode('a'.repeat(32)));
    await refused(hmac, 401, 'OIDC_TOKEN_INVALID');
    await refused('', 401, 'OIDC_TOKEN_INVALID');
  });

  it('refuses expired, not yet valid, future and overlong tokens', async () => {
    await setup();
    await refused(await token({}, { issuedAt: -900, expiresIn: 300 }), 401, 'OIDC_TOKEN_EXPIRED');
    await refused(await token({}, { notBefore: 600 }), 401, 'OIDC_TOKEN_INVALID');
    await refused(
      await token({}, { issuedAt: 600, notBefore: 0, expiresIn: 300 }),
      401,
      'OIDC_TOKEN_INVALID',
    );
    await refused(await token({}, { expiresIn: 7200 }), 401, 'OIDC_TOKEN_INVALID');
  });

  it('refuses issuers that are not allowlisted, even when signed by a known key', async () => {
    await setup();
    await refused(
      await token({}, { issuer: 'https://token.actions.githubusercontent.com' }),
      401,
      'OIDC_ISSUER_NOT_TRUSTED',
    );
    await refused(
      await token({}, { issuer: 'http://evil.example' }),
      401,
      'OIDC_ISSUER_NOT_TRUSTED',
    );
  });

  it('refuses tokens missing required claims or audience', async () => {
    await setup();
    for (const claim of ['repository_id', 'repository_owner_id', 'workflow_ref', 'ref', 'jti']) {
      await refused(await token({ [claim]: undefined }), 401, 'OIDC_TOKEN_INVALID');
    }
    await refused(await issuer.token({}), 401, 'OIDC_TOKEN_INVALID');
  });

  it('requires exactly the binding audience', async () => {
    const { identityId } = await setup();
    await refused(
      await issuer.token({ audience: 'https://other.test' }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    await refused(
      await issuer.token({ audience: [AUD, 'https://other.test'] }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    expect(await denials(identityId)).toEqual(['audience']);
  });

  it('accepts each identity token once', async () => {
    await setup();
    const once = await token();
    expect((await exchange(once)).status).toBe(200);
    await refused(once, 401, 'OIDC_TOKEN_REPLAYED');
  });
});

describe('GitHub OIDC exchange: trust restrictions', () => {
  it('ignores tokens from other repositories without recording them per binding', async () => {
    const { identityId } = await setup();
    await refused(await token({ repository_id: '5' }), 401, 'OIDC_NO_MATCHING_BINDING');
    expect(await denials(identityId)).toEqual([]);
  });

  it('refuses the wrong owner, branch, workflow, event and substituted workflows', async () => {
    const { identityId } = await setup();
    await refused(await token({ repository_owner_id: '1' }), 401, 'OIDC_NO_MATCHING_BINDING');
    await refused(
      await token({ ref: 'refs/heads/feature', sub: 'repo:octo-org/app:ref:refs/heads/feature' }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    await refused(
      await token({ workflow_ref: 'octo-org/app/.github/workflows/other.yml@refs/heads/main' }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    await refused(
      await token({ workflow_ref: 'attacker/app/.github/workflows/deploy.yml@refs/heads/main' }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    await refused(await token({ event_name: 'schedule' }), 401, 'OIDC_NO_MATCHING_BINDING');
    expect(await denials(identityId)).toEqual(['repository_owner', 'ref', 'workflow', 'event']);
  });

  it('refuses pull requests unless named, and pull_request_target always', async () => {
    const { w, identityId } = await setup('pr', { eventNames: [], refs: [], workflowPath: null });
    await refused(
      await token({ event_name: 'pull_request', ref: 'refs/pull/7/merge' }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    await refused(
      await token({ event_name: 'pull_request_target' }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    expect(await denials(identityId)).toEqual(['pull_request']);
    await api.stepUp(w.lead);
    expect(
      await api.fails(
        api.call(w.lead, 'post', bindingsOf(w), {
          identityId,
          name: 'Forks',
          issuer: issuer.url,
          audience: AUD,
          repositoryId: REPO,
          repositoryOwnerId: OWNER,
          repositoryName: 'octo-org/app',
          environmentIds: [w.dev],
          eventNames: ['pull_request_target'],
        }),
        400,
      ),
    ).toBe('BAD_REQUEST');
  });

  it('checks reusable workflow refs and GitHub deployment environments', async () => {
    const shared = 'octo-org/shared/.github/workflows/deploy.yml@' + 'b'.repeat(40);
    const { identityId } = await setup('reuse', {
      jobWorkflowRef: shared,
      githubEnvironments: ['staging'],
    });
    await refused(await token({ environment: 'staging' }), 401, 'OIDC_NO_MATCHING_BINDING');
    await refused(
      await token({ job_workflow_ref: shared, environment: 'production' }),
      401,
      'OIDC_NO_MATCHING_BINDING',
    );
    expect(
      (await exchange(await token({ job_workflow_ref: shared, environment: 'staging' }))).status,
    ).toBe(200);
    expect(await denials(identityId)).toEqual(['job_workflow', 'environment']);
  });

  it('stops a disabled binding at once, including tokens it already issued', async () => {
    const { w, binding, identityId } = await setup();
    const issued = machineTokenSchema.parse((await exchange(await token())).body);
    await api.ok(api.call(w.lead, 'post', `${bindingsOf(w)}/${binding.id}/disable`, {}), 200);
    const m = machine(issued.accessToken);
    const later = await m.get('/identity');
    expect(later.status).toBe(401);
    expect(errorCode(later.body)).toBe('OIDC_BINDING_DISABLED');
    await refused(await token(), 401, 'OIDC_NO_MATCHING_BINDING');
    expect(await denials(identityId)).toContain('binding_disabled');

    await api.stepUp(w.lead);
    await api.ok(api.call(w.lead, 'post', `${bindingsOf(w)}/${binding.id}/enable`, {}), 200);
    expect((await exchange(await token())).status).toBe(200);
  });

  it('refuses disabled identities and revokes tokens of deleted bindings', async () => {
    const { w, binding, identityId } = await setup();
    const issued = machineTokenSchema.parse((await exchange(await token())).body);
    await api.stepUp(w.lead);
    await api.ok(api.call(w.lead, 'delete', `${bindingsOf(w)}/${binding.id}`), 204);
    expect((await machine(issued.accessToken).get('/identity')).status).toBe(401);
    await refused(await token(), 401, 'OIDC_NO_MATCHING_BINDING');

    await bind(w, identityId, [w.dev]);
    await api.ok(api.call(w.lead, 'post', `${machinesOf(w)}/${identityId}/disable`, {}), 200);
    await refused(await token(), 401, 'OIDC_NO_MATCHING_BINDING');
    expect(await denials(identityId)).toContain('identity_disabled');
  });

  it('keeps workspaces and projects apart', async () => {
    const a = await setup('alpha');
    const b = await setup('beta');
    // The same repository is bound in two workspaces: the caller must say which.
    await refused(await token(), 409, 'OIDC_BINDING_AMBIGUOUS');
    const issued = machineTokenSchema.parse(
      (await exchange(await token(), { workspaceId: a.w.ws })).body,
    );
    expect(issued.identity.id).toBe(a.identityId);
    const m = machine(issued.accessToken);
    expect((await m.post(`/environments/${b.w.dev}/runtime`)).status).toBe(404);
    expect((await m.post(`/environments/${a.w.prod}/runtime`)).status).toBe(404);
    await refused(await token(), 401, 'OIDC_NO_MATCHING_BINDING', {
      workspaceId: a.w.ws,
      projectId: b.w.project,
    });
    // A binding id from another workspace does not help either.
    await refused(await token(), 401, 'OIDC_NO_MATCHING_BINDING', {
      workspaceId: a.w.ws,
      bindingId: b.binding.id,
    });
  });

  it('ends tokens issued under a binding when its conditions change', async () => {
    const { w, binding } = await setup();
    const issued = machineTokenSchema.parse((await exchange(await token())).body);
    await api.stepUp(w.lead);
    await api.ok(
      api.call(w.lead, 'patch', `${bindingsOf(w)}/${binding.id}`, { refs: ['refs/heads/release'] }),
      200,
    );
    const later = await machine(issued.accessToken).get('/identity');
    expect(later.status).toBe(401);
    expect(errorCode(later.body)).toBe('TOKEN_REVOKED');
  });

  it('only narrows scopes and environments at exchange', async () => {
    const { w } = await setup();
    await refused(await token(), 403, 'SCOPE_NOT_GRANTED', { environmentIds: [w.prod] });
    const narrowed = machineTokenSchema.parse(
      (await exchange(await token(), { scopes: ['environment:read'] })).body,
    );
    expect(
      (await machine(narrowed.accessToken).post(`/environments/${w.dev}/runtime`)).status,
    ).toBe(403);
  });

  it('keeps machine tokens away from binding management', async () => {
    const { w } = await setup();
    const issued = machineTokenSchema.parse((await exchange(await token())).body);
    const response = await h
      .api()
      .get(`/api/v1${bindingsOf(w)}`)
      .set('Authorization', `Bearer ${issued.accessToken}`);
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('MACHINE_TOKEN_NOT_ALLOWED');
  });
});

describe('GitHub OIDC: protected environments', () => {
  it('needs a strict binding and a direct grant to reach Production', async () => {
    const w = await world('protected');
    await api.createSecret(w.lead, w.secrets(w.prod), { key: 'API_TOKEN', value: PROD_VALUE });
    const id = await identity(w);
    await grant(w, id, w.dev);
    // No grant on Production yet.
    await api.stepUp(w.lead);
    expect(
      await api.fails(
        api.call(w.lead, 'post', bindingsOf(w), {
          identityId: id,
          name: 'Prod',
          issuer: issuer.url,
          audience: AUD,
          repositoryId: REPO,
          repositoryOwnerId: OWNER,
          repositoryName: 'octo-org/app',
          environmentIds: [w.prod],
          ...STRICT,
        }),
        422,
      ),
    ).toBe('VALIDATION_FAILED');
    await grant(w, id, w.prod);
    // Loose conditions cannot reach a protected environment.
    for (const loose of [
      { eventNames: [] },
      { refs: [], githubEnvironments: [] },
      { eventNames: ['push', 'pull_request'] },
      { refs: ['refs/heads/*'] },
    ]) {
      await api.stepUp(w.lead);
      expect(
        await api.fails(
          api.call(w.lead, 'post', bindingsOf(w), {
            identityId: id,
            name: 'Prod',
            issuer: issuer.url,
            audience: AUD,
            repositoryId: REPO,
            repositoryOwnerId: OWNER,
            repositoryName: 'octo-org/app',
            environmentIds: [w.prod],
            ...STRICT,
            ...loose,
          }),
          422,
        ),
        JSON.stringify(loose),
      ).toBe('OIDC_PROTECTED_POLICY_REQUIRED');
    }
    const binding = await bind(w, id, [w.prod], { githubEnvironments: ['production'] });
    const issued = machineTokenSchema.parse(
      (await exchange(await token({ environment: 'production' }))).body,
    );
    const runtime = runtimeConfigurationSchema.parse(
      (await machine(issued.accessToken).post(`/environments/${w.prod}/runtime`)).body,
    );
    expect(runtime.values[0]?.value).toBe(PROD_VALUE);

    // Removing the grant stops access on the next request, whatever the binding says.
    const grants = await h.db.accessPolicy.findMany({
      where: { serviceIdentityId: id, environmentId: w.prod },
    });
    await api.stepUp(w.lead);
    await api.ok(
      api.call(w.lead, 'delete', `${machinesOf(w)}/${id}/grants/${grants[0]?.id ?? ''}`),
      200,
    );
    expect((await machine(issued.accessToken).post(`/environments/${w.prod}/runtime`)).status).toBe(
      404,
    );

    // Loosening a binding that reaches Production is refused too.
    await api.stepUp(w.lead);
    await grant(w, id, w.prod);
    await api.stepUp(w.lead);
    expect(
      await api.fails(
        api.call(w.lead, 'patch', `${bindingsOf(w)}/${binding.id}`, {
          eventNames: [],
          githubEnvironments: [],
          refs: [],
        }),
        422,
      ),
    ).toBe('OIDC_PROTECTED_POLICY_REQUIRED');
  });

  it('refuses a loose binding once its environment becomes protected', async () => {
    const { w } = await setup('later', { eventNames: [], refs: [], workflowPath: null });
    expect((await exchange(await token())).status).toBe(200);
    await api.stepUp(w.lead);
    await api.ok(
      api.call(
        w.lead,
        'put',
        `/workspaces/${w.ws}/projects/${w.project}/environments/${w.dev}/protection`,
        { isProtected: true },
      ),
      204,
    );
    await refused(await token(), 403, 'OIDC_PROTECTED_POLICY_REQUIRED');
  });

  it('does not let people without the access create or change bindings', async () => {
    const { w, binding } = await setup();
    const developer = h.newUser('developer');
    await api.addToProject(w, developer, 'project-developer');
    await api.stepUp(developer);
    expect(
      (await api.call(developer, 'post', bindingsOf(w), { identityId: binding.identity.id }))
        .status,
    ).toBe(403);
    expect(
      (await api.call(developer, 'post', `${bindingsOf(w)}/${binding.id}/disable`, {})).status,
    ).toBe(403);
    // Changes need a fresh password confirmation.
    await h.db.authStepUpGrant.deleteMany({});
    const changed = await api.call(w.lead, 'patch', `${bindingsOf(w)}/${binding.id}`, {
      name: 'x',
    });
    expect(errorCode(changed.body)).toBe('STEP_UP_REQUIRED');
  });
});

describe('GitHub OIDC: operations', () => {
  it('handles concurrent jobs, each with its own token', async () => {
    await setup();
    const tokens = await Promise.all(Array.from({ length: 12 }, () => token()));
    const responses = await Promise.all(tokens.map((t) => exchange(t)));
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(200));
    const issued = new Set(responses.map((r) => machineTokenSchema.parse(r.body).accessToken));
    expect(issued.size).toBe(12);
  });

  it('audits management and attempts without tokens or values', async () => {
    const { w, binding } = await setup();
    const valid = await token({ run_id: '77' });
    await exchange(valid);
    const wrongRef = await token({ ref: 'refs/heads/dev' });
    await exchange(wrongRef);
    await api.stepUp(w.lead);
    await api.ok(
      api.call(w.lead, 'patch', `${bindingsOf(w)}/${binding.id}`, {
        refs: ['refs/heads/release'],
      }),
      200,
    );
    const attempts = await api.ok(
      api.call(w.lead, 'get', `${bindingsOf(w)}/${binding.id}/attempts`),
      200,
      oidcBindingAttemptListSchema,
    );
    expect(attempts.items.map((a) => [a.outcome, a.reason])).toEqual([
      ['DENIED', 'ref'],
      ['SUCCESS', null],
    ]);
    expect(attempts.items[1]?.runId).toBe('77');
    const events = await h.db.auditEvent.findMany({ where: { workspaceId: w.ws } });
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'oidc_trust_binding.created',
        'oidc_trust_binding.updated',
        'machine.authenticated',
        'machine.authentication_failed',
      ]),
    );
    const all = JSON.stringify(events);
    for (const secret of [valid, wrongRef, DEV_VALUE, PROD_VALUE])
      expect(all).not.toContain(secret);
    expect(all).not.toContain('evv_mt_');
    const list = await api.ok(
      api.call(w.lead, 'get', bindingsOf(w)),
      200,
      oidcTrustBindingListSchema,
    );
    expect(list.issuers).toEqual([issuer.url]);
    expect(list.items[0]?.refs).toEqual(['refs/heads/release']);
  });

  it('documents the exchange and binding routes in OpenAPI', async () => {
    const response = await h.api().get('/api/v1/openapi.json').expect(200);
    const doc = response.body as {
      paths: Record<string, Record<string, { security: unknown; 'x-envvault-callers': string[] }>>;
    };
    expect(doc.paths['/machine/oidc/token']?.post?.security).toEqual([{ githubOidc: [] }]);
    expect(doc.paths['/machine/oidc/token']?.post?.['x-envvault-callers']).toEqual(['github-oidc']);
    expect(
      doc.paths['/workspaces/{workspaceId}/projects/{projectId}/oidc-trust-bindings']?.post?.[
        'x-envvault-callers'
      ],
    ).toEqual(['person']);
  });
});

describe('GitHub OIDC: failure modes', () => {
  async function isolated(
    env: Record<string, string>,
    run: (h2: Harness, api2: ReturnType<typeof client>) => Promise<void>,
  ) {
    const h2 = await Harness.start(env, { encryption: encryption() });
    try {
      await run(h2, client(h2));
    } finally {
      await h2.stop();
    }
  }

  async function bindIn(h2: Harness, api2: ReturnType<typeof client>, iss: string) {
    await truncateAllTables(h2.db);
    const w = await api2.world('isolated');
    const created = await api2.ok(
      api2.call(w.owner, 'post', machinesOf(w), { name: 'deploy' }),
      201,
      machineIdentitySummarySchema,
    );
    await api2.stepUp(w.owner);
    await api2.ok(
      api2.call(w.owner, 'post', `${machinesOf(w)}/${created.id}/grants`, {
        environmentId: w.dev,
        roleKey: 'environment-runtime',
      }),
      201,
    );
    await api2.stepUp(w.owner);
    await api2.ok(
      api2.call(w.owner, 'post', bindingsOf(w), {
        identityId: created.id,
        name: 'Deploy',
        issuer: iss,
        audience: AUD,
        repositoryId: REPO,
        repositoryOwnerId: OWNER,
        repositoryName: 'octo-org/app',
        environmentIds: [w.dev],
        ...STRICT,
      }),
      201,
    );
    return w;
  }

  const send = (h2: Harness, jwt: string) =>
    h2.api().post('/api/v1/machine/oidc/token').set('Authorization', `Bearer ${jwt}`).send({});

  it('fails closed when the issuer keys cannot be fetched', async () => {
    const down = await OidcIssuer.start();
    down.unavailable = true;
    try {
      await isolated({ OIDC_TRUSTED_ISSUERS: down.url }, async (h2, api2) => {
        await bindIn(h2, api2, down.url);
        const response = await send(h2, await down.token({ audience: AUD }));
        expect(response.status).toBe(503);
        expect(errorCode(response.body)).toBe('OIDC_PROVIDER_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('30');
      });
    } finally {
      await down.stop();
    }
  });

  it('picks up rotated signing keys', async () => {
    const rotating = await OidcIssuer.start();
    try {
      await isolated(
        { OIDC_TRUSTED_ISSUERS: rotating.url, OIDC_JWKS_COOLDOWN_SECONDS: '0' },
        async (h2, api2) => {
          await bindIn(h2, api2, rotating.url);
          expect((await send(h2, await rotating.token({ audience: AUD }))).status).toBe(200);
          await rotating.rotate();
          expect((await send(h2, await rotating.token({ audience: AUD }))).status).toBe(200);
          expect(rotating.jwksRequests).toBeGreaterThanOrEqual(2);
        },
      );
    } finally {
      await rotating.stop();
    }
  });

  it('rate limits exchanges per repository', async () => {
    await isolated(
      { OIDC_TRUSTED_ISSUERS: issuer.url, OIDC_TOKEN_RATE_LIMIT: '2' },
      async (h2, api2) => {
        await bindIn(h2, api2, issuer.url);
        expect((await send(h2, await token())).status).toBe(200);
        expect((await send(h2, await token())).status).toBe(200);
        const limited = await send(h2, await token());
        expect(limited.status).toBe(429);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      },
    );
  });

  it('refuses exchanges while the shared limit store is down', async () => {
    await isolated(
      {
        OIDC_TRUSTED_ISSUERS: issuer.url,
        RATE_LIMIT_STORE: 'redis',
        REDIS_URL: 'redis://127.0.0.1:1',
      },
      async (h2) => {
        const response = await send(h2, await token());
        expect(response.status).toBe(503);
        expect(errorCode(response.body)).toBe('RATE_LIMIT_UNAVAILABLE');
      },
    );
  });

  it('turns the exchange off with an empty issuer list', async () => {
    await isolated({ OIDC_TRUSTED_ISSUERS: '' }, async (h2) => {
      const response = await send(h2, await token());
      expect(response.status).toBe(401);
      expect(errorCode(response.body)).toBe('OIDC_ISSUER_NOT_TRUSTED');
    });
  });
});
