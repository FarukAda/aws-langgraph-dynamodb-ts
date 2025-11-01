import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import noInstanceof from 'eslint-plugin-no-instanceof';
import unusedImports from 'eslint-plugin-unused-imports';

export default defineConfig([
  js.configs.recommended,
  ...ts.configs.recommended,
  prettierConfig,
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['dist'],
    plugins: {
      prettier: prettier as any,
      import: importPlugin as any,
      'no-instanceof': noInstanceof as any,
      'unused-imports': unusedImports as any,
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
          vars: 'all',
          ignoreRestSiblings: false,
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
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      // No instanceof plugin
      'no-instanceof/no-instanceof': 'error',
    },
  },
]);
