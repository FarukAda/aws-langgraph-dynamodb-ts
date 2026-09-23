# 20. Make the layer direction a build gate

## Status

Accepted.

## Context

The package is arranged in layers — shared mechanics, each feature's
declarations, its internals, its operations, the adapter classes, the factory,
the entry point — and three features that do not know about each other. That
arrangement is what keeps a change local, and nothing enforced it. Eight
imports ran the wrong way: the shared option-key lists named each feature's
option types, a feature's declarations reached into its internals for one
type, and a search helper called the store's `get` operation. Most were
`import type`, which erases at run time and so produced no cycle, no failing
test and nothing for a reviewer to notice.

## Decision

We record the permitted direction in `test/static/guards/layers.ts`, which
places every module of `src/` in a layer and every feature module in a
feature. `test/static/layer-direction.test.ts` fails on an import that reaches
a later layer, on one feature importing another, on a module the table does
not place, and on a relative import it cannot resolve. Type-only imports and
re-exports count. An upward import we accept is listed with the reason it
exists and what removing it would cost, and one that no longer matches a real
import fails, so the list can only shrink. It is empty: the eight imports were
fixed by moving each list, type and function to the layer and feature that
owns it.

## Consequences

Positive. The decomposition is checked on every change, when the author can
still act on it, and a new module cannot escape the rule by being unlisted.

Negative. The rule lives in a test, so a violation surfaces at test time rather
than while typing. `shared/` is one layer, and the mutual dependencies inside
it are not checked by this gate.

Neutral. The layers were already there; this writes them down, as the
reference repository's record 10 does for its own.
