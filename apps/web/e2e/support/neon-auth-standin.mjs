// Local stand-in for a Neon Auth branch, used ONLY by the end-to-end tests.
//
// Neon Auth is managed Better Auth. This runs the same Better Auth version the
// Neon SDK pins (1.7.6), configured to match Neon's documented contract:
//   - cookies prefixed `__Secure-neon-auth.` (as expected by @neondatabase/auth)
//   - JWT plugin: EdDSA/Ed25519, iss = aud = Auth URL origin, 15 minute tokens,
//     JWKS at <base>/.well-known/jwks.json
//   - email/password with required email verification via email OTP
//   - password reset links
// Emails are captured in memory and exposed at GET /__test/mailbox for tests.
// Never deploy this: it is an unauthenticated, in-memory test fixture.

import { createServer } from 'node:http';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { toNodeHandler } from 'better-auth/node';
import { emailOTP, jwt } from 'better-auth/plugins';

const PORT = Number(process.env.STANDIN_PORT ?? 4410);
const ORIGIN = `http://localhost:${PORT}`;
const BASE_PATH = '/neondb/auth';
const TRUSTED = (process.env.STANDIN_TRUSTED_ORIGINS ?? 'http://localhost:3100').split(',');

/** @type {{ to: string; kind: string; otp?: string; url?: string; at: number }[]} */
const mailbox = [];

const db = { user: [], session: [], account: [], verification: [], jwks: [] };

const auth = betterAuth({
  baseURL: ORIGIN,
  basePath: BASE_PATH,
  secret: process.env.STANDIN_SECRET ?? 'e2e-standin-secret-not-for-production-use',
  database: memoryAdapter(db),
  trustedOrigins: TRUSTED,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      mailbox.push({ to: user.email, kind: 'reset-password', url, at: Date.now() });
    },
  },
  emailVerification: { autoSignInAfterVerification: true },
  advanced: { cookiePrefix: 'neon-auth', useSecureCookies: true },
  plugins: [
    emailOTP({
      overrideDefaultEmailVerification: true,
      sendVerificationOnSignUp: true,
      async sendVerificationOTP({ email, otp, type }) {
        mailbox.push({ to: email, kind: type, otp, at: Date.now() });
      },
    }),
    jwt({
      jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' }, jwksPath: '/.well-known/jwks.json' },
      jwt: { issuer: ORIGIN, audience: ORIGIN, expirationTime: '15m' },
    }),
  ],
});

const handler = toNodeHandler(auth);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  if (url.pathname === '/__test/mailbox') {
    const to = url.searchParams.get('to');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(mailbox.filter((m) => !to || m.to === to)));
    return;
  }
  if (url.pathname === '/__test/sessions') {
    // Number of live sessions per email (lets tests assert sign-out/step-up cleanup).
    const email = url.searchParams.get('email');
    const user = db.user.find((u) => u.email === email);
    const live = user ? db.session.filter((x) => x.userId === user.id).length : 0;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessions: live }));
    return;
  }
  if (url.pathname === '/__test/health') {
    res.end('ok');
    return;
  }
  void handler(req, res);
}).listen(PORT, 'localhost', () => {
  process.stdout.write(`Neon Auth stand-in listening on ${ORIGIN}${BASE_PATH}\n`);
});
