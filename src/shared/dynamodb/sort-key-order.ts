/**
 * Order two DynamoDB string sort keys the way the server orders them.
 *
 * DynamoDB compares a string key by the bytes of its UTF-8 encoding.
 * JavaScript's `<` and `>` compare UTF-16 code units, and the two disagree
 * wherever an astral character meets one in U+E000-U+FFFF: an astral character
 * is a surrogate pair starting at U+D800, so `'A\u{1F600}' < 'A！'` in
 * JavaScript and the reverse on the server. Any listing that merges or bounds
 * rows in memory and then resumes with a key condition has to use this order,
 * or the boundary it draws is not the boundary the next query reads from, and
 * a row is skipped or handed out twice.
 *
 * The comparison is written on the bytes rather than on code points. The two
 * agree — UTF-8 was designed so that byte order is code-point order — but the
 * bytes are what DynamoDB documents itself as comparing, so the code states the
 * server's rule instead of a property that happens to coincide with it.
 *
 * Accepts: `left`, `right` — any two strings; well-formedness is not required,
 * since an unpaired surrogate encodes to the replacement character's bytes and
 * so still compares deterministically.
 *
 * Returns: a negative number when `left` sorts before `right`, a positive one
 * when it sorts after, and `0` when the two encode to the same bytes.
 *
 * Throws: nothing.
 */
export function compareSortKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
