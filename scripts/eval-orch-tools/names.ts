import { z } from "zod"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import type { ToolArgs } from "./cases.ts"

/** Each kind of tool a harness's vocabulary names, under every name and alias it's called by. */
function namesOf(harness: string, kind: string): Set<string> {
  const vocabulary = VOCABULARIES.find((each) => each.harness === harness)
  if (!vocabulary) throw new Error(`No vocabulary for ${harness}`)
  return new Set(Object.entries(vocabulary.tools).filter(([, tool]) => tool.kind === kind).flatMap(([name, tool]) => [name, ...tool.aliases ?? []]))
}

const MAKO_TOOL = /(?:^|[_.:/])(agents_[a-z]+)$/

/**
 * A call as the cases name it: Mako's `agents_*` by bare name, however the
 * harness prefixes its MCP tools; any of the harness's own spawn tools as
 * `native_spawn`; anything else as the harness calls it.
 */
export function bareName(harness: string, name: string): string {
  const mako = MAKO_TOOL.exec(name)?.[1]
  if (mako) return mako
  return namesOf(harness, "agent").has(name) ? "native_spawn" : name
}

/** Whether `name` is one of the harness's shell tools, whose command a case's `shellMustNot` reads. */
export function isShell(harness: string, name: string): boolean {
  return namesOf(harness, "shell").has(name)
}

const Command = z.union([z.string(), z.array(z.string()).transform((parts) => parts.join(" "))])

/** A shell call's command, from the field each harness puts it in. */
export function shellCommand(args: ToolArgs): string {
  for (const key of ["command", "cmd", "commandLine", "script"]) {
    const command = Command.safeParse(args[key])
    if (command.success) return command.data
  }
  return JSON.stringify(args)
}
