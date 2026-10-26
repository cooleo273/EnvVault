import { generateKeyring, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import {
  effectiveConfigurationSchema,
  environmentComparisonSchema,
  readinessReportSchema,
  restorePreviewSchema,
  restoreResultSchema,
  revealedSecretSchema,
  secretListSchema,
  secretVersionPageSchema,
  snapshotDetailSchema,
  snapshotDiffSchema,
  snapshotPageSchema,
  snapshotSummarySchema,
  validationRuleSchema,
} from '@envvault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Harness, type TestUser } from './support/harness.js';
import { client } from './support/secrets-world.js';

// Synthetic values only.
const V1 = 'synthetic-intel-one-31ac';
const V2 = 'synthetic-intel-two-8f02';

let h: Harness;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    { SECRET_BULK_READ_RATE_LIMIT: '200' },
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

type World = Awaited<ReturnType<typeof api.world>>;

async function qa(w: World): Promise<string> {
  const created = await api.ok(
    api.call(w.owner, 'post', `/workspaces/${w.ws}/projects/${w.project}/environments`, {
      name: 'QA',
      kind: 'TESTING',
    }),
    201,
    z.object({ id: z.uuid() }),
  );
  return created.id;
}

function envPath(w: World, env: string) {
  return `/workspaces/${w.ws}/projects/${w.project}/environments/${env}`;
}

async function compare(
  user: TestUser,
  w: World,
  source: string,
  target: string,
  extra: object = {},
) {
  return api.call(user, 'post', `/workspaces/${w.ws}/projects/${w.project}/environments/compare`, {
    sourceEnvironmentId: source,
    targetEnvironmentId: target,
    ...extra,
  });
}

async function idOf(user: TestUser, path: string, key: string) {
  const list = await api.ok(api.call(user, 'get', `${path}?pageSize=100`), 200, secretListSchema);
  const found = list.items.find((s) => s.key === key);
  if (!found) throw new Error(`no ${key}`);
  return found;
}

describe('environment comparison', () => {
  it('compares metadata by default and never returns values', async () => {
    const w = await api.world();
    const q = await qa(w);
    await api.createSecret(w.owner, w.secrets(w.dev), {
      key: 'SHARED',
      value: V1,
      isRequired: true,
    });
    await api.createSecret(w.owner, w.secrets(q), { key: 'SHARED', value: V1 });
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'PORT', type: 'NUMBER', value: '80' });
    await api.createSecret(w.owner, w.secrets(q), { key: 'PORT', type: 'STRING', value: '80' });
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'ONLY_DEV', value: V2 });
    await api.createSecret(w.owner, w.secrets(q), { key: 'ONLY_QA', value: V2 });

    const response = await compare(w.owner, w, w.dev, q);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-intel/);
    const result = environmentComparisonSchema.parse(response.body);
    expect(result.summary).toMatchObject({
      both: 2,
      onlySource: 1,
      onlyTarget: 1,
      typeMismatch: 1,
      requiredMismatch: 1,
      valuesEqual: 0,
    });
    const byKey = Object.fromEntries(result.items.map((r) => [r.key, r]));
    expect(byKey.SHARED).toMatchObject({
      status: 'both',
      value: 'not_checked',
      differences: ['isRequired'],
    });
    expect(byKey.PORT?.differences).toContain('type');
    expect(byKey.ONLY_DEV?.status).toBe('only_source');

    const filtered = environmentComparisonSchema.parse(
      (await compare(w.owner, w, w.dev, q, { filter: 'only_target' })).body,
    );
    expect(filtered.items.map((r) => r.key)).toEqual(['ONLY_QA']);
  });

  it('compares values on the server only with read access to both', async () => {
    const w = await api.world();
    const q = await qa(w);
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'SAME', value: V1 });
    await api.createSecret(w.owner, w.secrets(q), { key: 'SAME', value: V1 });
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'DIFF', value: V1 });
    await api.createSecret(w.owner, w.secrets(q), { key: 'DIFF', value: V2 });
    await api.createSecret(w.owner, w.secrets(q), { key: 'EMPTY' });
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'EMPTY', value: '' });
    const response = await compare(w.owner, w, w.dev, q, { compareValues: true });
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-intel/);
    const result = environmentComparisonSchema.parse(response.body);
    const values = Object.fromEntries(result.items.map((r) => [r.key, r.value]));
    expect(values).toEqual({ SAME: 'equal', DIFF: 'different', EMPTY: 'not_comparable' });

    // Production values are not readable by the Project Admin without a grant.
    const prod = await compare(w.owner, w, w.dev, w.prod, { compareValues: true });
    expect(prod.status).toBe(403);
    await api.ok(compare(w.owner, w, w.dev, w.prod), 200);
  });

  it('refuses environments the caller cannot see, in this or another project', async () => {
    const w = await api.world();
    const viewer = h.newUser('viewer');
    const membership = await api.addToProject(w, viewer, 'project-viewer');
    await api.grant(w, w.prod, membership, 'environment-viewer');
    await h.db.accessPolicy.updateMany({
      where: { workspaceMembershipId: membership },
      data: { effect: 'DENY' },
    });
    expect((await compare(viewer, w, w.dev, w.prod)).status).toBe(404);
    const other = await api.world('other');
    expect((await compare(w.owner, w, w.dev, other.dev)).status).toBe(404);
    expect((await compare(other.owner, w, w.dev, w.prod)).status).toBe(404);
  });
});

describe('inheritance', () => {
  it('inherits eligible variables, lets overrides win and falls back when removed', async () => {
    const w = await api.world();
    const q = await qa(w);
    await api.createSecret(w.owner, w.secrets(w.dev), {
      key: 'LOG_LEVEL',
      type: 'STRING',
      value: 'info',
      inheritable: true,
    });
    await api.createSecret(w.owner, w.secrets(w.dev), {
      key: 'API_KEY',
      type: 'SECRET',
      value: V1,
    });
    await api.createSecret(w.owner, w.secrets(w.dev), { key: 'PLAIN', type: 'STRING', value: 'x' });
    expect(
      (
        await api.call(w.owner, 'post', w.secrets(w.dev), {
          key: 'TOKEN',
          type: 'SECRET',
          value: V2,
          inheritable: true,
        })
      ).status,
    ).toBe(400);

    const effective = await api.ok(
      api.call(w.owner, 'put', `${envPath(w, q)}/inheritance`, { baseEnvironmentId: w.dev }),
      200,
      effectiveConfigurationSchema,
    );
    expect(effective.base).toMatchObject({ id: w.dev, state: 'ok' });
    expect(effective.items.map((i) => [i.key, i.source])).toEqual([['LOG_LEVEL', 'inherited']]);

    const override = await api.createSecret(w.owner, w.secrets(q), {
      key: 'LOG_LEVEL',
      type: 'STRING',
      value: 'debug',
    });
    const overridden = await api.ok(
      api.call(w.owner, 'get', `${envPath(w, q)}/effective`),
      200,
      effectiveConfigurationSchema,
    );
    expect(overridden.items).toMatchObject([
      { key: 'LOG_LEVEL', source: 'local', overridesInherited: true },
    ]);
    // The base is untouched by the override.
    const baseId = (await idOf(w.owner, w.secrets(w.dev), 'LOG_LEVEL')).id;
    expect(
      revealedSecretSchema.parse(
        (await api.call(w.owner, 'post', `${w.secrets(w.dev)}/${baseId}/reveal`)).body,
      ).value,
    ).toBe('info');

    await api.ok(api.call(w.owner, 'delete', `${w.secrets(q)}/${override.id}`), 204);
    const fallback = await api.ok(
      api.call(w.owner, 'get', `${envPath(w, q)}/effective`),
      200,
      effectiveConfigurationSchema,
    );
    expect(fallback.items).toMatchObject([{ key: 'LOG_LEVEL', source: 'inherited' }]);
    const event = await h.db.auditEvent.findFirstOrThrow({
      where: { action: 'environment.inheritance_changed' },
    });
    expect(event.metadata).toMatchObject({ from: null, to: w.dev });
  });

  it('rejects protected, self, chained, cross project and archived bases', async () => {
    const w = await api.world();
    const q = await qa(w);
    const put = (env: string, base: string | null) =>
      api.call(w.owner, 'put', `${envPath(w, env)}/inheritance`, { baseEnvironmentId: base });
    expect((await put(q, w.prod)).status).toBe(400);
    expect((await put(q, q)).status).toBe(400);
    await api.ok(put(q, w.dev), 200);
    expect((await put(w.dev, q)).status).toBe(400);
    const other = await api.world('other');
    expect((await put(q, other.dev)).status).toBe(404);

    // Archiving the base later breaks inheritance visibly instead of silently.
    await api.ok(api.call(w.owner, 'post', `${envPath(w, w.dev)}/archive`), 204);
    const broken = await api.ok(
      api.call(w.owner, 'get', `${envPath(w, q)}/effective`),
      200,
      effectiveConfigurationSchema,
    );
    expect(broken).toMatchObject({ base: { state: 'archived' }, items: [] });
    const report = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, q)}/readiness`, {}),
      200,
      readinessReportSchema,
    );
    expect(report.status).toBe('BLOCKED');
    expect(report.issues.map((i) => i.code)).toContain('INHERITANCE_BROKEN');
  });

  it('never shows inherited configuration to someone who cannot read the base', async () => {
    const w = await api.world();
    const q = await qa(w);
    await api.createSecret(w.owner, w.secrets(w.dev), {
      key: 'LOG_LEVEL',
      type: 'STRING',
      value: 'info',
      inheritable: true,
    });
    await api.ok(
      api.call(w.owner, 'put', `${envPath(w, q)}/inheritance`, { baseEnvironmentId: w.dev }),
      200,
    );
    const dev = h.newUser('dev');
    const membership = await api.addToProject(w, dev, 'project-developer');
    await api.grant(w, w.dev, membership, 'environment-viewer');
    await h.db.accessPolicy.updateMany({
      where: { workspaceMembershipId: membership },
      data: { effect: 'DENY' },
    });
    const effective = await api.ok(
      api.call(dev, 'get', `${envPath(w, q)}/effective`),
      200,
      effectiveConfigurationSchema,
    );
    expect(effective.base).toMatchObject({ state: 'no_access', name: 'Restricted environment' });
    expect(effective.items).toEqual([]);
    // Nor can they point an environment at it, or change inheritance at all.
    expect(
      (await api.call(dev, 'put', `${envPath(w, q)}/inheritance`, { baseEnvironmentId: null }))
        .status,
    ).toBe(403);
  });
});

describe('validation and readiness', () => {
  it('reports BLOCKED, UNKNOWN and READY by precise rules without leaking values', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const rules = await api.ok(
      api.call(w.owner, 'put', `${envPath(w, w.dev)}/validation-rules`, {
        rules: [
          { key: 'DATABASE_URL', required: true, format: 'URL' },
          { key: 'PORT', format: 'NUMBER', minNumber: 1, maxNumber: 65535 },
          { key: 'MODE', allowedValues: ['dev', 'prod'] },
          { key: '*', pattern: '^[A-Z][A-Z0-9_]*$' },
        ],
      }),
      200,
      z.array(validationRuleSchema),
    );
    expect(rules).toHaveLength(4);
    expect(
      (
        await api.call(w.owner, 'put', `${envPath(w, w.dev)}/validation-rules`, {
          rules: [{ key: 'A', pattern: '(a+)+$' }],
        })
      ).status,
    ).toBe(400);

    await api.createSecret(w.owner, path, { key: 'PORT', type: 'NUMBER', value: '99999' });
    await api.createSecret(w.owner, path, { key: 'MODE', type: 'STRING', value: V1 });
    let report = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/readiness`, {}),
      200,
      readinessReportSchema,
    );
    expect(report).toMatchObject({
      status: 'BLOCKED',
      valuesInspected: false,
      coverage: { required: 1, present: 0 },
    });
    expect(report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['REQUIRED_MISSING', 'VALUE_NOT_INSPECTED']),
    );

    await api.createSecret(w.owner, path, {
      key: 'DATABASE_URL',
      value: 'postgres://db.example.test:5432/app',
    });
    report = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/readiness`, {}),
      200,
      readinessReportSchema,
    );
    // Nothing failed, but value rules were not checked: never READY.
    expect(report.status).toBe('UNKNOWN');

    const inspected = await api.call(w.owner, 'post', `${envPath(w, w.dev)}/readiness`, {
      inspectValues: true,
    });
    expect(JSON.stringify(inspected.body)).not.toMatch(/synthetic-intel|99999|db\.example/);
    report = readinessReportSchema.parse(inspected.body);
    expect(report.status).toBe('BLOCKED');
    expect(
      report.issues
        .filter((i) => i.code === 'VALUE_INVALID')
        .map((i) => i.key)
        .sort(),
    ).toEqual(['MODE', 'PORT']);

    const port = await idOf(w.owner, path, 'PORT');
    const mode = await idOf(w.owner, path, 'MODE');
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${port.id}`, {
        expectedRevision: port.revision,
        value: '8080',
      }),
      200,
    );
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${mode.id}`, {
        expectedRevision: mode.revision,
        value: 'dev',
      }),
      200,
    );
    await api.createSecret(w.owner, path, { key: 'lowercase', value: 'x' });
    report = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/readiness`, { inspectValues: true }),
      200,
      readinessReportSchema,
    );
    expect(report.issues.map((i) => i.code)).toEqual(['NAME_NOT_ALLOWED']);
    await api.ok(
      api.call(w.owner, 'delete', `${path}/${(await idOf(w.owner, path, 'lowercase')).id}`),
      204,
    );
    report = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/readiness`, { inspectValues: true }),
      200,
      readinessReportSchema,
    );
    expect(report).toMatchObject({ status: 'READY', valuesInspected: true, issues: [] });
  });

  it('does not claim values passed when they could not be decrypted or read', async () => {
    const w = await api.world();
    await api.ok(
      api.call(w.owner, 'put', `${envPath(w, w.dev)}/validation-rules`, {
        rules: [{ key: 'PORT', format: 'NUMBER' }],
      }),
      200,
    );
    const { id } = await api.createSecret(w.owner, w.secrets(w.dev), {
      key: 'PORT',
      type: 'NUMBER',
      value: '80',
    });
    await h.db.secretVersion.updateMany({ where: { secretId: id }, data: { kmsKeyVersion: '99' } });
    const report = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/readiness`, { inspectValues: true }),
      200,
      readinessReportSchema,
    );
    expect(report.status).toBe('UNKNOWN');
    expect(report.issues.map((i) => i.code)).toEqual(['VALUE_UNAVAILABLE']);

    const viewer = h.newUser('viewer');
    await api.addToProject(w, viewer, 'project-viewer');
    expect(
      (await api.call(viewer, 'post', `${envPath(w, w.dev)}/readiness`, { inspectValues: true }))
        .status,
    ).toBe(403);
    expect(
      (await api.call(viewer, 'put', `${envPath(w, w.dev)}/validation-rules`, { rules: [] }))
        .status,
    ).toBe(403);
    await api.ok(api.call(viewer, 'post', `${envPath(w, w.dev)}/readiness`, {}), 200);
  });
});

describe('snapshots, drift and restore', () => {
  async function snapshot(user: TestUser, w: World, env: string, description = 'baseline') {
    return api.ok(
      api.call(user, 'post', `${envPath(w, env)}/snapshots`, { description }),
      201,
      snapshotSummarySchema,
    );
  }

  it('captures references, reports drift without assuming values changed', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const a = await api.createSecret(w.owner, path, { key: 'A', value: V1 });
    const b = await api.createSecret(w.owner, path, { key: 'B', value: V1 });
    await api.createSecret(w.owner, path, { key: 'GONE', value: V1 });
    const snap = await snapshot(w.owner, w, w.dev);
    expect(snap.entryCount).toBe(3);
    const detail = await api.ok(
      api.call(w.owner, 'get', `${envPath(w, w.dev)}/snapshots/${snap.id}`),
      200,
      snapshotDetailSchema,
    );
    expect(JSON.stringify(detail)).not.toMatch(/synthetic-intel/);
    expect(detail.entries.map((e) => [e.key, e.version])).toEqual([
      ['A', 1],
      ['B', 1],
      ['GONE', 1],
    ]);

    // A: new version with the same value. B: new value. GONE: deleted. NEW: added.
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${a.id}`, { expectedRevision: 1, value: V1 }),
      200,
    );
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${b.id}`, {
        expectedRevision: 1,
        value: V2,
        category: 'Changed',
      }),
      200,
    );
    await api.ok(
      api.call(w.owner, 'delete', `${path}/${(await idOf(w.owner, path, 'GONE')).id}`),
      204,
    );
    await api.createSecret(w.owner, path, { key: 'NEW', value: V2 });

    const drift = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/snapshots/${snap.id}/diff`, {}),
      200,
      snapshotDiffSchema,
    );
    expect(drift.summary).toEqual({
      added: 1,
      removed: 1,
      modified: 2,
      unchanged: 0,
      versionChanged: 2,
    });
    const rows = Object.fromEntries(drift.items.map((r) => [r.key, r]));
    expect(rows.A).toMatchObject({
      change: 'modified',
      versionChanged: true,
      value: 'not_checked',
      fields: [],
    });
    expect(rows.B?.fields).toEqual(['category']);
    const valued = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/snapshots/${snap.id}/diff`, {
        compareValues: true,
      }),
      200,
      snapshotDiffSchema,
    );
    const values = Object.fromEntries(valued.items.map((r) => [r.key, r.value]));
    expect(values).toMatchObject({ A: 'equal', B: 'different' });
    expect(JSON.stringify(valued)).not.toMatch(/synthetic-intel/);
    // No snapshot table stores values.
    const stored = JSON.stringify(await h.db.environmentSnapshotEntry.findMany());
    expect(stored).not.toMatch(/synthetic-intel/);
    const list = await api.ok(
      api.call(w.owner, 'get', `${envPath(w, w.dev)}/snapshots`),
      200,
      snapshotPageSchema,
    );
    expect(list.total).toBe(1);
  });

  it('previews and restores atomically as new versions, keeping history', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const a = await api.createSecret(w.owner, path, { key: 'A', value: V1, category: 'Original' });
    const gone = await api.createSecret(w.owner, path, { key: 'GONE', value: V1 });
    const snap = await snapshot(w.owner, w, w.dev);
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${a.id}`, {
        expectedRevision: 1,
        value: V2,
        category: 'Edited',
      }),
      200,
    );
    await api.ok(api.call(w.owner, 'delete', `${path}/${gone.id}`), 204);
    await api.createSecret(w.owner, path, { key: 'ADDED', value: V2 });
    const historyBefore = await h.db.secretVersion.findMany({
      where: { secretId: a.id },
      orderBy: { versionNumber: 'asc' },
    });

    const preview = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/snapshots/${snap.id}/restore/preview`, {
        removeAdded: true,
      }),
      200,
      restorePreviewSchema,
    );
    expect(preview.counts).toEqual({
      update: 1,
      undelete: 1,
      delete: 1,
      unchanged: 0,
      valueRestores: 1,
    });
    expect(preview.conflicts).toEqual([]);
    const result = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/snapshots/${snap.id}/restore`, {
        expectedState: preview.expectedState,
        removeAdded: true,
        changeReason: 'roll back release',
      }),
      200,
      restoreResultSchema,
    );
    expect(result).toMatchObject({ updated: 1, undeleted: 1, deleted: 1, valueRestores: 1 });

    const list = await api.ok(api.call(w.owner, 'get', path), 200, secretListSchema);
    expect(list.items.map((s) => s.key).sort()).toEqual(['A', 'GONE']);
    expect(list.items.find((s) => s.key === 'A')).toMatchObject({
      category: 'Original',
      currentVersion: 3,
    });
    expect(
      revealedSecretSchema.parse((await api.call(w.owner, 'post', `${path}/${a.id}/reveal`)).body)
        .value,
    ).toBe(V1);
    const page = await api.ok(
      api.call(w.owner, 'get', `${path}/${a.id}/versions`),
      200,
      secretVersionPageSchema,
    );
    expect(page.items[0]).toMatchObject({
      version: 3,
      origin: 'RESTORE',
      restoredFromVersion: 1,
      changeReason: 'roll back release',
    });
    const historyAfter = await h.db.secretVersion.findMany({
      where: { secretId: a.id, versionNumber: { lte: 2 } },
      orderBy: { versionNumber: 'asc' },
    });
    expect(historyAfter).toEqual(historyBefore);
    const actions = (await h.db.auditEvent.findMany({ where: { projectId: w.project } })).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'environment.snapshot_created',
        'environment.snapshot_restore_started',
        'environment.snapshot_restored',
      ]),
    );
  });

  it('refuses stale previews, name conflicts and missing keys without changing anything', async () => {
    const w = await api.world();
    const path = w.secrets(w.dev);
    const a = await api.createSecret(w.owner, path, { key: 'A', value: V1 });
    const snap = await snapshot(w.owner, w, w.dev);
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${a.id}`, { expectedRevision: 1, value: V2 }),
      200,
    );
    const restorePath = `${envPath(w, w.dev)}/snapshots/${snap.id}/restore`;
    const preview = await api.ok(
      api.call(w.owner, 'post', `${restorePath}/preview`, {}),
      200,
      restorePreviewSchema,
    );

    // Someone edits after the preview.
    await api.ok(
      api.call(w.owner, 'patch', `${path}/${a.id}`, { expectedRevision: 2, tags: ['late'] }),
      200,
    );
    const stale = await api.call(w.owner, 'post', restorePath, {
      expectedState: preview.expectedState,
      removeAdded: true,
    });
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toBe('SNAPSHOT_STALE');

    // The snapshot's version needs a key that is not available: nothing is written.
    const v1 = await h.db.secretVersion.findFirstOrThrow({
      where: { secretId: a.id, versionNumber: 1 },
    });
    await h.db.secretVersion.update({ where: { id: v1.id }, data: { kmsKeyVersion: '42' } });
    const fresh = await api.ok(
      api.call(w.owner, 'post', `${restorePath}/preview`, {}),
      200,
      restorePreviewSchema,
    );
    const missing = await api.call(w.owner, 'post', restorePath, {
      expectedState: fresh.expectedState,
      removeAdded: true,
    });
    expect(missing.status).toBe(503);
    expect(await h.db.secretVersion.count({ where: { secretId: a.id } })).toBe(2);
    await h.db.secretVersion.update({ where: { id: v1.id }, data: { kmsKeyVersion: '1' } });

    // A deleted variable whose name is in use again cannot come back.
    const b = await api.createSecret(w.owner, path, { key: 'B', value: V1 });
    const snap2 = await snapshot(w.owner, w, w.dev, 'with B');
    await api.ok(api.call(w.owner, 'delete', `${path}/${b.id}`), 204);
    await api.createSecret(w.owner, path, { key: 'B', value: V2 });
    const blocked = await api.ok(
      api.call(w.owner, 'post', `${envPath(w, w.dev)}/snapshots/${snap2.id}/restore/preview`, {
        removeAdded: false,
      }),
      200,
      restorePreviewSchema,
    );
    expect(blocked.conflicts.map((c) => c.key)).toEqual(['B']);
    const refused = await api.call(
      w.owner,
      'post',
      `${envPath(w, w.dev)}/snapshots/${snap2.id}/restore`,
      {
        expectedState: blocked.expectedState,
        removeAdded: false,
      },
    );
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      'SNAPSHOT_RESTORE_BLOCKED',
    );
  });

  it('keeps restore behind write, rollback, direct grants and step up', async () => {
    const w = await api.world();
    const dev = h.newUser('dev');
    const membership = await api.addToProject(w, dev, 'project-developer');
    const snap = await snapshot(dev, w, w.dev);
    // Developers write values but cannot roll back.
    expect(
      (await api.call(dev, 'post', `${envPath(w, w.dev)}/snapshots/${snap.id}/restore/preview`, {}))
        .status,
    ).toBe(403);
    // A snapshot id is not valid under another environment.
    expect(
      (await api.call(w.owner, 'get', `${envPath(w, w.prod)}/snapshots/${snap.id}`)).status,
    ).toBe(404);

    await api.grant(w, w.prod, membership, 'environment-writer');
    await api.createSecret(dev, w.secrets(w.prod), { key: 'P', value: V1 });
    const prodSnap = await snapshot(dev, w, w.prod);
    const preview = await api.ok(
      api.call(dev, 'post', `${envPath(w, w.prod)}/snapshots/${prodSnap.id}/restore/preview`, {}),
      200,
      restorePreviewSchema,
    );
    expect(preview.requiresStepUp).toBe(true);
    const body = { expectedState: preview.expectedState, removeAdded: true };
    const needsStepUp = await api.call(
      dev,
      'post',
      `${envPath(w, w.prod)}/snapshots/${prodSnap.id}/restore`,
      body,
    );
    expect((needsStepUp.body as { error: { code: string } }).error.code).toBe('STEP_UP_REQUIRED');
    await api.stepUp(dev);
    await api.ok(
      api.call(dev, 'post', `${envPath(w, w.prod)}/snapshots/${prodSnap.id}/restore`, body),
      200,
      restoreResultSchema,
    );
    // The owner administers the project but cannot snapshot Production without a grant.
    expect((await api.call(w.owner, 'post', `${envPath(w, w.prod)}/snapshots`, {})).status).toBe(
      403,
    );
  });
});
