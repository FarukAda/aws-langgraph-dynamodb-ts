# 22. Give each row format, denormalised copy and write protocol one owning module

## Status

Accepted.

## Context

Three adapters share one DynamoDB table (record 2), so a row's key, the
attributes it carries and the way it is written are decisions that outlast any
one method. The source had grown along the order in which an operation runs
rather than along those decisions. A checkpointer key was composed in seven
modules, and the key attribute names `PK` and `SK` were written as string
literals in twenty; a session's `messageCount`, which copies how many message
rows the session holds, was read or written in seven modules; the store's
vector backend, which copies every item's embedding, was called from five; a
pending write's commit was spread over twelve step-shaped modules; and one
module held forty-five constants that answered unrelated questions. Record 17
removed the file-length and complexity caps that had pushed modules apart, and
the coding guidelines this package follows ask for one module per decision
(rules 1 to 10) and for a mutable denormalised copy to sit behind one module
that alone keeps it in step (rule 91).

## Decision

We give every decision that is expensive to change one module, and let no
other module make it. The conventions every row follows — the key attributes,
the separator, the adapter tags, the format version, expiry and the server's
key order — live in `src/shared/dynamodb/table-schema.ts`. Each feature's key
layout and the mapping between its rows and its values live in its own
`src/<feature>/internal/rows.ts`. The SESSION row, and with it
`messageCount`, belong to `src/history/internal/session.ts`. The vector copy
belongs to `src/store/internal/vector-index.ts`. How a write whose outcome
matters is guarded, tokened and read back belongs to
`src/shared/dynamodb/idempotent-write.ts`, and each adapter's own write
protocol to one module of that adapter. Constants live with the module that
enforces or applies them.

`test/static/owners.test.ts` fails when a key is composed, or a key attribute
named, outside the four row-schema owners; when `messageCount` is touched
outside the SESSION row's owner; and when a vector backend is called outside
the vector copy's owner. The owners are listed in
`test/static/guards/owners.ts`, and an entry that names a module owning
nothing fails too, so the list cannot drift into an exemption.

We made the change by moving code, not rewriting it: the public API, every
error and log message and every request the package sends are unchanged.

## Consequences

Positive. A change to a key layout, to how the message count is kept or to
when the vector copy is written is a change to one module, and the guard says
so to anyone who tries it elsewhere. The source went from 167 modules to 86,
each opening with the decision it hides, which is where a reader starts.

Negative. Modules are larger; the checkpointer's row module is several hundred
lines, and review, not a cap, has to keep it coherent. The guard is lexical: a
key built from a computed property name, or a backend held under a name that
does not end in `backend`, would pass it. Some functions stay exported only
because their unit tests call them, so a module's test-facing surface is wider
than the interface other modules use.

Neutral. The three features keep their own query builders, because their
expression placeholders differ and the surface harness selects rows by them;
only the attribute names are shared.
