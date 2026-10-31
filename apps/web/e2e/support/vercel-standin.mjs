// Test only stand in for the Vercel REST API used by the full stack tests, so
// the browser tests never reach the real Vercel. One synthetic token, team and
// project; values are kept in memory.
import { createServer } from 'node:http';

const PORT = Number(process.env.VERCEL_STANDIN_PORT ?? 4420);
const TOKEN = 'e2e-synthetic-vercel-token-000111222333';
const TEAM = 'team_e2e';
const project = { id: 'prj_e2e', name: 'e2e-web', framework: 'nextjs' };
const env = [];
let clock = 1_700_000_000_000;
let seq = 0;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const view = ({ value: _value, ...rest }) => ({ ...rest, value: '', decrypted: false });

createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname === '/__test/health') return send(res, 200, { ok: true });
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return send(res, 401, { error: { code: 'forbidden' } });
    if (url.searchParams.get('teamId') !== TEAM)
      return send(res, 403, { error: { code: 'team_unauthorized' } });
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === `/v2/teams/${TEAM}`)
      return send(res, 200, { id: TEAM, slug: 'e2e', name: 'E2E Team' });
    if (url.pathname === '/v10/projects') return send(res, 200, { projects: [project] });
    if (parts[2] !== project.id) return send(res, 404, { error: { code: 'not_found' } });
    if (parts.length === 3) return send(res, 200, project);
    if (parts[3] === 'custom-environments') return send(res, 200, { environments: [] });
    if (parts[3] !== 'env') return send(res, 404, { error: { code: 'not_found' } });
    if (req.method === 'GET') return send(res, 200, { envs: env.map(view) });
    if (req.method === 'POST') {
      const b = await body(req);
      clock += 1000;
      const created = {
        id: `env_${++seq}`,
        key: b.key,
        value: b.value,
        type: b.type,
        target: b.target ?? [],
        gitBranch: b.gitBranch ?? null,
        customEnvironmentIds: b.customEnvironmentIds ?? [],
        createdAt: clock,
        updatedAt: clock,
      };
      env.push(created);
      return send(res, 201, { created: view(created), failed: [] });
    }
    const variable = env.find((v) => v.id === parts[4]);
    if (!variable) return send(res, 404, { error: { code: 'not_found' } });
    if (req.method === 'PATCH') {
      const b = await body(req);
      variable.value = b.value ?? variable.value;
      clock += 1000;
      variable.updatedAt = clock;
      return send(res, 200, view(variable));
    }
    if (req.method === 'DELETE') {
      env.splice(env.indexOf(variable), 1);
      return send(res, 200, [view(variable)]);
    }
    send(res, 405, {});
  })();
}).listen(PORT, 'localhost');
