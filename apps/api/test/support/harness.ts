import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@envvault/database';
import { apiErrorResponseSchema } from '@envvault/shared';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { parseEnv } from '../../src/config/env.js';
import type { EncryptionRuntime } from '../../src/encryption/encryption.config.js';
import { FakeNeonAuth } from './fake-neon-auth.js';

export interface TestUser {
  sub: string;
  email: string;
  password: string;
  token: () => Promise<string>;
}

export const WEB_ORIGIN = 'http://localhost:3000';

/**
 * The real application (all guards, pipes and filters) against the test
 * database and an in-process fake Neon Auth branch.
 */
export class Harness {
  private constructor(
    readonly app: NestExpressApplication,
    readonly db: PrismaClient,
    readonly neon: FakeNeonAuth,
  ) {}

  /** `encryption` defaults to disabled, as in an API started without ENCRYPTION_PROVIDER. */
  static async start(
    envOverrides: Record<string, string> = {},
    options: { encryption?: EncryptionRuntime } = {},
  ): Promise<Harness> {
    const neon = await FakeNeonAuth.start();
    const env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      CORS_ORIGINS: WEB_ORIGIN,
      NEON_AUTH_BASE_URL: neon.baseUrl,
      RATE_LIMIT_MAX: '10000',
      RATE_LIMIT_SENSITIVE_MAX: '10000',
      // Background workers would race the tests; tests run jobs explicitly.
      MAINTENANCE_POLL_SECONDS: '0',
      AUDIT_SEAL_INTERVAL_SECONDS: '0',
      ...envOverrides,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register(env, options.encryption ? { encryption: options.encryption } : {}),
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, env);
    await app.init();
    const db = createPrismaClient({ connectionString: process.env.TEST_DATABASE_URL ?? '' });
    return new Harness(app, db, neon);
  }

  async stop(): Promise<void> {
    await this.app.close();
    await this.db.$disconnect();
    await this.neon.stop();
  }

  api() {
    return request(this.app.getHttpServer());
  }

  newUser(label: string, overrides: { emailVerified?: boolean; email?: string } = {}): TestUser {
    const email = overrides.email ?? `${label}-${randomUUID().slice(0, 8)}@example.test`;
    const password = `pw-${randomUUID()}`;
    const sub = this.neon.addUser(email, password);
    const emailVerified = overrides.emailVerified ?? true;
    return {
      sub,
      email,
      password,
      token: () => this.neon.issueToken({ sub, email, emailVerified }),
    };
  }

  /** `Authorization` header value for a fresh token. */
  async bearer(user: TestUser): Promise<string> {
    return `Bearer ${await user.token()}`;
  }
}

export function errorCode(body: unknown): string {
  return apiErrorResponseSchema.parse(body).error.code;
}
