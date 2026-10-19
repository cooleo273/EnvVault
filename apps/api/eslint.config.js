import { nodeConfig } from '@envvault/config/eslint/node';

export default [
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname, ignores: ['eslint.config.js'] }),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Keeps consistent-type-imports from converting DI-injected classes to
        // type-only imports, which would break Nest's reflection metadata.
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
      },
    },
    rules: {
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
];
