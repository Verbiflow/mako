/**
 * How well the transcript's file links land, on this Mac's own sessions.
 *
 * Reads Claude Code, Codex and Cursor session records (read-only), parses
 * each assistant message with the renderer's own Markdown plugins, and
 * resolves every file link with Mako's own resolver (`resolveSpelling`), and
 * as a click against the conversation's folder resolved it before. What the
 * agent meant is judged apart from both, from the files its own tool calls
 * touched in that session: a reference naming exactly one of them meant that
 * one, followed to where it is now.
 *
 *   tsx scripts/audit-file-references.ts [--days 30] [--sessions 200] [--out file.json]
 *
 * Holds no data; everything it prints comes from the local stores at run time.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import type { InlineCode, Link } from "mdast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { visit } from "unist-util-visit"
import { z } from "zod"
import type { FileResolution, Touch } from "@mako/host/contracts/file-references"
import { RENAME_LOG, RenameHistory, resolveSpelling, SuffixIndex, type Place, type ReferenceContext } from "@mako/host/files/index"
import { remarkFileCitations } from "../src/lib/citation-markdown"
import { markdownFileTarget } from "../src/lib/file-citations"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const DAYS = Number(option("--days") ?? 30)
const SESSIONS = Number(option("--sessions") ?? 200)
const OUT = option("--out")
const home = homedir()
const since = Date.now() - DAYS * 86_400_000

interface Message {
  text: string
  /** The folder the session was in when it wrote this. */
  cwd: string
  /** Files its tool calls touched, over the whole session, each with when. */
  touched: Touches
  /** How many touches came by the end of its turn, so the resolver sees only those, as the host does a finished answer. */
  seq: number
  /** Folders its tool calls ran in, oldest first, over the whole session. */
  workdirs: string[]
}
/** A session's touched files, and the order of each file's touches. */
class Touches extends Set<string> {
  seq = 0
  readonly order = new Map<string, number[]>()
  override add(path: string): this {
    this.seq++
    const list = this.order.get(path)
    if (list) list.push(this.seq)
    else this.order.set(path, [this.seq])
    return super.add(path)
  }
}
/** A turn ended: its messages see the touches made by then. */
function endTurn(messages: Message[], from: number, touched: Touches): number {
  for (let i = from; i < messages.length; i++) messages[i]!.seq = touched.seq
  return messages.length
}
interface Session {
  harness: "claude" | "codex" | "cursor"
  file: string
  /** The folder Mako resolves the conversation's relative links against. */
  workspace: string
  messages: Message[]
}

/* ------------------------------------------------------------- sessions */

function newest(folder: string, match: (name: string) => boolean, depth = 4): string[] {
  const out: { path: string; at: number }[] = []
  const walk = (dir: string, level: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (level < depth && entry.name !== "subagents") walk(path, level + 1)
      } else if (match(entry.name)) {
        const at = statSync(path).mtimeMs
        if (at >= since) out.push({ path, at })
      }
    }
  }
  walk(folder, 0)
  return out.sort((a, b) => b.at - a.at).map((item) => item.path)
}

const ranIn = (workdirs: string[], dir: string) => {
  if (workdirs.at(-1) === dir) return
  const at = workdirs.indexOf(dir)
  if (at >= 0) workdirs.splice(at, 1)
  workdirs.push(dir)
}
const cdIn = (command: string, cwd: string) => {
  const cd = /(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1]?.replace(/^["']|["']$/g, "")
  return cd ? resolve(cwd, cd.replace(/^~(?=\/)/, home)) : cwd
}

const PATH_TOKEN = /(?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,10}\b/g
/** Paths a tool input names: absolute ones, and relative ones with a folder and an extension. */
function pathsIn(text: string, cwd: string): string[] {
  const out: string[] = []
  const base = cdIn(text, cwd)
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[0]
    if (/^\w+:\/\//.test(text.slice(Math.max(0, match.index - 8), match.index + 3))) continue
    out.push(token.startsWith("~/") ? join(home, token.slice(2)) : isAbsolute(token) ? token : resolve(base, token))
  }
  return out
}

/** A JSON Lines file's records that match `schema`; `keep` skips lines cheaply before parsing. */
function records<T extends z.ZodType>(file: string, schema: T, keep: (line: string) => boolean = () => true): z.infer<T>[] {
  const out: z.infer<T>[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || !keep(line)) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = schema.safeParse(value)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

const ToolInput = z.object({
  file_path: z.string(),
  notebook_path: z.string(),
  path: z.string(),
  target_notebook: z.string(),
  target_directory: z.string(),
  command: z.string(),
  working_directory: z.string(),
}).partial()
const TextBlock = z.object({ type: z.literal("text"), text: z.string() })
const ToolBlock = z.object({ type: z.literal("tool_use"), input: ToolInput.catch({}) })
const Blocks = z.array(z.union([TextBlock, ToolBlock, z.object({ type: z.string() })]))
const ClaudeRecord = z.object({ type: z.literal("assistant"), isSidechain: z.boolean().optional(), cwd: z.string(), message: z.object({ content: Blocks.catch([]) }) })
/** A person's prompt, not a tool's result, which Claude Code also records as the user's. */
const ClaudePrompt = z.object({
  type: z.literal("user"),
  isSidechain: z.boolean().optional(),
  message: z.object({ content: z.union([z.string(), z.array(z.object({ type: z.string() })).refine((blocks) => !blocks.some((block) => block.type === "tool_result"))]) }),
})
const CursorRecord = z.union([z.object({ role: z.literal("assistant"), message: z.object({ content: Blocks.catch([]) }) }), z.object({ role: z.literal("user") })])
const CodexRecord = z.union([
  z.object({ type: z.enum(["session_meta", "turn_context"]), payload: z.object({ cwd: z.string() }) }),
  z.object({
    type: z.literal("response_item"),
    payload: z.union([
      z.object({ type: z.literal("function_call"), arguments: z.string() }),
      z.object({ type: z.literal("custom_tool_call"), input: z.string() }),
      z.object({ type: z.literal("message"), role: z.literal("assistant"), content: z.array(z.object({ text: z.string().optional() })) }),
      z.object({ type: z.literal("message"), role: z.literal("user") }),
    ]),
  }),
])
const CodexArguments = z.object({ workdir: z.string() }).partial()

/** Files and folders a tool call names, from the folder it ran in. */
function noteCall(input: z.infer<typeof ToolInput>, base: string, cwd: string, touched: Touches, workdirs: string[]) {
  for (const path of [input.file_path, input.notebook_path, input.path, input.target_notebook, input.target_directory]) if (path) touched.add(resolve(base, path))
  if (!input.command) return
  ranIn(workdirs, cdIn(input.command, cwd))
  for (const path of pathsIn(input.command, cwd)) touched.add(path)
}

function claudeSession(file: string): Session | null {
  const messages: Message[] = []
  const touched = new Touches()
  const workdirs: string[] = []
  let workspace: string | undefined
  let turn = 0
  for (const record of records(file, z.union([ClaudeRecord, ClaudePrompt]), (line) => line.includes('"assistant"') || line.includes('"user"'))) {
    if (record.isSidechain) continue
    if (record.type === "user") {
      turn = endTurn(messages, turn, touched)
      continue
    }
    workspace ??= record.cwd
    for (const block of record.message.content) {
      if ("input" in block) noteCall(block.input, record.cwd, record.cwd, touched, workdirs)
      else if ("text" in block && block.text.length > 20) messages.push({ text: block.text, cwd: record.cwd, touched, seq: touched.seq, workdirs })
    }
  }
  endTurn(messages, turn, touched)
  return workspace && messages.length ? { harness: "claude", file, workspace, messages } : null
}

/** A Cursor project folder's name back to the folder: its dashes are slashes, except where a real folder's name holds them. */
function cursorWorkspace(name: string): string | undefined {
  const parts = name.split("-")
  let path = ""
  let at = 0
  while (at < parts.length) {
    let end = parts.length
    while (end > at && !existsSync(`${path}/${parts.slice(at, end).join("-")}`)) end--
    if (end === at) return undefined
    path = `${path}/${parts.slice(at, end).join("-")}`
    at = end
  }
  return path
}

function cursorSession(file: string): Session | null {
  const workspace = cursorWorkspace(/\/projects\/([^/]+)\/agent-transcripts\//.exec(file)?.[1] ?? "")
  if (!workspace) return null
  const messages: Message[] = []
  const touched = new Touches()
  const workdirs: string[] = []
  let turn = 0
  for (const record of records(file, CursorRecord)) {
    if (record.role === "user") {
      turn = endTurn(messages, turn, touched)
      continue
    }
    for (const block of record.message.content) {
      if ("input" in block) noteCall(block.input, workspace, block.input.working_directory ?? workspace, touched, workdirs)
      else if ("text" in block && block.text.length > 20) messages.push({ text: block.text, cwd: workspace, touched, seq: touched.seq, workdirs })
    }
  }
  endTurn(messages, turn, touched)
  return messages.length ? { harness: "cursor", file, workspace, messages } : null
}

function codexSession(file: string): Session | null {
  const messages: Message[] = []
  const touched = new Touches()
  const workdirs: string[] = []
  let workspace: string | undefined
  let cwd: string | undefined
  let turn = 0
  for (const record of records(file, CodexRecord)) {
    if (record.type !== "response_item") {
      cwd = record.payload.cwd
      workspace ??= cwd
      continue
    }
    const payload = record.payload
    if (!cwd) continue
    if (payload.type === "message" && payload.role === "user") {
      turn = endTurn(messages, turn, touched)
      continue
    }
    if (payload.type === "message") {
      const text = payload.content.map((part) => part.text ?? "").join("")
      if (text.length > 20) messages.push({ text, cwd, touched, seq: touched.seq, workdirs })
      continue
    }
    const input = payload.type === "function_call" ? payload.arguments : payload.input
    let workdir = cwd
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      // Code mode passes JavaScript, not JSON.
    }
    const named = CodexArguments.safeParse(parsed).data?.workdir ?? /\bworkdir\s*:\s*["'`]([^"'`]+)["'`]/.exec(input)?.[1]
    if (named) workdir = resolve(cwd, named)
    const decoded = input.replaceAll("\\n", "\n").replaceAll('\\"', '"')
    ranIn(workdirs, cdIn(/"(?:cmd|command)"\s*:\s*"([^"]*)"/.exec(input)?.[1] ?? /\bcmd\s*:\s*["'`]([^"'`]*)/.exec(input)?.[1] ?? "", workdir))
    for (const header of decoded.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)|\*\*\* Move to: (.+)/g)) touched.add(resolve(workdir, (header[1] ?? header[2])!.trim()))
    for (const path of pathsIn(decoded, workdir)) touched.add(path)
  }
  endTurn(messages, turn, touched)
  return workspace && messages.length ? { harness: "codex", file, workspace, messages } : null
}

/* ------------------------------------------------------- the renderer */

interface Reference {
  /** `link`: the agent wrote a Markdown link; `inline`: inline code the renderer turned into one; `citation`: a harness's citation syntax, a code fence's `start:end:path` among them. */
  how: "link" | "inline" | "citation"
  raw: string
  path: string
}
interface MessageReferences {
  linked: Reference[]
  /** Inline code that reads as a file name but the renderer left as text. */
  unlinked: string[]
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFileCitations)
function references(text: string): MessageReferences {
  // The plugins change the tree in place.
  const tree = parser.parse(text)
  parser.runSync(tree)
  const linked: Reference[] = []
  const inLink = new Set<InlineCode>()
  visit(tree, "link", (node: Link) => {
    const target = markdownFileTarget(node.url)
    if (!target) return
    const only = node.children.length === 1 ? node.children[0] : undefined
    if (only?.type === "inlineCode") inLink.add(only)
    const fence = only?.type === "text" && /:\d+–\d+$/.test(only.value) && /#L\d+-L\d+$/.test(node.url)
    const how = node.url.startsWith("mako-citation:") || fence ? "citation" : only?.type === "inlineCode" && only.value === node.url ? "inline" : "link"
    linked.push({ how, raw: node.url, path: target.path })
  })
  const unlinked: string[] = []
  visit(tree, "inlineCode", (node: InlineCode) => {
    if (inLink.has(node)) return
    if (/^[\w@~./-]*[\w@-]\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?:-\d+)?)?$/.test(node.value) && !/^\d/.test(node.value) && !/^[\w-]+\.(?:com|org|io|dev|net|co|ai)$/.test(node.value))
      unlinked.push(node.value.replace(/:\d+(?:-\d+)?$/, ""))
  })
  return { linked, unlinked }
}

/* ----------------------------------------------------------- the host */

const exists = (path: string) => existsSync(path)
const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const listings = new Map<string, { root: string; files: string[] }>()
const roots = new Map<string, string | null>()
function gitRoot(cwd: string): string | null {
  let found = roots.get(cwd)
  if (found !== undefined) return found
  try {
    found = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    found = null
  }
  roots.set(cwd, found)
  return found
}
function lsFiles(root: string): string[] {
  try {
    return execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean)
  } catch {
    return []
  }
}
const WALK_SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "Pods", "venv", "__pycache__"])
/** The host's file list for a conversation's folder: the repository's files, or `walkWorkspace` over a plain folder. */
function listing(cwd: string): { root: string; files: string[] } {
  let found = listings.get(cwd)
  if (found) return found
  const root = gitRoot(cwd)
  if (root) found = { root, files: lsFiles(root) }
  else {
    const files: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || files.length > 20_000) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      if (depth > 0 && entries.some((entry) => entry.name === ".git")) {
        for (const path of lsFiles(dir)) files.push(relative(cwd, join(dir, path)))
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue
        if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
        else if (entry.isFile()) files.push(relative(cwd, join(dir, entry.name)))
      }
    }
    if (exists(cwd)) walk(cwd, 0)
    found = { root: cwd, files }
  }
  listings.set(cwd, found)
  return found
}

type Resolved = { found: string } | { none: true } | { many: number }
/** `WorkspaceFiles.locate` with `relativeTo: "cwd"`, as `ConversationFiles.read` calls it. */
function hostResolve(workspace: string, requested: string): Resolved {
  const absolute = isAbsolute(requested) || requested.startsWith("~/")
    ? real(requested.startsWith("~/") ? join(home, requested.slice(2)) : requested)
    : real(resolve(workspace, requested))
  if (exists(absolute)) return { found: absolute }
  if (isAbsolute(requested) || requested.startsWith("~/") || requested.startsWith("./") || requested.startsWith("../")) return { none: true }
  const wanted = requested.replaceAll("\\", "/").replace(/^\.\//, "")
  const { root, files } = listing(workspace)
  const matches = files.filter((path) => path === wanted || path.endsWith(`/${wanted}`))
  if (matches.length === 1) return { found: real(resolve(root, matches[0]!)) }
  return matches.length ? { many: matches.length } : { none: true }
}

/** Where a relative path could sit: from the message's folder, each folder the session's calls ran in (latest first), then the conversation's. */
const basesOf = (message: Message, workspace: string) => [...new Set([message.cwd, ...message.workdirs.slice(-8).reverse(), workspace])]
const expand = (path: string) => (path.startsWith("~/") ? join(home, path.slice(2)) : path)
const candidatesOf = (message: Message, workspace: string, path: string) =>
  isAbsolute(expand(path)) ? [expand(path)] : basesOf(message, workspace).map((base) => resolve(base, path))

/** The touched file a reference names: by its path from a folder the session worked in, else by its trailing segments. */
function intended(message: Message, workspace: string, path: string): string[] {
  const direct = candidatesOf(message, workspace, path).filter((candidate) => message.touched.has(candidate))
  if (direct.length) return direct.slice(0, 1)
  const tail = expand(path).replace(/^(?:\.\.?\/)+/, "")
  if (!tail.includes("/") && !/\.[A-Za-z0-9]+$/.test(tail)) return []
  return [...message.touched].filter((file) => file === tail || file.endsWith(`/${tail}`))
}

const history = new Map<string, { renamed: Map<string, string>; deleted: Set<string> }>()
/** Every rename and deletion a repository's history holds, newest first. */
function historyOf(root: string) {
  let found = history.get(root)
  if (found) return found
  found = { renamed: new Map(), deleted: new Set() }
  try {
    const log = execFileSync("git", ["-C", root, "log", "--all", "-M", "--format=", "--name-status", "--diff-filter=RD"], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] })
    for (const line of log.split("\n")) {
      const [status, from, to] = line.split("\t")
      if (status?.startsWith("R") && from && to && !found.renamed.has(from)) found.renamed.set(from, to)
      else if (status === "D" && from) found.deleted.add(from)
    }
  } catch {
    // Not a repository Git can read.
  }
  history.set(root, found)
  return found
}
interface Fate {
  fate: "renamed-since" | "renamed-then-deleted" | "deleted-since" | "never-there"
  /** A renamed file's path now. */
  now?: string
}
/** What became of a path its repository once had: renamed (to a file that's there now), deleted, or never there. */
function followed(path: string): Fate {
  let dir = path
  while (dir !== "/" && !existsSync(dir)) dir = resolve(dir, "..")
  const root = gitRoot(dir)
  if (!root) return { fate: "never-there" }
  const { renamed, deleted } = historyOf(root)
  let at = relative(root, path)
  const seen = new Set<string>()
  while (renamed.has(at) && !seen.has(at)) {
    seen.add(at)
    at = renamed.get(at)!
  }
  if (seen.size) return existsSync(join(root, at)) ? { fate: "renamed-since", now: join(root, at) } : { fate: "renamed-then-deleted" }
  return { fate: deleted.has(at) ? "deleted-since" : "never-there" }
}
const fateOf = (path: string) => followed(path).fate

const OTHER_CHECKOUT = /\/\.mako\/(?:worktrees\/[^/]+\/[^/]+|thread-data\/[^/]+\/[^/]+)\/(.+)$/
/** A file in another checkout of the project (a Thread's worktree), found in this one by its longest unique trailing path. */
function inThisCheckout(workspace: string, path: string): string | undefined {
  const rest = OTHER_CHECKOUT.exec(path)?.[1]
  if (!rest) return undefined
  const { root, files } = listing(workspace)
  const segments = rest.split("/")
  for (let from = 0; from <= segments.length - 2; from++) {
    const tail = segments.slice(from).join("/")
    const matches = files.filter((file) => file === tail || file.endsWith(`/${tail}`))
    if (matches.length === 1) return join(root, matches[0]!)
    if (matches.length > 1) return undefined
  }
  return undefined
}

const nows = new Map<string, string | undefined>()
/** Where a file the session named is now: there still, renamed since, or the same file in this checkout. */
function now(workspace: string, path: string): string | undefined {
  const key = `${workspace}\0${path}`
  if (nows.has(key)) return nows.get(key)
  let found: string | undefined
  if (exists(path)) found = real(path)
  else {
    const renamed = followed(path).now
    const moved = renamed ? undefined : inThisCheckout(workspace, path)
    found = renamed ? real(renamed) : moved && exists(moved) ? real(moved) : moved && followed(moved).now
  }
  nows.set(key, found)
  return found
}

/* ------------------------------------------------- Mako's resolver */

const renameHistories = new Map<string, RenameHistory>()
/** A repository's renames on every branch, read the way the host reads them. */
function renamesOf(root: string): RenameHistory {
  let found = renameHistories.get(root)
  if (found) return found
  found = new RenameHistory()
  try {
    found.add(execFileSync("git", ["-C", root, ...RENAME_LOG, "--all"], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }))
  } catch {
    // Not a repository Git can read.
  }
  renameHistories.set(root, found)
  return found
}
const commonDirs = new Map<string, string | undefined>()
function commonDir(root: string): string | undefined {
  if (!commonDirs.has(root)) {
    try {
      commonDirs.set(root, resolve(root, execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()))
    } catch {
      commonDirs.set(root, undefined)
    }
  }
  return commonDirs.get(root)
}
const CHECKOUT_ROOT = /^(.*\/\.mako\/worktrees\/[^/]+\/[^/]+\/[^/]+)\//
const placesBySession = new WeakMap<Touches, Place[]>()
/** The places the host would know: the conversation's checkout, indexed, and each Mako worktree the session touched, there or gone. */
function placesOf(message: Message, workspace: string): Place[] {
  let places = placesBySession.get(message.touched)
  if (places) return places
  const { root, files } = listing(workspace)
  const repository = gitRoot(workspace) ? commonDir(root) : undefined
  places = [{ root, name: basename(root), current: true, ...(repository && { repository }), index: SuffixIndex.of(files) }]
  for (const checkout of new Set([...message.touched].flatMap((path) => CHECKOUT_ROOT.exec(path)?.[1] ?? []))) {
    if (checkout === root) continue
    const there = exists(checkout)
    const shared = there ? commonDir(checkout) : undefined
    places.push({ root: checkout, name: basename(checkout), current: false, ...(shared && { repository: shared }), ...(!there && { gone: true }) })
  }
  placesBySession.set(message.touched, places)
  return places
}
/** Where Git says a path went, from the nearest folder that's still there. */
function renamedInGit(path: string): string | undefined {
  let dir = path
  while (dir !== "/" && !existsSync(dir)) dir = resolve(dir, "..")
  const root = gitRoot(dir)
  if (!root || !path.startsWith(root + "/")) return undefined
  const to = renamesOf(root).follow(relative(root, path), 0)
  return to ? join(root, to) : undefined
}
/**
 * `resolveSpelling`, the host's own, over what the session's record shows:
 * its folders, the files its calls named before the message (as reads, in
 * order), its places, and Git's renames. Messages carry no finish time
 * here, so every rename counts, as for an answer written before all of them.
 */
const touchedAsOf = new WeakMap<Message, Map<string, Touch>>()
/** The files the session touched before `message`, each at its latest touch then. */
function touchedBy(message: Message): Map<string, Touch> {
  let touched = touchedAsOf.get(message)
  if (touched) return touched
  touched = new Map()
  for (const [path, order] of message.touched.order) {
    let latest = 0
    for (const seq of order) if (seq <= message.seq) latest = seq
    if (latest) touched.set(path, { kind: "read", at: latest })
  }
  touchedAsOf.set(message, touched)
  return touched
}
function makoResolve(message: Message, workspace: string, spelling: string): FileResolution {
  const context: ReferenceContext = {
    folders: basesOf(message, workspace),
    touched: touchedBy(message),
    places: placesOf(message, workspace),
    renamed: renamedInGit,
    home,
  }
  return resolveSpelling(spelling, context, exists)
}
const outcomeOf = (resolution: FileResolution, truth: string | undefined) =>
  resolution.kind === "file"
    ? truth ? (real(resolution.file.path) === truth ? "opens-meant" : "opens-other") : "opens-unjudged"
    : resolution.kind === "choice" ? (truth ? "chooser-findable" : "chooser") : truth ? "plain-but-findable" : "plain"
const stepOf = (resolution: FileResolution) => (resolution.kind === "file" ? resolution.file.reason : resolution.kind)

/** Why a link that doesn't open the meant file fails. */
function cause(verdict: string, workspace: string, path: string, meant: string[], meantEver: string[]): string {
  if (verdict === "ambiguous-error") return meant.length === 1 ? "several-match-touched-one" : "several-match"
  const target = meant[0] ?? meantEver[0]
  if (verdict === "not-a-file") return /^(?:\.\.\/)+/.test(path) ? "relative-to-a-document" : "named-only"
  if (!target) return "unknown"
  if (/^\/(?:private\/)?(?:tmp|var\/folders)\//.test(target)) return verdict === "dead-gone" ? "temporary-removed" : "temporary"
  if (/\/\.mako\/(?:worktrees|thread-data)\//.test(target)) return verdict === "dead-gone" ? "other-checkout-removed" : "other-checkout"
  if (verdict === "wrong-file") return "same-name-elsewhere"
  if (verdict === "dead-gone") return fateOf(target)
  if (path.startsWith("../")) return "parent-relative"
  if (!target.startsWith(workspace + "/")) return "outside-the-workspace"
  const { root, files } = listing(workspace)
  return files.includes(relative(root, target)) ? "partial-path" : "git-ignored"
}
const causes: Record<string, Record<string, number>> = {}
const compare: Record<string, Record<string, number>> = {}
const steps: Record<string, Record<string, number>> = {}
const shifts: Record<string, unknown[]> = {}
const standing: Record<string, Record<string, number>> = {}
/** Mako's resolver's links by why it linked and how that landed, a few of each, to read by eye. */
const samples: Record<string, unknown[]> = {}

/* ------------------------------------------------------------- measure */

type Verdict =
  | "right"
  | "wrong-file"
  | "dead-findable"
  | "dead-gone"
  | "ambiguous-error"
  | "resolved-unknown"
  | "not-a-file"
const counts: Record<string, Record<string, number>> = {}
const forms: Record<string, Record<string, number>> = {}
const examples: Record<string, unknown[]> = {}
const missedExamples: unknown[] = []
const missed = { total: 0, touchedExists: 0, examples: missedExamples }
const bump = (table: Record<string, Record<string, number>>, row: string, column: string) => {
  const of = (table[row] ??= {})
  of[column] = (of[column] ?? 0) + 1
}
const around = (text: string, raw: string) => {
  const at = text.indexOf(raw.replace(/^mako-citation:/, ""))
  return at < 0 ? text.slice(0, 160) : text.slice(Math.max(0, at - 100), at + raw.length + 60).replaceAll("\n", " ")
}
const formOf = (path: string, cwd: string): string => {
  if (path.startsWith("~/")) return "home"
  if (isAbsolute(path)) return path.startsWith(cwd + "/") ? "absolute-inside" : "absolute-outside"
  if (path.startsWith("../")) return "parent-relative"
  if (path.startsWith("./")) return "dot-relative"
  return path.includes("/") ? "relative" : "bare-name"
}

// Mako's own test runs live in temporary folders, with project folders named after them; they say little about real answers.
const scratch = (path: string) => /^\/(?:private\/)?(?:var\/folders|tmp)\//.test(path) || /-(?:private-)?(?:var-folders|tmp)-/.test(path)
const files = [
  ...newest(join(home, ".claude", "projects"), (name) => name.endsWith(".jsonl"), 1).filter((file) => !scratch(file)).map((file) => ({ file, read: claudeSession })),
  ...newest(join(home, ".codex", "sessions"), (name) => name.startsWith("rollout-") && name.endsWith(".jsonl")).map((file) => ({ file, read: codexSession })),
  ...newest(join(home, ".cursor", "projects"), (name) => name.endsWith(".jsonl"), 3).filter((file) => file.includes("/agent-transcripts/") && !scratch(file)).map((file) => ({ file, read: cursorSession })),
]
let sessions = 0
let messages = 0
const kept = { claude: 0, codex: 0, cursor: 0 }
for (const { file, read } of files) {
  let session: Session | null
  try {
    session = read(file)
  } catch {
    continue
  }
  if (!session || scratch(session.workspace)) continue
  if (kept[session.harness] >= SESSIONS) continue
  kept[session.harness]++
  sessions++
  for (const message of session.messages) {
    messages++
    const { linked, unlinked } = references(message.text)
    for (const reference of linked) {
      const resolved = hostResolve(session.workspace, reference.path)
      const meantEver = intended(message, session.workspace, reference.path)
      const meant = meantEver.filter(exists)
      const meantNow = [...new Set(meantEver.map((file) => now(session.workspace, file)).filter(Boolean))]
      const truth = meantNow.length === 1 ? meantNow[0] : undefined
      const today = "found" in resolved ? (truth ? (resolved.found === truth ? "opens-meant" : "opens-other") : "opens-unjudged") : "dead-link"
      const proposed = makoResolve(message, session.workspace, reference.path)
      const tomorrow = outcomeOf(proposed, truth)
      bump(compare, `${session.harness}:before`, today)
      bump(compare, `${session.harness}:mako`, tomorrow)
      bump(steps, stepOf(proposed), tomorrow)
      bump(standing, "links", tomorrow)
      const bucket = (samples[`${stepOf(proposed)}:${tomorrow}${formOf(reference.path, message.cwd) === "bare-name" ? ":bare" : ""}`] ??= [])
      if (bucket.length < 30 && Math.random() < 0.3)
        bucket.push({ path: reference.path, linked: proposed.kind === "file" ? proposed.file.path : proposed.kind, truth, workspace: session.workspace, context: around(message.text, reference.raw) })
      if (formOf(reference.path, message.cwd) === "bare-name") bump(standing, "bare names", tomorrow)
      if (today !== tomorrow) {
        const list = (shifts[`${today} -> ${tomorrow}`] ??= [])
        if (list.length < 25 && Math.random() < 0.4)
          list.push({ harness: session.harness, path: reference.path, workspace: session.workspace, today: "found" in resolved ? resolved.found : resolved, proposed, truth, context: around(message.text, reference.raw) })
      }
      let verdict: Verdict
      if ("found" in resolved) {
        if (meant.length === 1) verdict = real(meant[0]!) === resolved.found ? "right" : "wrong-file"
        else verdict = "resolved-unknown"
      } else if ("many" in resolved) verdict = "ambiguous-error"
      else if (meant.length) verdict = "dead-findable"
      else if (meantEver.length) verdict = "dead-gone"
      else verdict = "not-a-file"
      const row = `${session.harness}:${reference.how}`
      bump(counts, row, verdict)
      const why = verdict === "right" || verdict === "resolved-unknown" ? verdict : cause(verdict, real(session.workspace), reference.path, meant.map(real), meantEver)
      if (why !== verdict) bump(causes, verdict, why)
      bump(forms, formOf(reference.path, message.cwd), verdict)
      const list = (examples[`${verdict}:${why}`] ??= [])
      if (list.length < 30 && Math.random() < 0.5)
        list.push({ harness: session.harness, session: file, how: reference.how, path: reference.path, workspace: session.workspace, cwd: message.cwd, resolved, meant: (meant.length ? meant : meantEver).slice(0, 3), context: around(message.text, reference.raw) })
    }
    for (const name of unlinked) {
      missed.total++
      const meant = [...new Set(intended(message, session.workspace, name).map((file) => now(session.workspace, file)).filter(Boolean))]
      if (meant.length === 1) {
        missed.touchedExists++
        if (missed.examples.length < 40 && Math.random() < 0.3) missed.examples.push({ harness: session.harness, name, cwd: message.cwd, meant: meant[0] })
      }
      const proposed = makoResolve(message, session.workspace, name)
      bump(compare, `${session.harness}:unlinked-mako`, outcomeOf(proposed, meant.length === 1 ? meant[0] : undefined))
    }
  }
}

const total = (row: Record<string, number>) => Object.values(row).reduce((sum, n) => sum + n, 0)
const summary = { days: DAYS, sessions: kept, messages, byHarnessAndHow: counts, byForm: forms, causes, compare, steps, standing, unlinkedInlineNames: { total: missed.total, nameATouchedFile: missed.touchedExists } }
const table = (of: Record<string, Record<string, number>>) => {
  for (const [row, cells] of Object.entries(of).sort(([a], [b]) => a.localeCompare(b)))
    console.log(row.padEnd(28), String(total(cells)).padStart(6), Object.entries(cells).sort(([, a], [, b]) => b - a).map(([k, n]) => `${k} ${n}`).join(", "))
}
console.log(`sessions ${JSON.stringify(kept)}, messages ${messages}\n\nhow links landed before Mako resolved them (a click against the conversation's folder):`)
table(counts)
console.log("\nwhy those fail:")
table(causes)
console.log("\nbefore against Mako's resolver:")
table(compare)
console.log("\nMako's resolver, by why it linked:")
table(steps)
console.log("\nMako's resolver (opens-other is a wrong copy; chooser-findable and plain-but-findable are misses):")
table(standing)
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, examples, shifts, samples, missed: missed.examples }, null, 1))
