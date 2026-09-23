import js from '@eslint/js';
import type { ESLint, Linter } from 'eslint';
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

/**
 * `typescript-eslint` types its exported configs against a minimal
 * `{ name?, rules? }` shape so the package stays compatible across ESLint
 * majors, which drops `languageOptions` from the type even though the object
 * carries one at runtime. Read through ESLint's own {@link Linter.Config}
 * instead of widening to `any`, which `no-explicit-any` bans here too.
 */
const disableTypeChecked = ts.configs.disableTypeChecked as Linter.Config;

const NO_UNKNOWN = {
  selector: 'TSUnknownKeyword',
  message:
    'The `unknown` type is banned in src. Model the shape explicitly (see CONTRIBUTING.md, "The rules the guards enforce").',
};
const NO_EXPORT_ALL = {
  selector: 'ExportAllDeclaration',
  message:
    'Barrel re-exports are banned except in src/index.ts, so the public surface is declared in one place (see CONTRIBUTING.md).',
};
const NO_REEXPORT = {
  selector: 'ExportNamedDeclaration[source]',
  message:
    'Re-exports are banned except in src/index.ts, so the public surface is declared in one place (see CONTRIBUTING.md).',
};

export default defineConfig([
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  prettierConfig,
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['dist'],
    plugins,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: typeof __dirname === 'undefined' ? process.cwd() : __dirname,
      },
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
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],
      'no-instanceof/no-instanceof': 'error',
      /**
       * Off until their hits are fixed. The first scan with
       * `recommendedTypeChecked` on reported 872 hits across all of its rules.
       * Rule 53 requires a clean tree before a blocking check goes on, so the
       * four correctness rules that check `await` discipline
       * (`no-floating-promises`, `no-misused-promises`, `await-thenable`,
       * `require-await`) and every other type-checked rule with 20 or fewer
       * hits were fixed and stay on. The four below each had more than 20; a
       * scan with only them turned on, after those fixes, reports
       * `no-unsafe-argument` 117 hits, `no-unsafe-assignment` 71,
       * `no-unsafe-member-access` 70 and `no-unsafe-return` 44.
       */
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    ...disableTypeChecked,
    languageOptions: {
      ...disableTypeChecked.languageOptions,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
    rules: { ...js.configs.recommended.rules, ...disableTypeChecked.rules },
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
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': ['error', NO_EXPORT_ALL, NO_REEXPORT],
      /**
       * Every hit here is `expect(mock.fn)` or `expect(Class.prototype.method)`
       * (Jest reads the reference, never calls it against a `this`) or a plain
       * function copied onto a fake `serde`/logger object (nothing in this
       * codebase's methods reads `this`). Both are idiomatic test code, not the
       * unbound-`this` bug the rule exists to catch.
       */
      '@typescript-eslint/unbound-method': 'off',
      /**
       * Every hit here is a test deliberately proving this library normalises
       * a rejection whatever its value — `throw 'boom'`, `throw null`, a
       * getter that throws a string — because a caller's own `serde`,
       * `embeddings` or resource can throw anything a `throw` statement
       * accepts. That is the behaviour under test, not a bug.
       */
      '@typescript-eslint/only-throw-error': 'off',
      /**
       * Same reasoning as `only-throw-error` above: every hit here is a
       * `Promise.reject(...)` deliberately given a non-Error value — a plain
       * object, `null`, `undefined` — to prove this library's own rejection
       * handling does not assume the rejection is an `Error`.
       */
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },
  {
    /**
     * `tsconfig.json` excludes this fixture on purpose (its `package.json`
     * pins an older `@aws-sdk/lib-dynamodb` so a real type-check runs only
     * inside the isolated tarball install `test:consumer-types` sets up).
     * The project service can never find a tsconfig for it, so type-aware
     * rules are off here; the fixture still gets every non-type-aware rule
     * from the `**\/*.{ts,tsx}` block above.
     */
    files: ['test/package-smoke/consumer-types/**/*.ts'],
    ...disableTypeChecked,
  },
]);
