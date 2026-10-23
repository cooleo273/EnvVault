import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { createRepositories } from '@envvault/database';
import { truncateAllTables } from '@envvault/database/testing';
import {
  cliDeviceRequestSchema,
  cliDeviceStartSchema,
  cliSessionListSchema,
  cliTokenSchema,
  metaResponseSchema,
  runtimeConfigurationSchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorCode, Harness, type TestUser } from './support/harness.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const VALUE = 'synthetic-runtime-value-6b2e';

let h: Harness;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    { SECRET_RUNTIME_RESOURCE_RATE_LIMIT: '8', RUNTIME_MAX_BYTES: String(64 * 1024) },
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

const DEVICE = { clientVersion: '0.1.0', hostname: 'synthetic-laptop', platform: 'darwin' };

function cli(method: 'get' | 'post' | 'delete', path: string, token: string, body?: object) {
  const request = h.api()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  return body ? request.send(body) : request.send();
}

async function start() {
  const response = await h.api().post('/api/v1/cli/device/authorize').send(DEVICE);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toContain('no-store');
  return cliDeviceStartSchema.parse(response.body);
}

async function poll(deviceCode: string) {
  return h.api().post('/api/v1/cli/device/token').send({ deviceCode });
}

/** Full sign in: request, browser approval with a step up, token. */
async function login(user: TestUser) {
  const device = await start();
  await api.stepUp(user);
  await api.ok(api.call(user, 'post', '/cli/device/approve', { userCode: device.userCode }), 204);
  const response = await poll(device.deviceCode);
  expect(response.status).toBe(200);
  return cliTokenSchema.parse(response.body);
}

async function ageGrant(userCode: string) {
  await h.db.cliDeviceGrant.updateMany({
    where: { userCode },
    data: { expiresAt: new Date(Date.now() - 1000), lastPolledAt: null },
  });
}

describe('CLI device authorization', () => {
  it('publishes the protocol version', async () => {
    const meta = metaResponseSchema.parse((await h.api().get('/api/v1/meta')).body);
    expect(meta).toMatchObject({
      protocolVersion: 1,
      features: expect.arrayContaining(['cli-device-authorization']),
    });
  });

  it('waits for approval in the browser, requires a step up, and issues tokens once', async () => {
    const w = await api.world('cli');
    const device = await start();
    expect(device.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(device.verificationUriComplete).toContain(`/cli/authorize?code=${device.userCode}`);
    expect(errorCode((await poll(device.deviceCode)).body)).toBe('AUTHORIZATION_PENDING');
    expect(errorCode((await poll(device.deviceCode)).body)).toBe('SLOW_DOWN');

    const shown = await api.ok(
      api.call(w.owner, 'get', `/cli/device/${device.userCode}`),
      200,
      cliDeviceRequestSchema,
    );
    expect(shown).toMatchObject({ hostname: 'synthetic-laptop', platform: 'darwin' });
    expect(
      errorCode(
        (await api.call(w.owner, 'post', '/cli/device/approve', { userCode: device.userCode }))
          .body,
      ),
    ).toBe('STEP_UP_REQUIRED');
    await api.stepUp(w.owner);
    await api.ok(
      api.call(w.owner, 'post', '/cli/device/approve', { userCode: device.userCode }),
      204,
    );

    await h.db.cliDeviceGrant.updateMany({
      where: { userCode: device.userCode },
      data: { lastPolledAt: null },
    });
    const issued = await poll(device.deviceCode);
    expect(issued.status).toBe(200);
    expect(issued.headers['cache-control']).toContain('no-store');
    const token = cliTokenSchema.parse(issued.body);
    expect(token.accessToken).toMatch(/^evv_at_/);
    expect(token.refreshToken).toMatch(/^evv_rt_/);
    expect(errorCode((await poll(device.deviceCode)).body)).toBe('INVALID_GRANT');

    const stored = JSON.stringify(await h.db.cliSession.findMany());
    expect(stored).not.toContain(token.accessToken);
    expect(stored).not.toContain(token.refreshToken);
    const me = await cli('get', '/users/me', token.accessToken);
    expect(me.status).toBe(200);
    expect((me.body as { user: { email: string } }).user.email).toBe(w.owner.email);
    const actions = (await h.db.auditEvent.findMany()).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['auth.cli_login_approved', 'auth.cli_session_created']),
    );
  });

  it('reports denied and expired requests', async () => {
    const w = await api.world('cli-deny');
    const denied = await start();
    await api.ok(api.call(w.owner, 'post', '/cli/device/deny', { userCode: denied.userCode }), 204);
    expect(errorCode((await poll(denied.deviceCode)).body)).toBe('ACCESS_DENIED');

    const late = await start();
    await ageGrant(late.userCode);
    expect(errorCode((await poll(late.deviceCode)).body)).toBe('EXPIRED_TOKEN');
    expect((await api.call(w.owner, 'get', `/cli/device/${late.userCode}`)).status).toBe(404);
    expect(errorCode((await poll('evv_dc_unknown')).body)).toBe('INVALID_GRANT');
  });

  it('limits CLI tokens to the routes local development needs', async () => {
    const w = await api.world('cli-scope');
    const token = await login(w.owner);
    expect((await cli('get', '/workspaces', token.accessToken)).status).toBe(200);
    for (const [method, path, body] of [
      ['post', '/workspaces', { name: 'x' }],
      ['post', `/workspaces/${w.ws}/retention/runs`, { confirm: 'x' }],
      ['post', w.secrets(w.dev), { key: 'K', value: VALUE }],
      ['post', '/cli/device/approve', { userCode: 'BCDF-GHJK' }],
      ['post', '/auth/step-up', { password: 'x' }],
    ] as const) {
      const response = await cli(method, path, token.accessToken, body);
      expect(response.status, path).toBe(403);
      expect(errorCode(response.body)).toBe('CLI_TOKEN_NOT_ALLOWED');
    }
  });
});

describe('CLI sessions', () => {
  it('rotates tokens and ends the session when an old refresh token is replayed', async () => {
    const w = await api.world('cli-rotate');
    const first = await login(w.owner);
    const refreshed = cliTokenSchema.parse(
      (await h.api().post('/api/v1/cli/token/refresh').send({ refreshToken: first.refreshToken }))
        .body,
    );
    expect(refreshed.accessToken).not.toBe(first.accessToken);
    expect(errorCode((await cli('get', '/users/me', first.accessToken)).body)).toBe(
      'TOKEN_INVALID',
    );
    expect((await cli('get', '/users/me', refreshed.accessToken)).status).toBe(200);

    const replay = await h
      .api()
      .post('/api/v1/cli/token/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    expect(errorCode((await cli('get', '/users/me', refreshed.accessToken)).body)).toBe(
      'TOKEN_REVOKED',
    );
    expect(await h.db.auditEvent.count({ where: { action: 'auth.cli_refresh_reused' } })).toBe(1);
  });

  it('expires access tokens and refreshes them', async () => {
    const w = await api.world('cli-expire');
    const token = await login(w.owner);
    await h.db.cliSession.updateMany({ data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    expect(errorCode((await cli('get', '/users/me', token.accessToken)).body)).toBe(
      'TOKEN_EXPIRED',
    );
    const refreshed = await h
      .api()
      .post('/api/v1/cli/token/refresh')
      .send({ refreshToken: token.refreshToken });
    expect(refreshed.status).toBe(200);
    await h.db.cliSession.updateMany({ data: { refreshExpiresAt: new Date(Date.now() - 1000) } });
    const tooLate = await h
      .api()
      .post('/api/v1/cli/token/refresh')
      .send({
        refreshToken: cliTokenSchema.parse(refreshed.body).refreshToken,
      });
    expect(errorCode(tooLate.body)).toBe('TOKEN_EXPIRED');
  });

  it('ends on logout, on revocation from the web, and on sign out everywhere', async () => {
    const w = await api.world('cli-revoke');
    const a = await login(w.owner);
    await api.ok(
      Promise.resolve(await cli('post', '/cli/sessions/current/revoke', a.accessToken)),
      204,
    );
    expect(errorCode((await cli('get', '/users/me', a.accessToken)).body)).toBe('TOKEN_REVOKED');

    const b = await login(w.owner);
    const list = await api.ok(api.call(w.owner, 'get', '/cli/sessions'), 200, cliSessionListSchema);
    expect(list.items.map((s) => s.id)).toEqual([b.sessionId]);
    await api.ok(api.call(w.owner, 'delete', `/cli/sessions/${b.sessionId}`), 204);
    expect(errorCode((await cli('get', '/users/me', b.accessToken)).body)).toBe('TOKEN_REVOKED');

    const c = await login(w.owner);
    await api.ok(
      api.call(w.owner, 'post', '/auth/tokens/revoke', { reason: 'sessions_revoked' }),
      204,
    );
    expect(errorCode((await cli('get', '/users/me', c.accessToken)).body)).toBe('TOKEN_REVOKED');
    expect(
      (await h.api().post('/api/v1/cli/token/refresh').send({ refreshToken: c.refreshToken }))
        .status,
    ).toBe(401);
  });
});

describe('runtime configuration', () => {
  async function setup() {
    const w = await api.world('runtime');
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'MUST_HAVE', isRequired: true });
    const dev = h.newUser('runtime-dev');
    const membershipId = await api.addToProject(w, dev, 'project-developer');
    return {
      w,
      dev,
      membershipId,
      path: (env: string) =>
        `/workspaces/${w.ws}/projects/${w.project}/environments/${env}/runtime`,
    };
  }

  it('returns values with no-store to a developer, audits the load without values', async () => {
    const { w, dev, path } = await setup();
    const token = await login(dev);
    const response = await cli('post', path(w.dev), token.accessToken, {});
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const config = runtimeConfigurationSchema.parse(response.body);
    expect(config.values).toEqual([{ key: 'API_TOKEN', value: VALUE, source: 'local' }]);
    expect(config.missingRequired).toEqual(['MUST_HAVE']);
    const events = await h.db.auditEvent.findMany({ where: { action: 'secret.runtime_loaded' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ count: 1, cli: true });
    expect(JSON.stringify(events)).not.toContain(VALUE);
  });

  it('is its own capability: export or read alone do not grant it, and protected environments need a direct grant and a step up', async () => {
    const { w, dev, membershipId, path } = await setup();
    const viewer = h.newUser('runtime-viewer');
    await api.addToProject(w, viewer, 'project-viewer');
    const viewerToken = await login(viewer);
    expect(errorCode((await cli('post', path(w.dev), viewerToken.accessToken, {})).body)).toBe(
      'FORBIDDEN',
    );

    const devToken = await login(dev);
    // Protected: nothing is inherited from the project role.
    expect(errorCode((await cli('post', path(w.prod), devToken.accessToken, {})).body)).toBe(
      'FORBIDDEN',
    );
    await api.grant(w, w.prod, membershipId, 'environment-exporter');
    expect(errorCode((await cli('post', path(w.prod), devToken.accessToken, {})).body)).toBe(
      'FORBIDDEN',
    );
    await api.grant(w, w.prod, membershipId, 'environment-reader');
    // Approving the CLI sign in left a fresh step up; protected values need one of their own.
    const devUser = await h.db.user.findFirstOrThrow({ where: { email: dev.email } });
    await createRepositories(h.db).authState.clearStepUpGrants(devUser.id);
    expect(errorCode((await cli('post', path(w.prod), devToken.accessToken, {})).body)).toBe(
      'STEP_UP_REQUIRED',
    );
    await api.stepUp(dev);
    expect((await cli('post', path(w.prod), devToken.accessToken, {})).status).toBe(200);

    const denied = await h.db.auditEvent.count({
      where: {
        action: 'secret.access_denied',
        metadata: { path: ['attempted'], equals: 'secret.runtime_loaded' },
      },
    });
    expect(denied).toBeGreaterThanOrEqual(3);
  });

  it('honours DENY, membership removal and workspace boundaries', async () => {
    const { w, dev, membershipId, path } = await setup();
    const token = await login(dev);
    await api.ok(
      api.call(
        w.owner,
        'post',
        `/workspaces/${w.ws}/projects/${w.project}/environments/${w.dev}/access`,
        {
          workspaceMembershipId: membershipId,
          roleKey: 'environment-reader',
          effect: 'DENY',
        },
      ),
      201,
    );
    expect((await cli('post', path(w.dev), token.accessToken, {})).status).toBe(404);

    const other = await api.world('runtime-other');
    const foreign = `/workspaces/${other.ws}/projects/${other.project}/environments/${other.dev}/runtime`;
    expect((await cli('post', foreign, token.accessToken, {})).status).toBe(404);
  });

  it('enforces the per environment limit and the response size limit', async () => {
    const { w, dev, path } = await setup();
    const token = await login(dev);
    let last = 0;
    for (let i = 0; i < 9; i++)
      last = (await cli('post', path(w.dev), token.accessToken, {})).status;
    expect(last).toBe(429);

    const big = await api.world('runtime-big');
    for (const key of ['BIG_A', 'BIG_B']) {
      await api.createSecret(big.owner, big.secrets(big.dev), {
        key,
        type: 'MULTILINE',
        value: 'x'.repeat(40_000),
      });
    }
    const ownerToken = await login(big.owner);
    const response = await cli(
      'post',
      `/workspaces/${big.ws}/projects/${big.project}/environments/${big.dev}/runtime`,
      ownerToken.accessToken,
      {},
    );
    expect(response.status).toBe(413);
    expect(errorCode(response.body)).toBe('RUNTIME_TOO_LARGE');
    expect(JSON.stringify(response.body)).not.toContain('xxxx');
  });

  it('includes inheritable values of a base the caller may load', async () => {
    const { w, dev, path } = await setup();
    const qa = await api.ok(
      api.call(w.owner, 'post', `/workspaces/${w.ws}/projects/${w.project}/environments`, {
        name: 'QA',
        kind: 'TESTING',
      }),
      201,
      z.object({ id: z.uuid() }),
    );
    await api.createSecret(w.owner, w.secrets(w.dev), {
      key: 'LOG_LEVEL',
      type: 'STRING',
      value: 'debug',
      inheritable: true,
    });
    await api.ok(
      api.call(
        w.owner,
        'put',
        `/workspaces/${w.ws}/projects/${w.project}/environments/${qa.id}/inheritance`,
        {
          baseEnvironmentId: w.dev,
        },
      ),
      200,
    );
    const token = await login(dev);
    const config = runtimeConfigurationSchema.parse(
      (await cli('post', path(qa.id), token.accessToken, {})).body,
    );
    expect(config.values).toEqual([{ key: 'LOG_LEVEL', value: 'debug', source: 'inherited' }]);
    expect(config.withheldInherited).toBe(0);
  });
});
