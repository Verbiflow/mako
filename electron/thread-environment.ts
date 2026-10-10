import { createHash, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { connect } from "node:net"
import { basename, join } from "node:path"
import { ThreadIdSchema, type ThreadId } from "./contracts/thread-identity.js"
import { worktreeCheckout, worktreeSlug } from "./contracts/thread-worktrees.js"
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
import { checkoutOf, processPort, projectRoot, readRecipe, recipeValues } from "./thread-recipe.js"
import { linkedCarry, linkedEntries, missingEntries, missingText } from "./worktree-carry.js"
import type { Recipe } from "./thread-recipe.js"

const VARIABLES = ["MAKO_THREAD_ID", "MAKO_THREAD_HOST", "MAKO_THREAD_PORT", "MAKO_THREAD_PORTS", "MAKO_THREAD_URL", "MAKO_THREAD_DATA_DIR", "MAKO_THREAD_VALUES"] as const
/** Lists the recipe's names Mako set, so a Mako started inside a Thread can clear them. */
const RECIPE_NAMES = "MAKO_THREAD_VALUES"
/** A Thread unused this long gives its ports to a new one when every block is held. */
const RECLAIM_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const CLAIM_ATTEMPTS = 3
const PROBE_TIMEOUT_MS = 250
const HOST_LABEL_LENGTH = 40
/** Each turn's note reads the main checkout's ignored files at most this often per checkout. */
const MISSING_FRESH_MS = 30_000

/**
 * Sets a Thread's values on an agent process's environment, and clears ones
 * inherited from a Mako that was itself started from a Thread.
 */
export function applyThreadEnvironment(env: NodeJS.ProcessEnv, environment?: ThreadEnvironment): void {
  for (const name of env[RECIPE_NAMES]?.split(",") ?? []) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) delete env[name]
  for (const name of VARIABLES) delete env[name]
  if (!environment) return
  if (environment.thread) env.MAKO_THREAD_ID = environment.thread
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
  return [values, WORKTREE_INSTRUCTIONS, missingInstructions(environment), recipeInstructions(environment)].filter(Boolean).join(" ")
}

function missingInstructions(environment: ThreadEnvironment): string | undefined {
  const missing = environment.missing && missingText(environment.missing)
  if (!missing) return undefined
  const fix = environment.recipe?.kind === "ready"
    ? "add each to the recipe's carry, prepare or leave (recipe_guide), then recipe_save and recipe_publish"
    : "set up the project's recipe with recipe_guide"
  return `This worktree has only what Git checks out and what the recipe brings, so it lacks ${missing}, which the main checkout (${environment.missing!.main}) has. If your work needs one, call worktree_bring with it: Mako brings it without anyone reading it. Never copy one yourself. So every new worktree gets them, ${fix}.`
}

const WORKTREE_INSTRUCTIONS = "To work on a branch of this Thread's own, call worktree_move (worktree_status says where you edit now); never make a worktree with `git worktree add` or copy the checkout, since Mako, its Changes panel and the recipe's checks see only this Thread's checkouts."

function recipeInstructions(environment: ThreadEnvironment): string | undefined {
  const recipe = environment.recipe
  if (!recipe) return undefined
  if (recipe.kind === "none") return "This project has no recipe yet for running its app in each Thread; if you're asked to set one up, call recipe_guide."
  if (recipe.kind === "invalid") return `The project's recipe is broken, so its values aren't set and its processes can't start: ${recipe.message}. Tell the user; recipe_guide says how to repair it.`
  const names = Object.entries(environment.values ?? {}).map(([name, value]) => `${name}=${value}`)
  const processes = recipe.processes.map((entry) => entry.port === undefined ? entry.name : `${entry.name} on ${entry.port}`)
  return [
    names.length ? `The project's recipe also sets ${names.join(", ")} in your shell.` : undefined,
    processes.length ? `Its processes (${processes.join(", ")}) run through the mako server's app_start, app_stop, app_restart, app_status and app_logs tools; start them there rather than by hand, so they stay this Thread's and survive your turn.` : undefined,
    recipe.checks.length ? `Its checks (${recipe.checks.join(", ")}) run with app_check, when one covers what you changed.` : undefined,
    recipe.linked?.length ? `This checkout's ${recipe.linked.join(", ")} link each entry to the main checkout's, so it needed no install. An install here would write through the links into the main checkout's: before you install, add, remove or upgrade any dependency, call app_own_packages, which gives this checkout its own copy in a few seconds, then install as usual.` : undefined,
    recipe.shared?.length ? `This checkout's ${recipe.shared.join(", ")} ${recipe.shared.length === 1 ? "is" : "are"} linked to the main checkout's, so a write there changes it for every Thread. To change ${recipe.shared.length === 1 ? "it" : "one"} in this Thread only, first call worktree_bring with it and no link, which makes it this checkout's own.` : undefined,
    "port_holder names whoever holds a port.",
    "If your change alters how the project installs, starts or is checked, update the recipe in the same turn: recipe_save, then recipe_publish once it works.",
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
  private readonly lacking = new Map<string, { at: number; missing: ThreadEnvironment["missing"] }>()
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
    const lacking = await this.missingIn(checkout, read.kind === "ready" ? read.recipe : undefined)
    if (lacking) environment.missing = lacking
    if (read.kind === "none") return { ...environment, recipe: { kind: "none" } }
    if (read.kind === "invalid") return { ...environment, recipe: { kind: "invalid", message: read.message } }
    const [linked, shared] = await Promise.all([
      linkedEntries(checkout, read.recipe.prepare).catch((): string[] => []),
      linkedCarry(checkout, read.recipe).catch((): string[] => []),
    ])
    const result: ThreadEnvironment = {
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
    if (result.recipe?.kind === "ready" && linked.length) result.recipe.linked = linked
    if (result.recipe?.kind === "ready" && shared.length) result.recipe.shared = shared
    return result
  }

  /** What a Thread's worktree lacks of the main checkout's ignored files; nothing for a checkout that isn't one. */
  private async missingIn(checkout: string, recipe: Recipe | undefined): Promise<ThreadEnvironment["missing"]> {
    const worktree = this.dependencies.store.worktrees().find((candidate) => candidate.path === checkout || worktreeCheckout(candidate) === checkout)
    if (!worktree) return undefined
    const main = worktreeCheckout(worktree) === worktree.path ? worktree.repoRoot : worktree.project
    const key = `${checkout}\0${JSON.stringify(recipe?.leave ?? [])}`
    const cached = this.lacking.get(key)
    if (cached && this.now() - cached.at < MISSING_FRESH_MS) return cached.missing
    const found = await missingEntries(main, recipe, checkout).catch(() => ({ credentials: [], dependencies: [] }))
    const missing = found.credentials.length || found.dependencies.length ? { main, ...found } : undefined
    this.lacking.set(key, { at: this.now(), missing })
    return missing
  }

  /**
   * Whose app a checkout runs, resolved: its Worktree Thread's, or else the
   * folder's own, shared by every Thread in it. A Thread with no folder has
   * one of its own. `name` names its host.
   */
  appFor(thread: ThreadId | undefined, checkout: string | undefined): AppOwner {
    if (!checkout) {
      if (!thread) throw new Error("An app belongs to a folder or a Thread")
      return { app: AppKeySchema.parse(thread) }
    }
    const worktree = this.dependencies.store.worktrees().find((candidate) => candidate.path === checkout || worktreeCheckout(candidate) === checkout)
    if (worktree) return { app: AppKeySchema.parse(worktree.thread), name: basename(checkout) }
    return { app: folderApp(checkout), name: basename(checkout) }
  }

  /** What an app holds on this device, if it has claimed anything, without claiming or marking it used. */
  held(app: AppKey): ThreadEnvironment | undefined {
    const values = this.dependencies.store.environment(app)
    return values && { app, host: values.host, port: values.port, ports: THREAD_PORT_COUNT, dataDir: this.dataDir(app) }
  }

  /**
   * The app in the folder at `cwd`, for a person at the desk rather than an
   * agent: whose it is, and its values. Only `claim` gives an app that has
   * never run its ports; a look at the strip claims nothing.
   */
  async forFolder(cwd: string, claim: boolean): Promise<FolderApp> {
    const checkout = await checkoutOf(cwd)
    const owner = this.appFor(undefined, checkout)
    const root = await projectRoot(checkout)
    const found: FolderApp = { app: owner.app, checkout, project: basename(root), root }
    const values = claim
      ? this.dependencies.store.useEnvironment(owner.app) ?? await this.claim(owner.app, owner.name ?? basename(checkout))
      : this.dependencies.store.environment(owner.app)
    if (!values) return found
    found.environment = { app: owner.app, host: values.host, port: values.port, ports: THREAD_PORT_COUNT, dataDir: this.dataDir(owner.app) }
    if (ThreadIdSchema.safeParse(owner.app).success) found.environment.thread = ThreadIdSchema.parse(owner.app)
    if (claim) await mkdir(found.environment.dataDir, { recursive: true, mode: 0o700 })
    return found
  }

  /** Where an app's own data lives; removing its worktree deletes it. */
  dataDir(app: AppKey): string {
    return join(this.dependencies.dataRoot, AppKeySchema.parse(app))
  }

  /** File reads use the owner's data folder without claiming ports, creating folders or reading recipes. */
  async fileDataDir(owner: { cwd?: string; thread?: ThreadId; conversationId?: string }): Promise<string | undefined> {
    const launched = owner.conversationId ? this.launchedWith(owner.conversationId) : undefined
    if (launched) return launched.dataDir
    const thread = owner.thread ?? (owner.conversationId ? this.dependencies.store.journalPlacement(owner.conversationId)?.thread : undefined)
    const checkout = owner.cwd ? await checkoutOf(owner.cwd) : undefined
    if (!thread && !checkout) return undefined
    return this.dataDir(this.appFor(thread, checkout).app)
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

/** A folder's app as the desk sees it: whose it is, which project, and its values once it has any. */
export interface FolderApp {
  app: AppKey
  checkout: string
  /** The project's name, and its main checkout. */
  project: string
  root: string
  environment?: ThreadEnvironment
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
