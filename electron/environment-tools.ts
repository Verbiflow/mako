import { lstat, readlink, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { capped, changedSince, socketsOf, systemPortsFrom, writingOf } from "./app-probe.js"
import { z } from "zod"
import { childProcessEnv } from "./accounts-common.js"
import { applyControlEnvironment } from "./control-launch.js"
import { AppKeySchema, type AppKey, type ThreadEnvironment } from "./contracts/thread-environments.js"
import { THREAD_PORT_COUNT, THREAD_PORT_FIRST } from "./contracts/thread-environments.js"
import type { AppActionOutcome, AppCheckView, AppMark, AppOutputChunk, AppOutputCursor, AppOutputKey, AppProcessView, RoomApp, RoomFit, RoomView, SetupProgress, SetupStep, ThreadAppView } from "./contracts/thread-app.js"
import type { ProjectAppSetup, ProjectRecipeState, RecipeProcessView } from "./contracts/project-app.js"
import { applyThreadEnvironment, type FolderApp } from "./thread-environment.js"
import { ENVIRONMENT_GUIDE } from "./environment-guide.js"
import { grantedSecrets, readAllowedSecrets, writeAllowedSecrets } from "./recipe-secrets.js"
import { bringFiles, carryReport, isSpareCheckout, linkedEntries, matchedEntries, ownPackages } from "./worktree-carry.js"
import { listed, toolText, when } from "./tool-text.js"
import { cleanOutput, presentOutput } from "./run-output.js"
import { freeMemory, memoryPressure, runKey, type AppOverview, type MemoryLook, type MemoryPressure, type RunKind, type RunSpec, type RunStatus, type ThreadProcesses } from "./thread-processes.js"
import { installsDue, movableInstalls } from "./checkout-install.js"
import { installStatus, settleHanded } from "./spare-install.js"
import {
  checkoutOf,
  inputsDigest,
  processCwd,
  processPort,
  processValues,
  projectRoot,
  appDraft,
  expandTemplate,
  pinRunning,
  publishDraft,
  readRecipe,
  readVersion,
  recipeValues,
  recipeVersions,
  RECIPE_PATH,
  recipeIssues,
  RecipeSchema,
  recordProof,
  runningVersion,
  saveDraft,
  StaleDraftError,
  unpinRunning,
  versionCount,
  type CheckTier,
  type Recipe,
  type RecipeProofStep,
  type RecipeRead,
  type RecipeVerify,
} from "./thread-recipe.js"

/** Under the minute most harnesses' MCP clients give a tool call; longer waits come back as "still starting". */
const SETTLE_MS = 25_000
/** While the Room is open its memory figures are this fresh: a look reads the process table (about 35 ms) and the footprint of each process whose size moved (about 30 ms of CPU each). */
const ROOM_MEMORY_MS = 15_000
/**
 * How long app_check waits for a result, by harness: Codex gives Mako's
 * own servers fifteen minutes (mcp-runtime.ts), and Claude bounds an MCP
 * call by nothing by default. The others get SETTLE_MS.
 */
const CHECK_WAIT_MS = new Map([["codex", 10 * 60_000], ["claude", 10 * 60_000]])
/** Under memory pressure, another Thread's app unused this long is stopped to make room. */
const EVICT_QUIET_MS = 15 * 60 * 1000
const PREPARE_KEY = runKey("prepare", "checkout")
/** How often a start waiting in line looks at memory again. */
const LINE_MS = 5_000
const INSTALL_POLL_MS = 1_000
/** How long a proof waits for the draft's processes to come up, and for each of its verify commands. */
const PROOF_START_MS = 5 * 60_000
const PROOF_VERIFY_MS = 30 * 60_000
/** A recipe's cleanup that takes longer than this is stopped, and the worktree goes anyway. */
const CLEANUP_MS = 2 * 60_000

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
  /** The Worktree Thread whose app it is, for the Room. */
  owner?(app: AppKey): { id: string; title: string } | undefined
  pressure?: () => Promise<MemoryPressure>
  freeMemory?: () => Promise<{ freeBytes: number; totalBytes: number } | undefined>
  settleMs?: number
  lineMs?: number
  now?: () => number
}

export interface EnvironmentTools {
  status(conversationId: string): Promise<string>
  start(conversationId: string, names?: string[], target?: string): Promise<string>
  stop(conversationId: string, names?: string[]): Promise<string>
  restart(conversationId: string, names?: string[], target?: string): Promise<string>
  logs(conversationId: string, target: { process: string } | { check: CheckTier }, lines: number): Promise<string>
  /** What the Thread's app touches outside its checkout and ports, for finding what two copies would fight over. */
  probe(conversationId: string): Promise<string>
  /** Linked package folders made the checkout's own, so an install there can't write into the main checkout. */
  ownPackages(conversationId: string): Promise<string>
  check(conversationId: string, tier: CheckTier, target?: string): Promise<string>
  port(conversationId: string, port: number): Promise<string>
  /** Saves the recipe as a draft only this Thread runs. */
  save(conversationId: string, recipe: Recipe, reason?: string): Promise<string>
  /** Proves this Thread's draft, then publishes it to every Thread; `checked` is how the agent's own checks went. */
  publish(conversationId: string, checked?: AgentCheck[]): Promise<string>
  /** Runs the recipe's cleanup for a worktree about to be removed; what happened, or nothing when there's none to run. */
  cleanup(checkout: string): Promise<string | undefined>
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
  /** Every app running or waiting for memory on this Mac, with what each holds and how many more fit; the marks come with it. */
  room(): Promise<RoomView>
  /** Stops each app, as its own Stop does; one waiting for memory leaves the line. */
  stopApps(apps: string[]): Promise<void>
  /** The project's recipe written out, with its credentials files, for Settings. */
  setup(cwd: string): Promise<ProjectAppSetup>
  /** The person's answer on the recipe's credentials files: new checkouts get all of them, or none. */
  allowSecrets(cwd: string, allow: boolean): Promise<ProjectAppSetup>
}

interface Context {
  environment: ThreadEnvironment
  checkout: string
}

type Read = RecipeRead
type Ready = Context & { recipe: Recipe; read: Extract<Read, { kind: "ready" }> }

/** How one of the recipe's `check` verifications went, in the publishing agent's words. */
export interface AgentCheck {
  target?: string
  passed: boolean
  how: string
}

/** One of a recipe's verifications: the recipe's own, or a target's. */
interface Verification {
  /** In a proof's steps: `verify`, or `verify web`. */
  label: string
  /** The run it's kept as: `verify`, or `verify-web`. */
  run: string
  target?: string
  verify: RecipeVerify
}

type ProofOutcome =
  | { kind: "failed" | "published"; text: string }
  | { kind: "checking"; text: string; checks: Verification[]; steps: RecipeProofStep[]; up: Record<string, number>; startedAt: number }

interface ProofRun {
  version: number
  startedAt: number
  /** What it's doing now, for a call that finds it still going. */
  step: string
  done: Promise<ProofOutcome>
  outcome?: ProofOutcome
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
  | { kind: "started"; notes: string[]; lines: string[]; refused: { name: string; reason: string }[]; stillStarting: boolean; address?: string }

/** What every command Mako runs for an app starts from: the host's environment without Mako's own secrets, with the Thread's values when there's a Thread. */
export function commandEnvironment(environment?: ThreadEnvironment): NodeJS.ProcessEnv {
  const base = childProcessEnv(process.env)
  delete base.ELECTRON_RUN_AS_NODE
  delete base.MAKO_CONVERSATIONS_TOKEN
  applyControlEnvironment(base)
  applyThreadEnvironment(base, environment)
  return base
}

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
  /** The run installing a checkout: one a spare checkout handed over with it, else the app's own. */
  const installOf = async (app: AppKey, checkout: string) => {
    const carrier = (await deps.processes.prepared(checkout)).by ?? app
    return { carrier, status: await installStatus(deps.processes, carrier) }
  }
  /** Starts that found their checkout's install still running, by app: each goes ahead once its install has ended. */
  const afterInstall = new Map<AppKey, { checkout: string; again: () => Promise<StartOutcome> }>()
  let installTimer: ReturnType<typeof setTimeout> | undefined
  const followInstalls = () => {
    if (installTimer || !afterInstall.size) return
    installTimer = setTimeout(() => {
      void (async () => {
        for (const [app, { checkout, again }] of Array.from(afterInstall)) {
          const install = (await installOf(app, checkout)).status
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
  const appUp = async (app: AppKey) =>
    (await deps.processes.status(app)).some((run) => run.kind === "process" && (run.state.kind === "running" || run.state.kind === "starting"))
  /**
   * The recipe an app runs: its draft if it has one, else the version its
   * running processes started with, else the published one. A version
   * published while the app runs reaches it at its next start.
   */
  const readFor = async (checkout: string, environment: ThreadEnvironment): Promise<Read> => {
    const read = await readRecipe(checkout, environment, deps.recipesRoot)
    if (read.kind !== "ready" || read.draft || read.version === undefined || !read.saved) return read
    const pinned = await runningVersion(read.saved, environment.app)
    if (pinned === undefined || pinned === read.version) return read
    if (!(await appUp(environment.app))) {
      await unpinRunning(read.saved, environment.app)
      return read
    }
    const record = await readVersion(read.saved, pinned)
    if (!record) return read
    return { ...read, recipe: record.recipe, version: pinned, from: join(recipeVersions(read.saved), `${pinned}.json`), newer: read.version }
  }
  const context = async (conversationId: string): Promise<Context & { read: Read }> => {
    const cwd = deps.cwd(conversationId)
    if (!cwd) throw new Error("Mako isn't running this conversation.")
    const environment = await deps.environment(conversationId, cwd)
    if (!environment) throw new Error("This conversation isn't in a Thread yet, so it has no app or ports of its own.")
    const checkout = await checkoutOf(cwd)
    await deps.processes.touch(environment.app, checkout)
    return { environment, checkout, read: await readFor(checkout, environment) }
  }
  const folderContext = async (cwd: string): Promise<Context & { read: Read }> => {
    if (!deps.folder) throw new Error("This Mako can't run apps from the desk.")
    const found = await deps.folder(cwd, true)
    const environment = found.environment!
    await deps.processes.touch(environment.app, found.checkout)
    return { environment, checkout: found.checkout, read: await readFor(found.checkout, environment) }
  }
  const withRecipe = async (conversationId: string): Promise<Ready> => ready(await context(conversationId))
  const ready = ({ read, ...rest }: Context & { read: Read }): Ready => {
    if (read.kind === "none")
      throw new Error("This project has no recipe yet, so Mako has nothing to start or check. Run what you need yourself on this Thread's ports. recipe_guide says how to set one up, which gives every Thread this; do that when the user asks.")
    if (read.kind === "invalid") throw new Error(`The project's recipe is broken, so nothing can start: ${read.message}`)
    return { ...rest, recipe: read.recipe, read }
  }
  /** The processes to run: those named, a target's, or with neither the first target's, or every process when the recipe has no targets. */
  const chosen = (recipe: Recipe, names?: string[], target?: string) => {
    const all = Object.keys(recipe.processes)
    if (target !== undefined) {
      const found = recipe.targets?.[target]
      if (!found) throw new Error(`The recipe has no target named ${target}; it has ${Object.keys(recipe.targets ?? {}).join(", ") || "none"}.`)
      if (names?.length) throw new Error("Name processes or a target, not both.")
      return found.processes
    }
    if (!names?.length) return Object.values(recipe.targets ?? {})[0]?.processes ?? all
    const unknown = names.filter((name) => !all.includes(name))
    if (unknown.length) throw new Error(`The recipe has no process named ${unknown.join(", ")}; it has ${all.join(", ") || "none"}.`)
    return names
  }
  const env = (context: Context, recipe: Recipe, own: Record<string, string> = {}) =>
    ({ ...commandEnvironment({ ...context.environment, values: recipeValues(recipe, context.environment) }), ...own })
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
      if (spec.ready) run.ready = spec.ready
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
      const record = await deps.processes.prepared(checkout)
      const status = await installStatus(deps.processes, record.by ?? app)
      if (status?.state.kind === "running") {
        const handed = record.by ? ", which started before this Thread took the checkout" : ""
        return { shown: true, installing: true, message: `Preparing this checkout (${status.command})${handed}; it keeps going. Call again to wait for it, or app_logs with process "prepare" to watch it.` }
      }
      if (!record.pending) return undefined
      // A spare checkout's install ran without this Thread's values; what it didn't finish runs now as the Thread's own.
      if (record.by) {
        const passed = status?.state.kind === "exited" && status.state.code === 0
        await settleHanded(deps.processes, checkout, passed ? await movableInstalls(checkout, steps, record.pending) : {})
        return undefined
      }
      if (!status) {
        // Stopped before it finished, and its run forgotten: it runs again now.
        await deps.processes.savePrepared(checkout, { done: record.done })
        return undefined
      }
      const passed = status.state.kind === "exited" && status.state.code === 0
      await deps.processes.savePrepared(checkout, { done: passed ? { ...record.done, ...record.pending } : record.done })
      if (passed) return undefined
      return { shown: true, message: `Preparing this checkout ${checkResult(status)}${took(status)}, so nothing started; it runs again on the next start. It ran: ${status.command}\n\n${await runOutput(deps.processes, app, PREPARE_KEY)}` }
    }
    const earlier = await settled()
    if (earlier) return earlier
    const record = await deps.processes.prepared(checkout)
    const due = await installsDue(checkout, steps, record.done)
    if (!due.length) return undefined
    // An install over the links would write into the main checkout's packages.
    if (due.some(({ step }) => step.link)) await ownPackages(checkout, due.map(({ step }) => step))
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
  /** Catch up older worktrees with the recipe's files and approved credentials, keeping their own edits. */
  const bringCheckoutFiles = async ({ checkout, recipe }: Context & { recipe: Recipe }) => {
    const root = await projectRoot(checkout)
    if (root === checkout) return
    const granted = deps.recipesRoot ? grantedSecrets(recipe, await readAllowedSecrets(deps.recipesRoot, checkout)) : []
    await bringFiles(root, checkout, [...(recipe.carry ?? []), ...granted].map((path) => ({ path })), granted)
  }
  /** Under memory pressure, stops other Threads' quiet apps first; the start waits only while the machine stays critical. */
  const makeRoom = async (app: AppKey): Promise<{ refused?: string; notes: string[] }> => {
    const notes: string[] = []
    if ((await pressure()) === "normal") return { notes }
    const now = (deps.now ?? Date.now)()
    const others = (await deps.processes.active()).filter((entry) => entry.app !== app)
    // A spare checkout's install is for a Thread nobody has started yet, so it goes first; one handed to a Thread left a link where it was.
    const ahead = (await Promise.all(others.map(async (entry) => {
      const checkout = deps.processes.checkoutOf(entry.app)
      return checkout && isSpareCheckout(checkout) && !(await lstat(checkout).catch(() => undefined))?.isSymbolicLink() ? [entry] : []
    }))).flat()
    if (ahead.length) {
      for (const entry of ahead) await deps.processes.stop(entry.app)
      notes.push(`Stopped the install of ${ahead.length === 1 ? "a checkout" : `${ahead.length} checkouts`} kept ready for new Threads, to make room.`)
      if ((await pressure()) === "normal") return { notes }
    }
    for (const quiet of others.filter((entry) => !ahead.includes(entry) && entry.usedAt < now - EVICT_QUIET_MS).sort((a, b) => a.usedAt - b.usedAt)) {
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
  const packagesSummary = async (read: Read, checkout: string) => {
    if (read.kind !== "ready" || !read.recipe.prepare.some((step) => step.link)) return undefined
    const linked = await linkedEntries(checkout, read.recipe.prepare)
    return linked.length
      ? `${linked.join(", ")} link each package to the main checkout's. Call app_own_packages before you install, add, remove or upgrade a dependency here; an install over the links writes into the main checkout.`
      : "This checkout's own (installed or cloned here, or the main checkout); install as usual."
  }
  const prepareSummary = async (recipe: Recipe, checkout: string) => {
    const { done, pending, by } = await deps.processes.prepared(checkout)
    const root = await projectRoot(checkout)
    const linked = root === checkout ? [] : await linkedEntries(checkout, recipe.prepare)
    const handed = by && (await installStatus(deps.processes, by))?.state.kind === "running" ? pending : undefined
    return Object.fromEntries(await Promise.all(recipe.prepare.map(async (step) => {
      if (handed?.[step.command] !== undefined) return [step.command, "installing now, in a run that started before this Thread took the checkout; a start waits for it"] as const
      const digest = await inputsDigest(checkout, step.inputs)
      // As prepare() decides: linked packages need no install while the inputs match the main checkout's.
      const current = done[step.command] === digest || (step.link === true && linked.length > 0 && (await inputsDigest(root, step.inputs)) === digest)
      return [step.command, current ? "up to date" : "runs before the next start or check"] as const
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
  const startIn = async (current: Ready, names: string[] | undefined, again: () => Promise<StartOutcome>, anyway = false): Promise<StartOutcome> => {
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
    await bringCheckoutFiles(current)
    if (idle.length) {
      const preparing = await prepare(current)
      if (preparing?.installing) {
        afterInstall.set(app, { checkout: current.checkout, again })
        followInstalls()
        const command = (await installOf(app, current.checkout)).status?.command ?? "the recipe's install"
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
    if (idle.length) await deps.processes.ofProject(app, await projectRoot(current.checkout))
    const result = await deps.processes.start(app, await processSpecs(current, current.recipe, picked))
    const fresh = !before.some((entry) => entry.kind === "process" && (entry.state.kind === "running" || entry.state.kind === "starting"))
    if (fresh && result.started.length && current.read.saved && current.read.version !== undefined)
      await pinRunning(current.read.saved, app, current.read.version)
    const statuses = await deps.processes.settle(app, picked.map((name) => runKey("process", name)), settleMs)
    if (picked.every((name) => statuses.find((entry) => entry.kind === "process" && entry.name === name)?.state.kind === "running"))
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
    return { kind: "started", notes, lines, refused: result.refused, stillStarting: statuses.some((status) => status.state.kind === "starting"), address: appAddress(current.recipe, current.environment, [...statuses, ...before]) }
  }
  const startText = (outcome: StartOutcome): string => {
    if (outcome.kind === "nothing") return "The recipe names no processes to start."
    if (outcome.kind === "blocked") return outcome.message
    if (outcome.kind === "waiting") return [...outcome.notes, outcome.message].join("\n")
    if (outcome.kind === "elsewhere")
      return `Only one copy of this project's app runs at a time on this Mac (the recipe sets oneAtATime), and ${outcome.whose} has it running, so nothing started here. Ask the user whether to stop that copy; never stop it yourself.`
    return [
      ...outcome.notes,
      ...outcome.lines,
      outcome.address ? `App: ${outcome.address}` : undefined,
      outcome.stillStarting ? `Still starting after ${Math.round(settleMs / 1000)} seconds; call app_status to see when it's up, or app_logs to see why not.` : undefined,
    ].filter(Boolean).join("\n")
  }
  const again = (conversationId: string, names?: string[]) => async (): Promise<StartOutcome> => {
    const current = await withRecipe(conversationId)
    return startIn(current, names, again(conversationId, names))
  }
  const deskAgain = (cwd: string) => async (): Promise<StartOutcome> => startIn(ready(await folderContext(cwd)), undefined, deskAgain(cwd))
  const start = async (conversationId: string, names?: string[], target?: string) => {
    const current = await withRecipe(conversationId)
    const picked = chosen(current.recipe, names, target)
    return startText(await startIn(current, picked, again(conversationId, picked)))
  }
  /** Stops the named processes, or the whole app with its install step and any check under way; finished checks keep their results. */
  const stopIn = async ({ environment, checkout, read }: Context & { read?: Read }, names?: string[]) => {
    if (names?.length && read?.kind === "ready") chosen(read.recipe, names)
    afterInstall.delete(environment.app)
    const runs = await deps.processes.status(environment.app)
    const up = (status: RunStatus) => status.state.kind === "running" || status.state.kind === "starting"
    const picked = runs.filter((status) => names?.length ? status.kind === "process" && names.includes(status.name) : status.kind !== "check" || up(status))
    await deps.processes.stop(environment.app, picked.map((status) => runKey(status.kind, status.name)))
    // The whole app includes an install a spare checkout handed over with this one.
    const handed = names?.length ? undefined : await installOf(environment.app, checkout)
    if (handed && handed.carrier !== environment.app) {
      await deps.processes.stop(handed.carrier)
      if (handed.status) picked.push(handed.status)
    }
    const inLine = line.delete(environment.app)
    const were = picked.filter(up).map((status) => status.kind === "check" ? `the ${status.name} check` : status.kind === "prepare" ? "the prepare step" : status.name)
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
    const writes = writing.map((entry) => entry.path)
    const notes = [
      owners.length ? "connectsTo is every port on this Mac the app has a connection to, with who listens there; a service another Thread's app also uses is shared, so each copy needs its own database, namespace or prefix in it." : undefined,
      writes.length ? "writing is files the app holds open for writing outside this checkout and this Thread's data folder; two copies writing one file is a conflict." : undefined,
      leftovers.length ? "leftovers, by pid, look left behind by the app: each started since it came up, outlived the process that started it and works in this checkout or data folder, so stopping the app doesn't end it." : undefined,
      changed?.length ? "changedFolders is where apps keep state, with something in it changed since the app came up; other apps on this Mac write there too, so look for names of this project or its tools." : undefined,
    ].filter(Boolean)
    const report = {
      running: pids.length > 0,
      upSince: since === undefined ? undefined : when(since, (deps.now ?? Date.now)()),
      listening: Object.fromEntries(sockets.listening.map((entry) =>
        [entry.port, ours(entry.port) ? `pid ${entry.pid}` : `pid ${entry.pid}; outside this Thread's ports ${environment.port}-${last}, so a second copy would fight over it`])),
      connectsTo: Object.fromEntries(owners.map(({ port, owner }) => [port, owner])),
      connectsOutside: listed(capped(outside)),
      writing: listed(capped(writes)),
      leftovers: Object.fromEntries(leftovers.map((entry) => [entry.pid, entry.command])),
      changedFolders: changed && listed(capped(changed)),
      notes: notes.length ? notes : undefined,
    }
    return toolText(report)
  }
  const stop = async (conversationId: string, names?: string[]) => stopIn(await context(conversationId), names)
  /**
   * Check runs a conversation hasn't had the result of yet, by app, tier and
   * conversation: the run its last app_check started or joined, and that
   * run's result once a newer run replaced it. Its next app_check gets this
   * instead of starting a run, so calling again to wait never loses a result.
   */
  const owed = new Map<string, { startedAt: number; result?: string }>()
  const owedKey = (app: AppKey, tier: CheckTier, conversation: string) => `${app}\0${tier}\0${conversation}`
  const checkRun = async (app: AppKey, tier: CheckTier) => (await deps.processes.status(app)).find((entry) => entry.kind === "check" && entry.name === tier)
  const checkReport = async (app: AppKey, tier: CheckTier, status: RunStatus | undefined, command: string) => {
    const actual = status?.command ?? command
    const stale = actual !== command ? ` It ran ${actual}, and the recipe now names a different ${tier} check, so this run doesn't prove it. Call app_check again to run the current recipe.` : ""
    const passed = status?.state.kind === "exited" && status.state.code === 0
    if (passed) return `The ${tier} check passed${took(status)}.${stale}`
    return `The ${tier} check ${checkResult(status)}${took(status)}.${stale || ` It ran: ${actual}`}\n\n${await runOutput(deps.processes, app, runKey("check", tier))}`
  }
  /** Before a new run replaces a finished one, keeps its result for each conversation still owed it. */
  const keepOwedResults = async (app: AppKey, tier: CheckTier, command: string) => {
    const status = await checkRun(app, tier)
    if (!status || status.state.kind === "running" || status.state.kind === "starting") return
    const waiting = [...owed.entries()].filter(([key, entry]) => key.startsWith(`${app}\0${tier}\0`) && entry.result === undefined && entry.startedAt === status.startedAt)
    if (!waiting.length) return
    const result = await checkReport(app, tier, status, command)
    for (const [, entry] of waiting) entry.result = result
  }
  const checkWait = (conversation?: string) =>
    deps.settleMs ?? (conversation === undefined ? undefined : CHECK_WAIT_MS.get(deps.conversation?.(conversation)?.harness ?? "")) ?? SETTLE_MS
  /** Waits for the check under way, and returns its result or says it's still running. */
  const awaitCheck = async (app: AppKey, tier: CheckTier, command: string, conversation: string | undefined, joined: boolean): Promise<string> => {
    const [status] = await deps.processes.settle(app, [runKey("check", tier)], checkWait(conversation))
    const now = (deps.now ?? Date.now)()
    const joinedNote = joined && status?.startedAt ? ` This call joined a run already under way, started ${when(status.startedAt, now)}.` : ""
    if (status?.state.kind === "running" || status?.state.kind === "starting") {
      const actual = status.command
      const stale = actual !== command ? ` The recipe now names a different ${tier} check; this run doesn't prove it.` : ""
      return `The ${tier} check (${actual}) is still running, ${elapsed(now - (status.startedAt ?? now))} in, and keeps going.${joinedNote} Your next app_check with tier "${tier}" waits for this same run and returns its result, rather than starting another; app_logs with check "${tier}" shows its output so far.${stale}`
    }
    if (conversation !== undefined) owed.delete(owedKey(app, tier, conversation))
    return (await checkReport(app, tier, status, command)) + (joinedNote ? `\n${joinedNote.trim()}` : "")
  }
  const checkIn = async (current: Ready, tier: CheckTier, again: () => Promise<StartOutcome>, conversation?: string, target?: string): Promise<string> => {
    if (target !== undefined && !current.recipe.targets?.[target])
      throw new Error(`The recipe has no target named ${target}; it has ${Object.keys(current.recipe.targets ?? {}).join(", ") || "none"}.`)
    const aimed = target ?? Object.keys(current.recipe.targets ?? {})[0]
    const command = (tier === "full" && aimed !== undefined ? current.recipe.targets?.[aimed]?.full : undefined) ?? current.recipe.checks[tier]
    if (!command) throw new Error(`The recipe has no ${tier} check${aimed !== undefined && tier === "full" ? ` for ${aimed}` : ""}.`)
    const { app } = current.environment
    const mine = conversation === undefined ? undefined : owedKey(app, tier, conversation)
    const waiting = mine === undefined ? undefined : owed.get(mine)
    if (mine !== undefined && waiting) {
      const status = await checkRun(app, tier)
      const up = status?.state.kind === "running" || status?.state.kind === "starting"
      if (waiting.result === undefined && up && status?.startedAt === waiting.startedAt) return awaitCheck(app, tier, command, conversation, false)
      owed.delete(mine)
      const earlier = "This is the run your last app_check left running. If you've changed files since it started, call app_check again for a new run."
      if (waiting.result !== undefined) return `${waiting.result}\n${earlier}`
      if (status?.startedAt === waiting.startedAt) return `${await checkReport(app, tier, status, command)}\n${earlier}`
      return `The ${tier} check your last app_check left running was stopped before it finished, so it has no result. Call app_check again to run it.`
    }
    if (tier === "full") {
      const names = chosen(current.recipe, undefined, aimed)
      if (names.length) {
        const running = startText(await startIn(current, names, again))
        const statuses = await deps.processes.status(app)
        const down = names.filter((name) => statuses.find((entry) => entry.kind === "process" && entry.name === name)?.state.kind !== "running")
        if (down.length) return `The full check needs the app running, and ${down.join(", ")} isn't up yet:\n${running}`
      }
      else await bringCheckoutFiles(current)
    }
    else {
      await bringCheckoutFiles(current)
      const preparing = await prepare(current)
      if (preparing) return preparing.message
    }
    await keepOwedResults(app, tier, command)
    const { started } = await deps.processes.start(app, [{ kind: "check", name: tier, command, cwd: current.checkout, env: env(current, current.recipe) }])
    const run = await checkRun(app, tier)
    if (mine !== undefined && run?.startedAt !== undefined) owed.set(mine, { startedAt: run.startedAt })
    return awaitCheck(app, tier, command, conversation, !started.includes(tier))
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
    const checks = (["quick", "full"] as const).filter((tier) => read.recipe.checks[tier]).map((tier) => runs.find((entry) => entry.kind === "check" && entry.name === tier && entry.command === read.recipe.checks[tier]))
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
    const browser = processes.find((entry) => entry.name === "web" && entry.state === "running" && entry.port !== undefined)
      ?? processes.find((entry) => entry.state === "running" && entry.port !== undefined)
    if (found.environment && browser?.port !== undefined) view.address = { host: found.environment.host, port: browser.port }
    if (deps.recipesRoot && read.recipe.secrets?.length
      && grantedSecrets(read.recipe, await readAllowedSecrets(deps.recipesRoot, found.checkout)).length < read.recipe.secrets.length)
      view.credentialsWaiting = true
    const up = processes.filter((entry) => entry.state === "running" || entry.state === "starting")
    const started = runs.filter((entry) => entry.kind === "process" && entry.startedAt !== undefined && (entry.state.kind === "running" || entry.state.kind === "starting"))
    if (started.length) view.startedAt = Math.min(...started.map((entry) => entry.startedAt!))
    const installing = found.environment ? (await installOf(found.app, found.checkout)).status : undefined
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
  /** The last look at memory, or a new one when that's older than `ms`. */
  const recentMemory = async (ms: number): Promise<MemoryLook | undefined> => {
    const last = deps.processes.lastMemory()
    if (last && (deps.now ?? Date.now)() - last.at < ms) return last
    return deps.processes.memory().catch(() => last)
  }
  /** About how many copies of the project's app fit: those running, and as many more as free memory holds at the median peak. */
  const fitOf = async (root: string, freeBytes: number | undefined, running: number): Promise<RoomFit["estimate"]> => {
    const estimate = await deps.processes.estimate(root)
    if (estimate.kind !== "ready") return estimate
    const fit: RoomFit["estimate"] = { ...estimate, running }
    return freeBytes === undefined ? fit : { ...fit, atOnce: running + Math.floor(freeBytes / estimate.peakBytes) }
  }
  /** Said only once it's known: nothing while Mako is still learning the app's size. */
  const fitText = (estimate: RoomFit["estimate"], freeBytes: number | undefined) => {
    if (estimate.kind === "containers") return "this app starts containers, whose memory Mako can't see, so it can't say how many copies of it fit"
    if (estimate.kind !== "ready" || estimate.atOnce === undefined || freeBytes === undefined) return undefined
    return `each copy of this app peaks around ${bytes(estimate.peakBytes)} (the median of its last ${estimate.runs} runs); with ${bytes(freeBytes)} free, about ${estimate.atOnce} fit at once, counting the ${estimate.running} running now`
  }
  const roomReport = async (app: AppKey, checkout: string): Promise<string> => {
    const [overview, level, free, root] = await Promise.all([deps.processes.overview(), pressure(), (deps.freeMemory ?? freeMemory)().catch(() => undefined), rootOf(checkout)])
    const up = (entry: AppOverview, kind?: RunKind) => entry.runs.some((run) => (!kind || run.kind === kind) && (run.state.kind === "running" || run.state.kind === "starting"))
    const running = overview.filter((entry) => up(entry)).length
    const copies = (await Promise.all(overview.map(async (entry) =>
      up(entry, "process") && (entry.project ?? (entry.checkout ? await rootOf(entry.checkout) : undefined)) === root))).filter(Boolean).length
    const queued = line.get(app)
    return [
      `memory ${level}; ${running} app${running === 1 ? "" : "s"} running on this Mac`,
      fitText(await fitOf(root, free?.freeBytes, copies), free?.freeBytes),
      queued ? `waiting in line for memory since ${minutes((deps.now ?? Date.now)() - queued.since)} ago; it starts by itself once there's room` : undefined,
    ].filter(Boolean).join("; ")
  }
  /** Where each project's main checkout is, by checkout, for apps that ran before Mako kept their project. */
  const roots = new Map<string, string>()
  const rootOf = async (checkout: string) => {
    let root = roots.get(checkout)
    if (root === undefined) {
      root = await projectRoot(checkout).catch(() => checkout)
      roots.set(checkout, root)
    }
    return root
  }
  const roomApp = async (entry: AppOverview, state: AppMark["state"], look: MemoryLook | undefined, overview: AppOverview[]): Promise<RoomApp> => {
    const room: RoomApp = { app: entry.app, kind: entry.app.startsWith("folder-") ? "folder" : "thread", state, runs: [] }
    let checkout = entry.checkout
    if (checkout && isSpareCheckout(checkout)) {
      room.kind = "spare"
      // A spare a Thread took mid-install leaves a link where it was, to the Thread's checkout.
      if ((await lstat(checkout).catch(() => undefined))?.isSymbolicLink()) checkout = await readlink(checkout).catch(() => checkout)
    }
    if (checkout) room.checkout = checkout
    const root = entry.project ?? (checkout ? await rootOf(checkout) : undefined)
    if (root) room.project = { root, name: basename(root) }
    const owner = room.kind === "thread" ? entry.app : overview.find((other) => other.app !== entry.app && other.checkout === checkout && !other.app.startsWith("folder-"))?.app
    const thread = owner ? deps.owner?.(owner) : undefined
    if (thread) room.thread = thread
    const up = entry.runs.filter((run) => run.state.kind === "running" || run.state.kind === "starting")
    room.runs = up.map((run) => run.kind === "process" ? run.name : run.kind === "prepare" ? "install" : `${run.name} check`)
    const port = entry.runs.find((run) => run.kind === "process" && run.state.kind === "running" && run.port !== undefined)?.port
    if (port !== undefined) room.port = port
    const memory = up.length ? look?.apps.get(entry.app) : undefined
    if (memory) room.memoryBytes = memory.bytes
    if (memory?.containers) room.containers = true
    if (up.length && entry.upAt !== undefined) room.upAt = entry.upAt
    if (entry.usedAt) room.usedAt = entry.usedAt
    const queued = line.get(entry.app)
    if (queued) room.waitingSince = queued.since
    return room
  }
  const marksFrom = (overview: AppOverview[]): AppMark[] => {
    const marks: AppMark[] = []
    const seen = new Set<AppKey>()
    for (const entry of overview) {
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
  /** Proofs of drafts, by app: the one under way or last finished, which a later recipe_publish waits for or finishes. */
  const proofs = new Map<AppKey, ProofRun>()
  const whoIs = (conversationId: string) => {
    const thread = deps.conversation?.(conversationId)
    return thread ? `the Thread "${thread.title}" (${thread.harness})` : undefined
  }
  const stepsLine = (steps: RecipeProofStep[]) =>
    steps.map((step) => `${step.name} ${step.passed ? "passed" : "failed"}${step.ms === undefined ? "" : ` in ${elapsed(step.ms)}`}`).join(", ")
  const proofRecord = (current: Ready, steps: RecipeProofStep[], by: string | undefined) => {
    const proof = { at: (deps.now ?? Date.now)(), on: "this Mac", checkout: current.checkout, steps }
    return by ? { ...proof, by } : proof
  }
  /** Publishes the draft Mako proved, unless the app saved another since or another version was published meanwhile. */
  const publishProved = async (current: Ready, version: number, steps: RecipeProofStep[], by: string | undefined, started: number): Promise<ProofOutcome> => {
    const file = current.read.saved!
    const { app } = current.environment
    if ((await appDraft(file, app))?.version !== version)
      return { kind: "failed", text: `Draft ${version} wasn't published: this Thread saved another draft while it was being proven. Call recipe_publish to prove that one.` }
    try {
      await publishDraft(file, app, version, proofRecord(current, steps, by), (deps.now ?? Date.now)())
    } catch (error) {
      if (!(error instanceof StaleDraftError)) throw error
      await recordProof(file, version, proofRecord(current, steps, by))
      const parent = current.read.draft?.parent === undefined ? undefined : await readVersion(file, current.read.draft.parent)
      const since = error.published && parent ? recipeChanges(parent.recipe, error.published.recipe) : []
      return {
        kind: "failed",
        text: [
          `Draft ${version} passed its proof but wasn't published: ${error.message} Publishing it would undo that version's changes.`,
          error.published?.by ? `${error.published.by} published it${error.published.reason ? `: ${error.published.reason}` : ""}.` : undefined,
          since.length ? `What it changed:\n${since.map((change) => `  ${change}`).join("\n")}` : undefined,
          "Make your change on top of it: take the recipe from app_status after app_stop (or the published file it names), apply your change, recipe_save, and recipe_publish again.",
        ].filter(Boolean).join("\n"),
      }
    }
    await pinRunning(file, app, version)
    proofs.delete(app)
    return {
      kind: "published",
      text: `Published version ${version} in ${elapsed((deps.now ?? Date.now)() - started)}: ${stepsLine(steps)}. Every Thread of this project uses it from its next app start; apps already running keep the version they started with until then.`,
    }
  }
  /**
   * Mako's part of a draft's proof: stop the app, install what's due, start
   * every process the recipe's targets need, wait until each is running, and
   * run each `verify.run`. Then either the agent's checks are what's left,
   * or the draft is published.
   */
  const prove = async (current: Ready, run: ProofRun, by: string | undefined): Promise<ProofOutcome> => {
    const { app } = current.environment
    const { recipe } = current
    const version = run.version
    const file = current.read.saved!
    const now = deps.now ?? Date.now
    const steps: RecipeProofStep[] = []
    const fail = async (why: string): Promise<ProofOutcome> => {
      await recordProof(file, version, proofRecord(current, steps, by))
      return { kind: "failed", text: `Draft ${version} wasn't published: ${why}\n\nIt stays this Thread's draft, and every other Thread keeps the published version. Fix it, recipe_save, then recipe_publish again.` }
    }
    const names = [...new Set(recipe.targets ? Object.values(recipe.targets).flatMap((target) => target.processes) : Object.keys(recipe.processes))]
    run.step = "stopping the app to start it fresh"
    await deps.processes.stop(app, Object.keys(recipe.processes).map((name) => runKey("process", name)))
    if (recipe.prepare.length) {
      run.step = "installing"
      const began = now()
      for (;;) {
        const preparing = await prepare(current)
        if (!preparing) break
        if (!preparing.installing) {
          steps.push({ name: "install", passed: false, ms: now() - began })
          return fail(preparing.message)
        }
        await deps.processes.settle(app, [PREPARE_KEY], PROOF_START_MS)
      }
      steps.push({ name: "install", passed: true, ms: now() - began })
    }
    else await bringCheckoutFiles(current)
    if (names.length) {
      run.step = `starting ${names.join(", ")}`
      const began = now()
      const outcome = await startIn(current, names, async () => ({ kind: "nothing" }), true)
      if (outcome.kind !== "started") {
        steps.push({ name: "start", passed: false, ms: now() - began })
        return fail(startText(outcome))
      }
      const statuses = await deps.processes.settle(app, names.map((name) => runKey("process", name)), PROOF_START_MS)
      const down = statuses.filter((status) => status.kind === "process" && status.state.kind !== "running")
      if (down.length || statuses.length < names.length) {
        steps.push({ name: "start", passed: false, ms: now() - began })
        const lines = await Promise.all(names.map(async (name) => {
          const status = statuses.find((entry) => entry.kind === "process" && entry.name === name)
          return `${name}: ${describe(status)}${await failureTail(deps.processes, app, status)}`
        }))
        return fail(`not every process came up within ${elapsed(PROOF_START_MS)}:\n${lines.join("\n")}`)
      }
      steps.push({ name: "start", passed: true, ms: now() - began })
    }
    const verifications = recipeVerifications(recipe)
    for (const verification of verifications) {
      if (!("run" in verification.verify)) continue
      const command = verification.verify.run
      const key = runKey("check", verification.run)
      run.step = `running ${verification.label} (${command})`
      await deps.processes.stop(app, [key])
      await deps.processes.start(app, [{ kind: "check", name: verification.run, command, cwd: current.checkout, env: env(current, recipe) }])
      const [status] = await deps.processes.settle(app, [key], PROOF_VERIFY_MS)
      if (status?.state.kind === "running" || status?.state.kind === "starting") {
        await deps.processes.stop(app, [key])
        steps.push({ name: verification.label, passed: false, ms: PROOF_VERIFY_MS, command })
        return fail(`${verification.label} (${command}) didn't finish within ${elapsed(PROOF_VERIFY_MS)}, so Mako stopped it. A verification proves the recipe works; it isn't a test suite.`)
      }
      const passed = status?.state.kind === "exited" && status.state.code === 0
      steps.push({ name: verification.label, passed, ms: status?.state.kind === "exited" && status.startedAt !== undefined ? status.state.at - status.startedAt : 0, command })
      if (!passed) return fail(`${verification.label} (${command}) ${checkResult(status)}${took(status)}.\n\n${await runOutput(deps.processes, app, key)}`)
    }
    const checks = verifications.filter((verification) => "check" in verification.verify)
    if (!checks.length) return publishProved(current, version, steps, by, run.startedAt)
    const up = Object.fromEntries((await deps.processes.status(app))
      .filter((status) => status.kind === "process" && names.includes(status.name))
      .map((status) => [status.name, status.startedAt ?? 0]))
    const address = appAddress(recipe, current.environment, await deps.processes.status(app))
    return {
      kind: "checking",
      checks,
      steps,
      up,
      startedAt: run.startedAt,
      text: [
        `Draft ${version} is up for your checks: ${steps.length ? stepsLine(steps) : "nothing to install or start"}${address ? `, at ${address}` : ""}. Now check what the recipe asks, yourself:`,
        ...checks.map((check) => `- ${check.target ? `${check.target}: ` : ""}${"check" in check.verify ? expandTemplate(check.verify.check, current.environment) : ""}`),
        "Use whatever shows it: the running app through Mako's computer control, app_logs, a request from your shell. Don't restart the app or save the recipe in between; Mako publishes only the copy it started.",
        `Then call recipe_publish with checked: for each${checks.some((check) => check.target) ? " target" : ""}, whether it passed and, in a sentence or two, how you saw it. That's kept with the version.`,
      ].join("\n"),
    }
  }
  /** The processes that stopped or restarted since a proof started them. */
  const movedSince = async (app: AppKey, up: Record<string, number>) => {
    const statuses = await deps.processes.status(app)
    return Object.entries(up).filter(([name, at]) => {
      const status = statuses.find((entry) => entry.kind === "process" && entry.name === name)
      return status?.state.kind !== "running" || status.startedAt !== at
    }).map(([name]) => name)
  }
  /** Finishes a proof that waits on the agent's checks, with how they went. */
  const finishChecks = async (current: Ready, run: ProofRun | undefined, checked: AgentCheck[], by: string | undefined): Promise<string> => {
    const version = current.read.version!
    const outcome = run?.version === version ? run.outcome : undefined
    if (outcome?.kind !== "checking")
      throw new Error(`Mako hasn't started draft ${version} for your checks yet. Call recipe_publish without checked first: it installs and starts the draft, runs what Mako can, then says what to check.`)
    const moved = await movedSince(current.environment.app, outcome.up)
    if (moved.length)
      throw new Error(`${moved.join(", ")} stopped or restarted after Mako started draft ${version}, so what you checked isn't the copy Mako proved. Call recipe_publish without checked to start it again.`)
    const unknown = checked.filter((check) => !outcome.checks.some((wanted) => wanted.target === check.target))
    if (unknown.length) throw new Error(`The recipe asks for no check ${unknown.map((check) => check.target ?? "without a target").join(", ")}; it asks for ${outcome.checks.map((check) => check.target ?? "one without a target").join(", ")}.`)
    const missing = outcome.checks.filter((wanted) => !checked.some((check) => check.target === wanted.target))
    if (missing.length) throw new Error(`Say how every check went; missing: ${missing.map((check) => check.target ?? "the recipe's check").join(", ")}.`)
    const steps = [...outcome.steps, ...checked.map((check) => ({ name: check.target ? `check ${check.target}` : "check", passed: check.passed, how: check.how }))]
    const failed = checked.filter((check) => !check.passed)
    if (failed.length) {
      await recordProof(current.read.saved!, version, proofRecord(current, steps, by))
      proofs.delete(current.environment.app)
      return `Draft ${version} wasn't published: ${failed.map((check) => check.target ?? "the check").join(", ")} didn't pass. It stays this Thread's draft, and every other Thread keeps the published version. Fix the recipe, recipe_save, and recipe_publish again.`
    }
    return (await publishProved(current, version, steps, by, outcome.startedAt)).text
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
      await stopIn(ready(await folderContext(cwd)))
      return deskOutcome(await startIn(ready(await folderContext(cwd)), undefined, deskAgain(cwd)))
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
      const app = key === "prepare" ? (await installOf(found.app, found.checkout)).carrier : found.app
      return deps.processes.readLog(app, outputRun(key), cursor)
    },
    async marks() {
      return marksFrom(await deps.processes.overview())
    },
    async room() {
      const [overview, level, look] = await Promise.all([
        deps.processes.overview(),
        pressure().catch((): MemoryPressure => "normal"),
        recentMemory(ROOM_MEMORY_MS),
      ])
      const apps: RoomApp[] = []
      const listed = new Set<AppKey>()
      for (const entry of overview) {
        listed.add(entry.app)
        const state = markState(entry.runs) ?? (line.has(entry.app) ? "waiting" : undefined)
        if (state) apps.push(await roomApp(entry, state, look, overview))
      }
      for (const app of line.keys()) {
        if (!listed.has(app)) apps.push(await roomApp({ app, checkout: deps.processes.checkoutOf(app), usedAt: 0, runs: [] }, "waiting", look, overview))
      }
      const roots = new Map(apps.flatMap((entry) => entry.project ? [[entry.project.root, entry.project.name] as const] : []))
      const fits = await Promise.all([...roots].map(async ([root, name]): Promise<RoomFit> => {
        const running = apps.filter((entry) => entry.project?.root === root && entry.kind !== "spare" && entry.state === "running").length
        return { root, name, estimate: await fitOf(root, look?.freeBytes, running) }
      }))
      const view: RoomView = { at: (deps.now ?? Date.now)(), pressure: level, apps, fits, marks: marksFrom(overview) }
      if (look?.freeBytes !== undefined) view.freeBytes = look.freeBytes
      if (look?.totalBytes !== undefined) view.totalBytes = look.totalBytes
      return view
    },
    async stopApps(keys) {
      const apps = keys.map((key) => {
        const app = AppKeySchema.safeParse(key)
        if (!app.success) throw new Error(`${key} isn't an app Mako runs.`)
        return app.data
      })
      for (const app of apps) {
        const checkout = deps.processes.checkoutOf(app)
        const found = checkout && deps.folder ? await deps.folder(checkout, false).catch(() => undefined) : undefined
        // As its own Stop does, where its checkout is still its own; a spare checkout's install has no Thread to ask.
        if (found?.environment?.app === app) {
          await stopIn({ environment: found.environment, checkout: found.checkout })
          continue
        }
        afterInstall.delete(app)
        line.delete(app)
        await deps.processes.stop(app)
      }
    },
  }
  return {
    desk,
    async guide(conversationId) {
      const cwd = deps.cwd(conversationId)
      const environment = cwd ? await deps.environment(conversationId, cwd).catch(() => undefined) : undefined
      if (cwd && environment) {
        const checkout = await checkoutOf(cwd)
        const root = await projectRoot(checkout)
        // Changing a recipe that works leaves every Thread seeing its app as it is.
        const working = (await readRecipe(checkout, environment, deps.recipesRoot).catch(() => undefined))?.kind === "ready"
        if (!working && setups.get(root)?.conversation !== conversationId)
          setups.set(root, { conversation: conversationId, since: (deps.now ?? Date.now)(), appStarted: false })
        if (!working) stoppedSetups.delete(root)
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
      const now = (deps.now ?? Date.now)()
      const recipeProcesses = read.kind === "ready" ? read.recipe.processes : {}
      const checks = (["quick", "full"] as const).flatMap((tier) => {
        const command = read.kind === "ready" ? read.recipe.checks[tier] : undefined
        const status = runs.find((entry) => entry.kind === "check" && entry.name === tier)
        return command || status ? [[tier, checkLine(command, status, now)] as const] : []
      })
      const report = {
        app: read.kind === "ready" ? appAddress(read.recipe, environment, runs) : `http://${environment.host}:${environment.port}`,
        ports: `${environment.port}-${environment.port + environment.ports - 1}`,
        dataFolder: environment.dataDir,
        recipe: recipeSummary(read),
        values: Object.keys(values).length ? values : undefined,
        yourShell: launched === undefined
          ? "Mako didn't start this agent process with this Thread's values."
          : shellMatches ? "has these values"
          : `has ${Object.keys(shellValues).length ? `older values (${Object.entries(shellValues).map(([name, value]) => `${name}=${value}`).join(", ")})` : "none of these values"}: the recipe changed after this agent started. Mako's processes use the new ones; a new Session gets them too.`,
        processes: Object.fromEntries([
          ...processNames.map((name) => {
            const status = runs.find((entry) => entry.kind === "process" && entry.name === name)
            return [name, processLine(processPort(recipeProcesses[name]!, environment), status, now)]
          }),
          ...runs.filter((entry) => entry.kind === "process" && !processNames.includes(entry.name))
            .map((entry) => [entry.name, `${processLine(entry.port, entry, now)}; no longer in the recipe (it ran ${entry.command}), and app_stop with its name stops it`]),
        ]),
        prepare: read.kind === "ready" && read.recipe.prepare.length ? await prepareSummary(read.recipe, checkout) : undefined,
        packages: await packagesSummary(read, checkout),
        room: await roomReport(environment.app, checkout),
        checks: checks.length ? Object.fromEntries(checks) : undefined,
        credentials: secrets.length
          ? granted.length === secrets.length
            ? `The user allows ${secrets.join(", ")}, so worktrees get them from the main checkout. Never read them.`
            : `${secrets.join(", ")} hold credentials, and the user hasn't allowed worktrees to have them yet (Settings, then Apps, in Mako). A worktree's app starts without them; say so if the app fails for want of them. Never copy or read them yourself.`
          : undefined,
      }
      return toolText(report)
    },
    start,
    stop,
    async restart(conversationId, names, target) {
      const current = await withRecipe(conversationId)
      const picked = chosen(current.recipe, names, target)
      await deps.processes.stop(current.environment.app, picked.map((name) => runKey("process", name)))
      // With nothing left running, the app is no longer held to the version it started with.
      const next = (await appUp(current.environment.app)) ? current : await withRecipe(conversationId)
      const restarted = next === current ? picked : chosen(next.recipe, names, target)
      return startText(await startIn(next, restarted, again(conversationId, restarted)))
    },
    async probe(conversationId) {
      return probe(await context(conversationId))
    },
    async ownPackages(conversationId) {
      const current = await withRecipe(conversationId)
      const steps = current.recipe.prepare.filter((step) => step.link)
      const linked = await linkedEntries(current.checkout, steps)
      if (!linked.length)
        return "This checkout's packages are its own already (installed or cloned here, or this is the main checkout), so installing here touches nothing else. Install as you normally would."
      const running = (await deps.processes.status(current.environment.app)).some((entry) => entry.kind === "process" && (entry.state.kind === "running" || entry.state.kind === "starting"))
      const owned = await ownPackages(current.checkout, steps)
      return [
        `${owned.join(", ")} ${owned.length === 1 ? "is" : "are"} now this checkout's own: a copy of the main checkout's packages, so installing here no longer touches the main checkout. Install, add, remove or upgrade packages as you normally would.`,
        running ? "The running app still has the old packages loaded; app_restart it after installing." : undefined,
      ].filter(Boolean).join(" ")
    },
    async logs(conversationId, target, lines) {
      const { environment, checkout } = await context(conversationId)
      const key = "check" in target ? runKey("check", target.check) : target.process === "prepare" ? PREPARE_KEY : runKey("process", target.process)
      const app = key === PREPARE_KEY ? (await installOf(environment.app, checkout)).carrier : environment.app
      return cleanOutput(await deps.processes.logs(app, key, lines))
    },
    async check(conversationId, tier, target) {
      return checkIn(await withRecipe(conversationId), tier, again(conversationId), conversationId, target)
    },
    async port(conversationId, port) {
      const { environment } = await context(conversationId)
      const owner = await deps.processes.portOwner(port)
      if (!owner) return `Nothing on this Mac listens on port ${port}.`
      return deps.processes.describeHolder(port, environment.app)
    },
    async save(conversationId, recipe, reason) {
      if (!deps.recipesRoot) throw new Error("This Mako has nowhere to keep recipes, so nothing was saved.")
      const { environment, checkout, read } = await context(conversationId)
      const granted = grantedSecrets(recipe, await readAllowedSecrets(deps.recipesRoot, checkout))
      const carried = await carryReport(recipe, await projectRoot(checkout), granted)
      const saved = await saveDraft(deps.recipesRoot, checkout, recipe, environment, { by: whoIs(conversationId), reason }, (deps.now ?? Date.now)())
      const after = await readRecipe(checkout, environment, deps.recipesRoot)
      if (after.kind !== "ready") throw new Error(`Saved, but it doesn't read back as ready: ${after.kind === "invalid" ? after.message : "no recipe"}`)
      const running = await appUp(environment.app)
      const changes = read.kind === "ready" ? recipeChanges(read.recipe, after.recipe) : []
      const { version } = saved
      if (version.state === "published")
        return `That's version ${version.version}, the published recipe, so this Thread has no draft any more and runs version ${version.version} like every other Thread.${running ? " Its processes still run as they were started; app_restart runs them with it." : ""}`
      return [
        read.kind === "ready" && read.draft && read.version === version.version
          ? `That's this Thread's draft already, version ${version.version}; nothing changed.`
          : `Saved as draft version ${version.version}${version.parent === undefined ? ", the project's first recipe" : `, made from version ${version.parent}`}. Only this Thread runs it; every other Thread keeps ${saved.published === undefined ? (after.ignored ? `the committed ${RECIPE_PATH}` : "running without a recipe") : `version ${saved.published}`} until it's published.`,
        read.kind === "none"
          ? undefined
          : read.kind === "invalid"
            ? "The recipe it replaces here couldn't be read, so there's nothing to compare it with."
            : changes.length
              ? `Changed from what this Thread ran:\n${changes.map((change) => `  ${change}`).join("\n")}`
              : undefined,
        after.ignored ? `This checkout also has a committed ${RECIPE_PATH}; once this is published, Mako's recipe comes first and that file is ignored.` : undefined,
        ...carried,
        running ? "This Thread's processes still run as they were started; app_restart runs them with the draft." : undefined,
        "Iterate with app_restart and app_check as you need. Once it works, recipe_publish proves it and publishes it to every Thread.",
      ].filter(Boolean).join("\n")
    },
    async publish(conversationId, checked) {
      if (!deps.recipesRoot) throw new Error("This Mako has nowhere to keep recipes.")
      const current = await withRecipe(conversationId)
      const { app } = current.environment
      const version = current.read.version
      if (!current.read.draft || version === undefined || !current.read.saved)
        return version === undefined
          ? "This Thread has no draft to publish. recipe_save makes one."
          : `This Thread has no draft to publish; it runs version ${version}${current.read.newer ? `, and version ${current.read.newer} is published` : ", the published one"}. recipe_save makes a draft.`
      const by = whoIs(conversationId)
      const earlier = proofs.get(app)
      if (checked?.length) return finishChecks(current, earlier, checked, by)
      const reuse = earlier?.version === version
        && (!earlier.outcome || (earlier.outcome.kind === "checking" && !(await movedSince(app, earlier.outcome.up)).length))
      const run: ProofRun = reuse ? earlier : { version, startedAt: (deps.now ?? Date.now)(), step: "starting", done: Promise.resolve({ kind: "failed", text: "" }) }
      if (!reuse) {
        run.done = prove(current, run, by).catch((error: Error) => ({ kind: "failed" as const, text: `Draft ${version} wasn't published: the proof broke off (${error.message}).` }))
        void run.done.then((outcome) => { run.outcome = outcome })
        proofs.set(app, run)
      }
      const waited = await Promise.race([run.done, new Promise<undefined>((done) => setTimeout(() => done(undefined), checkWait(conversationId)).unref?.())])
      if (waited) return waited.text
      return `The proof of draft ${version} is still running (${run.step}), ${elapsed((deps.now ?? Date.now)() - run.startedAt)} in, and keeps going. Call recipe_publish again to wait for this same proof; it doesn't start another.`
    },
    async cleanup(checkout) {
      if (!deps.folder) return undefined
      const found = await deps.folder(checkout, false)
      if (!found.environment) return undefined
      const read = await readFor(found.checkout, found.environment)
      if (read.kind !== "ready" || !read.recipe.cleanup) return undefined
      const { app } = found.environment
      const command = read.recipe.cleanup
      const key = runKey("check", "cleanup")
      await deps.processes.start(app, [{ kind: "check", name: "cleanup", command, cwd: found.checkout, env: env({ environment: found.environment, checkout: found.checkout }, read.recipe) }])
      const [status] = await deps.processes.settle(app, [key], CLEANUP_MS)
      if (status?.state.kind === "running" || status?.state.kind === "starting") {
        await deps.processes.stop(app, [key])
        return `cleanup (${command}) didn't finish within ${elapsed(CLEANUP_MS)}, so Mako stopped it`
      }
      const passed = status?.state.kind === "exited" && status.state.code === 0
      return passed ? `cleanup (${command}) passed${took(status)}` : `cleanup (${command}) ${checkResult(status)}${took(status)}: ${cleanOutput((await deps.processes.output(app, key).catch(() => ({ text: "" }))).text)}`
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

/** A web process is preferred; recipes without one use their first listening process. */
function appAddress(recipe: Recipe, environment: ThreadEnvironment, runs?: RunStatus[]): string | undefined {
  const entries = Object.entries(recipe.processes)
  const active = entries.filter(([name]) => {
    const run = runs?.find((run) => run.kind === "process" && run.name === name)
    return run && run.port !== undefined && (run.state.kind === "running" || run.state.kind === "starting")
  })
  const available = active.length ? active : entries
  const picked = available.find(([name, spec]) => name === "web" && spec.port) ?? available.find(([, spec]) => spec.port)
  if (!picked) return undefined
  const [name, spec] = picked
  const status = runs?.find((run) => run.kind === "process" && run.name === name)
  const port = status && (status.state.kind === "running" || status.state.kind === "starting") ? status.port : processPort(spec, environment)
  return port === undefined ? undefined : `http://${environment.host}:${port}`
}

function processView(name: string, port: number | undefined, status: RunStatus | undefined): AppProcessView {
  const view: AppProcessView = { name, state: "stopped" }
  const listening = status && (status.state.kind === "running" || status.state.kind === "starting") ? status.port : port
  if (listening !== undefined) view.port = listening
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
  if (status && status.command !== command) return view
  if (status?.state.kind === "running" || status?.state.kind === "starting") view.state = "running"
  if (status?.state.kind === "exited") {
    view.state = status.state.code === 0 ? "passed" : "failed"
    view.at = status.state.at
  }
  return view
}

interface RecipeSummary {
  /** Which version this app runs, and whether it's published. */
  version?: string
  /** Set only for a recipe that can't be used, with why. */
  broken?: string
  /** The file in use, or the one that's broken. */
  file?: string
  /** Where recipe_save writes, when that isn't the file in use. */
  savedIn?: string
  ignored?: string
  contents?: Recipe
}

function recipeSummary(read: Awaited<ReturnType<typeof readRecipe>>): RecipeSummary | string {
  if (read.kind === "none") return "none: agents run things themselves on this Thread's ports; recipe_guide says how to set one up"
  const summary: RecipeSummary = {}
  if (read.kind === "invalid") summary.broken = read.message
  if (read.from) summary.file = read.from
  if (read.saved && read.saved !== read.from) summary.savedIn = read.saved
  if (read.kind === "ready" && read.version !== undefined)
    summary.version = read.draft
      ? `${read.version}, this Thread's draft${read.draft.parent === undefined ? "" : `, made from version ${read.draft.parent}`}; only this Thread runs it until recipe_publish proves and publishes it`
      : read.newer !== undefined
        ? `${read.version}, which this app's processes started with; version ${read.newer} is published, and app_restart of the whole app runs it`
        : `${read.version}, published`
  if (read.kind === "ready") {
    if (read.ignored) summary.ignored = `${read.ignored}: committed with the project, but the recipe saved in Mako comes first`
    summary.contents = read.recipe
  }
  return summary
}

/** The recipe in use, written out for a person: where it's kept, when it was saved, and what it runs. */
async function recipeState(read: Read): Promise<ProjectRecipeState> {
  if (read.kind === "none") return { kind: "none" }
  if (read.kind === "invalid") return read.from ? { kind: "invalid", message: read.message, file: read.from } : { kind: "invalid", message: read.message }
  const { recipe } = read
  const saved = read.from === read.saved || read.version !== undefined
  const state: ProjectRecipeState = {
    kind: "ready",
    source: saved ? "mako" : "committed",
    file: read.from,
    earlier: read.saved ? Math.max(0, (await versionCount(read.saved)) - 1) : 0,
    recipe: {
      values: recipe.values,
      processes: Object.entries(recipe.processes).map(([name, spec]) => {
        const written: RecipeProcessView = { name, command: spec.command }
        if (spec.port) written.port = spec.port
        if (spec.cwd) written.cwd = spec.cwd
        return written
      }),
      checks: recipe.checks,
      prepare: recipe.prepare.map((step) => ({ command: step.command, inputs: step.inputs, outputs: step.outputs ?? [], link: step.link === true })),
      carry: recipe.carry ?? [],
      oneAtATime: recipe.oneAtATime ?? false,
    },
  }
  const savedAt = (await stat(read.from).catch(() => undefined))?.mtimeMs
  if (savedAt !== undefined) state.savedAt = Math.round(savedAt)
  if (read.version !== undefined) state.version = read.version
  if (read.draft) state.draft = true
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
  if (state.kind === "starting") return status.ready === undefined ? `starting; port ${status.port} doesn't answer yet` : `starting; its ready command (${status.ready}) hasn't passed yet`
  if (state.kind === "exited") return state.code === 0 ? "finished (exit 0)" : `crashed (exit ${state.code})`
  if (state.kind === "ended") return "ended without an exit code (something outside Mako stopped it, or the Mac restarted)"
  return "stopped"
}

/** A process in one line: its state and port, then for a run Mako knows of, its pid, start, memory and log. */
function processLine(port: number | undefined, status: RunStatus | undefined, now: number): string {
  const up = status?.state.kind === "running" || status?.state.kind === "starting"
  const parts = [describe(status) + (port !== undefined && !(up && status?.port !== undefined) ? ` (port ${port})` : "")]
  if (!status) return parts[0]!
  if (up && status.pid) parts.push(`pid ${status.pid}`)
  if (status.startedAt) parts.push(`started ${when(status.startedAt, now)}`)
  if (status.state.kind === "exited") parts.push(`ended ${when(status.state.at, now)}`)
  if (status.memoryBytes) parts.push(bytes(status.memoryBytes))
  parts.push(`log ${status.log}`)
  return parts.join("; ")
}

/** A check's last result in one line, with its command when the recipe's is different or gone. */
function checkLine(command: string | undefined, status: RunStatus | undefined, now: number): string {
  const result = checkResult(status) + (status?.state.kind === "exited" ? ` ${when(status.state.at, now)}` : "")
  return status && status.command !== command ? `${result}; ran ${status.command}` : result
}

/** How long a finished run took, as " in 2 min 48 s"; nothing for one still going. */
function took(status: RunStatus | undefined): string {
  if (status?.state.kind !== "exited" || status.startedAt === undefined) return ""
  return ` in ${elapsed(status.state.at - status.startedAt)}`
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} s`
  if (seconds < 60) return `${Math.round(seconds)} s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)} min${whole % 60 ? ` ${whole % 60} s` : ""}`
}

function checkResult(status: RunStatus | undefined): string {
  if (!status) return "not run yet"
  if (status.state.kind === "running") return "running"
  if (status.state.kind === "exited") return status.state.code === 0 ? "passed" : `failed (exit ${status.state.code})`
  if (status.state.kind === "ended") return "ended without an exit code"
  return "not run yet"
}

/** Every field of a recipe by its path, such as `checks.quick` or `prepare[0].link`, written as JSON. */
function recipeFields(recipe: Recipe): Map<string, string> {
  const found = new Map<string, string>()
  const put = (path: string, value: string | boolean | readonly string[] | undefined) => {
    if (value !== undefined) found.set(path, JSON.stringify(value))
  }
  // A field added to the recipe fails to compile here until it's listed below.
  const { $schema, values, processes, targets, checks, prepare, carry, secrets, oneAtATime, verify, cleanup, ...unlisted } = recipe
  const none: Record<string, never> = unlisted
  void none
  put("$schema", $schema)
  for (const [name, value] of Object.entries(values)) put(`values.${name}`, value)
  for (const [name, spec] of Object.entries(processes)) {
    const { command, cwd, port, values: own, ready, ...unlistedProcess } = spec
    const noneInProcess: Record<string, never> = unlistedProcess
    void noneInProcess
    put(`processes.${name}.command`, command)
    put(`processes.${name}.cwd`, cwd)
    put(`processes.${name}.port`, port)
    put(`processes.${name}.ready`, ready)
    for (const [key, value] of Object.entries(own ?? {})) put(`processes.${name}.values.${key}`, value)
  }
  const putVerify = (path: string, given: RecipeVerify | undefined) => {
    if (given && "run" in given) put(`${path}.run`, given.run)
    if (given && "check" in given) put(`${path}.check`, given.check)
  }
  for (const [name, target] of Object.entries(targets ?? {})) {
    const { processes: runs, full, verify: own, ...unlistedTarget } = target
    const noneInTarget: Record<string, never> = unlistedTarget
    void noneInTarget
    put(`targets.${name}.processes`, runs)
    put(`targets.${name}.full`, full)
    putVerify(`targets.${name}.verify`, own)
  }
  put("checks.quick", checks.quick)
  put("checks.full", checks.full)
  prepare.forEach(({ command, inputs, outputs, link, ...unlistedStep }, index) => {
    const noneInStep: Record<string, never> = unlistedStep
    void noneInStep
    put(`prepare[${index}].command`, command)
    put(`prepare[${index}].inputs`, inputs)
    put(`prepare[${index}].outputs`, outputs)
    put(`prepare[${index}].link`, link)
  })
  put("carry", carry)
  put("secrets", secrets)
  put("oneAtATime", oneAtATime)
  putVerify("verify", verify)
  put("cleanup", cleanup)
  return found
}

/** Every field that differs between two recipes, as "checks.quick: was …, now …". */
function recipeChanges(before: Recipe, after: Recipe): string[] {
  const old = recipeFields(before)
  const now = recipeFields(after)
  return [...new Set([...old.keys(), ...now.keys()])].flatMap((path) => {
    const was = old.get(path)
    const is = now.get(path)
    if (was === is) return []
    if (was === undefined) return [`${path}: added, ${is}`]
    if (is === undefined) return [`${path}: removed, was ${was}`]
    return [`${path}: was ${was}, now ${is}`]
  })
}

/** Every verification a recipe asks for before a version is published: its own, then each target's. */
function recipeVerifications(recipe: Recipe): Verification[] {
  return [
    ...(recipe.verify ? [{ label: "verify", run: "verify", verify: recipe.verify }] : []),
    ...Object.entries(recipe.targets ?? {}).flatMap(([name, target]) => target.verify ? [{ label: `verify ${name}`, run: `verify-${name}`, target: name, verify: target.verify }] : []),
  ]
}

async function runOutput(processes: ThreadProcesses, app: AppKey, key: string): Promise<string> {
  const run = await processes.output(app, key).catch(() => undefined)
  return run ? presentOutput(run.text, run.log) : "(its output couldn't be read)"
}

async function failureTail(processes: ThreadProcesses, app: AppKey, status: RunStatus | undefined): Promise<string> {
  if (!status || status.state.kind === "running" || status.state.kind === "starting") return ""
  if (status.state.kind === "exited" && status.state.code === 0) return ""
  return `\n\n${await runOutput(processes, app, runKey(status.kind, status.name))}`
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
  const aimed = z.object({
    processes: z.array(z.string().min(1).max(32)).max(20).optional().describe("The recipe's process names; when left out, the target's, or the first target's, or all of them if the recipe has no targets."),
    target: z.string().min(1).max(32).optional().describe("One of the recipe's targets, such as web or desktop, to run the processes it needs."),
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
        "Run this Thread's own copy of the app when you need it running to try or test your change, instead of starting a dev server yourself. Starts the recipe's processes (or one target's, such as web or desktop) on this Thread's ports and waits up to about 25 seconds for each to be ready: its port answering, or its ready command passing. They keep running after your turn and after Mako restarts, and stay out of other Threads' way. A process whose port something else holds is refused, naming who holds it; when this Mac is critically short of memory, the start waits in line and goes ahead by itself once there's room. Returns each process's state and, for one that crashed, the end of its log.",
      inputSchema: aimed,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ processes, target }) => reply(() => tools.start(conversationId(), processes, target))
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
      description: "Stop, then start, this Thread's app: after changing configuration, the recipe's values or dependencies that a running dev server doesn't reload, or after recipe_save changed how its processes start.",
      inputSchema: aimed,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ processes, target }) => reply(() => tools.restart(conversationId(), processes, target))
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
    "app_own_packages",
    {
      description:
        "Call before you install, add, remove or upgrade any dependency when this checkout's packages link to the main checkout's (your instructions and app_status say when). An install over the links would write into the main checkout's packages; this gives the checkout its own copy of them in a few seconds, after which you install as usual. Mako does the same by itself before its own install step once the lockfile changes.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => reply(() => tools.ownPackages(conversationId()))
  )
  server.registerTool(
    "app_check",
    {
      description:
        "Run one of the recipe's checks in this Thread's checkout, with this Thread's values, when it covers what you changed. \"quick\" needs no running app (such as typecheck and lint); \"full\" starts the app (or a target's processes) first, then checks it while it runs. Returns the result and how long it took, and for a failure the run's whole output. A check that outlasts the call keeps going, and your next app_check with that tier returns that same run's result instead of starting another. Long one-off runs, such as a package build or a whole test suite, belong in your own shell, not here.",
      inputSchema: z.object({
        tier: z.enum(["quick", "full"]),
        target: z.string().min(1).max(32).optional().describe("For a recipe with targets: whose full check, and whose processes it starts; the first target's when left out."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ tier, target }) => reply(() => tools.check(conversationId(), tier, target))
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
        "Save a new version of this project's recipe, which says how every Thread installs, starts and checks the app. Call it when setting one up, when repairing a broken one, and in the same turn as any change of yours that alters how the project installs, starts or is checked: a new install step, a renamed script, a new port, value or service. Pass the whole recipe; app_status shows the current one to edit. Mako checks it against this Thread's ports and this checkout's folders and refuses it with the reason if it can't run. It's saved as a draft only this Thread runs, so you can iterate with app_restart and app_check; recipe_publish then proves it and publishes it to every Thread. Returns what changed. Every Thread waits on its start and checks many times a day, so keep them fast unless the user asked for more.",
      inputSchema: z.object({
        recipe: z.record(z.string(), z.unknown()).describe("The whole recipe: values, processes, checks, prepare, and targets, verify, carry, secrets, cleanup and oneAtATime when it needs them."),
        reason: z.string().trim().min(1).max(500).describe("Why, in a line, for the project's version history, such as \"Run the API on its own port\"."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ recipe, reason }) => reply(async () => {
      const parsed = RecipeSchema.safeParse(recipe)
      if (!parsed.success) throw new Error(`Not saved: ${recipeIssues(parsed.error)}`)
      return tools.save(conversationId(), parsed.data, reason)
    })
  )
  server.registerTool(
    "recipe_publish",
    {
      description:
        "Publish this Thread's draft of the recipe to every Thread of the project, once it works. Mako proves it first, on this Thread's copy: it stops the app, installs what's due, starts every process and waits until each is ready, then runs the recipe's verify commands. A failure leaves it a draft and returns the failing step with its whole output. When the recipe asks for checks you make yourself (verify.check), this call starts the draft and says what to check; call again with checked, how each went, to publish. A proof that outlasts the call keeps going, and calling again waits for the same one. The version and its proof are kept in the project's history.",
      inputSchema: z.object({
        checked: z.array(z.object({
          target: z.string().min(1).max(32).optional().describe("The target the check is for; left out for the recipe's own verify."),
          passed: z.boolean(),
          how: z.string().trim().min(1).max(2_000).describe("What you did and saw, in a sentence or two, such as \"Opened the URL through computer control, signed in as the seeded user, the inbox listed 3 threads\"."),
        }).strict()).max(20).optional().describe("Only after recipe_publish said what to check: how each check went."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ checked }) => reply(() => tools.publish(conversationId(), checked?.map((check) => {
      return check.target === undefined
        ? { passed: check.passed, how: check.how }
        : { passed: check.passed, how: check.how, target: check.target }
    })))
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
