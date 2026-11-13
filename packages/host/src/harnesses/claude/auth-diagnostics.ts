import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { classifyProviderFailure } from "../../contracts/provider-failure.js"
import type { ProviderFailureEvidence } from "../../contracts/provider-failure-evidence.js"
import { claudeFailureEvidence, claudePermissionRefusal, claudeRejectedCredential } from "./failure-evidence.js"
import type { HostLogFields } from "../../base/host-log.js"
import { claudeCredentialState, type ClaudeCredentialState } from "./accounts.js"

/** The host-log scope Claude's native authentication failures are written under. */
export const CLAUDE_AUTH_LOG = "claude-auth"

/**
 * What the failing store's shape says. `unexplained` includes a provider refusing locally current credentials;
 * it does not establish a sign-out or a refresh-rotation fault.
 */
export type ClaudeAuthCause =
  | "store-unreadable"
  | "signed-out"
  | "cleared"
  | "no-refresh-token"
  | "refresh-expired"
  | "unexplained"

export function claudeAuthCause(state: ClaudeCredentialState, now: Date): ClaudeAuthCause {
  if (state.store === "unreadable") return "store-unreadable"
  if (state.store === "none") return "signed-out"
  if (!state.access && state.refresh !== "present") return "cleared"
  if (state.refresh !== "present") return "no-refresh-token"
  if (state.refreshExpiresAt && Date.parse(state.refreshExpiresAt) <= now.getTime()) return "refresh-expired"
  return "unexplained"
}

function storeFields(state: ClaudeCredentialState): HostLogFields {
  if (state.store === "none" || state.store === "unreadable") return { store: state.store, scopedStore: state.scoped }
  return {
    store: state.store,
    scopedStore: state.scoped,
    accessToken: state.access,
    refreshToken: state.refresh,
    expiresAt: state.expiresAt,
    refreshExpiresAt: state.refreshExpiresAt,
    storeWrittenAt: state.writtenAt,
  }
}

const REVOKED = "OAuth access token has been revoked"

/** Configuration provenance plus the failing store's secret-free shape, read once per failure category. */
export function claudeAuthDiagnostics(
  env: NodeJS.ProcessEnv,
  publish: (fields: HostLogFields) => void,
  inspect: (env: NodeJS.ProcessEnv) => Promise<ClaudeCredentialState> = claudeCredentialState
) {
  const hash = (value: string) => createHash("sha256").update(value.normalize("NFC")).digest("hex").slice(0, 16)
  const provenance = {
    configScope: hash(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude")),
    customConfig: Boolean(env.CLAUDE_CONFIG_DIR),
    secureStorageScope: hash(env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? ""),
    secureStorageOverride: env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined,
    apiKeyOverride: Boolean(env.ANTHROPIC_API_KEY),
    authTokenOverride: Boolean(env.ANTHROPIC_AUTH_TOKEN),
    oauthTokenOverride: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
    baseUrlOverride: Boolean(env.ANTHROPIC_BASE_URL),
  }
  let nativeAuth = false
  let nativeRejected = false
  let nativePermission = false
  let version: string | undefined
  const reported = new Set<string>()
  const pending = new Set<Promise<void>>()
  function report(category: string) {
    if (reported.has(category)) return
    reported.add(category)
    const failedAt = new Date()
    const settle = inspect(env)
      .then(
        state => publish({ ...provenance, category, nativeVersion: version, cause: claudeAuthCause(state, failedAt), ...storeFields(state) }),
        () => publish({ ...provenance, category, nativeVersion: version, cause: "store-unreadable" })
      )
      .finally(() => pending.delete(settle))
    pending.add(settle)
  }
  return {
    observe(message: SDKMessage): void {
      if (message.type === "system" && message.subtype === "init") {
        // Never log arbitrary native strings, prompt content, identity or credentials.
        if (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(message.claude_code_version))
          version = message.claude_code_version
      }
      if (message.type === "assistant" && !message.parent_tool_use_id &&
        (message.error === "authentication_failed" || message.error === "oauth_org_not_allowed")) {
        nativeAuth = true
        nativePermission ||= message.error === "oauth_org_not_allowed" || message.message.content.some(block => block.type === "text" && claudePermissionRefusal(block.text))
        const revoked = message.message.content.some(block => block.type === "text" && block.text.includes(REVOKED))
        nativeRejected ||= message.message.content.some(block => block.type === "text" && claudeRejectedCredential(block.text))
        report(revoked ? "access-revoked" : message.error)
      }
    },
    failure(message: string): void {
      if (message === "Failed to authenticate: OAuth session expired and could not be refreshed")
        report("native-refresh-unavailable")
    },
    /** Native failures only: consult the launch scope, never expose tokens or treat a wrapper as sign-out proof. */
    async failureEvidence(message: string | undefined): Promise<ProviderFailureEvidence | undefined> {
      if (!message) { nativeAuth = false; nativeRejected = false; nativePermission = false; return undefined }
      const classified = classifyProviderFailure(message).kind
      const auth = nativeAuth || /^Failed to authenticate[.:]/i.test(message) || classified === "auth" || classified === "permission" || claudeRejectedCredential(message) || claudePermissionRefusal(message)
      const rejected = nativeRejected
      const permission = nativePermission
      nativeAuth = false
      nativeRejected = false
      nativePermission = false
      if (!auth) return undefined
      if (permission) return { kind: "permission", source: "provider-permission-error" }
      if (rejected) return { kind: "auth", source: "provider-auth-error" }
      // An override runs as its own credential; the ordinary OAuth store cannot attest to it.
      const override = provenance.apiKeyOverride || provenance.authTokenOverride || provenance.oauthTokenOverride
      const state = override ? undefined : await inspect(env).catch(() => undefined)
      return claudeFailureEvidence(message, state)
    },
    /** Resolves once every store read started so far has been published. */
    async settled(): Promise<void> {
      await Promise.all(pending)
    },
  }
}
