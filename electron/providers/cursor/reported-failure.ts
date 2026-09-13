/**
 * The errors `cursor-agent acp` writes into the transcript instead of
 * failing the turn.
 *
 * Read from cursor-agent 2026.09.10: its ACP prompt handler runs the agent
 * loop with retries disabled (the TUI, `-p` and the SDK enable them), catches
 * whatever the loop throws, and — unless it is a cancellation or an
 * action-required error — sends `"\n\nError: " + String(error)` as one last
 * `agent_message_chunk` and answers `end_turn`. `String(error)` is
 * `<kind>: <message>` where the kind is one of its own error classes and the
 * message is a Connect error, `[<code>] <detail>`. Verified against three
 * sessions that ended with
 * `Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)`.
 *
 * The match is anchored to the end of the turn's final text so an agent
 * quoting one of these lines mid-answer is not mistaken for a failure.
 */
const REPORTED_ERROR =
  /(?:^|\n)Error: ((?:RetriableError|NonRetriableError|ActionRequiredError|CancelledError): [^\n]*|\[unauthenticated\] [^\n]*)\s*$/

/** The error text, or `undefined` when the turn's final text is an ordinary answer. */
export function cursorReportedFailure(finalText: string): string | undefined {
  const match = REPORTED_ERROR.exec(finalText)
  return match?.[1]?.trim() || undefined
}
