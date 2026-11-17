import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { hostPlatform } from "../../base/platform.js"

/** Where Claude Code's administrator settings sit, which every session reads. */
const MANAGED = { darwin: "/Library/Application Support/ClaudeCode/managed-settings.json", linux: "/etc/claude-code/managed-settings.json", win32: "C:\\ProgramData\\ClaudeCode\\managed-settings.json" } as const

const Settings = z.object({
  hooks: z.record(z.string(), z.unknown()).optional(),
  enabledPlugins: z.record(z.string(), z.unknown()).optional(),
}).loose()

/**
 * Whether the person's own Claude Code setup may run their code in a session, outside the tools Mako holds: a hook on
 * any event (theirs run beside Mako's, never after it, and one on `UserPromptSubmit`, `SessionStart` or even `Stop`
 * can write before a turn's checkpoint holds the workspace), an enabled plugin (which may bring hooks), or settings
 * Mako can't read. Read where the session reads them: the config folder its environment names, the folder's project
 * and local settings, and the administrator's. A launch where this is true holds no writes; its message waits for the
 * checkpoint instead (`WriteHolds.attend`).
 */
export async function personCodeRuns(env: NodeJS.ProcessEnv | undefined, cwd: string): Promise<boolean> {
  const configDir = env?.CLAUDE_CONFIG_DIR || join(env?.HOME || homedir(), ".claude")
  const platform = hostPlatform()
  const files = [
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    ...platform === "other" ? [] : [MANAGED[platform]],
  ]
  for (const file of files) {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      return true
    }
    let parsed: z.infer<typeof Settings>
    try {
      const read = Settings.safeParse(JSON.parse(text))
      if (!read.success) return true
      parsed = read.data
    } catch {
      return true
    }
    if (Object.values(parsed.hooks ?? {}).some((groups) => !Array.isArray(groups) || groups.length > 0)) return true
    if (Object.values(parsed.enabledPlugins ?? {}).some((enabled) => enabled !== false)) return true
  }
  return false
}
