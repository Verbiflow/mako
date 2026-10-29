import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Sandbox } from "./harness-sandbox.ts"

/**
 * Pointing a harness that Mako's own host launches at a local stand-in for
 * its model (`scripted-model.ts`, `scripted-windsurf.ts`), through what the
 * person's own setup would hold: the harness's settings files in the
 * sandbox's home, or the environment the host passes on. `key` is the API
 * key each harness sends, which names the test in the stand-in's log.
 */

/** The GETs a stand-in answers besides the conversation: Grok's key check and model catalog, as harness-decode-pairs.ts answers them. */
export const SCRIPTED_GETS: ReadonlyMap<string, string> = new Map([
  ["/v1/api-key", JSON.stringify({ redacted_api_key: "xai-...questions", user_id: "questions", name: "questions", acls: ["api-key:model:*", "api-key:endpoint:*"], api_key_blocked: false, api_key_disabled: false, team_blocked: false })],
  ["/v1/models", JSON.stringify({ object: "list", data: [{ id: "grok-4.6", object: "model", name: "Grok", context_window: 256_000 }] })],
])

/** Points the harness Mako launches at the stand-in model, through what the person's own setup would hold. */
export async function pointAt(harness: string, sandbox: Sandbox, url: string, env: NodeJS.ProcessEnv, key: string): Promise<void> {
  switch (harness) {
    case "claude":
      // Mako launches the CLI's own login without a key or endpoint from its environment (`nativeEnv`); the CLI's settings are the person's.
      await mkdir(join(sandbox.home, ".claude"), { recursive: true })
      await writeFile(join(sandbox.home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: key, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }))
      // As Claude Code leaves it after its first run; Mako reads who is signed in from it.
      await writeFile(join(sandbox.home, ".claude.json"), "{}")
      return
    case "codex":
      await mkdir(join(sandbox.home, ".codex"), { recursive: true })
      await writeFile(join(sandbox.home, ".codex", "config.toml"), `openai_base_url = "${url}/v1"\nchatgpt_base_url = "${url}/backend-api"\n\n[features]\nplugins = false\n`)
      await writeFile(join(sandbox.home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }))
      if (process.env.CODEX_EXECUTABLE) env.CODEX_EXECUTABLE = process.env.CODEX_EXECUTABLE
      return
    case "grok":
      Object.assign(env, { GROK_HOME: join(sandbox.home, ".grok"), XAI_API_KEY: key, GROK_XAI_API_BASE_URL: `${url}/v1`, GROK_CLI_CHAT_PROXY_BASE_URL: `${url}/v1`, GROK_MODELS_BASE_URL: `${url}/v1` })
      return
    case "opencode":
      if (process.env.OPENCODE_BIN_PATH) env.OPENCODE_BIN_PATH = process.env.OPENCODE_BIN_PATH
      Object.assign(env, {
        // Anthropic's models only, through the stand-in: OpenCode's own free hosted models would answer otherwise.
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${url}/v1`, apiKey: key } } } }),
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      })
      return
    case "devin":
      await mkdir(join(sandbox.home, ".config", "devin"), { recursive: true })
      await writeFile(join(sandbox.home, ".config", "devin", "config.json"), JSON.stringify({ auto_update: false }))
      if (process.env.DEVIN_CLI_PATH) env.DEVIN_CLI_PATH = process.env.DEVIN_CLI_PATH
      Object.assign(env, { WINDSURF_API_KEY: key, WINDSURF_API_SERVER_URL: url, DEVIN_API_URL: url, WINDSURF_WEBSITE_URL: url, DEVIN_WEBAPP_URL: url })
      return
    default:
      throw new Error(`There is no stand-in for ${harness}'s model`)
  }
}
