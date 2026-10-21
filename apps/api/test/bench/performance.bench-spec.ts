import { writeFileSync } from 'node:fs';
import { generateKeyring, IntegrityKeys, LocalKeyProvider } from '@envvault/crypto';
import { truncateAllTables } from '@envvault/database/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { sealPending } from '../../src/audit/audit-chain.js';
import { Harness } from '../support/harness.js';
import { client } from '../support/secrets-world.js';

/*
 * Synthetic workload: one project, 2000 variables in Development (imported
 * in batches of 500) and 2000 in QA, then timed requests through the full
 * application stack (guards, authorization, PostgreSQL). Values are random
 * synthetic strings. Results go to BENCH_OUT as JSON.
 */
const VARIABLES = 2000;
const RUNS = 20;

let h: Harness;
let api: ReturnType<typeof client>;
const results: Record<string, { medianMs: number; p95Ms: number; runs: number }> = {};

beforeAll(async () => {
  const provider = new LocalKeyProvider(generateKeyring(), { nodeEnv: 'test' });
  h = await Harness.start(
    {
      SECRET_BULK_READ_RATE_LIMIT: '1000',
      SECRET_IMPORT_RATE_LIMIT: '1000',
      SNAPSHOT_RESTORE_RATE_LIMIT: '1000',
      RATE_LIMIT_USER_MAX: '100000',
    },
    { encryption: { status: 'ready', provider } },
  );
  api = client(h);
  await truncateAllTables(h.db);
});
afterAll(async () => {
  if (process.env.BENCH_OUT)
    writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(results, null, 2)}\n`);
  await h.stop();
});

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    medianMs: Math.round(at(0.5) * 10) / 10,
    p95Ms: Math.round(at(0.95) * 10) / 10,
    runs: samples.length,
  };
}

async function time(name: string, runs: number, fn: () => Promise<{ status: number }>) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const response = await fn();
    samples.push(performance.now() - started);
    expect(response.status).toBeLessThan(300);
  }
  results[name] = stats(samples);
}

async function importAll(w: Awaited<ReturnType<typeof api.world>>, env: string, prefix: string) {
  const samples: number[] = [];
  for (let batch = 0; batch < VARIABLES / 500; batch++) {
    const keys = Array.from(
      { length: 500 },
      (_, i) => `${prefix}_${String(batch * 500 + i).padStart(5, '0')}`,
    );
    const content = keys
      .map((k) => `${k}=synthetic-${Math.random().toString(36).slice(2)}`)
      .join('\n');
    const started = performance.now();
    const response = await api.call(w.owner, 'post', `${w.secrets(env)}/import`, {
      content,
      defaultType: 'STRING',
      items: keys.map((key) => ({ action: 'create', key })),
    });
    samples.push(performance.now() - started);
    expect(response.status).toBe(200);
  }
  return samples;
}

it('measures representative requests', async () => {
  const w = await api.world('bench');
  const qa = await api.ok(
    api.call(w.owner, 'post', `/workspaces/${w.ws}/projects/${w.project}/environments`, {
      name: 'QA',
      kind: 'TESTING',
    }),
    201,
    z.object({ id: z.uuid() }),
  );
  results['import 500 variables (commit)'] = stats([
    ...(await importAll(w, w.dev, 'DEV')),
    ...(await importAll(w, qa.id, 'DEV')),
  ]);

  const env = `/workspaces/${w.ws}/projects/${w.project}/environments/${w.dev}`;
  await time('project dashboard: project detail', RUNS, () =>
    api.call(w.owner, 'get', `/workspaces/${w.ws}/projects/${w.project}`),
  );
  await time('project dashboard: environment list', RUNS, () =>
    api.call(w.owner, 'get', `/workspaces/${w.ws}/projects/${w.project}/environments`),
  );
  await time('environment navigation: environment detail', RUNS, () =>
    api.call(w.owner, 'get', env),
  );
  await time('secret metadata list: page 1 of 2000 (50 rows)', RUNS, () =>
    api.call(w.owner, 'get', `${env}/secrets?pageSize=50`),
  );
  await time('secret metadata list: search', RUNS, () =>
    api.call(w.owner, 'get', `${env}/secrets?pageSize=50&q=DEV_019`),
  );
  await time('secret metadata list: page 40', RUNS, () =>
    api.call(w.owner, 'get', `${env}/secrets?pageSize=50&page=40`),
  );
  await time('compare 2000 vs 2000 (metadata)', 10, () =>
    api.call(w.owner, 'post', `/workspaces/${w.ws}/projects/${w.project}/environments/compare`, {
      sourceEnvironmentId: w.dev,
      targetEnvironmentId: qa.id,
    }),
  );
  await time('readiness on 2000 (metadata)', 10, () =>
    api.call(w.owner, 'post', `${env}/readiness`, {}),
  );
  const snapshotSamples: number[] = [];
  let snapshotId = '';
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const created = await api.ok(
      api.call(w.owner, 'post', `${env}/snapshots`, {}),
      201,
      z.object({ id: z.uuid() }),
    );
    snapshotSamples.push(performance.now() - started);
    snapshotId = created.id;
  }
  results['snapshot create (2000 variables)'] = stats(snapshotSamples);
  await time('snapshot restore preview (2000 variables)', 10, () =>
    api.call(w.owner, 'post', `${env}/snapshots/${snapshotId}/restore/preview`, {}),
  );
  await time('audit log: activity page 1', RUNS, () =>
    api.call(w.owner, 'get', `/workspaces/${w.ws}/projects/${w.project}/activity`),
  );

  const events = await h.db.auditEvent.count();
  const started = performance.now();
  const { sealed } = await sealPending(h.db, IntegrityKeys.ephemeral(), {
    now: new Date(Date.now() + 3_600_000),
  });
  results[`audit sealing (${String(sealed)} of ${String(events)} events, one pass)`] = stats([
    performance.now() - started,
  ]);
});
