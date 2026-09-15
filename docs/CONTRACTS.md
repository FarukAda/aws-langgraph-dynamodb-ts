# Contract standard

The rule every function in `src/` must satisfy before this package is released
as 1.0.0. It exists because the 1.0.0-rc.1 defects were not test failures: they
were functions that accepted inputs for which no answer had ever been decided,
described by comments that asserted facts nobody had checked.

A reviewer who has never seen this codebase must be able to verify compliance
without trusting the author's judgement. Every rule below is therefore
mechanically checkable.

## 1. Closed domain

A function is **closed** when, for every combination of accepted inputs, the
answer is either stated in its contract or made unrepresentable by its types.

Procedure, per function:

1. For each parameter, list its **distinguishable states** — the values the body
   can tell apart. `Record<string, T>` has three: `undefined` (if accepted),
   empty, non-empty. `readonly T[]` likewise. A union has one per member. Two
   states are distinct if any branch, `??`, `||`, `.length` or key count treats
   them differently.
2. Form the cross product. That is the domain.
3. Every cell gets a decided answer, or the parameter type is changed so the
   cell cannot exist.

**Prefer unrepresentable over documented.** If two states of one parameter mean
different things to the caller, they must not share a type. `readonly string[] |
undefined`, where `[]` means "parent stored nothing" and `undefined` means "no
parent", is a defect even when both cells are documented: the call site can pass
the wrong one and nothing catches it. Replace it with a discriminated union.

**Accepting more than the interface requires is allowed and costs you a cell.**
Where this package widens an upstream signature (an optional parameter that
upstream declares required), the widened state is part of the domain and needs a
decided answer like any other.

## 2. The contract block

Every exported function carries a JSDoc block with these sections, in this
order. Sections that do not apply are omitted, never left empty.

- **Summary** — one sentence: what the function returns or does, in terms of its
  inputs.
- **Accepts** — per parameter: the accepted states and what each one means.
  Every state from §1 appears here or is unrepresentable.
- **Returns** — the output domain, including which inputs produce which shape.
- **Throws** — every error type this function raises, with the condition.
  "Nothing" is a valid and useful answer; write it.
- **Guarantees** — invariants a caller may rely on after the call. A guarantee
  that exists to satisfy an external contract carries the citation that
  establishes it (§3).

Nothing else goes in the block.

### Forbidden in every comment in `src/`

The package is a product, not a notebook. Delete on sight:

- Rationale for a choice: "so a read never walks ancestors", "this is cheaper
  than", "we prefer X because".
- Comparisons with alternatives not taken.
- Narrative about trade-offs, history, or what a previous version did.
- Any claim about behaviour outside this function that carries no citation.
- Anything addressed to a maintainer rather than a caller.

The single exception: a **consequence the caller acts on** — cost, ordering,
durability, concurrency — belongs in the contract of the **public API**, because
there the caller is the end user. Internal helpers carry contract only.

The test for any sentence: *can a caller make a different decision because of
it?* If not, it is a note, and notes do not ship.

## 3. Citations

Any statement about behaviour that is not visible in the function being
documented requires a citation. This includes every claim about a dependency, a
reference implementation, an AWS service, or another module in this package.

A valid citation is one of:

- `package@version` plus `path:line` — `@langchain/langgraph-checkpoint@1.1.5
  dist/base.d.ts:68`.
- A versioned URL to official documentation (AWS API reference, RFC).
- `path:line` within this repository.

Not valid: "the reference savers", "as documented upstream", "AWS recommends",
recollection, inference from naming.

**A claim that cannot be cited is either removed, or verified and then cited.**
Verification means reading the cited source, not remembering it. The citation is
what makes the claim checkable by someone who does not share the author's
assumptions, which is the entire point.

Version-pinned citations are re-checked when the pinned dependency's range
changes.

## 4. Tests derived from the contract

- One test per domain cell from §1, named after the cell.
- Each expectation traces to a clause of the contract. A test whose expected
  value corresponds to no sentence in the contract is invalid, regardless of
  whether it passes.
- Tests are written from the contract text, not from reading the
  implementation.
- Where the contract asserts agreement with a reference implementation, the test
  **executes both** and compares. A cited claim about another implementation is
  never tested by restating it.

Coverage is not evidence of anything here and is not cited as such.

## 5. Done, per function

A function is done when all of the following hold, each verifiable by a third
party:

1. Every distinguishable input state appears in **Accepts** or is
   unrepresentable.
2. Every cell of the domain has a decided answer.
3. Every external claim carries a valid citation (§3).
4. No forbidden comment remains in the function or its file.
5. One test per cell exists, each traceable to a contract clause.
6. Where the contract references another implementation, a differential test
   executes both.

---

# Worked example: `selectStoredChannels`

`src/checkpointer/internal/stored-channels.ts`. Chosen because it is six lines
long, has 100% line and branch coverage, and silently loses user state.

## Facts established before writing anything

| # | Fact | Citation |
|---|---|---|
| F-1 | `put(config, checkpoint, metadata, newVersions: ChannelVersions)` — `newVersions` is required upstream, and the method carries no JSDoc. The meaning of `newVersions` is undocumented and must be derived from call sites. | `@langchain/langgraph-checkpoint@1.1.5` `dist/base.d.ts:68` |
| F-2 | `ChannelVersions = Record<string, ChannelVersion>` — `{}` is a valid value. | `@langchain/langgraph-checkpoint@1.1.5` `dist/base.d.ts:8` |
| F-3 | `MemorySaver.put(config, checkpoint, metadata)` takes three parameters and stores the whole checkpoint. The reference saver does not narrow at all. | `@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:206-227` |
| F-4 | LangGraph passes `{}` as `newVersions` when forking a checkpoint (`updateState(..., "__copy__")`) and when writing an empty-checkpoint update. `{}` means "no channel version changed", not "store nothing". | `@langchain/langgraph@1.4.13` `dist/pregel/index.js:668` and `:613` |
| F-5 | `BaseCheckpointSaver.getDeltaChannelHistory` walks the parent chain and terminates per channel at the nearest ancestor whose `channel_values[ch]` is populated; a walk that reaches the root yields no seed and the consumer treats that as "start empty". | `@langchain/langgraph-checkpoint@1.1.5` `dist/base.d.ts:78-95` |
| F-6 | This package did not override `getDeltaChannelHistory` when this example was written, so F-5 described its own read path. It does now — see the note at the end of this example. | `src/checkpointer/saver.ts` (`getDeltaChannelHistory`) |

F-5 and F-6 together yield the invariant this function exists to protect: **a
channel value that no row on the parent chain stores is unreachable.** Narrowing
is only safe against a known ancestor.

## Domain, as it stands

Distinguishable states: `newVersions` in {`undefined`, `{}`, non-empty};
`parentStored` in {`undefined`, `[]`, non-empty}. Nine cells. `checkpoint` is
read for `channel_values` only and is the set being filtered, not a state.

| `newVersions` \ `parentStored` | `undefined` | `[]` | non-empty |
|---|---|---|---|
| `undefined` | all present | all present | all present |
| `{}` | **undecided** -> `[]` | **undecided** -> `[]` | **undecided** -> parent's list |
| non-empty | all present | **undecided** -> `newVersions` only | `present` and (`newVersions` or parent) |

Four cells were never decided. The implementation answers them anyway, because
`{}` is not nullish and `[]` is not nullish. Two of those answers lose data: the
`{}` row is F1 in the review, and the non-empty/`[]` cell drops a root
checkpoint's unchanged values, which by F-5 makes them unreachable.

The existing test `test/unit/checkpointer/internal/stored-channels.test.ts:44`
asserts the `{}`/`[]` cell equals `[]`. Under §4 that test is invalid: its
expectation corresponds to no decided clause. It is the mechanism by which the
defect passed review.

## Closure

`parentStored` carries two meanings in one type, so it becomes unrepresentable
(§1):

```ts
export type ParentChannels =
  | { readonly kind: 'noParent' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'stored'; readonly channels: readonly string[] };
```

`'unknown'` is the parent row that is gone or predates the `storedChannels`
attribute; `'noParent'` is a checkpoint with no parent id. Both mean no ancestor
is known to hold anything, which by F-5 forbids narrowing. The decided domain
collapses to one sentence: **narrow only against a known ancestor list, and only
when at least one channel changed.**

```ts
export function selectStoredChannels(
  checkpoint: Checkpoint,
  newVersions: ChannelVersions | undefined,
  parent: ParentChannels,
): string[] {
  const present = Object.keys(checkpoint.channel_values);
  if (newVersions === undefined || Object.keys(newVersions).length === 0) return present;
  if (parent.kind !== 'stored') return present;
  const keep = new Set([...Object.keys(newVersions), ...parent.channels]);
  return present.filter((channel) => keep.has(channel));
}
```

Six cells return `present`; three narrow. Nine of nine decided.

## Contract

```ts
/**
 * The keys of `checkpoint.channel_values` this put writes to storage.
 *
 * Accepts:
 * - `checkpoint` — read for `channel_values` only; may be empty.
 * - `newVersions` — the channel versions that changed this step, as passed to
 *   `BaseCheckpointSaver.put` (`@langchain/langgraph-checkpoint@1.1.5`
 *   `dist/base.d.ts:68`, where the parameter is required and undocumented).
 *   `undefined` — the caller omitted the argument, which this package accepts
 *   and the interface does not. `{}` — no channel version changed; passed by
 *   `@langchain/langgraph@1.4.13` `dist/pregel/index.js:668` when forking a
 *   checkpoint and `:613` for an empty-checkpoint update. Non-empty — the named
 *   channels changed.
 * - `parent` — `'stored'` carries the channel list the parent row is known to
 *   hold; `'noParent'` and `'unknown'` mean no ancestor is known to hold
 *   anything.
 *
 * Returns: keys of `checkpoint.channel_values` in insertion order. Narrowed to
 * those named by `newVersions` or held by `parent.channels` when `newVersions`
 * is non-empty and `parent.kind` is `'stored'`; every other input returns every
 * key.
 *
 * Throws: nothing.
 *
 * Guarantees: every key of `checkpoint.channel_values` is returned here or is
 * held by a row on this checkpoint's parent chain. Required because this
 * package did not, when this example was written, override
 * `BaseCheckpointSaver.getDeltaChannelHistory`
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/base.d.ts:78-95`), whose walk
 * terminates per channel at the nearest ancestor with a populated
 * `channel_values[ch]` and treats reaching the root as "start empty".
 */
```

Deleted from the current file: the claim that the reference savers store only
changed channels and rebuild the rest on read (contradicted by F-3), and the
rationale clause "so a read never walks ancestors" (§2 — the caller of an
internal helper acts on no decision from it).

## Tests

Nine cells, nine tests, each named for its cell and asserting the clause it
comes from:

| Test | Clause |
|---|---|
| `undefined` against each of the three parent kinds (3) | "every other input returns every key" |
| `{}` against each of the three parent kinds (3) | same clause; `{}` is listed in **Accepts** as "no channel version changed" |
| non-empty against `noParent` and `unknown` (2) | same clause |
| non-empty against `stored` (1) | the narrowing clause |

Plus, per §4, because the contract cites F-4 and F-5 — claims about another
implementation — one differential test that executes both: fork a real graph
through `graph.updateState(config, values, "__copy__")` against `MemorySaver`
and against this saver, and compare the resulting state. Restating F-4 in an
assertion does not satisfy this.

## What became of this example

Both outcomes it argued for were carried out, and the example is kept as the record of the
method rather than as a description of the code:

- `selectStoredChannels` and the whole carry-forward mechanism were **deleted**, not repaired.
  Closing the domain showed the narrowing was never safe against an unknown ancestor, and that
  the only always-correct answer — store every channel value the checkpoint carries — needs no
  function at all.
- F-6 no longer holds. `DynamoDBSaver` overrides `getDeltaChannelHistory`
  (`src/checkpointer/internal/delta-history.ts`) so that an ancestor which exists but has
  expired raises `ANCESTOR_EXPIRED` instead of silently yielding a channel rebuilt from its
  initial value. A fact established for one function stops being true when another changes,
  which is the reason §3 requires a citation that can be re-checked rather than a recollection.

## Scope

219 exported functions in `src/`. Every one passes §5 before 1.0.0.
