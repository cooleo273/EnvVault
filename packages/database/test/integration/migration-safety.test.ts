import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/client.js';

/**
 * Runs the real Prisma migration runner against a separate disposable
 * database, stopping before a migration to load representative legacy data,
 * then applies the migration and checks that every row survived.
 */

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS_DIR = join(PACKAGE_DIR, 'prisma', 'migrations');
const ALL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{14}_/.test(name))
  .sort();
const SECRETS_CRUD = '20261021090000_secrets_crud';

function sibling(url: string, suffix: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/^\//, '')}_${suffix}`;
  parsed.pathname = `/${parsed.pathname.replace(/^\//, '')}`;
  return parsed.toString();
}

const baseUrl = process.env.TEST_DATABASE_URL ?? '';
const url = sibling(baseUrl, 'migrations');
const databaseName = new URL(url).pathname.slice(1);

/** Applies exactly `names` (in order) with `prisma migrate deploy`, optionally replacing one script. */
function deploy(names: string[], override?: { name: string; sql: string }): void {
  const workdir = mkdtempSync(join(tmpdir(), 'envvault-migrations-'));
  try {
    const target = join(workdir, 'migrations');
    for (const name of names)
      cpSync(join(MIGRATIONS_DIR, name), join(target, name), { recursive: true });
    cpSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), join(target, 'migration_lock.toml'));
    if (override) writeFileSync(join(target, override.name, 'migration.sql'), override.sql);
    const config = join(workdir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(PACKAGE_DIR, 'prisma', 'schema'),
        migrations: { path: target },
        datasource: { url },
      })};\n`,
    );
    execSync(`pnpm exec prisma migrate deploy --config ${JSON.stringify(config)}`, {
      cwd: PACKAGE_DIR,
      // Pinned so nothing can fall back to a developer's .env (for example a Neon URL).
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function recreateDatabase(): Promise<void> {
  if (!/test/i.test(databaseName)) throw new Error(`Refusing to use ${databaseName}`);
  const admin = createPrismaClient({ connectionString: baseUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.$disconnect();
  }
}

const LEGACY_TYPES = [
  'GENERIC',
  'API_KEY',
  'PASSWORD',
  'CONNECTION_STRING',
  'CERTIFICATE',
  'PRIVATE_KEY',
  'JSON',
] as const;

const EXPECTED: Record<(typeof LEGACY_TYPES)[number], string> = {
  GENERIC: 'STRING',
  API_KEY: 'SECRET',
  PASSWORD: 'SECRET',
  CONNECTION_STRING: 'SECRET',
  CERTIFICATE: 'MULTILINE',
  PRIVATE_KEY: 'MULTILINE',
  JSON: 'JSON',
};

const IDS = {
  user: '0190a000-0000-7000-8000-0000000000a1',
  workspace: '0190a000-0000-7000-8000-0000000000a2',
  project: '0190a000-0000-7000-8000-0000000000a3',
  environment: '0190a000-0000-7000-8000-0000000000a4',
  key: '0190a000-0000-7000-8000-0000000000a5',
  changeRequest: '0190a000-0000-7000-8000-0000000000a6',
};

const ciphertext = randomBytes(40);

/** Legacy shape: every old type, a deleted row, a version and change request items with and without a type. */
async function loadLegacyData(db: PrismaClient): Promise<void> {
  const statements = [
    `INSERT INTO users (id, email, auth_user_id, updated_at) VALUES ('${IDS.user}', 'legacy@example.test', 'test:legacy', now())`,
    `INSERT INTO workspaces (id, name, slug, updated_at) VALUES ('${IDS.workspace}', 'Legacy', 'legacy', now())`,
    `INSERT INTO projects (id, workspace_id, name, slug, updated_at, color, icon) VALUES ('${IDS.project}', '${IDS.workspace}', 'P', 'p', now(), 'slate', 'folder')`,
    `INSERT INTO environments (id, workspace_id, project_id, name, slug, kind, sort_order, updated_at, color) VALUES ('${IDS.environment}', '${IDS.workspace}', '${IDS.project}', 'Dev', 'dev', 'DEVELOPMENT', 0, now(), 'slate')`,
    `INSERT INTO encryption_keys (id, workspace_id, version, kms_provider, kms_key_ref, updated_at) VALUES ('${IDS.key}', '${IDS.workspace}', 1, 'local', 'local-legacy', now())`,
    ...LEGACY_TYPES.map(
      (type, index) =>
        `INSERT INTO secrets (id, workspace_id, project_id, environment_id, key, type, description, created_by_user_id, updated_by_user_id, updated_at, deleted_at)
         VALUES ('0190a000-0000-7000-8000-00000000010${String(index)}', '${IDS.workspace}', '${IDS.project}', '${IDS.environment}', 'K_${type}', '${type}', 'legacy ${type}', '${IDS.user}', '${IDS.user}', now(), ${type === 'PASSWORD' ? 'now()' : 'NULL'})`,
    ),
    `UPDATE secrets SET latest_version_number = 1 WHERE key = 'K_API_KEY'`,
    `INSERT INTO secret_versions (id, workspace_id, secret_id, version_number, ciphertext, iv, auth_tag, encrypted_data_key, encryption_key_id, kms_key_version, created_by_user_id)
     VALUES ('0190a000-0000-7000-8000-000000000201', '${IDS.workspace}', '0190a000-0000-7000-8000-000000000101', 1, decode('${ciphertext.toString('hex')}', 'hex'), decode('${'00'.repeat(12)}', 'hex'), decode('${'11'.repeat(16)}', 'hex'), decode('${'22'.repeat(61)}', 'hex'), '${IDS.key}', '1', '${IDS.user}')`,
    `UPDATE secrets SET current_version_id = '0190a000-0000-7000-8000-000000000201' WHERE key = 'K_API_KEY'`,
    `INSERT INTO change_requests (id, workspace_id, project_id, environment_id, title, required_approvals, requested_by_id, updated_at)
     VALUES ('${IDS.changeRequest}', '${IDS.workspace}', '${IDS.project}', '${IDS.environment}', 'Legacy change', 0, '${IDS.user}', now())`,
    `INSERT INTO change_request_items (id, workspace_id, change_request_id, operation, secret_id, secret_key, secret_type)
     VALUES ('0190a000-0000-7000-8000-000000000301', '${IDS.workspace}', '${IDS.changeRequest}', 'DELETE', '0190a000-0000-7000-8000-000000000100', 'K_GENERIC', NULL),
            ('0190a000-0000-7000-8000-000000000302', '${IDS.workspace}', '${IDS.changeRequest}', 'DELETE', '0190a000-0000-7000-8000-000000000105', 'K_PRIVATE_KEY', 'PRIVATE_KEY')`,
  ];
  for (const sql of statements) await db.$executeRawUnsafe(sql);
}

async function enumLabels(db: PrismaClient, name: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ label: string }[]>(
    `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder`,
    name,
  );
  return rows.map((r) => r.label);
}

describe(`migration ${SECRETS_CRUD}`, () => {
  const before = ALL.slice(0, ALL.indexOf(SECRETS_CRUD));
  let db: PrismaClient | undefined;

  beforeAll(() => {
    expect(before.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await db?.$disconnect();
    const admin = createPrismaClient({ connectionString: baseUrl });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
  });

  it('is atomic: a failure late in the script leaves the legacy schema untouched', async () => {
    await recreateDatabase();
    deploy(before);
    const legacy = createPrismaClient({ connectionString: url });
    db = legacy;
    await loadLegacyData(legacy);
    const original = readFileSync(join(MIGRATIONS_DIR, SECRETS_CRUD, 'migration.sql'), 'utf8');
    // Fail as the very last statement, after every change has run.
    const failing = original.replace(/COMMIT;\s*$/, 'SELECT 1 / 0;\nCOMMIT;\n');
    expect(failing).not.toBe(original);
    expect(() => {
      deploy([...before, SECRETS_CRUD], { name: SECRETS_CRUD, sql: failing });
    }).toThrow();
    expect(await enumLabels(legacy, 'SecretType')).toEqual([...LEGACY_TYPES]);
    expect(await enumLabels(legacy, 'SecretType_legacy')).toEqual([]);
    const columns = await legacy.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'secrets' AND column_name IN ('tags', 'revision')`,
    );
    expect(columns).toEqual([]);
    await legacy.$disconnect();
    db = undefined;
  });

  it('converts every legacy row without losing data', async () => {
    await recreateDatabase();
    deploy(before);
    const migrated = createPrismaClient({ connectionString: url });
    db = migrated;
    await loadLegacyData(migrated);
    const versionBefore = await migrated.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM secret_versions ORDER BY id`,
    );

    deploy([...before, SECRETS_CRUD]);

    expect(await enumLabels(migrated, 'SecretType')).toEqual([
      'STRING',
      'SECRET',
      'BOOLEAN',
      'NUMBER',
      'JSON',
      'MULTILINE',
    ]);
    expect(await enumLabels(migrated, 'SecretType_legacy')).toEqual([]);
    const secrets = await migrated.$queryRawUnsafe<
      {
        key: string;
        type: string;
        description: string;
        tags: string[];
        revision: number;
        is_required: boolean;
        deleted: boolean;
        current_version_id: string | null;
      }[]
    >(
      `SELECT key, type::text AS type, description, tags, revision, is_required, deleted_at IS NOT NULL AS deleted, current_version_id FROM secrets ORDER BY key`,
    );
    expect(secrets).toHaveLength(LEGACY_TYPES.length);
    for (const type of LEGACY_TYPES) {
      expect(secrets.find((s) => s.key === `K_${type}`)).toMatchObject({
        type: EXPECTED[type],
        description: `legacy ${type}`,
        tags: [],
        revision: 1,
        is_required: false,
        deleted: type === 'PASSWORD',
      });
    }
    expect(secrets.find((s) => s.key === 'K_API_KEY')?.current_version_id).toBe(
      '0190a000-0000-7000-8000-000000000201',
    );
    // Versions are not touched at all.
    expect(
      await migrated.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM secret_versions ORDER BY id`,
      ),
    ).toEqual(versionBefore);
    // An optional type that was NULL stays NULL.
    const items = await migrated.$queryRawUnsafe<
      { secret_key: string; secret_type: string | null }[]
    >(
      `SELECT secret_key, secret_type::text AS secret_type FROM change_request_items ORDER BY secret_key`,
    );
    expect(items).toEqual([
      { secret_key: 'K_GENERIC', secret_type: null },
      { secret_key: 'K_PRIVATE_KEY', secret_type: 'MULTILINE' },
    ]);
    // New rows get the new default; the helper function is gone.
    const functions = await migrated.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_proc WHERE proname = 'envvault_map_legacy_secret_type'`,
    );
    expect(Number(functions[0]?.n)).toBe(0);
    // Every remaining migration still applies on top of the converted data.
    deploy(ALL);
  });
});
