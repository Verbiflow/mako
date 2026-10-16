import { z } from "zod"
import type { EntryBlock, ThreadEntry } from "./format.js"
import type { EffectKeys, EffectReading, ReportedChange } from "./harnesses/vocabulary.js"
import { liveToolFinished } from "./live-content.js"
import { identifyTool, scriptToolCalls, toolDeclaration, toolRefusals, type ToolIdentity } from "./tool-identity.js"
import type { ToolEffect, ToolEffects } from "./tool-effects.js"

/**
 * Every harness's tool calls read as `ToolEffect`s: the one reading the live
 * decoders and the history readers share, so a call says the same live and
 * saved. A call is read by its identity (`identifyTool`, which unwraps
 * `use_tool`, `CallDynamicTool` and code-mode scripts) and by what its
 * harness declares of the tool (`NativeTool.effects`): where its arguments
 * hold an edit's strings or a write's content, where its result states the
 * exact change, a command's folder and exit. Nothing here reads a file or a
 * clock; a call is read from what its record holds.
 *
 * A change is stated as exactly as the call stated it: hunks with line
 * numbers when the harness reported them (Claude's `structuredPatch`,
 * Cursor's `diffString`, OpenCode's per-file patches) or when a diff gave
 * the whole file before and after (Devin, Grok's `write`), an edit's strings
 * when it said only what text it replaced, and the bare path otherwise.
 */

/** The most text one effect carries from a call; a longer content, patch or edit is left out of the effect, never cut. */
export const REPORTED_TEXT_LIMIT = 256 * 1024
const MAX_NAMED = 256
const MAX_COMMAND = 64_000
const MAX_EDITS = 256
/** A command line longer than this is reported without the paths it names. */
const MAX_PARSED_COMMAND = 16_000

type JsonValue = z.infer<ReturnType<typeof z.json>>
type JsonFields = { [key: string]: JsonValue }

/**
 * A harness's own value for a call's arguments or result, taken as JSON
 * without walking it: it reached the harness's record through `JSON.parse`,
 * and every field read of it is checked where it is read.
 */
export const ReportedJson = z.custom<JsonValue>((value) => value !== undefined)

/** A file a call's content showed before and after, as ACP's `diff` content gives it. */
export interface ReportedDiff {
  path: string
  /** `null` for a file the call created. */
  oldText: string | null
  newText: string
}

/** One finished call as its harness recorded it. */
export interface ReportedCall {
  harness: string
  /** The harness's own tool name. */
  name?: string
  title?: string
  /** ACP's kind for the call, for a name no vocabulary knows. */
  acpKind?: string
  /** The arguments, parsed; `input` is read when they aren't. */
  args?: JsonValue
  /** The arguments as the harness sent them: JSON, or a script's source. */
  input?: string
  /** What the harness returned for the call, in its own shape. */
  result?: JsonValue
  /** The text the call answered the model with. */
  output?: string
  /** Files its content showed changing (ACP's `diff`). */
  diffs?: readonly ReportedDiff[]
  /** How its command exited, when the protocol says beside the result (ACP's terminal extension). */
  exitCode?: number
  /** The folder the call ran in when its harness says, else the session's. */
  cwd?: string
}

/** The effects one finished call reported, in the order it made them. */
export function reportedEffects(call: ReportedCall): ToolEffect[] {
  const args = isFields(call.args) ? call.args : parsedArguments(call.input)
  const identity = identifyTool({ harness: call.harness, name: call.name, title: call.title, acpKind: call.acpKind, input: call.input, args })
  const own = call.name ? toolDeclaration(call.harness, call.name)?.effects : undefined
  const scripted = scriptEffects(call, own, args)
  if (scripted) return scripted
  const reading: Reading = {
    call,
    args: identity.via ? parsedArguments(identity.input) : args,
    declared: toolDeclaration(call.harness, identity.via ? identity.tool ?? identity.name : identity.name)?.effects ?? {},
  }
  const effects = byKind(identity, reading)
  if (call.diffs?.length && !effects.some(changesFile)) effects.push(...diffEffects(call.diffs, reading, "edit"))
  return effects.slice(0, 1024)
}

/** How a call ended, for its effects: a call its harness refused never ran. */
export function toolEffectsStatus(harness: string, call: { finished: boolean; failed: boolean; output?: string }): ToolEffects["status"] {
  if (!call.finished) return "running"
  const output = call.output?.trimStart()
  if (output && toolRefusals(harness).some((refusal) => refusal.test(output))) return "refused"
  return call.failed ? "failed" : "completed"
}

/** A live tool block's status as its effects' status. */
export function liveEffectsStatus(harness: string, block: { status?: string; output?: string }): ToolEffects["status"] {
  return toolEffectsStatus(harness, { finished: liveToolFinished(block.status), failed: block.status === "failed" || /cancel/i.test(block.status ?? ""), output: block.output })
}

type ToolEntry = Extract<EntryBlock, { type: "tool" }>

/**
 * A saved call's effects: those its reader recorded on the block, or, for a
 * store whose reader records none, those its block alone says (its name,
 * arguments, diffs and output). `cwd` is the session's folder.
 */
export function savedCallEffects(harness: string, block: ToolEntry, cwd?: string): ToolEffect[] {
  if (block.effects) return block.effects
  const diffs = block.details?.flatMap((detail) => detail.type === "diff" ? [{ path: detail.path, oldText: detail.oldText, newText: detail.newText }] : [])
  const call: ReportedCall = { harness, name: block.name, input: block.input }
  if (cwd) call.cwd = cwd
  if (diffs?.length) call.diffs = diffs
  if (block.output !== undefined) call.output = block.output
  return reportedEffects(call)
}

/**
 * Every tool call of a saved session with its effects, in the order the
 * session made them. This is the saved-history side of attribution: the host
 * opens a session through its catalog (`SessionCatalog.open`) and reads it
 * here; the live side is the live engine's `effects` hook. A call reports no
 * effects when its record says nothing it did; it is still listed, with its
 * status. `startedAt` is when the reply holding the call was written.
 */
export function savedToolEffects(harness: string, entries: readonly ThreadEntry[], cwd?: string): ToolEffects[] {
  const calls: ToolEffects[] = []
  const times = entries.map((entry) => (entry.at === undefined ? Number.NaN : Date.parse(entry.at)))
  /** The time of the first entry after each that has one. */
  const after = Array.from({ length: entries.length }, () => Number.NaN)
  for (let index = entries.length - 1, next = Number.NaN; index >= 0; index--) {
    after[index] = next
    if (Number.isFinite(times[index])) next = times[index]!
  }
  entries.forEach((entry, index) => {
    if (entry.kind !== "assistant") return
    const at = times[index]!
    // A finished call whose record keeps no end had ended by the next entry.
    const next = after[index]! >= at ? after[index] : undefined
    entry.blocks.forEach((block, position) => {
      if (block.type !== "tool") return
      const finished = block.output !== undefined || block.error === true || block.canceled === true
      const call: ToolEffects = {
        callId: block.id ?? `${entry.id ?? index}:${position}`,
        status: toolEffectsStatus(harness, { finished, failed: block.error === true || block.canceled === true, output: block.output }),
        effects: savedCallEffects(harness, block, cwd),
      }
      if (Number.isFinite(at)) call.startedAt = at
      if (Number.isFinite(at) && finished && next !== undefined) call.endedAt = next
      calls.push(call)
    })
  })
  return calls
}

/* ----------------------------------------------------------- by kind */

interface Reading {
  call: ReportedCall
  /** The arguments of the tool that ran, inside any wrapper. */
  args: JsonFields | undefined
  declared: EffectReading
}

function byKind(identity: ToolIdentity, reading: Reading): ToolEffect[] {
  const path = () => absolutePath(identity.path, reading.call.cwd)
  switch (identity.kind) {
    case "shell":
      return identity.command === undefined ? [] : [commandEffect(identity.command, reading), ...reportedFiles(reading)]
    case "read": {
      const read = path()
      return read ? [{ kind: "read", path: read }] : []
    }
    case "edit":
      return editEffects(path(), reading)
    case "write":
      return writeEffects(path(), reading)
    case "delete": {
      const deleted = path()
      return deleted ? [{ kind: "delete", path: deleted }] : []
    }
    case "move": {
      const from = path()
      const to = absolutePath(text(lookup(reading, ["destination", "new_path", "newPath", "to", "target_path"])), reading.call.cwd)
      return from && to ? [{ kind: "rename", from, to }] : []
    }
    default:
      return []
  }
}

/** A code-mode script's effects: its harness's record of the calls it made, else the calls its source names. */
function scriptEffects(call: ReportedCall, own: EffectReading | undefined, args: JsonFields | undefined): ToolEffect[] | undefined {
  const recorded = own?.calls ? lookup({ call, args, declared: own }, own.calls) : undefined
  if (Array.isArray(recorded)) {
    return recorded.flatMap((inner) => {
      if (!isFields(inner)) return []
      const name = text(inner["tool"]) ?? text(inner["name"])
      return name ? reportedEffects({ harness: call.harness, name, args: inner["input"] ?? inner["args"], cwd: call.cwd }) : []
    })
  }
  const calls = call.name ? scriptToolCalls({ harness: call.harness, name: call.name, input: call.input, args }) : []
  if (calls.length < 2) return undefined
  return calls.flatMap((inner) => reportedEffects({ harness: call.harness, name: inner.name, input: inner.input, cwd: call.cwd }))
}

function changesFile(effect: ToolEffect): boolean {
  return effect.kind !== "read" && effect.kind !== "command"
}

function editEffects(path: string | undefined, reading: Reading): ToolEffect[] {
  const { declared, call } = reading
  const reported = reportedChange(declared.reported, path, reading)
  if (reported.length) return reported
  if (declared.wholeDiffs && call.diffs?.length) return diffEffects(call.diffs, reading, "edit")
  const patched = declared.patch ? patchEffects(text(lookup(reading, declared.patch)), path, call.cwd) : []
  if (patched.length) return patched
  const edits = declared.edits ? argumentEdits(declared.edits, reading) : undefined
  if (path && edits) return [edits.length ? { kind: "modify", path, edits } : { kind: "modify", path }]
  if (call.diffs?.length) return diffEffects(call.diffs, reading, "edit")
  return path ? [{ kind: "modify", path }] : []
}

function writeEffects(path: string | undefined, reading: Reading): ToolEffect[] {
  const { declared, call } = reading
  const content = bounded(text(lookup(reading, declared.content)))
  if (path && declared.reported?.form === "hunks") {
    const result = lookup(reading, prefixed(declared.reported.key))
    const created = declared.reported.created
    if (created && text(lookup(reading, prefixed(created.key))) === created.value) return [{ kind: "create", path, ...content !== undefined && { content } }]
    if (Array.isArray(result)) return [hunksEffect(path, result)]
  }
  const reported = declared.reported?.form === "hunks" ? [] : reportedChange(declared.reported, path, reading, content)
  if (reported.length) return reported
  if (declared.wholeDiffs && call.diffs?.length) return diffEffects(call.diffs, reading, "write")
  if (!path) return call.diffs?.length ? diffEffects(call.diffs, reading, "write") : []
  return [{ kind: "write", path, ...content !== undefined && { content } }]
}

/* --------------------------------------------------- reported changes */

/** What a result states it changed, read by the tool's declared form; empty when it states nothing. */
function reportedChange(change: ReportedChange | undefined, path: string | undefined, reading: Reading, content?: string): ToolEffect[] {
  if (!change) return []
  const value = lookup(reading, prefixed(change.key))
  switch (change.form) {
    case "hunks":
      return path && Array.isArray(value) && value.length ? [hunksEffect(path, value)] : []
    case "unified": {
      const diff = text(value)
      return diff ? patchEffects(diff, path, reading.call.cwd) : []
    }
    case "files": {
      if (!Array.isArray(value)) return []
      return value.flatMap((entry): ToolEffect[] => {
        if (!isFields(entry)) return []
        const file = absolutePath(text(entry["file"]) ?? text(entry["path"]), reading.call.cwd) ?? (value.length === 1 ? path : undefined)
        if (!file) return []
        const status = text(entry["status"])
        if (status === "deleted") return [{ kind: "delete", path: file }]
        const body = patchBody(text(entry["patch"]))
        if (status === "added") {
          const added = content ?? addedContent(body)
          return [{ kind: "create", path: file, ...added !== undefined && { content: added } }]
        }
        return [{ kind: "modify", path: file, ...body !== undefined && { patch: body } }]
      })
    }
    case "edited-files":
      return reportedFiles(reading, value)
  }
}

/** Files a command changed as its harness saw them (Claude's `bashEditDiff`). */
function reportedFiles(reading: Reading, value = reading.declared.reported?.form === "edited-files" ? lookup(reading, prefixed(reading.declared.reported.key)) : undefined): ToolEffect[] {
  const files = isFields(value) ? value["files"] : undefined
  if (!Array.isArray(files)) return []
  return files.flatMap((entry): ToolEffect[] => {
    if (!isFields(entry)) return []
    const path = absolutePath(text(entry["filePath"]), reading.call.cwd)
    if (!path) return []
    if (entry["deleted"] === true) return [{ kind: "delete", path, seen: true }]
    const hunks = Array.isArray(entry["hunks"]) ? entry["hunks"] : []
    if (entry["created"] === true) {
      const content = addedContent(hunksPatch(hunks))
      return [{ kind: "create", path, ...content !== undefined && { content }, seen: true }]
    }
    return [{ ...hunksEffect(path, hunks), seen: true }]
  })
}

function hunksEffect(path: string, hunks: readonly JsonValue[]): Extract<ToolEffect, { kind: "modify" }> {
  const patch = bounded(hunksPatch(hunks))
  return { kind: "modify", path, ...patch !== undefined && { patch } }
}

/** Hunks as objects (`oldStart`, `oldLines`, `newStart`, `newLines`, `lines`) as one unified diff body. */
function hunksPatch(hunks: readonly JsonValue[]): string | undefined {
  let patch = ""
  for (const hunk of hunks) {
    if (!isFields(hunk) || !Array.isArray(hunk["lines"])) return undefined
    const counts = [hunk["oldStart"], hunk["oldLines"], hunk["newStart"], hunk["newLines"]].map(numberOf)
    if (counts.some((count) => count === undefined)) return undefined
    const lines = hunk["lines"].flatMap((line) => isWords(line) ? [line] : [])
    patch += `@@ -${counts[0]},${counts[1]} +${counts[2]},${counts[3]} @@\n${lines.map((line) => `${line}\n`).join("")}`
    if (patch.length > REPORTED_TEXT_LIMIT) return undefined
  }
  return patch || undefined
}

/* ------------------------------------------------------------ patches */

/**
 * The files a patch changes: a unified diff, one effect per `---`/`+++`
 * pair, or Codex's envelope (`*** Update File:`), whose hunks carry no line
 * numbers and so name the file alone. `path` stands for a one-file diff
 * whose header names no usable path.
 */
function patchEffects(patch: string | undefined, path: string | undefined, cwd: string | undefined): ToolEffect[] {
  if (!patch) return []
  if (/^\*\*\* Begin Patch/m.test(patch)) return envelopeEffects(patch, cwd)
  const effects: ToolEffect[] = []
  const files = unifiedFiles(patch)
  for (const file of files) {
    const target = absolutePath(file.to ?? file.from, cwd) ?? (files.length === 1 ? path : undefined)
    if (!target) continue
    const body = bounded(file.body)
    if (file.to === undefined) effects.push({ kind: "delete", path: target })
    else if (file.from === undefined) {
      const content = addedContent(file.body)
      effects.push({ kind: "create", path: target, ...content !== undefined && { content } })
    } else {
      const from = absolutePath(file.from, cwd)
      if (from && from !== target) effects.push({ kind: "rename", from, to: target })
      effects.push({ kind: "modify", path: target, ...body !== undefined && { patch: body } })
    }
  }
  return effects
}

interface UnifiedFile {
  /** The path before and after; undefined for `/dev/null`. */
  from?: string
  to?: string
  body: string
}

/** A unified diff's files, each with its hunks; `diff --git`, `Index:` and `===` lines are left out. */
function unifiedFiles(patch: string): UnifiedFile[] {
  const files: UnifiedFile[] = []
  const lines = patch.split("\n")
  let current: UnifiedFile | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      current = { body: "" }
      const from = headerPath(line.slice(4), "a/")
      const to = headerPath(lines[index + 1]!.slice(4), "b/")
      if (from !== undefined) current.from = from
      if (to !== undefined) current.to = to
      files.push(current)
      index++
      continue
    }
    if (!current) continue
    if (line.startsWith("@@") || (current.body && /^[ +\-\\]/.test(line))) current.body += `${line}\n`
  }
  // A patch without a header is one file's hunks.
  if (!files.length && /^@@ -\d/m.test(patch)) files.push({ from: "", to: "", body: patch.slice(patch.search(/^@@ -\d/m)).replace(/\n?$/, "\n") })
  return files
}

/** A header's path: `/dev/null` is none, Git's `a/`/`b/` prefix and a trailing timestamp go. */
function headerPath(header: string, prefix: string): string | undefined {
  const path = header.replace(/\t.*$/, "").trim()
  if (path === "/dev/null") return undefined
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** A patch's hunks from its first `@@`, without its header; undefined when it has none. */
function patchBody(patch: string | undefined): string | undefined {
  if (!patch) return undefined
  const start = patch.search(/^@@ /m)
  if (start < 0) return undefined
  return bounded(patch.slice(start).replace(/\n?$/, "\n"))
}

/** The content of a file a patch created whole: every line of its one hunk added. */
function addedContent(body: string | undefined): string | undefined {
  if (!body || !/^@@ -[01],0 \+1(?:,\d+)? @@/.test(body)) return undefined
  const lines = body.split("\n").slice(1)
  if (lines.at(-1) === "") lines.pop()
  let content = ""
  for (const line of lines) {
    if (line === "\\ No newline at end of file") content = content.slice(0, -1)
    else if (line.startsWith("+")) content += `${line.slice(1)}\n`
    else return undefined
  }
  return bounded(content)
}

/** Codex's patch envelope: each file it adds, deletes, updates or moves. */
function envelopeEffects(patch: string, cwd: string | undefined): ToolEffect[] {
  const effects: ToolEffect[] = []
  let added: { path: string; content: string } | undefined
  const flush = () => {
    if (added) effects.push({ kind: "create", path: added.path, ...bounded(added.content) !== undefined && { content: added.content } })
    added = undefined
  }
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line)
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (header || move || line.startsWith("*** ")) flush()
    if (header) {
      const path = absolutePath(header[2]!.trim(), cwd)
      if (!path) continue
      if (header[1] === "Add") added = { path, content: "" }
      else effects.push(header[1] === "Delete" ? { kind: "delete", path } : { kind: "modify", path })
    } else if (move) {
      const last = effects.at(-1)
      const to = absolutePath(move[1]!.trim(), cwd)
      if (last?.kind === "modify" && to) effects.splice(-1, 1, { kind: "rename", from: last.path, to }, { kind: "modify", path: to })
    } else if (added && line.startsWith("+")) added.content += `${line.slice(1)}\n`
  }
  flush()
  return effects
}

/* -------------------------------------------------------------- diffs */

/**
 * ACP `diff` content as effects. A diff of the whole file is a patch; one
 * of the text replaced is an edit of those strings. A file the diff shows
 * created is one the call made, and a whole-file diff from empty text a
 * write, since an empty file and no file read the same.
 */
function diffEffects(diffs: readonly ReportedDiff[], reading: Reading, tool: "edit" | "write"): ToolEffect[] {
  const whole = reading.declared.wholeDiffs === true
  const effects: ToolEffect[] = []
  for (const diff of diffs) {
    const path = absolutePath(diff.path, reading.call.cwd)
    if (!path) continue
    if (diff.oldText === null) {
      const content = bounded(diff.newText)
      effects.push({ kind: "create", path, ...content !== undefined && { content } })
    } else if (whole && diff.oldText === "") {
      const content = bounded(diff.newText)
      effects.push({ kind: "write", path, ...content !== undefined && { content } })
    } else if (whole) {
      const patch = bounded(wholePatch(diff.oldText, diff.newText))
      effects.push({ kind: "modify", path, ...patch !== undefined && { patch } })
    } else if (tool === "write" && diff.oldText === "") {
      const content = bounded(diff.newText)
      effects.push({ kind: "write", path, ...content !== undefined && { content } })
    } else {
      const edit = boundedEdit(diff.oldText, diff.newText, false)
      effects.push({ kind: "modify", path, ...edit && { edits: [edit] } })
    }
  }
  return effects
}

const NO_NEWLINE = "\n\\ No newline at end of file"

/** A file's lines; a last line without its newline carries the marker a unified diff writes after it. */
function fileLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  else lines[lines.length - 1] += NO_NEWLINE
  return lines
}

/**
 * The change from `before` to `after` as one hunk: the lines between the
 * first and the last that differ, with three lines of context. Exact, though
 * a change in two distant places is one hunk spanning both. Linear in the
 * file's length; no diff search.
 */
export function wholePatch(before: string, after: string): string | undefined {
  const old = fileLines(before)
  const next = fileLines(after)
  let start = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start++
  let oldEnd = old.length
  let newEnd = next.length
  while (oldEnd > start && newEnd > start && old[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  if (start === oldEnd && start === newEnd) return undefined
  const from = Math.max(0, start - 3)
  const oldTo = Math.min(old.length, oldEnd + 3)
  const newTo = Math.min(next.length, newEnd + 3)
  const range = (begin: number, count: number) => `${count === 0 ? begin : begin + 1},${count}`
  const lines = [
    `@@ -${range(from, oldTo - from)} +${range(from, newTo - from)} @@`,
    ...old.slice(from, start).map((line) => ` ${line}`),
    ...old.slice(start, oldEnd).map((line) => `-${line}`),
    ...next.slice(start, newEnd).map((line) => `+${line}`),
    ...old.slice(oldEnd, oldTo).map((line) => ` ${line}`),
  ]
  return `${lines.join("\n")}\n`
}

/* -------------------------------------------------------------- edits */

type Edit = NonNullable<Extract<ToolEffect, { kind: "modify" }>["edits"]>[number]

/** An edit's strings from its arguments: one edit, or a list under `list`; undefined when none is stated. */
function argumentEdits(keys: NonNullable<EffectReading["edits"]>, reading: Reading): Edit[] | undefined {
  const list = keys.list ? reading.args?.[keys.list] : undefined
  const sources = Array.isArray(list) ? list.filter(isFields) : reading.args ? [reading.args] : []
  const edits: Edit[] = []
  for (const source of sources.slice(0, MAX_EDITS)) {
    const old = text(valueOf(source, keys.old), true)
    const next = text(valueOf(source, keys.new), true)
    if (old === undefined || next === undefined) continue
    const edit = boundedEdit(old, next, keys.all !== undefined && valueOf(source, keys.all) === true)
    // An edit too long to carry leaves the change unstated rather than half stated.
    if (!edit) return []
    edits.push(edit)
  }
  return edits.length ? edits : undefined
}

function boundedEdit(old: string, next: string, all: boolean): Edit | undefined {
  if (old.length + next.length > REPORTED_TEXT_LIMIT) return undefined
  return all ? { old, new: next, all: true } : { old, new: next }
}

/* ------------------------------------------------------------ commands */

function commandEffect(command: string, reading: Reading): ToolEffect {
  const { declared, call } = reading
  const cwd = absolutePath(text(lookup(reading, declared.cwd)), call.cwd) ?? absolutePath(call.cwd, undefined)
  const effect: Extract<ToolEffect, { kind: "command" }> = { kind: "command", command: command.slice(0, MAX_COMMAND) }
  if (cwd) effect.cwd = cwd
  const exitCode = call.exitCode ?? numberOf(lookup(reading, declared.exitCode)) ?? outputExit(call.output, declared)
  if (exitCode !== undefined && Number.isInteger(exitCode)) effect.exitCode = exitCode
  const named = command.length > MAX_PARSED_COMMAND ? [] : namedPaths(command, cwd)
  if (named.length) effect.named = named
  const background = declared.background === true || (declared.background !== undefined && lookup(reading, declared.background) === true)
  if (background) effect.background = true
  return effect
}

function outputExit(output: string | undefined, declared: EffectReading): number | undefined {
  const match = declared.exitText && output ? declared.exitText.exec(output) : null
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** Commands whose operands are all paths they create, change or remove. */
const PATH_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "touch", "mkdir", "tee", "ln", "truncate", "install", "unlink"])
const REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "1>", "1>>", "2>", "2>>"])
const SEPARATORS = new Set([";", "&&", "||", "|", "&", "(", ")", "\n"])
/** Words that run the command after them. */
const PREFIXES = new Set(["sudo", "command", "nohup", "time", "exec", "builtin"])
const DEVICES = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/

/** A word of a command line: its text once quotes are removed, and whether the shell would expand it. */
interface Word {
  text: string
  /** It holds an unquoted variable, substitution, glob or brace, so its path isn't known from the line alone. */
  expands: boolean
  operator?: true
}

/**
 * The paths a command line names as what it writes: redirect targets, the
 * operands of `rm`, `mv`, `cp`, `touch`, `mkdir`, `tee` and their kind, the
 * files of `sed -i` and `perl -i`, and `git rm`/`git mv`. Conservative: a
 * word the shell would expand, a heredoc's body and anything after a `cd`
 * into a folder it can't place are left out, and relative paths need the
 * folder the command ran in.
 */
export function namedPaths(command: string, cwd: string | undefined): string[] {
  const named = new Set<string>()
  let folder = cwd
  const add = (word: Word | undefined) => {
    if (!word || word.expands || word.operator || named.size >= MAX_NAMED || !word.text || DEVICES.test(word.text) || /^&\d$/.test(word.text)) return
    const path = absolutePath(word.text, folder)
    if (path) named.add(path)
  }
  for (const words of simpleCommands(commandWords(command))) {
    const operands: Word[] = []
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!
      if (word.operator && REDIRECTS.has(word.text)) add(words[++index])
      else if (!word.operator) operands.push(word)
    }
    while (operands.length && (/^\w+=/.test(operands[0]!.text) || PREFIXES.has(operands[0]!.text))) operands.shift()
    const [program, ...rest] = operands
    if (!program || program.expands) continue
    const name = program.text.replace(/^.*\//, "")
    if (name === "cd") {
      const target = rest[0]
      folder = target && !target.expands ? absolutePath(target.text, folder) : undefined
      continue
    }
    if (PATH_COMMANDS.has(name)) for (const operand of withoutOptions(rest)) add(operand)
    else if ((name === "sed" || name === "perl") && rest.some((word) => /^-[a-zA-Z]*i/.test(word.text) || word.text.startsWith("--in-place"))) inPlaceFiles(name, rest).forEach(add)
    else if (name === "git" && (rest[0]?.text === "rm" || rest[0]?.text === "mv")) for (const operand of withoutOptions(rest.slice(1))) add(operand)
  }
  return [...named]
}

/** Operands after the options; everything after `--` is an operand. */
function withoutOptions(words: readonly Word[]): Word[] {
  const operands: Word[] = []
  let options = true
  for (const word of words) {
    if (options && word.text === "--") options = false
    else if (!options || !word.text.startsWith("-") || word.text === "-") operands.push(word)
  }
  return operands
}

/** The files `sed -i` or `perl -i` edits: its operands after the script, which `-e` or `-f` may give instead. */
function inPlaceFiles(name: string, words: readonly Word[]): Word[] {
  const operands: Word[] = []
  let script = false
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!.text
    if (word === "-e" || word === "-f" || word === "--expression" || word === "--file") {
      script = true
      index++
    } else if (/^-[a-zA-Z]*[ef]$/.test(word) && name === "perl") {
      script = true
      index++
    } else if (word === "-i" && name === "sed" && /^(?:\.[\w.-]*)?$/.test(words[index + 1]?.text ?? "-")) {
      // BSD sed's `-i ''` or `-i .bak`: the suffix is its own word.
      index++
    } else if (!word.startsWith("-")) operands.push(words[index]!)
  }
  return script ? operands : operands.slice(1)
}

/** Words split into simple commands at `;`, `&&`, `||`, `|`, `&`, parentheses and newlines. */
function simpleCommands(words: readonly Word[]): Word[][] {
  const commands: Word[][] = [[]]
  for (const word of words) {
    if (word.operator && SEPARATORS.has(word.text)) commands.push([])
    else commands.at(-1)!.push(word)
  }
  return commands.filter((words) => words.length)
}

/**
 * A command line's words, the way a POSIX shell splits them: quotes and
 * backslashes removed, operators apart, comments and heredoc bodies left out.
 */
function commandWords(command: string): Word[] {
  const words: Word[] = []
  const heredocs: string[] = []
  let word: Word | undefined
  const end = () => {
    if (word) words.push(word)
    word = undefined
  }
  const extend = (text: string, expands = false) => {
    word ??= { text: "", expands: false }
    word.text += text
    if (expands) word.expands = true
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === "\n") {
      end()
      words.push({ text: "\n", expands: false, operator: true })
      // A heredoc's body runs from the next line to its delimiter.
      while (heredocs.length) {
        const delimiter = heredocs.shift()!
        const close = new RegExp(`^\\t*${escapeRegExp(delimiter)}$`, "m")
        const rest = command.slice(index + 1)
        const found = close.exec(rest)
        index = found ? index + 1 + found.index + found[0].length - 1 : command.length
      }
      continue
    }
    if (char === " " || char === "\t") {
      end()
      continue
    }
    if (char === "\\") {
      if (command[index + 1] === "\n") index++
      else extend(command[++index] ?? "")
      continue
    }
    if (char === "'") {
      const close = command.indexOf("'", index + 1)
      extend(command.slice(index + 1, close < 0 ? command.length : close))
      index = close < 0 ? command.length : close
      continue
    }
    if (char === "\"") {
      let text = ""
      let expands = false
      for (index++; index < command.length && command[index] !== "\""; index++) {
        if (command[index] === "\\" && /["\\$`]/.test(command[index + 1] ?? "")) text += command[++index]
        else {
          if (command[index] === "$" || command[index] === "`") expands = true
          text += command[index]
        }
      }
      extend(text, expands)
      continue
    }
    if (char === "#" && !word) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index++
      continue
    }
    const operator = /^(?:<<-?|&>>|&>|>>|>\||[12]>>|[12]>|&&|\|\||[;&|()<>])/.exec(command.slice(index))?.[0]
    // A digit before `>` belongs to the redirect only as a word of its own (`2>`), never inside one (`a2>b`).
    if (operator && (!word || !/^[12]>/.test(operator))) {
      end()
      if (operator.startsWith("<<")) {
        const delimiter = /^\s*(['"]?)([\w.-]+)\1/.exec(command.slice(index + operator.length))
        if (delimiter) {
          heredocs.push(delimiter[2]!)
          index += operator.length + delimiter[0].length - 1
          continue
        }
      }
      words.push({ text: operator, expands: false, operator: true })
      index += operator.length - 1
      continue
    }
    extend(char, char === "$" || char === "`" || char === "*" || char === "?" || char === "[" || char === "{" || char === "~")
  }
  end()
  return words
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/* -------------------------------------------------------------- values */

/** A path made absolute against `cwd`; undefined for a URL of another scheme, a home-relative path, or a relative one with no folder. */
export function absolutePath(path: string | undefined, cwd: string | undefined): string | undefined {
  let local = path?.trim()
  if (!local) return undefined
  if (local.startsWith("file://")) {
    try {
      local = decodeURIComponent(new URL(local).pathname)
    } catch {
      return undefined
    }
  } else if (/^[a-z][\w+.-]*:/i.test(local) || local.startsWith("~")) return undefined
  if (local.startsWith("/")) return normalized(local)
  return cwd?.startsWith("/") ? normalized(`${cwd}/${local}`) : undefined
}

function normalized(path: string): string {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

/** Keys a declaration gives as one or a list, as a list. */
function keyList(keys: EffectKeys): string[] {
  return [keys].flat()
}

function prefixed(keys: EffectKeys): string[] {
  return keyList(keys).map((key) => key.startsWith("result.") ? key : `result.${key}`)
}

/** The first value the keys name, in the arguments or (`result.…`) the result. */
function lookup(reading: Reading, keys: EffectKeys | undefined): JsonValue | undefined {
  if (keys === undefined) return undefined
  for (const key of keyList(keys)) {
    const value = key.startsWith("result.") ? valueOf(reading.call.result, key.slice("result.".length)) : valueOf(reading.args, key)
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** The value at a dotted key; a list of keys is tried in order. */
function valueOf(source: JsonValue | undefined, keys: EffectKeys): JsonValue | undefined {
  for (const key of keyList(keys)) {
    let value = source
    for (const part of key.split(".")) value = isFields(value) ? value[part] : undefined
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function isFields(value: JsonValue | undefined): value is JsonFields {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isWords(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function parsedArguments(input: string | undefined): JsonFields | undefined {
  if (!input?.trimStart().startsWith("{")) return undefined
  try {
    const parsed = ReportedJson.safeParse(JSON.parse(input))
    return parsed.success && isFields(parsed.data) ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** A string value; an empty one only when `empty` allows it (an edit's replacement can be nothing). */
function text(value: JsonValue | undefined, empty = false): string | undefined {
  return isWords(value) && (empty || value.length > 0) ? value : undefined
}

function numberOf(value: JsonValue | undefined): number | undefined {
  return Object.prototype.toString.call(value) === "[object Number]" && Number.isFinite(value) ? Number(value) : undefined
}

/** Text an effect may carry: undefined when it is longer than the limit. */
function bounded(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= REPORTED_TEXT_LIMIT ? value : undefined
}
