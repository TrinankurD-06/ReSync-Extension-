import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/dist-e2e/**','**/coverage/**', '**/playwright-report/**', '**/test-results/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_|^React$', caughtErrors: 'none' }],
    },
  },
];
