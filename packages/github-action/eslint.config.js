import { nodeConfig } from '@envvault/config/eslint/node';

export default nodeConfig({
  tsconfigRootDir: import.meta.dirname,
  ignores: ['eslint.config.js', 'build.mjs', 'dist/**'],
});
