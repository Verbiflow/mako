import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { SDKMessage, SDKResultSuccess, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createClaudeSdkDriver, type ClaudeSdkDependencies } from "@mako/host/harnesses/claude/sdk-driver"
import { claudeFailureEvidence } from "@mako/host/harnesses/claude/failure-evidence"
import type { ClaudeCredentialState } from "@mako/host/harnesses/claude/accounts"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { ProviderFailureEvidence } from "@mako/host/contracts/provider-failure-evidence"
import { ProviderFailureError } from "@mako/host/contracts/provider-failure"
import { admitted } from "../fixtures/admitted-start.ts"

const HTML = 'Failed to authenticate. API Error: 403 <!doctype html><html><head><title>Temporary access check</title></head><body>Please wait.</body></html>'
const REVOKED = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid token"}}'
const REFRESH_FAILED = "Failed to authenticate: OAuth session expired and could not be refreshed"

class Messages implements AsyncIterable<SDKMessage> {
  private readonly items: SDKMessage[] = []
  private wake?: () => void
  private ended = false
  send(message: SDKMessage): void { this.items.push(message); this.wake?.() }
  close(): void { this.ended = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (!this.ended) {
      const message = this.items.shift()
      if (message) yield message
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) { assert.ok(Date.now() < deadline, what); await delay(5) }
}

/** Native SDK frames plus injected credential metadata: no token values, real sign-in, native process or model. */
export async function claudeRecoveryControls(dependencies: ClaudeSdkDependencies, root: string): Promise<void> {
  const now = Date.now()
  const valid: ClaudeCredentialState = { store: "file", scoped: true, access: true, refresh: "present", expiresAt: new Date(now + 60 * 60_000).toISOString(), refreshExpiresAt: new Date(now + 24 * 60 * 60_000).toISOString() }
  const expired: ClaudeCredentialState = { ...valid, expiresAt: new Date(now - 1_000).toISOString() }
  const cases: { name: string; error: string; nativeOrg?: boolean; state?: ClaudeCredentialState; expected: ProviderFailureEvidence }[] = [
    { name: "valid-permission", error: 'Failed to authenticate. API Error: 403 {"error":{"type":"permission_error","message":"Model access refused"}}', state: valid, expected: { kind: "permission", source: "provider-permission-error" } },
    { name: "valid-native-organisation", error: "Failed to authenticate", nativeOrg: true, state: valid, expected: { kind: "permission", source: "provider-permission-error" } },
    { name: "valid-forbidden-code", error: 'API Error: 403 {"error":{"code":"forbidden"}}', state: valid, expected: { kind: "permission", source: "provider-permission-error" } },
    { name: "valid-scope", error: "Failed to authenticate: insufficient scope", state: valid, expected: { kind: "permission", source: "provider-permission-error" } },
    { name: "valid-unknown-json", error: 'Failed to authenticate. API Error: 403 {"error":{"type":"unclassified_error"}}', state: valid, expected: { kind: "unknown", source: "provider-error" } },
    { name: "valid-html", error: HTML, state: valid, expected: { kind: "provider-unavailable", source: "credential-current" } },
    { name: "gateway-permission-words", error: 'API Error: 403 <html><title>Access check</title><body>Insufficient scope</body></html>', state: valid, expected: { kind: "provider-unavailable", source: "credential-current" } },
    { name: "closed-during-read", error: HTML, state: valid, expected: { kind: "provider-unavailable", source: "credential-current" } },
    { name: "valid-plain", error: "Failed to authenticate. API Error: 403 Temporary access check", state: valid, expected: { kind: "provider-unavailable", source: "credential-current" } },
    { name: "valid-revoked", error: REVOKED, state: valid, expected: { kind: "auth", source: "provider-auth-error" } },
    { name: "valid-revoked-code-only", error: 'API Error: 400 {"error":"invalid_token"}', state: valid, expected: { kind: "auth", source: "provider-auth-error" } },
    { name: "valid-revoked-json-message", error: 'Failed to authenticate. API Error: 401 {"error":{"type":"invalid_request_error","message":"OAuth access token has been revoked"}}', state: valid, expected: { kind: "auth", source: "provider-auth-error" } },
    { name: "valid-long-json", error: `Failed to authenticate. API Error: 401 ${JSON.stringify({ error: { type: "authentication_error", message: "Invalid token "+"detail ".repeat(500) } })}`, state: valid, expected: { kind: "auth", source: "provider-auth-error" } },
    { name: "missing", error: HTML, state: { store: "none", scoped: true }, expected: { kind: "auth", source: "credential-missing" } },
    { name: "missing-json", error: 'Failed to authenticate. API Error: 403 {"error":{"type":"unknown"}}', state: { store: "none", scoped: true }, expected: { kind: "auth", source: "credential-missing" } },
    { name: "expired-refresh-failed", error: REFRESH_FAILED, state: expired, expected: { kind: "auth", source: "refresh-failed" } },
    { name: "expired-refresh-possible", error: "Failed to authenticate", state: expired, expected: { kind: "provider-unavailable", source: "unconfirmed-auth" } },
    { name: "unreadable-html", error: HTML, state: { store: "unreadable", scoped: true }, expected: { kind: "provider-unavailable", source: "gateway-response" } },
    { name: "read-failed-html", error: HTML, expected: { kind: "provider-unavailable", source: "gateway-response" } },
  ]
  assert.deepEqual(claudeFailureEvidence('API Error: 401 {"error":"invalid_token"}', valid), { kind: "auth", source: "provider-auth-error" })
  for (const test of cases) {
    const events: LiveDriverEvent[] = []
    const messages = new Messages()
    const scope = join(root, test.name)
    let input: AsyncIterator<SDKUserMessage> | undefined
    let inspected = 0
    let completeRead: (() => void) | undefined
    const driver = createClaudeSdkDriver({ ...dependencies,
      configure: async () => ({ options: { env: { CLAUDE_CONFIG_DIR: scope } }, account: { name: "fixture" } }),
      configDir: () => scope,
      inspectCredentials: async env => {
        inspected++
        assert.equal(env.CLAUDE_CONFIG_DIR, scope)
        if (test.name === "closed-during-read") await new Promise<void>(resolve => { completeRead = resolve })
        if (!test.state) throw new Error("fixture store unavailable")
        return test.state
      },
      query: async options => { input = options.prompt[Symbol.asyncIterator](); return { ...(await dependencies.query(options)), [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close() } },
    })
    const id = randomUUID()
    const session = () => events.findLast(event => event.type === "live-session")?.session
    try {
      await driver.start("/disposable", admitted("claude", { conversationId: id, emit: event => events.push(event) }))
      const prompt = async () => {
        await driver.prompt(id, "Fixture work", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
        const echo = await input?.next(); assert.ok(echo && !echo.done); messages.send(echo.value)
      }
      const result = (error?: string): SDKResultSuccess => ({
        type: "result", subtype: "success", uuid: randomUUID(), session_id: id,
        duration_ms: 1, duration_api_ms: 1, is_error: error !== undefined, num_turns: 1, result: error ?? "Done", stop_reason: "end_turn", total_cost_usd: 0,
        modelUsage: {}, permission_denials: [], queued_turn_count: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
          server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
      })
      await prompt()
      if (test.nativeOrg) messages.send({ type: "assistant", error: "oauth_org_not_allowed", uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
        message: { id: randomUUID(), type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null,
            cache_creation: null, fallback_credit: null, inference_geo: null, iterations: null, output_tokens_details: null, speed: null },
          container: null, context_management: null, diagnostics: null, stop_details: null } })
      messages.send(result(test.error))
      if (test.name === "closed-during-read") {
        await until(() => completeRead !== undefined, "credential read pending")
        await driver.close(id)
        const count = events.length
        completeRead!()
        await delay(5)
        assert.equal(events.slice(count).some(event => event.type === "live-session" && event.session.status === "failed"), false, "late credential result cannot resurrect a closed session")
        continue
      }
      await until(() => session()?.status === "failed", `${test.name}: terminal SDK failure`)
      assert.deepEqual(session()?.failureEvidence, test.expected, `${test.name}: evidence must survive the actual SDK boundary`)
      assert.equal(inspected, test.error === REFRESH_FAILED ? 2 : 1, "one classification read, plus the existing first-category refresh diagnostic")
      assert.equal(session()?.error, test.error.slice(0, 2_000), "provider words are retained separately from the verdict")
      await prompt(); messages.send(result())
      await until(() => session()?.status === "ready", "next successful turn")
      assert.equal(session()?.failureEvidence, undefined, "a later turn cannot inherit an old credential verdict")
    } finally { await driver.close(id) }
  }
  assert.deepEqual(claudeFailureEvidence('Failed to authenticate. API Error: 403 {"error":{"type":"unknown"}}', undefined), { kind: "unknown", source: "provider-error" }, "a provider JSON refusal is not an HTML gateway signal or a transient credential verdict")
  // Initialization errors use the same typed evidence, not only errors at the end of a turn.
  const startup = createClaudeSdkDriver({ ...dependencies,
    configure: async () => ({ options: { env: {} }, account: { name: "fixture" } }),
    inspectCredentials: async () => valid,
    query: async () => { throw new Error(HTML) },
  })
  await assert.rejects(startup.start("/disposable", admitted("claude", { conversationId: randomUUID(), emit: () => {} })), error => error instanceof ProviderFailureError && error.failureEvidence.kind === "provider-unavailable")
  console.log("PASS: credential/JSON/HTML evidence crosses actual SDK failure/start boundaries, preserves provider detail and clears on the next turn")
}
