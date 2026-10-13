import { z } from "zod"

/**
 * Each harness's own hooks, commands and MCP servers, as Mako reads and
 * edits them in the files the harness reads. Nothing here runs a hook or
 * starts a server; a change is previewed as a diff of the one file it
 * writes, then applied only if that file is still what the preview read.
 */
export const NativeAuthoringFamilySchema = z.enum(["hooks", "commands", "mcp"])
export type NativeAuthoringFamily = z.infer<typeof NativeAuthoringFamilySchema>

/**
 * Where a source sits: every project (`user`), this project and everyone
 * who clones it (`project`), this project on this Mac only (`local`), set by
 * an administrator (`managed`), or another harness's file this one also
 * reads (`imported`).
 */
export const AuthoringScopeSchema = z.enum(["user", "project", "local", "managed", "imported"])
export type AuthoringScope = z.infer<typeof AuthoringScopeSchema>

/** An operation Mako can do here, or the reason it can't, in the harness's terms. */
export type AuthoringSupport = { supported: true } | { supported: false; reason: string }

export interface AuthoringOperations {
  create: AuthoringSupport
  edit: AuthoringSupport
  /** Turning one entry off and on again without deleting it. */
  disable: AuthoringSupport
  remove: AuthoringSupport
  /** Recording the person's trust in one entry, where the harness runs nothing it hasn't been told to trust. */
  trust: AuthoringSupport
}

/** Whether the harness reads a project source: once the person trusts the folder, or in any folder (`unasked`). */
export interface AuthoringTrust {
  state: "trusted" | "untrusted" | "unasked"
  /** What the harness does with the file in this state, and where the person trusts it. */
  detail: string
}

/** One file the harness reads entries of this family from. */
export interface AuthoringSource {
  /** Stable while the file stays where it is. */
  id: string
  scope: AuthoringScope
  /** A file, or the folder a harness reads one file per entry from. */
  path: string
  label: string
  /** The order the harness reads sources in: 0 first. What that order decides is the view's `precedence`. */
  rank: number
  exists: boolean
  writable: AuthoringSupport
  trust?: AuthoringTrust
  /** The harness ignores every entry of this source: a switch in the source itself turned them all off. */
  off?: { key: string; detail: string }
  /** What stopped Mako reading it: invalid syntax, too large, a link out of its folder. Nothing is written to a source with a problem. */
  problem?: string
  /** It holds only which entries are off, by name, not entries of its own. */
  switches?: true
}

/** A hook as its harness declares it: what fires it, and what it runs. */
export interface HookFields {
  event: string
  /** Which tools or sources the event must match; absent matches everything. */
  matcher?: string
  type: string
  /** The command, URL or prompt, by the handler's type. */
  run: string
  /** Seconds. */
  timeout?: number
  /** Keys the harness reads that Mako doesn't edit, kept as they are. */
  other: string[]
}

export interface CommandFields {
  /** What the person types after `/`. */
  invocation: string
  description?: string
  /** The whole native text: frontmatter and body for a file, the template for a config entry. */
  text: string
}

export interface McpFields {
  transport: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  url?: string
  /** Names only; values never leave the host. */
  envNames: string[]
  headerNames: string[]
}

/** Whether the harness will run an entry it asks to be trusted one by one. */
export interface EntryTrust {
  state: "trusted" | "untrusted" | "modified" | "managed"
  detail: string
}

export interface AuthoringEntry {
  id: string
  sourceId: string
  name: string
  enabled: boolean
  trust?: EntryTrust
  /** The entry of the same name the harness uses instead, by its id. */
  shadowedBy?: string
  hook?: HookFields
  command?: CommandFields
  mcp?: McpFields
  /** A code file the harness loads whole: an OpenCode plugin. */
  module?: { text: string }
}

/** The form a hook takes in this harness, for the editor. */
export interface HookVocabulary {
  events: string[]
  /** Handler types and the field each one runs. */
  handlers: { type: string; run: "command" | "url" | "prompt" | "tool" }[]
  matcher: boolean
  /** The events that read a matcher, when not all of them do. */
  matchers?: string[]
}

/** One harness's entries of one family, every source it reads, in its order. */
export interface AuthoringView {
  provider: string
  family: NativeAuthoringFamily
  label: string
  /** Why Mako can't show this family for this harness at all. */
  absent?: { by: "harness" | "mako"; reason: string }
  operations: AuthoringOperations
  /** What an entry is, so the editor shows the right form. */
  form: "hook" | "command" | "mcp" | "module"
  /** What the reading order decides, in one sentence: whether entries merge, and which wins a name. */
  precedence: string
  /** When the harness reads a change. */
  reload: string
  hooks?: HookVocabulary
  sources: AuthoringSource[]
  entries: AuthoringEntry[]
}

export interface AuthoringCatalog {
  cwd: string
  views: AuthoringView[]
}

export interface AuthoringTarget {
  provider: string
  family: NativeAuthoringFamily
  cwd: string
}

/** A hook or command as the editor submits it. Unknown keys of an edited entry stay as they are. */
export type AuthoringDraft =
  | { kind: "hook"; event: string; matcher?: string; type: string; run: string; timeout?: number }
  | { kind: "command"; invocation: string; text: string }
  | { kind: "module"; name: string; text: string }

export type AuthoringChange =
  | { kind: "create"; sourceId: string; draft: AuthoringDraft }
  | { kind: "edit"; entryId: string; draft: AuthoringDraft }
  | { kind: "enable"; entryId: string; enabled: boolean }
  | { kind: "remove"; entryId: string }
  | { kind: "trust"; entryId: string }

export interface AuthoringDiffLine {
  kind: "context" | "add" | "remove"
  text: string
  before?: number
  after?: number
}

/** What applying a change would write, read now. Credentials in the file are redacted from `lines`. */
export interface AuthoringPlan {
  target: AuthoringTarget
  change: AuthoringChange
  path: string
  scope: AuthoringScope
  /** One sentence: what changes, and where. */
  summary: string
  /** The file as the preview read it; apply refuses if it changed since. Null when the file doesn't exist yet. */
  revision: string | null
  /** `unchanged` when the file already says what the change asks: applying it writes nothing. */
  effect: "create-file" | "edit-file" | "delete-file" | "unchanged"
  lines: AuthoringDiffLine[]
  /** Whether the file as it was is copied into Mako's backups before the write. */
  backup: boolean
}

export interface AuthoringApplied {
  plan: AuthoringPlan
  /** The copy of the file as it was, when there was one. */
  backup: string | null
  view: AuthoringView
}
