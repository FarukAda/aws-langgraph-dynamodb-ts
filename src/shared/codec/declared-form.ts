/**
 * The one `serdeType` whose grammar this package can check for itself: the type
 * `JSON_SERDE` stamps on everything it writes, and the one LangGraph's own
 * `JsonPlusSerializer` stamps on every value but a raw `Uint8Array`.
 */
const JSON_SERDE_TYPE = 'json';

/**
 * Whether stored bytes are still the form the row that holds them declares.
 *
 * This is the structural question behind the two ways a decode fails —
 * `PAYLOAD_CORRUPT` for bytes no reader can decode, and the `serde` refusal for
 * bytes *this* reader will not rebuild a value from — and it is the only one
 * this package can answer on its own. `SerializerProtocol` offers no way to ask
 * a serde whether it parsed the bytes before deciding not to reconstruct what
 * they name, and the refusal it throws is a caller's object: its class, its
 * fields and its prose are all whatever that caller chose. Classifying a
 * payload by any of those would make the code mean "a third party said so",
 * which is exactly what neither code may mean.
 *
 * Accepts: `serdeType` — the type stamped on the row, as the descriptor carries
 * it. `bytes` — what the row stored, already decompressed.
 *
 * Returns: whether the bytes still parse as the declared form. A type this
 * package has no grammar for is taken at its word and answers `true`, so its
 * serde's refusal is reported rather than written off: dropping a payload this
 * reader merely cannot check would lose data on nothing but its own ignorance.
 *
 * Throws: **nothing**, for any bytes. It is called from inside the `catch` that
 * is classifying a decode failure, where a throw would replace the failure
 * being reported — and the value it is handed came off a row, so it may be
 * anything that row's writer stored.
 */
export function bytesHoldDeclaredForm(serdeType: string, bytes: Uint8Array): boolean {
  if (serdeType !== JSON_SERDE_TYPE) return true;
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}
