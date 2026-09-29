import { createHash, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { connect } from "node:net"
import { basename, join } from "node:path"
import type { ThreadId } from "./contracts/thread-identity.js"
import { worktreeSlug } from "./contracts/thread-worktrees.js"
import {
  AppKeySchema,
  THREAD_HOST_SUFFIX,
  THREAD_PORT_COUNT,
  THREAD_PORT_FIRST,
  THREAD_PORT_LAST,
  type AppKey,
  type ThreadEnvironment,
  type ThreadEnvironmentValues,
  type ThreadRecipeProcess,
} from "./contracts/thread-environments.js"
import type { ThreadStore } from "./thread-store.js"
import { checkoutOf, processPort, readRecipe, recipeValues } from "./thread-recipe.js"

const VARIABLES = ["MAKO_THREAD_ID", "MAKO_THREAD_HOST", "MAKO_THREAD_PORT", "MAKO_THREAD_PORTS", "MAKO_THREAD_URL", "MAKO_THREAD_DATA_DIR", "MAKO_THREAD_VALUES"] as const
/** Lists the recipe's names Mako set, so a Mako started inside a Thread can clear them. */
const RECIPE_NAMES = "MAKO_THREAD_VALUES"
/** A Thread unused this long gives its ports to a new one when every block is held. */
const RECLAIM_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const CLAIM_ATTEMPTS = 3
const PROBE_TIMEOUT_MS = 250
const HOST_LABEL_LENGTH = 40

/**
 * Sets a Thread's values on an agent process's environment, and clears ones
 * inherited from a Mako that was itself started from a Thread.
 */
export function applyThreadEnvironment(env: NodeJS.ProcessEnv, environment?: ThreadEnvironment): void {
  for (const name of env[RECIPE_NAMES]?.split(",") ?? []) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) delete env[name]
  for (const name of VARIABLES) delete env[name]
  if (!environment) return
  env.MAKO_THREAD_ID = environment.thread
  env.MAKO_THREAD_HOST = environment.host
  env.MAKO_THREAD_PORT = String(environment.port)
  env.MAKO_THREAD_PORTS = String(environment.ports)
  env.MAKO_THREAD_URL = threadUrl(environment)
  env.MAKO_THREAD_DATA_DIR = environment.dataDir
  const values = Object.entries(environment.values ?? {})
  for (const [name, value] of values) env[name] = value
  if (values.length) env[RECIPE_NAMES] = values.map(([name]) => name).join(",")
}

/** One line for the note sent with each prompt; it names only what the process was started with. */
export function threadEnvironmentInstructions(environment: ThreadEnvironment): string {
  const last = environment.port + environment.ports - 1
  const values = `This Thread's own values, already in your shell's environment: ports ${environment.port}-${last} (MAKO_THREAD_PORT, MAKO_THREAD_PORTS), host ${environment.host} (${threadUrl(environment)} is MAKO_THREAD_URL; the name keeps this Thread's cookies apart), and a private data folder (MAKO_THREAD_DATA_DIR). Run anything you start for this Thread on those ports. Other Threads' agents share this machine: never stop a process you didn't start, and if the project needs a fixed port that is taken, say so instead.`
  return [values, recipeInstructions(environment)].filter(Boolean).join(" ")
}

function recipeInstructions(environment: ThreadEnvironment): string | undefined {
  const recipe = environment.recipe
  if (!recipe) return undefined
  if (recipe.kind === "none") return "This project has no recipe yet for running its app in each Thread; if you're asked to set one up, call environment_guide."
  if (recipe.kind === "invalid") return `The project's recipe is broken, so its values aren't set and its processes can't start: ${recipe.message}. Tell the user; environment_guide says how to repair it.`
  const names = Object.entries(environment.values ?? {}).map(([name, value]) => `${name}=${value}`)
  const processes = recipe.processes.map((entry) => entry.port === undefined ? entry.name : `${entry.name} on ${entry.port}`)
  return [
    names.length ? `The project's recipe also sets ${names.join(", ")} in your shell.` : undefined,
    processes.length ? `Its processes (${processes.join(", ")}) run through the environment_start, environment_stop, environment_restart, environment_status and environment_logs tools; start them there rather than by hand, so they stay this Thread's and survive your turn.` : undefined,
    recipe.checks.length ? `Its checks (${recipe.checks.join(", ")}) run with environment_check; a passing full check is the proof to report.` : undefined,
    "environment_port names whoever holds a port.",
  ].filter(Boolean).join(" ")
}

function threadUrl(environment: ThreadEnvironment): string {
  return `http://${environment.host}:${environment.port}`
}

export interface ThreadEnvironmentDependencies {
  store: ThreadStore
  /** Threads' data folders, one per Thread ID. */
  dataRoot: string
  /** Where Mako keeps projects' recipes, one file per repository. */
  recipesRoot?: string
  /** Whether anything accepts connections on a local port. */
  listening?: (port: number) => Promise<boolean>
  now?: () => number
}

/**
 * Hands each Thread the values that keep its folder's running app apart
 * from other folders' on this device, and keeps them for the folder's life.
 */
export class ThreadEnvironments {
  private readonly launched = new Map<string, ThreadEnvironment>()
  private readonly dependencies: ThreadEnvironmentDependencies
  private readonly listening: (port: number) => Promise<boolean>
  private readonly now: () => number

  constructor(dependencies: ThreadEnvironmentDependencies) {
    this.dependencies = dependencies
    this.listening = dependencies.listening ?? portListening
    this.now = dependencies.now ?? Date.now
  }

  /**
   * The values a conversation's agent process starts with, with the names
   * the recipe in `cwd`'s checkout gives them. `title` names the host of a
   * Thread that has no title yet.
   */
  async forLaunch(conversationId: string, title?: string, cwd?: string): Promise<ThreadEnvironment | undefined> {
    const environment = await this.forConversation(conversationId, title, cwd)
    if (environment) this.launched.set(conversationId, environment)
    else this.launched.delete(conversationId)
    return environment
  }

  /** The same values, resolved now, for a conversation whose agent is already running. */
  async forConversation(conversationId: string, title?: string, cwd?: string): Promise<ThreadEnvironment | undefined> {
    const { store } = this.dependencies
    const placed = store.journalPlacement(conversationId)
    if (!placed) return undefined
    const checkout = cwd ? await checkoutOf(cwd) : undefined
    const owner = this.appFor(placed.thread, checkout)
    const values = store.useEnvironment(owner.app) ?? await this.claim(owner.app, owner.name ?? worktreeSlug(store.thread(placed.thread)?.title ?? title))
    const environment: ThreadEnvironment = {
      thread: placed.thread,
      app: values.app,
      host: values.host,
      port: values.port,
      ports: THREAD_PORT_COUNT,
      dataDir: this.dataDir(values.app),
    }
    await mkdir(environment.dataDir, { recursive: true, mode: 0o700 })
    if (!checkout) return environment
    let read: Awaited<ReturnType<typeof readRecipe>>
    try {
      read = await readRecipe(checkout, environment, this.dependencies.recipesRoot)
    } catch (error) {
      return { ...environment, recipe: { kind: "invalid", message: `the recipe couldn't be read: ${error instanceof Error ? error.message : String(error)}` } }
    }
    if (read.kind === "none") return { ...environment, recipe: { kind: "none" } }
    if (read.kind === "invalid") return { ...environment, recipe: { kind: "invalid", message: read.message } }
    return {
      ...environment,
      values: recipeValues(read.recipe, environment),
      recipe: {
        kind: "ready",
        processes: Object.entries(read.recipe.processes).map(([name, spec]) => {
          const entry: ThreadRecipeProcess = { name }
          const port = processPort(spec, environment)
          if (port !== undefined) entry.port = port
          return entry
        }),
        checks: Object.keys(read.recipe.checks),
      },
    }
  }

  /**
   * Whose app a checkout runs, resolved: its Worktree Thread's, or else the
   * folder's own, shared by every Thread in it. A Thread with no folder has
   * one of its own. `name` names its host.
   */
  appFor(thread: ThreadId, checkout: string | undefined): AppOwner {
    if (!checkout) return { app: AppKeySchema.parse(thread) }
    const worktree = this.dependencies.store.worktrees().find((candidate) => candidate.path === checkout)
    if (worktree) return { app: AppKeySchema.parse(worktree.thread), name: basename(worktree.path) }
    return { app: folderApp(checkout), name: basename(checkout) }
  }

  /** What an app holds on this device, if it has claimed anything, without claiming or marking it used. */
  held(app: AppKey): Omit<ThreadEnvironment, "thread"> | undefined {
    const values = this.dependencies.store.environment(app)
    return values && { app, host: values.host, port: values.port, ports: THREAD_PORT_COUNT, dataDir: this.dataDir(app) }
  }

  /** Where an app's own data lives; removing its worktree deletes it. */
  dataDir(app: AppKey): string {
    return join(this.dependencies.dataRoot, AppKeySchema.parse(app))
  }

  /** What the conversation's running agent process was started with. */
  launchedWith(conversationId: string): ThreadEnvironment | undefined {
    return this.launched.get(conversationId)
  }

  private async claim(app: AppKey, name: string): Promise<ThreadEnvironmentValues> {
    const { store } = this.dependencies
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const held = store.heldEnvironments()
      const host = this.chooseHost(app, name, new Set(held.map((values) => values.host)))
      const heldPorts = new Set(held.map((values) => values.port))
      let port: number | undefined
      for (let base = THREAD_PORT_FIRST; base + THREAD_PORT_COUNT - 1 <= THREAD_PORT_LAST && port === undefined; base += THREAD_PORT_COUNT)
        if (!heldPorts.has(base) && !(await this.blockBusy(base))) port = base
      let reclaim: AppKey | undefined
      if (port === undefined) {
        const cutoff = this.now() - RECLAIM_AFTER_MS
        for (const stale of held) {
          if (stale.usedAt >= cutoff) break
          if (await this.blockBusy(stale.port)) continue
          port = stale.port
          reclaim = stale.app
          break
        }
      }
      if (port === undefined)
        throw new Error("Every block of ports for Threads on this Mac is held by a Thread used in the last week")
      const claimed = store.claimEnvironment({ app, host, port, reclaim })
      if (claimed) return claimed
    }
    throw new Error("Other Mako hosts kept taking the ports chosen for this Thread")
  }

  private chooseHost(app: AppKey, name: string, held: ReadonlySet<string>): string {
    const named = hostLabel(name)
    const label = named && named !== "thread" ? named : `t-${app.replace(/^folder-/, "").slice(0, 8)}`
    const candidates = Array.from({ length: 50 }, (_, index) => index === 0 ? label : `${label}-${index + 1}`)
    candidates.push(`${label}-${randomUUID().slice(0, 6)}`)
    const free = candidates.find((candidate) => !held.has(`${candidate}${THREAD_HOST_SUFFIX}`))
    if (!free) throw new Error(`Every hostname for this Thread is taken: ${label}${THREAD_HOST_SUFFIX}`)
    return `${free}${THREAD_HOST_SUFFIX}`
  }

  private async blockBusy(base: number): Promise<boolean> {
    const ports = Array.from({ length: THREAD_PORT_COUNT }, (_, index) => base + index)
    return (await Promise.all(ports.map((port) => this.listening(port)))).some(Boolean)
  }
}

/** Whose app a checkout runs, and the name its host is given. */
export interface AppOwner {
  app: AppKey
  name?: string
}

/** The app of a folder no Worktree Thread owns, from its resolved path. */
export function folderApp(checkout: string): AppKey {
  return AppKeySchema.parse(`folder-${createHash("sha256").update(checkout).digest("hex").slice(0, 16)}`)
}

/** A DNS label: lowercase letters, digits and inner hyphens. */
function hostLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, HOST_LABEL_LENGTH).replace(/^-+|-+$/g, "")
}

/** Something listening on either loopback address counts. Loopback refuses at once when nothing listens, so a probe with no answer counts as busy. */
export async function portListening(port: number): Promise<boolean> {
  const answers = await Promise.all(["127.0.0.1", "::1"].map((host) => new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    const done = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(true))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })))
  return answers.some(Boolean)
}
