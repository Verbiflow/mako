import type { JsonObject } from "../../contracts/json.js"
import type { RoutedThread } from "../../contracts/native-routing.js"
import { launchSpawnsOff } from "../native-routing.js"

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
