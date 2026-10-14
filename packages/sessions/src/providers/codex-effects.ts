import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { namedPaths } from "../tool-effect-reading.js"
import type { ToolEffect } from "../tool-effects.js"
import type { CodexPatchChange } from "./codex-presentation.js"

/**
 * What a Codex call said about the machine, gathered from its records: the
 * call's arguments, its typed item and the output Codex gave the model.
 * `codexToolEffects` turns them into the shared `ToolEffect`s.
 */
export interface CodexCallFacts {
  /** The folder the call ran in: its item's, its `workdir`, or its turn's. */
  cwd?: string
  /** The command a shell call ran, as the model asked for it. */
  command?: string
  exitCode?: number
  /** Codex reported the command still running when it answered the model. */
  background?: boolean
  /** What Codex parsed out of the command (`parsed_cmd`): each part's kind and the path it names. */
  parsed?: { type: string; path?: string }[]
  /** Each file a patch changed, as Codex applied it. */
  changes?: CodexPatchChange[]
  /** The patch the model sent, read when Codex kept no applied changes. */
  patch?: string
  /** The one file a read, view or write names. */
  path?: string
  /** What a whole-file write wrote. */
  content?: string
}

const MAX_CONTENT = 2_000_000
/** A command line longer than this is reported without the paths it names, as every harness's is. */
const MAX_PARSED_COMMAND = 16_000

/** An absolute path for `path`, read against `cwd`; undefined when it can't be placed. */
export function codexPath(path: string | undefined, cwd: string | undefined): string | undefined {
  if (!path) return undefined
  const local = path.startsWith("file:") ? fileFromUrl(path) : path
  if (!local) return undefined
  if (isAbsolute(local)) return local
  return cwd ? resolve(cwd, local) : undefined
}

function fileFromUrl(url: string): string | undefined {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

/** The effects of one call by its native name; undefined for a call that reports none. */
export function codexToolEffects(name: string, facts: CodexCallFacts): ToolEffect[] | undefined {
  switch (name) {
    case "exec_command":
      return facts.command === undefined ? undefined : commandEffects(facts)
    case "apply_patch":
      return patchEffects(facts)
    case "view_image":
    case "read_file": {
      const path = codexPath(facts.path, facts.cwd)
      return path ? [{ kind: "read", path }] : undefined
    }
    case "write_file":
    case "append_to_file": {
      const path = codexPath(facts.path, facts.cwd)
      if (!path) return undefined
      return [name === "write_file" && facts.content !== undefined && facts.content.length <= MAX_CONTENT
        ? { kind: "write", path, content: facts.content }
        : { kind: "write", path }]
    }
    default:
      return undefined
  }
}

/**
 * A shell call: the command, where it ran and how it exited, the paths it
 * names as written (`namedPaths`, every harness's reading), and each file
 * Codex itself parsed out of it as read (`parsed_cmd`).
 */
function commandEffects(facts: CodexCallFacts): ToolEffect[] {
  const line = facts.command ?? ""
  const cwd = codexPath(facts.cwd, undefined)
  const command: ToolEffect = { kind: "command", command: line.slice(0, 64_000) }
  if (cwd) command.cwd = cwd
  if (facts.exitCode !== undefined) command.exitCode = facts.exitCode
  const named = line.length > MAX_PARSED_COMMAND ? [] : namedPaths(line, cwd)
  if (named.length) command.named = named
  if (facts.background) command.background = true
  const reads = new Set<string>()
  for (const part of facts.parsed ?? []) {
    const path = part.type === "read" ? codexPath(part.path, cwd) : undefined
    if (path) reads.add(path)
  }
  return [command, ...[...reads].map((path): ToolEffect => ({ kind: "read", path }))]
}

function patchEffects(facts: CodexCallFacts): ToolEffect[] | undefined {
  const changes = facts.changes ?? (facts.patch === undefined ? undefined : patchChanges(facts.patch))
  if (!changes?.length) return undefined
  const effects: ToolEffect[] = []
  for (const change of changes) {
    const path = codexPath(change.path, facts.cwd)
    if (!path) continue
    switch (change.type) {
      case "add":
        effects.push(change.diff.length <= MAX_CONTENT ? { kind: "create", path, content: change.diff } : { kind: "create", path })
        break
      case "delete":
        effects.push({ kind: "delete", path })
        break
      case "update": {
        const to = codexPath(change.movePath ?? undefined, facts.cwd)
        if (to && to !== path) effects.push({ kind: "rename", from: path, to })
        const patch = change.diff.startsWith("@@ -") && change.diff.length <= MAX_CONTENT ? change.diff : undefined
        effects.push(patch ? { kind: "modify", path: to ?? path, patch } : { kind: "modify", path: to ?? path })
        break
      }
    }
  }
  return effects.length ? effects : undefined
}

/**
 * The files a patch in Codex's own grammar names (`*** Add File:`, `***
 * Delete File:`, `*** Update File:` with `*** Move to:`). An added file's
 * lines are its content; an update's hunks carry no line numbers, so it
 * names the file without a patch.
 */
export function patchChanges(patch: string): CodexPatchChange[] {
  const changes: CodexPatchChange[] = []
  let current: CodexPatchChange | undefined
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line)
    if (header) {
      current = { path: header[2]!.trim(), type: header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update", diff: "" }
      changes.push(current)
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move && current?.type === "update") {
      current.movePath = move[1]!.trim()
      continue
    }
    if (line.startsWith("*** ")) {
      if (line === "*** End Patch") current = undefined
      continue
    }
    if (current?.type === "add" && line.startsWith("+")) current.diff += `${line.slice(1)}\n`
  }
  return changes
}
