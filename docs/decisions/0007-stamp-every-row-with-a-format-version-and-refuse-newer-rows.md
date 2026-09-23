# 7. Stamp every row with a format version and refuse newer rows

## Status

Accepted.

## Context

A table can be read by more than one release of this package at once — a
rolling deployment, a reader kept a version behind a writer on purpose — and
a minor release is free to add attributes a row did not carry before. A
reader built before that attribute existed has no way to know the row it is
looking at means something it does not recognise, unless the row says so
itself.

Before a row carried its own version, "written by an older release" was
inferred from a missing attribute — `rev`, `occurrence`, `writeGroup`,
`storedChannels` in turn. That inference does not generalise to the
opposite direction, a row written by a *newer* release, and it is not even
reliably expressible: a lookup cannot tell an attribute that is absent from
one that is present and `undefined`, which silently reversed
first-write-wins for pending writes across an upgrade. Guessing at an
unrecognised shape is also the wrong failure mode for this problem: reading
a newer row under today's rules is how a checkpoint comes back with state
quietly missing, which is worse than refusing to read it at all.

## Decision

We stamp every row this package writes with its format version, `v`
(`src/shared/dynamodb/table-schema.ts`), and every read that returns a row's
content checks that version *before* it checks the row's shape. A row
without `v` reads as version 0, under the rules that applied when it was
written, so nothing already on a table needs migrating. A row whose `v`
exceeds what the running release understands throws `FORMAT_UNSUPPORTED`
(`src/shared/errors/error-code.ts`) naming the field, rather than being
matched against attribute names a later format may have renamed or
repurposed. `narrowMetaItem` in `src/checkpointer/internal/rows.ts`
and `fetchPayload` / `fetchPendingWrites` in
`src/checkpointer/internal/fetch.ts` all apply this check first, ahead of
narrowing the row to a typed item, for exactly that reason: a foreign or
newer row is reported as newer, not silently treated as absent or invalid.
A payload descriptor carries the same rule under its own `schemaVersion`.

## Consequences

Positive. A rolling deployment, or a reader deliberately held back a
version, fails loudly and specifically on a row it cannot fully understand
instead of returning a shorter thread or a checkpoint with attributes
quietly dropped. The version check costs nothing extra to store — one
small integer per row — and nothing already written needs a migration,
since an absent `v` has a defined meaning.

Negative. Every code path that reads a row's content must remember to call
the check before it does anything else with the row; the ordering is a
convention `test/static` cannot fully enforce, so a new read path that
narrows first and checks second would reintroduce the exact bug this
decision closes. Raising `v` in a minor is constrained to changes an older
`1.x` reader can still safely ignore, which pushes some shape changes to a
major release that could otherwise have shipped sooner.

Neutral. `v` names only the row's own format, not which release wrote it;
two releases that never change the row shape write the same `v` and are
interchangeable to a reader. The check is deliberately blind to *why* a
version is unsupported — a genuinely newer format and a hand-edited row
with a bogus `v` are refused identically, because this package cannot tell
the two apart and should not try.
