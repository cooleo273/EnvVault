import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Test only stand in for the Vercel REST API endpoints EnvVault uses, shaped
 * on the documented responses. Holds synthetic values in memory so tests can
 * check what was written. Faults can be injected per test.
 */

export interface MockVariable {
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[];
  gitBranch: string | null;
  customEnvironmentIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface MockProject {
  id: string;
  name: string;
  accountId: string;
  env: MockVariable[];
  customEnvironments: { id: string; slug: string; type: string }[];
}

export class MockVercel {
  readonly tokens = new Map<string, { userId: string; username: string; teams: string[] }>();
  readonly projects = new Map<string, MockProject>();
  /** Every request as `METHOD path?query`, for asserting what EnvVault asked for. */
  readonly requests: string[] = [];
  /** Answer everything with 503. */
  down = false;
  /** Keys whose create or update fails with 400. */
  readonly rejectKeys = new Set<string>();
  /** After this many successful writes, answer writes with 429 (null: never). */
  rateLimitAfterWrites: number | null = null;
  writes = 0;
  /** Delay before answering variable listings (to keep a run busy). */
  listDelayMs = 0;
  private clock = 1_700_000_000_000;
  private seq = 0;
  private server!: Server;
  private port = 0;

  static async start(): Promise<MockVercel> {
    const mock = new MockVercel();
    mock.server = createServer((req, res) => {
      void mock.handle(req, res);
    });
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    mock.port = (mock.server.address() as AddressInfo).port;
    return mock;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  reset(): void {
    this.tokens.clear();
    this.projects.clear();
    this.requests.length = 0;
    this.down = false;
    this.rejectKeys.clear();
    this.rateLimitAfterWrites = null;
    this.writes = 0;
    this.listDelayMs = 0;
  }

  tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  addProject(id: string, name: string, accountId: string): MockProject {
    const project: MockProject = { id, name, accountId, env: [], customEnvironments: [] };
    this.projects.set(id, project);
    return project;
  }

  /** A variable created outside EnvVault (in the dashboard). */
  addVariable(projectId: string, variable: Partial<MockVariable> & { key: string }): MockVariable {
    const now = this.tick();
    const created: MockVariable = {
      id: `env_${String(++this.seq)}`,
      value: 'synthetic-dashboard-value',
      type: 'encrypted',
      target: ['preview'],
      gitBranch: null,
      customEnvironmentIds: [],
      createdAt: now,
      updatedAt: now,
      ...variable,
    };
    this.projects.get(projectId)?.env.push(created);
    return created;
  }

  /** An edit made in the Vercel dashboard after EnvVault wrote the variable. */
  edit(projectId: string, key: string, value: string): void {
    const variable = this.projects.get(projectId)?.env.find((v) => v.key === key);
    if (variable) {
      variable.value = value;
      variable.updatedAt = this.tick();
    }
  }

  variables(projectId: string): MockVariable[] {
    return this.projects.get(projectId)?.env ?? [];
  }

  private json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private error(
    res: ServerResponse,
    status: number,
    code: string,
    headers: Record<string, string> = {},
  ) {
    this.json(res, status, { error: { code, message: code } }, headers);
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  private publicView(v: MockVariable) {
    // Listings without decrypt=true carry no readable value.
    const { value: _value, ...rest } = v;
    return { ...rest, value: '', decrypted: false };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    this.requests.push(`${req.method ?? ''} ${url.pathname}${url.search}`);
    if (this.down) {
      this.error(res, 503, 'service_unavailable');
      return;
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const account = auth ? this.tokens.get(auth) : undefined;
    if (!account) {
      this.error(res, 401, 'forbidden');
      return;
    }
    const teamId = url.searchParams.get('teamId');
    if (teamId && !account.teams.includes(teamId)) {
      this.error(res, 403, 'team_unauthorized');
      return;
    }
    const owner = teamId ?? account.userId;
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/v2/user') {
      this.json(res, 200, { user: { id: account.userId, username: account.username } });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'v2' && parts[1] === 'teams' && parts[2]) {
      if (!account.teams.includes(parts[2])) {
        this.error(res, 403, 'team_unauthorized');
        return;
      }
      this.json(res, 200, {
        id: parts[2],
        slug: `team-${parts[2]}`,
        name: 'Synthetic Team',
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v10/projects') {
      const search = url.searchParams.get('search') ?? '';
      const items = [...this.projects.values()]
        .filter((p) => p.accountId === owner && p.name.includes(search))
        .map((p) => ({ id: p.id, name: p.name, framework: 'nextjs' }));
      this.json(res, 200, {
        projects: items,
        pagination: { count: items.length, next: null, prev: null },
      });
      return;
    }
    const project = parts[2] ? this.projects.get(parts[2]) : undefined;
    if (parts[1] === 'projects' && project?.accountId !== owner) {
      this.error(res, 404, 'not_found');
      return;
    }
    if (!project) {
      this.error(res, 404, 'not_found');
      return;
    }

    if (req.method === 'GET' && parts[0] === 'v9' && parts.length === 3) {
      this.json(res, 200, { id: project.id, name: project.name, framework: 'nextjs' });
      return;
    }
    if (req.method === 'GET' && parts[3] === 'custom-environments') {
      this.json(res, 200, {
        accountLimit: { total: 3 },
        environments: project.customEnvironments,
      });
      return;
    }
    if (parts[3] !== 'env') {
      this.error(res, 404, 'not_found');
      return;
    }

    if (req.method === 'GET') {
      if (this.listDelayMs) await new Promise((resolve) => setTimeout(resolve, this.listDelayMs));
      this.json(res, 200, { envs: project.env.map((v) => this.publicView(v)) });
      return;
    }
    const write = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';
    if (write && this.rateLimitAfterWrites !== null && this.writes >= this.rateLimitAfterWrites) {
      this.error(res, 429, 'rate_limited', { 'retry-after': '42' });
      return;
    }
    if (req.method === 'POST') {
      const body = await this.body(req);
      const key = String(body.key);
      if (this.rejectKeys.has(key)) {
        this.json(res, 201, {
          created: [],
          failed: [{ error: { code: 'invalid_value', message: 'invalid', key } }],
        });
        return;
      }
      const target = (body.target as string[] | undefined) ?? [];
      const branch = (body.gitBranch as string | undefined) ?? null;
      const custom = (body.customEnvironmentIds as string[] | undefined) ?? [];
      const clash = project.env.find(
        (v) =>
          v.key === key &&
          v.gitBranch === branch &&
          (v.target.some((t) => target.includes(t)) ||
            v.customEnvironmentIds.some((c) => custom.includes(c))),
      );
      if (clash) {
        this.error(res, 403, 'env_already_exists');
        return;
      }
      this.writes += 1;
      const created = this.addVariable(project.id, {
        key,
        value: String(body.value),
        type: String(body.type),
        target,
        gitBranch: branch,
        customEnvironmentIds: custom,
      });
      this.json(res, 201, { created: this.publicView(created), failed: [] });
      return;
    }
    const variable = project.env.find((v) => v.id === parts[4]);
    if (!variable) {
      this.error(res, 404, 'not_found');
      return;
    }
    if (req.method === 'PATCH') {
      const body = await this.body(req);
      if (this.rejectKeys.has(variable.key)) {
        this.error(res, 400, 'invalid_value');
        return;
      }
      this.writes += 1;
      if (typeof body.value === 'string') variable.value = body.value;
      if (typeof body.type === 'string') variable.type = body.type;
      variable.updatedAt = this.tick();
      this.json(res, 200, this.publicView(variable));
      return;
    }
    if (req.method === 'DELETE') {
      this.writes += 1;
      project.env = project.env.filter((v) => v.id !== variable.id);
      this.json(res, 200, [this.publicView(variable)]);
      return;
    }
    this.error(res, 405, 'method_not_allowed');
  }
}
