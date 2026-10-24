import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  collect,
  createEnvVaultClient,
  EnvVaultApiError,
  EnvVaultMachineClient,
  paginate,
} from '@envvault/sdk';
import {
  issuedServiceCredentialSchema,
  machineIdentitySummarySchema,
  type MachineScope,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Harness, type TestUser } from './support/harness.js';
import { client } from './support/secrets-world.js';

/**
 * The published TypeScript SDK against the real API over HTTP: the same
 * validators, guards, rate limits and audit as production. Synthetic values.
 */
const VALUE = 'synthetic-sdk-value-4e81';

let h: Harness;
let api: ReturnType<typeof client>;
let baseUrl: string;
type World = Awaited<ReturnType<ReturnType<typeof client>['world']>>;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    { MACHINE_TOKEN_RATE_LIMIT: '6' },
    { encryption: { status: 'ready', provider } },
  );
  baseUrl = await h.listen();
  api = client(h);
});
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  await truncateAllTables(h.db);
});

const person = (user: TestUser) =>
  createEnvVaultClient({ baseUrl, getAccessToken: () => user.token(), userAgent: 'sdk-test/1' });

const identities = (w: World) => `/workspaces/${w.ws}/projects/${w.project}/machine-identities`;

/** A machine identity with runtime access to Development and a credential. */
async function machine(
  w: World,
  scopes: MachineScope[] = ['environment:read', 'secret:list', 'secret:runtime'],
) {
  const identity = await api.ok(
    api.call(w.owner, 'post', identities(w), { name: `ci-${String(Date.now())}` }),
    201,
    machineIdentitySummarySchema,
  );
  await api.stepUp(w.owner);
  await api.ok(
    api.call(w.owner, 'post', `${identities(w)}/${identity.id}/grants`, {
      environmentId: w.dev,
      roleKey: 'environment-runtime',
    }),
    201,
  );
  const issued = await api.ok(
    api.call(w.owner, 'post', `${identities(w)}/${identity.id}/credentials`, {
      name: 'sdk',
      scopes,
    }),
    201,
    issuedServiceCredentialSchema,
  );
  return { identity, issued };
}

describe('TypeScript SDK against the API', () => {
  it('serves a person: compatibility, workspaces, pagination and metadata', async () => {
    const w = await api.world('sdk-person');
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_URL', value: VALUE });
    const sdk = person(w.owner);
    await expect(sdk.checkCompatibility()).resolves.toMatchObject({ protocolVersion: 1 });
    expect((await sdk.listWorkspaces()).map((ws) => ws.id)).toEqual([w.ws]);

    for (const name of ['QA', 'Preview', 'Demo']) {
      await sdk.createEnvironment(w.ws, w.project, { name, kind: 'OTHER' });
    }
    const onePerPage = await collect(
      paginate((page) => sdk.listEnvironments(w.ws, w.project, { page, pageSize: 1 })),
    );
    expect(onePerPage.map((e) => e.name).sort()).toEqual(
      ['Demo', 'Development', 'Preview', 'Production', 'QA'].sort(),
    );
    expect(await collect(sdk.iterateEnvironments(w.ws, w.project))).toHaveLength(5);
    const secrets = await collect(sdk.iterateSecrets(w.ws, w.project, w.dev));
    expect(secrets.map((s) => s.key)).toEqual(['API_URL']);
    expect(JSON.stringify(secrets)).not.toContain(VALUE);
  });

  it('raises typed errors with request ids and hides other workspaces', async () => {
    const w = await api.world('sdk-errors');
    const other = await api.world('sdk-errors-other');
    const sdk = person(w.owner);
    const error = (await sdk
      .getProject(other.ws, other.project)
      .catch((e: unknown) => e)) as EnvVaultApiError;
    expect(error).toBeInstanceOf(EnvVaultApiError);
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.requestId).toMatch(/\S+/);
    const invalid = (await sdk
      .createEnvironment(w.ws, w.project, { name: '', kind: 'OTHER' })
      .catch((e: unknown) => e)) as EnvVaultApiError;
    // Schema failures are 400 BAD_REQUEST with issues; 422 VALIDATION_FAILED is for well formed but unacceptable input.
    expect(invalid.statusCode).toBe(400);
    expect(invalid.code).toBe('BAD_REQUEST');
    expect(invalid.issues?.[0]?.path).toBe('name');
  });

  it('serves a machine: runtime values, revocation and grant removal', async () => {
    const w = await api.world('sdk-machine');
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
    const { identity, issued } = await machine(w);
    const sdk = new EnvVaultMachineClient({ baseUrl, credential: issued.token });

    expect((await sdk.identity()).identity.id).toBe(identity.id);
    expect(await sdk.runtimeValues('development')).toEqual({ API_TOKEN: VALUE });
    await expect(sdk.runtime('production')).rejects.toMatchObject({ statusCode: 404 });

    // Removing the grant takes effect on the next request with the same token.
    const grant = (
      await h.db.accessPolicy.findFirstOrThrow({ where: { serviceIdentityId: identity.id } })
    ).id;
    await api.ok(
      api.call(w.owner, 'delete', `${identities(w)}/${identity.id}/grants/${grant}`),
      200,
    );
    await expect(sdk.runtime('development')).rejects.toMatchObject({ statusCode: 404 });

    await api.stepUp(w.owner);
    await api.ok(
      api.call(
        w.owner,
        'post',
        `${identities(w)}/${identity.id}/credentials/${issued.credential.id}/revoke`,
        {},
      ),
      200,
    );
    const revoked = (await sdk.identity().catch((e: unknown) => e)) as EnvVaultApiError;
    expect(revoked.statusCode).toBe(401);
    expect(revoked.code).toBe('CREDENTIAL_REVOKED');
    await sdk.close();
  });

  it('renews an expired machine token and respects narrowed scopes', async () => {
    const w = await api.world('sdk-renew');
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'API_TOKEN', value: VALUE });
    const { issued } = await machine(w);
    const sdk = new EnvVaultMachineClient({ baseUrl, credential: issued.token });
    await sdk.identity();
    // Every token issued so far is ended server side; the client exchanges again by itself.
    await h.db.machineAccessToken.updateMany({ data: { revokedAt: new Date() } });
    await expect(sdk.runtimeValues('development')).resolves.toEqual({ API_TOKEN: VALUE });
    expect(await h.db.machineAccessToken.count()).toBe(2);

    const narrow = new EnvVaultMachineClient({
      baseUrl,
      credential: issued.token,
      scopes: ['environment:read'],
    });
    await expect(narrow.runtime('development')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('cannot reach a protected environment without a direct grant', async () => {
    const w = await api.world('sdk-protected');
    const { issued } = await machine(w);
    const sdk = new EnvVaultMachineClient({ baseUrl, credential: issued.token });
    expect((await sdk.environments()).map((e) => e.slug)).toEqual(['development']);
    await expect(sdk.runtime(w.prod)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('surfaces rate limits with Retry-After and waits only when asked to', async () => {
    const w = await api.world('sdk-rate');
    const { issued } = await machine(w);
    const anonymous = createEnvVaultClient({ baseUrl });
    const statuses: number[] = [];
    let last: EnvVaultApiError | undefined;
    for (let i = 0; i < 7; i++) {
      try {
        await anonymous.exchangeServiceCredential(issued.token);
        statuses.push(200);
      } catch (error) {
        last = error as EnvVaultApiError;
        statuses.push(last.statusCode);
      }
    }
    expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(last?.isRateLimited).toBe(true);
    expect(last?.retryAfterSeconds).toBeGreaterThan(0);
  });
});
