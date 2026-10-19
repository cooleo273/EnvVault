import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@envvault/database';
import { truncateAllTables } from '@envvault/database/testing';
import { apiErrorResponseSchema, meResponseSchema } from '@envvault/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { parseEnv } from '../src/config/env.js';
import { FakeNeonAuth } from './support/fake-neon-auth.js';

/** A route that forgot to declare an authorization requirement. */
@Controller({ path: 'undeclared', version: '1' })
class UndeclaredController {
  @Get()
  leak() {
    return { secret: 'should never be returned' };
  }
}

let neon: FakeNeonAuth;
let app: NestExpressApplication;
let db: PrismaClient;

interface TestUser {
  sub: string;
  email: string;
  password: string;
  token: () => Promise<string>;
}

function newUser(label: string, overrides: { emailVerified?: boolean } = {}): TestUser {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const sub = neon.addUser(email, password);
  return {
    sub,
    email,
    password,
    token: () => neon.issueToken({ sub, email, ...overrides }),
  };
}

function api() {
  return request(app.getHttpServer());
}

function errorCode(body: unknown): string {
  return apiErrorResponseSchema.parse(body).error.code;
}

async function createWorkspace(user: TestUser, slug: string): Promise<string> {
  const response = await api()
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${await user.token()}`)
    .send({ name: slug, slug })
    .expect(201);
  return (response.body as { id: string }).id;
}

beforeAll(async () => {
  neon = await FakeNeonAuth.start();
  const env = parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    CORS_ORIGINS: 'http://localhost:3000',
    NEON_AUTH_BASE_URL: neon.baseUrl,
    RATE_LIMIT_MAX: '10000',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(env)],
    controllers: [UndeclaredController],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, env);
  await app.init();
  db = createPrismaClient({ connectionString: process.env.TEST_DATABASE_URL ?? '' });
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
  await neon.stop();
});

beforeEach(async () => {
  await truncateAllTables(db);
});

describe('authentication', () => {
  it('rejects requests without credentials with 401 and a Bearer challenge', async () => {
    const response = await api().get('/api/v1/users/me').expect(401);
    expect(errorCode(response.body)).toBe('UNAUTHENTICATED');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects malformed authorization headers and tokens outside the header', async () => {
    const token = await newUser('fmt').token();
    for (const value of [`Basic ${token}`, `bearer ${token}`, `Bearer ${token} extra`, token]) {
      await api().get('/api/v1/users/me').set('Authorization', value).expect(401);
    }
    await api().get(`/api/v1/users/me?access_token=${token}`).expect(401);
    await api().get('/api/v1/users/me').set('Cookie', `token=${token}`).expect(401);
  });

  it('logs in a valid Neon Auth token and provisions the profile once', async () => {
    const user = newUser('login');
    const first = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${await user.token()}`)
      .expect(200);
    const me = meResponseSchema.parse(first.body);
    expect(me.user).toMatchObject({ email: user.email, emailVerified: true });
    expect(me.workspaces).toEqual([]);

    const second = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${await user.token()}`)
      .expect(200);
    expect(meResponseSchema.parse(second.body).user.id).toBe(me.user.id);
    await expect(db.user.count({ where: { authUserId: user.sub } })).resolves.toBe(1);
  });

  it('rejects invalid credentials: forged signature, unknown key and tampered claims', async () => {
    const user = newUser('invalid');
    await neon.addKey(`rogue-${randomUUID()}`, false);
    const [header, payload] = (await user.token()).split('.') as [string, string];
    for (const token of [`${header}.${payload}.AAAA`, 'garbage.token.value']) {
      const response = await api()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(errorCode(response.body)).toBe('TOKEN_INVALID');
      expect(response.headers['www-authenticate']).toContain('invalid_token');
    }
  });

  it('rejects expired credentials with TOKEN_EXPIRED', async () => {
    const user = newUser('expired');
    const token = await neon.issueToken({
      sub: user.sub,
      email: user.email,
      issuedAt: -1200,
      expiresIn: 900,
    });
    const response = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(errorCode(response.body)).toBe('TOKEN_EXPIRED');
  });

  it('rejects tokens issued by a different Neon Auth branch (dev/prod separation)', async () => {
    const user = newUser('branch');
    const token = await neon.issueToken({
      sub: user.sub,
      email: user.email,
      issuer: 'https://ep-development.neonauth.example',
      audience: 'https://ep-development.neonauth.example',
    });
    const response = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(errorCode(response.body)).toBe('TOKEN_INVALID');
  });

  it('never trusts client-supplied user ids', async () => {
    const alice = newUser('alice');
    const bob = newUser('bob');
    const bobProfile = meResponseSchema.parse(
      (
        await api()
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${await bob.token()}`)
      ).body,
    );

    const response = await api()
      .get(`/api/v1/users/me?userId=${bobProfile.user.id}`)
      .set('Authorization', `Bearer ${await alice.token()}`)
      .set('X-User-Id', bobProfile.user.id)
      .set('X-Workspace-Id', randomUUID())
      .expect(200);
    expect(meResponseSchema.parse(response.body).user.email).toBe(alice.email);
  });

  it('requires a verified email for everything except profile and logout', async () => {
    const user = newUser('unverified', { emailVerified: false });
    const token = await user.token();
    const me = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(meResponseSchema.parse(me.body).user.emailVerified).toBe(false);

    const response = await api()
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(errorCode(response.body)).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects banned identities and suspended EnvVault accounts', async () => {
    const banned = newUser('banned');
    const bannedToken = await neon.issueToken({
      sub: banned.sub,
      email: banned.email,
      banned: true,
    });
    expect(
      errorCode(
        (
          await api()
            .get('/api/v1/users/me')
            .set('Authorization', `Bearer ${bannedToken}`)
            .expect(403)
        ).body,
      ),
    ).toBe('ACCOUNT_DISABLED');

    const suspended = newUser('suspended');
    await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${await suspended.token()}`)
      .expect(200);
    await db.user.update({ where: { authUserId: suspended.sub }, data: { status: 'SUSPENDED' } });
    const response = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${await suspended.token()}`)
      .expect(403);
    expect(errorCode(response.body)).toBe('ACCOUNT_DISABLED');
  });

  it('keeps health probes public', async () => {
    await api().get('/api/v1/health').expect(200);
  });
});

describe('logout and token revocation', () => {
  it('rejects tokens issued before logout and accepts tokens issued afterwards', async () => {
    const user = newUser('logout');
    const oldToken = await neon.issueToken({ sub: user.sub, email: user.email, issuedAt: -60 });
    await api().get('/api/v1/users/me').set('Authorization', `Bearer ${oldToken}`).expect(200);

    await api()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({})
      .expect(204);

    const replay = await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(401);
    expect(errorCode(replay.body)).toBe('TOKEN_REVOKED');

    // A new sign-in mints a token issued after the logout boundary.
    const fresh = await neon.issueToken({ sub: user.sub, email: user.email, issuedAt: 2 });
    await api().get('/api/v1/users/me').set('Authorization', `Bearer ${fresh}`).expect(200);
  });

  it('records sign-out-everywhere and ends step-up', async () => {
    const user = newUser('everywhere');
    const token = await neon.issueToken({ sub: user.sub, email: user.email, issuedAt: -60 });
    await api()
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: user.password })
      .expect(200);
    await api()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ scope: 'all' })
      .expect(204);

    const profile = await db.user.findUniqueOrThrow({
      where: { authUserId: user.sub },
      select: { id: true },
    });
    await expect(
      db.authTokenRevocation.findUnique({ where: { userId: profile.id } }),
    ).resolves.toMatchObject({
      reason: 'LOGOUT_ALL_DEVICES',
    });
    await expect(db.authStepUpGrant.count({ where: { userId: profile.id } })).resolves.toBe(0);
  });
});

describe('authorization', () => {
  it('denies by default when a route declares no authorization requirement', async () => {
    const user = newUser('undeclared');
    const response = await api()
      .get('/api/v1/undeclared')
      .set('Authorization', `Bearer ${await user.token()}`)
      .expect(403);
    expect(JSON.stringify(response.body)).not.toContain('should never be returned');
  });

  it('lets owners read their workspace and lists only their own workspaces', async () => {
    const alice = newUser('owner');
    const bob = newUser('other');
    const aliceWs = await createWorkspace(alice, `alice-${randomUUID().slice(0, 6)}`);
    await createWorkspace(bob, `bob-${randomUUID().slice(0, 6)}`);

    const list = await api()
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${await alice.token()}`)
      .expect(200);
    expect((list.body as { id: string }[]).map((w) => w.id)).toEqual([aliceWs]);

    const detail = await api()
      .get(`/api/v1/workspaces/${aliceWs}`)
      .set('Authorization', `Bearer ${await alice.token()}`)
      .expect(200);
    expect(detail.body).toMatchObject({ id: aliceWs, memberCount: 1 });
    expect((detail.body as { permissions: string[] }).permissions).toContain('workspace:delete');
  });

  it('blocks cross-workspace access with 404 (no existence oracle)', async () => {
    const alice = newUser('victim');
    const mallory = newUser('attacker');
    const aliceWs = await createWorkspace(alice, `victim-${randomUUID().slice(0, 6)}`);
    const malloryToken = await mallory.token();

    for (const call of [
      () => api().get(`/api/v1/workspaces/${aliceWs}`),
      () => api().delete(`/api/v1/workspaces/${aliceWs}`),
      () => api().get(`/api/v1/workspaces/${randomUUID()}`),
      () => api().get('/api/v1/workspaces/not-a-uuid'),
    ]) {
      const response = await call().set('Authorization', `Bearer ${malloryToken}`).expect(404);
      expect(errorCode(response.body)).toBe('NOT_FOUND');
    }
    await expect(db.workspace.findUniqueOrThrow({ where: { id: aliceWs } })).resolves.toMatchObject(
      {
        deletedAt: null,
      },
    );
  });

  it('enforces permissions for members (403) and removes access when a membership is suspended', async () => {
    const owner = newUser('ws-owner');
    const member = newUser('ws-member');
    const wsId = await createWorkspace(owner, `team-${randomUUID().slice(0, 6)}`);
    await api()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${await member.token()}`)
      .expect(200);
    const memberProfile = await db.user.findUniqueOrThrow({ where: { authUserId: member.sub } });
    const memberRole = await db.role.findFirstOrThrow({
      where: { workspaceId: wsId, key: 'member' },
    });
    const membership = await db.workspaceMembership.create({
      data: { workspaceId: wsId, userId: memberProfile.id, roleId: memberRole.id },
    });

    await api()
      .get(`/api/v1/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${await member.token()}`)
      .expect(200);
    const denied = await api()
      .delete(`/api/v1/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${await member.token()}`)
      .expect(403);
    expect(errorCode(denied.body)).toBe('FORBIDDEN');

    await db.workspaceMembership.update({
      where: { id: membership.id },
      data: { status: 'SUSPENDED' },
    });
    await api()
      .get(`/api/v1/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${await member.token()}`)
      .expect(404);
  });

  it('rejects duplicate workspace slugs with 409', async () => {
    const user = newUser('slug');
    const slug = `dup-${randomUUID().slice(0, 6)}`;
    await createWorkspace(user, slug);
    const response = await api()
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${await user.token()}`)
      .send({ name: 'Again', slug })
      .expect(409);
    expect(errorCode(response.body)).toBe('SLUG_TAKEN');
  });
});

describe('step-up for sensitive actions', () => {
  it('requires a recent password re-verification before deleting a workspace', async () => {
    const owner = newUser('stepup');
    const wsId = await createWorkspace(owner, `sensitive-${randomUUID().slice(0, 6)}`);

    const required = await api()
      .delete(`/api/v1/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${await owner.token()}`)
      .expect(403);
    expect(errorCode(required.body)).toBe('STEP_UP_REQUIRED');

    const failed = await api()
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${await owner.token()}`)
      .send({ password: 'wrong password' })
      .expect(403);
    expect(errorCode(failed.body)).toBe('STEP_UP_FAILED');

    const granted = await api()
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${await owner.token()}`)
      .send({ password: owner.password })
      .expect(200);
    expect(granted.body).toMatchObject({ active: true });

    await api()
      .delete(`/api/v1/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${await owner.token()}`)
      .expect(204);
    await api()
      .get(`/api/v1/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${await owner.token()}`)
      .expect(404);

    const actions = (await db.auditEvent.findMany({ select: { action: true, outcome: true } })).map(
      (e) => `${e.action}:${e.outcome}`,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'workspace.created:SUCCESS',
        'auth.step_up.failed:DENIED',
        'auth.step_up.succeeded:SUCCESS',
        'workspace.deleted:SUCCESS',
      ]),
    );
  });

  it('never stores or echoes the submitted password', async () => {
    const owner = newUser('nopw');
    await api()
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${await owner.token()}`)
      .send({ password: owner.password })
      .expect(200);
    const audit = JSON.stringify(await db.auditEvent.findMany());
    expect(audit).not.toContain(owner.password);
  });
});

describe('identity provider outage', () => {
  it('fails closed with 503 when the JWKS cannot be fetched', async () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      CORS_ORIGINS: 'http://localhost:3000',
      NEON_AUTH_BASE_URL: 'http://127.0.0.1:1/neondb/auth',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env)],
    }).compile();
    const offline = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(offline, env);
    await offline.init();
    try {
      const user = newUser('outage');
      const response = await request(offline.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${await user.token()}`)
        .expect(503);
      expect(errorCode(response.body)).toBe('AUTH_UNAVAILABLE');
    } finally {
      await offline.close();
    }
  });
});
