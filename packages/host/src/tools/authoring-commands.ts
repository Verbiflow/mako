import { join, sep } from "node:path"
import { z } from "zod"
import type { AuthoringChange, AuthoringDraft, AuthoringEntry } from "../contracts/native-authoring.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import type { AuthoringEdit, ReadSource } from "./editing-capability.js"
import { frontmatter, parseJsonc, setJsonValue } from "./authoring-text.js"

/**
 * Custom commands: a folder of Markdown files, one per command, whose path
 * below the folder is the name typed after `/` (Claude Code joins folders
 * with `:`, OpenCode with `/`); or, for OpenCode, entries of a config key.
 * A file is written as the person wrote it, frontmatter and all.
 */
export interface CommandFolder {
  /** What joins a nested file's folders into its name. */
  separator: ":" | "/"
}

const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/
const ObjectSchema = z.record(z.string(), z.json())
const asObject = (value: JsonValue | undefined): JsonObject | null => { const parsed = ObjectSchema.safeParse(value); return parsed.success ? parsed.data : null }

export function commandEntryId(sourceId: string, key: string): string {
  return `${sourceId}#${key}`
}

function entryKey(sourceId: string, entryId: string): string {
  if (!entryId.startsWith(`${sourceId}#`)) throw new Error("That command is no longer where it was. Reload and try again.")
  return entryId.slice(sourceId.length + 1)
}

/** The source an entry or a new command belongs to. */
export function commandSource(sources: readonly ReadSource[], change: AuthoringChange): ReadSource {
  const sourceId = change.kind === "create" ? change.sourceId : change.entryId.slice(0, change.entryId.lastIndexOf("#"))
  const source = sources.find((entry) => entry.spec.id === sourceId || (change.kind !== "create" && change.entryId.startsWith(`${entry.spec.id}#`)))
  if (!source) throw new Error("That command's folder is no longer one this harness reads. Reload and try again.")
  return source
}

function invocationOf(folder: CommandFolder, path: string): string {
  return path.slice(0, -".md".length).split(sep).join(folder.separator)
}

function fileOf(folder: CommandFolder, invocation: string): string {
  const segments = invocation.replace(/^\//, "").split(folder.separator)
  if (!segments.every((segment) => SEGMENT.test(segment) && !segment.includes("..")))
    throw new Error(`Name a command with letters, numbers, dots, dashes and underscores${folder.separator === "/" ? ", with / between folders" : ", with : between folders"}.`)
  return `${join(...segments)}.md`
}

export function readCommandFolder(folder: CommandFolder, source: ReadSource): AuthoringEntry[] {
  return source.files.map((file) => {
    const invocation = invocationOf(folder, file.path)
    const description = frontmatter(file.text).get("description")
    const command: AuthoringEntry["command"] = { invocation, text: file.text }
    if (description) command.description = description
    return { id: commandEntryId(source.spec.id, file.path), sourceId: source.spec.id, name: `/${invocation}`, enabled: true, command }
  })
}

function commandDraft(draft: AuthoringDraft): Extract<AuthoringDraft, { kind: "command" }> {
  if (draft.kind !== "command") throw new Error("A command needs a name and its instructions.")
  if (!draft.text.trim()) throw new Error("Write the command's instructions before saving.")
  return draft
}

function folderEdit(source: ReadSource, file: string, after: string | null, summary: string): AuthoringEdit {
  if (source.problem) throw new Error(source.problem)
  if (!source.spec.writable.supported) throw new Error(source.spec.writable.reason)
  const before = source.files.find((entry) => entry.path === file)?.text ?? null
  return { path: join(source.spec.path, file), root: source.spec.root, scope: source.spec.scope, format: "markdown", before, after, summary }
}

/** One command file created, rewritten or deleted. Renaming is a new command and a removal. */
export function commandFolderEdit(folder: CommandFolder, source: ReadSource, change: AuthoringChange): AuthoringEdit {
  if (change.kind === "create") {
    const draft = commandDraft(change.draft)
    const file = fileOf(folder, draft.invocation)
    if (source.files.some((entry) => entry.path === file)) throw new Error(`/${invocationOf(folder, file)} already exists in ${source.spec.label}. Edit that one instead.`)
    return folderEdit(source, file, draft.text, `Create /${invocationOf(folder, file)} in ${source.spec.label}`)
  }
  if (change.kind === "enable" || change.kind === "trust") throw new Error("A command file has no switch; it is read while it exists.")
  const file = entryKey(source.spec.id, change.entryId)
  if (!source.files.some((entry) => entry.path === file)) throw new Error(`${file} is no longer in ${source.spec.path}. Reload and try again.`)
  if (change.kind === "remove") return folderEdit(source, file, null, `Delete /${invocationOf(folder, file)} from ${source.spec.label}`)
  const draft = commandDraft(change.draft)
  if (fileOf(folder, draft.invocation) !== file) throw new Error("Renaming a command isn't an edit: create the new one, then remove this one.")
  return folderEdit(source, file, draft.text, `Rewrite /${invocationOf(folder, file)} in ${source.spec.label}`)
}

/** Commands declared under a config key (OpenCode's `commands`), each a `template` with its options beside it. */
export function readConfigCommands(source: ReadSource, keys: readonly string[]): AuthoringEntry[] {
  if (source.text === null) return []
  const value = asObject(parseJsonc(source.text, source.spec.path)) ?? {}
  return keys.flatMap((key) => Object.entries(asObject(value[key]) ?? {}).flatMap(([name, entry]) => {
    const template = z.string().safeParse(asObject(entry)?.template).data
    if (template === undefined) return []
    const command: AuthoringEntry["command"] = { invocation: name, text: template }
    const description = z.string().safeParse(asObject(entry)?.description).data
    if (description) command.description = description
    return [{ id: commandEntryId(source.spec.id, `${key}.${name}`), sourceId: source.spec.id, name: `/${name}`, enabled: true, command }]
  }))
}

/** A config command's template rewritten or the command removed; its other options stay. */
export function configCommandEdit(source: ReadSource, change: AuthoringChange): AuthoringEdit {
  if (source.problem) throw new Error(source.problem)
  if (!source.spec.writable.supported) throw new Error(source.spec.writable.reason)
  if (change.kind === "create") throw new Error("New commands are written as files, which this config also reads.")
  if (change.kind === "enable" || change.kind === "trust") throw new Error("A command has no switch; it is read while it exists.")
  const key = entryKey(source.spec.id, change.entryId)
  const dot = key.indexOf(".")
  const path = [key.slice(0, dot), key.slice(dot + 1)]
  const value = asObject(parseJsonc(source.text ?? "", source.spec.path)) ?? {}
  if (!asObject(asObject(value[path[0] ?? ""])?.[path[1] ?? ""])) throw new Error(`/${path[1]} is no longer in ${source.spec.path}. Reload and try again.`)
  const base = { path: source.spec.path, root: source.spec.root, scope: source.spec.scope, format: source.spec.format, before: source.text }
  if (change.kind === "remove") return { ...base, after: setJsonValue(source.text ?? "", path, undefined), summary: `Remove /${path[1]} from ${source.spec.label}` }
  const draft = commandDraft(change.draft)
  if (draft.invocation !== path[1]) throw new Error("Renaming a command isn't an edit: create the new one, then remove this one.")
  return { ...base, after: setJsonValue(source.text ?? "", [...path, "template"], draft.text), summary: `Rewrite /${path[1]} in ${source.spec.label}` }
}

const MODULE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\.(?:ts|js)$/

/** Code files a harness loads whole, one entry each: OpenCode's plugins. */
export function readModuleFolder(source: ReadSource): AuthoringEntry[] {
  return source.files.map((file) => ({ id: commandEntryId(source.spec.id, file.path), sourceId: source.spec.id, name: file.path, enabled: true, module: { text: file.text } }))
}

/** One module file created, rewritten or deleted; a name without `.ts` or `.js` gets `.ts`. */
export function moduleFolderEdit(source: ReadSource, change: AuthoringChange): AuthoringEdit {
  if (change.kind === "enable" || change.kind === "trust") throw new Error("A plugin file is loaded while it exists.")
  if (change.kind === "remove") {
    const file = entryKey(source.spec.id, change.entryId)
    if (!source.files.some((entry) => entry.path === file)) throw new Error(`${file} is no longer in ${source.spec.path}. Reload and try again.`)
    return folderEdit(source, file, null, `Delete ${file} from ${source.spec.label}`)
  }
  if (change.draft.kind !== "module") throw new Error("A plugin needs a file name and its code.")
  const draft = change.draft
  const name = /\.(?:ts|js)$/.test(draft.name) ? draft.name : `${draft.name}.ts`
  if (!MODULE.test(name)) throw new Error("Name a plugin file with letters, numbers, dots, dashes and underscores, ending .ts or .js.")
  if (!draft.text.trim()) throw new Error("Write the plugin's code before saving.")
  const exists = source.files.some((entry) => entry.path === name)
  if (change.kind === "create" && exists) throw new Error(`${name} already exists in ${source.spec.label}. Edit that one instead.`)
  if (change.kind === "edit" && entryKey(source.spec.id, change.entryId) !== name) throw new Error("Renaming a plugin isn't an edit: create the new file, then remove this one.")
  return folderEdit(source, name, draft.text, `${change.kind === "create" ? "Create" : "Rewrite"} ${name} in ${source.spec.label}`)
}
