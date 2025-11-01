import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import noInstanceof from 'eslint-plugin-no-instanceof';

export default defineConfig({
  files: ['**/*.{ts,tsx}'],
  extends: [js.configs.recommended, ts.configs.recommended, prettierConfig],
  ignores: ['dist'],
  plugins: {
    prettier: prettier as any,
    import: importPlugin as any,
    'no-instanceof': noInstanceof as any,
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        args: 'none',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'no-console': 'error',

    // Prettier integration
    'prettier/prettier': 'error',

    // Import plugin rules
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', ['parent', 'sibling']],
        'newlines-between': 'always',
      },
    ],
    'import/no-duplicates': 'error',

    // No instanceof plugin
    'no-instanceof/no-instanceof': 'error',
  },
});
