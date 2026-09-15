/** One entry of a TransactWriteItems/TransactionCanceledException's CancellationReasons. */
export interface CancellationReason {
  Code?: string;
}

/**
 * The per-item reasons a `TransactWriteItems` cancellation carries.
 *
 * Accepts: `error` — any error; only a `TransactionCanceledException` carries
 * the field.
 *
 * Returns: one entry per transaction item, in the order the items were sent
 * (https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html),
 * or `undefined` when the error carries none — which is what an older service
 * response or a different failure looks like.
 *
 * Throws: nothing.
 */
export function getCancellationReasons(error: Error): CancellationReason[] | undefined {
  return (error as { CancellationReasons?: CancellationReason[] }).CancellationReasons;
}
