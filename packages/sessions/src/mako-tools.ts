import { z } from "zod"

/**
 * Mako's own `mako` server, by tool: what each call's row says, in Mako's
 * words rather than the tool's name. One table for every surface: the desk's
 * row (`ToolWords`), the phone's steps (`stepWords`), the activity line and a
 * Fin's last step all read `makoToolWords`.
 *
 * Each entry reads the call's typed arguments, and its answer once it has
 * one, into a verb in three forms and what it acts on: "Start fin:x on
 * Codex" (the tool's name, and a failed call's words), "Starting fin:x on
 * Codex" while it runs, "Started fin:x on Codex" once it returned. Where the
 * answer says more than the arguments (the Fin's name a start made, a pull
 * request's number), the settled words say that. A tool missing here reads
 * as its name in words.
 */

/** A verb as the row says it: named, running and done ("Start", "Starting", "Started"). */
type Verb = readonly [base: string, running: string, done: string]

interface Said {
  verb: Verb
  /** What the call acts on, after the verb. */
  what?: string
  /** What it acted on once it returned, when that says more ("3 Fins" for "Fins"). */
  done?: string
  /** A page the call made or read that its row can open: a pull request's. */
  link?: string
}

/** What a group of Mako's tools is about, which picks its glyph. */
export type MakoToolGroup = "agents" | "pull-request" | "app" | "worktree" | "recipe" | "history" | "media" | "port" | "cloud" | "other"

export interface MakoToolWords {
  /** The tool's name in words, and what a failed call says: "Start fin:x on Codex". */
  label: string
  /** While it runs: "Starting fin:x on Codex". */
  running: string
  /** Once it returned: "Started fin:x on Codex". */
  done: string
  group: MakoToolGroup
  link?: string
}

/** How a surface names a harness ("codex" → "Codex"); without one, the id with its first letter raised. */
export type HarnessName = (harness: string) => string

const Json = z.json()
type JsonValue = z.infer<typeof Json>
const Fields = z.record(z.string(), Json)
type Fields = z.infer<typeof Fields>

interface Read {
  args: Fields
  /** The call's answer as fields, when it answered with an object (JSON, or a refusal's JSON after its line). */
  answer?: Fields
  /** The call's answer as text. */
  text?: string
  harness: HarnessName
}

interface MakoTool {
  group: MakoToolGroup
  say: (read: Read) => Said
}

const verb = (base: string, running: string, done: string): Verb => [base, running, done]
const START = verb("Start", "Starting", "Started")
const READ = verb("Read", "Reading", "Read")
const MOVE = verb("Move", "Moving", "Moved")

/** `automation`: the list, or what it did to one. */
function automationWords(args: Fields): Said {
  const what = text(args.id) ? `the automation ${text(args.id)}` : "an automation"
  if (args.action === "run") return { verb: verb("Run", "Running", "Ran"), what }
  if (args.action === "on") return { verb: verb("Turn on", "Turning on", "Turned on"), what }
  if (args.action === "off") return { verb: verb("Turn off", "Turning off", "Turned off"), what }
  return { verb: verb("List", "Listing", "Listed"), what: "the automations" }
}

/** `harness`: what it read, or which it installed or updated. */
function harnessWords(args: Fields): Said {
  const what = text(args.harness) ?? "a harness"
  if (args.action === "install") return { verb: verb("Install", "Installing", "Installed"), what }
  if (args.action === "update") return { verb: verb("Update", "Updating", "Updated"), what }
  return { verb: verb("Read", "Reading", "Read"), what: "the harnesses' versions" }
}

/** `settings`: what it read, or which it changed. */
function settingsWords(args: Fields): Said {
  if (args.action === "read") return { verb: verb("Read", "Reading", "Read"), what: "Settings" }
  const setting = text(args.setting)
  return { verb: verb("Change", "Changing", "Changed"), what: setting ? `the setting ${setting}` : "a setting" }
}

/** `thread`, by its action, in the words of the Thread's menu. */
function threadWords(args: Fields): Said {
  if (args.action === "archive") return { verb: verb("Archive", "Archiving", "Archived"), what: "this Thread" }
  if (args.action === "restore") return { verb: verb("Restore", "Restoring", "Restored"), what: "this Thread" }
  const title = firstWords(text(args.title))
  return { verb: verb("Rename", "Renaming", "Renamed"), what: title ? `this Thread to ${title}` : "this Thread" }
}
const MERGE = verb("Merge", "Merging", "Merged")
const OPEN = verb("Open", "Opening", "Opened")
const STOP = verb("Stop", "Stopping", "Stopped")
const RESTART = verb("Restart", "Restarting", "Restarted")
const CHECK = verb("Check", "Checking", "Checked")

const Text = z.union([z.string(), z.number().transform(String)])

function text(value: JsonValue | undefined): string | undefined {
  return Text.safeParse(value).data?.trim() || undefined
}

function texts(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.flatMap((item) => text(item) ?? []) : []
}

function fields(value: JsonValue | undefined): Fields | undefined {
  return Fields.safeParse(value).data
}

/** The first few words of a brief or a message: what a Fin with no name is about. */
function firstWords(value: string | undefined, count = 6): string | undefined {
  const line = value?.split("\n").map((part) => part.trim()).find(Boolean)
  if (!line) return undefined
  const words = line.split(/\s+/)
  return words.length > count ? `${words.slice(0, count).join(" ")}…` : line.replace(/[.:;,]$/, "")
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A Fin as the row names it, `fin:<name>`: by the name it was given, else the one its answer carries. */
function fin(given: string | undefined, answer: Fields | undefined): string {
  const named = text(answer?.["name"])
  const bare = given?.replace(/^fin:/, "")
  if (bare && !THREAD_ID.test(bare)) return `fin:${bare}`
  return named ? `fin:${named}` : "a Fin"
}

function count(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`
}

/** A pull request's number in a tool's answer: "Opened #374 …", "#374 was already open", or a report's `number: 374`. */
function pullNumber(answer: string | undefined): string | undefined {
  return answer ? (/(?:^|\s)#(\d+)\b/.exec(answer)?.[1] ?? /^\s*number: (\d+)$/m.exec(answer)?.[1]) : undefined
}

function pullLink(answer: string | undefined): string | undefined {
  return answer ? /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/.exec(answer)?.[0] : undefined
}

/** " in api", for a call that named one of a project folder's repositories. */
function inRepository(args: Fields): string {
  const repository = text(args["repository"])
  return repository ? ` in ${repository}` : ""
}

function pullRequest(number: string | undefined, args: Fields): string {
  return `${number ? `PR #${number}` : "the PR"}${inRepository(args)}`
}

function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) ?? path
}

function listed(items: readonly string[], none: string): string {
  if (!items.length) return none
  return items.length > 3 ? `${items.slice(0, 2).join(", ")} and ${items.length - 2} more` : items.join(", ")
}

/** "(web)", "(quick · lint)": what an app call was aimed at, when it named something. */
function aimed(...parts: (string | undefined)[]): string | undefined {
  const named = parts.filter(Boolean)
  return named.length ? `(${named.join(" · ")})` : undefined
}

const REPORT_WORDS = new Map([["done", "done"], ["failed", "failed"], ["blocked", "blocked"], ["needs-input", "a question"], ["progress", "progress"]])

const ArtifactsSchema = z.array(z.object({ kind: z.string(), ref: z.string() }).loose())

const TOOLS: ReadonlyMap<string, MakoTool> = new Map<string, MakoTool>([
  ["agents_start", {
    group: "agents",
    say: ({ args, answer, harness }) => {
      const name = text(args["name"]) ?? text(answer?.["name"])
      const brief = fields(args["brief"])
      const subject = name ? `fin:${name.replace(/^fin:/, "")}` : text(args["title"]) ?? firstWords(text(brief?.["objective"])) ?? "a Fin"
      const on = text(args["harness"])
      const what = on ? `${subject} on ${harness(on)}` : subject
      return text(answer?.["state"]) === "queued" ? { verb: verb("Start", "Starting", "Queued"), what } : { verb: START, what }
    },
  }],
  ["agents_link", {
    group: "agents",
    say: ({ args, answer, harness }) => {
      const name = text(args["name"]) ?? text(answer?.["name"])
      const on = text(args["harness"])
      return { verb: verb("Link", "Linking", "Linked"), what: name ? `fin:${name}` : on ? `a ${harness(on)} run` : "a run" }
    },
  }],
  ["agents_list", {
    group: "agents",
    say: ({ args, answer }) => {
      const scope = text(args["scope"])
      if (scope === "crew") return { verb: READ, what: "the crew" }
      if (scope === "apexes") return { verb: READ, what: "other Apexes" }
      const children = answer?.["children"]
      return { verb: READ, what: "Fins", ...Array.isArray(children) && { done: count(children.length, "Fin", "Fins") } }
    },
  }],
  ["agents_read", {
    group: "agents",
    say: ({ args, answer }) => ({ verb: READ, what: `${fin(text(args["child"]), answer)}'s ${text(args["view"]) === "transcript" ? "transcript" : "report"}` }),
  }],
  ["agents_report", {
    group: "agents",
    say: ({ args }) => {
      const status = text(args["status"])
      const artifacts = ArtifactsSchema.safeParse(args["artifacts"])
      const pull = artifacts.success ? artifacts.data.find((artifact) => artifact.kind === "pull-request") : undefined
      const number = pull ? /(?:\/pull\/|#)(\d+)\b/.exec(pull.ref)?.[1] ?? (/^\d+$/.test(pull.ref) ? pull.ref : undefined) : undefined
      const what = `${(status && REPORT_WORDS.get(status)) ?? status ?? "back"}${number ? ` · PR #${number}` : ""}`
      return { verb: verb("Report", "Reporting", "Reported"), what, ...pull && pull.ref.startsWith("https://") && { link: pull.ref } }
    },
  }],
  ["agents_answer", {
    group: "agents",
    say: ({ args, answer }) => {
      const to = fin(text(args["to"]), answer)
      if (args["person"] === true) return { verb: verb("Leave", "Leaving", "Left"), what: `${to}'s question to you` }
      if (args["allow"] === true) return { verb: verb("Allow", "Allowing", "Allowed"), what: `${to}'s request` }
      if (args["allow"] === false) return { verb: verb("Refuse", "Refusing", "Refused"), what: `${to}'s request` }
      const said = firstWords(text(args["answer"]), 12)
      return { verb: verb("Answer", "Answering", "Answered"), what: to, ...said && { done: `${to}: ${said}` } }
    },
  }],
  ["agents_send", {
    group: "agents",
    say: ({ args, answer }) => {
      const to = text(args["to"])
      const apex = to?.startsWith("apex:") ? to : undefined
      return { verb: verb("Message", "Messaging", "Messaged"), what: apex ?? fin(to, answer) }
    },
  }],
  ["agents_move", {
    group: "agents",
    say: ({ args, answer, harness }) => {
      const to = text(args["harness"])
      const where = to ? ` to ${harness(to)}` : ""
      if (args["all"] === true) {
        const moved = Array.isArray(answer?.["moved"]) ? answer["moved"].length : 0
        return { verb: MOVE, what: `all Fins${where}`, ...moved > 0 && { done: `${count(moved, "Fin", "Fins")}${where}` } }
      }
      return { verb: MOVE, what: `${fin(text(args["child"]), undefined)}${where}` }
    },
  }],
  ["agents_stop", {
    group: "agents",
    say: ({ args, answer }) => {
      const child = text(args["child"])
      const stopped = texts(answer?.["stopped"])
      // On a device that couldn't be reached: nothing stopped yet, and the stop is kept for when it answers.
      const pending = Array.isArray(answer?.["pending"]) ? answer["pending"].length : 0
      const kept = pending > 0 && !stopped.length ? verb("Stop", "Stopping", "Stop kept for") : STOP
      if (child === "all") return { verb: kept, what: "all Fins", ...(stopped.length || pending) && { done: count(stopped.length || pending, "Fin", "Fins") } }
      return { verb: kept, what: fin(child, answer) }
    },
  }],
  ["agents_wait", {
    group: "agents",
    say: ({ args }) => {
      const children = texts(args["children"])
      const what = children.length === 1 ? fin(children[0], undefined) : children.length ? count(children.length, "Fin", "Fins") : "all Fins"
      return { verb: verb("Wait on", "Waiting on", "Waited on"), what }
    },
  }],
  ["pull_request_open", {
    group: "pull-request",
    say: ({ args, text: answer }) => {
      const number = pullNumber(answer)
      const link = pullLink(answer)
      const already = answer ? /^(?:\S+: )?#\d+ was already open/.test(answer) : false
      return { verb: already ? verb("Open", "Opening", "Updated") : OPEN, what: pullRequest(undefined, args), done: pullRequest(number, args), ...link && { link } }
    },
  }],
  ["pull_request_status", {
    group: "pull-request",
    say: ({ args, text: answer }) => {
      const number = pullNumber(answer)
      const link = pullLink(answer)
      return { verb: READ, what: pullRequest(undefined, args), done: number ? pullRequest(number, args) : `the PR's status${inRepository(args)}`, ...link && { link } }
    },
  }],
  ["pull_request_merge", {
    group: "pull-request",
    say: ({ args, text: answer }) => {
      const asked = answer ? /Asked GitHub to merge/.test(answer) : false
      return { verb: asked ? verb("Merge", "Merging", "Queued the merge of") : MERGE, what: pullRequest(undefined, args), done: pullRequest(pullNumber(answer), args) }
    },
  }],
  ["pull_request_rerun", {
    group: "pull-request",
    say: ({ args, text: answer }) => answer && /nothing was re-run/.test(answer)
      ? { verb: verb("Rerun", "Rerunning", "Found no failed"), what: `checks${inRepository(args)}` }
      : { verb: verb("Rerun", "Rerunning", "Reran"), what: `checks${inRepository(args)}` },
  }],
  ["thread_history", {
    group: "history",
    say: ({ args }) => {
      const other = text(args["thread"]) === "tree" ? "the whole tree" : text(args["thread"]) ? "a referenced thread" : undefined
      const turns = text(args["turns"])
      const query = text(args["query"])
      if (text(args["action"]) === "export") return { verb: verb("Export", "Exporting", "Exported"), what: other ?? "this Thread" }
      if (text(args["action"]) === "search") return { verb: verb("Search", "Searching", "Searched"), what: `${other ?? "earlier turns"}${query ? ` for ${query}` : ""}` }
      return { verb: READ, what: other ?? (turns ? `turns ${turns}` : "earlier turns") }
    },
  }],
  ["show", {
    group: "media",
    say: ({ args }) => {
      const files = Array.isArray(args["files"]) ? args["files"].flatMap((file) => text(fields(file)?.["path"]) ?? []) : []
      return { verb: verb("Show", "Showing", "Showed"), what: listed(files.map(baseName), "files") }
    },
  }],
  ["worktree_status", { group: "worktree", say: () => ({ verb: READ, what: "the worktree" }) }],
  ["worktree_move", { group: "worktree", say: () => ({ verb: MOVE, what: "to the worktree" }) }],
  ["worktree_bring", {
    group: "worktree",
    say: ({ args }) => {
      const entries = Array.isArray(args["entries"]) ? args["entries"].flatMap((entry) => text(fields(entry)?.["path"]) ?? []) : []
      return { verb: verb("Bring", "Bringing", "Brought"), what: listed(entries, "ignored files") }
    },
  }],
  ["worktree_update", { group: "worktree", say: () => ({ verb: verb("Update", "Updating", "Updated"), what: "from main" }) }],
  ["worktree_merge", { group: "worktree", say: () => ({ verb: MERGE, what: "the worktree" }) }],
  ["worktree_remove", { group: "worktree", say: () => ({ verb: verb("Remove", "Removing", "Removed"), what: "the worktree" }) }],
  ["recipe_guide", { group: "recipe", say: () => ({ verb: READ, what: "the recipe guide" }) }],
  ["recipe_save", {
    group: "recipe",
    say: ({ args }) => {
      const version = text(args["version"])
      return { verb: verb("Save", "Saving", "Saved"), what: version ? `version ${version} as a draft` : "a recipe draft" }
    },
  }],
  ["recipe_publish", { group: "recipe", say: () => ({ verb: verb("Publish", "Publishing", "Published"), what: "the recipe" }) }],
  ["app_status", { group: "app", say: () => ({ verb: READ, what: "the app's status" }) }],
  ["app_start", { group: "app", say: ({ args }) => ({ verb: START, what: app(args) }) }],
  ["app_stop", { group: "app", say: ({ args }) => ({ verb: STOP, what: app(args) }) }],
  ["app_restart", { group: "app", say: ({ args }) => ({ verb: RESTART, what: app(args) }) }],
  ["app_logs", { group: "app", say: ({ args }) => ({ verb: READ, what: ["app logs", aimed(text(args["process"]) ?? text(args["check"]), text(args["step"]))].filter(Boolean).join(" ") }) }],
  ["app_check", {
    group: "app",
    say: ({ args }) => {
      const steps = texts(args["steps"])
      return { verb: CHECK, what: ["the app", aimed(text(args["tier"]), text(args["target"]), steps.length ? steps.join(", ") : undefined)].filter(Boolean).join(" ") }
    },
  }],
  ["app_probe", { group: "app", say: () => ({ verb: verb("Probe", "Probing", "Probed"), what: "the app" }) }],
  ["app_own_packages", { group: "app", say: () => ({ verb: verb("Unlink", "Unlinking", "Unlinked"), what: "packages" }) }],
  ["port_holder", { group: "port", say: ({ args }) => ({ verb: CHECK, what: text(args["port"]) ? `port ${text(args["port"])}` : "a port" }) }],
  ["thread_move", { group: "cloud", say: () => ({ verb: MOVE, what: "this Thread to the cloud" }) }],
  ["thread", { group: "cloud", say: ({ args }) => threadWords(args) }],
  ["settings", { group: "cloud", say: ({ args }) => settingsWords(args) }],
  ["harness", { group: "cloud", say: ({ args }) => harnessWords(args) }],
  ["automation", { group: "cloud", say: ({ args }) => automationWords(args) }],
])

/** The worktree tools' earlier names, in saved history. */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ["workspace_status", "worktree_status"],
  ["workspace_move", "worktree_move"],
  ["workspace_merge", "worktree_merge"],
  ["workspace_remove", "worktree_remove"],
])

/** "the app (web)": the processes or target a call named; `tier` is what saved history's calls named them by. */
function app(args: Fields): string {
  const processes = texts(args["processes"])
  return ["the app", aimed(processes.length ? processes.join(", ") : text(args["target"]) ?? text(args["process"]) ?? text(args["tier"]))].filter(Boolean).join(" ")
}

/** Every tool of the `mako` server this table words, by its current name. */
export const MAKO_TOOL_NAMES: readonly string[] = [...TOOLS.keys()]

/** Whether the table words `tool` itself, rather than reading its name in words. */
export function isWordedMakoTool(tool: string): boolean {
  return TOOLS.has(RENAMED.get(tool) ?? tool)
}

/** What a tool of the server is about, which its row's glyph says. */
export function makoToolGroup(tool: string): MakoToolGroup {
  return TOOLS.get(RENAMED.get(tool) ?? tool)?.group ?? "other"
}

/** A tool's answer as fields: its JSON, or a refusal's (`refused: …` then the JSON). */
function answerOf(answer: string | undefined): Fields | undefined {
  const json = answer?.trim().replace(/^refused: [^\n]*\n/, "")
  if (!json?.startsWith("{")) return undefined
  try {
    return fields(JSON.parse(json))
  } catch {
    return undefined
  }
}

function raised(harness: string): string {
  return harness.charAt(0).toUpperCase() + harness.slice(1)
}

/** The surface's name for a harness, raised when it has none but the id. */
function named(harness: HarnessName): HarnessName {
  return (id) => {
    const name = harness(id)
    return name === id ? raised(id) : name
  }
}

/** `agents_frobnicate` → "Agents frobnicate": a tool of the server this table doesn't word yet. */
function nameInWords(tool: string): string {
  const words = tool.replace(/[_\-.]+/g, " ").trim().toLowerCase()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : tool
}

/**
 * What one call of the `mako` server's `tool` says, from its arguments and,
 * once it returned, its answer's text.
 */
export function makoToolWords(tool: string, args: Fields = {}, answer?: string, harness: HarnessName = raised): MakoToolWords {
  const entry = TOOLS.get(RENAMED.get(tool) ?? tool)
  if (!entry) {
    const name = nameInWords(tool)
    return { label: name, running: name, done: name, group: "other" }
  }
  const said = entry.say({ args, answer: answerOf(answer), text: answer, harness: named(harness) })
  const [base, running, done] = said.verb
  const phrase = (word: string, what: string | undefined) => (what ? `${word} ${what}` : word)
  return {
    label: phrase(base, said.what),
    running: phrase(running, said.what),
    done: phrase(done, said.done ?? said.what),
    group: entry.group,
    ...said.link && { link: said.link },
  }
}
