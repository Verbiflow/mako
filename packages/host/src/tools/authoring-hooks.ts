import { z } from "zod"
import type { AuthoringChange, AuthoringDraft, AuthoringEntry, HookFields, HookVocabulary } from "../contracts/native-authoring.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import type { AuthoringEdit, ReadSource } from "./editing-capability.js"
import { insertJsonValue, parseJsonc, parseTomlText, setJsonValue } from "./authoring-text.js"

/**
 * Hook files in the two forms the harnesses use. `grouped` is Claude Code's,
 * which Codex, Grok and Devin read too: each event holds matcher groups, each
 * group its handlers. `flat` is Cursor's: each event holds handlers, each with
 * its own matcher. An entry is one handler, addressed by where it sits.
 */
export interface HookDialect {
  layout: "grouped" | "flat"
  /** Where the event map sits in the file. */
  root: string[]
  /** The key naming a handler's type; null when every handler is a command. */
  typeKey: string | null
  vocabulary: HookVocabulary
  /** What a new file starts with besides its hooks, which alone doesn't make the file worth keeping. */
  scaffold: JsonObject
  /** The file holds nothing but hooks, so it is deleted with its last one. */
  ownsFile: boolean
}

const ObjectSchema = z.record(z.string(), z.json())
const ArraySchema = z.array(z.json())
const asObject = (value: JsonValue | undefined): JsonObject | null => { const parsed = ObjectSchema.safeParse(value); return parsed.success ? parsed.data : null }
const asArray = (value: JsonValue | undefined): JsonValue[] => { const parsed = ArraySchema.safeParse(value); return parsed.success ? parsed.data : [] }
const text = (value: JsonValue | undefined): string | undefined => z.string().safeParse(value).data
const seconds = (value: JsonValue | undefined): number | undefined => z.number().nonnegative().safeParse(value).data

/** Where one handler sits: its source, event, group (grouped only) and position. */
export interface HookAddress {
  sourceId: string
  event: string
  group: number
  handler: number
}

export function hookEntryId(address: HookAddress): string {
  return `${address.sourceId}#${encodeURIComponent(address.event)}/${address.group}/${address.handler}`
}

export function parseHookEntryId(id: string): HookAddress {
  const match = /^(.*)#([^#/]+)\/(\d+)\/(\d+)$/.exec(id)
  if (!match?.[1] || !match[2]) throw new Error("That hook is no longer where it was. Reload and try again.")
  return { sourceId: match[1], event: decodeURIComponent(match[2]), group: Number(match[3]), handler: Number(match[4]) }
}

function runKey(dialect: HookDialect, type: string): string {
  const handler = dialect.vocabulary.handlers.find((entry) => entry.type === type)
  if (!handler) throw new Error(`This harness has no ${type} hooks. Choose one of: ${dialect.vocabulary.handlers.map((entry) => entry.type).join(", ")}.`)
  return handler.run
}

/** The event map of a parsed file, whatever its root. */
function events(dialect: HookDialect, value: JsonValue): JsonObject {
  let current: JsonValue | undefined = value
  for (const key of dialect.root) current = asObject(current)?.[key]
  return asObject(current) ?? {}
}

/** The file's contents as JSON: JSON or JSONC, or TOML for a harness that also reads hooks from its config. */
export function hookDocument(source: ReadSource): JsonValue {
  if (source.text === null) return {}
  return source.spec.format === "toml" ? parseTomlText(source.text, source.spec.path) : parseJsonc(source.text, source.spec.path)
}

function fields(dialect: HookDialect, event: string, matcher: string | undefined, handler: JsonObject): HookFields {
  const type = dialect.typeKey ? text(handler[dialect.typeKey]) ?? "command" : "command"
  const run = dialect.vocabulary.handlers.find((entry) => entry.type === type)?.run ?? "command"
  const known = new Set([dialect.typeKey ?? "", run, "timeout", dialect.layout === "flat" ? "matcher" : ""])
  const result: HookFields = { event, type, run: text(handler[run]) ?? "", other: Object.keys(handler).filter((key) => !known.has(key)) }
  if (matcher !== undefined) result.matcher = matcher
  const timeout = seconds(handler.timeout)
  if (timeout !== undefined) result.timeout = timeout
  return result
}

/** Every handler in one source, in the order the harness runs them. */
export function readHooks(dialect: HookDialect, source: ReadSource, value: JsonValue, enabled: (address: HookAddress, hook: HookFields) => boolean): AuthoringEntry[] {
  const entries: AuthoringEntry[] = []
  for (const [event, list] of Object.entries(events(dialect, value))) {
    asArray(list).forEach((item, group) => {
      const object = asObject(item)
      if (!object) return
      const handlers = dialect.layout === "grouped" ? asArray(object.hooks).map(asObject) : [object]
      const matcher = text(object.matcher)
      handlers.forEach((handler, index) => {
        if (!handler) return
        const address = { sourceId: source.spec.id, event, group, handler: dialect.layout === "grouped" ? index : 0 }
        const hook = fields(dialect, event, matcher, handler)
        entries.push({ id: hookEntryId(address), sourceId: source.spec.id, name: `${event}${matcher ? ` · ${matcher}` : ""}`, enabled: enabled(address, hook), hook })
      })
    })
  }
  return entries
}

function validDraft(dialect: HookDialect, draft: AuthoringDraft): Extract<AuthoringDraft, { kind: "hook" }> {
  if (draft.kind !== "hook") throw new Error("A hook needs an event and what it runs.")
  if (!dialect.vocabulary.events.includes(draft.event)) throw new Error(`${draft.event} isn't an event this harness fires. Choose one of: ${dialect.vocabulary.events.join(", ")}.`)
  if (!draft.run.trim()) throw new Error("Say what the hook runs.")
  if (draft.matcher && !dialect.vocabulary.matcher) throw new Error("This harness's hooks have no matcher.")
  if (draft.timeout !== undefined && !(draft.timeout > 0 && draft.timeout <= 86_400)) throw new Error("A timeout is a number of seconds, up to a day.")
  runKey(dialect, draft.type)
  return draft
}

function handlerFor(dialect: HookDialect, draft: Extract<AuthoringDraft, { kind: "hook" }>): JsonObject {
  const handler: JsonObject = {}
  if (dialect.typeKey) handler[dialect.typeKey] = draft.type
  handler[runKey(dialect, draft.type)] = draft.run
  if (draft.timeout !== undefined) handler.timeout = draft.timeout
  if (dialect.layout === "flat" && draft.matcher) handler.matcher = draft.matcher
  return handler
}

/** A new handler at the end of its event, so no existing one moves. */
function appendHook(dialect: HookDialect, before: string, value: JsonValue, draft: Extract<AuthoringDraft, { kind: "hook" }>): string {
  let next = before
  for (const [key, scaffold] of Object.entries(dialect.scaffold)) if (asObject(value)?.[key] === undefined) next = setJsonValue(next, [key], scaffold)
  const list = asArray(events(dialect, value)[draft.event])
  const handler = handlerFor(dialect, draft)
  let item = handler
  if (dialect.layout === "grouped") {
    item = { hooks: [handler] }
    if (draft.matcher) item = { matcher: draft.matcher, hooks: [handler] }
  }
  if (!list.length) return setJsonValue(next, [...dialect.root, draft.event], [item])
  return insertJsonValue(next, [...dialect.root, draft.event], list.length, item)
}

/** One handler removed, then its group, its event and the hooks object when each is left empty. */
function removeHook(dialect: HookDialect, before: string, value: JsonValue, address: HookAddress): string | null {
  const list = asArray(events(dialect, value)[address.event])
  const group = asObject(list[address.group])
  const eventPath = [...dialect.root, address.event]
  let next: string
  if (dialect.layout === "grouped" && asArray(group?.hooks).length > 1) next = setJsonValue(before, [...eventPath, address.group, "hooks", address.handler], undefined)
  else if (list.length > 1) next = setJsonValue(before, [...eventPath, address.group], undefined)
  else next = setJsonValue(before, eventPath, undefined)
  const after = parseJsonc(next, "the edited file")
  if (!Object.keys(events(dialect, after)).length && dialect.root.length) next = setJsonValue(next, dialect.root, undefined)
  const left = asObject(parseJsonc(next, "the edited file")) ?? {}
  if (dialect.ownsFile && Object.keys(left).every((key) => key in dialect.scaffold)) return null
  return next
}

/** The handler's own keys set from the draft; keys Mako doesn't edit stay as they are. */
function editHook(dialect: HookDialect, before: string, value: JsonValue, address: HookAddress, draft: Extract<AuthoringDraft, { kind: "hook" }>): string {
  const list = asArray(events(dialect, value)[address.event])
  const group = asObject(list[address.group])
  if (!group) throw new Error("That hook is no longer in the file. Reload and try again.")
  const handler = dialect.layout === "grouped" ? asObject(asArray(group.hooks)[address.handler]) : group
  if (!handler) throw new Error("That hook is no longer in the file. Reload and try again.")
  const current = fields(dialect, address.event, text(group.matcher), handler)
  const sharesGroup = dialect.layout === "grouped" && asArray(group.hooks).length > 1
  if (draft.event !== address.event || ((draft.matcher ?? "") !== (current.matcher ?? "") && sharesGroup)) {
    const removed = removeHook({ ...dialect, ownsFile: false }, before, value, address) ?? before
    const merged = { ...handler, ...handlerFor(dialect, draft) }
    if (draft.timeout === undefined) delete merged.timeout
    const moved = appendHook(dialect, removed, parseJsonc(removed, "the edited file"), draft)
    const index = asArray(events(dialect, parseJsonc(moved, "the edited file"))[draft.event]).length - 1
    return setJsonValue(moved, dialect.layout === "grouped" ? [...dialect.root, draft.event, index, "hooks", 0] : [...dialect.root, draft.event, index], merged)
  }
  const path = dialect.layout === "grouped" ? [...dialect.root, address.event, address.group, "hooks", address.handler] : [...dialect.root, address.event, address.group]
  let next = before
  if (dialect.typeKey) next = setJsonValue(next, [...path, dialect.typeKey], draft.type)
  const oldRun = runKey(dialect, current.type)
  const newRun = runKey(dialect, draft.type)
  if (oldRun !== newRun) next = setJsonValue(next, [...path, oldRun], undefined)
  next = setJsonValue(next, [...path, newRun], draft.run)
  next = setJsonValue(next, [...path, "timeout"], draft.timeout)
  if (dialect.layout === "grouped") next = setJsonValue(next, [...dialect.root, address.event, address.group, "matcher"], draft.matcher || undefined)
  else next = setJsonValue(next, [...path, "matcher"], draft.matcher || undefined)
  return next
}

/** A hook file's edit for a create, edit or remove; turning one off is the harness's own business, declared beside this. */
export function hookFileEdit(dialect: HookDialect, source: ReadSource, change: AuthoringChange): AuthoringEdit {
  if (source.problem) throw new Error(source.problem)
  if (!source.spec.writable.supported) throw new Error(source.spec.writable.reason)
  const before = source.text ?? ""
  const value = hookDocument(source)
  let after: string | null
  let summary: string
  if (change.kind === "create") {
    const draft = validDraft(dialect, change.draft)
    after = appendHook(dialect, before, value, draft)
    summary = `Add a ${draft.event} hook to ${source.spec.label}`
  } else if (change.kind === "edit") {
    const draft = validDraft(dialect, change.draft)
    after = editHook(dialect, before, value, parseHookEntryId(change.entryId), draft)
    summary = `Change a ${draft.event} hook in ${source.spec.label}`
  } else if (change.kind === "remove") {
    const address = parseHookEntryId(change.entryId)
    after = removeHook(dialect, before, value, address)
    summary = `Remove a ${address.event} hook from ${source.spec.label}${after === null ? ", and the file with it" : ""}`
  } else throw new Error("This harness turns hooks off in another file.")
  return { path: source.spec.path, root: source.spec.root, scope: source.spec.scope, format: source.spec.format, before: source.text, after, summary }
}
