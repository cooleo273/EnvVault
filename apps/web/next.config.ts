import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { parsePublicEnv } from './src/env';
import { loadWebEnvFromRootFile } from './src/root-env';
import { buildSecurityHeaders } from './src/security-headers';

// Monorepo convenience: the web app reads its own keys from the root .env.
loadWebEnvFromRootFile(resolve(process.cwd(), '../../.env'));

// Fails the dev server / build early when configuration is invalid.
const env = parsePublicEnv(process.env);

const nextConfig: NextConfig = {
  // Separate build dir lets the e2e dev server run next to a developer's own `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  // Phase 0 auth URLs. Query strings (e.g. reset tokens) are preserved.
  redirects() {
    return Promise.resolve([
      // Account settings index (an HTTP redirect, before any streaming).
      { source: '/settings', destination: '/settings/profile', permanent: false },
      ...[
        ['/auth/sign-in', '/login'],
        ['/auth/sign-up', '/signup'],
        ['/auth/forgot-password', '/forgot-password'],
        ['/auth/reset-password', '/reset-password'],
        ['/auth/verify-email', '/verify-email'],
      ].map(([source, destination]) => ({
        source: source ?? '',
        destination: destination ?? '',
        permanent: true,
      })),
    ]);
  },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: buildSecurityHeaders({
          apiOrigin: env.NEXT_PUBLIC_API_URL,
          isDevelopment: process.env.NODE_ENV === 'development',
        }),
      },
    ]);
  },
};

export default nextConfig;
