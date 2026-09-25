/**
 * Hides how much of an unchecked string a line may quote.
 *
 * A log line or public error message that quotes a string this package did
 * not length-check passes it through here. The caps for an identifier, for a
 * relayed cause's prose and for a list of labels, and the mark that states a
 * cut value's real length, are chosen here, so a call site says what kind of
 * value it quotes and never how many characters it keeps.
 */

/**
 * Characters of an unchecked string one log line or one public error message
 * carries, past which it is cut and marked with its real length.
 *
 * Most of what these lines quote is a row's sort key or an offloaded object's
 * S3 key, so the service already caps each at 1024 bytes — the cost is not one
 * long line but many. `list: skipped a row that is not a checkpoint meta item`
 * and `left a foreign row in place` fire once per row, and those passes walk a
 * whole partition, up to `MAX_TOTAL_ROWS_IN_MEMORY`
 * (`src/shared/dynamodb/paginate.ts`) rows: one call on a shared table could
 * write megabytes of log. A consumer's `VectorBackend` carries no such service
 * cap at all.
 *
 * 256 is `MAX_KEY_SEGMENT_BYTES` (`src/shared/dynamodb/table-schema.ts`), this
 * package's own budget for one identifier inside a key, so any key composed
 * from identifiers it validated is quoted whole in the common case and only a
 * foreign row, a hand-written one or a backend's own answer — exactly the
 * cases these lines report — is cut. Nothing is lost by cutting: the line's
 * job is to say which row to go and look at, and the row holds the rest.
 */
export const MAX_LOGGED_VALUE_CHARS = 256;

/**
 * Labels of an unchecked `string[]` one log line or one public error message
 * carries, past which the rest are dropped and the real depth is stated.
 *
 * An array is two unbounded things — how many labels there are and how long
 * each one is — so a bound on the labels alone is not a bound: a backend
 * answering with one label of a megabyte and one answering with a million
 * labels of a character cost the same line. {@link MAX_LOGGED_VALUE_CHARS}
 * covers the first, this covers the second.
 *
 * 8 is a budget rather than a rule about namespaces: a store namespace is a
 * path, what identifies which path is its leading labels, and every namespace
 * this package's own documentation forms is two or three deep. The marker
 * states the depth it really had, so a deeper one is cut without being
 * misreported.
 *
 * A `namespace` and `key` pair that passed `parseStoreAddress` needs none of
 * this and goes in whole: that check measures the sort key they *compose*, so
 * it bounds how many labels there are as well as how long each one is. A
 * search or listing **prefix** passes no such check — nothing composes it into
 * a key — so its depth is unchecked however carefully each label was checked,
 * and a backend's own answer is unchecked in both.
 */
export const MAX_LOGGED_LABELS = 8;

/**
 * Characters of a relayed *cause's* text one public error message or one log
 * line carries, past which it is cut and marked with its real length.
 *
 * Its own cap rather than {@link MAX_LOGGED_VALUE_CHARS} because the two bound
 * different things. That one bounds an **identifier** — a sort key, an S3
 * object key, a namespace label — and 256 is this package's own budget for one
 * identifier inside a key, so a value past it is already abnormal and the line
 * only has to say which row to go and look at. This one bounds **prose**: the
 * sentence an AWS SDK error, a consumer's `VectorBackend` or a caller's own
 * `serde` wrote to explain a failure, which `redactedMessage` relays into
 * `err.message`. Cutting that at an identifier's budget would throw away the
 * half of a diagnostic that says what to do about it, and a diagnostic is the
 * entire value of relaying it at all.
 *
 * 1024 is measured against the longest text this package actually relays: an
 * IAM `AccessDenied`, which names the calling principal's ARN, the action and
 * the resource ARN and then says why no policy allows it, runs to the mid
 * hundreds of characters, and a role ARN with a long path and a session name
 * pushes it further. 1024 clears that whole, so the case an operator most
 * needs to read arrives intact.
 *
 * What it is *for* is the other direction. `redactedMessage` also relays a
 * **caller's own** thrown error — a `serde` refusing a value, a `vectorBackend`
 * rejecting a query — whose length the caller controls entirely, and those
 * messages are quoted once per row on paths that walk a whole prefix or table.
 * Unbounded, one such error fills a log; at 1024 a thousand of them are a
 * megabyte rather than an unbounded amount.
 *
 * Its own literal at the same value as `MAX_SORT_KEY_BYTES`
 * (`src/shared/dynamodb/table-schema.ts`) and `MAX_S3_KEY_BYTES`
 * (`src/shared/codec/s3/config.ts`) rather than an alias of either, for the
 * reason `LIST_SCAN_WARN_THRESHOLD` (`src/shared/dynamodb/paginate.ts`)
 * records: aliasing two caps would move one whenever the other is retuned,
 * and these three answer unrelated questions.
 */
export const MAX_RELAYED_MESSAGE_CHARS = 1024;

/** True for the high half of a surrogate pair, whose low half follows it. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * The cut itself, shared by both caps so one value can never be marked twice
 * with two different lengths.
 *
 * `max` is a character count. A value at or under it comes back identical; a
 * longer one comes back as `max` characters — one fewer when that would split
 * a surrogate pair — followed by `…(len N)` giving the length it really had.
 */
function cutTo(value: string, max: number): string {
  if (typeof value !== 'string' || value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  const kept = isHighSurrogate(last) ? max - 1 : max;
  return `${value.slice(0, kept)}…(len ${value.length})`;
}

/**
 * Bound a string this package did not length-check.
 *
 * **The rule, in one sentence:** a string goes through here before a log line
 * or a public error message quotes it, unless this package composed it from
 * identifiers it length-checked. Where the string came from does not decide
 * it — a row, a bucket's own configuration, a consumer's `VectorBackend` and
 * an object the caller handed in are the same thing here, which is that
 * nothing bounded them. A caller's `sessionId`, `threadId`, `namespace` and
 * `key`, and every key built from them, are capped by
 * `MAX_PARTITION_ID_BYTES`, `MAX_KEY_SEGMENT_BYTES` and `MAX_SORT_KEY_BYTES`
 * before a request is made, so those go in as they are; a row's own `SK`, an
 * offloaded object's key, a descriptor's `location`, a backend's `namespace`
 * and `key`, a lifecycle rule's scope and a stored message's `type` are
 * bounded by nothing this package ran.
 *
 * **It says "or a public error message" for one reason:** one value must not
 * get two answers. An `s3Key` off a row was cut for the `warn` that reports
 * refusing to delete the object and quoted whole by the error that refuses to
 * read it — one package, one value, two answers. An error's text is not the
 * compatibility surface (the README tells callers to branch on `code`, `name`
 * and the structured fields, never on text) and the `context` those errors
 * carry keeps the value whole, so what reads an error as data loses nothing
 * by this.
 *
 * Accepts: `value` — the string as whatever produced it carried it. Declared
 * `string` because a table's own key attributes always are, and because the
 * interfaces a consumer implements say so; anything else is returned
 * untouched rather than coerced or refused, since a report of a value that is
 * already wrong is the last place to raise a `TypeError` of its own.
 *
 * Returns: the value unchanged at or under {@link MAX_LOGGED_VALUE_CHARS}
 * characters, otherwise that many characters followed by `…(len N)` giving the
 * length it really had. The mark is what keeps a cut value honest: without it
 * a truncated key reads as a key that simply ends there.
 *
 * Throws: nothing.
 *
 * Guarantees: a cut never falls between the halves of a surrogate pair, so a
 * well-formed value stays well-formed. A lone surrogate is what
 * `assertWellFormed` exists to keep out of this package's strings, and a JSON
 * log transport rewrites one to U+FFFD without saying so.
 */
export function truncateForLog(value: string): string {
  return cutTo(value, MAX_LOGGED_VALUE_CHARS);
}

/**
 * Bound the **prose** of a relayed cause, which takes its own cap.
 *
 * {@link truncateForLog} bounds an identifier, where 256 characters is this
 * package's own budget for one and anything past it is already abnormal. The
 * text an AWS SDK error, a consumer's `VectorBackend` or a caller's own
 * `serde` wrote is a sentence rather than a name: cut at an identifier's
 * budget it loses the half that says what to do, which is the only reason to
 * relay it. {@link MAX_RELAYED_MESSAGE_CHARS} records what the larger number
 * is measured against, and why the two differ.
 *
 * It has exactly one caller — `redactedMessage`, the funnel every `catch` in
 * this package goes through — so no call site can get the cap wrong and no
 * future one has to remember it. That also means a site must not cut the
 * result again: a second cut marks the length of the first cut's output rather
 * than of the original, which is the one thing the mark exists to prevent.
 *
 * Accepts: `value` — the redacted text. Redaction runs first, so a credential
 * shape can never be half-cut past the pattern that would have caught it.
 *
 * Returns: the value unchanged at or under the cap, otherwise that many
 * characters followed by `…(len N)`.
 *
 * Throws: nothing.
 */
export function truncateRelayedText(value: string): string {
  return cutTo(value, MAX_RELAYED_MESSAGE_CHARS);
}

/**
 * Bound a list of labels — a store `namespace`, a list of channel names — the
 * same rule reaches.
 *
 * An array is two unbounded things, how many labels it holds and how long each
 * one is, so a bound on one of them is not a bound. {@link truncateForLog}
 * covers the labels; the count is covered here.
 *
 * A `namespace` and `key` pair that passed `parseStoreAddress` is already
 * bounded in both — that check measures the sort key they compose — and goes
 * in whole. A search or listing prefix is not: nothing composes it into a key,
 * so however carefully each label was checked, how many there are was not.
 *
 * The labels stay a list rather than being joined into one string, for two
 * reasons. A structured transport already carries the field as a list and the
 * README's Logging table documents it as one, so joining would change the
 * shape of a line rather than only its size. And a label nothing validated may
 * hold the `#` a join would put between labels, so a joined line cannot say
 * whether the backend answered with one label or with two — which is the very
 * thing these lines report.
 *
 * Accepts: `labels` — as the row, the backend or the caller gave it. Declared
 * `string[]` because that is what the interfaces say; anything else is
 * returned untouched, for the reason {@link truncateForLog} gives, and that
 * case is reached rather than defensive — a `namespace` that is not an array
 * is one of the things `parseStoreAddress` refuses, and the line reporting the
 * refusal quotes what was refused.
 *
 * Returns: at most {@link MAX_LOGGED_LABELS} labels, each bounded by
 * {@link truncateForLog}, with one further label reading `…(len N)` when some
 * were dropped, giving the depth the list really had. A list within both
 * bounds comes back as an equal list.
 *
 * Throws: nothing.
 */
export function truncateLabelsForLog(labels: string[]): string[] {
  if (!Array.isArray(labels)) return labels;
  const kept = labels.slice(0, MAX_LOGGED_LABELS).map((label) => truncateForLog(label));
  return labels.length > MAX_LOGGED_LABELS ? [...kept, `…(len ${labels.length})`] : kept;
}
