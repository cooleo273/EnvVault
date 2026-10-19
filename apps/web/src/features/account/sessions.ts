import 'server-only';
import { getAuth } from '@/lib/auth/server';

/** A Neon Auth session as shown in the UI. Never includes the session token. */
export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  /** False when Neon Auth did not return what is needed to end this session alone. */
  revocable: boolean;
}

interface RawSession {
  id?: unknown;
  token?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  userAgent?: unknown;
  ipAddress?: unknown;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** Server-side only: the raw list includes session tokens. */
export async function listRawSessions(): Promise<
  { id: string; token: string | null; raw: RawSession }[]
> {
  const { data, error } = await getAuth().listSessions();
  if (error || !Array.isArray(data)) return [];
  return (data as RawSession[])
    .filter((s): s is RawSession & { id: string } => typeof s.id === 'string')
    .map((s) => ({ id: s.id, token: typeof s.token === 'string' ? s.token : null, raw: s }));
}

/** Active sessions of the signed-in user, current session first. */
export async function listSessions(): Promise<SessionSummary[] | null> {
  const [{ data: current }, sessions] = await Promise.all([
    getAuth().getSession(),
    listRawSessions(),
  ]);
  if (!current?.session) return null;
  return sessions
    .map(({ id, token, raw }) => ({
      id,
      current: id === current.session.id,
      createdAt: iso(raw.createdAt),
      expiresAt: iso(raw.expiresAt),
      userAgent: typeof raw.userAgent === 'string' && raw.userAgent ? raw.userAgent : null,
      ipAddress: typeof raw.ipAddress === 'string' && raw.ipAddress ? raw.ipAddress : null,
      revocable: token !== null,
    }))
    .sort(
      (a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt),
    );
}
