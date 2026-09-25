import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HostLogFields } from "../../host-log.js"

/** Configuration provenance, not a claim about which credential native code read. */
export function claudeAuthDiagnostics(
  env: NodeJS.ProcessEnv,
  publish: (fields: HostLogFields) => void
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
  let version: string | undefined
  const reported = new Set<string>()
  function report(category: string) {
    if (reported.has(category)) return
    reported.add(category)
    publish({ ...provenance, category, nativeVersion: version })
  }
  return {
    observe(message: SDKMessage): void {
      if (message.type === "system" && message.subtype === "init") {
        // Never log arbitrary native strings, prompt content, identity or credentials.
        if (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(message.claude_code_version))
          version = message.claude_code_version
      }
      if (message.type === "assistant" && !message.parent_tool_use_id &&
        (message.error === "authentication_failed" || message.error === "oauth_org_not_allowed"))
        report(message.error)
    },
    failure(message: string): void {
      if (message === "Failed to authenticate: OAuth session expired and could not be refreshed")
        report("native-refresh-unavailable")
    },
  }
}
