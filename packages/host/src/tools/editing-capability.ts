import type {
  AuthoringChange,
  AuthoringEntry,
  AuthoringOperations,
  AuthoringScope,
  AuthoringSupport,
  AuthoringTrust,
  AuthoringView,
  HookVocabulary,
  NativeAuthoringFamily,
} from "../contracts/native-authoring.js"

/** The existing shared editor owns writes; adapters declare where they apply. */
export interface ProviderEditingCapability {
  provider: string
  route: "mcp-registry" | "skill-registry"
  operations: readonly ("import" | "remove")[]
}

/** What a harness's sources are resolved against: the project, and the harness's own folders as its selected account sees them. */
export interface AuthoringContext {
  cwd: string
  /** The person's home, or a test's. */
  home: string
  /** The environment the harness runs with, where its own home variables live. */
  env: NodeJS.ProcessEnv
  /** The selected account's own folder, when it isn't the harness's default. */
  accountDir?: string
}

/** How a source's text is read and its credentials redacted from a preview. */
export type AuthoringFormat = "json" | "toml" | "markdown" | "text" | "folder"

/** One place a harness reads a family from, resolved for a project. */
export interface AuthoringSourceSpec {
  id: string
  scope: AuthoringScope
  path: string
  /** Writes must stay inside this folder: the project, or the harness's or person's home. */
  root: string
  label: string
  rank: number
  format: AuthoringFormat
  /** For a folder: the file endings of its entries and how deep they nest. */
  entries?: { endings: string[]; depth: number }
  /** Where in the file this source's entries sit, when the file holds more than them (one project's part of `~/.claude.json`). */
  within?: string[]
  /** It holds only which entries are off, by name (Cursor's `mcp-disabled.json`, Grok's `disabled-hooks`), not entries of its own. */
  switches?: true
  writable: AuthoringSupport
  trust?: AuthoringTrust
}

/** A source with what was read from it: a file's text (null when absent), or a folder's files. */
export interface ReadSource {
  spec: AuthoringSourceSpec
  text: string | null
  files: { path: string; text: string }[]
  problem?: string
}

/** What a family's reader found, beside the entries: sources switched off as a whole. */
export interface AuthoringReading {
  entries: AuthoringEntry[]
  off: { sourceId: string; key: string; detail: string }[]
  problems: { sourceId: string; problem: string }[]
}

/** The one file a change writes, and what to. */
export interface AuthoringEdit {
  path: string
  root: string
  scope: AuthoringScope
  format: AuthoringFormat
  before: string | null
  /** Null deletes the file. */
  after: string | null
  summary: string
}

/**
 * A harness's own hooks, commands or MCP servers, read and changed where the
 * harness keeps them. `sources` is the only part that touches the disk;
 * `read` and `change` are pure over what it found, so recorded configs are
 * fixtures.
 */
export interface ProviderAuthoringCapability {
  provider: string
  family: NativeAuthoringFamily
  form: AuthoringView["form"]
  /** What the reading order decides: whether entries merge, and which wins a name. */
  precedence: string
  /**
   * Which entry of a name the harness uses when sources repeat it: every one
   * (`all`, as hooks run), the earliest source in reading order (`first`) or
   * the latest (`last`). Mako marks the others shadowed.
   */
  names: "all" | "first" | "last"
  /** When the harness reads a change. */
  reload: string
  operations: AuthoringOperations
  hooks?: HookVocabulary
  sources(context: AuthoringContext): Promise<AuthoringSourceSpec[]>
  read(sources: readonly ReadSource[]): AuthoringReading
  change(sources: readonly ReadSource[], change: AuthoringChange): AuthoringEdit
}

/** MCP servers: editing entries where the harness keeps them, and whether the registry may copy servers in. */
export interface ProviderMcpEditing extends ProviderAuthoringCapability {
  family: "mcp"
  /** The registry's sync writes into this harness's configuration. */
  imports: boolean
}
