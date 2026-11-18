import type { ToolEffect } from "@mako/sessions/tool-effects"
import { readOnlyCommand } from "./read-only.js"

/**
 * Where a finished tool call may have written, from the effects it reported: each file it created, changed, deleted
 * or renamed, and the folder of each command that isn't known to only read (`readOnlyCommand`), which is `cwd`, the
 * call's own folder, when the command names none. A checkout these are in has changed files to count again; a call
 * that only read names nothing.
 */
export function writtenPaths(effects: readonly ToolEffect[], cwd: string): string[] {
  const paths: string[] = []
  for (const effect of effects) {
    if (effect.kind === "create" || effect.kind === "modify" || effect.kind === "write" || effect.kind === "delete") paths.push(effect.path)
    else if (effect.kind === "rename") paths.push(effect.from, effect.to)
    else if (effect.kind === "command" && !readOnlyCommand(effect.command)) paths.push(effect.cwd ?? cwd)
  }
  return paths
}
