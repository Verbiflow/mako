import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import type { AccessTier } from "../../contracts/access.js"
import type { RoutedThread } from "../../contracts/native-routing.js"
import { layerOf } from "../mako-layer.js"
import { opencodeLayer } from "./layer.js"

const Rule = z.looseObject({ action: z.string(), resource: z.string(), effect: z.enum(["ask", "allow", "deny"]) })
const Agent = z.looseObject({ permissions: z.array(Rule).optional() })
const Config = z.looseObject({ agents: z.record(z.string(), z.unknown()).optional() })

function inlineConfig(env: NodeJS.ProcessEnv): z.infer<typeof Config> {
  const errors: ParseError[] = []
  const config = Config.parse(parse(env.OPENCODE_CONFIG_CONTENT || "{}", errors, { allowTrailingComma: true }))
  if (errors.length) throw new Error("OpenCode inline configuration contains invalid JSON.")
  return config
}

/** Native configuration only. OpenCode evaluates these rules and owns saved grants. */
export function configureOpenCodePermissions(env: NodeJS.ProcessEnv, access: AccessTier): void {
  if (access !== "ask" && access !== "edits" && access !== "full") return
  const config = inlineConfig(env)
  const permissions: z.infer<typeof Rule>[] = access === "full"
    ? [{ action: "*", resource: "*", effect: "allow" }]
    : [
        { action: "*", resource: "*", effect: "ask" },
        ...["read", "glob", "grep", "list", "question", "todoread", "todowrite"].map(action => ({ action, resource: "*", effect: "allow" as const })),
        ...(access === "edits" ? [{ action: "edit", resource: "*", effect: "allow" as const }] : []),
      ]
  // Agent-specific rules follow global rules in v2. Scope the selected preset
  // to Build so Plan and custom agents retain their own native policies.
  const build = Agent.default({}).parse(config.agents?.build)
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...config,
    agents: { ...config.agents, build: { ...build, permissions: [...(build.permissions ?? []), ...permissions] } },
  })
}

/** The permission action OpenCode checks before its `subagent` tool runs, and drops the tool for when it's denied everywhere. */
export const OPENCODE_SPAWN_ACTION = "subagent"
/** The agents Mako's modes run; each gets the deny last, so it wins over the tier's rules and the person's. */
const ROUTED_AGENTS = ["build", "plan"]

/** In a Thread whose spawns go to Mako, a deny on the subagent action for every agent Mako runs, after its other rules. */
export function configureOpenCodeRouting(env: NodeJS.ProcessEnv, conversation: string, routing: (() => RoutedThread) | undefined): void {
  if (!opencodeLayer.apply(layerOf({ nativeRouting: routing }), conversation).spawnsDenied()) return
  const config = inlineConfig(env)
  const deny = { action: OPENCODE_SPAWN_ACTION, resource: "*", effect: "deny" as const }
  const agents = { ...config.agents }
  for (const name of ROUTED_AGENTS) {
    const agent = Agent.default({}).parse(agents[name])
    agents[name] = { ...agent, permissions: [...(agent.permissions ?? []), deny] }
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, agents })
}
