import { nextConfig } from '@envvault/config/eslint/next';

export default nextConfig({
  tsconfigRootDir: import.meta.dirname,
  ignores: ['eslint.config.js', 'postcss.config.mjs'],
});
