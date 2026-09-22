## What

## Why

## How

## Testing

## Breaking changes

None.

## Checklist

- [ ] `npm run lint`, `npm run typecheck:all` and `npm test` pass at 100 % coverage
- [ ] tests were written first and cover the change (unit; integration or conformance for DynamoDB semantics)
- [ ] CHANGELOG `[Unreleased]` entry for anything a user can observe
- [ ] README updated where documented behaviour changed; `npm run docs` regenerated if public JSDoc changed
- [ ] the change respects the README's [*Versioning and compatibility*](../README.md#versioning-and-compatibility) section
- [ ] a decision that is expensive to reverse has a record in `docs/decisions/`
- [ ] a claim about undocumented AWS behaviour has a `docs/evidence` entry and a live test named after it
- [ ] reformatting, if any, is in its own pull request

## Checks that did not help

<!-- A check that fired on this change without leading you to change anything: name it and say why. Checks that are routinely useless get fixed or removed. -->
