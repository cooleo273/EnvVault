import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  integrationConnectionSchema,
  integrationMappingSchema,
  machineIdentitySummarySchema,
  issuedServiceCredentialSchema,
  machineTokenSchema,
  syncJobListSchema,
  syncJobSchema,
  syncPlanSchema,
  type SyncPlan,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorCode, Harness, type TestUser } from './support/harness.js';
import { MockVercel } from './support/mock-vercel.js';
import { client } from './support/secrets-world.js';

// Synthetic values and tokens only.
const TOKEN = 'synthetic-vercel-token-0123456789abcdef';
const OTHER_TOKEN = 'synthetic-vercel-token-fedcba9876543210';
const DEV_VALUE = 'synthetic-dev-database-url-4a1f';
const PROD_VALUE = 'synthetic-prod-api-key-77de';

let h: Harness;
let api: ReturnType<typeof client>;
let vercel: MockVercel;

beforeAll(async () => {
  vercel = await MockVercel.start();
  h = await Harness.start(
    { VERCEL_API_URL: vercel.url, STEP_UP_RATE_LIMIT: '100', INTEGRATION_SYNC_RATE_LIMIT: '100' },
    {
      encryption: {
        status: 'ready',
        provider: new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' }),
      },
    },
  );
  api = client(h);
});
afterAll(async () => {
  await h.stop();
  await vercel.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
  vercel.reset();
  vercel.tokens.set(TOKEN, { userId: 'user_synthetic', username: 'synthetic', teams: ['team_a'] });
  vercel.addProject('prj_web', 'web', 'team_a');
  vercel.addProject('prj_other', 'other', 'team_other');
});

/** A world whose lead administers the project and may export Development and Production. */
async function world(label = 'int') {
  const w = await api.world(label);
  const lead = h.newUser(`${label}-lead`);
  const membership = await api.addToProject(w, lead, 'project-admin');
  await api.grant(w, w.prod, membership, 'environment-writer');
  await api.grant(w, w.prod, membership, 'environment-exporter');
  const base = `/workspaces/${w.ws}/projects/${w.project}/integrations`;
  return { ...w, lead, base, membership };
}
type World = Awaited<ReturnType<typeof world>>;

async function secret(w: World, env: string, key: string, value: string, type = 'SECRET') {
  return api.createSecret(w.lead, w.secrets(env), { key, value, type });
}

async function connect(w: World, user: TestUser = w.lead, token = TOKEN) {
  await api.stepUp(user);
  return api.ok(
    api.call(user, 'post', `${w.base}/vercel`, { name: 'Vercel web', token, teamId: 'team_a' }),
    201,
    integrationConnectionSchema,
  );
}

async function linked(w: World, target = 'PREVIEW', env = w.dev, extra: object = {}) {
  const connection = await connect(w);
  await api.stepUp(w.lead);
  await api.ok(
    api.call(w.lead, 'put', `${w.base}/${connection.id}/vercel/project`, { projectId: 'prj_web' }),
    200,
  );
  await api.stepUp(w.lead);
  const mapping = await api.ok(
    api.call(w.lead, 'post', `${w.base}/${connection.id}/mappings`, {
      environmentId: env,
      target,
      ...extra,
    }),
    201,
    integrationMappingSchema,
  );
  return { connection, mapping, path: `${w.base}/${connection.id}/mappings/${mapping.id}` };
}

async function preview(w: World, path: string): Promise<SyncPlan> {
  return api.ok(api.call(w.lead, 'post', `${path}/preview`, {}), 200, syncPlanSchema);
}

async function sync(w: World, path: string, options: object = {}, user: TestUser = w.lead) {
  const plan = await preview(w, path);
  await api.stepUp(user);
  return api.call(user, 'post', `${path}/sync`, { planHash: plan.planHash, ...options });
}

const actions = (plan: SyncPlan) =>
  Object.fromEntries(
    plan.items.map((i) => [i.key, i.conflict ? `${i.action}:${i.conflict}` : i.action]),
  );

describe('Vercel connection', () => {
  it('stores the token encrypted and never returns or records it', async () => {
    const w = await world();
    const connection = await connect(w);
    expect(connection.account).toEqual({ id: 'team_a', name: 'Synthetic Team', type: 'team' });
    expect(connection.hasCredential).toBe(true);
    const row = await h.db.integrationConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(Buffer.from(row.credentialCiphertext ?? []).toString('utf8')).not.toContain(TOKEN);
    expect(row.encryptionKeyId).not.toBeNull();
    const everything = JSON.stringify([
      (await api.call(w.lead, 'get', w.base)).body,
      (await api.call(w.lead, 'get', `${w.base}/${connection.id}`)).body,
      await h.db.auditEvent.findMany({ where: { workspaceId: w.ws } }),
      row.config,
    ]);
    expect(everything).not.toContain(TOKEN);
  });

  it('refuses invalid tokens and unknown teams, storing nothing', async () => {
    const w = await world();
    await api.stepUp(w.lead);
    const bad = await api.call(w.lead, 'post', `${w.base}/vercel`, {
      name: 'Bad',
      token: OTHER_TOKEN,
    });
    expect(bad.status).toBe(502);
    expect(errorCode(bad.body)).toBe('PROVIDER_AUTH_FAILED');
    const team = await api.call(w.lead, 'post', `${w.base}/vercel`, {
      name: 'Bad',
      token: TOKEN,
      teamId: 'team_nope',
    });
    expect(errorCode(team.body)).toBe('PROVIDER_FORBIDDEN');
    expect(await h.db.integrationConnection.count()).toBe(0);
  });

  it('needs integration:manage and a password confirmation; integration settings never reveal values', async () => {
    const w = await world();
    const developer = h.newUser('developer');
    await api.addToProject(w, developer, 'project-developer');
    await api.stepUp(developer);
    expect(
      (await api.call(developer, 'post', `${w.base}/vercel`, { name: 'x', token: TOKEN })).status,
    ).toBe(403);
    expect((await api.call(developer, 'get', w.base)).status).toBe(403);
    await h.db.authStepUpGrant.deleteMany({});
    const noStepUp = await api.call(w.lead, 'post', `${w.base}/vercel`, {
      name: 'x',
      token: TOKEN,
    });
    expect(errorCode(noStepUp.body)).toBe('STEP_UP_REQUIRED');
  });

  it('keeps workspaces and projects apart', async () => {
    const a = await world('alpha');
    const b = await world('beta');
    const connection = await connect(a);
    expect((await api.call(b.lead, 'get', `${b.base}/${connection.id}`)).status).toBe(404);
    expect(
      (
        await api.call(
          a.lead,
          'get',
          `/workspaces/${a.ws}/projects/${b.project}/integrations/${connection.id}`,
        )
      ).status,
    ).toBe(404);
    // An environment of another project cannot be mapped.
    await api.stepUp(a.lead);
    await api.ok(
      api.call(a.lead, 'put', `${a.base}/${connection.id}/vercel/project`, {
        projectId: 'prj_web',
      }),
      200,
    );
    await api.stepUp(a.lead);
    expect(
      (
        await api.call(a.lead, 'post', `${a.base}/${connection.id}/mappings`, {
          environmentId: b.dev,
          target: 'PREVIEW',
        })
      ).status,
    ).toBe(404);
    // A Vercel project of another account cannot be linked.
    await api.stepUp(a.lead);
    const foreign = await api.call(a.lead, 'put', `${a.base}/${connection.id}/vercel/project`, {
      projectId: 'prj_other',
    });
    expect(foreign.status).toBe(422);
    expect(errorCode(foreign.body)).toBe('PROVIDER_NOT_FOUND');
  });

  it('refuses machine tokens', async () => {
    const w = await world();
    await connect(w);
    const base = `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;
    const identity = await api.ok(
      api.call(w.lead, 'post', base, { name: 'ci' }),
      201,
      machineIdentitySummarySchema,
    );
    await api.stepUp(w.lead);
    const issued = await api.ok(
      api.call(w.lead, 'post', `${base}/${identity.id}/credentials`, {
        name: 'ci',
        scopes: ['environment:read'],
      }),
      201,
      issuedServiceCredentialSchema,
    );
    const token = machineTokenSchema.parse(
      (
        await h
          .api()
          .post('/api/v1/machine/token')
          .set('Authorization', `Bearer ${issued.token}`)
          .send({})
      ).body,
    );
    const response = await h
      .api()
      .get(`/api/v1${w.base}`)
      .set('Authorization', `Bearer ${token.accessToken}`);
    expect(errorCode(response.body)).toBe('MACHINE_TOKEN_NOT_ALLOWED');
  });

  it('records health when Vercel revokes the token, and disconnecting erases it', async () => {
    const w = await world();
    const { connection, path } = await linked(w);
    vercel.tokens.delete(TOKEN);
    const check = await api.call(w.lead, 'post', `${w.base}/${connection.id}/check`, {});
    expect(errorCode(check.body)).toBe('PROVIDER_AUTH_FAILED');
    const after = integrationConnectionSchema.parse(
      (await api.call(w.lead, 'get', `${w.base}/${connection.id}`)).body,
    );
    expect(after).toMatchObject({ status: 'ERROR', lastErrorCode: 'PROVIDER_AUTH_FAILED' });
    expect(errorCode((await api.call(w.lead, 'post', `${path}/preview`, {})).body)).toBe(
      'PROVIDER_AUTH_FAILED',
    );

    await api.stepUp(w.lead);
    await api.ok(api.call(w.lead, 'delete', `${w.base}/${connection.id}`), 204);
    const row = await h.db.integrationConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    expect(row.credentialCiphertext).toBeNull();
    expect(row.disconnectedAt).not.toBeNull();
    expect(await h.db.integrationEnvironmentMapping.count()).toBe(0);
  });
});

describe('Vercel synchronisation', () => {
  it('previews by key only and pushes authorised values once confirmed', async () => {
    const w = await world();
    await secret(w, w.dev, 'DATABASE_URL', DEV_VALUE);
    await secret(w, w.dev, 'LOG_LEVEL', 'debug', 'STRING');
    vercel.addVariable('prj_web', { key: 'UNRELATED' });
    const { path } = await linked(w);
    const plan = await preview(w, path);
    expect(actions(plan)).toEqual({ DATABASE_URL: 'create', LOG_LEVEL: 'create' });
    expect(plan.unrelated).toBe(1);
    expect(JSON.stringify(plan)).not.toContain(DEV_VALUE);
    await api.stepUp(w.lead);
    const job = await api.ok(
      api.call(w.lead, 'post', `${path}/sync`, { planHash: plan.planHash }),
      200,
      syncJobSchema,
    );
    expect(job).toMatchObject({ status: 'SUCCEEDED', redeployRequired: true });
    expect(job.counts).toEqual({ written: 2 });
    const pushed = Object.fromEntries(vercel.variables('prj_web').map((v) => [v.key, v]));
    expect(pushed.DATABASE_URL).toMatchObject({
      value: DEV_VALUE,
      type: 'sensitive',
      target: ['preview'],
    });
    expect(pushed.LOG_LEVEL).toMatchObject({ value: 'debug', type: 'encrypted' });
    expect(pushed.UNRELATED?.value).toBe('synthetic-dashboard-value');
    // EnvVault never asks Vercel for decrypted values.
    expect(vercel.requests.some((r) => r.includes('decrypt'))).toBe(false);
    expect(actions(await preview(w, path))).toEqual({
      DATABASE_URL: 'unchanged',
      LOG_LEVEL: 'unchanged',
    });
    const audits = await h.db.auditEvent.findMany({ where: { workspaceId: w.ws } });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['integration.values_exported', 'integration.synced']),
    );
    const recorded = JSON.stringify([audits, await h.db.integrationSyncJob.findMany()]);
    expect(recorded).not.toContain(DEV_VALUE);
    expect(recorded).not.toContain(TOKEN);
  });

  it('needs secret:export on the environment: integration settings are not secret access', async () => {
    const w = await world();
    await secret(w, w.dev, 'A', DEV_VALUE);
    const { path } = await linked(w);
    // A workspace admin manages integrations but holds no secret permission.
    const admin = h.newUser('admin');
    await api.join(w.owner, w.ws, admin, 'admin');
    await api.stepUp(admin);
    expect((await api.call(admin, 'post', `${path}/preview`, {})).status).toBe(403);
    const plan = await preview(w, path);
    const refused = await api.call(admin, 'post', `${path}/sync`, { planHash: plan.planHash });
    expect(refused.status).toBe(403);
    expect(vercel.variables('prj_web')).toHaveLength(0);
    const refusals = await h.db.auditEvent.findMany({
      where: { action: 'integration.sync_refused' },
    });
    expect(refusals.map((r) => (r.metadata as { attempted: string }).attempted).sort()).toEqual([
      'integration.previewed',
      'integration.synced',
    ]);
  });

  it('updates changed values and leaves external edits and unmanaged variables alone unless overwriting', async () => {
    const w = await world();
    const a = await secret(w, w.dev, 'A', 'synthetic-a-1');
    await secret(w, w.dev, 'B', 'synthetic-b-1');
    vercel.addVariable('prj_web', { key: 'TAKEN', value: 'synthetic-theirs' });
    await secret(w, w.dev, 'TAKEN', 'synthetic-ours');
    const { path } = await linked(w);
    await sync(w, path);
    expect(vercel.variables('prj_web').find((v) => v.key === 'TAKEN')?.value).toBe(
      'synthetic-theirs',
    );

    await api.ok(
      api.call(w.lead, 'patch', `${w.secrets(w.dev)}/${a.id}`, {
        value: 'synthetic-a-2',
        expectedRevision: 1,
      }),
      200,
    );
    vercel.edit('prj_web', 'B', 'synthetic-b-edited-in-vercel');
    expect(actions(await preview(w, path))).toEqual({
      A: 'update',
      B: 'conflict:changed_externally',
      TAKEN: 'conflict:unmanaged',
    });
    const cautious = syncJobSchema.parse((await sync(w, path)).body);
    expect(Object.fromEntries(cautious.items.map((i) => [i.key, i.outcome]))).toEqual({
      A: 'written',
      B: 'skipped',
      TAKEN: 'skipped',
    });
    expect(vercel.variables('prj_web').find((v) => v.key === 'B')?.value).toBe(
      'synthetic-b-edited-in-vercel',
    );

    const forced = syncJobSchema.parse((await sync(w, path, { overwrite: true })).body);
    expect(forced.status).toBe('SUCCEEDED');
    const values = Object.fromEntries(vercel.variables('prj_web').map((v) => [v.key, v.value]));
    expect(values).toMatchObject({
      A: 'synthetic-a-2',
      B: 'synthetic-b-1',
      TAKEN: 'synthetic-ours',
    });
  });

  it('removes only managed variables, and only when asked', async () => {
    const w = await world();
    const gone = await secret(w, w.dev, 'OLD', 'synthetic-old');
    vercel.addVariable('prj_web', { key: 'UNRELATED' });
    const { path } = await linked(w);
    await sync(w, path);
    await api.stepUp(w.lead);
    await api.ok(api.call(w.lead, 'delete', `${w.secrets(w.dev)}/${gone.id}`), 204);
    expect(actions(await preview(w, path))).toEqual({ OLD: 'remove' });
    await sync(w, path);
    expect(
      vercel
        .variables('prj_web')
        .map((v) => v.key)
        .sort(),
    ).toEqual(['OLD', 'UNRELATED']);
    const removed = syncJobSchema.parse((await sync(w, path, { removeManaged: true })).body);
    expect(removed.items).toEqual([
      { key: 'OLD', action: 'remove', outcome: 'removed', errorCode: null },
    ]);
    expect(vercel.variables('prj_web').map((v) => v.key)).toEqual(['UNRELATED']);
  });

  it('refuses a run whose plan changed since the preview', async () => {
    const w = await world();
    await secret(w, w.dev, 'A', 'synthetic-a');
    const { path } = await linked(w);
    const plan = await preview(w, path);
    await secret(w, w.dev, 'B', 'synthetic-b');
    await api.stepUp(w.lead);
    const stale = await api.call(w.lead, 'post', `${path}/sync`, { planHash: plan.planHash });
    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe('SYNC_PLAN_CHANGED');
    expect(vercel.variables('prj_web')).toHaveLength(0);
    const jobs = await h.db.integrationSyncJob.findMany();
    expect(jobs.map((j) => [j.status, j.errorCode])).toEqual([['CANCELLED', 'SYNC_PLAN_CHANGED']]);
  });

  it('needs explicit confirmation for protected environments and Vercel Production', async () => {
    const w = await world();
    await secret(w, w.prod, 'API_KEY', PROD_VALUE);
    const { path } = await linked(w, 'PRODUCTION', w.prod);
    const plan = await preview(w, path);
    expect(plan.requiresConfirmation).toEqual({ protectedEnvironment: true, production: true });
    await api.stepUp(w.lead);
    const unconfirmed = await api.call(w.lead, 'post', `${path}/sync`, {
      planHash: plan.planHash,
      confirmProtected: true,
    });
    expect(errorCode(unconfirmed.body)).toBe('SYNC_CONFIRMATION_REQUIRED');
    expect(vercel.variables('prj_web')).toHaveLength(0);
    const done = syncJobSchema.parse(
      (await sync(w, path, { confirmProtected: true, confirmProduction: true })).body,
    );
    expect(done.status).toBe('SUCCEEDED');
    expect(vercel.variables('prj_web')[0]).toMatchObject({
      value: PROD_VALUE,
      target: ['production'],
    });
  });

  it('cannot reach a protected environment without a direct grant there', async () => {
    const w = await world();
    await secret(w, w.prod, 'API_KEY', PROD_VALUE);
    const { path } = await linked(w, 'PRODUCTION', w.prod);
    // The project admin role alone gives no data access to protected Production.
    const other = h.newUser('other-admin');
    await api.addToProject(w, other, 'project-admin');
    await api.stepUp(other);
    const plan = await preview(w, path);
    const refused = await api.call(other, 'post', `${path}/sync`, {
      planHash: plan.planHash,
      confirmProtected: true,
      confirmProduction: true,
    });
    expect(refused.status).toBe(403);
    expect(vercel.variables('prj_web')).toHaveLength(0);
  });

  it('reports partial success precisely and a retry completes only what is missing', async () => {
    const w = await world();
    for (const key of ['A', 'B', 'C']) await secret(w, w.dev, key, `synthetic-${key}`);
    const { path } = await linked(w);
    vercel.rejectKeys.add('B');
    const partial = syncJobSchema.parse((await sync(w, path)).body);
    expect(partial.status).toBe('PARTIAL');
    expect(Object.fromEntries(partial.items.map((i) => [i.key, [i.outcome, i.errorCode]]))).toEqual(
      {
        A: ['written', null],
        B: ['failed', 'PROVIDER_REJECTED'],
        C: ['written', null],
      },
    );
    vercel.rejectKeys.clear();
    expect(actions(await preview(w, path))).toEqual({
      A: 'unchanged',
      B: 'create',
      C: 'unchanged',
    });
    const retried = syncJobSchema.parse((await sync(w, path)).body);
    expect(retried.counts).toEqual({ unchanged: 2, written: 1 });
    expect(vercel.variables('prj_web')).toHaveLength(3);
  });

  it('stops at a provider rate limit and says when to retry', async () => {
    const w = await world();
    for (const key of ['A', 'B', 'C']) await secret(w, w.dev, key, `synthetic-${key}`);
    const { path } = await linked(w);
    vercel.rateLimitAfterWrites = 1;
    const job = syncJobSchema.parse((await sync(w, path)).body);
    expect(job).toMatchObject({
      status: 'PARTIAL',
      errorCode: 'PROVIDER_RATE_LIMITED',
      retryAfterSeconds: 42,
    });
    expect(job.items.map((i) => i.outcome)).toEqual(['written', 'failed', 'not_attempted']);
  });

  it('fails cleanly while Vercel is down, writing nothing', async () => {
    const w = await world();
    await secret(w, w.dev, 'A', 'synthetic-a');
    const { path } = await linked(w);
    const plan = await preview(w, path);
    vercel.down = true;
    expect(errorCode((await api.call(w.lead, 'post', `${path}/preview`, {})).body)).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    await api.stepUp(w.lead);
    const response = await api.call(w.lead, 'post', `${path}/sync`, { planHash: plan.planHash });
    expect(response.status).toBe(503);
    vercel.down = false;
    expect(vercel.variables('prj_web')).toHaveLength(0);
    const jobs = syncJobListSchema.parse(
      (await api.call(w.lead, 'get', `${path.split('/mappings')[0]}/jobs`)).body,
    );
    expect(jobs.items[0]?.status).toBe('FAILED');
  });

  it('runs one synchronisation of a mapping at a time', async () => {
    const w = await world();
    await secret(w, w.dev, 'A', 'synthetic-a');
    const { path } = await linked(w);
    const plan = await preview(w, path);
    await api.stepUp(w.lead);
    vercel.listDelayMs = 400;
    const [first, second] = await Promise.all([
      api.call(w.lead, 'post', `${path}/sync`, { planHash: plan.planHash }),
      new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
        api.call(w.lead, 'post', `${path}/sync`, { planHash: plan.planHash }),
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(errorCode((first.status === 409 ? first : second).body)).toBe('SYNC_IN_PROGRESS');
    expect(vercel.variables('prj_web')).toHaveLength(1);
  });

  it('maps Preview branches and custom environments, and refuses duplicates', async () => {
    const w = await world();
    vercel.projects
      .get('prj_web')
      ?.customEnvironments.push({ id: 'env_qa', slug: 'qa', type: 'preview' });
    await secret(w, w.dev, 'A', 'synthetic-a');
    const { connection, path } = await linked(w, 'PREVIEW', w.dev, { gitBranch: 'staging' });
    await sync(w, path);
    expect(vercel.variables('prj_web')[0]).toMatchObject({
      target: ['preview'],
      gitBranch: 'staging',
    });
    await api.stepUp(w.lead);
    const dup = await api.call(w.lead, 'post', `${w.base}/${connection.id}/mappings`, {
      environmentId: w.dev,
      target: 'PREVIEW',
      gitBranch: 'staging',
    });
    expect(errorCode(dup.body)).toBe('MAPPING_EXISTS');
    await api.stepUp(w.lead);
    const missing = await api.call(w.lead, 'post', `${w.base}/${connection.id}/mappings`, {
      environmentId: w.dev,
      target: 'CUSTOM',
      customEnvironmentId: 'env_nope',
    });
    expect(errorCode(missing.body)).toBe('PROVIDER_NOT_FOUND');
    await api.stepUp(w.lead);
    const custom = await api.ok(
      api.call(w.lead, 'post', `${w.base}/${connection.id}/mappings`, {
        environmentId: w.dev,
        target: 'CUSTOM',
        customEnvironmentId: 'env_qa',
      }),
      201,
      integrationMappingSchema,
    );
    expect(custom.customEnvironment).toEqual({ id: 'env_qa', slug: 'qa' });
    await sync(w, `${w.base}/${connection.id}/mappings/${custom.id}`);
    expect(
      vercel.variables('prj_web').find((v) => v.customEnvironmentIds.includes('env_qa')),
    ).toMatchObject({ key: 'A', target: [] });
  });

  it('keeps job history after a mapping or connection is removed, with no values', async () => {
    const w = await world();
    await secret(w, w.dev, 'A', DEV_VALUE);
    const { connection, path } = await linked(w);
    await sync(w, path);
    await api.stepUp(w.lead);
    await api.ok(api.call(w.lead, 'delete', `${w.base}/${connection.id}`), 204);
    const jobs = syncJobListSchema.parse(
      (await api.call(w.lead, 'get', `${w.base}/${connection.id}/jobs`)).body,
    );
    expect(jobs.items).toHaveLength(1);
    expect(JSON.stringify(jobs)).not.toContain(DEV_VALUE);
    expect(vercel.variables('prj_web')).toHaveLength(1);
  });
});
