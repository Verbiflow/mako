import type { JsonObject } from "../../contracts/json.js"
import type { RoutedThread } from "../../contracts/native-routing.js"
import { hostLog } from "../../base/host-log.js"
import { layerOf } from "../mako-layer.js"
import { codexHookHash, codexHookKey } from "./authoring.js"
import { codexLayer } from "./layer.js"

/** What `thread/start`, `thread/resume` and `thread/fork` carry in `config` for native routing (`codexLayer`). */
export function codexRoutingConfig(conversation: string, routing: (() => RoutedThread) | undefined): JsonObject {
  return codexLayer.apply(layerOf({ nativeRouting: routing }), conversation).config()
}

/** Where Codex's own hook for a call posts it (`/calls/before` on the conversation server), and the grant it posts with. */
export interface CodexCallGate {
  url: string
  token: string
}

/**
 * The calls Mako's hook is registered for: Codex's shell (`Bash` covers `exec_command`, direct and in code mode), its
 * file edits (`apply_patch`), and every MCP tool (`mcp__<server>__<tool>`: its bundled browser and computer servers,
 * Mako's own and the person's, any of which may write), so a turn's checkpoint can hold each; which wait is the
 * gate's (`hookMayWrite`). A name list of letters, digits, `_` and `|` matches exactly in Codex's matcher; the other is
 * a pattern. `write_stdin` into a running command runs no hook at all (Codex: it continues a command that already
 * ran its hook as `Bash`), so a turn holds no writes while one runs (`firstWrite.openCommands`).
 */
const CODEX_GATED = ["Bash|apply_patch", "^mcp__.*$"] as const

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
