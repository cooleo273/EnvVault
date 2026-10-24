import { configuration } from '../../../lib/envvault';

// Runs on the server for every request; never statically rendered with values.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const config = await configuration();
  // Counts only: a response body is visible to whoever calls the route.
  return Response.json({ status: 'ok', configured: Object.keys(config).length });
}
