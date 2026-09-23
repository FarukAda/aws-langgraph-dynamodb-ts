# 21. Parse caller input once into types only a parser can build

## Status

Accepted.

## Context

Every public method takes values a typed caller could not get wrong and an
untyped one can: a `RunnableConfig` whose `configurable` is typed
`Record<string, any>` upstream, a session id, a store namespace and key, a
batch of operations, a list of pending writes. They were checked by functions
that returned nothing — fifty-four exported `validate*` and `assert*`
functions — which left a checked value indistinguishable from an unchecked one.

That had three costs, all visible in the code. The same value was checked
again wherever a later function could not tell it had been: a store `put` checked
its namespace and key three times on one call, a search its prefix twice, a
session id was checked by each of five history actions and again by the session
adapter, and `store.ts` re-derived an operation's kind from its shape after the
batch check had already done so. Some checks ran in the middle of processing
instead of before it: a `putWrites` call checked its channel names and its
composed sort-key length inside the encode loop, after earlier writes of the same
call had been serialized and uploaded. And because the checked value kept its
loose type, functions downstream took it loose too: a thread, namespace and
checkpoint travelled as three positional strings through the write path, and
`buildWriteItems` took nine parameters.

The coding guidelines this package follows (rules 83–94) and the reference
repository's record 9 describe the alternative: parse at the boundary into a type
that carries the proof. That needs the one type TypeScript offers for "not yet
known to be anything", `unknown`, which `src` banned outright.

## Decision

We parse every caller input at the public boundary — the first statement of each
action, or the adapter method for inputs no action sees — into a branded type
that only its parser can build. A brand is a phantom intersection such as
`string & { readonly [threadIdBrand]: true }`, declared next to its one
constructor, a `parse*` function, in one of four parser modules:
`src/shared/validation/primitives.ts` and `src/<feature>/internal/parse.ts`.
Functions downstream ask for the brand, or for an interface whose fields are
brands (`ThreadAddress`, `PutWritesRequest`, `ParsedOperation`), so a value that
was never parsed cannot reach them, and they do not check it again. A parser that
returns an array or a window returns a copy it built, so the caller's own object
can no longer change after the check. The order of checks inside each parser is
the order the replaced checks ran in, so the field a refusal names does not move.

We allow `unknown` in exactly one place: as the declared type of a parameter of a
`parse*` function in a parser module. ESLint enforces it with one selector and
`test/static/no-any-unknown.test.ts` with the TypeScript AST; the test also checks
that the two lists of parser modules agree.

We name a function by what it returns: `parse*` returns the checked value as a
more precise type; `assert*` returns nothing and exists only where the checked
value stays under its own declared type — construction options, collaborators, a
row's format version — delegating to the parser that owns the rule.
`test/static/brand-construction.test.ts` fails on a brand declared outside a
parser module, on a cast to a brand outside the `parse*` function that owns it,
and on a brand with no constructor or with two; `test/static/check-names.test.ts`
fails on any function named `validate*`.

## Consequences

Positive. A duplicate check is now a compile error rather than a latent cost:
there is nothing to re-check against, because the downstream parameter is the
brand. A reader can tell from a signature whether a value has been checked. Every
refusal of caller input happens before the first request, upload or encode, so a
malformed call leaves nothing half-done. The write path takes an address instead
of a loose triple, and the store dispatches on a parsed `kind` instead of asking an
operation's shape a second time.

Negative. Brands are unfamiliar and appear in internal signatures, which is a tax
on every reader. The cast that applies a brand is a place where a mistake would be
silent; the static guard confines it to one function per brand, but it cannot
check that the function's checks are the right ones. The guard also matches a
cast by its literal syntax — `as B` or `<B>` naming the brand — so a generic
helper that casts to a type parameter (`function forge<T>(v: unknown): T { return
v as T; }`, called as `forge<ThreadId>(v)`) would build a brand without the guard
ever seeing `ThreadId` written at the cast site; nothing in this package is
written that way, and keeping it that way is a matter for review, not something
this guard can check. Tests of internal functions must build their inputs
through the parsers, which makes a fixture a parser would refuse fail where it is
written — and makes such fixtures longer. `unknown` is back in `src`, in a narrow
and gated form.

Neutral. Not every value is branded. Functions that read rows back — the
checkpoint read path, the key builders — take plain strings, because they are fed
from a parsed address and from a row's own identifiers alike, and a row is data
the table returned, admitted by the row narrowers rather than by a parser. Public
types do not change: every brand is internal, and a brand is a subtype of the
string or array a public signature names.
