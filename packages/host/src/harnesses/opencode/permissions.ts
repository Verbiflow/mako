import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import type { AccessTier } from "../../contracts/access.js"

const Rule = z.looseObject({ action: z.string(), resource: z.string(), effect: z.enum(["ask", "allow", "deny"]) })
const Agent = z.looseObject({ permissions: z.array(Rule).optional() })
const Config = z.looseObject({ agents: z.record(z.string(), z.unknown()).optional() })

/** Native configuration only. OpenCode evaluates these rules and owns saved grants. */
export function configureOpenCodePermissions(env: NodeJS.ProcessEnv, access: AccessTier): void {
  if (access !== "ask" && access !== "edits" && access !== "full") return
  const errors: ParseError[] = []
  const config = Config.parse(parse(env.OPENCODE_CONFIG_CONTENT || "{}", errors, { allowTrailingComma: true }))
  if (errors.length) throw new Error("OpenCode inline configuration contains invalid JSON.")
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
