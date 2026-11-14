/**
 * Whether a harness's own route for work Mako has a tool for goes ahead: a
 * shell command (`git worktree add`, `gh pr create`, `npm run dev`, `claude
 * -p`, a sleep loop) or one of the harness's own tools (Claude's
 * `EnterWorktree`, a browser MCP server). One decision for every harness;
 * each driver delivers it as its harness allows (`NativeCallsCapability`).
 *
 * A deny is only for a route that's clearly wrong and that Mako's tool does
 * in full: a worktree Mako doesn't know, a new branch in the checkout others
 * work in, a merge outside pull_request_merge. Everything else is a warn:
 * the call runs, and the model reads in one line what the better Mako tool
 * is and why, and decides. A route outside the Thread's checkouts, or one the agent marks
 * with `MAKO_NATIVE=1` after the Mako tool failed or couldn't do what was
 * asked, goes ahead.
 */

/** The families of work Mako has its own tools for. */
export type CallFamily = "worktree" | "branch" | "pull-request" | "app" | "port" | "browser" | "agent-cli" | "background" | "polling" | "build"

export type CallRoute =
  | { kind: "allow" }
  | { kind: "warn"; family: CallFamily; rule: string; message: string }
  | { kind: "deny"; family: CallFamily; rule: string; message: string }

/** What the decision reads of the Thread a call runs in. */
export interface CallThread {
  /** The Session's own folder, and the Thread's worktree when it has one: commands outside both go ahead. */
  folder?: string
  worktree?: string
  /** The main checkout the worktree was made from. */
  main?: string
  /** The project's recipe: ready with its processes, none, or not read. */
  recipe?: { kind: "ready"; processes: string[] } | { kind: "none" }
  /** The launch has Mako's `mako-computer` server. */
  computer?: boolean
  /** This machine's build slots now (`BuildSlots`): a heavy suite started while every one is in use hears so. */
  builds?: { slots: number; holders: string[] }
}

/** How a harness names a Mako tool, for the message: `mcp__mako__worktree_move` on Claude, the bare name elsewhere. */
export type ToolNames = (tool: string) => string
export const bareNames: ToolNames = (tool) => tool

/** The prefix that lets a command the policy would deny run anyway. */
export const NATIVE_OVERRIDE = "MAKO_NATIVE=1"

/** Routes the override doesn't open: Mako's tool does all they do, so a refusal stands. */
const NO_OVERRIDE = new Set(["git-worktree-add"])

const OVERRIDE_LINE = `Only if that tool failed or can't do what was asked, run the command again starting with ${NATIVE_OVERRIDE}.`

/** One simple command of a shell line, as the policy reads it. */
interface ShellSegment {
  argv: string[]
  /** Environment assignments before the program. */
  env: Record<string, string>
  /** The folder it runs in, after any `cd` before it on the line. */
  cwd?: string
  /** Ended by `&`, or started under `nohup`, `setsid` or `disown`. */
  background: boolean
}

interface ShellLine {
  segments: ShellSegment[]
  /** A `while`, `until` or `for` loop on the line. */
  loop: boolean
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "|&"])
const WRAPPERS = new Set(["command", "builtin", "exec", "time", "sudo", "nice", "caffeinate"])
const DETACHERS = new Set(["nohup", "setsid", "disown"])
const LOOP_WORDS = new Set(["while", "until", "for"])
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "{", "(", "!", "if"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash"])

/** Words and operators of a shell line, with quotes removed; good enough for the commands agents write, not a full parser. */
export function shellWords(line: string): string[] {
  const words: string[] = []
  let word = ""
  let started = false
  let quote: "'" | '"' | undefined
  const push = () => {
    if (started) words.push(word)
    word = ""
    started = false
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && index + 1 < line.length) word += line[++index]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === "\\" && index + 1 < line.length) {
      const next = line[++index]!
      if (next !== "\n") {
        word += next
        started = true
      }
      continue
    }
    if (char === "#" && !started && (index === 0 || /\s/.test(line[index - 1]!))) {
      while (index + 1 < line.length && line[index + 1] !== "\n") index += 1
      continue
    }
    if (char === "\n") {
      push()
      words.push("\n")
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    const two = line.slice(index, index + 2)
    if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
      push()
      words.push(two === ";;" ? ";" : two)
      index += 1
      continue
    }
    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") {
      // `2>&1` and `&>` are redirections, not separators.
      if (char === "&" && (line[index - 1] === ">" || line[index + 1] === ">")) {
        word += char
        started = true
        continue
      }
      push()
      words.push(char)
      continue
    }
    word += char
    started = true
  }
  push()
  return words
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A shell's flags that take the next word as its script: `-c`, `-lc`, `-ec`. */
export const scriptFlag = (word: string) => /^-[a-z]+$/.test(word) && word.includes("c")

/** An MCP tool's server and tool, from the `mcp__<server>__<tool>` name harnesses give it. */
export function mcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined
  const rest = name.slice("mcp__".length)
  const split = rest.indexOf("__")
  return split > 0 && split + 2 < rest.length ? { server: rest.slice(0, split), tool: rest.slice(split + 2) } : undefined
}

/** A shell line as simple commands, each with the folder `cd` left it in; `bash -c '…'` is read inside. */
export function shellLine(line: string, cwd?: string, depth = 0): ShellLine {
  const words = shellWords(line)
  const segments: ShellSegment[] = []
  let loop = false
  let folder = cwd
  let current: string[] = []
  const close = (separator: string | undefined) => {
    let argv = current
    current = []
    const env: Record<string, string> = {}
    let background = separator === "&"
    while (argv.length) {
      const [first] = argv
      if (SHELL_KEYWORDS.has(first!) || first === ")") argv = argv.slice(1)
      else if (LOOP_WORDS.has(first!)) {
        loop = true
        argv = first === "for" ? [] : argv.slice(1)
      } else if (ASSIGNMENT.test(first!)) {
        const at = first!.indexOf("=")
        env[first!.slice(0, at)] = first!.slice(at + 1)
        argv = argv.slice(1)
      } else if (first === "env") argv = argv.slice(1)
      else if (WRAPPERS.has(first!)) argv = argv.slice(1).filter((word, index) => index > 0 || !word.startsWith("-"))
      else if (first === "timeout" || first === "gtimeout") argv = argv.slice(2)
      else if (DETACHERS.has(first!)) {
        background = true
        argv = argv.slice(1)
      } else break
    }
    if (argv[0] === "done" || argv[0] === "fi" || argv[0] === "}" || argv[0] === "esac") argv = []
    if (!argv.length) return
    if (argv[0] === "cd") {
      const target = argv[1]
      if (target && !target.startsWith("-")) folder = resolveFolder(folder, target)
      return
    }
    const program = basename(argv[0]!)
    const inner = SHELLS.has(program) ? argv.findIndex((word, index) => index > 0 && scriptFlag(word)) : -1
    if (inner > 0 && argv[inner + 1] !== undefined && depth < 3) {
      const nested = shellLine(argv[inner + 1]!, folder, depth + 1)
      loop ||= nested.loop
      for (const segment of nested.segments) segments.push({ ...segment, env: { ...env, ...segment.env }, background: segment.background || background })
      return
    }
    segments.push({ argv, env, ...(folder !== undefined && { cwd: folder }), background })
  }
  for (const word of words) {
    if (SEPARATORS.has(word) || word === "(" || word === ")") {
      close(word)
      continue
    }
    current.push(word)
  }
  close(undefined)
  if (words.includes("disown")) for (const segment of segments) segment.background = true
  return { segments, loop }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

function resolveFolder(base: string | undefined, target: string): string | undefined {
  if (target.startsWith("/")) return normalize(target)
  if (target.startsWith("~") || target.startsWith("$")) return undefined
  if (base === undefined) return undefined
  return normalize(`${base}/${target}`)
}

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

const plain = (path: string) => (path.startsWith("/private/") ? path.slice("/private".length) : path)
const inside = (folder: string, path: string) => plain(path) === plain(folder) || plain(path).startsWith(`${plain(folder)}/`)

/** Where a command runs, for the Thread: its worktree, its other checkout (the folder it was opened in), or elsewhere. */
function placeOf(thread: CallThread, folder: string | undefined): "worktree" | "checkout" | "elsewhere" {
  if (folder === undefined) return thread.folder !== undefined || thread.worktree !== undefined ? "checkout" : "elsewhere"
  if (thread.worktree !== undefined && inside(thread.worktree, folder)) return "worktree"
  if (thread.folder !== undefined && inside(thread.folder, folder)) return thread.worktree !== undefined && inside(thread.folder, thread.worktree) ? "worktree" : "checkout"
  if (thread.main !== undefined && inside(thread.main, folder)) return "checkout"
  return "elsewhere"
}

/** `git`'s subcommand and its arguments, past global options, with the folder `-C` names. */
function gitCommand(argv: string[], cwd: string | undefined): { sub: string; args: string[]; cwd: string | undefined } | undefined {
  let folder = cwd
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index]!
    if (word === "-C") {
      folder = resolveFolder(folder, argv[++index] ?? "")
      continue
    }
    if (word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") {
      index += 1
      continue
    }
    if (word.startsWith("-")) continue
    return { sub: word, args: argv.slice(index + 1), cwd: folder }
  }
  return undefined
}

/** `gh`'s command group and command, past `-R`. */
function ghCommand(argv: string[]): { group: string; command: string; args: string[] } | undefined {
  const words = argv.slice(1).filter((word, index, all) => !(word === "-R" || word === "--repo" || all[index - 1] === "-R" || all[index - 1] === "--repo"))
  const [group, command, ...args] = words
  return group && command ? { group, command, args } : undefined
}

const AGENT_CLIS = new Map<string, (args: string[]) => boolean>([
  ["claude", (args) => args.some((word) => word === "-p" || word === "--print")],
  ["codex", (args) => args[0] === "exec" || args[0] === "e" || args[0] === "review"],
  ["cursor-agent", (args) => args.some((word) => word === "-p" || word === "--print")],
  ["cursor", (args) => args[0] === "agent" && args.some((word) => word === "-p" || word === "--print")],
  ["opencode", (args) => args[0] === "run"],
  ["grok", (args) => args.some((word) => word === "-p" || word === "--print" || word === "--prompt")],
  ["devin", (args) => args.some((word) => word === "-p" || word === "--print" || word === "--prompt")],
  ["gemini", (args) => args.some((word) => word === "-p" || word === "--prompt")],
])

const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"])
const SERVER_SCRIPTS = /^(dev|start|serve|preview|watch)([:-].*)?$|^(electron|app)[:-]?(dev|start)/
const SERVERS = new Map<string, (args: string[]) => boolean>([
  ["vite", (args) => !args[0] || args[0] === "dev" || args[0] === "serve" || args[0] === "preview" || args[0].startsWith("-")],
  ["next", (args) => args[0] === "dev" || args[0] === "start"],
  ["wrangler", (args) => args[0] === "dev"],
  ["electron", (args) => args.length > 0],
  ["electron-vite", (args) => !args[0] || args[0] === "dev" || args[0] === "preview"],
  ["astro", (args) => args[0] === "dev"],
  ["nodemon", () => true],
  ["webpack-dev-server", () => true],
])

/** A dev server or app start: `npm run dev`, `vite`, `next dev`, `wrangler dev`, `electron .`, through `npx` or not. */
function serverStart(argv: string[]): boolean {
  let words = argv
  const program = basename(words[0]!)
  if (program === "npx" || program === "bunx" || (program === "pnpm" && words[1] === "exec") || (program === "pnpm" && words[1] === "dlx")) {
    words = words.slice(program === "pnpm" ? 2 : 1).filter((word, index) => index > 0 || !word.startsWith("-"))
    if (!words.length) return false
  }
  const name = basename(words[0]!)
  if (RUNNERS.has(name)) {
    const args = words.slice(1).filter((word) => !word.startsWith("-"))
    const script = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0]
    return script !== undefined && SERVER_SCRIPTS.test(script)
  }
  return SERVERS.get(name)?.(words.slice(1)) ?? false
}

function sleepSeconds(argv: string[]): number | undefined {
  if (basename(argv[0]!) !== "sleep") return undefined
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(argv[1] ?? "")
  if (!match) return undefined
  return Number(match[1]) * (match[2] === "m" ? 60 : match[2] === "h" ? 3600 : 1)
}

/** A sleep this long, alone, is a wait the turn should end on instead. */
const LONG_SLEEP_S = 60

const BROWSERS = /chrome|chromium|safari|firefox|arc|brave|edge|comet|dia/i

/** A URL on this machine: the Thread's own `*.thread.localhost` address, `localhost` or loopback. */
const ownApp = (word: string) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.thread\.localhost)(:\d+)?(\/|$)/.test(word)

interface Finding {
  kind: "warn" | "deny"
  family: CallFamily
  rule: string
  message: string
}

/** One shell line's route: the strongest finding among its commands. */
export function routeShellCall(thread: CallThread, call: { command: string; cwd?: string }, names: ToolNames = bareNames): CallRoute {
  const line = shellLine(call.command, call.cwd)
  const findings: Finding[] = []
  const n = names
  if (line.loop && line.segments.some((segment) => basename(segment.argv[0]!) === "sleep"))
    findings.push({ kind: "warn", family: "polling", rule: "sleep-loop", message: `Don't wait in a loop: it holds the turn and nobody else can use it. A Fin's report wakes you (${n("agents_start")} with mode wait when your next step needs its result), ${n("app_logs")} and ${n("app_status")} read the app, and ${n("pull_request_status")} reads checks; otherwise end your turn and say what you're waiting for.` })
  for (const segment of line.segments) {
    const found = segmentFinding(thread, segment, line, n)
    if (found && (segment.env.MAKO_NATIVE !== "1" || NO_OVERRIDE.has(found.rule))) findings.push(found)
  }
  const deny = findings.find((finding) => finding.kind === "deny")
  const chosen = deny ?? findings[0]
  if (!chosen) return { kind: "allow" }
  return chosen.kind === "deny" && !NO_OVERRIDE.has(chosen.rule) ? { ...chosen, message: `${chosen.message} ${OVERRIDE_LINE}` } : chosen
}

function segmentFinding(thread: CallThread, segment: ShellSegment, line: ShellLine, n: ToolNames): Finding | undefined {
  const { argv } = segment
  const program = basename(argv[0]!)
  if (program === "git") {
    const git = gitCommand(argv, segment.cwd)
    if (!git) return undefined
    const place = placeOf(thread, git.cwd)
    if (place === "elsewhere") return undefined
    if (git.sub === "worktree" && git.args[0] === "add")
      return { kind: "deny", family: "worktree", rule: "git-worktree-add", message: `Mako doesn't see a worktree made with \`git worktree add\`: its Changes panel, pull request, app and checks follow only this Thread's own checkouts. Call ${n("worktree_move")} to work on this Thread's own branch (it takes the branch's name and a base), or ${n("agents_start")} with a workspace to put parallel work on a branch of its own.` }
    if (git.sub === "worktree" && git.args[0] === "remove")
      return { kind: "warn", family: "worktree", rule: "git-worktree-remove", message: `${n("worktree_remove")} removes this Thread's worktree with its app and data folder; use it for Mako's worktrees.` }
    const creates = (git.sub === "checkout" && git.args.some((word) => word === "-b" || word === "-B")) ||
      (git.sub === "switch" && git.args.some((word) => word === "-c" || word === "-C" || word === "--create" || word === "--force-create"))
    if (creates && place === "checkout")
      return { kind: "deny", family: "branch", rule: "git-new-branch-in-checkout", message: `This changes the branch of a checkout other Threads and the person work in. Call ${n("worktree_move")}: it puts this Thread on a branch of its own in its own worktree and takes only this Thread's changes along.` }
    if (creates)
      return { kind: "warn", family: "branch", rule: "git-new-branch-in-worktree", message: `This worktree's branch is the Thread's: its pull request and Changes panel follow it. Stay on it unless the person asked for another branch; ${n("worktree_status")} says which branch that is.` }
    if (git.sub === "switch" && place === "checkout" && git.args[0] && !git.args[0].startsWith("-"))
      return { kind: "warn", family: "branch", rule: "git-switch-in-checkout", message: `This switches the branch of a checkout other Threads and the person work in. Call ${n("worktree_move")} to work on a branch of this Thread's own.` }
    if ((git.sub === "pull" || git.sub === "rebase" || git.sub === "merge") && git.args.some((word) => /^(origin\/)?(main|master)$/.test(word)))
      return { kind: "warn", family: "branch", rule: "git-update-from-main", message: `${n("worktree_update")} brings main into this Thread's branch and reports conflicts the same way the Git sidebar does.` }
    return undefined
  }
  if (program === "gh") {
    const gh = ghCommand(argv)
    if (!gh || placeOf(thread, segment.cwd) === "elsewhere") return undefined
    if (gh.group === "pr" && gh.command === "create")
      return { kind: "warn", family: "pull-request", rule: "gh-pr-create", message: `Call ${n("pull_request_open")} instead: it pushes the branch and opens or updates its pull request the way the Git sidebar's button does, so the person sees it in Mako.` }
    if (gh.group === "pr" && gh.command === "merge")
      return { kind: "deny", family: "pull-request", rule: "gh-pr-merge", message: `Call ${n("pull_request_merge")} instead, and only when the person asked or you're on full access with merging as the next step of your work: it merges the way the Git sidebar does and cleans up after.` }
    if (gh.group === "pr" && (gh.command === "edit" || gh.command === "ready"))
      return { kind: "warn", family: "pull-request", rule: "gh-pr-edit", message: `${n("pull_request_open")} updates the branch's pull request (title, body, draft) too.` }
    const watches = gh.args.includes("--watch") || (gh.group === "run" && gh.command === "watch")
    if (watches)
      return { kind: "warn", family: "polling", rule: "gh-watch", message: `${n("pull_request_status")} reads the checks and failed logs once; rather than watching, end your turn and say what you're waiting on, or start a Fin for it.` }
    if ((gh.group === "pr" && (gh.command === "checks" || gh.command === "view" || gh.command === "status")) || (gh.group === "run" && (gh.command === "view" || gh.command === "list")))
      return { kind: "warn", family: "pull-request", rule: "gh-pr-status", message: `${n("pull_request_status")} reads this branch's pull request, its checks, reviews and failed logs in one call.` }
    return undefined
  }
  const cli = AGENT_CLIS.get(program)
  if (cli?.(argv.slice(1)))
    return { kind: "warn", family: "agent-cli", rule: `agent-cli-${program}`, message: `An agent started from the shell isn't a Fin: the person can't open, steer or stop it, and nothing wakes you when it ends. Call ${n("agents_start")} with a brief instead (harness: "${program === "cursor-agent" ? "cursor" : program}" for this harness).` }
  if (serverStart(argv)) {
    if (placeOf(thread, segment.cwd) === "elsewhere") return undefined
    const recipe = thread.recipe
    if (recipe?.kind === "ready")
      return { kind: "warn", family: "app", rule: "dev-server", message: `This Thread's app runs from the project's recipe: ${n("app_start")}${recipe.processes.length ? ` (${recipe.processes.join(", ")})` : ""} starts it on the Thread's own ports and keeps it running past your turn, and ${n("app_logs")} and ${n("app_probe")} read it.` }
    if (recipe?.kind === "none")
      return { kind: "warn", family: "app", rule: "dev-server-no-recipe", message: `A server started here stops being anyone's when your turn ends. The project has no recipe yet: ${n("recipe_guide")} sets one up so ${n("app_start")} runs the app on this Thread's own ports.` }
    if (segment.background) return { kind: "warn", family: "background", rule: "background-server", message: `A server left running past your turn is nobody's to stop. ${n("app_start")} runs the project's app for this Thread.` }
    return undefined
  }
  if ((program === "curl" || program === "wget") && thread.recipe?.kind === "ready" && argv.some(ownApp))
    return { kind: "warn", family: "app", rule: "curl-own-app", message: `${n("app_probe")} reads this Thread's app at its own address with the status, timing and a body excerpt, and says when it isn't running; ${n("app_status")} and ${n("app_logs")} say why.` }
  if (program === "lsof" && argv.some((word) => word.startsWith("-i") || word.startsWith("-ti")))
    return { kind: "warn", family: "port", rule: "lsof-port", message: `${n("port_holder")} names who holds a port: which Thread's app, or which process outside Mako.` }
  if ((program === "kill" && argv.some((word) => word.includes("lsof"))) || program === "killall" || (program === "pkill" && argv.includes("-f")))
    return { kind: "warn", family: "port", rule: "kill-by-pattern", message: `Other Threads' agents share this machine, so stop only processes you started. ${n("port_holder")} says who holds a port, and ${n("app_stop")} stops this Thread's app.` }
  if (thread.computer) {
    if (program === "screencapture" || program === "cliclick")
      return { kind: "warn", family: "browser", rule: program, message: `Use the js tool on the mako-computer server for screens, clicks and keys: it shares targets and recordings with the person's view of this Thread. To show the person a picture you made, use ${n("show")}.` }
    if (program === "osascript" && argv.some((word) => /System Events|keystroke|click/.test(word)))
      return { kind: "warn", family: "browser", rule: "osascript-ui", message: "Use the js tool on the mako-computer server to drive apps and the browser: it shares targets and recordings with the person's view of this Thread." }
    if (program === "open" && (argv.some((word) => /^https?:\/\//.test(word)) || (argv.includes("-a") && argv.some((word) => BROWSERS.test(word)))))
      return { kind: "warn", family: "browser", rule: "open-browser", message: `The js tool on the mako-computer server opens and drives a browser you can read back; to put a page or file in front of the person, use ${n("show")}.` }
  }
  if (thread.builds && thread.builds.holders.length >= thread.builds.slots && heavySuite(program, argv.slice(1)))
    return { kind: "warn", family: "build", rule: "build-slots-full", message: `Every build slot on this machine is in use (${thread.builds.holders.join("; ")}), so a suite run now runs beside them and slows every Fin here. ${n("app_check")} waits its turn for one and starts the moment one frees.` }
  if (segment.background && program !== "sleep" && !line.loop)
    return { kind: "warn", family: "background", rule: "background", message: `Work left running past your turn is nobody's to stop or read. ${n("app_start")} runs the project's app, and ${n("agents_start")} runs work the person can open and that reports back.` }
  const seconds = sleepSeconds(argv)
  if (seconds !== undefined && seconds >= LONG_SLEEP_S && !line.loop)
    return { kind: "warn", family: "polling", rule: "long-sleep", message: `Rather than sleeping, end your turn and say what you're waiting for: a Fin's report wakes you, and ${n("app_logs")} and ${n("pull_request_status")} read the app and checks when you're back.` }
  return undefined
}

/** One of the harness's own tools that Mako has its own for, by the name the harness calls it. */
export interface NativeTool {
  /** `EnterWorktree`, `mcp__claude-in-chrome__navigate`, `computerUse`. */
  tool: string
  /** The MCP server, for a tool one serves. */
  server?: string
}

const BROWSER_SERVERS = /^(claude-in-chrome|claude[_-]browser|computer-use|playwright|puppeteer|chrome-devtools|browser-?use|browsermcp|cursor-ide-browser|cursor-browser-extension|node_repl|cua_repl)$/i

/** The route of a harness's own tool: its worktree and browser tools are Mako's where Mako's own are there. */
export function routeNativeTool(thread: CallThread, call: NativeTool, names: ToolNames = bareNames): CallRoute {
  if (call.tool === "EnterWorktree")
    return { kind: "deny", family: "worktree", rule: "native-worktree", message: `Mako doesn't see the harness's own worktrees: its Changes panel, pull request, app and checks follow only this Thread's checkouts. Call ${names("worktree_move")} to work on this Thread's own branch, or ${names("agents_start")} with a workspace for parallel work on a branch of its own.` }
  if (thread.computer && call.server !== undefined && BROWSER_SERVERS.test(call.server))
    return { kind: "warn", family: "browser", rule: "native-browser", message: `Use the js tool on the mako-computer server for browser and computer use in this Thread: it shares targets, sign-ins and recordings with the person's view of the Thread. Another browser is fine when it fails.` }
  return { kind: "allow" }
}

/**
 * How a harness's driver delivers these routes, declared once. `per-call`:
 * the harness asks before each call, by a hook Mako answers in its process
 * or over its server, so a deny's message is what the model reads next.
 * `words`: no hook was seen to work, so the instructions carry the rule.
 */
export type NativeCallsCapability =
  | { kind: "per-call"; via: string; families: readonly CallFamily[]; verified: { version: string; how: string } }
  | { kind: "words"; reason: string }

/** The per-call policy as one value, for a layer that hands it to each harness's adapter (`CallPolicy`). */
export interface NativeCallPolicy {
  shell(thread: CallThread, call: { command: string; cwd?: string }, names?: ToolNames): CallRoute
  tool(thread: CallThread, call: NativeTool, names?: ToolNames): CallRoute
}

export const NATIVE_CALL_POLICY: NativeCallPolicy = { shell: routeShellCall, tool: routeNativeTool }

/** Package-manager scripts and tools that build or run a whole suite: what a build slot is for. */
const HEAVY_SCRIPTS = new Set(["test", "build", "check", "typecheck", "lint", "e2e"])
const HEAVY_TOOLS = new Set(["vitest", "jest", "mocha", "playwright", "xcodebuild", "gradle", "gradlew", "mvn", "bazel", "tsgo"])

/** Whether a command builds or runs a whole suite (`build-slots-full`): its program, or a package script named like one. */
function heavySuite(program: string, args: readonly string[]): boolean {
  if (HEAVY_TOOLS.has(program)) return true
  // A tool run through a package runner is that tool: `npx vitest`, `pnpm exec tsc -b`, `bunx jest`.
  const run = program === "npx" || program === "bunx" ? args : (program === "pnpm" || program === "yarn" || program === "npm") && (args[0] === "exec" || args[0] === "dlx") ? args.slice(1) : undefined
  const tool = run?.find((arg) => !arg.startsWith("-"))
  if (run && tool) return heavySuite(basename(tool), run.slice(run.indexOf(tool) + 1))
  if (program === "tsc") return args.some((arg) => arg === "-b" || arg === "--build" || arg === "-p" || arg === "--project")
  if (program === "cargo" || program === "go" || program === "swift") return ["test", "build", "check"].includes(args[0] ?? "")
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    const words = args.filter((arg) => !arg.startsWith("-"))
    const script = words[0] === "run" || words[0] === "run-script" ? words[1] : words[0]
    return script !== undefined && HEAVY_SCRIPTS.has(script.split(":")[0]!)
  }
  return false
}
