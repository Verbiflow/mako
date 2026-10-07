import { homedir } from "node:os"
import { join } from "node:path"

/** Where Devin keeps its data, `credentials.toml` and the CLI's store among it: `XDG_DATA_HOME` moves it. */
export function devinDataHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.XDG_DATA_HOME || join(home, ".local", "share")
}

/** The folder of Devin's CLI store, `sessions.db`, and its session locks. */
export function devinCliDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(devinDataHome(env, home), "devin", "cli")
}
