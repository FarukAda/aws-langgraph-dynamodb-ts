import js from '@eslint/js';
import type { ESLint } from 'eslint';
import prettierConfig from 'eslint-config-prettier';
import noInstanceof from 'eslint-plugin-no-instanceof';
import perfectionist from 'eslint-plugin-perfectionist';
import prettier from 'eslint-plugin-prettier';
import unusedImports from 'eslint-plugin-unused-imports';
import { defineConfig } from 'eslint/config';
import ts from 'typescript-eslint';

/**
 * Third-party plugins typed through ESLint's own {@link ESLint.Plugin} contract.
 * Annotating the map keeps the config free of `any` so it passes the same
 * `no-explicit-any` rule it enforces on the rest of the repo.
 */
const plugins: Record<string, ESLint.Plugin> = {
  'no-instanceof': noInstanceof,
  perfectionist,
  prettier,
  'unused-imports': unusedImports,
};

const NO_UNKNOWN = {
  selector: 'TSUnknownKeyword',
  message: 'The `unknown` type is banned (CLAUDE.md Types rule). Model the shape explicitly.',
};
const NO_EXPORT_ALL = {
  selector: 'ExportAllDeclaration',
  message: 'Barrel re-exports are banned except in src/index.ts (CLAUDE.md Exports rule).',
};
const NO_REEXPORT = {
  selector: 'ExportNamedDeclaration[source]',
  message: 'Re-exports are banned except in src/index.ts (CLAUDE.md Exports rule).',
};

export default defineConfig([
  js.configs.recommended,
  ...ts.configs.recommended,
  prettierConfig,
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['dist'],
    plugins,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
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
      'no-inline-comments': 'error',
      'max-lines': ['error', { max: 150, skipBlankLines: false, skipComments: false }],
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'no-restricted-syntax': ['error', NO_UNKNOWN, NO_EXPORT_ALL, NO_REEXPORT],
      'prettier/prettier': 'error',
      'perfectionist/sort-imports': [
        'error',
        {
          type: 'natural',
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling'], 'index'],
          newlinesBetween: 1,
        },
      ],
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],
      'no-instanceof/no-instanceof': 'error',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
    rules: { ...js.configs.recommended.rules },
  },
  {
    files: ['src/index.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_UNKNOWN],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: false, skipComments: false }],
      '@typescript-eslint/no-explicit-any': 'off',
      complexity: 'off',
      'max-depth': 'off',
      'no-restricted-syntax': ['error', NO_EXPORT_ALL, NO_REEXPORT],
    },
  },
]);
