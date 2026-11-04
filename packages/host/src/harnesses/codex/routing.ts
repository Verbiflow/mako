import type { JsonObject } from "../../contracts/json.js"
import type { RoutedThread } from "../../contracts/native-routing.js"
import { launchSpawnsOff } from "../native-routing.js"
import { hostLog } from "../../base/host-log.js"
import { codexHookHash, codexHookKey } from "./authoring.js"

/**
 * What `thread/start`, `thread/resume` and `thread/fork` carry in `config`
 * for native routing. Codex resolves its multi-agent tools from the config's
 * override first, then the model's own `multi_agent_version`, then the
 * features, so `features.multi_agent = false` leaves a bundled model's
 * `spawn_agent` in place: only `agents.enabled = false` removes it. An
 * enabled `features.multi_agent_v2` would win over that, so it's off too.
 */
export function codexRoutingConfig(conversation: string, routing: (() => RoutedThread) | undefined): JsonObject {
  return launchSpawnsOff("codex", "agents.enabled", conversation, routing) ? { "agents.enabled": false, "features.multi_agent_v2": false } : {}
}

/** Where Codex's own hook for a call posts it (`/calls/before` on the conversation server), and the grant it posts with. */
export interface CodexCallGate {
  url: string
  token: string
}

/** The calls Mako's hook is registered for: Codex's shell (`Bash` covers `exec_command`, direct and in code mode) and its bundled browser and computer servers. */
const CODEX_GATED = ["Bash", "^mcp__(node_repl|cua_repl)__js(_reset)?$"] as const

/** Where Codex files the trust of a hook in the session's own config layer, as 0.166.0 resolves its synthetic path on macOS and Linux. */
const SESSION_FLAGS = "/<session-flags>/config.toml"

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/**
 * What `thread/start`, `thread/resume` and `thread/fork` carry in `config`
 * for native calls: a PreToolUse command hook per gated tool, posting the
 * call to Mako, and its trust in the same layer, so nothing is written to
 * the person's Codex home and their own untrusted hooks stay off. Proven on
 * 0.164.0 and 0.166.0 against a scripted model (2026-11-03): a deny is what
 * the model reads (`Command blocked by PreToolUse hook: …`) and the command
 * never runs; a note without a decision arrives as a developer message. A
 * hook that can't reach Mako fails, and the call goes on.
 */
export function codexCallsConfig(conversation: string, gate: CodexCallGate | undefined): JsonObject {
  if (!gate) return {}
  const handler = { type: "command", command: `curl -s -m 8 -X POST --data-binary @- -H ${quote(`Authorization: Bearer ${gate.token}`)} ${quote(gate.url)}`, timeout: 10 }
  const state: JsonObject = {}
  const groups = CODEX_GATED.map((matcher, group) => {
    const hash = codexHookHash("PreToolUse", matcher, handler)
    if (hash) state[codexHookKey(SESSION_FLAGS, { sourceId: SESSION_FLAGS, event: "PreToolUse", group, handler: 0 })] = { trusted_hash: hash }
    return { matcher, hooks: [handler] }
  })
  hostLog("routing", "native calls gated", { harness: "codex", via: "session-flags PreToolUse", conversation })
  return { hooks: { PreToolUse: groups, state } }
}
