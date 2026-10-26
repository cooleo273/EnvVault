import { hostname } from 'node:os';
import { EnvVaultApiError } from '@envvault/sdk';
import { CLI_ERROR_CODES } from '@envvault/shared';
import { CLI_VERSION, type Context } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { credentialFrom, signedIn } from '../session.js';

/**
 * envvault login: browser approved sign in. The CLI never sees a password
 * or a Neon Auth session; it receives EnvVault session tokens after the
 * person approves the shown code in the web app.
 */
export async function login(ctx: Context, options: { browser: boolean }): Promise<number> {
  const apiUrl = await ctx.apiUrl();
  const api = ctx.client(apiUrl);
  await api.checkCompatibility();
  const device = await api.startCliLogin({
    clientVersion: CLI_VERSION,
    hostname: hostname().slice(0, 255) || 'unknown',
    platform: process.platform,
  });
  const p = ctx.paint;
  ctx.note(`To sign in, open:\n\n  ${p.bold(device.verificationUriComplete)}\n`);
  ctx.note(`and check that it shows this code: ${p.bold(p.cyan(device.userCode))}\n`);
  if (options.browser && ctx.io.interactive) {
    await ctx.openBrowser(device.verificationUriComplete).catch(() => {
      ctx.note('Could not open a browser; open the address above yourself.');
    });
  }
  ctx.note('Waiting for approval…');

  let interval = device.interval * 1000;
  const deadline = Date.now() + device.expiresIn * 1000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new CliError('The sign in request expired.', EXIT.auth, 'Run envvault login again.');
    }
    await ctx.sleep(interval);
    try {
      const token = await api.pollCliLogin(device.deviceCode);
      const webUrl = new URL(device.verificationUri).origin;
      const authed = ctx.client(apiUrl, () => Promise.resolve(token.accessToken));
      const me = await authed.me();
      await ctx.store.write(credentialFrom(token, apiUrl, me.user.email, webUrl));
      if (ctx.json)
        ctx.printJson({ signedIn: true, email: me.user.email, apiUrl, sessionId: token.sessionId });
      else ctx.out(`Signed in as ${me.user.email} (${apiUrl}).`);
      return EXIT.ok;
    } catch (error) {
      if (!(error instanceof EnvVaultApiError)) throw error;
      if (error.code === CLI_ERROR_CODES.AUTHORIZATION_PENDING) continue;
      if (error.code === CLI_ERROR_CODES.SLOW_DOWN) {
        interval += 5000;
        continue;
      }
      if (error.code === CLI_ERROR_CODES.ACCESS_DENIED) {
        throw new CliError('The sign in request was denied in the browser.', EXIT.auth);
      }
      if (error.code === CLI_ERROR_CODES.EXPIRED_TOKEN) {
        throw new CliError('The sign in request expired.', EXIT.auth, 'Run envvault login again.');
      }
      throw error;
    }
  }
}

/** envvault logout: ends the session on the server and forgets it locally, in that order. */
export async function logout(ctx: Context): Promise<number> {
  const apiUrl = await ctx.apiUrl();
  const credential = await ctx.store.read(apiUrl);
  if (!credential) {
    ctx.out(`Not signed in to ${apiUrl}.`);
    return EXIT.ok;
  }
  let ended = true;
  try {
    const session = await signedIn(ctx);
    await session.api.endCliSession();
  } catch (error) {
    const auth = error instanceof CliError && error.exitCode === EXIT.auth;
    if (!auth) ended = false;
  }
  await ctx.store.remove(apiUrl);
  if (ended) {
    ctx.out(`Signed out of ${apiUrl}.`);
    return EXIT.ok;
  }
  ctx.note(
    'Signed out on this computer, but the server could not be reached to end the session. It ends on its own within 30 days; to end it now, use Security settings in the web app.',
  );
  return EXIT.unavailable;
}

export async function whoami(ctx: Context): Promise<number> {
  const session = await signedIn(ctx);
  const me = await session.api.me();
  const info = {
    email: me.user.email,
    name: me.user.displayName,
    apiUrl: session.apiUrl,
    sessionId: session.credential.sessionId,
    sessionExpiresAt: session.credential.refreshExpiresAt,
  };
  if (ctx.json) ctx.printJson(info);
  else ctx.out(`${info.email}${info.name ? ` (${info.name})` : ''} on ${info.apiUrl}`);
  return EXIT.ok;
}

export async function authStatus(ctx: Context): Promise<number> {
  const apiUrl = await ctx.apiUrl();
  const stored = await ctx.store.read(apiUrl);
  if (!stored) {
    if (ctx.json) ctx.printJson({ signedIn: false, apiUrl, credentialStore: ctx.store.kind });
    else ctx.out(`Not signed in to ${apiUrl}. Run envvault login.`);
    return EXIT.auth;
  }
  const session = await signedIn(ctx);
  const current = (await session.api.cliSessions()).find((s) => s.current);
  if (!current)
    throw new CliError('This CLI session is no longer active.', EXIT.auth, 'Run envvault login.');
  const status = {
    signedIn: true,
    apiUrl,
    email: session.credential.email,
    credentialStore: ctx.store.kind,
    accessTokenExpiresAt: session.credential.accessExpiresAt,
    sessionExpiresAt: current.expiresAt,
    hostname: current.hostname,
  };
  if (ctx.json) ctx.printJson(status);
  else {
    ctx.out(`Signed in to ${apiUrl} as ${status.email}`);
    ctx.out(
      `  credentials in: ${status.credentialStore === 'keychain' ? 'operating system credential store' : 'credential file'}`,
    );
    ctx.out(`  session ends:   ${status.sessionExpiresAt} unless used and refreshed`);
  }
  return EXIT.ok;
}
