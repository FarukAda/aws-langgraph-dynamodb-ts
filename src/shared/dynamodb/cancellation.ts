/** One entry of a TransactWriteItems/TransactionCanceledException's CancellationReasons. */
export interface CancellationReason {
  Code?: string;
}

/** Extract `CancellationReasons` from a transaction-cancellation error, if present. */
export function getCancellationReasons(error: Error): CancellationReason[] | undefined {
  return (error as { CancellationReasons?: CancellationReason[] }).CancellationReasons;
}
