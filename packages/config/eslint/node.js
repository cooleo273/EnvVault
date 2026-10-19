// ESLint flat config for Node.js packages and services.
import globals from 'globals';
import { baseConfig } from './base.js';

/**
 * @param {{ tsconfigRootDir: string, ignores?: string[] }} options
 */
export function nodeConfig(options) {
  return [
    ...baseConfig(options),
    {
      languageOptions: {
        globals: { ...globals.node },
      },
    },
    {
      files: ['**/*.spec.ts', '**/*.test.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ];
}
