import { realpathSync } from "node:fs"
import { rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { HostConfig } from "../host-config.js"
import type { MethodTable } from "../host-methods.js"
import type { HostJobs } from "../host-jobs.js"
import { hostLog, hostWarn } from "../host-log.js"
import type { ThreadStore } from "../thread-store.js"
import { portListening, ThreadEnvironments } from "../thread-environment.js"
import { ThreadProcesses } from "../thread-processes.js"
import { ThreadWorktreeService } from "../thread-worktrees.js"
import { moveHold, moveSource, ThreadWorktreeMoves } from "../thread-worktree-moves.js"
import { WorkspaceMoves } from "../workspace-moves.js"
import { moveablePlace } from "../workspace-tools.js"
import { projectRecipe } from "../thread-recipe.js"
import { CheckoutHeadService } from "../checkout-heads.js"
import { PlanBuilds } from "../plan-builds.js"
import { beginTrace } from "../app-probe.js"
import { childHistory } from "../watch-backend.js"
import { commandEnvironment, environmentTools, type EnvironmentTools } from "../environment-tools.js"
import { spareInstaller } from "../spare-install.js"
import { isSpareCheckout } from "../worktree-carry.js"
import { AppKeySchema, type AppKey } from "../contracts/thread-environments.js"
import { ThreadIdSchema } from "../contracts/thread-identity.js"
import { listExternalEditors, openInExternalEditor } from "../editors.js"
import { revealAction } from "../reveal-policy.js"
import { presentMachine } from "../machine.js"
import { automationList, fireAutomation, loadAutomations, saveAutomations, setEnabled } from "../automations.js"
import { installWorkspaceIpc, type WatchedFile } from "../ipc/workspace.js"
import { installThreadWorktreesIpc } from "../ipc/thread-worktrees.js"
import { installWorkspaceMovesIpc } from "../ipc/workspace-moves.js"
import { installPlanBuildsIpc } from "../ipc/plan-builds.js"
import { installCheckoutHeadsIpc } from "../ipc/checkout-heads.js"
import { installThreadAppIpc } from "../ipc/thread-app.js"
import { listBranchPulls, listPullHeads } from "../github.js"
import type { LiveConversations } from "../live-conversations.js"
import type { ThreadLifecycle } from "../thread-lifecycle.js"
import type { AgentHost } from "../host.js"
import type { HostEvent } from "../shared.js"
import type { ThreadWorktreeMoveDeps } from "../thread-worktree-moves.js"

/** A long quiet, not a short timer: a stopped app keeps its files and data, and restarting it for nothing costs more than it frees. */
const THREAD_APP_IDLE_MS = 6 * 60 * 60 * 1000

/** Worktrees, spares, checkouts, recipes, and each Thread's apps and their processes. */
export interface Workspaces {
  checkoutHeads: CheckoutHeadService
  planBuilds: PlanBuilds
  /** Each Thread's values and data folder; beside the Thread store, so a Thread keeps one whichever host starts its agents. */
  environments: ThreadEnvironments | null
  /** Each running app's records, so any host sees and stops the processes another host started. */
  processes: ThreadProcesses | null
  /** Beside the Thread store, so every profile sharing the store shares its worktrees. */
  worktrees: ThreadWorktreeService | null
  /** The recipe Mako keeps for each project, one file per repository, outside every checkout. */
  recipes: string | undefined
  /** Whose app a key is, in words: a Worktree Thread's, or a folder's that Threads share. */
  whoseApp(app: AppKey): string | undefined
  /** The Worktree Thread an app belongs to, for the Room. */
  appOwner(app: AppKey): { id: string; title: string } | undefined
  /** What changed on disk while apps ran, for their probes; FSEvents keeps that history, so macOS only. */
  fileHistory: ReturnType<typeof childHistory>
  close(): void
}

export interface WorkspacesDeps {
  store: ThreadStore | null
  jobs: HostJobs
  emit(event: HostEvent): void
  /** What holds a worktree: its conversations and terminals, as a person would name them. */
  inUse(path: string): Promise<string[]>
  /** Conversations mid-turn in a worktree. */
  working(path: string): Promise<string[]>
  /** The recipe's cleanup for a worktree about to be removed, once the app tools exist. */
  cleanup(path: string): Promise<string | undefined> | undefined
}

export function openWorkspaces(config: HostConfig, deps: WorkspacesDeps): Workspaces {
  const { store, emit } = deps
  const checkoutHeads = new CheckoutHeadService((heads) => emit({ type: "checkout-heads", heads }))
  const planBuilds = new PlanBuilds({
    file: join(config.environment.dataRoot, "plan-builds.json"),
    announce: (builds) => emit({ type: "plan-builds", builds }),
  })
  const shared = store ? realpathSync(dirname(store.path)) : undefined
  const recipes = shared ? join(shared, "recipes") : undefined
  const environments = store && shared
    ? new ThreadEnvironments({ store, dataRoot: join(shared, "thread-data"), recipesRoot: recipes })
    : null
  const fileHistory = childHistory()
  const whoseApp = (app: AppKey): string | undefined => {
    const thread = ThreadIdSchema.safeParse(app)
    if (thread.success) {
      const title = store?.thread(thread.data)?.title
      return title ? `the Thread “${title}”` : undefined
    }
    const folder = processes?.checkoutOf(app)
    if (folder && isSpareCheckout(folder)) return "the install of a checkout kept ready for a new Thread"
    return folder ? `the ${basename(folder)} folder` : undefined
  }
  const appOwner = (app: AppKey) => {
    const thread = ThreadIdSchema.safeParse(app)
    const found = thread.success ? store?.thread(thread.data) : undefined
    return found ? { id: found.id, title: found.title || "Untitled Thread" } : undefined
  }
  const processes = shared
    ? new ThreadProcesses({
        root: join(shared, "thread-environments"),
        listening: portListening,
        whose: whoseApp,
        cameUp: (folder, at) => beginTrace(folder, at, fileHistory),
      })
    : null
  if (processes) {
    if (!config.fixtureDesk)
      deps.jobs.every("stop thread apps unused for six hours", 10 * 60_000, async () => {
        const stopped = await processes.stopIdle(THREAD_APP_IDLE_MS)
        if (stopped.length) hostLog("threads", "stopped apps unused for six hours", { threads: stopped.join(", ") })
      })
    /** Each running copy's peak counts toward its project's "about N at once"; with nothing running a look reads no process table. */
    deps.jobs.every("measure thread apps' memory", 30_000, async () => { await processes.memory() })
  }
  const worktrees = store && shared
    ? new ThreadWorktreeService(join(shared, "worktrees"), store, deps.inUse, deps.working, processes && environments ? {
        stop: async (thread) => { await processes.stop(AppKeySchema.parse(thread)) },
        cleanup: async (thread, path) => {
          const done = await deps.cleanup(path)?.catch((error: Error) => `cleanup couldn't run: ${error.message}`)
          if (done) hostLog("threads", "worktree cleanup", { thread, path, result: done })
        },
        discard: async (thread, path) => {
          await processes.discard(AppKeySchema.parse(thread))
          await processes.forgetPrepared(path)
          await rm(environments.dataDir(AppKeySchema.parse(thread)), { recursive: true, force: true })
        },
      } : undefined, processes ? {
        recipe: (checkout) => projectRecipe(checkout, recipes),
        prepared: (checkout) => processes.prepared(checkout),
        savePrepared: (checkout, prepared) => processes.savePrepared(checkout, prepared),
        forgetPrepared: (checkout) => processes.forgetPrepared(checkout),
        spareInstall: spareInstaller({
          processes,
          recipe: (checkout) => projectRecipe(checkout, recipes),
          env: (values) => ({ ...commandEnvironment(), ...values }),
        }),
      } : undefined)
    : null
  if (worktrees) {
    const tidy = () => worktrees.tidy()
    void tidy().catch((error: Error) => hostWarn("threads", "spare worktrees could not be tidied", { error: error.message }))
    // Spares a project stopped wanting go after a day even while the host keeps running.
    deps.jobs.every("tidy spare worktrees", 60 * 60_000, tidy)
  }
  return {
    checkoutHeads,
    planBuilds,
    environments,
    processes,
    worktrees,
    recipes,
    whoseApp,
    appOwner,
    fileHistory,
    close: () => checkoutHeads.close(),
  }
}

/** The Thread's Sessions moving into its worktree, and agents' app tools; made once the conversations are open. */
export interface WorkspaceMovers {
  worktreeMoves: ThreadWorktreeMoves | undefined
  moves: WorkspaceMoves
  appTools: EnvironmentTools | undefined
}

export interface WorkspaceMoversDeps {
  config: HostConfig
  workspaces: Workspaces
  live: LiveConversations
  store: ThreadStore | null
  lifecycle: ThreadLifecycle
  launch: ThreadWorktreeMoveDeps["launch"]
  /** How long a harness's MCP calls may wait, for an app check to fit inside one. */
  checkWaitMs(harness: string): number | undefined
  emit(event: HostEvent): void
  warn(message: string, facts: Record<string, string | number | boolean | undefined>): void
}

export function openWorkspaceMovers(deps: WorkspaceMoversDeps): WorkspaceMovers {
  const { workspaces, live, store, emit } = deps
  const { worktrees, environments, processes } = workspaces
  const worktreeMoves = worktrees ? new ThreadWorktreeMoves({
    conversations: live,
    worktrees,
    threadOf: (id) => store?.journalPlacement(id)?.thread,
    archived: (id) => deps.lifecycle.controls({ kind: "live", id }).archived,
    archive: (id) => emit({ type: "thread-archives", snapshot: deps.lifecycle.archive({ id: crypto.randomUUID(), target: { kind: "live", id }, archived: true }) }),
    moved: (event) => emit(event),
    launch: deps.launch,
    warn: deps.warn,
  }) : undefined
  const worktreeMove = (): ThreadWorktreeMoves => {
    if (!worktreeMoves) throw new Error("Worktrees need the Thread store, which didn't open.")
    return worktreeMoves
  }
  const moves = new WorkspaceMoves({
    file: join(deps.config.environment.dataRoot, "workspace-moves.json"),
    source: (id) => moveSource(live, id),
    companions: (id) => worktreeMoves?.companions(id) ?? [],
    place: (id, cwd) => moveablePlace(worktrees, id, worktreeMoves?.project(id) ?? cwd),
    move: async (id) => (await worktreeMove().carry(id, { lead: true, tell: true })).session.id,
    follow: async (id, told, lead) => { await worktreeMove().carry(id, { lead: false, tell: told, after: lead }) },
    announce: (state) => emit({ type: "workspace-moves", moves: state }),
    failed: (_id, message) => emit({ type: "notice", level: "error", message }),
  })
  const appTools = environments && processes ? environmentTools({
    cwd: (id) => live.session(id)?.cwd,
    environment: (id, cwd) => environments.forConversation(id, live.session(id)?.title, cwd),
    launchedWith: (id) => environments.launchedWith(id),
    conversation: (id) => {
      const session = live.session(id)
      return session && {
        title: session.title || "Untitled conversation",
        harness: session.harness,
        working: session.status === "running",
        checkWaitMs: deps.checkWaitMs(session.harness),
      }
    },
    folder: (cwd, claim) => environments.forFolder(cwd, claim),
    processes,
    recipesRoot: workspaces.recipes,
    whose: workspaces.whoseApp,
    history: workspaces.fileHistory,
    owner: workspaces.appOwner,
  }) : undefined
  return { worktreeMoves, moves, appTools }
}

export interface WorkspaceMethodsDeps {
  workspaces: Workspaces
  movers: WorkspaceMovers
  live: LiveConversations
  withHost<T>(run: (host: AgentHost) => T | Promise<T>): Promise<T>
  emit(event: HostEvent): void
}

/** The files people open, the editors and folders they reach for, worktrees, moves, apps and automations. */
export function declareWorkspaceMethods(methods: MethodTable, { workspaces, movers, live, withHost, emit }: WorkspaceMethodsDeps): WatchedFile {
  const files = installWorkspaceIpc(methods, { withHost, emit })
  methods.handle("mako:pick-folder", () => presentMachine().chooseFolder("Choose a folder"))
  methods.handle("mako:external-editors", () => listExternalEditors())
  methods.handle("mako:open-in-editor", (path: string, editor?: string) =>
    withHost(async (h) => {
      const absolute = await h.resolvePath(path)
      await openInExternalEditor(absolute, editor)
    })
  )
  methods.handle("mako:reveal", (path: string) =>
    withHost(async (h) => {
      // Documents open in their default app; anything the default handler
      // would run (bundles, executables, `.command`) is only shown in Finder.
      // The path may come from anywhere, including an agent's answer.
      const absolute = await h.resolvePath(path)
      const info = await stat(absolute)
      const machine = presentMachine()
      if (revealAction(absolute, info) === "open" && (await machine.open(absolute))) return
      await machine.reveal(absolute)
    })
  )
  methods.handle("mako:automations", () => automationList())
  methods.handle("mako:save-automations", (next: Parameters<typeof saveAutomations>[1]) =>
    withHost((h) => saveAutomations(h.workspace, next))
  )
  methods.handle("mako:automation-enabled", (id: string, enabled: boolean) => setEnabled(id, enabled))
  methods.handle("mako:run-automation", (id: string) => fireAutomation(id, "manual"))
  methods.handle("mako:reload-automations", () => withHost((h) => loadAutomations(h.workspace)))
  installThreadWorktreesIpc(methods, workspaces.worktrees, { heads: listPullHeads, branches: listBranchPulls })
  installWorkspaceMovesIpc(methods, movers.moves, (target) => moveHold(live, movers.worktreeMoves, movers.moves, target))
  installPlanBuildsIpc(methods, workspaces.planBuilds)
  installCheckoutHeadsIpc(methods, workspaces.checkoutHeads)
  installThreadAppIpc(methods, movers.appTools?.desk)
  return files
}
