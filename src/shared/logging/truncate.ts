import { MAX_LOGGED_LABELS, MAX_LOGGED_VALUE_CHARS, MAX_RELAYED_MESSAGE_CHARS } from '../constants';

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
 * A `namespace` and `key` pair that passed `validateStoreKey` is already
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
 * is one of the things `validateStoreKey` refuses, and the line reporting the
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
