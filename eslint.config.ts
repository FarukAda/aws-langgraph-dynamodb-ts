import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
// @ts-expect-error perfectionist ships without bundled types
import perfectionist from 'eslint-plugin-perfectionist';
import noInstanceof from 'eslint-plugin-no-instanceof';
import unusedImports from 'eslint-plugin-unused-imports';

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
    plugins: {
      prettier: prettier as any,
      perfectionist: perfectionist as any,
      'no-instanceof': noInstanceof as any,
      'unused-imports': unusedImports as any,
    },
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
