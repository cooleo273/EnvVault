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
const HISTORY = '20261022090000_secret_version_history';

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
    `UPDATE secrets SET latest_version_number = 2 WHERE key = 'K_API_KEY'`,
    `INSERT INTO secret_versions (id, workspace_id, secret_id, version_number, ciphertext, iv, auth_tag, encrypted_data_key, encryption_key_id, kms_key_version, created_by_user_id)
     VALUES ('0190a000-0000-7000-8000-000000000201', '${IDS.workspace}', '0190a000-0000-7000-8000-000000000101', 1, decode('${ciphertext.toString('hex')}', 'hex'), decode('${'00'.repeat(12)}', 'hex'), decode('${'11'.repeat(16)}', 'hex'), decode('${'22'.repeat(61)}', 'hex'), '${IDS.key}', '1', '${IDS.user}')`,
    `INSERT INTO secret_versions (id, workspace_id, secret_id, version_number, ciphertext, iv, auth_tag, encrypted_data_key, encryption_key_id, kms_key_version, created_by_user_id)
     VALUES ('0190a000-0000-7000-8000-000000000202', '${IDS.workspace}', '0190a000-0000-7000-8000-000000000101', 2, decode('${ciphertext.toString('hex')}ff', 'hex'), decode('${'33'.repeat(12)}', 'hex'), decode('${'44'.repeat(16)}', 'hex'), decode('${'55'.repeat(61)}', 'hex'), '${IDS.key}', '1', '${IDS.user}')`,
    `UPDATE secrets SET current_version_id = '0190a000-0000-7000-8000-000000000202' WHERE key = 'K_API_KEY'`,
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

// Each step runs the real Prisma CLI, a few seconds apiece.
describe(`migration ${SECRETS_CRUD}`, { timeout: 120_000 }, () => {
  const before = ALL.slice(0, ALL.indexOf(SECRETS_CRUD));
  let db: PrismaClient | undefined;

  beforeAll(() => {
    expect(before.length).toBeGreaterThan(0);
    expect(ALL).toContain(HISTORY);
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
      '0190a000-0000-7000-8000-000000000202',
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
    // 20261022090000_secret_version_history: provenance backfilled, bytes untouched.
    const history = await migrated.$queryRawUnsafe<
      { id: string; origin: string; change_reason: string | null; ciphertext: Buffer }[]
    >(
      `SELECT id, origin::text AS origin, change_reason, ciphertext FROM secret_versions ORDER BY version_number`,
    );
    expect(history.map((v) => [v.origin, v.change_reason])).toEqual([
      ['CREATE', null],
      ['UPDATE', null],
    ]);
    expect(history.map((v) => Buffer.from(v.ciphertext).toString('hex'))).toEqual(
      versionBefore.map((v) => Buffer.from(v.ciphertext as Uint8Array).toString('hex')),
    );
    await expect(
      migrated.$executeRawUnsafe(`UPDATE secret_versions SET origin = 'ROLLBACK'`),
    ).rejects.toThrow(/immutable/);
  });
});

const INTELLIGENCE = '20261023090000_environment_intelligence';
const HARDENING = '20261024090000_security_hardening';

/** Phase 3C shape: live and deleted variables, a rollback, audit events and a change request. */
async function loadPhase3cData(db: PrismaClient): Promise<void> {
  const v = (n: number) => `0190a000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;
  const s = (n: number) => `0190a000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`;
  const bytes = (hex: string, n: number) => `decode('${hex.repeat(n)}', 'hex')`;
  const version = (id: string, secret: string, n: number, origin: string, from: string | null) =>
    `INSERT INTO secret_versions (id, workspace_id, secret_id, version_number, ciphertext, iv, auth_tag, encrypted_data_key, encryption_key_id, kms_key_version, origin, restored_from_version_id, created_by_user_id)
     VALUES ('${id}', '${IDS.workspace}', '${secret}', ${String(n)}, ${bytes('a1', 30 + n)}, ${bytes('b2', 12)}, ${bytes('c3', 16)}, ${bytes('d4', 61)}, '${IDS.key}', '1', '${origin}', ${from ? `'${from}'` : 'NULL'}, '${IDS.user}')`;
  const statements = [
    `INSERT INTO users (id, email, auth_user_id, updated_at) VALUES ('${IDS.user}', 'phase3c@example.test', 'test:phase3c', now())`,
    `INSERT INTO workspaces (id, name, slug, updated_at) VALUES ('${IDS.workspace}', 'Phase 3C', 'phase3c', now())`,
    `INSERT INTO projects (id, workspace_id, name, slug, updated_at, color, icon) VALUES ('${IDS.project}', '${IDS.workspace}', 'P', 'p', now(), 'slate', 'folder')`,
    `INSERT INTO environments (id, workspace_id, project_id, name, slug, kind, sort_order, updated_at, color, is_protected) VALUES ('${IDS.environment}', '${IDS.workspace}', '${IDS.project}', 'Prod', 'prod', 'PRODUCTION', 0, now(), 'slate', true)`,
    `INSERT INTO encryption_keys (id, workspace_id, version, kms_provider, kms_key_ref, updated_at) VALUES ('${IDS.key}', '${IDS.workspace}', 1, 'local', 'local-phase3c', now())`,
    `INSERT INTO secrets (id, workspace_id, project_id, environment_id, key, type, tags, is_required, revision, latest_version_number, created_by_user_id, updated_by_user_id, updated_at)
     VALUES ('${s(1)}', '${IDS.workspace}', '${IDS.project}', '${IDS.environment}', 'DATABASE_URL', 'SECRET', ARRAY['db'], true, 4, 3, '${IDS.user}', '${IDS.user}', now()),
            ('${s(2)}', '${IDS.workspace}', '${IDS.project}', '${IDS.environment}', 'LOG_LEVEL', 'STRING', ARRAY[]::text[], false, 1, 1, '${IDS.user}', '${IDS.user}', now())`,
    `INSERT INTO secrets (id, workspace_id, project_id, environment_id, key, type, latest_version_number, created_by_user_id, updated_by_user_id, updated_at, deleted_at, deleted_by_user_id)
     VALUES ('${s(3)}', '${IDS.workspace}', '${IDS.project}', '${IDS.environment}', 'OLD_TOKEN', 'SECRET', 1, '${IDS.user}', '${IDS.user}', now(), now(), '${IDS.user}')`,
    version(v(1), s(1), 1, 'CREATE', null),
    version(v(2), s(1), 2, 'UPDATE', null),
    version(v(3), s(1), 3, 'ROLLBACK', v(1)),
    version(v(4), s(2), 1, 'IMPORT', null),
    version(v(5), s(3), 1, 'CREATE', null),
    `UPDATE secrets SET current_version_id = '${v(3)}' WHERE id = '${s(1)}'`,
    `UPDATE secrets SET current_version_id = '${v(4)}' WHERE id = '${s(2)}'`,
    `UPDATE secrets SET current_version_id = '${v(5)}' WHERE id = '${s(3)}'`,
    `INSERT INTO audit_events (id, workspace_id, actor_type, actor_user_id, action, outcome, resource_type, metadata)
     VALUES ('0190a000-0000-7000-8000-000000000601', '${IDS.workspace}', 'USER', '${IDS.user}', 'secret.revealed', 'SUCCESS', 'secret', '{"key":"DATABASE_URL"}'),
            ('0190a000-0000-7000-8000-000000000602', NULL, 'SYSTEM', NULL, 'system.started', 'SUCCESS', 'system', '{}')`,
    `INSERT INTO change_requests (id, workspace_id, project_id, environment_id, title, required_approvals, requested_by_id, updated_at)
     VALUES ('${IDS.changeRequest}', '${IDS.workspace}', '${IDS.project}', '${IDS.environment}', 'Pending', 1, '${IDS.user}', now())`,
    `INSERT INTO change_request_items (id, workspace_id, change_request_id, operation, secret_id, secret_key, secret_type)
     VALUES ('0190a000-0000-7000-8000-000000000701', '${IDS.workspace}', '${IDS.changeRequest}', 'DELETE', '${s(2)}', 'LOG_LEVEL', 'STRING')`,
  ];
  for (const sql of statements) await db.$executeRawUnsafe(sql);
}

const TABLES = [
  'secrets',
  'secret_versions',
  'audit_events',
  'change_request_items',
  'environments',
  'encryption_keys',
];

async function contents(
  db: PrismaClient,
  columnsOf: Record<string, string[]>,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const columns = (columnsOf[table] ?? []).map((c) => `"${c}"`).join(', ');
    out[table] = await db.$queryRawUnsafe(`SELECT ${columns} FROM "${table}" ORDER BY "id"`);
  }
  return out;
}

async function columnsOf(db: PrismaClient): Promise<Record<string, string[]>> {
  const rows = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY ordinal_position`,
  );
  const map: Record<string, string[]> = {};
  for (const row of rows) (map[row.table_name] ??= []).push(row.column_name);
  return map;
}

describe(`migrations ${INTELLIGENCE} and ${HARDENING}`, { timeout: 120_000 }, () => {
  const before3d = ALL.slice(0, ALL.indexOf(INTELLIGENCE));
  let db: PrismaClient | undefined;

  beforeAll(() => {
    expect(ALL.indexOf(HARDENING)).toBe(ALL.indexOf(INTELLIGENCE) + 1);
  });

  afterAll(async () => {
    await db?.$disconnect();
    const admin = createPrismaClient({ connectionString: baseUrl });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
  });

  it('are each atomic: a failure on the last statement changes nothing', async () => {
    await recreateDatabase();
    deploy(before3d);
    db = createPrismaClient({ connectionString: url });
    await loadPhase3cData(db);
    const schemaBefore = await columnsOf(db);
    for (const name of [INTELLIGENCE, HARDENING]) {
      const original = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
      const failing = original.replace(/COMMIT;\s*$/, 'SELECT 1 / 0;\nCOMMIT;\n');
      expect(failing).not.toBe(original);
      const applied = name === INTELLIGENCE ? before3d : [...before3d, INTELLIGENCE];
      if (name === HARDENING) deploy(applied);
      const expected = await columnsOf(db);
      expect(() => {
        deploy([...applied, name], { name, sql: failing });
      }).toThrow();
      expect(await columnsOf(db)).toEqual(expected);
      if (name === INTELLIGENCE) {
        expect(expected).toEqual(schemaBefore);
        expect(await enumLabels(db, 'SecretVersionOrigin')).not.toContain('RESTORE');
        // A failed migration is recorded; clear it so the next deploy can retry.
        await db.$executeRawUnsafe(
          `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${name}'`,
        );
      } else {
        const triggers = await db.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'audit_seals_append_only'`,
        );
        expect(Number(triggers[0]?.n)).toBe(0);
        await expect(db.$executeRawUnsafe(`DELETE FROM audit_events`)).rejects.toThrow(
          /append-only/,
        );
        await db.$executeRawUnsafe(
          `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${name}'`,
        );
      }
    }
    await db.$disconnect();
    db = undefined;
  });

  it('keep every Phase 3C row and byte, and their constraints accept existing data', async () => {
    await recreateDatabase();
    deploy(before3d);
    db = createPrismaClient({ connectionString: url });
    await loadPhase3cData(db);
    const oldColumns = await columnsOf(db);
    const before = await contents(db, oldColumns);

    deploy([...before3d, INTELLIGENCE, HARDENING]);

    // The same columns, read after both migrations, hold the same values.
    expect(await contents(db, oldColumns)).toEqual(before);
    const added = await db.$queryRawUnsafe<{ inheritable: boolean; base: string | null }[]>(
      `SELECT s.inheritable, e.base_environment_id AS base FROM secrets s JOIN environments e ON e.id = s.environment_id`,
    );
    expect(added.every((r) => !r.inheritable && r.base === null)).toBe(true);
    expect(await enumLabels(db, 'SecretVersionOrigin')).toContain('RESTORE');
    // Recreated rollback check: the existing rollback row is still valid, an invalid one is not.
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO secret_versions (id, workspace_id, secret_id, version_number, ciphertext, iv, auth_tag, encrypted_data_key, encryption_key_id, kms_key_version, origin, created_by_user_id)
         SELECT gen_random_uuid(), workspace_id, secret_id, 9, ciphertext, iv, auth_tag, encrypted_data_key, encryption_key_id, kms_key_version, 'RESTORE', created_by_user_id FROM secret_versions LIMIT 1`,
      ),
    ).rejects.toThrow(/rollback_source_chk/);
    // Audit history stays append only; only a retention purge may delete.
    await expect(
      db.$executeRawUnsafe(`UPDATE audit_events SET outcome = 'DENIED'`),
    ).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    for (const table of [
      'audit_seals',
      'retention_policies',
      'maintenance_jobs',
      'idempotency_records',
    ]) {
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${table}"`,
      );
      expect(Number(rows[0]?.n), table).toBe(0);
    }
    // Every remaining migration (none today) still applies.
    deploy(ALL);
  });
});
