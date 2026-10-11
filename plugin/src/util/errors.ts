// One way to turn anything thrown into text for logs, notices and status details.

/** An Error's message; anything else thrown, as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
