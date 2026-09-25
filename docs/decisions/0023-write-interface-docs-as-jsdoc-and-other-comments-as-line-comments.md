# 23. Write interface documentation as JSDoc and every other comment as a line comment

## Status

Accepted.

## Context

`src` allowed one comment form, `/** */`, and a static guard refused `//`.
JSDoc is interface documentation: TypeScript attaches it to the declaration
under it, an editor shows it on hover, and typedoc publishes it to
`docs/api`. A comment that explains the line under it inside a function is
not interface documentation, and the one-form rule made the two look alike:
51 blocks in `src` sat above a statement, inside an empty `catch` or on a
union member, and documented no declaration at all. The coding guidelines
this package follows keep interface documentation distinct from comments
(rule 30) and implementation detail out of it (rule 31). The repository the
guidelines were written against documents declarations with JSDoc and writes
an explanation inside a body with `//`.

## Decision

A `/** */` block is interface documentation. It is the module's header — the
first thing in the file — or it sits directly above a declaration: a
function, class, interface, type, enum, variable, member or parameter. Any
other comment is a `//` line of its own; ESLint's `no-inline-comments` keeps
comments off lines of code. A declaration outside a function body is never
documented with `//`, so everything typedoc and an editor show is JSDoc. A
plain `/* */` block, and a directive comment — `eslint-disable`,
`eslint-enable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` — are refused
anywhere in `src`.

`test/static/comment-kinds.test.ts` enforces all four rules and replaces the
JSDoc-only guard. It finds every comment by walking the tokens of the parsed
tree rather than re-lexing the raw text: a plain re-scan has to guess whether
a backtick opens a template literal or resumes one after a `${}`
substitution, and a wrong guess swallows everything up to the next backtick —
including whatever comments sit between — into one bogus token. `src`'s error
messages are built from such templates throughout, so a raw re-scan lost
sight of comments in over a third of the modules; reading each token's
leading and trailing trivia off the already-parsed tree instead keeps every
comment in view, wherever on the line it sits. The 51 blocks that documented
nothing became `//` lines with their text unchanged. Tests already used both
forms and are not checked.

## Consequences

Positive. A reader tells at a glance whether a comment belongs to an
interface or explains the code under it, and what typedoc publishes is
exactly the documentation of declarations.

Negative. Two forms instead of one. The guard's notion of a declaration is
syntactic: a `/** */` above an expression statement that happens to assign a
function is refused and has to become `//`.

Neutral. The directive ban used to follow from the JSDoc-only rule; it is now
stated on its own, with the same effect.
