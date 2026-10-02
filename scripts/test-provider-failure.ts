import assert from "node:assert/strict"
import {
  PROVIDER_FAILURE_KINDS,
  classifyProviderFailure,
  classifyStartFailure,
  describeProviderFailure,
} from "../electron/contracts/provider-failure.js"
import { heldReason } from "../electron/contracts/session-hold.js"
import { reconnectRefusal } from "../electron/live-transfers.js"

/** Real provider text seen in host logs, and the verdict each must get. */
const cases: [string, string][] = [
  [
    'Failed to run prompt: {"type":"invalid_request_error","message":"reasoning encrypted_content was not issued to this caller"}',
    "transcript-rejected",
  ],
  ["Item 'rs_0a1b' of type 'reasoning' was provided without its required following item.", "transcript-rejected"],
  ["messages.3: tool_use ids were found without tool_result blocks immediately after", "transcript-rejected"],
  ["previous_response_id not found", "transcript-rejected"],
  ["prompt is too long: 214031 tokens > 200000 maximum", "context-exhausted"],
  ["This model's maximum context length is 128000 tokens", "context-exhausted"],
  ["401 Unauthorized: invalid api key", "auth"],
  ["auth_required", "auth"],
  ["Failed to authenticate: OAuth session expired and could not be refreshed", "auth"],
  ["Not logged in. Run `cursor-agent login`.", "auth"],
  ["Your plan does not include this model", "auth"],
  ["429 Too Many Requests", "rate-limited"],
  ["overloaded_error: Overloaded", "rate-limited"],
  ["You have hit your usage limit. Try again in 3 hours.", "rate-limited"],
  ["502 Bad Gateway", "provider-unavailable"],
  ["API Error: 500 Internal server error", "provider-unavailable"],
  ["fetch failed", "network"],
  ["read ECONNRESET", "network"],
  ["socket hang up", "network"],
  // cursor-agent's own error text, lifted out of its transcript.
  ["RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)", "network"],
  ["RetriableError: [deadline_exceeded] the operation timed out", "network"],
  ["RetriableError: Connection stalled", "network"],
  ["RetriableError: [unavailable] Error", "provider-unavailable"],
  ["[unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment", "auth"],
  ["Codex app-server sent an oversized JSON-RPC message", "transport-limit"],
  ["Session not found", "resume-failed"],
  ["The saved native session cannot be resumed. The session store is missing or unreadable. No replacement session was started.", "resume-failed"],
  [heldReason("Mako (dev)"), "resume-failed"],
  ["Invalid params: Unknown model config option: effort", "rejected-input"],
  ["Prompt cannot be empty", "rejected-input"],
  ["The folder /Users/me/gone no longer exists. Open this in a folder that exists.", "missing-folder"],
  // The startup watch's words; a cause in the stderr line it appends wins.
  ["Claude exited with code 1 during SDK initialization", "launch-failed"],
  ["Claude exited with code 1 during SDK initialization: Error: Invalid MCP configuration:", "launch-failed"],
  ["Grok exited on SIGKILL before session/new", "launch-failed"],
  ["Claude Code executable not found at /opt/claude/cli.js. Is options.pathToClaudeCodeExecutable set?", "launch-failed"],
  ["spawn /usr/local/bin/devin ENOENT", "launch-failed"],
  ["Claude Code process exited with code 1: Error: Settings file is invalid", "launch-failed"],
  ["Claude exited with code 1 during SDK initialization: Invalid API key · Please run /login", "auth"],
  ["Claude exited with code 1 during SDK initialization: No conversation found with session ID: 1f2e", "resume-failed"],
  ["Claude produced no output for 20 s during SDK initialization (process still running)", "launch-stalled"],
  ["Grok did not finish session/new within 120 s (its last stderr output was 31 s ago)", "launch-stalled"],
  ["Something entirely new went wrong", "unknown"],
  ["", "unknown"],
]

for (const [text, kind] of cases)
  assert.equal(classifyProviderFailure(text).kind, kind, `"${text.slice(0, 60)}" → ${kind}`)

// A specific fault wins over the broad HTTP family it could also trip: a
// rejected transcript arrives as a 400 invalid_request_error.
assert.equal(
  classifyProviderFailure("400 invalid_request_error: reasoning encrypted_content was not issued to this caller").kind,
  "transcript-rejected"
)
// A context overflow that mentions "request too large" is still context, not capacity.
assert.equal(classifyProviderFailure("413 request too large: too many tokens").kind, "context-exhausted")

// Only the transient kinds offer Send again.
const retriable = new Set(PROVIDER_FAILURE_KINDS.filter((kind) => describeProviderFailure(kind).retriable))
assert.deepEqual([...retriable].sort(), ["launch-stalled", "network", "provider-unavailable", "rate-limited", "unknown"])
for (const kind of PROVIDER_FAILURE_KINDS) {
  const described = describeProviderFailure(kind, "OpenCode")
  assert.equal(described.kind, kind)
  assert.ok(described.title.length > 0 && described.guidance.length > 0, kind)
  assert.ok(!/The provider/.test(described.title), `${kind} names the provider it was given`)
}
assert.match(describeProviderFailure("transcript-rejected", "OpenCode").guidance, /new OpenCode thread/)

// A start that failed for no classifiable reason while reopening is Mako's
// failure to resume; a recognisable cause keeps its own kind either way.
assert.equal(classifyStartFailure("weird driver text", true), "resume-failed")
assert.equal(classifyStartFailure("weird driver text", false), "unknown")
assert.equal(classifyStartFailure("401 Unauthorized", true), "auth")
assert.equal(classifyStartFailure(reconnectRefusal({ kind: "held", by: "Mako (dev)" }), true), "resume-failed")
assert.equal(classifyStartFailure(reconnectRefusal(undefined), true), "resume-failed")

console.log(`Provider failure classification: ${cases.length} texts, priority, retriability and start failures passed`)

assert.equal(classifyStartFailure("Codex app-server sent an oversized JSON-RPC message", true), "transport-limit")
assert.doesNotMatch(describeProviderFailure("resume-failed").guidance, /process.*open/)
