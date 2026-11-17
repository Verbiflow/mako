import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** A `config.toml` that names hooks: a `[hooks]` table, an array of them, or a `hooks =` key. */
const TOML_HOOKS = /^\s*(\[\[?\s*hooks\b|hooks\s*=)/m
/** A `config.toml` that turns plugins, which may bring hooks, off. */
const PLUGINS_OFF = /^\s*plugins\s*=\s*false\b/m

/** A file's text; null when there's none, undefined when it can't be read. */
async function text(path: string): Promise<string | null | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? null : undefined
  }
}

/**
 * Whether the person's own Codex setup may run their code beside Mako's hook, so a write could go before a turn's
 * checkpoint holds the workspace: hooks in a config layer Codex reads (its home, the folder's `.codex`, the system's
 * `/etc/codex`: a `hooks.json`, or hooks in a `config.toml` or `requirements.toml`), installed plugins with plugins not
 * turned off, or a file Mako can't read. Hooks an administrator pushes as macOS managed preferences aren't files and
 * aren't seen. A launch where this is true holds no writes; its message waits for the checkpoint (`WriteHolds.attend`).
 */
export async function codexPersonCodeRuns(env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex")
  const folders = [home, join(cwd, ".codex"), "/etc/codex"]
  let pluginsOff = false
  for (const folder of folders) {
    const hooks = await text(join(folder, "hooks.json"))
    if (hooks !== null) return true
    for (const name of ["config.toml", "managed_config.toml", "requirements.toml"]) {
      const config = await text(join(folder, name))
      if (config === undefined) return true
      if (config === null) continue
      if (TOML_HOOKS.test(config)) return true
      if (folder === home && name === "config.toml" && PLUGINS_OFF.test(config)) pluginsOff = true
    }
  }
  if (pluginsOff) return false
  try {
    return (await readdir(join(home, "plugins"))).length > 0
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT")
  }
}
