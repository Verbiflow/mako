import type { ToolKind } from "../tool-identity.js"

/**
 * What one harness calls things, declared once: every built-in tool by its
 * exact native name, the other names the same tool goes by in the harness's
 * stores or older versions, and how it names an MCP server's tools.
 *
 * The live decoder, the saved-history readers, the window and the audits all
 * read a harness's tools through this, so a renamed or added tool is one
 * line here. Each declaration says what it was last checked against; when
 * the harness reports or records a tool it doesn't declare, the host logs it
 * (`native event not handled`, kind `tool <name>`) and `audit:tools` lists it.
 */
export interface HarnessVocabulary<Tool extends string = string> {
  harness: string
  /** The native version these names were last checked against, when, and from what. */
  checked: { version: string; on: string; against: string }
  tools: { readonly [Name in Tool]: NativeTool }
  /** How the harness names tool `t` on MCP server `s`, besides Mako's own `mcp__s__t`. */
  mcp: readonly McpNaming[]
  concepts: HarnessConcepts
}

/**
 * A path the harness reads. `~/…` is under the home directory; anything else
 * is relative to a project directory, walked as `instructions.order` says.
 */
export type ConceptPath = string

/**
 * What a harness reads and reports beyond its tools, from its own types,
 * docs and binary. `npm run harness:self-report -- <harness>` probes the
 * installed build for the file names and hook events declared here, and
 * `npm run harness:concepts` generates the concept-by-harness reference from
 * these and the live drivers. A folder Mako writes into for a harness must be
 * one the harness reads (`test-harness-concepts.ts`).
 */
export interface HarnessConcepts {
  checked: { version: string; on: string; against: string }
  instructions: {
    /** Names looked for in each project directory. */
    files: readonly string[]
    /** Folders of rule files, in each project directory. */
    rules: readonly ConceptPath[]
    /** Files and folders read for every project. */
    user: readonly ConceptPath[]
    /** Which directories load and in what order. */
    order: string
  }
  hooks: {
    config: readonly ConceptPath[]
    events: readonly string[]
    /** The event names are built at run time, so the binary can't be searched for them. */
    composed?: true
    control: string
  } | ConceptAbsent
  skills: readonly ConceptPath[]
  commands: { folders: readonly ConceptPath[]; note?: string } | ConceptAbsent
  agents: readonly ConceptPath[]
  mcpConfig: readonly ConceptPath[]
  output: {
    /** The protocol Mako drives it over. */
    live: string
    /** Output formats of a one-shot run. */
    headless: readonly string[]
    /** Where and how it keeps its sessions. */
    store: string
  }
  /** How its model catalog is read. */
  models: string
  /** What only this harness has, with what carries it. */
  distinct: readonly { name: string; via: string }[]
}

export interface ConceptAbsent {
  absent: string
}

export interface NativeTool {
  kind: ToolKind
  label?: string
  keys?: FieldKeys
  wraps?: ArgumentWrapper | ScriptWrapper
  /** The same tool under other names: another surface's store, or an older version. */
  aliases?: readonly string[]
  /**
   * Why the harness's newest recorded definitions (scripts/fixtures/native-tools)
   * don't carry this tool, which then still decodes from older stores or other setups.
   */
  unlisted?: string
}

/**
 * `s__t` is Grok's, `s.t` Codex's and Devin's saved form, `s: t` Codex's live
 * form, and `s-t` Cursor's stores, where the tool is everything after the
 * last hyphen.
 */
export type McpNaming = "s__t" | "s.t" | "s: t" | "s-t"

export type ToolField = "path" | "command" | "pattern" | "query" | "url" | "description" | "prompt" | "code"

export type FieldKeys = { readonly [Name in ToolField]?: readonly string[] }

/** Another tool runs inside this one, named and argued by these keys. */
export interface ArgumentWrapper {
  form: "arguments"
  tool: string
  args: string
  server?: string
  /** A server name that means the harness's own built-in tools. */
  builtin?: string
  /** This native projection retains the exact server/tool title when input is clipped. */
  titleRoute?: true
}

/** A script calls the real tools; the script is under `key`, or is the whole input. */
export interface ScriptWrapper {
  form: "script"
  key?: string
  /**
   * Each call the script makes draws as its own row, so a row of the script
   * is the script itself, named by what it ran, never a second row for one
   * of its calls.
   */
  callsShown?: true
}

/** Keeps a declaration's tool names as literal keys, so a harness SDK's own tool list can be checked against them. */
export function defineVocabulary<const Tool extends string>(vocabulary: HarnessVocabulary<Tool>): HarnessVocabulary<Tool> {
  return vocabulary
}
