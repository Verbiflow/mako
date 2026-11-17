import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { hostLog } from "../../base/host-log.js"
import { publishFile } from "../../base/published-files.js"

/**
 * Mako's OpenCode plugin for native calls: each tool call is posted to the
 * conversation server's gate (`/calls/pre`, `/calls/post`) in Claude Code's
 * hook shape. A deny is thrown, which the model reads as the call's error
 * result, and the call never runs, before OpenCode asks anyone; a note is
 * appended to the result. Proven on 2.2.3 and 2.1.4 against a scripted
 * model (2026-11-03). A gate that doesn't answer leaves the call as it was.
 */
const PLUGIN_SOURCE = `const post = async (url, token, body) => {
  try {
    const response = await fetch(url, { method: "POST", headers: { authorization: \`Bearer \${token}\`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    return response.ok ? await response.json() : {}
  } catch {
    return {}
  }
}

export default {
  id: "mako-calls",
  async setup(context) {
    const { url, token } = context.options
    await context.tool.hook("execute.before", async (call) => {
      const answer = await post(\`\${url}/pre\`, token, { tool_name: call.tool, tool_input: call.input })
      const output = answer && answer.hookSpecificOutput
      if (output && output.permissionDecision === "deny" && output.permissionDecisionReason) throw new Error(output.permissionDecisionReason)
    })
    await context.tool.hook("execute.after", async (call) => {
      if (call.status !== "completed") return
      const answer = await post(\`\${url}/post\`, token, { tool_name: call.tool, tool_input: call.input })
      const note = answer && answer.hookSpecificOutput && answer.hookSpecificOutput.additionalContext
      if (!note) return
      const result = call.result ?? {}
      const content = typeof result.content === "string" ? \`\${result.content}\\n\\n\${note}\`
        : Array.isArray(result.content) ? [...result.content, { type: "text", text: note }]
        : note
      call.result = { ...result, content }
    })
  },
}
`

/** The plugin's folder, the same for every launch of this build: OpenCode loads a folder holding `server.js`, never a bare file. */
async function pluginFolder(): Promise<string> {
  const folder = join(tmpdir(), `mako-opencode-calls-${createHash("sha256").update(PLUGIN_SOURCE).digest("hex").slice(0, 16)}`)
  await publishFile(join(folder, "server.js"), PLUGIN_SOURCE, { mode: 0o600, dirMode: 0o700 })
  return folder
}

const Config = z.looseObject({ plugins: z.array(z.json()).optional() })

/**
 * Names Mako's plugin in the launch's inline config, after the person's own
 * (`plugins`, v2's key; their `plugin/` folders load as before), where the
 * launch routes calls and has Mako's server to post to.
 */
export async function configureOpenCodeCalls(env: NodeJS.ProcessEnv, conversation: string, gate: { url: string; token: string } | undefined): Promise<void> {
  if (!gate) return
  const errors: ParseError[] = []
  const config = Config.parse(parse(env.OPENCODE_CONFIG_CONTENT || "{}", errors, { allowTrailingComma: true }))
  if (errors.length) throw new Error("OpenCode inline configuration contains invalid JSON.")
  const plugin = { package: await pluginFolder(), options: gate }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, plugins: [...config.plugins ?? [], plugin] })
  hostLog("routing", "native calls gated", { harness: "opencode", via: "plugin execute.before", conversation })
}
