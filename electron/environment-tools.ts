import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { capped, changedSince, socketsOf, systemPortsFrom, writingOf } from "./app-probe.js"
import { z } from "zod"
import { childProcessEnv } from "./accounts-common.js"
import { applyControlEnvironment } from "./control-launch.js"
import type { AppKey, ThreadEnvironment } from "./contracts/thread-environments.js"
import { THREAD_PORT_COUNT, THREAD_PORT_FIRST } from "./contracts/thread-environments.js"
import type { AppActionOutcome, AppCheckView, AppMark, AppOutputChunk, AppOutputCursor, AppOutputKey, AppProcessView, SetupProgress, SetupStep, ThreadAppView } from "./contracts/thread-app.js"
import type { ProjectAppSetup, ProjectRecipeState, RecipeProcessView } from "./contracts/project-app.js"
import { applyThreadEnvironment, type FolderApp } from "./thread-environment.js"
import { ENVIRONMENT_GUIDE } from "./environment-guide.js"
import { grantedSecrets, readAllowedSecrets, writeAllowedSecrets } from "./recipe-secrets.js"
import { carryFiles, carryReport, matchedEntries } from "./worktree-carry.js"
import { memoryPressure, runKey, type AppOverview, type MemoryPressure, type RunSpec, type RunStatus, type ThreadProcesses } from "./thread-processes.js"
import {
  checkoutOf,
  inputsDigest,
  processCwd,
  processPort,
  processValues,
  projectRoot,
  readRecipe,
  recipeHistory,
  recipeValues,
  RECIPE_PATH,
  recipeIssues,
  RecipeSchema,
  saveRecipe,
  type CheckTier,
  type Recipe,
} from "./thread-recipe.js"

/** Under the one minute some agents (Codex) give an MCP tool; longer waits come back as "still starting". */
const SETTLE_MS = 25_000
const FAILURE_LINES = 40
/** Under memory pressure, another Thread's app unused this long is stopped to make room. */
const EVICT_QUIET_MS = 15 * 60 * 1000
const PREPARE_KEY = runKey("prepare", "checkout")
/** How often a start waiting in line looks at memory again. */
const LINE_MS = 5_000
const INSTALL_POLL_MS = 1_000

interface Deps {
  cwd(conversationId: string): string | undefined
  /** The Thread's values now, with the recipe in `cwd`'s checkout. */
  environment(conversationId: string, cwd: string): Promise<ThreadEnvironment | undefined>
  /** What the conversation's agent process was started with. */
  launchedWith(conversationId: string): ThreadEnvironment | undefined
  /** A conversation Mako runs now, to name the Thread setting a project up and say whether its turn is still going; undefined once it's gone. */
  conversation?(conversationId: string): { title: string; harness: string; working: boolean } | undefined
  /** The app in a folder, for a person at the desk; `claim` gives it ports if it has none. */
  folder?(cwd: string, claim: boolean): Promise<FolderApp>
  processes: ThreadProcesses
  /** Where Mako keeps projects' recipes, one file per repository. */
  recipesRoot?: string
  /** Whose app it is, in words, such as `the Thread "Fix login"`, to name whose app was stopped to make room. */
  whose?(app: AppKey): string | undefined
  pressure?: () => Promise<MemoryPressure>
  settleMs?: number
  lineMs?: number
  now?: () => number
}

export interface EnvironmentTools {
  status(conversationId: string): Promise<string>
  start(conversationId: string, names?: string[]): Promise<string>
  stop(conversationId: string, names?: string[]): Promise<string>
  restart(conversationId: string, names?: string[]): Promise<string>
  logs(conversationId: string, target: { process: string } | { check: CheckTier }, lines: number): Promise<string>
  /** What the Thread's app touches outside its checkout and ports, for finding what two copies would fight over. */
  probe(conversationId: string): Promise<string>
  check(conversationId: string, tier: CheckTier): Promise<string>
  port(conversationId: string, port: number): Promise<string>
  save(conversationId: string, recipe: Recipe): Promise<string>
  /** How to set up the recipe; the project shows as being set up by this conversation until its checks pass or its turn ends with one saved. */
  guide(conversationId: string): Promise<string>
  /** The same app, for a person at the desk, by folder. */
  desk: DeskApp
}

/**
 * A folder's app from the desk: what the strip and the terminal dock show,
 * and what their buttons do. Each action waits as the agents' tools do, so
 * a caller that shouldn't wait doesn't await it and reads `view` instead.
 */
export interface DeskApp {
  view(cwd: string): Promise<ThreadAppView>
  start(cwd: string): Promise<AppActionOutcome>
  stop(cwd: string): Promise<void>
  restart(cwd: string): Promise<AppActionOutcome>
  check(cwd: string, tier: CheckTier): Promise<AppActionOutcome>
  /** Stops every other app on this Mac, then starts this one whatever the memory. */
  makeRoom(cwd: string): Promise<AppActionOutcome>
  /** For a recipe that runs one copy at a time: stops the copy another checkout runs, then starts this one. */
  takeTurn(cwd: string): Promise<AppActionOutcome>
  output(cwd: string, key: AppOutputKey, cursor?: AppOutputCursor): Promise<AppOutputChunk>
  /** Every checkout on this Mac whose app isn't stopped, for the sidebar. */
  marks(): Promise<AppMark[]>
  /** The project's recipe written out, with its credentials files, for Settings. */
  setup(cwd: string): Promise<ProjectAppSetup>
  /** The person's answer on the recipe's credentials files: new checkouts get all of them, or none. */
  allowSecrets(cwd: string, allow: boolean): Promise<ProjectAppSetup>
}

interface Context {
  environment: ThreadEnvironment
  checkout: string
}

type Read = Awaited<ReturnType<typeof readRecipe>>

interface RoomReport {
  memory: MemoryPressure
  appsRunningOnThisMac: number
  /** Set while this app's start waits for memory. */
  waitingInLine?: string
}

interface InLine {
  since: number
  again(): Promise<StartOutcome>
}

interface Unprepared {
  message: string
  shown: boolean
  /** The install is still running, rather than failed or refused. */
  installing?: true
}

interface Setup {
  conversation: string
  since: number
  /** A start in the conversation's app came up the way `app_start` reports it: every process still up a moment past its port. */
  appStarted: boolean
}

type StartOutcome =
  | { kind: "nothing" }
  | ({ kind: "blocked" } & Unprepared)
  | { kind: "waiting"; notes: string[]; message: string }
  | { kind: "elsewhere"; whose: string }
  | { kind: "started"; notes: string[]; lines: string[]; refused: { name: string; reason: string }[]; stillStarting: boolean }

export function environmentTools(deps: Deps): EnvironmentTools {
  const settleMs = deps.settleMs ?? SETTLE_MS
  /**
   * Starts waiting in line for memory, oldest first: when each joined, and
   * how to try it again with the recipe as it is then. Whoever asked, the
   * desk shows it waiting, and it starts by itself once there's room.
   */
  const line = new Map<AppKey, InLine>()
  let lineTimer: ReturnType<typeof setTimeout> | undefined
  const pressure = deps.pressure ?? memoryPressure
  const followLine = () => {
    if (lineTimer || !line.size) return
    lineTimer = setTimeout(() => {
      void (async () => {
        if ((await pressure().catch(() => "critical")) === "critical") return
        const [app, next] = [...line.entries()].sort((a, b) => a[1].since - b[1].since)[0]!
        const outcome = await next.again().catch(() => undefined)
        if (outcome?.kind !== "waiting") line.delete(app)
      })().finally(() => {
        lineTimer = undefined
        followLine()
      })
    }, deps.lineMs ?? LINE_MS)
    lineTimer.unref?.()
  }
  /** Starts that found their checkout's install still running, by app: each goes ahead once its install has ended. */
  const afterInstall = new Map<AppKey, () => Promise<StartOutcome>>()
  let installTimer: ReturnType<typeof setTimeout> | undefined
  const followInstalls = () => {
    if (installTimer || !afterInstall.size) return
    installTimer = setTimeout(() => {
      void (async () => {
        for (const [app, again] of [...afterInstall]) {
          const install = (await deps.processes.status(app)).find((entry) => entry.kind === "prepare")
          if (install?.state.kind === "running" || install?.state.kind === "starting") continue
          afterInstall.delete(app)
          await again().catch(() => undefined)
        }
      })().finally(() => {
        installTimer = undefined
        followInstalls()
      })
    }, INSTALL_POLL_MS)
    installTimer.unref?.()
  }
  /**
   * Projects an agent is setting up, by main checkout: the conversation that
   * read the guide, when it did, and whether a start of its Thread's app has
   * come up, since a stopped process leaves no record to read that from later.
   */
  const setups = new Map<string, Setup>()
  /** The conversation whose setup's turn ended before a recipe was saved, by main checkout: it may be asking something. */
  const stoppedSetups = new Map<string, string>()
  const context = async (conversationId: string): Promise<Context & { read: Read }> => {
    const cwd = deps.cwd(conversationId)
    if (!cwd) throw new Error("Mako isn't running this conversation.")
    const environment = await deps.environment(conversationId, cwd)
    if (!environment) throw new Error("This conversation isn't in a Thread yet, so it has no environment of its own.")
    const checkout = await checkoutOf(cwd)
    await deps.processes.touch(environment.app, checkout)
    return { environment, checkout, read: await readRecipe(checkout, environment, deps.recipesRoot) }
  }
  const folderContext = async (cwd: string): Promise<Context & { read: Read }> => {
    if (!deps.folder) throw new Error("This Mako can't run apps from the desk.")
    const found = await deps.folder(cwd, true)
    const environment = found.environment!
    await deps.processes.touch(environment.app, found.checkout)
    return { environment, checkout: found.checkout, read: await readRecipe(found.checkout, environment, deps.recipesRoot) }
  }
  const withRecipe = async (conversationId: string): Promise<Context & { recipe: Recipe }> => ready(await context(conversationId))
  const ready = ({ read, ...rest }: Context & { read: Read }): Context & { recipe: Recipe } => {
    if (read.kind === "none")
      throw new Error("This project has no recipe yet, so Mako has nothing to start or check. Run what you need yourself on this Thread's ports. recipe_guide says how to set one up, which gives every Thread this; do that when the user asks.")
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
  /**
   * Runs the recipe's install and catch-up steps whose inputs changed; a
   * message when the checkout isn't ready yet, `shown` when the desk's view
   * already says why.
   */
  const prepare = async (current: Context & { recipe: Recipe }): Promise<Unprepared | undefined> => {
    const steps = current.recipe.prepare
    if (!steps.length) return undefined
    const { app } = current.environment
    const { checkout } = current
    const settled = async (): Promise<Unprepared | undefined> => {
      const status = (await deps.processes.status(app)).find((entry) => entry.kind === "prepare")
      const record = await deps.processes.prepared(checkout)
      if (status?.state.kind === "running") return { shown: true, installing: true, message: `Preparing this checkout (${status.command}); it keeps going. Call again to wait for it, or app_logs with process "prepare" to watch it.` }
      if (!record.pending) return undefined
      if (!status) {
        // Stopped before it finished, and its run forgotten: it runs again now.
        await deps.processes.savePrepared(checkout, { done: record.done })
        return undefined
      }
      const passed = status.state.kind === "exited" && status.state.code === 0
      await deps.processes.savePrepared(checkout, { done: passed ? { ...record.done, ...record.pending } : record.done })
      if (passed) return undefined
      const tail = await deps.processes.logs(app, PREPARE_KEY, FAILURE_LINES).catch(() => "")
      return { shown: true, message: `Preparing this checkout failed (${describe(status)}), so nothing started. It runs again on the next start.\nLast lines of its log:\n${tail}` }
    }
    const earlier = await settled()
    if (earlier) return earlier
    const record = await deps.processes.prepared(checkout)
    const digests = await Promise.all(steps.map((step) => inputsDigest(checkout, step.inputs)))
    const due = steps.flatMap((step, index) => record.done[step.command] === digests[index] ? [] : [{ command: step.command, digest: digests[index]! }])
    if (!due.length) return undefined
    await deps.processes.savePrepared(checkout, { ...record, pending: Object.fromEntries(due.map((step) => [step.command, step.digest])) })
    const command = due.map((step) => step.command).join(" && ")
    const result = await deps.processes.start(app, [{ kind: "prepare", name: "checkout", command, cwd: checkout, env: env(current, current.recipe) }])
    if (result.refused.length) {
      await deps.processes.savePrepared(checkout, record)
      return { shown: false, message: `This checkout needs preparing (${command}), and ${result.refused[0]!.reason.toLowerCase()}` }
    }
    await deps.processes.settle(app, [PREPARE_KEY], settleMs)
    return settled()
  }
  /** The credentials files the person allowed, into a checkout made before they did; the main checkout has its own. */
  const bringSecrets = async ({ checkout, recipe }: Context & { recipe: Recipe }) => {
    if (!deps.recipesRoot || !recipe.secrets?.length) return
    const root = await projectRoot(checkout)
    if (root === checkout) return
    const granted = grantedSecrets(recipe, await readAllowedSecrets(deps.recipesRoot, checkout))
    if (granted.length) await carryFiles(root, checkout, granted)
  }
  /** Under memory pressure, stops other Threads' quiet apps first; the start waits only while the machine stays critical. */
  const makeRoom = async (app: AppKey): Promise<{ refused?: string; notes: string[] }> => {
    const notes: string[] = []
    if ((await pressure()) === "normal") return { notes }
    const now = (deps.now ?? Date.now)()
    const others = (await deps.processes.active()).filter((entry) => entry.app !== app)
    for (const quiet of others.filter((entry) => entry.usedAt < now - EVICT_QUIET_MS).sort((a, b) => a.usedAt - b.usedAt)) {
      await deps.processes.stop(quiet.app)
      notes.push(`Stopped the quiet app of ${deps.whose?.(quiet.app) || quiet.app} (${bytes(quiet.memoryBytes)}, unused for ${minutes(now - quiet.usedAt)}) to make room.`)
      if ((await pressure()) === "normal") return { notes }
    }
    if ((await pressure()) !== "critical") return { notes: [...notes, "This Mac is short of memory; the app starts anyway."] }
    const running = (await deps.processes.active()).filter((entry) => entry.app !== app)
      .map((entry) => `${deps.whose?.(entry.app) || entry.app} (${bytes(entry.memoryBytes)}, used ${minutes(now - entry.usedAt)} ago)`)
    return {
      notes,
      refused: `Waiting in line for memory: this Mac is critically short of memory${running.length ? `, with these apps running: ${running.join(", ")}` : ""}. Nothing has started yet; Mako starts it by itself once there's room, and app_status shows when. If it can't wait, ask the user whether to stop one of those apps; app_stop takes it out of the line.`,
    }
  }
  const prepareSummary = async (recipe: Recipe, checkout: string) => {
    const { done } = await deps.processes.prepared(checkout)
    return Promise.all(recipe.prepare.map(async (step) => ({
      command: step.command,
      inputs: step.inputs,
      state: done[step.command] === (await inputsDigest(checkout, step.inputs)) ? "up to date" : "runs before the next start or check",
    })))
  }
  /** Other checkouts of this project with the app's processes up: a recipe that runs one copy at a time waits for them. */
  const copiesElsewhere = async (current: Context): Promise<AppKey[]> => {
    const project = await projectRoot(current.checkout)
    const found: AppKey[] = []
    for (const other of await deps.processes.active()) {
      if (other.app === current.environment.app) continue
      const checkout = deps.processes.checkoutOf(other.app)
      if (!checkout || (await projectRoot(checkout).catch(() => checkout)) !== project) continue
      const runs = await deps.processes.status(other.app)
      if (runs.some((run) => run.kind === "process" && (run.state.kind === "running" || run.state.kind === "starting"))) found.push(other.app)
    }
    return found
  }
  /** Starts the named processes, or all; under critical memory it joins the line with `again`, unless `anyway`. */
  const startIn = async (current: Context & { recipe: Recipe }, names: string[] | undefined, again: () => Promise<StartOutcome>, anyway = false): Promise<StartOutcome> => {
    const picked = chosen(current.recipe, names)
    if (!picked.length) return { kind: "nothing" }
    const { app } = current.environment
    const before = await deps.processes.status(app)
    const idle = picked.filter((name) => !before.some((entry) => entry.kind === "process" && entry.name === name && (entry.state.kind === "running" || entry.state.kind === "starting")))
    let notes: string[] = []
    if (idle.length && current.recipe.oneAtATime) {
      const [holder] = await copiesElsewhere(current)
      if (holder) {
        line.delete(app)
        return { kind: "elsewhere", whose: deps.whose?.(holder) || holder }
      }
    }
    if (idle.length) {
      await bringSecrets(current)
      const preparing = await prepare(current)
      if (preparing?.installing) {
        afterInstall.set(app, again)
        followInstalls()
        const { command } = (await deps.processes.status(app)).find((entry) => entry.kind === "prepare")!
        return { kind: "blocked", shown: true, message: `Preparing this checkout (${command}); the app starts by itself once it's done, and app_status shows when. app_logs with process "prepare" watches it.` }
      }
      if (preparing) return { kind: "blocked", ...preparing }
      const room = anyway ? { notes: [] } : await makeRoom(app)
      if (room.refused) {
        line.set(app, { since: line.get(app)?.since ?? (deps.now ?? Date.now)(), again })
        followLine()
        return { kind: "waiting", notes: room.notes, message: room.refused }
      }
      notes = room.notes
    }
    line.delete(app)
    const result = await deps.processes.start(app, await processSpecs(current, current.recipe, picked))
    const statuses = await deps.processes.settle(app, picked.map((name) => runKey("process", name)), settleMs)
    if (Object.keys(current.recipe.processes).every((name) => statuses.find((entry) => entry.name === name)?.state.kind === "running"))
      for (const setup of setups.values()) {
        const cwd = deps.cwd(setup.conversation)
        if (cwd && (await deps.environment(setup.conversation, cwd).catch(() => undefined))?.app === app) setup.appStarted = true
      }
    const lines = await Promise.all(picked.map(async (name) => {
      const refused = result.refused.find((entry) => entry.name === name)
      if (refused) return `${name}: not started. ${refused.reason}`
      const status = statuses.find((entry) => entry.name === name)
      const already = !result.started.includes(name)
      return `${name}: ${describe(status)}${already && status?.state.kind === "running" ? " (it was already running)" : ""}${await failureTail(deps.processes, app, status)}`
    }))
    return { kind: "started", notes, lines, refused: result.refused, stillStarting: statuses.some((status) => status.state.kind === "starting") }
  }
  const startText = (current: Context, outcome: StartOutcome): string => {
    if (outcome.kind === "nothing") return "The recipe names no processes to start."
    if (outcome.kind === "blocked") return outcome.message
    if (outcome.kind === "waiting") return [...outcome.notes, outcome.message].join("\n")
    if (outcome.kind === "elsewhere")
      return `Only one copy of this project's app runs at a time on this Mac (the recipe sets oneAtATime), and ${outcome.whose} has it running, so nothing started here. Ask the user whether to stop that copy; never stop it yourself.`
    return [
      ...outcome.notes,
      ...outcome.lines,
      `App: http://${current.environment.host}:${current.environment.port}`,
      outcome.stillStarting ? `Still starting after ${Math.round(settleMs / 1000)} seconds; call app_status to see when it's up, or app_logs to see why not.` : undefined,
    ].filter(Boolean).join("\n")
  }
  const again = (conversationId: string, names?: string[]) => async (): Promise<StartOutcome> => {
    const current = await withRecipe(conversationId)
    return startIn(current, names, again(conversationId, names))
  }
  const deskAgain = (cwd: string) => async (): Promise<StartOutcome> => startIn(ready(await folderContext(cwd)), undefined, deskAgain(cwd))
  const start = async (conversationId: string, names?: string[]) => {
    const current = await withRecipe(conversationId)
    return startText(current, await startIn(current, names, again(conversationId, names)))
  }
  /** Stops the named processes, or the whole app with its install step and any check under way; finished checks keep their results. */
  const stopIn = async ({ environment, checkout, read }: Context & { read?: Read }, names?: string[]) => {
    if (names?.length && read?.kind === "ready") chosen(read.recipe, names)
    afterInstall.delete(environment.app)
    const runs = await deps.processes.status(environment.app)
    const up = (status: RunStatus) => status.state.kind === "running" || status.state.kind === "starting"
    const picked = runs.filter((status) => names?.length ? status.kind === "process" && names.includes(status.name) : status.kind !== "check" || up(status))
    await deps.processes.stop(environment.app, picked.map((status) => runKey(status.kind, status.name)))
    const inLine = line.delete(environment.app)
    const were = picked.filter(up).map((status) => status.kind === "check" ? `the ${status.name} check` : status.kind === "prepare" ? "the install step" : status.name)
    const { leftovers } = await deps.processes.footprint(environment.app, [checkout, environment.dataDir])
    const left = leftovers.length
      ? ` Still running, though, and likely left behind by the app: ${leftovers.map((entry) => `pid ${entry.pid} (${entry.command})`).join("; ")}. Each started since the app came up, outlived the process that started it and works in this checkout or data folder, so no stop reaches it. Stop one yourself if it's the app's and shouldn't outlive it.`
      : ""
    if (were.length) return `Stopped ${were.join(", ")}, with every process each had started.${left}`
    return (inLine ? "Nothing was running; the start waiting for memory was taken out of the line." : "Nothing was running.") + left
  }
  const probe = async ({ environment, checkout }: Context) => {
    const { pids, leftovers, since, records } = await deps.processes.footprint(environment.app, [checkout, environment.dataDir])
    const [sockets, writing, changed, picked] = await Promise.all([
      socketsOf(pids),
      writingOf(pids, [checkout, environment.dataDir, records]),
      since === undefined ? Promise.resolve(undefined) : changedSince(since, [checkout, environment.dataDir, records, await projectRoot(checkout), join(homedir(), ".mako")]),
      systemPortsFrom(),
    ])
    const last = environment.port + environment.ports - 1
    const ours = (port: number) => (port >= environment.port && port <= last) || port >= picked
    const local = [...new Set(sockets.connected.filter((entry) => entry.local).map((entry) => entry.port))]
      .filter((port) => !sockets.listening.some((entry) => entry.port === port))
    const owners = await Promise.all(local.map(async (port) => {
      const owner = await deps.processes.portOwner(port).catch(() => undefined)
      return { port, owner: owner ? deps.processes.ownerName(owner, environment.app) : "nothing listening now" }
    }))
    const outside = [...new Set(sockets.connected.filter((entry) => !entry.local).map((entry) => `${entry.host}:${entry.port}`))]
    const report = {
      running: pids.length > 0,
      since: since === undefined ? undefined : new Date(since).toISOString(),
      listening: sockets.listening.map((entry) => ({ port: entry.port, pid: entry.pid, ...(ours(entry.port) ? {} : { note: `outside this Thread's ports ${environment.port}-${last}; a second copy would fight over it` }) })),
      connectsTo: owners,
      connectsOutside: capped(outside),
      writing: capped(writing.map((entry) => entry.path)),
      leftovers,
      changedFolders: changed && capped(changed),
      notes: [
        "connectsTo is every port on this Mac the app has a connection to, with who listens there; a service another Thread's app also uses is shared, so each copy needs its own database, namespace or prefix in it.",
        "writing is files the app holds open for writing outside this checkout and this Thread's data folder; two copies writing one file is a conflict.",
        "leftovers look left behind by the app: each started since it came up, outlived the process that started it and works in this checkout or data folder, so stopping the app doesn't end it.",
        "changedFolders is where apps keep state, with something in it changed since the app came up; other apps on this Mac write there too, so look for names of this project or its tools.",
      ],
    }
    return JSON.stringify(report, null, 2)
  }
  const stop = async (conversationId: string, names?: string[]) => stopIn(await context(conversationId), names)
  const checkIn = async (current: Context & { recipe: Recipe }, tier: CheckTier, again: () => Promise<StartOutcome>): Promise<string> => {
    const command = current.recipe.checks[tier]
    if (!command) throw new Error(`The recipe has no ${tier} check.`)
    const { app } = current.environment
    if (tier === "full") {
      const names = Object.keys(current.recipe.processes)
      if (names.length) {
        const running = startText(current, await startIn(current, names, again))
        const statuses = await deps.processes.status(app)
        const down = names.filter((name) => statuses.find((entry) => entry.kind === "process" && entry.name === name)?.state.kind !== "running")
        if (down.length) return `The full check needs the app running, and ${down.join(", ")} isn't up yet:\n${running}`
      }
    }
    else {
      await bringSecrets(current)
      const preparing = await prepare(current)
      if (preparing) return preparing.message
    }
    const key = runKey("check", tier)
    await deps.processes.start(app, [{ kind: "check", name: tier, command, cwd: current.checkout, env: env(current, current.recipe) }])
    const [status] = await deps.processes.settle(app, [key], settleMs)
    const result = checkResult(status)
    if (status?.state.kind === "running") return `The ${tier} check (${command}) is still running after ${Math.round(settleMs / 1000)} seconds. Call app_check with the same tier to keep waiting for this run, or app_logs with check "${tier}" to watch it.`
    const output = await deps.processes.logs(app, key, status?.state.kind === "exited" && status.state.code === 0 ? 15 : 60).catch(() => "")
    return `The ${tier} check (${command}) ${result}.\n${output}`
  }
  /** Why the install step runs now: the first step due, in words. */
  const prepareReason = async (recipe: Recipe, checkout: string): Promise<string> => {
    const { done } = await deps.processes.prepared(checkout)
    if (!Object.keys(done).length) return "this checkout hasn't been set up yet"
    for (const step of recipe.prepare) {
      if (done[step.command] === undefined) return "the recipe's install step changed"
      if (done[step.command] !== await inputsDigest(checkout, step.inputs)) return `${step.inputs.join(", ")} changed`
    }
    return "its inputs changed"
  }
  /**
   * How far a setup has got, read from what Mako itself did for the setup
   * conversation's Thread since it read the guide: whether a recipe reads as
   * ready, whether that Thread's processes came up, and how its checks ended.
   * Nothing depends on the agent saying so.
   */
  const setupProgress = async (setup: Setup): Promise<SetupProgress> => {
    const cwd = deps.cwd(setup.conversation)
    const environment = cwd ? await deps.environment(setup.conversation, cwd) : undefined
    const read = cwd && environment ? await readRecipe(await checkoutOf(cwd), environment, deps.recipesRoot).catch(() => undefined) : undefined
    if (!environment || read?.kind !== "ready") return { recipe: "running", app: "waiting", checks: "waiting" }
    const runs = (await deps.processes.status(environment.app)).filter((entry) => (entry.startedAt ?? 0) >= setup.since)
    const failed = (entry: RunStatus) => entry.state.kind === "ended" || (entry.state.kind === "exited" && entry.state.code !== 0)
    const working = (entry: RunStatus) => entry.state.kind === "starting" || entry.state.kind === "running"
    const processes = Object.keys(read.recipe.processes).map((name) => runs.find((entry) => entry.kind === "process" && entry.name === name))
    const app: SetupStep = setup.appStarted ? "done"
      : processes.some((entry) => entry && failed(entry)) ? "failed"
      : processes.some((entry) => entry && working(entry)) ? "running"
      : "waiting"
    const checks = (["quick", "full"] as const).filter((tier) => read.recipe.checks[tier]).map((tier) => runs.find((entry) => entry.kind === "check" && entry.name === tier))
    const passed = (entry: RunStatus | undefined) => entry?.state.kind === "exited" && entry.state.code === 0
    const checkStep: SetupStep = checks.length && checks.every(passed) ? "done"
      : checks.some((entry) => entry && working(entry)) ? "running"
      : checks.some((entry) => entry && failed(entry)) ? "failed"
      : checks.some(passed) ? "running"
      : "waiting"
    return { recipe: "done", app, checks: checkStep }
  }
  const deskView = async (cwd: string): Promise<ThreadAppView> => {
    if (!deps.folder) throw new Error("This Mako can't run apps from the desk.")
    const found = await deps.folder(cwd, false)
    const environment = found.environment ?? placeholder(found.app)
    let read: Read
    try {
      read = await readRecipe(found.checkout, environment, deps.recipesRoot)
    } catch (error) {
      read = { kind: "invalid", checkout: found.checkout, message: `the recipe couldn't be read: ${error instanceof Error ? error.message : String(error)}` }
    }
    const setup = setups.get(found.root)
    const thread = setup && deps.conversation?.(setup.conversation)
    if (setup && !thread) setups.delete(found.root)
    if (setup && thread) {
      const progress = await setupProgress(setup)
      // Done once its checks pass, or once its turn ends. A turn that ends without a
      // recipe may be asking something, so the project reads as not set up, with a way back to it.
      if (progress.recipe === "done" && (progress.checks === "done" || !thread.working)) setups.delete(found.root)
      else if (thread.working) return { kind: "setting-up", project: found.project, root: found.root, thread: { title: thread.title, harness: thread.harness, conversation: setup.conversation }, progress }
      else {
        setups.delete(found.root)
        stoppedSetups.set(found.root, setup.conversation)
      }
    }
    if (read.kind !== "ready") {
      if (read.kind === "none") {
        const left = stoppedSetups.get(found.root)
        const leftThread = left && deps.conversation?.(left)
        const none: Extract<ThreadAppView, { kind: "none" }> = { kind: "none", project: found.project, root: found.root }
        if (left && leftThread) none.stopped = { title: leftThread.title, conversation: left }
        else if (left) stoppedSetups.delete(found.root)
        return none
      }
      return { kind: "invalid", project: found.project, root: found.root, message: read.message }
    }
    const runs = found.environment ? await deps.processes.status(found.app) : []
    const run = (kind: RunStatus["kind"], name: string) => runs.find((entry) => entry.kind === kind && entry.name === name)
    const processes = Object.entries(read.recipe.processes).map(([name, spec]) => processView(name, found.environment && processPort(spec, found.environment), run("process", name)))
    const checks = (["quick", "full"] as const).flatMap((tier) => {
      const command = read.recipe.checks[tier]
      return command ? [checkView(tier, command, run("check", tier))] : []
    })
    const view: ThreadAppView = { kind: "ready", project: found.project, phase: "stopped", processes, checks }
    if (found.environment) view.address = { host: found.environment.host, port: found.environment.port }
    if (deps.recipesRoot && read.recipe.secrets?.length
      && grantedSecrets(read.recipe, await readAllowedSecrets(deps.recipesRoot, found.checkout)).length < read.recipe.secrets.length)
      view.credentialsWaiting = true
    const up = processes.filter((entry) => entry.state === "running" || entry.state === "starting")
    const started = runs.filter((entry) => entry.kind === "process" && entry.startedAt !== undefined && (entry.state.kind === "running" || entry.state.kind === "starting"))
    if (started.length) view.startedAt = Math.min(...started.map((entry) => entry.startedAt!))
    const installing = run("prepare", "checkout")
    const lastStart = Math.max(0, ...runs.filter((entry) => entry.kind === "process").map((entry) => entry.startedAt ?? 0))
    if (installing?.state.kind === "running" || installing?.state.kind === "starting") {
      view.prepare = { command: installing.command, reason: await prepareReason(read.recipe, found.checkout) }
      view.phase = "preparing"
    }
    else if (installing?.state.kind === "exited" && installing.state.code !== 0 && installing.state.at >= lastStart) {
      view.prepare = { command: installing.command, reason: await prepareReason(read.recipe, found.checkout), exit: { code: installing.state.code, at: installing.state.at } }
      view.phase = "crashed"
    }
    else if (processes.some((entry) => entry.state === "exited")) view.phase = "crashed"
    else if (up.some((entry) => entry.state === "starting")) view.phase = "starting"
    else if (up.length) view.phase = "running"
    else if (line.has(found.app)) {
      const others = (await deps.processes.active()).filter((entry) => entry.app !== found.app)
      view.phase = "waiting"
      view.room = { apps: others.length, bytes: others.reduce((sum, entry) => sum + entry.memoryBytes, 0) }
    }
    else if (read.recipe.oneAtATime) {
      const [holder] = await copiesElsewhere({ environment, checkout: found.checkout })
      if (holder) view.elsewhere = deps.whose?.(holder) || "another checkout of this project"
    }
    return view
  }
  /** What a person should hear after an action; the view shows the rest. */
  const deskOutcome = (outcome: StartOutcome): AppActionOutcome => {
    if (outcome.kind === "nothing") return { problems: ["The recipe names no processes to start."] }
    if (outcome.kind === "blocked") return { problems: outcome.shown ? [] : [outcome.message] }
    if (outcome.kind === "waiting") return { problems: [] }
    if (outcome.kind === "elsewhere") return { problems: [`Only one copy of this app runs at a time, and ${outcome.whose} has it.`] }
    return { problems: outcome.refused.map((entry) => `${entry.name} didn't start: ${entry.reason}`) }
  }
  const roomReport = async (app: AppKey): Promise<RoomReport> => {
    const report: RoomReport = { memory: await pressure(), appsRunningOnThisMac: (await deps.processes.active()).length }
    const queued = line.get(app)
    if (queued) report.waitingInLine = `since ${minutes((deps.now ?? Date.now)() - queued.since)} ago; it starts by itself once there's room`
    return report
  }
  const setupView = async (cwd: string): Promise<{ view: ProjectAppSetup; read: Read; checkout: string }> => {
    if (!deps.folder) throw new Error("This Mako can't run apps from the desk.")
    const found = await deps.folder(cwd, false)
    const read = await readRecipe(found.checkout, found.environment ?? placeholder(found.app), deps.recipesRoot)
    const view: ProjectAppSetup = { project: found.project, root: found.root, recipe: await recipeState(read) }
    const patterns = read.kind === "ready" ? read.recipe.secrets ?? [] : []
    if (read.kind === "ready" && patterns.length) {
      const allowed = deps.recipesRoot ? await readAllowedSecrets(deps.recipesRoot, found.checkout) : undefined
      const granted = grantedSecrets(read.recipe, allowed)
      view.secrets = { patterns, files: await matchedEntries(found.root, patterns).catch(() => []), allowed: granted.length === patterns.length }
      if (view.secrets.allowed && allowed) view.secrets.allowedAt = allowed.at
    }
    return { view, read, checkout: found.checkout }
  }
  const desk: DeskApp = {
    view: deskView,
    async setup(cwd) {
      return (await setupView(cwd)).view
    },
    async allowSecrets(cwd, allow) {
      if (!deps.recipesRoot) throw new Error("This Mako has nowhere to keep recipes.")
      const { read, checkout } = await setupView(cwd)
      if (read.kind !== "ready" || !read.recipe.secrets?.length) throw new Error("This project's recipe names no credentials files.")
      await writeAllowedSecrets(deps.recipesRoot, checkout, allow ? read.recipe.secrets : [], (deps.now ?? Date.now)())
      return (await setupView(cwd)).view
    },
    async start(cwd) {
      return deskOutcome(await startIn(ready(await folderContext(cwd)), undefined, deskAgain(cwd)))
    },
    async stop(cwd) {
      await stopIn(await folderContext(cwd))
    },
    async restart(cwd) {
      const current = ready(await folderContext(cwd))
      await stopIn(current)
      return deskOutcome(await startIn(current, undefined, deskAgain(cwd)))
    },
    async check(cwd, tier) {
      await checkIn(ready(await folderContext(cwd)), tier, deskAgain(cwd))
      return { problems: [] }
    },
    async makeRoom(cwd) {
      const current = ready(await folderContext(cwd))
      const others = (await deps.processes.active()).filter((entry) => entry.app !== current.environment.app)
      for (const other of others) await deps.processes.stop(other.app)
      return deskOutcome(await startIn(current, undefined, deskAgain(cwd), true))
    },
    async takeTurn(cwd) {
      const current = ready(await folderContext(cwd))
      for (const other of await copiesElsewhere(current)) await deps.processes.stop(other)
      return deskOutcome(await startIn(current, undefined, deskAgain(cwd)))
    },
    async output(cwd, key, cursor) {
      if (!deps.folder) throw new Error("This Mako can't run apps from the desk.")
      const found = await deps.folder(cwd, false)
      const empty: AppOutputChunk = { text: "", cursor: cursor ?? { file: "", offset: 0 }, reset: false }
      if (!found.environment) return empty
      return deps.processes.readLog(found.app, outputRun(key), cursor)
    },
    async marks() {
      const marks: AppMark[] = []
      const seen = new Set<AppKey>()
      for (const entry of await deps.processes.overview()) {
        seen.add(entry.app)
        const state = markState(entry.runs) ?? (line.has(entry.app) ? "waiting" : undefined)
        if (!entry.checkout || !state) continue
        const mark: AppMark = { checkout: entry.checkout, state }
        const port = entry.runs.find((run) => run.kind === "process" && run.state.kind === "running" && run.port !== undefined)?.port
        if (state === "running" && port !== undefined) mark.port = port
        marks.push(mark)
      }
      for (const app of line.keys()) {
        const checkout = seen.has(app) ? undefined : deps.processes.checkoutOf(app)
        if (checkout) marks.push({ checkout, state: "waiting" })
      }
      return marks
    },
  }
  return {
    desk,
    async guide(conversationId) {
      const cwd = deps.cwd(conversationId)
      if (cwd) {
        const root = await projectRoot(await checkoutOf(cwd))
        if (setups.get(root)?.conversation !== conversationId)
          setups.set(root, { conversation: conversationId, since: (deps.now ?? Date.now)(), appStarted: false })
        stoppedSetups.delete(root)
      }
      return ENVIRONMENT_GUIDE
    },
    async status(conversationId) {
      const { environment, checkout, read } = await context(conversationId)
      const runs = await deps.processes.status(environment.app)
      const launched = deps.launchedWith(conversationId)
      const values = read.kind === "ready" ? recipeValues(read.recipe, environment) : {}
      const shellValues = launched?.values ?? {}
      const shellMatches = JSON.stringify(Object.entries(shellValues).sort()) === JSON.stringify(Object.entries(values).sort())
      const processNames = read.kind === "ready" ? Object.keys(read.recipe.processes) : []
      const secrets = read.kind === "ready" ? read.recipe.secrets ?? [] : []
      const granted = secrets.length && deps.recipesRoot && read.kind === "ready"
        ? grantedSecrets(read.recipe, await readAllowedSecrets(deps.recipesRoot, checkout))
        : []
      const report = {
        thread: {
          app: `http://${environment.host}:${environment.port}`,
          ports: `${environment.port}-${environment.port + environment.ports - 1}`,
          dataFolder: environment.dataDir,
        },
        recipe: recipeSummary(read),
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
            .map((entry) => ({ ...summary(entry.name, entry.command, entry.port, entry), note: "no longer in the recipe; app_stop with its name stops it" })),
        ],
        prepare: read.kind === "ready" && read.recipe.prepare.length ? await prepareSummary(read.recipe, checkout) : undefined,
        room: await roomReport(environment.app),
        checks: (["quick", "full"] as const).flatMap((tier) => {
          const command = read.kind === "ready" ? read.recipe.checks[tier] : undefined
          const status = runs.find((entry) => entry.kind === "check" && entry.name === tier)
          return command || status ? [checkSummary(tier, command, status)] : []
        }),
        credentials: secrets.length
          ? granted.length === secrets.length
            ? `The user allows ${secrets.join(", ")}, so new checkouts get them from the main checkout. Never read them.`
            : `${secrets.join(", ")} hold credentials, and the user hasn't allowed new checkouts to have them yet (Settings, then Apps, in Mako). A Thread outside the main checkout starts without them; say so if the app fails for want of them. Never copy or read them yourself.`
          : undefined,
        planning: "In plan mode your agent app may refuse app_start and app_check. Don't work around that: say what you'd run, and the user can press Run app at the top right of this Thread.",
      }
      return JSON.stringify(report, null, 2)
    },
    start,
    stop,
    async restart(conversationId, names) {
      const current = await withRecipe(conversationId)
      const picked = chosen(current.recipe, names)
      await deps.processes.stop(current.environment.app, picked.map((name) => runKey("process", name)))
      return startText(current, await startIn(current, picked, again(conversationId, picked)))
    },
    async probe(conversationId) {
      return probe(await context(conversationId))
    },
    async logs(conversationId, target, lines) {
      const { environment } = await context(conversationId)
      const key = "check" in target ? runKey("check", target.check) : target.process === "prepare" ? PREPARE_KEY : runKey("process", target.process)
      return deps.processes.logs(environment.app, key, lines)
    },
    async check(conversationId, tier) {
      return checkIn(await withRecipe(conversationId), tier, again(conversationId))
    },
    async port(conversationId, port) {
      const { environment } = await context(conversationId)
      const owner = await deps.processes.portOwner(port)
      if (!owner) return `Nothing on this Mac listens on port ${port}.`
      return deps.processes.describeHolder(port, environment.app)
    },
    async save(conversationId, recipe) {
      if (!deps.recipesRoot) throw new Error("This Mako has nowhere to keep recipes, so nothing was saved.")
      const { environment, checkout, read } = await context(conversationId)
      const granted = grantedSecrets(recipe, await readAllowedSecrets(deps.recipesRoot, checkout))
      const carried = await carryReport(recipe, await projectRoot(checkout), granted)
      const saved = await saveRecipe(deps.recipesRoot, checkout, recipe, environment)
      const after = await readRecipe(checkout, environment, deps.recipesRoot)
      if (after.kind !== "ready") throw new Error(`Saved to ${saved.file}, but it doesn't read back as ready: ${after.kind === "invalid" ? after.message : "no recipe"}`)
      const running = (await deps.processes.status(environment.app)).some((entry) => entry.kind === "process" && (entry.state.kind === "running" || entry.state.kind === "starting"))
      return [
        `Saved as this project's recipe in Mako, ${saved.file}. Every Thread of this project uses it from now on, on every branch; nothing needs committing or merging for that.`,
        saved.previous ? `The version it replaced is kept at ${saved.previous}.` : read.kind === "none" ? "It's the project's first recipe." : undefined,
        after.ignored ? `This checkout also has a committed ${RECIPE_PATH}; Mako's saved recipe comes first, so that file is ignored while this one exists.` : undefined,
        ...carried,
        running ? "This Thread's processes are still running as they were started; app_restart runs them with this recipe." : undefined,
        "Agents already running keep the values their shell started with; their next Session gets these. Prove it with app_start and app_check.",
      ].filter(Boolean).join("\n")
    },
  }
}

/** The values an app would have, to read its recipe before it has claimed any: the view claims nothing. */
function placeholder(app: AppKey): ThreadEnvironment {
  return { app, host: "localhost", port: THREAD_PORT_FIRST, ports: THREAD_PORT_COUNT, dataDir: "" }
}

function outputRun(key: AppOutputKey): string {
  if (key === "prepare") return PREPARE_KEY
  if (key.startsWith("check:")) return runKey("check", key.slice("check:".length))
  return runKey("process", key.slice("process:".length))
}

/** The desk view's phase from an app's runs alone, as `deskView` orders it; nothing for a stopped app. */
function markState(runs: AppOverview["runs"]): AppMark["state"] | undefined {
  const up = (run: AppOverview["runs"][number]) => run.state.kind === "running" || run.state.kind === "starting"
  const installing = runs.find((run) => run.kind === "prepare" && runKey(run.kind, run.name) === PREPARE_KEY)
  const processes = runs.filter((run) => run.kind === "process")
  const lastStart = Math.max(0, ...processes.map((run) => run.startedAt ?? 0))
  if (installing && up(installing)) return "starting"
  if (installing?.state.kind === "exited" && installing.state.code !== 0 && installing.state.at >= lastStart) return "crashed"
  if (processes.some((run) => run.state.kind === "exited")) return "crashed"
  if (processes.some((run) => run.state.kind === "starting")) return "starting"
  if (processes.some((run) => run.state.kind === "running")) return "running"
  return undefined
}

function processView(name: string, port: number | undefined, status: RunStatus | undefined): AppProcessView {
  const view: AppProcessView = { name, state: "stopped" }
  if (port !== undefined) view.port = port
  if (!status) return view
  if (status.memoryBytes !== undefined) view.memoryBytes = status.memoryBytes
  if (status.state.kind === "running" || status.state.kind === "starting") view.state = status.state.kind
  if (status.state.kind === "exited") {
    view.state = "exited"
    view.exit = { code: status.state.code, afterMs: Math.max(0, status.state.at - (status.startedAt ?? status.state.at)), at: status.state.at }
  }
  return view
}

function checkView(tier: CheckTier, command: string, status: RunStatus | undefined): AppCheckView {
  const view: AppCheckView = { tier, command, state: "never" }
  if (status?.state.kind === "running" || status?.state.kind === "starting") view.state = "running"
  if (status?.state.kind === "exited") {
    view.state = status.state.code === 0 ? "passed" : "failed"
    view.at = status.state.at
  }
  return view
}

interface RecipeSummary {
  state: string
  /** The file in use, or the one that's broken. */
  from?: string
  /** Where Mako keeps this project's recipe; recipe_save writes it. */
  savedIn?: string
  ignored?: string
  problem?: string
  contents?: Recipe
}

function recipeSummary(read: Awaited<ReturnType<typeof readRecipe>>): RecipeSummary {
  const summary: RecipeSummary = { state: "ready" }
  if (read.kind !== "none" && read.from) summary.from = read.from
  if (read.saved) summary.savedIn = read.saved
  if (read.kind === "ready") {
    if (read.ignored) summary.ignored = `${read.ignored}: committed with the project, but the recipe saved in Mako comes first`
    summary.contents = read.recipe
  }
  if (read.kind === "none") summary.state = "none: agents run things themselves on this Thread's ports; recipe_guide says how to set one up"
  if (read.kind === "invalid") {
    summary.state = "broken"
    summary.problem = read.message
  }
  return summary
}

/** The recipe in use, written out for a person: where it's kept, when it was saved, and what it runs. */
async function recipeState(read: Read): Promise<ProjectRecipeState> {
  if (read.kind === "none") return { kind: "none" }
  if (read.kind === "invalid") return read.from ? { kind: "invalid", message: read.message, file: read.from } : { kind: "invalid", message: read.message }
  const { recipe } = read
  const saved = read.from === read.saved
  const state: ProjectRecipeState = {
    kind: "ready",
    source: saved ? "mako" : "committed",
    file: read.from,
    earlier: saved ? (await readdir(recipeHistory(read.from)).catch(() => [])).filter((name) => name.endsWith(".json")).length : 0,
    recipe: {
      values: recipe.values,
      processes: Object.entries(recipe.processes).map(([name, spec]) => {
        const written: RecipeProcessView = { name, command: spec.command }
        if (spec.port) written.port = spec.port
        if (spec.cwd) written.cwd = spec.cwd
        return written
      }),
      checks: recipe.checks,
      prepare: recipe.prepare.map((step) => ({ command: step.command, inputs: step.inputs, outputs: step.outputs ?? [] })),
      carry: recipe.carry ?? [],
      oneAtATime: recipe.oneAtATime ?? false,
    },
  }
  const savedAt = (await stat(read.from).catch(() => undefined))?.mtimeMs
  if (savedAt !== undefined) state.savedAt = Math.round(savedAt)
  if (read.ignored) state.ignored = read.ignored
  return state
}

function bytes(count: number): string {
  if (count >= 1024 ** 3) return `${(count / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(1, Math.round(count / 1024 ** 2))} MB`
}

function minutes(ms: number): string {
  const total = Math.round(ms / 60_000)
  if (total < 60) return `${total} min`
  const hours = Math.round(total / 60)
  return `${hours} hour${hours === 1 ? "" : "s"}`
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
  memory?: string
  log?: string
  note?: string
}

function summary(name: string, command: string, port: number | undefined, status: RunStatus | undefined): ProcessSummary {
  const entry: ProcessSummary = { name, command, state: describe(status) }
  if (port !== undefined) entry.port = port
  if (!status) return entry
  if (status.pid && (status.state.kind === "running" || status.state.kind === "starting")) entry.pid = status.pid
  if (status.startedAt) entry.startedAt = new Date(status.startedAt).toISOString()
  if (status.memoryBytes) entry.memory = bytes(status.memoryBytes)
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

async function failureTail(processes: ThreadProcesses, app: AppKey, status: RunStatus | undefined): Promise<string> {
  if (!status || status.state.kind === "running" || status.state.kind === "starting") return ""
  if (status.state.kind === "exited" && status.state.code === 0) return ""
  const tail = await processes.logs(app, runKey(status.kind, status.name), FAILURE_LINES).catch(() => "")
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
 * The app, recipe and port tools on a conversation's `mako` server. They act
 * on the calling conversation's Thread only: its processes, its ports, its
 * checks. Each description says when to call it, since that's all an agent
 * reads before choosing a tool.
 */
export function registerEnvironmentTools(server: McpServer, tools: EnvironmentTools, conversationId: () => string): void {
  const names = z.object({
    processes: z.array(z.string().min(1).max(32)).max(20).optional().describe("The recipe's process names; all of them when left out."),
  }).strict()
  server.registerTool(
    "app_status",
    {
      description:
        "Call first when you need this Thread's app running or checked, when a start or check went wrong, or before changing the recipe. Returns this Thread's address, ports and data folder; the project's recipe (where it's kept, all of it, the values it sets for this Thread and whether your shell has them); each process's state (running, starting, stopped, or crashed with its exit code); and the last quick and full check results.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(() => tools.status(conversationId()))
  )
  server.registerTool(
    "app_start",
    {
      description:
        "Run this Thread's own copy of the app when you need it running to try or test your change, instead of starting a dev server yourself. Starts the recipe's processes on this Thread's ports and waits up to about 25 seconds for their ports to answer. They keep running after your turn and after Mako restarts, and stay out of other Threads' way. A process whose port something else holds is refused, naming who holds it; when this Mac is critically short of memory, the start waits in line and goes ahead by itself once there's room. Returns each process's state and, for one that crashed, the end of its log.",
      inputSchema: names,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ processes }) => reply(() => tools.start(conversationId(), processes))
  )
  server.registerTool(
    "app_stop",
    {
      description: "Stop this Thread's app when you're done with it or before changing something its processes hold open. Stops only what Mako started for this Thread, each with every process it started; never another Thread's processes or anything Mako didn't start.",
      inputSchema: names,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ processes }) => reply(() => tools.stop(conversationId(), processes))
  )
  server.registerTool(
    "app_restart",
    {
      description: "Stop, then start, this Thread's app: after changing configuration, environment values or dependencies that a running dev server doesn't reload, or after recipe_save changed how its processes start.",
      inputSchema: names,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ processes }) => reply(() => tools.restart(conversationId(), processes))
  )
  server.registerTool(
    "app_logs",
    {
      description: "Read the end of an app process's or a check's output, stdout and stderr together, when one crashed, failed or isn't answering. Name either a process or a check.",
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
    "app_probe",
    {
      description:
        "Call while setting up the recipe, or when two Threads' copies of the app seem to fight, to see what this Thread's app touches outside its own checkout and ports: the ports it listens on, which local services it connects to and who runs them, outside hosts it connects to, files it holds open for writing elsewhere, processes it left behind that a stop won't end, and folders where apps keep state that changed since it came up. Call with the app running, and again after app_stop to see what it left behind.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(() => tools.probe(conversationId()))
  )
  server.registerTool(
    "app_check",
    {
      description:
        "Prove your change works before you report it. \"quick\" runs the recipe's check that needs no running app (such as typecheck, lint and unit tests); \"full\" starts the app first, then runs the project's end-to-end check against it. Runs in this Thread's checkout with this Thread's values and waits up to about 25 seconds; a check still running then keeps going, and calling again with the same tier waits for that run. A passing full check is the proof to report.",
      inputSchema: z.object({ tier: z.enum(["quick", "full"]) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ tier }) => reply(() => tools.check(conversationId(), tier))
  )
  server.registerTool(
    "recipe_guide",
    {
      description:
        "Read before setting up or repairing this project's recipe: when the user asks for every Thread to run or test its own copy of the app, when app_status says there's no recipe or it's broken, or when a change of yours needs a recipe field you don't know yet. Explains where to learn how the project runs, what two copies of the app fight over, every recipe field, and how to prove the result with the app tools. A small edit to a working recipe needs only app_status and recipe_save.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(() => tools.guide(conversationId()))
  )
  server.registerTool(
    "recipe_save",
    {
      description:
        "Replace this project's recipe, which says how every Thread installs, starts and checks the app. Call it when setting one up, when repairing a broken one, and in the same turn as any change of yours that alters how the project installs, starts or is checked: a new install step, a renamed script, a new port, value or service. Pass the whole recipe; app_status shows the current one to edit. Mako checks it against this Thread's ports and this checkout's folders and refuses it with the reason if it can't run; the version it replaces is kept. Mako keeps it for the project, so every Thread on every branch uses it at once and nothing needs committing. Prove it afterwards with app_restart and app_check.",
      inputSchema: z.object({
        recipe: z.record(z.string(), z.unknown()).describe("The whole recipe: values, processes, checks, prepare, and carry, secrets and oneAtATime when it needs them."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ recipe }) => reply(async () => {
      const parsed = RecipeSchema.safeParse(recipe)
      if (!parsed.success) throw new Error(`Not saved: ${recipeIssues(parsed.error)}`)
      return tools.save(conversationId(), parsed.data)
    })
  )
  server.registerTool(
    "port_holder",
    {
      description: "Who holds a port on this Mac: one of this Thread's app processes, another Thread's (named by its title), or a process Mako didn't start. Ask before assuming a port is free, and instead of stopping whatever holds it.",
      inputSchema: z.object({ port: z.number().int().min(1).max(65_535) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ port }) => reply(() => tools.port(conversationId(), port))
  )
}
