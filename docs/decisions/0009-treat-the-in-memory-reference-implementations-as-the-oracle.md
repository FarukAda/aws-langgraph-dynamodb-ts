# 9. Treat the in-memory reference implementations as the oracle

## Status

Accepted.

## Context

`BaseCheckpointSaver` and `BaseStore` describe a contract in prose and
types, but a contract in prose leaves edge cases unsettled: what a listing
does with a namespace prefix that matches no items, what a search does with
a filter naming a field no stored value has, what a falsy checkpoint id
means. `@langchain/langgraph-checkpoint`'s `MemorySaver` and
`@langchain/core`'s `InMemoryStore` are executable answers to exactly those
questions, and LangGraph applications are written and tested against them
before a persistent backend ever enters the picture. A backend that answers
one of these questions differently, without saying so, changes what an
application sees when it swaps `MemorySaver` for this package.

The in-memory implementations are not infallible, though, and DynamoDB is
not a JavaScript object graph: a key composed from a structural separator
cannot contain that separator, and a namespace's insertion order has no
DynamoDB analogue to preserve. Treating "matches the reference" as an
absolute rule would force this package to reproduce bugs the reference
itself carries, or to fabricate an ordering with no basis in how the table
actually stores rows.

## Decision

We specify this package's observable behaviour as what `MemorySaver` and
`InMemoryStore` do, and list every place it diverges as a numbered `V-`row
in the README's *Differences from the reference implementations* table,
each naming why the difference is kept. Anything not in that table is
treated as a defect against the reference, not a choice, and the
differential and conformance tests
(`test/conformance/checkpointer.conformance.test.ts`,
`test/conformance/validation.conformance.test.ts`,
`test/conformance/graph.conformance.test.ts`) are what enforce it — the
checkpointer conformance tier also runs LangChain's own published
`@langchain/langgraph-checkpoint-validation` suite against this package,
with the one channel-delta test it exempts every non-delta saver from
skipped by name, for the reason `putCheckpoint`'s own doc comment states.
Recording a new divergence is a **minor** release at most, and only when
the reference itself is the defect or this backend's storage and key rules
require the difference; changing a divergence a caller may already depend
on is a **major**, as the README's *Versioning and compatibility* section
states.

## Consequences

Positive. A behaviour question with no obvious right answer has a concrete
one to consult, and a caller migrating from the reference saver or store
has a single table to check for every place this package's answer differs,
each with its reason attached. A regression against the reference is
something the differential tests catch mechanically rather than something
a reviewer has to notice by inspection.

Negative. The reference's own defects that this package must diverge from
to be correct — a falsy id read as absent, a filter compared with `===`
against an object — still have to be individually discovered, argued and
recorded rather than inherited automatically, and the table has grown past
thirty rows as a result. A change to the reference implementation upstream
is a change to this package's own specification, which this package does
not control the timing of.

Neutral. The oracle is the reference *implementation's* behaviour, not
`BaseCheckpointSaver`'s or `BaseStore`'s prose contract; where the two
disagree, the executable one wins, because that is the one an application
was actually written against.
