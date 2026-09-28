import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { childProcessEnv } from "./accounts-common.js"
import { applyControlEnvironment } from "./control-launch.js"
import type { ThreadEnvironment } from "./contracts/thread-environments.js"
import { applyThreadEnvironment } from "./thread-environment.js"
import { runKey, type RunSpec, type RunStatus, type ThreadProcesses } from "./thread-processes.js"
import {
  checkoutOf,
  processCwd,
  processPort,
  processValues,
  readRecipe,
  recipeValues,
  RECIPE_PATH,
  type CheckTier,
  type Recipe,
} from "./thread-recipe.js"

/** Under the one minute some agents (Codex) give an MCP tool; longer waits come back as "still starting". */
const SETTLE_MS = 25_000
const FAILURE_LINES = 40

interface Deps {
  cwd(conversationId: string): string | undefined
  /** The Thread's values now, with the recipe in `cwd`'s checkout. */
  environment(conversationId: string, cwd: string): Promise<ThreadEnvironment | undefined>
  /** What the conversation's agent process was started with. */
  launchedWith(conversationId: string): ThreadEnvironment | undefined
  processes: ThreadProcesses
  settleMs?: number
}

export interface EnvironmentTools {
  status(conversationId: string): Promise<string>
  start(conversationId: string, names?: string[]): Promise<string>
  stop(conversationId: string, names?: string[]): Promise<string>
  restart(conversationId: string, names?: string[]): Promise<string>
  logs(conversationId: string, target: { process: string } | { check: CheckTier }, lines: number): Promise<string>
  check(conversationId: string, tier: CheckTier): Promise<string>
  port(conversationId: string, port: number): Promise<string>
}

interface Context {
  environment: ThreadEnvironment
  checkout: string
}

export function environmentTools(deps: Deps): EnvironmentTools {
  const settleMs = deps.settleMs ?? SETTLE_MS
  const context = async (conversationId: string): Promise<Context & { read: Awaited<ReturnType<typeof readRecipe>> }> => {
    const cwd = deps.cwd(conversationId)
    if (!cwd) throw new Error("Mako isn't running this conversation.")
    const environment = await deps.environment(conversationId, cwd)
    if (!environment) throw new Error("This conversation isn't in a Thread yet, so it has no environment of its own.")
    const checkout = await checkoutOf(cwd)
    return { environment, checkout, read: await readRecipe(checkout, environment) }
  }
  const withRecipe = async (conversationId: string): Promise<Context & { recipe: Recipe }> => {
    const { read, ...rest } = await context(conversationId)
    if (read.kind === "none")
      throw new Error(`This project has no recipe (${RECIPE_PATH} in ${read.checkout}), so Mako has nothing to start or check. Run what you need yourself on this Thread's ports, and tell the user that setting up full testing would give every Thread this.`)
    if (read.kind === "invalid") throw new Error(`The project's recipe is broken, so nothing can start: ${read.message}`)
    return { ...rest, recipe: read.recipe }
  }
  const chosen = (recipe: Recipe, names?: string[]) => {
    const all = Object.keys(recipe.processes)
    if (!names?.length) return all
    const unknown = names.filter((name) => !all.includes(name))
    if (unknown.length) throw new Error(`The recipe has no process named ${unknown.join(", ")}; it has ${all.join(", ") || "none"}.`)
    return names
  }
  const env = (context: Context, recipe: Recipe, own: Record<string, string> = {}) => {
    const base = childProcessEnv(process.env)
    delete base.ELECTRON_RUN_AS_NODE
    delete base.MAKO_CONVERSATIONS_TOKEN
    applyControlEnvironment(base)
    applyThreadEnvironment(base, { ...context.environment, values: recipeValues(recipe, context.environment) })
    return { ...base, ...own }
  }
  const processSpecs = async (context: Context, recipe: Recipe, names: string[]): Promise<RunSpec[]> =>
    Promise.all(names.map(async (name) => {
      const spec = recipe.processes[name]!
      const run: RunSpec = {
        kind: "process",
        name,
        command: spec.command,
        cwd: await processCwd(context.checkout, name, spec),
        env: env(context, recipe, processValues(recipe, spec, context.environment)),
      }
      const port = processPort(spec, context.environment)
      if (port !== undefined) run.port = port
      return run
    }))
  const start = async (conversationId: string, names?: string[]) => {
    const current = await withRecipe(conversationId)
    const picked = chosen(current.recipe, names)
    if (!picked.length) return "The recipe names no processes to start."
    const thread = current.environment.thread
    const result = await deps.processes.start(thread, await processSpecs(current, current.recipe, picked))
    const statuses = await deps.processes.settle(thread, picked.map((name) => runKey("process", name)), settleMs)
    const lines = await Promise.all(picked.map(async (name) => {
      const refused = result.refused.find((entry) => entry.name === name)
      if (refused) return `${name}: not started. ${refused.reason}`
      const status = statuses.find((entry) => entry.name === name)
      const already = !result.started.includes(name)
      return `${name}: ${describe(status)}${already && status?.state.kind === "running" ? " (it was already running)" : ""}${await failureTail(deps.processes, thread, status)}`
    }))
    const waiting = statuses.some((status) => status.state.kind === "starting")
    return [
      ...lines,
      `App: http://${current.environment.host}:${current.environment.port}`,
      waiting ? `Still starting after ${Math.round(settleMs / 1000)} seconds; call environment_status to see when it's up, or environment_logs to see why not.` : undefined,
    ].filter(Boolean).join("\n")
  }
  const stop = async (conversationId: string, names?: string[]) => {
    const { environment, read } = await context(conversationId)
    if (names?.length && read.kind === "ready") chosen(read.recipe, names)
    const runs = await deps.processes.status(environment.thread)
    const up = (status: RunStatus) => status.state.kind === "running" || status.state.kind === "starting"
    const picked = runs.filter((status) => names?.length ? status.kind === "process" && names.includes(status.name) : status.kind === "process" || up(status))
    await deps.processes.stop(environment.thread, picked.map((status) => runKey(status.kind, status.name)))
    const were = picked.filter(up).map((status) => status.kind === "check" ? `the ${status.name} check` : status.name)
    return were.length ? `Stopped ${were.join(", ")}, with every process each had started.` : "Nothing was running."
  }
  return {
    async status(conversationId) {
      const { environment, checkout, read } = await context(conversationId)
      const runs = await deps.processes.status(environment.thread)
      const launched = deps.launchedWith(conversationId)
      const values = read.kind === "ready" ? recipeValues(read.recipe, environment) : {}
      const shellValues = launched?.values ?? {}
      const shellMatches = JSON.stringify(Object.entries(shellValues).sort()) === JSON.stringify(Object.entries(values).sort())
      const processNames = read.kind === "ready" ? Object.keys(read.recipe.processes) : []
      const report = {
        thread: {
          app: `http://${environment.host}:${environment.port}`,
          ports: `${environment.port}-${environment.port + environment.ports - 1}`,
          dataFolder: environment.dataDir,
        },
        recipe: read.kind === "ready"
          ? { file: `${checkout}/${RECIPE_PATH}`, state: "ready" }
          : read.kind === "none"
            ? { file: `${checkout}/${RECIPE_PATH}`, state: "none: agents run things themselves on this Thread's ports" }
            : { file: `${checkout}/${RECIPE_PATH}`, state: "broken", problem: read.message },
        values,
        yourShell: launched === undefined
          ? "Mako didn't start this agent process with this Thread's values."
          : shellMatches ? "has these values" : `has older values (${JSON.stringify(shellValues)}): the recipe changed after this agent started. The processes above use the new ones; a new Session gets them too.`,
        processes: [
          ...processNames.map((name) => {
            const status = runs.find((entry) => entry.kind === "process" && entry.name === name)
            const spec = read.kind === "ready" ? read.recipe.processes[name] : undefined
            const port = spec && processPort(spec, environment)
            return summary(name, spec?.command ?? "", port, status)
          }),
          ...runs.filter((entry) => entry.kind === "process" && !processNames.includes(entry.name))
            .map((entry) => ({ ...summary(entry.name, entry.command, entry.port, entry), note: "no longer in the recipe; environment_stop with its name stops it" })),
        ],
        checks: (["quick", "full"] as const).flatMap((tier) => {
          const command = read.kind === "ready" ? read.recipe.checks[tier] : undefined
          const status = runs.find((entry) => entry.kind === "check" && entry.name === tier)
          return command || status ? [checkSummary(tier, command, status)] : []
        }),
      }
      return JSON.stringify(report, null, 2)
    },
    start,
    stop,
    async restart(conversationId, names) {
      const current = await withRecipe(conversationId)
      const picked = chosen(current.recipe, names)
      await deps.processes.stop(current.environment.thread, picked.map((name) => runKey("process", name)))
      return start(conversationId, picked)
    },
    async logs(conversationId, target, lines) {
      const { environment } = await context(conversationId)
      const key = "process" in target ? runKey("process", target.process) : runKey("check", target.check)
      return deps.processes.logs(environment.thread, key, lines)
    },
    async check(conversationId, tier) {
      const current = await withRecipe(conversationId)
      const command = current.recipe.checks[tier]
      if (!command) throw new Error(`The recipe has no ${tier} check.`)
      const thread = current.environment.thread
      if (tier === "full") {
        const names = Object.keys(current.recipe.processes)
        if (names.length) {
          const running = await start(conversationId, names)
          const statuses = await deps.processes.status(thread)
          const down = names.filter((name) => statuses.find((entry) => entry.kind === "process" && entry.name === name)?.state.kind !== "running")
          if (down.length) return `The full check needs the app running, and ${down.join(", ")} isn't up yet:\n${running}`
        }
      }
      const key = runKey("check", tier)
      await deps.processes.start(thread, [{ kind: "check", name: tier, command, cwd: current.checkout, env: env(current, current.recipe) }])
      const [status] = await deps.processes.settle(thread, [key], settleMs)
      const result = checkResult(status)
      if (status?.state.kind === "running") return `The ${tier} check (${command}) is still running after ${Math.round(settleMs / 1000)} seconds. Call environment_check with the same tier to keep waiting for this run, or environment_logs with check "${tier}" to watch it.`
      const output = await deps.processes.logs(thread, key, status?.state.kind === "exited" && status.state.code === 0 ? 15 : 60).catch(() => "")
      return `The ${tier} check (${command}) ${result}.\n${output}`
    },
    async port(conversationId, port) {
      const { environment } = await context(conversationId)
      const owner = await deps.processes.portOwner(port)
      if (!owner) return `Nothing on this Mac listens on port ${port}.`
      return deps.processes.describeHolder(port, environment.thread)
    },
  }
}

function describe(status: RunStatus | undefined): string {
  if (!status) return "stopped"
  const state = status.state
  const where = status.port === undefined ? "" : ` on port ${status.port}`
  if (state.kind === "running") return `running${where}`
  if (state.kind === "starting") return `starting; port ${status.port} doesn't answer yet`
  if (state.kind === "exited") return state.code === 0 ? "finished (exit 0)" : `crashed (exit ${state.code})`
  if (state.kind === "ended") return "ended without an exit code (something outside Mako stopped it, or the Mac restarted)"
  return "stopped"
}

interface ProcessSummary {
  name: string
  command: string
  port?: number
  state: string
  pid?: number
  startedAt?: string
  log?: string
  note?: string
}

function summary(name: string, command: string, port: number | undefined, status: RunStatus | undefined): ProcessSummary {
  const entry: ProcessSummary = { name, command, state: describe(status) }
  if (port !== undefined) entry.port = port
  if (!status) return entry
  if (status.pid && (status.state.kind === "running" || status.state.kind === "starting")) entry.pid = status.pid
  if (status.startedAt) entry.startedAt = new Date(status.startedAt).toISOString()
  entry.log = status.log
  return entry
}

interface CheckSummary {
  tier: CheckTier
  command?: string
  result: string
  finishedAt?: string
}

function checkSummary(tier: CheckTier, command: string | undefined, status: RunStatus | undefined): CheckSummary {
  const entry: CheckSummary = { tier, result: checkResult(status) }
  const shown = command ?? status?.command
  if (shown) entry.command = shown
  if (status?.state.kind === "exited") entry.finishedAt = new Date(status.state.at).toISOString()
  return entry
}

function checkResult(status: RunStatus | undefined): string {
  if (!status) return "not run yet"
  if (status.state.kind === "running") return "running"
  if (status.state.kind === "exited") return status.state.code === 0 ? "passed" : `failed (exit ${status.state.code})`
  if (status.state.kind === "ended") return "ended without an exit code"
  return "not run yet"
}

async function failureTail(processes: ThreadProcesses, thread: ThreadEnvironment["thread"], status: RunStatus | undefined): Promise<string> {
  if (!status || status.state.kind === "running" || status.state.kind === "starting") return ""
  if (status.state.kind === "exited" && status.state.code === 0) return ""
  const tail = await processes.logs(thread, runKey(status.kind, status.name), FAILURE_LINES).catch(() => "")
  return tail ? `\nLast lines of its log:\n${tail}` : ""
}

async function reply(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] }
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
  }
}

/**
 * The environment tools beside `js` on a conversation's MCP server. They
 * act on the calling conversation's Thread only: its processes, its ports,
 * its checks.
 */
export function registerEnvironmentTools(server: McpServer, tools: EnvironmentTools, conversationId: () => string): void {
  const names = z.object({
    processes: z.array(z.string().min(1).max(32)).max(20).optional().describe("The recipe's process names; all of them when left out."),
  }).strict()
  server.registerTool(
    "environment_status",
    {
      description:
        "This Thread's running app: its address, ports and data folder, how the project's recipe (.mako/environment.json) resolved for this Thread (the values it sets and whether your shell has them), each recipe process's state (running, starting, stopped, crashed with its exit code), and the last quick and full check results.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(() => tools.status(conversationId()))
  )
  server.registerTool(
    "environment_start",
    {
      description:
        "Start the recipe's processes for this Thread, on this Thread's own ports, and wait up to about 25 seconds for their ports to answer. Processes Mako starts keep running after your turn and after Mako restarts, and they stay out of other Threads' way. A process whose port something else holds is refused, with who holds it. Returns each process's state and, for one that crashed, the end of its log.",
      inputSchema: names,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ processes }) => reply(() => tools.start(conversationId(), processes))
  )
  server.registerTool(
    "environment_stop",
    {
      description: "Stop this Thread's processes that Mako started, each with every process it started. Never touches another Thread's processes or anything Mako didn't start.",
      inputSchema: names,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ processes }) => reply(() => tools.stop(conversationId(), processes))
  )
  server.registerTool(
    "environment_restart",
    {
      description: "Stop, then start, this Thread's recipe processes, for example after changing configuration a dev server doesn't reload.",
      inputSchema: names,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ processes }) => reply(() => tools.restart(conversationId(), processes))
  )
  server.registerTool(
    "environment_logs",
    {
      description: "The end of a recipe process's or check's output, stdout and stderr together. Name either a process or a check.",
      inputSchema: z.object({
        process: z.string().min(1).max(32).optional(),
        check: z.enum(["quick", "full"]).optional(),
        lines: z.number().int().min(1).max(1_000).default(100),
      }).strict().refine((input) => (input.process === undefined) !== (input.check === undefined), "Name a process or a check, not both"),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ process, check, lines }) => reply(() => tools.logs(conversationId(), process === undefined ? { check: check! } : { process }, lines))
  )
  server.registerTool(
    "environment_check",
    {
      description:
        "Run the recipe's quick check (no running app: typecheck, lint, unit tests) or full check (starts the app first, then runs the project's end-to-end check against it) in this Thread's checkout, with this Thread's values. Waits up to about 25 seconds; a check still running then keeps going, and calling this again with the same tier waits for that run. A passing full check is the proof to report.",
      inputSchema: z.object({ tier: z.enum(["quick", "full"]) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ tier }) => reply(() => tools.check(conversationId(), tier))
  )
  server.registerTool(
    "environment_port",
    {
      description: "Who holds a port on this Mac: one of this Thread's processes, another Thread's (named by its title), or a process Mako didn't start. Ask this instead of killing whatever holds a port.",
      inputSchema: z.object({ port: z.number().int().min(1).max(65_535) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ port }) => reply(() => tools.port(conversationId(), port))
  )
}
