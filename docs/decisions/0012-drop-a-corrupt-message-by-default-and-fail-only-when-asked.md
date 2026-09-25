# 12. Drop a corrupt stored message by default, and fail the read only when asked

## Status

Accepted.

## Context

`getMessages` assembles a session's whole conversation from its stored
rows, and a row can fail to decode in ways that range from a genuine loss —
the S3 object it names is gone, or a decompression guard tripped — to a
value the configured serializer simply declines to rebuild. What to do
about one bad row among many is not a question this package can answer
once for every caller: `RunnableWithMessageHistory` re-persists whatever
`getMessages` returns as the conversation's truth, so silently dropping a
turn is invisible at the point it happens, while failing the whole read
blocks every other turn in the session on the one row that cannot be read.

Not every decode failure is this kind of loss, though. A row outside the
session's own message key space, a descriptor pointing outside its scope,
a format newer than the running release reads, and any transport,
throttling or permission failure are all failures about the *read*, not
about that one message's content — dropping one of those would hand back a
conversation that looks shorter than it is for a reason that has nothing
to do with a corrupt message.

## Decision

We give `getMessages` an `onCorruptMessage` policy
(`src/history/types.ts`), defaulting to `'skip'`: a message
`decodeMessage` classifies as this message's own permanent loss
(`src/history/actions/get-messages.ts`) is dropped, logged at `error` with
its sort key so an operator can locate the row, and excluded from the
returned array; the rest of the session is returned. A caller that would
rather the whole read fail passes `onCorruptMessage: 'throw'`, which
rethrows the underlying error instead. The policy governs only what
`decodeMessage` classifies as permanent payload loss; everything else —
a row `parseSessionMessageRow` refuses because it is not this adapter's own
(`src/history/internal/message-read.ts`), a format-version refusal, a
scope violation, or any infrastructure failure — propagates regardless of
the policy, because none of those is the message's own loss the policy
exists to govern.

## Consequences

Positive. The default matches what most chat applications want: one
unreadable turn out of many does not block the rest of a long-running
conversation, while a caller with a stricter tolerance can ask for the read
to fail outright with a single option. Restricting the policy to permanent
payload loss keeps an infrastructure hiccup from ever being silently
dropped, whichever policy is configured.

Negative. `'skip'` is a real loss of conversational state from the
caller's point of view — the message is simply absent from what
`getMessages` returns — visible only through the `error` log line naming
it, which an application that never watches its logs can miss entirely.
`'throw'` is the opposite trade: one bad row makes the whole session
unreadable until it is repaired or removed out of band, rather than only
that one turn.

Neutral. A row outside this adapter's own message key space is reported
and never dropped, whatever the policy says — that failure is a tenancy or
configuration fault, not a message this session's own history has lost,
and folding it into the corruption policy would let it disappear the same
way a genuinely corrupt message does.
