import { expect, test as setup } from '@playwright/test';

/**
 * next dev compiles a route, and the server actions it uses, on first
 * request. On a busy machine that can take longer than an assertion waits,
 * and a sign up whose redirect target is still compiling looks like a hang.
 * Requesting the routes of the shared flows first moves that one time cost
 * out of the assertions; every later assertion keeps its normal timeout.
 */
const FIRST_ROUTES = ['/signup', '/verify-email', '/login', '/onboarding', '/dashboard'];

setup('compile the routes the flows start with', async ({ request }) => {
  setup.setTimeout(240_000);
  for (const path of FIRST_ROUTES) {
    const response = await request.get(path, { maxRedirects: 0, timeout: 120_000 });
    // Anonymous requests to protected routes redirect; anything below 500 means it compiled.
    expect(response.status(), path).toBeLessThan(500);
  }
});
