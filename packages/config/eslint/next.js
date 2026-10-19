// ESLint flat config for the Next.js frontend.
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { baseConfig } from './base.js';

/**
 * @param {{ tsconfigRootDir: string, ignores?: string[] }} options
 */
export function nextConfig(options) {
  return [
    ...baseConfig({ ...options, ignores: ['next-env.d.ts', ...(options.ignores ?? [])] }),
    {
      languageOptions: {
        globals: { ...globals.browser, ...globals.node },
      },
    },
    {
      plugins: {
        '@next/next': nextPlugin,
        'react-hooks': reactHooks,
      },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
        ...reactHooks.configs.recommended.rules,
      },
    },
  ];
}
