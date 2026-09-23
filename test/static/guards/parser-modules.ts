/**
 * The modules that turn a caller's input into a checked type, relative to
 * `src/`. `unknown` is the honest type of a value no check has seen yet, so a
 * `parse*` function in one of these may declare a parameter `unknown`; nowhere
 * else in `src` may anything be declared `unknown`. `eslint.config.ts` lists
 * the same files, and `test/static/no-any-unknown.test.ts` checks the two lists
 * agree, so the lint rule and this guard cannot drift apart.
 */
export const PARSER_MODULES: readonly string[] = [
  'shared/validation/primitives.ts',
  'checkpointer/internal/parse.ts',
  'history/internal/parse.ts',
];
