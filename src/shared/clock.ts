/** Current time as an ISO-8601 string, derived from the (test-freezable) clock. */
export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}
